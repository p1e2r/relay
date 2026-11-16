//! Voice / video calls. The server only does signalling (WebRTC offers, answers,
//! ICE candidates) and keeps the call log; media flows peer-to-peer, or through
//! TURN if configured. Group calls are a full mesh, so they work best with
//! up to about 8 people.

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    models, ws, AppState,
};
use axum::{extract::State, routing::get, Json, Router};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};
use uuid::Uuid;

pub struct ActiveCall {
    pub chat_id: Uuid,
    pub caller: Uuid,
    pub video: bool,
    pub direct: bool,
    pub answered: bool,
    pub participants: HashSet<Uuid>,
    pub started_at: DateTime<Utc>,
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/calls", get(call_log)).route("/ice", get(ice_servers))
}

/// Time-limited TURN credentials (the coturn "TURN REST API" scheme):
/// username = "<expiry unix time>:<user id>", credential = base64(HMAC-SHA1(secret, username)).
fn turn_rest_credentials(secret: &str, user: Uuid, ttl_secs: i64) -> (String, String) {
    use base64::Engine;
    use hmac::{Hmac, Mac};
    let username = format!("{}:{}", Utc::now().timestamp() + ttl_secs, user);
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(secret.as_bytes()).expect("hmac accepts any key length");
    mac.update(username.as_bytes());
    let credential = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    (username, credential)
}

async fn ice_servers(State(st): State<AppState>, auth: AuthUser) -> Json<Value> {
    let mut servers = vec![];
    if !st.config.stun_urls.is_empty() {
        servers.push(json!({ "urls": st.config.stun_urls }));
    }
    if !st.config.turn_urls.is_empty() && !st.config.turn_secret.is_empty() {
        let (username, credential) = turn_rest_credentials(&st.config.turn_secret, auth.user_id, 24 * 3600);
        servers.push(json!({ "urls": st.config.turn_urls, "username": username, "credential": credential }));
    } else if !st.config.turn_urls.is_empty() {
        servers.push(json!({
            "urls": st.config.turn_urls,
            "username": st.config.turn_username,
            "credential": st.config.turn_credential,
        }));
    }
    Json(json!({ "ice_servers": servers }))
}

async fn call_log(State(st): State<AppState>, auth: AuthUser) -> AppResult<Json<Value>> {
    let rows: Vec<(Uuid, Uuid, Option<Uuid>, bool, String, DateTime<Utc>, Option<DateTime<Utc>>, Option<DateTime<Utc>>)> =
        sqlx::query_as(
            "SELECT c.id, c.chat_id, c.caller_id, c.video, c.status, c.started_at, c.answered_at, c.ended_at
             FROM calls c JOIN chat_members m ON m.chat_id = c.chat_id AND m.user_id = $1
             ORDER BY c.started_at DESC LIMIT 200",
        )
        .bind(auth.user_id)
        .fetch_all(&st.db)
        .await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, chat_id, caller_id, video, status, started_at, answered_at, ended_at)| {
            json!({
                "id": id, "chat_id": chat_id, "caller_id": caller_id, "video": video, "status": status,
                "started_at": started_at, "answered_at": answered_at, "ended_at": ended_at,
            })
        })
        .collect();
    Ok(Json(json!(list)))
}

fn call_json(id: Uuid, c: &ActiveCall) -> Value {
    json!({
        "id": id, "chat_id": c.chat_id, "caller_id": c.caller, "video": c.video,
        "answered": c.answered, "started_at": c.started_at,
        "participants": c.participants.iter().collect::<Vec<_>>(),
    })
}

fn uuid_field(ev: &Value, key: &str) -> AppResult<Uuid> {
    ev.get(key)
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| AppError::bad_request(format!("{key} required")))
}

async fn end_call(st: &AppState, call_id: Uuid, status: &str) {
    let removed = st.hub.calls.lock().await.remove(&call_id);
    let Some(call) = removed else { return };
    let status = if status == "ended" && !call.answered { "missed" } else { status };
    let _ = sqlx::query("UPDATE calls SET status = $2, ended_at = now() WHERE id = $1")
        .bind(call_id)
        .bind(status)
        .execute(&st.db)
        .await;
    let _ = ws::emit_chat(st, call.chat_id, &json!({ "type": "call.ended", "call_id": call_id, "chat_id": call.chat_id, "status": status })).await;
}

