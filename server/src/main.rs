mod auth;
mod calls;
mod chats;
mod error;
mod media;
mod messages;
mod models;
mod sms;
mod users;
mod ws;

use axum::{extract::DefaultBodyLimit, routing::get, Router};
use sqlx::postgres::PgPoolOptions;
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::PgPool,
    pub hub: Arc<ws::Hub>,
    pub media_dir: PathBuf,
    pub sms: Arc<sms::SmsSender>,
    pub config: Arc<Config>,
}

pub struct Config {
    pub stun_urls: Vec<String>,
    pub turn_urls: Vec<String>,
    pub turn_username: String,
    pub turn_credential: String,
    /// coturn `static-auth-secret`: when set, clients get short-lived TURN credentials.
    pub turn_secret: String,
    pub max_upload_mb: usize,
}

fn env_list(key: &str, default: &str) -> Vec<String> {
    std::env::var(key)
        .unwrap_or_else(|_| default.to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[tokio::main]
async fn main() -> anyhow_free::Result {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "relay_server=info,tower_http=warn".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://relay:relay@localhost:5432/relay".into());
    let db = PgPoolOptions::new()
        .max_connections(20)
        .connect(&database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&db).await?;

    let media_dir = PathBuf::from(std::env::var("MEDIA_DIR").unwrap_or_else(|_| "./data/media".into()));
    tokio::fs::create_dir_all(&media_dir).await?;

    let config = Config {
        stun_urls: env_list("STUN_URLS", "stun:stun.l.google.com:19302"),
        turn_urls: env_list("TURN_URLS", ""),
        turn_username: std::env::var("TURN_USERNAME").unwrap_or_default(),
        turn_credential: std::env::var("TURN_CREDENTIAL").unwrap_or_default(),
        turn_secret: std::env::var("TURN_SECRET").unwrap_or_default(),
        max_upload_mb: std::env::var("MAX_UPLOAD_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(100),
    };

    let state = AppState {
        db: db.clone(),
        hub: Arc::new(ws::Hub::default()),
        media_dir,
        sms: Arc::new(sms::SmsSender::from_env()),
        config: Arc::new(config),
    };

    messages::spawn_expiry_task(state.clone());

    let api = Router::new()
        .merge(auth::routes())
        .merge(users::routes())
        .merge(chats::routes())
        .merge(messages::routes())
        .merge(media::routes())
        .merge(calls::routes())
        .route("/health", get(|| async { "ok" }));

    let web_dir = PathBuf::from(std::env::var("WEB_DIR").unwrap_or_else(|_| "./web".into()));
    let index = web_dir.join("index.html");

    let max_body = state.config.max_upload_mb * 1024 * 1024;
    let app = Router::new()
        .nest("/api", api)
        .route("/ws", get(ws::handler))
        .fallback_service(ServeDir::new(&web_dir).fallback(ServeFile::new(index)))
        .layer(DefaultBodyLimit::max(max_body))
        .layer(CorsLayer::very_permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Relay server listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// Tiny boxed-error result so main can use `?` without pulling in anyhow.
mod anyhow_free {
    pub type Result = std::result::Result<(), Box<dyn std::error::Error + Send + Sync>>;
}
