use crate::{auth, calls, error::AppResult, models, AppState};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::Response,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::sync::{mpsc, Mutex, RwLock};
use uuid::Uuid;

struct Conn {
    id: Uuid,
    session_id: Uuid,
    tx: mpsc::UnboundedSender<Message>,
}

#[derive(Default)]
pub struct Hub {
    conns: RwLock<HashMap<Uuid, Vec<Conn>>>,
    pub calls: Mutex<HashMap<Uuid, calls::ActiveCall>>,
}

impl Hub {
    async fn add(&self, user: Uuid, conn: Conn) -> bool {
        let mut map = self.conns.write().await;
        let list = map.entry(user).or_default();
        let was_offline = list.is_empty();
        list.push(conn);
        was_offline
    }

    async fn remove(&self, user: Uuid, conn_id: Uuid) -> bool {
        let mut map = self.conns.write().await;
        if let Some(list) = map.get_mut(&user) {
            list.retain(|c| c.id != conn_id);
            if list.is_empty() {
                map.remove(&user);
                return true;
            }
        }
        false
    }

    pub async fn is_online(&self, user: Uuid) -> bool {
        self.conns.read().await.get(&user).is_some_and(|l| !l.is_empty())
    }

    pub async fn send_to_user(&self, user: Uuid, event: &Value) {
        let text = event.to_string();
        if let Some(list) = self.conns.read().await.get(&user) {
            for c in list {
                let _ = c.tx.send(Message::Text(text.clone().into()));
            }
        }
    }

    pub async fn send_to_users(&self, users: &[Uuid], event: &Value) {
        let text = event.to_string();
        let map = self.conns.read().await;
        for u in users {
            if let Some(list) = map.get(u) {
                for c in list {
                    let _ = c.tx.send(Message::Text(text.clone().into()));
                }
            }
        }
    }

    pub async fn disconnect_session(&self, session_id: Uuid) {
        let map = self.conns.read().await;
        for list in map.values() {
            for c in list.iter().filter(|c| c.session_id == session_id) {
                let _ = c.tx.send(Message::Close(None));
            }
        }
    }
}

/// Send an event to every member of a chat.
pub async fn emit_chat(st: &AppState, chat_id: Uuid, event: &Value) -> AppResult<()> {
    let members = models::chat_member_ids(&st.db, chat_id).await?;
    st.hub.send_to_users(&members, event).await;
    Ok(())
}

/// Push updated tick status for these messages to their senders.
pub async fn notify_status(st: &AppState, message_ids: &[Uuid]) -> AppResult<()> {
    if message_ids.is_empty() {
        return Ok(());
    }
    let msgs = models::load_messages(&st.db, Uuid::nil(), message_ids).await?;
    for m in msgs {
        if let Some(sender) = m.sender_id {
            st.hub
                .send_to_user(
                    sender,
                    &json!({ "type": "message.status", "chat_id": m.chat_id, "id": m.id, "status": m.status, "played": m.played }),
                )
                .await;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct WsQuery {
    token: String,
}

pub async fn handler(
    State(st): State<AppState>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, crate::error::AppError> {
    let user = auth::authenticate(&st, &q.token).await?;
    Ok(ws.on_upgrade(move |socket| run(st, user, socket)))
}

async fn presence_audience(st: &AppState, user: Uuid) -> AppResult<Vec<Uuid>> {
    let (privacy,): (String,) = sqlx::query_as("SELECT privacy_last_seen FROM users WHERE id = $1")
        .bind(user)
        .fetch_one(&st.db)
        .await?;
    if privacy == "nobody" {
        return Ok(vec![]);
    }
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT DISTINCT cm2.user_id FROM chat_members cm1
         JOIN chat_members cm2 ON cm2.chat_id = cm1.chat_id AND cm2.user_id <> $1
         JOIN chats c ON c.id = cm1.chat_id AND c.kind = 'direct'
         WHERE cm1.user_id = $1
           AND ($2 = 'everyone' OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.owner_id = $1 AND ct.contact_id = cm2.user_id))
           AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = cm2.user_id)",
    )
    .bind(user)
    .bind(&privacy)
    .fetch_all(&st.db)
    .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

async fn run(st: AppState, auth: auth::AuthUser, socket: WebSocket) {
    let user = auth.user_id;
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let conn_id = Uuid::new_v4();

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let close = matches!(msg, Message::Close(_));
            if sink.send(msg).await.is_err() || close {
                break;
            }
        }
    });

    let was_offline = st.hub.add(user, Conn { id: conn_id, session_id: auth.session_id, tx: tx.clone() }).await;
    let _ = tx.send(Message::Text(json!({ "type": "hello", "user_id": user }).to_string().into()));

    if was_offline {
        if let Ok(aud) = presence_audience(&st, user).await {
            st.hub.send_to_users(&aud, &json!({ "type": "presence", "user_id": user, "online": true })).await;
        }
    }

    // Everything that arrived while we were offline is now delivered.
    if let Ok(rows) = sqlx::query_as::<_, (Uuid,)>(
        "UPDATE receipts SET delivered_at = now() WHERE user_id = $1 AND delivered_at IS NULL RETURNING message_id",
    )
    .bind(user)
    .fetch_all(&st.db)
    .await
    {
        let ids: Vec<Uuid> = rows.into_iter().map(|r| r.0).collect();
        let _ = notify_status(&st, &ids).await;
    }

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                let Ok(ev) = serde_json::from_str::<Value>(&text) else { continue };
                if let Err(e) = handle_client_event(&st, user, &ev, &tx).await {
                    let _ = tx.send(Message::Text(
                        json!({ "type": "error", "message": e.message, "ref": ev.get("ref") }).to_string().into(),
                    ));
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    let now_offline = st.hub.remove(user, conn_id).await;
    if now_offline {
        let _ = sqlx::query("UPDATE users SET last_seen = now() WHERE id = $1").bind(user).execute(&st.db).await;
        if let Ok(aud) = presence_audience(&st, user).await {
            st.hub
                .send_to_users(
                    &aud,
                    &json!({ "type": "presence", "user_id": user, "online": false, "last_seen": chrono::Utc::now() }),
                )
                .await;
        }
        calls::leave_all(&st, user).await;
    }
    writer.abort();
}

async fn handle_client_event(
    st: &AppState,
    user: Uuid,
    ev: &Value,
    tx: &mpsc::UnboundedSender<Message>,
) -> AppResult<()> {
    let kind = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "ping" => {
            let _ = tx.send(Message::Text(json!({ "type": "pong" }).to_string().into()));
        }
        "typing" => {
            let chat_id: Uuid = ev
                .get("chat_id")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| crate::error::AppError::bad_request("chat_id required"))?;
            models::member_role(&st.db, chat_id, user).await?;
            let state = ev.get("state").and_then(|v| v.as_str()).unwrap_or("typing");
            let others: Vec<Uuid> = models::chat_member_ids(&st.db, chat_id)
                .await?
                .into_iter()
                .filter(|u| *u != user)
                .collect();
            st.hub
                .send_to_users(&others, &json!({ "type": "typing", "chat_id": chat_id, "user_id": user, "state": state }))
                .await;
        }
        k if k.starts_with("call.") => calls::handle_event(st, user, k, ev).await?,
        _ => {}
    }
    Ok(())
}
