use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    models::{self, MessageOut, MessageRow, MESSAGE_COLS},
    ws, AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/chats/{id}/messages", get(list).post(send))
        .route("/chats/{id}/read", post(mark_read))
        .route("/chats/{id}/media", get(chat_media))
        .route("/messages/{id}", patch(edit).delete(delete_message))
        .route("/messages/{id}/react", post(react))
        .route("/messages/{id}/star", post(star).delete(unstar))
        .route("/messages/{id}/forward", post(forward))
        .route("/messages/{id}/vote", post(vote))
        .route("/messages/{id}/played", post(played))
        .route("/messages/{id}/info", get(info))
        .route("/messages/{id}/location", post(update_live_location))
        .route("/messages/{id}/stop-live", post(stop_live_location))
        .route("/starred", get(starred))
        .route("/search", get(search))
}

const EDIT_WINDOW_MIN: i64 = 15;
const DELETE_WINDOW_HOURS: i64 = 48;

#[derive(Deserialize, Clone, Default)]
pub struct NewMessage {
    pub kind: String,
    #[serde(default)]
    pub body: String,
    pub media_id: Option<Uuid>,
    pub reply_to: Option<Uuid>,
    #[serde(default)]
    pub meta: Value,
}

fn validate(m: &mut NewMessage) -> AppResult<()> {
    if m.meta.is_null() {
        m.meta = json!({});
    }
    if m.body.chars().count() > 65_536 {
        return Err(AppError::bad_request("Message too long"));
    }
    match m.kind.as_str() {
        "text" => {
            if m.body.trim().is_empty() {
                return Err(AppError::bad_request("Empty message"));
            }
        }
        "image" | "video" | "audio" | "voice" | "document" | "sticker" | "gif" => {
            if m.media_id.is_none() {
                return Err(AppError::bad_request("media_id required"));
            }
        }
        "location" => {
            let ok = m.meta.get("lat").and_then(|v| v.as_f64()).is_some()
                && m.meta.get("lng").and_then(|v| v.as_f64()).is_some();
            if !ok {
                return Err(AppError::bad_request("location needs meta.lat and meta.lng"));
            }
            if let Some(mins) = m.meta.get("live_minutes").and_then(|v| v.as_i64()) {
                let mins = mins.clamp(1, 480);
                m.meta["live_until"] = json!(Utc::now() + Duration::minutes(mins));
            }
        }
        "contact" => {
            if m.meta.get("phone").and_then(|v| v.as_str()).is_none() {
                return Err(AppError::bad_request("contact needs meta.phone"));
            }
        }
        "poll" => {
            let opts = m.meta.get("options").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
            if m.meta.get("question").and_then(|v| v.as_str()).is_none_or(|q| q.trim().is_empty()) || !(2..=12).contains(&opts) {
                return Err(AppError::bad_request("poll needs a question and 2–12 options"));
            }
        }
        _ => return Err(AppError::bad_request("Unknown message kind")),
    }
    Ok(())
}

