use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    messages::{self, NewMessage},
    models::{self, ChatOut, MessageOut},
    ws, AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, patch, post},
    Json, Router,
};
use rand::{distributions::Alphanumeric, Rng};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/chats", get(list))
        .route("/chats/direct", post(open_direct))
        .route("/chats/group", post(create_group))
        .route("/chats/{id}", get(get_chat).patch(update_chat).delete(delete_chat))
        .route("/chats/{id}/settings", patch(my_settings))
        .route("/chats/{id}/clear", post(clear))
        .route("/chats/{id}/leave", post(leave))
        .route("/chats/{id}/invite", post(reset_invite))
        .route("/chats/{id}/members", post(add_members))
        .route("/chats/{id}/members/{uid}", delete(remove_member).patch(set_role))
        .route("/join/{code}", get(invite_preview).post(join))
        .route("/broadcasts", get(list_broadcasts).post(create_broadcast))
        .route("/broadcasts/{id}", delete(delete_broadcast))
        .route("/broadcasts/{id}/send", post(send_broadcast))
}

fn new_invite_code() -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(22).map(char::from).collect()
}

async fn emit_chat_updated(st: &AppState, chat_id: Uuid) -> AppResult<()> {
    ws::emit_chat(st, chat_id, &json!({ "type": "chat.updated", "chat_id": chat_id })).await
}

async fn list(State(st): State<AppState>, auth: AuthUser) -> AppResult<Json<Vec<ChatOut>>> {
    Ok(Json(models::load_chats(&st, auth.user_id, None).await?))
}

