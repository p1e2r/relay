use crate::{
    auth::{hash_pin, normalize_phone, AuthUser},
    error::{AppError, AppResult},
    models, AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/me", get(get_me).patch(update_me).delete(delete_account))
        .route("/me/pin", put(set_pin).delete(remove_pin))
        .route("/users/lookup", get(lookup))
        .route("/users/{id}", get(get_user))
        .route("/contacts", get(list_contacts).post(add_contact))
        .route("/contacts/sync", post(sync_contacts))
        .route("/contacts/{id}", delete(remove_contact))
        .route("/blocks", get(list_blocks))
        .route("/blocks/{id}", post(block).delete(unblock))
}

async fn get_me(State(st): State<AppState>, auth: AuthUser) -> AppResult<Json<models::Me>> {
    Ok(Json(models::load_me(&st.db, auth.user_id).await?))
}

#[derive(Deserialize)]
struct UpdateMe {
    name: Option<String>,
    about: Option<String>,
    avatar_id: Option<Uuid>,
    #[serde(default)]
    remove_avatar: bool,
    privacy_last_seen: Option<String>,
    privacy_photo: Option<String>,
    privacy_about: Option<String>,
    privacy_groups: Option<String>,
    privacy_messages: Option<String>,
    read_receipts: Option<bool>,
}

fn check_privacy(v: &Option<String>) -> AppResult<()> {
    match v.as_deref() {
        None | Some("everyone") | Some("contacts") | Some("nobody") => Ok(()),
        _ => Err(AppError::bad_request("Privacy must be everyone, contacts or nobody")),
    }
}

/// Everyone who shares a chat with this user.
pub async fn audience(st: &AppState, user: Uuid) -> AppResult<Vec<Uuid>> {
    Ok(sqlx::query_as::<_, (Uuid,)>(
        "SELECT DISTINCT cm2.user_id FROM chat_members cm1 JOIN chat_members cm2 ON cm2.chat_id = cm1.chat_id WHERE cm1.user_id = $1",
    )
    .bind(user)
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|r| r.0)
    .collect())
}

async fn update_me(State(st): State<AppState>, auth: AuthUser, Json(req): Json<UpdateMe>) -> AppResult<Json<models::Me>> {
    for p in [&req.privacy_last_seen, &req.privacy_photo, &req.privacy_about, &req.privacy_groups] {
        check_privacy(p)?;
    }
    if !matches!(req.privacy_messages.as_deref(), None | Some("everyone") | Some("contacts")) {
        return Err(AppError::bad_request("Who can message you must be everyone or contacts"));
    }
    if let Some(n) = &req.name {
        if n.trim().is_empty() || n.chars().count() > 25 {
            return Err(AppError::bad_request("Name must be 1–25 characters"));
        }
    }
    if req.about.as_ref().is_some_and(|a| a.chars().count() > 139) {
        return Err(AppError::bad_request("About can be at most 139 characters"));
    }
    sqlx::query(
        "UPDATE users SET
            name = COALESCE($2, name),
            about = COALESCE($3, about),
            avatar_id = CASE WHEN $5 THEN NULL ELSE COALESCE($4, avatar_id) END,
            privacy_last_seen = COALESCE($6, privacy_last_seen),
            privacy_photo = COALESCE($7, privacy_photo),
            privacy_about = COALESCE($8, privacy_about),
            privacy_groups = COALESCE($9, privacy_groups),
            read_receipts = COALESCE($10, read_receipts),
            privacy_messages = COALESCE($11, privacy_messages)
         WHERE id = $1",
    )
    .bind(auth.user_id)
    .bind(req.name.map(|n| n.trim().to_string()))
    .bind(req.about)
    .bind(req.avatar_id)
    .bind(req.remove_avatar)
    .bind(req.privacy_last_seen)
    .bind(req.privacy_photo)
    .bind(req.privacy_about)
    .bind(req.privacy_groups)
    .bind(req.read_receipts)
    .bind(req.privacy_messages)
    .execute(&st.db)
    .await?;
    let aud = audience(&st, auth.user_id).await?;
    st.hub.send_to_users(&aud, &json!({ "type": "user.updated", "user_id": auth.user_id })).await;
    Ok(Json(models::load_me(&st.db, auth.user_id).await?))
}