/// Insert a message (already validated), fan it out, and return it.
pub async fn create_message(
    st: &AppState,
    sender: Uuid,
    chat_id: Uuid,
    mut msg: NewMessage,
    forwarded: bool,
) -> AppResult<MessageOut> {
    validate(&mut msg)?;
    let role = models::member_role(&st.db, chat_id, sender).await?;
    let (chat_kind, disappearing, admins_only_send): (String, i32, bool) =
        sqlx::query_as("SELECT kind, disappearing_seconds, admins_only_send FROM chats WHERE id = $1")
            .bind(chat_id)
            .fetch_one(&st.db)
            .await?;
    if chat_kind == "group" && admins_only_send && !models::is_admin(&role) {
        return Err(AppError::forbidden("Only admins can send messages to this group"));
    }
    let members = models::chat_member_ids(&st.db, chat_id).await?;
    let others: Vec<Uuid> = members.iter().copied().filter(|u| *u != sender).collect();

    // Blocking: you can't message someone you've blocked; if they blocked you,
    // the message is stored but never delivered to them (one grey tick forever).
    let mut blocked_recipients: Vec<Uuid> = vec![];
    if chat_kind == "direct" {
        if let Some(other) = others.first() {
            let rows: Vec<(Uuid,)> = sqlx::query_as(
                "SELECT blocker_id FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)",
            )
            .bind(sender)
            .bind(*other)
            .fetch_all(&st.db)
            .await?;
            if rows.iter().any(|r| r.0 == sender) {
                return Err(AppError::forbidden("Unblock this contact to send a message"));
            }
            if !rows.is_empty() {
                blocked_recipients.push(*other);
            }
        }
    }

    if let Some(reply) = msg.reply_to {
        let ok: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2")
            .bind(reply)
            .bind(chat_id)
            .fetch_optional(&st.db)
            .await?;
        if ok.is_none() {
            msg.reply_to = None;
        }
    }

    let id = Uuid::new_v4();
    let expires_at: Option<DateTime<Utc>> =
        (disappearing > 0).then(|| Utc::now() + Duration::seconds(disappearing as i64));
    let mut tx = st.db.begin().await?;
    sqlx::query(
        "INSERT INTO messages (id, chat_id, sender_id, kind, body, media_id, reply_to, forwarded, meta, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(id)
    .bind(chat_id)
    .bind(sender)
    .bind(&msg.kind)
    .bind(&msg.body)
    .bind(msg.media_id)
    .bind(msg.reply_to)
    .bind(forwarded)
    .bind(&msg.meta)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    for u in &others {
        let deliverable = !blocked_recipients.contains(u);
        let online = deliverable && st.hub.is_online(*u).await;
        sqlx::query("INSERT INTO receipts (message_id, user_id, delivered_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END)")
            .bind(id)
            .bind(*u)
            .bind(online)
            .execute(&mut *tx)
            .await?;
        if !deliverable {
            sqlx::query("INSERT INTO hidden_messages (user_id, message_id) VALUES ($1, $2)")
                .bind(*u)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }
    sqlx::query("UPDATE chat_members SET last_read_at = now() WHERE chat_id = $1 AND user_id = $2")
        .bind(chat_id)
        .bind(sender)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let out = models::load_messages(&st.db, sender, &[id]).await?.remove(0);
    let audience: Vec<Uuid> = members.into_iter().filter(|u| !blocked_recipients.contains(u)).collect();
    st.hub.send_to_users(&audience, &json!({ "type": "message.new", "message": out })).await;
    Ok(out)
}

/// System notices like "Alice added Bob". The client renders them from `meta`.
pub async fn system_message(st: &AppState, chat_id: Uuid, actor: Uuid, meta: Value) -> AppResult<()> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO messages (id, chat_id, sender_id, kind, meta) VALUES ($1, $2, $3, 'system', $4)")
        .bind(id)
        .bind(chat_id)
        .bind(actor)
        .bind(&meta)
        .execute(&st.db)
        .await?;
    let out = models::load_messages(&st.db, actor, &[id]).await?.remove(0);
    ws::emit_chat(st, chat_id, &json!({ "type": "message.new", "message": out })).await
}

async fn message_row(st: &AppState, id: Uuid) -> AppResult<MessageRow> {
    Ok(sqlx::query_as(&format!("SELECT {MESSAGE_COLS} FROM messages WHERE id = $1"))
        .bind(id)
        .fetch_one(&st.db)
        .await?)
}

async fn emit_updated(st: &AppState, id: Uuid) -> AppResult<MessageOut> {
    let out = models::load_messages(&st.db, Uuid::nil(), &[id]).await?.remove(0);
    ws::emit_chat(st, out.chat_id, &json!({ "type": "message.updated", "message": out })).await?;
    Ok(out)
}

#[derive(Deserialize)]
struct ListQ {
    before: Option<DateTime<Utc>>,
    after: Option<DateTime<Utc>>,
    limit: Option<i64>,
}

async fn list(State(st): State<AppState>, auth: AuthUser, Path(chat_id): Path<Uuid>, Query(q): Query<ListQ>) -> AppResult<Json<Vec<MessageOut>>> {
    models::member_role(&st.db, chat_id, auth.user_id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let mut rows: Vec<MessageRow> = sqlx::query_as(&format!(
        "SELECT {MESSAGE_COLS} FROM messages m
         WHERE m.chat_id = $1
           AND ($2::timestamptz IS NULL OR m.created_at < $2)
           AND ($5::timestamptz IS NULL OR m.created_at > $5)
           AND m.created_at > COALESCE((SELECT cleared_at FROM chat_members WHERE chat_id = $1 AND user_id = $3), '-infinity')
           AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.user_id = $3 AND h.message_id = m.id)
         ORDER BY m.created_at {} LIMIT $4",
        if q.after.is_some() { "ASC" } else { "DESC" }
    ))
    .bind(chat_id)
    .bind(q.before)
    .bind(auth.user_id)
    .bind(limit)
    .bind(q.after)
    .fetch_all(&st.db)
    .await?;
    if q.after.is_none() {
        rows.reverse();
    }
    let order: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    Ok(Json(models::build_messages(&st.db, auth.user_id, rows, &order).await?))
}

async fn send(State(st): State<AppState>, auth: AuthUser, Path(chat_id): Path<Uuid>, Json(msg): Json<NewMessage>) -> AppResult<Json<MessageOut>> {
    Ok(Json(create_message(&st, auth.user_id, chat_id, msg, false).await?))
}

async fn mark_read(State(st): State<AppState>, auth: AuthUser, Path(chat_id): Path<Uuid>) -> AppResult<StatusCode> {
    models::member_role(&st.db, chat_id, auth.user_id).await?;
    sqlx::query("UPDATE chat_members SET last_read_at = now() WHERE chat_id = $1 AND user_id = $2")
        .bind(chat_id)
        .bind(auth.user_id)
        .execute(&st.db)
        .await?;
    // With read receipts off, others only see "delivered" in direct chats (groups always report reads, like WhatsApp).
    let (kind,): (String,) = sqlx::query_as("SELECT kind FROM chats WHERE id = $1").bind(chat_id).fetch_one(&st.db).await?;
    let (receipts_on,): (bool,) = sqlx::query_as("SELECT read_receipts FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_one(&st.db)
        .await?;
    let set_read = kind == "group" || receipts_on;
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        "UPDATE receipts r SET delivered_at = COALESCE(r.delivered_at, now()),
                read_at = CASE WHEN $3 THEN COALESCE(r.read_at, now()) ELSE r.read_at END
         FROM messages m
         WHERE r.message_id = m.id AND m.chat_id = $1 AND r.user_id = $2
           AND (r.delivered_at IS NULL OR ($3 AND r.read_at IS NULL))
         RETURNING r.message_id",
    )
    .bind(chat_id)
    .bind(auth.user_id)
    .bind(set_read)
    .fetch_all(&st.db)
    .await?;
    let ids: Vec<Uuid> = rows.into_iter().map(|r| r.0).collect();
    ws::notify_status(&st, &ids).await?;
    // Let my other devices clear the unread badge.
    st.hub.send_to_user(auth.user_id, &json!({ "type": "chat.read", "chat_id": chat_id })).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct EditReq {
    body: String,
}

async fn edit(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>, Json(req): Json<EditReq>) -> AppResult<Json<MessageOut>> {
    let row = message_row(&st, id).await?;
    if row.sender_id != Some(auth.user_id) {
        return Err(AppError::forbidden("You can only edit your own messages"));
    }
    if row.deleted || !matches!(row.kind.as_str(), "text" | "image" | "video" | "document" | "gif") {
        return Err(AppError::bad_request("This message can't be edited"));
    }
    if Utc::now() - row.created_at > Duration::minutes(EDIT_WINDOW_MIN) {
        return Err(AppError::bad_request("Messages can only be edited for 15 minutes"));
    }
    if row.kind == "text" && req.body.trim().is_empty() {
        return Err(AppError::bad_request("Empty message"));
    }
    sqlx::query("UPDATE messages SET body = $2, edited_at = now() WHERE id = $1")
        .bind(id)
        .bind(&req.body)
        .execute(&st.db)
        .await?;
    Ok(Json(emit_updated(&st, id).await?))
}

#[derive(Deserialize)]
struct DeleteQ {
    #[serde(default)]
    scope: String,
}

async fn delete_message(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>, Query(q): Query<DeleteQ>) -> AppResult<StatusCode> {
    let row = message_row(&st, id).await?;
    let role = models::member_role(&st.db, row.chat_id, auth.user_id).await?;
    if q.scope == "everyone" {
        let own = row.sender_id == Some(auth.user_id);
        let (kind,): (String,) = sqlx::query_as("SELECT kind FROM chats WHERE id = $1").bind(row.chat_id).fetch_one(&st.db).await?;
        let admin_ok = kind == "group" && models::is_admin(&role);
        if !own && !admin_ok {
            return Err(AppError::forbidden("You can only delete your own messages for everyone"));
        }
        if own && !admin_ok && Utc::now() - row.created_at > Duration::hours(DELETE_WINDOW_HOURS) {
            return Err(AppError::bad_request("Too late to delete for everyone"));
        }
        sqlx::query("UPDATE messages SET deleted = true, body = '', media_id = NULL, meta = jsonb_build_object('deleted_by', $2::text) WHERE id = $1")
            .bind(id)
            .bind(auth.user_id.to_string())
            .execute(&st.db)
            .await?;
        sqlx::query("DELETE FROM reactions WHERE message_id = $1").bind(id).execute(&st.db).await?;
        emit_updated(&st, id).await?;
    } else {
        sqlx::query("INSERT INTO hidden_messages (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(auth.user_id)
            .bind(id)
            .execute(&st.db)
            .await?;
        st.hub
            .send_to_user(auth.user_id, &json!({ "type": "message.hidden", "chat_id": row.chat_id, "id": id }))
            .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ReactReq {
    #[serde(default)]
    emoji: String,
}

async fn react(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>, Json(req): Json<ReactReq>) -> AppResult<Json<MessageOut>> {
    let row = message_row(&st, id).await?;
    models::member_role(&st.db, row.chat_id, auth.user_id).await?;
    if row.deleted || row.kind == "system" {
        return Err(AppError::bad_request("Can't react to this message"));
    }
    let emoji = req.emoji.trim();
    if emoji.is_empty() {
        sqlx::query("DELETE FROM reactions WHERE message_id = $1 AND user_id = $2")
            .bind(id)
            .bind(auth.user_id)
            .execute(&st.db)
            .await?;
    } else {
        if emoji.chars().count() > 8 {
            return Err(AppError::bad_request("Reaction must be one emoji"));
        }
        sqlx::query(
            "INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
             ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = $3, created_at = now()",
        )
        .bind(id)
        .bind(auth.user_id)
        .bind(emoji)
        .execute(&st.db)
        .await?;
    }
    Ok(Json(emit_updated(&st, id).await?))
}

async fn star(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    let row = message_row(&st, id).await?;
    models::member_role(&st.db, row.chat_id, auth.user_id).await?;
    sqlx::query("INSERT INTO stars (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(auth.user_id)
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unstar(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM stars WHERE user_id = $1 AND message_id = $2")
        .bind(auth.user_id)
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn starred(State(st): State<AppState>, auth: AuthUser) -> AppResult<Json<Vec<MessageOut>>> {
    let ids: Vec<Uuid> = sqlx::query_as::<_, (Uuid,)>(
        "SELECT s.message_id FROM stars s JOIN messages m ON m.id = s.message_id
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = s.user_id
         WHERE s.user_id = $1 AND NOT m.deleted ORDER BY s.created_at DESC LIMIT 500",
    )
    .bind(auth.user_id)
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|r| r.0)
    .collect();
    Ok(Json(models::load_messages(&st.db, auth.user_id, &ids).await?))
}

#[derive(Deserialize)]
struct ForwardReq {
    chat_ids: Vec<Uuid>,
}

async fn forward(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>, Json(req): Json<ForwardReq>) -> AppResult<Json<Vec<MessageOut>>> {
    let row = message_row(&st, id).await?;
    models::member_role(&st.db, row.chat_id, auth.user_id).await?;
    if row.deleted || row.kind == "system" {
        return Err(AppError::bad_request("Can't forward this message"));
    }
    if req.chat_ids.len() > 5 {
        return Err(AppError::bad_request("You can forward to up to 5 chats at once"));
    }
    let mut meta = row.meta.clone();
    if let Some(o) = meta.as_object_mut() {
        o.remove("live_until");
        o.remove("live_minutes");
    }
    let mut out = vec![];
    for chat_id in req.chat_ids {
        let msg = NewMessage { kind: row.kind.clone(), body: row.body.clone(), media_id: row.media_id, reply_to: None, meta: meta.clone() };
        out.push(create_message(&st, auth.user_id, chat_id, msg, true).await?);
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
struct VoteReq {
    options: Vec<i32>,
}

async fn vote(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>, Json(req): Json<VoteReq>) -> AppResult<Json<MessageOut>> {
    let row = message_row(&st, id).await?;
    models::member_role(&st.db, row.chat_id, auth.user_id).await?;
    if row.kind != "poll" || row.deleted {
        return Err(AppError::bad_request("Not a poll"));
    }
    let n = row.meta.get("options").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0) as i32;
    let multiple = row.meta.get("multiple").and_then(|v| v.as_bool()).unwrap_or(false);
    if !multiple && req.options.len() > 1 {
        return Err(AppError::bad_request("This poll allows one answer"));
    }
    let mut tx = st.db.begin().await?;
    sqlx::query("DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2")
        .bind(id)
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await?;
    for o in req.options.into_iter().filter(|o| (0..n).contains(o)) {
        sqlx::query("INSERT INTO poll_votes (message_id, user_id, option_idx) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
            .bind(id)
            .bind(auth.user_id)
            .bind(o)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(emit_updated(&st, id).await?))
}

async fn played(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    sqlx::query(
        "UPDATE receipts SET played_at = COALESCE(played_at, now()), read_at = COALESCE(read_at, now()), delivered_at = COALESCE(delivered_at, now())
         WHERE message_id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(auth.user_id)
    .execute(&st.db)
    .await?;
    ws::notify_status(&st, &[id]).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn info(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let row = message_row(&st, id).await?;
    if row.sender_id != Some(auth.user_id) {
        return Err(AppError::forbidden("Message info is only available for your own messages"));
    }
    let rows: Vec<(Uuid, Option<DateTime<Utc>>, Option<DateTime<Utc>>, Option<DateTime<Utc>>)> =
        sqlx::query_as("SELECT user_id, delivered_at, read_at, played_at FROM receipts WHERE message_id = $1")
            .bind(id)
            .fetch_all(&st.db)
            .await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(u, d, r, p)| json!({ "user_id": u, "delivered_at": d, "read_at": r, "played_at": p }))
        .collect();
    Ok(Json(json!({ "receipts": list })))
}

#[derive(Deserialize)]
struct LocReq {
    lat: f64,
    lng: f64,
}

async fn update_live_location(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>, Json(req): Json<LocReq>) -> AppResult<StatusCode> {
    let row = message_row(&st, id).await?;
    let live_until = row
        .meta
        .get("live_until")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<DateTime<Utc>>().ok());
    if row.sender_id != Some(auth.user_id) || row.kind != "location" || live_until.is_none_or(|t| t < Utc::now()) {
        return Err(AppError::bad_request("Live location isn't active"));
    }
    sqlx::query("UPDATE messages SET meta = meta || jsonb_build_object('lat', $2::float8, 'lng', $3::float8, 'updated_at', now()) WHERE id = $1")
        .bind(id)
        .bind(req.lat)
        .bind(req.lng)
        .execute(&st.db)
        .await?;
    emit_updated(&st, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn stop_live_location(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    let row = message_row(&st, id).await?;
    if row.sender_id != Some(auth.user_id) || row.kind != "location" {
        return Err(AppError::forbidden("Not your live location"));
    }
    sqlx::query("UPDATE messages SET meta = meta || jsonb_build_object('live_until', now()) WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await?;
    emit_updated(&st, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct MediaQ {
    #[serde(default)]
    kind: String,
}

/// Media, links and docs tab for chat info.
async fn chat_media(State(st): State<AppState>, auth: AuthUser, Path(chat_id): Path<Uuid>, Query(q): Query<MediaQ>) -> AppResult<Json<Vec<MessageOut>>> {
    models::member_role(&st.db, chat_id, auth.user_id).await?;
    let filter = match q.kind.as_str() {
        "docs" => "m.kind = 'document'",
        "links" => "m.kind = 'text' AND m.body ~* 'https?://'",
        _ => "m.kind IN ('image', 'video', 'gif')",
    };
    let ids: Vec<Uuid> = sqlx::query_as::<_, (Uuid,)>(&format!(
        "SELECT m.id FROM messages m WHERE m.chat_id = $1 AND NOT m.deleted AND {filter}
           AND m.created_at > COALESCE((SELECT cleared_at FROM chat_members WHERE chat_id = $1 AND user_id = $2), '-infinity')
           AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.user_id = $2 AND h.message_id = m.id)
         ORDER BY m.created_at DESC LIMIT 300"
    ))
    .bind(chat_id)
    .bind(auth.user_id)
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|r| r.0)
    .collect();
    Ok(Json(models::load_messages(&st.db, auth.user_id, &ids).await?))
}

#[derive(Deserialize)]
struct SearchQ {
    q: String,
    chat_id: Option<Uuid>,
}

async fn search(State(st): State<AppState>, auth: AuthUser, Query(q): Query<SearchQ>) -> AppResult<Json<Vec<MessageOut>>> {
    let term = q.q.trim();
    if term.is_empty() {
        return Ok(Json(vec![]));
    }
    let pattern = format!("%{}%", term.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let ids: Vec<Uuid> = sqlx::query_as::<_, (Uuid,)>(
        "SELECT m.id FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
         WHERE NOT m.deleted AND m.kind <> 'system' AND (m.body ILIKE $2 OR m.meta->>'filename' ILIKE $2)
           AND ($3::uuid IS NULL OR m.chat_id = $3)
           AND (cm.cleared_at IS NULL OR m.created_at > cm.cleared_at)
           AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.user_id = $1 AND h.message_id = m.id)
         ORDER BY m.created_at DESC LIMIT 100",
    )
    .bind(auth.user_id)
    .bind(pattern)
    .bind(q.chat_id)
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|r| r.0)
    .collect();
    Ok(Json(models::load_messages(&st.db, auth.user_id, &ids).await?))
}

/// Deletes disappearing messages once they expire.
pub fn spawn_expiry_task(st: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            tick.tick().await;
            let expired: Result<Vec<(Uuid, Uuid)>, _> = sqlx::query_as(
                "DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < now() RETURNING id, chat_id",
            )
            .fetch_all(&st.db)
            .await;
            if let Ok(rows) = expired {
                for (id, chat_id) in rows {
                    let _ = ws::emit_chat(&st, chat_id, &json!({ "type": "message.expired", "chat_id": chat_id, "id": id })).await;
                }
            }
        }
    });
}