async fn get_chat(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<Json<ChatOut>> {
    Ok(Json(models::load_chat(&st, auth.user_id, id).await?))
}

pub async fn direct_chat(st: &AppState, a: Uuid, b: Uuid) -> AppResult<Uuid> {
    if a == b {
        return Err(AppError::bad_request("Use \"Message yourself\" via your own number"));
    }
    let exists: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM users WHERE id = $1").bind(b).fetch_optional(&st.db).await?;
    if exists.is_none() {
        return Err(AppError::not_found());
    }
    let key = if a < b { format!("{a}:{b}") } else { format!("{b}:{a}") };
    if let Some((id,)) = sqlx::query_as::<_, (Uuid,)>("SELECT id FROM chats WHERE direct_key = $1")
        .bind(&key)
        .fetch_optional(&st.db)
        .await?
    {
        // Re-add if someone deleted their account and came back etc.
        for u in [a, b] {
            sqlx::query("INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
                .bind(id)
                .bind(u)
                .execute(&st.db)
                .await?;
        }
        return Ok(id);
    }
    let id = Uuid::new_v4();
    let mut tx = st.db.begin().await?;
    sqlx::query("INSERT INTO chats (id, kind, created_by, direct_key) VALUES ($1, 'direct', $2, $3)")
        .bind(id)
        .bind(a)
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    for u in [a, b] {
        sqlx::query("INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)")
            .bind(id)
            .bind(u)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(id)
}

#[derive(Deserialize)]
struct DirectReq {
    user_id: Uuid,
}

async fn open_direct(State(st): State<AppState>, auth: AuthUser, Json(req): Json<DirectReq>) -> AppResult<Json<ChatOut>> {
    let id = direct_chat(&st, auth.user_id, req.user_id).await?;
    Ok(Json(models::load_chat(&st, auth.user_id, id).await?))
}

/// Respect each person's "who can add me to groups" setting.
async fn can_add_to_group(st: &AppState, adder: Uuid, target: Uuid) -> AppResult<bool> {
    let row: Option<(String, bool, bool)> = sqlx::query_as(
        "SELECT u.privacy_groups,
                EXISTS (SELECT 1 FROM contacts c WHERE c.owner_id = u.id AND c.contact_id = $1),
                EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = $1) OR (b.blocker_id = $1 AND b.blocked_id = u.id))
         FROM users u WHERE u.id = $2",
    )
    .bind(adder)
    .bind(target)
    .fetch_optional(&st.db)
    .await?;
    Ok(match row {
        None => false,
        Some((_, _, true)) => false,
        Some((p, is_contact, false)) => p == "everyone" || (p == "contacts" && is_contact),
    })
}

#[derive(Deserialize)]
struct GroupReq {
    name: String,
    #[serde(default)]
    description: String,
    avatar_id: Option<Uuid>,
    #[serde(default)]
    member_ids: Vec<Uuid>,
}

async fn create_group(State(st): State<AppState>, auth: AuthUser, Json(req): Json<GroupReq>) -> AppResult<Json<Value>> {
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(AppError::bad_request("Group name must be 1–100 characters"));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO chats (id, kind, name, description, avatar_id, created_by, invite_code) VALUES ($1, 'group', $2, $3, $4, $5, $6)")
        .bind(id)
        .bind(name)
        .bind(&req.description)
        .bind(req.avatar_id)
        .bind(auth.user_id)
        .bind(new_invite_code())
        .execute(&st.db)
        .await?;
    sqlx::query("INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'owner')")
        .bind(id)
        .bind(auth.user_id)
        .execute(&st.db)
        .await?;
    messages::system_message(&st, id, auth.user_id, json!({ "action": "created", "name": name })).await?;
    let (added, skipped) = add_users(&st, id, auth.user_id, &req.member_ids).await?;
    if !added.is_empty() {
        messages::system_message(&st, id, auth.user_id, json!({ "action": "added", "targets": added })).await?;
    }
    let chat = models::load_chat(&st, auth.user_id, id).await?;
    Ok(Json(json!({ "chat": chat, "skipped": skipped })))
}

const MAX_GROUP: i64 = 1024;

async fn add_users(st: &AppState, chat_id: Uuid, adder: Uuid, ids: &[Uuid]) -> AppResult<(Vec<Uuid>, Vec<Uuid>)> {
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM chat_members WHERE chat_id = $1")
        .bind(chat_id)
        .fetch_one(&st.db)
        .await?;
    let mut added = vec![];
    let mut skipped = vec![];
    for &u in ids {
        if u == adder {
            continue;
        }
        if count + added.len() as i64 >= MAX_GROUP || !can_add_to_group(st, adder, u).await? {
            skipped.push(u);
            continue;
        }
        let res = sqlx::query("INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(chat_id)
            .bind(u)
            .execute(&st.db)
            .await?;
        if res.rows_affected() > 0 {
            added.push(u);
        }
    }
    st.hub.send_to_users(&added, &json!({ "type": "chat.updated", "chat_id": chat_id })).await;
    Ok((added, skipped))
}

#[derive(Deserialize)]
struct UpdateChat {
    name: Option<String>,
    description: Option<String>,
    avatar_id: Option<Uuid>,
    #[serde(default)]
    remove_avatar: bool,
    disappearing_seconds: Option<i32>,
    admins_only_send: Option<bool>,
    admins_only_edit: Option<bool>,
}

async fn update_chat(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>, Json(req): Json<UpdateChat>) -> AppResult<Json<ChatOut>> {
    let role = models::member_role(&st.db, id, auth.user_id).await?;
    let (kind, admins_only_edit): (String, bool) = sqlx::query_as("SELECT kind, admins_only_edit FROM chats WHERE id = $1")
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    let admin = models::is_admin(&role);
    let edits_info = req.name.is_some() || req.description.is_some() || req.avatar_id.is_some() || req.remove_avatar;
    if kind == "direct" && (edits_info || req.admins_only_send.is_some() || req.admins_only_edit.is_some()) {
        return Err(AppError::bad_request("Only disappearing messages can be changed in a direct chat"));
    }
    if kind == "group" {
        if (req.admins_only_send.is_some() || req.admins_only_edit.is_some()) && !admin {
            return Err(AppError::forbidden("Only admins can change group settings"));
        }
        if (edits_info || req.disappearing_seconds.is_some()) && admins_only_edit && !admin {
            return Err(AppError::forbidden("Only admins can edit this group's info"));
        }
    }
    if let Some(d) = req.disappearing_seconds {
        if ![0, 86_400, 604_800, 7_776_000].contains(&d) {
            return Err(AppError::bad_request("Disappearing timer must be off, 24h, 7d or 90d"));
        }
    }
    if let Some(n) = &req.name {
        if n.trim().is_empty() || n.chars().count() > 100 {
            return Err(AppError::bad_request("Group name must be 1–100 characters"));
        }
    }
    sqlx::query(
        "UPDATE chats SET
            name = COALESCE($2, name),
            description = COALESCE($3, description),
            avatar_id = CASE WHEN $5 THEN NULL ELSE COALESCE($4, avatar_id) END,
            disappearing_seconds = COALESCE($6, disappearing_seconds),
            admins_only_send = COALESCE($7, admins_only_send),
            admins_only_edit = COALESCE($8, admins_only_edit)
         WHERE id = $1",
    )
    .bind(id)
    .bind(req.name.as_ref().map(|n| n.trim().to_string()))
    .bind(&req.description)
    .bind(req.avatar_id)
    .bind(req.remove_avatar)
    .bind(req.disappearing_seconds)
    .bind(req.admins_only_send)
    .bind(req.admins_only_edit)
    .execute(&st.db)
    .await?;
    if let Some(n) = &req.name {
        messages::system_message(&st, id, auth.user_id, json!({ "action": "renamed", "name": n.trim() })).await?;
    }
    if req.description.is_some() {
        messages::system_message(&st, id, auth.user_id, json!({ "action": "description" })).await?;
    }
    if req.avatar_id.is_some() || req.remove_avatar {
        messages::system_message(&st, id, auth.user_id, json!({ "action": "icon" })).await?;
    }
    if let Some(d) = req.disappearing_seconds {
        messages::system_message(&st, id, auth.user_id, json!({ "action": "disappearing", "seconds": d })).await?;
    }
    if let Some(v) = req.admins_only_send {
        messages::system_message(&st, id, auth.user_id, json!({ "action": "admins_only_send", "value": v })).await?;
    }
    emit_chat_updated(&st, id).await?;
    Ok(Json(models::load_chat(&st, auth.user_id, id).await?))
}

#[derive(Deserialize)]
struct MySettings {
    /// 0 = unmute, -1 = always, otherwise seconds from now
    mute_seconds: Option<i64>,
    archived: Option<bool>,
    pinned: Option<bool>,
}

async fn my_settings(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>, Json(req): Json<MySettings>) -> AppResult<Json<ChatOut>> {
    models::member_role(&st.db, id, auth.user_id).await?;
    if req.pinned == Some(true) {
        let (pinned,): (i64,) = sqlx::query_as("SELECT count(*) FROM chat_members WHERE user_id = $1 AND pinned AND chat_id <> $2")
            .bind(auth.user_id)
            .bind(id)
            .fetch_one(&st.db)
            .await?;
        if pinned >= 3 {
            return Err(AppError::bad_request("You can only pin up to 3 chats"));
        }
    }
    if let Some(m) = req.mute_seconds {
        let q = match m {
            0 => "UPDATE chat_members SET muted_until = NULL WHERE chat_id = $1 AND user_id = $2",
            -1 => "UPDATE chat_members SET muted_until = 'infinity' WHERE chat_id = $1 AND user_id = $2",
            _ => "UPDATE chat_members SET muted_until = now() + make_interval(secs => $3) WHERE chat_id = $1 AND user_id = $2",
        };
        sqlx::query(q).bind(id).bind(auth.user_id).bind(m as f64).execute(&st.db).await?;
    }
    sqlx::query(
        "UPDATE chat_members SET archived = COALESCE($3, archived), pinned = COALESCE($4, pinned) WHERE chat_id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(auth.user_id)
    .bind(req.archived)
    .bind(req.pinned)
    .execute(&st.db)
    .await?;
    st.hub.send_to_user(auth.user_id, &json!({ "type": "chat.updated", "chat_id": id })).await;
    Ok(Json(models::load_chat(&st, auth.user_id, id).await?))
}

async fn clear(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    models::member_role(&st.db, id, auth.user_id).await?;
    sqlx::query("UPDATE chat_members SET cleared_at = now(), last_read_at = now() WHERE chat_id = $1 AND user_id = $2")
        .bind(id)
        .bind(auth.user_id)
        .execute(&st.db)
        .await?;
    st.hub.send_to_user(auth.user_id, &json!({ "type": "chat.cleared", "chat_id": id })).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Direct chat: clears it from your list (it comes back on a new message).
/// Group: you must leave first; then it's gone.
async fn delete_chat(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    let (kind,): (String,) = sqlx::query_as("SELECT kind FROM chats WHERE id = $1").bind(id).fetch_one(&st.db).await?;
    if kind == "group" {
        leave_group(&st, auth.user_id, id).await?;
    } else {
        clear(State(st.clone()), auth, Path(id)).await?;
        sqlx::query("UPDATE chat_members SET pinned = false, archived = false WHERE chat_id = $1 AND user_id = $2")
            .bind(id)
            .bind(auth.user_id)
            .execute(&st.db)
            .await?;
    }
    st.hub.send_to_user(auth.user_id, &json!({ "type": "chat.removed", "chat_id": id })).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn leave_group(st: &AppState, user: Uuid, chat_id: Uuid) -> AppResult<()> {
    let role = models::member_role(&st.db, chat_id, user).await?;
    messages::system_message(st, chat_id, user, json!({ "action": "left" })).await?;
    sqlx::query("DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2")
        .bind(chat_id)
        .bind(user)
        .execute(&st.db)
        .await?;
    let remaining: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT user_id, role FROM chat_members WHERE chat_id = $1 ORDER BY (role = 'admin') DESC, joined_at")
            .bind(chat_id)
            .fetch_all(&st.db)
            .await?;
    if remaining.is_empty() {
        sqlx::query("DELETE FROM chats WHERE id = $1").bind(chat_id).execute(&st.db).await?;
        return Ok(());
    }
    if role == "owner" {
        sqlx::query("UPDATE chat_members SET role = 'owner' WHERE chat_id = $1 AND user_id = $2")
            .bind(chat_id)
            .bind(remaining[0].0)
            .execute(&st.db)
            .await?;
    }
    emit_chat_updated(st, chat_id).await
}

async fn leave(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    let (kind,): (String,) = sqlx::query_as("SELECT kind FROM chats WHERE id = $1").bind(id).fetch_one(&st.db).await?;
    if kind != "group" {
        return Err(AppError::bad_request("You can only leave groups"));
    }
    leave_group(&st, auth.user_id, id).await?;
    st.hub.send_to_user(auth.user_id, &json!({ "type": "chat.removed", "chat_id": id })).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn require_group_admin(st: &AppState, chat_id: Uuid, user: Uuid) -> AppResult<String> {
    let role = models::member_role(&st.db, chat_id, user).await?;
    let (kind,): (String,) = sqlx::query_as("SELECT kind FROM chats WHERE id = $1").bind(chat_id).fetch_one(&st.db).await?;
    if kind != "group" {
        return Err(AppError::bad_request("Not a group"));
    }
    if !models::is_admin(&role) {
        return Err(AppError::forbidden("Only group admins can do that"));
    }
    Ok(role)
}

async fn reset_invite(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    require_group_admin(&st, id, auth.user_id).await?;
    let code = new_invite_code();
    sqlx::query("UPDATE chats SET invite_code = $2 WHERE id = $1").bind(id).bind(&code).execute(&st.db).await?;
    Ok(Json(json!({ "invite_code": code })))
}

#[derive(Deserialize)]
struct AddMembers {
    user_ids: Vec<Uuid>,
}

async fn add_members(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>, Json(req): Json<AddMembers>) -> AppResult<Json<Value>> {
    require_group_admin(&st, id, auth.user_id).await?;
    let (added, skipped) = add_users(&st, id, auth.user_id, &req.user_ids).await?;
    if !added.is_empty() {
        messages::system_message(&st, id, auth.user_id, json!({ "action": "added", "targets": added })).await?;
        emit_chat_updated(&st, id).await?;
    }
    Ok(Json(json!({ "added": added, "skipped": skipped })))
}

async fn remove_member(State(st): State<AppState>, auth: AuthUser, Path((id, uid)): Path<(Uuid, Uuid)>) -> AppResult<StatusCode> {
    require_group_admin(&st, id, auth.user_id).await?;
    let target_role = models::member_role(&st.db, id, uid).await?;
    if target_role == "owner" {
        return Err(AppError::forbidden("The group creator can't be removed"));
    }
    messages::system_message(&st, id, auth.user_id, json!({ "action": "removed", "targets": [uid] })).await?;
    sqlx::query("DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2").bind(id).bind(uid).execute(&st.db).await?;
    st.hub.send_to_user(uid, &json!({ "type": "chat.removed", "chat_id": id })).await;
    emit_chat_updated(&st, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RoleReq {
    role: String,
}

async fn set_role(State(st): State<AppState>, auth: AuthUser, Path((id, uid)): Path<(Uuid, Uuid)>, Json(req): Json<RoleReq>) -> AppResult<StatusCode> {
    require_group_admin(&st, id, auth.user_id).await?;
    if !matches!(req.role.as_str(), "admin" | "member") {
        return Err(AppError::bad_request("Role must be admin or member"));
    }
    let target_role = models::member_role(&st.db, id, uid).await?;
    if target_role == "owner" {
        return Err(AppError::forbidden("The group creator is always an admin"));
    }
    sqlx::query("UPDATE chat_members SET role = $3 WHERE chat_id = $1 AND user_id = $2")
        .bind(id)
        .bind(uid)
        .bind(&req.role)
        .execute(&st.db)
        .await?;
    let action = if req.role == "admin" { "promoted" } else { "demoted" };
    messages::system_message(&st, id, auth.user_id, json!({ "action": action, "targets": [uid] })).await?;
    emit_chat_updated(&st, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn invite_preview(State(st): State<AppState>, _auth: AuthUser, Path(code): Path<String>) -> AppResult<Json<Value>> {
    let (id, name, description, avatar_id): (Uuid, String, String, Option<Uuid>) =
        sqlx::query_as("SELECT id, name, description, avatar_id FROM chats WHERE invite_code = $1 AND kind = 'group'")
            .bind(&code)
            .fetch_optional(&st.db)
            .await?
            .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "invalid_invite", "This invite link was reset or is invalid"))?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM chat_members WHERE chat_id = $1").bind(id).fetch_one(&st.db).await?;
    Ok(Json(json!({ "id": id, "name": name, "description": description, "avatar_id": avatar_id, "member_count": count })))
}

async fn join(State(st): State<AppState>, auth: AuthUser, Path(code): Path<String>) -> AppResult<Json<ChatOut>> {
    let (id,): (Uuid,) = sqlx::query_as("SELECT id FROM chats WHERE invite_code = $1 AND kind = 'group'")
        .bind(&code)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "invalid_invite", "This invite link was reset or is invalid"))?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM chat_members WHERE chat_id = $1").bind(id).fetch_one(&st.db).await?;
    if count >= MAX_GROUP {
        return Err(AppError::bad_request("This group is full"));
    }
    let res = sqlx::query("INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(auth.user_id)
        .execute(&st.db)
        .await?;
    if res.rows_affected() > 0 {
        messages::system_message(&st, id, auth.user_id, json!({ "action": "joined_link" })).await?;
        emit_chat_updated(&st, id).await?;
    }
    Ok(Json(models::load_chat(&st, auth.user_id, id).await?))
}

// ---------- broadcast lists ----------

async fn list_broadcasts(State(st): State<AppState>, auth: AuthUser) -> AppResult<Json<Value>> {
    let lists: Vec<(Uuid, String)> = sqlx::query_as("SELECT id, name FROM broadcast_lists WHERE owner_id = $1 ORDER BY created_at DESC")
        .bind(auth.user_id)
        .fetch_all(&st.db)
        .await?;
    let mut out = vec![];
    for (id, name) in lists {
        let members: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM broadcast_members WHERE list_id = $1")
            .bind(id)
            .fetch_all(&st.db)
            .await?;
        out.push(json!({ "id": id, "name": name, "member_ids": members.into_iter().map(|m| m.0).collect::<Vec<_>>() }));
    }
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct BroadcastReq {
    name: String,
    member_ids: Vec<Uuid>,
}

async fn create_broadcast(State(st): State<AppState>, auth: AuthUser, Json(req): Json<BroadcastReq>) -> AppResult<Json<Value>> {
    if req.member_ids.len() < 2 || req.member_ids.len() > 256 {
        return Err(AppError::bad_request("A broadcast list needs 2–256 recipients"));
    }
    let id = Uuid::new_v4();
    let name = if req.name.trim().is_empty() { format!("{} recipients", req.member_ids.len()) } else { req.name.trim().to_string() };
    sqlx::query("INSERT INTO broadcast_lists (id, owner_id, name) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(auth.user_id)
        .bind(&name)
        .execute(&st.db)
        .await?;
    for m in &req.member_ids {
        sqlx::query("INSERT INTO broadcast_members (list_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(id)
            .bind(m)
            .execute(&st.db)
            .await?;
    }
    Ok(Json(json!({ "id": id, "name": name, "member_ids": req.member_ids })))
}

async fn delete_broadcast(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM broadcast_lists WHERE id = $1 AND owner_id = $2").bind(id).bind(auth.user_id).execute(&st.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Sends the message to each recipient as a normal direct message.
/// Like WhatsApp, only people who saved your number as a contact receive it.
async fn send_broadcast(State(st): State<AppState>, auth: AuthUser, Path(id): Path<Uuid>, Json(msg): Json<NewMessage>) -> AppResult<Json<Vec<MessageOut>>> {
    let members: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT bm.user_id FROM broadcast_members bm JOIN broadcast_lists bl ON bl.id = bm.list_id
         WHERE bm.list_id = $1 AND bl.owner_id = $2
           AND EXISTS (SELECT 1 FROM contacts c WHERE c.owner_id = bm.user_id AND c.contact_id = $2)",
    )
    .bind(id)
    .bind(auth.user_id)
    .fetch_all(&st.db)
    .await?;
    let mut out = vec![];
    for (u,) in members {
        let chat_id = direct_chat(&st, auth.user_id, u).await?;
        let mut m = msg.clone();
        m.reply_to = None;
        if let Ok(sent) = messages::create_message(&st, auth.user_id, chat_id, m, false).await {
            out.push(sent);
        }
    }
    Ok(Json(out))
}
