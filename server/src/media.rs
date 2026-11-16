use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    models::MediaOut,
    AppState,
};
use axum::{
    body::Body,
    extract::{Multipart, Path, Request, State},
    http::{header, HeaderValue},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new().route("/media", post(upload)).route("/media/{id}", get(download))
}

async fn upload(State(st): State<AppState>, auth: AuthUser, mut multipart: Multipart) -> AppResult<Json<MediaOut>> {
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad_request(format!("Bad upload: {e}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field.file_name().unwrap_or("file").chars().take(200).collect::<String>();
        let mime = field
            .content_type()
            .map(|s| s.to_string())
            .filter(|m| !m.is_empty() && m != "application/octet-stream")
            .unwrap_or_else(|| mime_guess::from_path(&filename).first_or_octet_stream().to_string());
        let id = Uuid::new_v4();
        let path = st.media_dir.join(id.to_string());
        let mut file = tokio::fs::File::create(&path).await?;
        let mut size: i64 = 0;
        loop {
            match field.chunk().await {
                Ok(Some(chunk)) => {
                    size += chunk.len() as i64;
                    file.write_all(&chunk).await?;
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = tokio::fs::remove_file(&path).await;
                    return Err(AppError::bad_request(format!("Upload interrupted: {e}")));
                }
            }
        }
        file.flush().await?;
        sqlx::query("INSERT INTO media (id, owner_id, mime, size, filename) VALUES ($1, $2, $3, $4, $5)")
            .bind(id)
            .bind(auth.user_id)
            .bind(&mime)
            .bind(size)
            .bind(&filename)
            .execute(&st.db)
            .await?;
        return Ok(Json(MediaOut { id, mime, size, filename }));
    }
    Err(AppError::bad_request("No file field in upload"))
}

/// Serves a file with Range support so audio/video can seek.
/// Media ids are random v4 UUIDs, so only someone who received the message can know one.
async fn download(State(st): State<AppState>, _auth: AuthUser, Path(id): Path<Uuid>, req: Request) -> AppResult<Response> {
    let row: Option<(String, String)> = sqlx::query_as("SELECT mime, filename FROM media WHERE id = $1")
        .bind(id)
        .fetch_optional(&st.db)
        .await?;
    let (mime, filename) = row.ok_or_else(AppError::not_found)?;
    let path = st.media_dir.join(id.to_string());
    let mut res = ServeFile::new(path)
        .oneshot(req)
        .await
        .map_err(|_| AppError::not_found())?
        .map(Body::new);
    let headers = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    let safe: String = filename.chars().filter(|c| c.is_ascii_graphic() && *c != '"' || *c == ' ').collect();
    if let Ok(v) = HeaderValue::from_str(&format!("inline; filename=\"{safe}\"")) {
        headers.insert(header::CONTENT_DISPOSITION, v);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable"));
    Ok(res)
}
