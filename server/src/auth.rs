use crate::{
    error::{AppError, AppResult},
    models::{self, Me},
    AppState,
};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{FromRequestParts, Path, State},
    http::{request::Parts, StatusCode},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/request-code", post(request_code))
        .route("/auth/verify", post(verify))
        .route("/auth/logout", post(logout))
        .route("/auth/sessions", get(list_sessions))
        .route("/auth/sessions/{id}", delete(revoke_session))
}

pub fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// Normalise to E.164: leading '+' then 8–15 digits.
pub fn normalize_phone(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    let digits: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
    if !trimmed.starts_with('+') || digits.len() < 8 || digits.len() > 15 {
        return Err(AppError::bad_request(
            "Enter your number in international format, e.g. +62 812 3456 7890",
        ));
    }
    Ok(format!("+{digits}"))
}

#[derive(Clone, Copy)]
pub struct AuthUser {
    pub user_id: Uuid,
    pub session_id: Uuid,
}

fn token_from_parts(parts: &Parts) -> Option<String> {
    if let Some(h) = parts.headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(t) = h.strip_prefix("Bearer ") {
            return Some(t.trim().to_string());
        }
    }
    parts.uri.query().and_then(|q| {
        q.split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(k, _)| *k == "token")
            .map(|(_, v)| v.to_string())
    })
}

pub async fn authenticate(state: &AppState, token: &str) -> AppResult<AuthUser> {
    let row: Option<(Uuid, Uuid, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, user_id, last_active FROM sessions WHERE token_hash = $1",
    )
    .bind(sha256_hex(token))
    .fetch_optional(&state.db)
    .await?;
    let (session_id, user_id, last_active) = row.ok_or_else(AppError::unauthorized)?;
    if Utc::now() - last_active > Duration::minutes(5) {
        sqlx::query("UPDATE sessions SET last_active = now() WHERE id = $1")
            .bind(session_id)
            .execute(&state.db)
            .await?;
    }
    Ok(AuthUser { user_id, session_id })
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = token_from_parts(parts).ok_or_else(AppError::unauthorized)?;
        authenticate(state, &token).await
    }
}

#[derive(Deserialize)]
struct RequestCode {
    phone: String,
}

/// Optional store-review account: REVIEW_PHONE gets the fixed REVIEW_CODE instead of an SMS.
fn review_code(phone: &str) -> Option<String> {
    let rp = std::env::var("REVIEW_PHONE").ok()?;
    let rc = std::env::var("REVIEW_CODE").ok().filter(|c| c.len() == 6 && c.chars().all(|x| x.is_ascii_digit()))?;
    (normalize_phone(&rp).ok()? == phone).then_some(rc)
}

async fn request_code(State(st): State<AppState>, Json(req): Json<RequestCode>) -> AppResult<Json<Value>> {
    let phone = normalize_phone(&req.phone)?;
    let recent: Option<(DateTime<Utc>,)> = sqlx::query_as("SELECT sent_at FROM otp_codes WHERE phone = $1")
        .bind(&phone)
        .fetch_optional(&st.db)
        .await?;
    if let Some((sent_at,)) = recent {
        let wait = 30 - (Utc::now() - sent_at).num_seconds();
        if wait > 0 {
            return Err(AppError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                format!("Wait {wait}s before requesting another code"),
            ));
        }
    }
    let fixed = review_code(&phone);
    let code = fixed.clone().unwrap_or_else(|| format!("{:06}", rand::thread_rng().gen_range(0..1_000_000)));
    sqlx::query(
        "INSERT INTO otp_codes (phone, code_hash, expires_at, sent_at, attempts)
         VALUES ($1, $2, now() + interval '10 minutes', now(), 0)
         ON CONFLICT (phone) DO UPDATE SET code_hash = $2, expires_at = now() + interval '10 minutes', sent_at = now(), attempts = 0",
    )
    .bind(&phone)
    .bind(sha256_hex(&format!("{phone}:{code}")))
    .execute(&st.db)
    .await?;
    if fixed.is_some() {
        return Ok(Json(json!({ "phone": phone, "expires_in": 600 })));
    }
    st.sms.send_code(&phone, &code).await.map_err(|e| {
        tracing::error!("sms send failed: {e}");
        AppError::new(StatusCode::BAD_GATEWAY, "sms_failed", "Couldn't send the SMS code, try again")
    })?;
    Ok(Json(json!({ "phone": phone, "expires_in": 600 })))
}