async fn delete_account(State(st): State<AppState>, auth: AuthUser) -> AppResult<StatusCode> {
    // Direct chats go with the account; groups keep their history.
    sqlx::query(
        "DELETE FROM chats WHERE kind = 'direct' AND id IN (SELECT chat_id FROM chat_members WHERE user_id = $1)",
    )
    .bind(auth.user_id)
    .execute(&st.db)
    .await?;
    sqlx::query("DELETE FROM users WHERE id = $1").bind(auth.user_id).execute(&st.db).await?;
    st.hub.disconnect_session(auth.session_id).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct PinReq {
    pin: String,
}

async fn set_pin(State(st): State<AppState>, auth: AuthUser, Json(req): Json<PinReq>) -> AppResult<StatusCode> {
    let hash = hash_pin(&req.pin)?;
    sqlx::query("UPDATE users SET pin_hash = $2 WHERE id = $1").bind(auth.user_id).bind(hash).execute(&st.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_pin(State(st): State<AppState>, auth: AuthUser) -> AppResult<StatusCode> {
    sqlx::query("UPDATE users SET pin_hash = NULL WHERE id = $1").bind(auth.user_id).execute(&st.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_user(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<Json<models::UserPublic>> {
    let mut users = models::public_users(&st, auth.user_id, &[id]).await?;
    users.remove(&id).map(Json).ok_or_else(AppError::not_found)
}

#[derive(Deserialize)]
struct LookupQ {
    phone: String,
}

async fn lookup(State(st): State<AppState>, auth: AuthUser, Query(q): Query<LookupQ>) -> AppResult<Json<models::UserPublic>> {
    let phone = normalize_phone(&q.phone)?;
    let row: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE phone = $1")
        .bind(&phone)
        .fetch_optional(&st.db)
        .await?;
    let (id,) = row.ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "not_on_relay", "This number isn't on Relay yet"))?;
    let mut users = models::public_users(&st, auth.user_id, &[id]).await?;
    users.remove(&id).map(Json).ok_or_else(AppError::not_found)
}

async fn list_contacts(State(st): State<AppState>, auth: AuthUser) -> AppResult<Json<Value>> {
    let ids: Vec<Uuid> = sqlx::query_as::<_, (Uuid,)>("SELECT contact_id FROM contacts WHERE owner_id = $1")
        .bind(auth.user_id)
        .fetch_all(&st.db)
        .await?
        .into_iter()
        .map(|r| r.0)
        .collect();
    let users = models::public_users(&st, auth.user_id, &ids).await?;
    let mut list: Vec<_> = users.into_values().collect();
    list.sort_by_key(|u| u.contact_name.clone().unwrap_or_else(|| u.name.clone()).to_lowercase());
    Ok(Json(json!(list)))
}

#[derive(Deserialize)]
struct AddContact {
    phone: String,
    #[serde(default)]
    name: String,
}

async fn add_contact(State(st): State<AppState>, auth: AuthUser, Json(req): Json<AddContact>) -> AppResult<Json<models::UserPublic>> {
    let phone = normalize_phone(&req.phone)?;
    let row: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE phone = $1")
        .bind(&phone)
        .fetch_optional(&st.db)
        .await?;
    let (id,) = row.ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "not_on_relay", "This number isn't on Relay yet"))?;
    if id == auth.user_id {
        return Err(AppError::bad_request("That's your own number"));
    }
    sqlx::query(
        "INSERT INTO contacts (owner_id, contact_id, name) VALUES ($1, $2, $3)
         ON CONFLICT (owner_id, contact_id) DO UPDATE SET name = $3",
    )
    .bind(auth.user_id)
    .bind(id)
    .bind(req.name.trim())
    .execute(&st.db)
    .await?;
    let mut users = models::public_users(&st, auth.user_id, &[id]).await?;
    users.remove(&id).map(Json).ok_or_else(AppError::not_found)
}

#[derive(Deserialize)]
struct SyncEntry {
    phone: String,
    #[serde(default)]
    name: String,
}

/// Upload phone-book entries; the ones on Relay are saved as contacts and returned.
async fn sync_contacts(State(st): State<AppState>, auth: AuthUser, Json(entries): Json<Vec<SyncEntry>>) -> AppResult<Json<Value>> {
    let mut found = vec![];
    for e in entries.into_iter().take(5000) {
        let Ok(phone) = normalize_phone(&e.phone) else { continue };
        if let Some((id,)) = sqlx::query_as::<_, (Uuid,)>("SELECT id FROM users WHERE phone = $1")
            .bind(&phone)
            .fetch_optional(&st.db)
            .await?
        {
            if id == auth.user_id {
                continue;
            }
            sqlx::query(
                "INSERT INTO contacts (owner_id, contact_id, name) VALUES ($1, $2, $3)
                 ON CONFLICT (owner_id, contact_id) DO UPDATE SET name = $3",
            )
            .bind(auth.user_id)
            .bind(id)
            .bind(e.name.trim())
            .execute(&st.db)
            .await?;
            found.push(id);
        }
    }
    let users = models::public_users(&st, auth.user_id, &found).await?;
    Ok(Json(json!(users.into_values().collect::<Vec<_>>())))
}

async fn remove_contact(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM contacts WHERE owner_id = $1 AND contact_id = $2")
        .bind(auth.user_id)
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_blocks(State(st): State<AppState>, auth: AuthUser) -> AppResult<Json<Value>> {
    let ids: Vec<Uuid> = sqlx::query_as::<_, (Uuid,)>("SELECT blocked_id FROM blocks WHERE blocker_id = $1 ORDER BY created_at DESC")
        .bind(auth.user_id)
        .fetch_all(&st.db)
        .await?
        .into_iter()
        .map(|r| r.0)
        .collect();
    let users = models::public_users(&st, auth.user_id, &ids).await?;
    Ok(Json(json!(ids.iter().filter_map(|i| users.get(i)).collect::<Vec<_>>())))
}

async fn block(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    if id == auth.user_id {
        return Err(AppError::bad_request("You can't block yourself"));
    }
    sqlx::query("INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(auth.user_id)
        .bind(id)
        .execute(&st.db)
        .await?;
    st.hub.send_to_user(id, &json!({ "type": "user.updated", "user_id": auth.user_id })).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn unblock(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2")
        .bind(auth.user_id)
        .bind(id)
        .execute(&st.db)
        .await?;
    st.hub.send_to_user(id, &json!({ "type": "user.updated", "user_id": auth.user_id })).await;
    Ok(StatusCode::NO_CONTENT)
}