pub async fn handle_event(st: &AppState, user: Uuid, kind: &str, ev: &Value) -> AppResult<()> {
    match kind {
        "call.start" => {
            let chat_id = uuid_field(ev, "chat_id")?;
            let video = ev.get("video").and_then(|v| v.as_bool()).unwrap_or(false);
            models::member_role(&st.db, chat_id, user).await?;
            let (chat_kind,): (String,) = sqlx::query_as("SELECT kind FROM chats WHERE id = $1")
                .bind(chat_id)
                .fetch_one(&st.db)
                .await?;
            let members = models::chat_member_ids(&st.db, chat_id).await?;
            if chat_kind == "direct" {
                let other = members.iter().copied().find(|u| *u != user);
                if let Some(other) = other {
                    let blocked: Option<(i32,)> = sqlx::query_as(
                        "SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)",
                    )
                    .bind(user)
                    .bind(other)
                    .fetch_optional(&st.db)
                    .await?;
                    if blocked.is_some() {
                        return Err(AppError::forbidden("Can't call this contact"));
                    }
                }
            }
            {
                let calls = st.hub.calls.lock().await;
                if let Some((id, c)) = calls.iter().find(|(_, c)| c.chat_id == chat_id) {
                    // A call is already running in this chat: tell the user so they can join it.
                    st.hub.send_to_user(user, &json!({ "type": "call.incoming", "call": call_json(*id, c) })).await;
                    return Ok(());
                }
            }
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO calls (id, chat_id, caller_id, video) VALUES ($1, $2, $3, $4)")
                .bind(id)
                .bind(chat_id)
                .bind(user)
                .bind(video)
                .execute(&st.db)
                .await?;
            let call = ActiveCall {
                chat_id,
                caller: user,
                video,
                direct: chat_kind == "direct",
                answered: false,
                participants: HashSet::from([user]),
                started_at: Utc::now(),
            };
            let payload = call_json(id, &call);
            st.hub.calls.lock().await.insert(id, call);
            st.hub.send_to_user(user, &json!({ "type": "call.started", "call": payload })).await;
            let others: Vec<Uuid> = members.into_iter().filter(|u| *u != user).collect();
            st.hub.send_to_users(&others, &json!({ "type": "call.incoming", "call": payload })).await;

            // Ring for 45 seconds, then give up.
            let st2 = st.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(45)).await;
                let unanswered = st2.hub.calls.lock().await.get(&id).is_some_and(|c| !c.answered);
                if unanswered {
                    end_call(&st2, id, "missed").await;
                }
            });
        }
        "call.accept" => {
            let call_id = uuid_field(ev, "call_id")?;
            let (chat_id, peers, first_answer) = {
                let mut calls = st.hub.calls.lock().await;
                let call = calls.get_mut(&call_id).ok_or_else(AppError::not_found)?;
                let peers: Vec<Uuid> = call.participants.iter().copied().filter(|u| *u != user).collect();
                let first = !call.answered;
                call.answered = true;
                call.participants.insert(user);
                (call.chat_id, peers, first)
            };
            models::member_role(&st.db, chat_id, user).await?;
            if first_answer {
                sqlx::query("UPDATE calls SET status = 'ongoing', answered_at = now() WHERE id = $1")
                    .bind(call_id)
                    .execute(&st.db)
                    .await?;
            }
            st.hub.send_to_user(user, &json!({ "type": "call.peers", "call_id": call_id, "peers": peers })).await;
            ws::emit_chat(st, chat_id, &json!({ "type": "call.joined", "call_id": call_id, "user_id": user })).await?;
        }
        "call.reject" => {
            let call_id = uuid_field(ev, "call_id")?;
            let info = st.hub.calls.lock().await.get(&call_id).map(|c| (c.chat_id, c.direct, c.answered));
            if let Some((chat_id, direct, answered)) = info {
                models::member_role(&st.db, chat_id, user).await?;
                ws::emit_chat(st, chat_id, &json!({ "type": "call.rejected", "call_id": call_id, "user_id": user })).await?;
                if direct && !answered {
                    end_call(st, call_id, "rejected").await;
                }
            }
        }
        "call.signal" => {
            let call_id = uuid_field(ev, "call_id")?;
            let to = uuid_field(ev, "to")?;
            let ok = st
                .hub
                .calls
                .lock()
                .await
                .get(&call_id)
                .is_some_and(|c| c.participants.contains(&user) && (c.participants.contains(&to) || c.caller == to));
            if ok {
                st.hub
                    .send_to_user(
                        to,
                        &json!({ "type": "call.signal", "call_id": call_id, "from": user, "data": ev.get("data") }),
                    )
                    .await;
            }
        }
        "call.media" => {
            // Mute / camera-off state, relayed to everyone in the call.
            let call_id = uuid_field(ev, "call_id")?;
            let peers: Vec<Uuid> = st
                .hub
                .calls
                .lock()
                .await
                .get(&call_id)
                .filter(|c| c.participants.contains(&user))
                .map(|c| c.participants.iter().copied().filter(|u| *u != user).collect())
                .unwrap_or_default();
            st.hub
                .send_to_users(
                    &peers,
                    &json!({ "type": "call.media", "call_id": call_id, "user_id": user, "audio": ev.get("audio"), "video": ev.get("video") }),
                )
                .await;
        }
        "call.leave" => {
            let call_id = uuid_field(ev, "call_id")?;
            leave(st, user, call_id).await;
        }
        _ => {}
    }
    Ok(())
}

async fn leave(st: &AppState, user: Uuid, call_id: Uuid) {
    let decision = {
        let mut calls = st.hub.calls.lock().await;
        let Some(call) = calls.get_mut(&call_id) else { return };
        call.participants.remove(&user);
        let end = call.participants.is_empty()
            || (call.answered && call.participants.len() <= 1)
            || (!call.answered && call.caller == user);
        (call.chat_id, end)
    };
    let (chat_id, end) = decision;
    let _ = ws::emit_chat(st, chat_id, &json!({ "type": "call.left", "call_id": call_id, "user_id": user })).await;
    if end {
        end_call(st, call_id, "ended").await;
    }
}

pub async fn leave_all(st: &AppState, user: Uuid) {
    let ids: Vec<Uuid> = st
        .hub
        .calls
        .lock()
        .await
        .iter()
        .filter(|(_, c)| c.participants.contains(&user))
        .map(|(id, _)| *id)
        .collect();
    for id in ids {
        leave(st, user, id).await;
    }
}