#[derive(Deserialize)]
struct Verify {
    phone: String,
    code: String,
    #[serde(default)]
    pin: Option<String>,
    #[serde(default)]
    device_name: Option<String>,
}

async fn verify(State(st): State<AppState>, Json(req): Json<Verify>) -> AppResult<Json<Value>> {
    let phone = normalize_phone(&req.phone)?;
    let row: Option<(String, DateTime<Utc>, i32)> =
        sqlx::query_as("SELECT code_hash, expires_at, attempts FROM otp_codes WHERE phone = $1")
            .bind(&phone)
            .fetch_optional(&st.db)
            .await?;
    let (hash, expires_at, attempts) =
        row.ok_or_else(|| AppError::bad_request("Request a code first"))?;
    if expires_at < Utc::now() || attempts >= 5 {
        return Err(AppError::bad_request("Code expired, request a new one"));
    }
    if sha256_hex(&format!("{phone}:{}", req.code.trim())) != hash {
        sqlx::query("UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = $1")
            .bind(&phone)
            .execute(&st.db)
            .await?;
        return Err(AppError::new(StatusCode::UNAUTHORIZED, "wrong_code", "Wrong code"));
    }

    let existing: Option<(Uuid, Option<String>)> =
        sqlx::query_as("SELECT id, pin_hash FROM users WHERE phone = $1")
            .bind(&phone)
            .fetch_optional(&st.db)
            .await?;
    let (user_id, is_new) = match existing {
        Some((id, pin_hash)) => {
            if let Some(pin_hash) = pin_hash {
                let Some(pin) = req.pin.as_deref() else {
                    return Err(AppError::new(StatusCode::UNAUTHORIZED, "pin_required", "Enter your two-step verification PIN"));
                };
                let parsed = PasswordHash::new(&pin_hash).map_err(|_| AppError::bad_request("Bad PIN state"))?;
                if Argon2::default().verify_password(pin.as_bytes(), &parsed).is_err() {
                    return Err(AppError::new(StatusCode::UNAUTHORIZED, "wrong_pin", "Wrong PIN"));
                }
            }
            (id, false)
        }
        None => {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO users (id, phone) VALUES ($1, $2)")
                .bind(id)
                .bind(&phone)
                .execute(&st.db)
                .await?;
            (id, true)
        }
    };
    sqlx::query("DELETE FROM otp_codes WHERE phone = $1").bind(&phone).execute(&st.db).await?;

    let token: String = {
        let bytes: [u8; 32] = rand::thread_rng().gen();
        hex::encode(bytes)
    };
    let session_id = Uuid::new_v4();
    let device = req.device_name.unwrap_or_else(|| "Unknown device".into());
    sqlx::query("INSERT INTO sessions (id, user_id, token_hash, device_name) VALUES ($1, $2, $3, $4)")
        .bind(session_id)
        .bind(user_id)
        .bind(sha256_hex(&token))
        .bind(device.chars().take(80).collect::<String>())
        .execute(&st.db)
        .await?;
    let me: Me = models::load_me(&st.db, user_id).await?;
    Ok(Json(json!({ "token": token, "new_user": is_new, "user": me })))
}

pub fn hash_pin(pin: &str) -> AppResult<String> {
    if pin.len() != 6 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::bad_request("PIN must be 6 digits"));
    }
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pin.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| AppError::bad_request("Couldn't hash PIN"))
}

async fn logout(State(st): State<AppState>, auth: AuthUser) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM sessions WHERE id = $1").bind(auth.session_id).execute(&st.db).await?;
    st.hub.disconnect_session(auth.session_id).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_sessions(State(st): State<AppState>, auth: AuthUser) -> AppResult<Json<Value>> {
    let rows: Vec<(Uuid, String, DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, device_name, created_at, last_active FROM sessions WHERE user_id = $1 ORDER BY last_active DESC",
    )
    .bind(auth.user_id)
    .fetch_all(&st.db)
    .await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, device, created, active)| {
            json!({ "id": id, "device_name": device, "created_at": created, "last_active": active, "current": id == auth.session_id })
        })
        .collect();
    Ok(Json(json!(list)))
}

async fn revoke_session(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM sessions WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(auth.user_id)
        .execute(&st.db)
        .await?;
    st.hub.disconnect_session(id).await;
    Ok(StatusCode::NO_CONTENT)
}
