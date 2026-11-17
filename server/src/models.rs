use crate::{
    error::{AppError, AppResult},
    AppState,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

// ---------- users ----------

#[derive(Serialize, FromRow, Clone)]
pub struct Me {
    pub id: Uuid,
    pub phone: String,
    pub name: String,
    pub about: String,
    pub avatar_id: Option<Uuid>,
    pub privacy_last_seen: String,
    pub privacy_photo: String,
    pub privacy_about: String,
    pub privacy_groups: String,
    pub privacy_messages: String,
    pub read_receipts: bool,
    #[sqlx(skip)]
    pub has_pin: bool,
    pub created_at: DateTime<Utc>,
}

pub async fn load_me(db: &PgPool, id: Uuid) -> AppResult<Me> {
    let mut me: Me = sqlx::query_as(
        "SELECT id, phone, name, about, avatar_id, privacy_last_seen, privacy_photo, privacy_about, privacy_groups, privacy_messages, read_receipts, created_at FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_one(db)
    .await?;
    let (has_pin,): (bool,) = sqlx::query_as("SELECT pin_hash IS NOT NULL FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(db)
        .await?;
    me.has_pin = has_pin;
    Ok(me)
}

#[derive(Serialize, Clone)]
pub struct UserPublic {
    pub id: Uuid,
    pub phone: String,
    pub name: String,
    pub about: Option<String>,
    pub avatar_id: Option<Uuid>,
    pub last_seen: Option<DateTime<Utc>>,
    pub online: bool,
    pub contact_name: Option<String>,
    pub blocked_by_me: bool,
}

#[derive(FromRow)]
struct UserRow {
    id: Uuid,
    phone: String,
    name: String,
    about: String,
    avatar_id: Option<Uuid>,
    last_seen: DateTime<Utc>,
    privacy_last_seen: String,
    privacy_photo: String,
    privacy_about: String,
    read_receipts: bool,
}

fn visible(setting: &str, owner_has_viewer_as_contact: bool) -> bool {
    match setting {
        "everyone" => true,
        "contacts" => owner_has_viewer_as_contact,
        _ => false,
    }
}

pub async fn public_users(st: &AppState, viewer: Uuid, ids: &[Uuid]) -> AppResult<HashMap<Uuid, UserPublic>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ids: Vec<Uuid> = ids.iter().copied().collect::<HashSet<_>>().into_iter().collect();
    let rows: Vec<UserRow> = sqlx::query_as(
        "SELECT id, phone, name, about, avatar_id, last_seen, privacy_last_seen, privacy_photo, privacy_about, read_receipts FROM users WHERE id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(&st.db)
    .await?;
    // Contacts the viewer saved (for display names)
    let my_contacts: HashMap<Uuid, String> =
        sqlx::query_as::<_, (Uuid, String)>("SELECT contact_id, name FROM contacts WHERE owner_id = $1 AND contact_id = ANY($2)")
            .bind(viewer)
            .bind(&ids)
            .fetch_all(&st.db)
            .await?
            .into_iter()
            .collect();
    // Owners who have the viewer as a contact (for "my contacts" privacy)
    let has_me: HashSet<Uuid> =
        sqlx::query_as::<_, (Uuid,)>("SELECT owner_id FROM contacts WHERE contact_id = $1 AND owner_id = ANY($2)")
            .bind(viewer)
            .bind(&ids)
            .fetch_all(&st.db)
            .await?
            .into_iter()
            .map(|r| r.0)
            .collect();
    let blocks: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT blocker_id, blocked_id FROM blocks WHERE (blocker_id = $1 AND blocked_id = ANY($2)) OR (blocked_id = $1 AND blocker_id = ANY($2))",
    )
    .bind(viewer)
    .bind(&ids)
    .fetch_all(&st.db)
    .await?;
    let blocked_by_me: HashSet<Uuid> = blocks.iter().filter(|b| b.0 == viewer).map(|b| b.1).collect();
    let blocked_me: HashSet<Uuid> = blocks.iter().filter(|b| b.1 == viewer).map(|b| b.0).collect();

    let mut out = HashMap::new();
    for r in rows {
        let is_self = r.id == viewer;
        let contact = has_me.contains(&r.id);
        let hidden_by_block = blocked_me.contains(&r.id);
        // WhatsApp rule: if you hide your own last seen you can't see other people's either.
        let ls_ok = is_self || (!hidden_by_block && visible(&r.privacy_last_seen, contact));
        let photo_ok = is_self || (!hidden_by_block && visible(&r.privacy_photo, contact));
        let about_ok = is_self || (!hidden_by_block && visible(&r.privacy_about, contact));
        let _ = r.read_receipts;
        out.insert(
            r.id,
            UserPublic {
                id: r.id,
                phone: r.phone,
                name: r.name,
                about: about_ok.then_some(r.about),
                avatar_id: if photo_ok { r.avatar_id } else { None },
                last_seen: ls_ok.then_some(r.last_seen),
                online: ls_ok && st.hub.is_online(r.id).await,
                contact_name: my_contacts.get(&r.id).cloned(),
                blocked_by_me: blocked_by_me.contains(&r.id),
            },
        );
    }
    Ok(out)
}

// ---------- messages ----------

#[derive(FromRow, Clone)]
pub struct MessageRow {
    pub id: Uuid,
    pub chat_id: Uuid,
    pub sender_id: Option<Uuid>,
    pub kind: String,
    pub body: String,
    pub media_id: Option<Uuid>,
    pub reply_to: Option<Uuid>,
    pub forwarded: bool,
    pub meta: Value,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

pub const MESSAGE_COLS: &str =
    "id, chat_id, sender_id, kind, body, media_id, reply_to, forwarded, meta, edited_at, deleted, expires_at, created_at";

#[derive(Serialize, FromRow, Clone)]
pub struct MediaOut {
    pub id: Uuid,
    pub mime: String,
    pub size: i64,
    pub filename: String,
}

#[derive(Serialize, Clone)]
pub struct ReplyPreview {
    pub id: Uuid,
    pub sender_id: Option<Uuid>,
    pub kind: String,
    pub body: String,
    pub deleted: bool,
}

#[derive(Serialize, Clone)]
pub struct Reaction {
    pub user_id: Uuid,
    pub emoji: String,
}

#[derive(Serialize, Clone)]
pub struct Vote {
    pub user_id: Uuid,
    pub option_idx: i32,
}

#[derive(Serialize, Clone)]
pub struct MessageOut {
    pub id: Uuid,
    pub chat_id: Uuid,
    pub sender_id: Option<Uuid>,
    pub kind: String,
    pub body: String,
    pub media: Option<MediaOut>,
    pub reply_to: Option<ReplyPreview>,
    pub forwarded: bool,
    pub meta: Value,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub reactions: Vec<Reaction>,
    pub votes: Vec<Vote>,
    pub status: String,
    pub played: bool,
    pub starred: bool,
}

/// Fetch full message objects for the given ids, keeping the input order.
pub async fn load_messages(db: &PgPool, viewer: Uuid, ids: &[Uuid]) -> AppResult<Vec<MessageOut>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let rows: Vec<MessageRow> = sqlx::query_as(&format!("SELECT {MESSAGE_COLS} FROM messages WHERE id = ANY($1)"))
        .bind(ids)
        .fetch_all(db)
        .await?;
    build_messages(db, viewer, rows, ids).await
}

pub async fn build_messages(db: &PgPool, viewer: Uuid, rows: Vec<MessageRow>, order: &[Uuid]) -> AppResult<Vec<MessageOut>> {
    let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    let media_ids: Vec<Uuid> = rows.iter().filter_map(|r| r.media_id).collect();
    let reply_ids: Vec<Uuid> = rows.iter().filter_map(|r| r.reply_to).collect();

    let media: HashMap<Uuid, MediaOut> = sqlx::query_as::<_, MediaOut>("SELECT id, mime, size, filename FROM media WHERE id = ANY($1)")
        .bind(&media_ids)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|m| (m.id, m))
        .collect();

    let replies: HashMap<Uuid, ReplyPreview> =
        sqlx::query_as::<_, (Uuid, Option<Uuid>, String, String, bool)>(
            "SELECT id, sender_id, kind, left(body, 200), deleted FROM messages WHERE id = ANY($1)",
        )
        .bind(&reply_ids)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|(id, sender_id, kind, body, deleted)| {
            (id, ReplyPreview { id, sender_id, kind, body: if deleted { String::new() } else { body }, deleted })
        })
        .collect();

    let mut reactions: HashMap<Uuid, Vec<Reaction>> = HashMap::new();
    for (mid, user_id, emoji) in sqlx::query_as::<_, (Uuid, Uuid, String)>(
        "SELECT message_id, user_id, emoji FROM reactions WHERE message_id = ANY($1) ORDER BY created_at",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?
    {
        reactions.entry(mid).or_default().push(Reaction { user_id, emoji });
    }

    let mut votes: HashMap<Uuid, Vec<Vote>> = HashMap::new();
    for (mid, user_id, option_idx) in sqlx::query_as::<_, (Uuid, Uuid, i32)>(
        "SELECT message_id, user_id, option_idx FROM poll_votes WHERE message_id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?
    {
        votes.entry(mid).or_default().push(Vote { user_id, option_idx });
    }

    let receipts: HashMap<Uuid, (i64, i64, i64, i64)> = sqlx::query_as::<_, (Uuid, i64, i64, i64, i64)>(
        "SELECT message_id, count(*), count(delivered_at), count(read_at), count(played_at) FROM receipts WHERE message_id = ANY($1) GROUP BY message_id",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|(id, a, b, c, d)| (id, (a, b, c, d)))
    .collect();

    let starred: HashSet<Uuid> = sqlx::query_as::<_, (Uuid,)>("SELECT message_id FROM stars WHERE user_id = $1 AND message_id = ANY($2)")
        .bind(viewer)
        .bind(&ids)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|r| r.0)
        .collect();

    let mut by_id: HashMap<Uuid, MessageOut> = HashMap::new();
    for r in rows {
        let (total, delivered, read, played) = receipts.get(&r.id).copied().unwrap_or((0, 0, 0, 0));
        let status = if total > 0 && read == total {
            "read"
        } else if total > 0 && delivered == total {
            "delivered"
        } else {
            "sent"
        };
        let deleted = r.deleted;
        by_id.insert(
            r.id,
            MessageOut {
                id: r.id,
                chat_id: r.chat_id,
                sender_id: r.sender_id,
                kind: r.kind,
                body: if deleted { String::new() } else { r.body },
                media: if deleted { None } else { r.media_id.and_then(|m| media.get(&m).cloned()) },
                reply_to: if deleted { None } else { r.reply_to.and_then(|id| replies.get(&id).cloned()) },
                forwarded: r.forwarded,
                meta: if deleted { Value::Object(Default::default()) } else { r.meta },
                edited_at: r.edited_at,
                deleted,
                expires_at: r.expires_at,
                created_at: r.created_at,
                reactions: if deleted { vec![] } else { reactions.remove(&r.id).unwrap_or_default() },
                votes: votes.remove(&r.id).unwrap_or_default(),
                status: status.into(),
                played: total > 0 && played == total,
                starred: starred.contains(&r.id),
            },
        );
    }
    Ok(order.iter().filter_map(|id| by_id.remove(id)).collect())
}

// ---------- chats ----------

#[derive(FromRow)]
struct ChatRow {
    id: Uuid,
    kind: String,
    name: String,
    description: String,
    avatar_id: Option<Uuid>,
    created_by: Option<Uuid>,
    created_at: DateTime<Utc>,
    disappearing_seconds: i32,
    invite_code: Option<String>,
    admins_only_send: bool,
    admins_only_edit: bool,
    role: String,
    muted_until: Option<DateTime<Utc>>,
    archived: bool,
    pinned: bool,
    last_read_at: DateTime<Utc>,
}

#[derive(Serialize, Clone)]
pub struct MemberOut {
    pub user: UserPublic,
    pub role: String,
}

#[derive(Serialize, Clone)]
pub struct ChatOut {
    pub id: Uuid,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub avatar_id: Option<Uuid>,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub disappearing_seconds: i32,
    pub invite_code: Option<String>,
    pub admins_only_send: bool,
    pub admins_only_edit: bool,
    pub members: Vec<MemberOut>,
    pub my_role: String,
    pub muted_until: Option<DateTime<Utc>>,
    pub archived: bool,
    pub pinned: bool,
    pub last_read_at: DateTime<Utc>,
    pub unread: i64,
    pub last_message: Option<MessageOut>,
}

pub async fn load_chats(st: &AppState, viewer: Uuid, only: Option<&[Uuid]>) -> AppResult<Vec<ChatOut>> {
    let only_vec: Option<Vec<Uuid>> = only.map(|s| s.to_vec());
    let rows: Vec<ChatRow> = sqlx::query_as(
        "SELECT c.id, c.kind, c.name, c.description, c.avatar_id, c.created_by, c.created_at, c.disappearing_seconds,
                c.invite_code, c.admins_only_send, c.admins_only_edit,
                m.role, m.muted_until, m.archived, m.pinned, m.last_read_at
         FROM chats c JOIN chat_members m ON m.chat_id = c.id AND m.user_id = $1
         WHERE ($2::uuid[] IS NULL OR c.id = ANY($2))",
    )
    .bind(viewer)
    .bind(&only_vec)
    .fetch_all(&st.db)
    .await?;
    let chat_ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    if chat_ids.is_empty() {
        return Ok(vec![]);
    }

    let members: Vec<(Uuid, Uuid, String)> =
        sqlx::query_as("SELECT chat_id, user_id, role FROM chat_members WHERE chat_id = ANY($1) ORDER BY joined_at")
            .bind(&chat_ids)
            .fetch_all(&st.db)
            .await?;
    let user_ids: Vec<Uuid> = members.iter().map(|m| m.1).collect();
    let users = public_users(st, viewer, &user_ids).await?;
    let mut members_by_chat: HashMap<Uuid, Vec<MemberOut>> = HashMap::new();
    for (cid, uid, role) in members {
        if let Some(u) = users.get(&uid) {
            members_by_chat.entry(cid).or_default().push(MemberOut { user: u.clone(), role });
        }
    }

    let last_ids: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT DISTINCT ON (msg.chat_id) msg.chat_id, msg.id FROM messages msg
         JOIN chat_members cm ON cm.chat_id = msg.chat_id AND cm.user_id = $1
         WHERE msg.chat_id = ANY($2) AND (cm.cleared_at IS NULL OR msg.created_at > cm.cleared_at)
           AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.user_id = $1 AND h.message_id = msg.id)
         ORDER BY msg.chat_id, msg.created_at DESC",
    )
    .bind(viewer)
    .bind(&chat_ids)
    .fetch_all(&st.db)
    .await?;
    let ids: Vec<Uuid> = last_ids.iter().map(|r| r.1).collect();
    let mut last_msgs: HashMap<Uuid, MessageOut> =
        load_messages(&st.db, viewer, &ids).await?.into_iter().map(|m| (m.chat_id, m)).collect();

    let unread: HashMap<Uuid, i64> = sqlx::query_as::<_, (Uuid, i64)>(
        "SELECT msg.chat_id, count(*) FROM messages msg
         JOIN chat_members cm ON cm.chat_id = msg.chat_id AND cm.user_id = $1
         WHERE msg.chat_id = ANY($2) AND msg.created_at > cm.last_read_at
           AND msg.sender_id IS DISTINCT FROM $1 AND msg.kind <> 'system' AND NOT msg.deleted
           AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.user_id = $1 AND h.message_id = msg.id)
         GROUP BY msg.chat_id",
    )
    .bind(viewer)
    .bind(&chat_ids)
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .collect();

    let mut out: Vec<ChatOut> = rows
        .into_iter()
        .map(|r| {
            let is_admin = r.role == "admin" || r.role == "owner";
            ChatOut {
                id: r.id,
                members: members_by_chat.remove(&r.id).unwrap_or_default(),
                last_message: last_msgs.remove(&r.id),
                unread: unread.get(&r.id).copied().unwrap_or(0),
                kind: r.kind,
                name: r.name,
                description: r.description,
                avatar_id: r.avatar_id,
                created_by: r.created_by,
                created_at: r.created_at,
                disappearing_seconds: r.disappearing_seconds,
                invite_code: if is_admin { r.invite_code } else { None },
                admins_only_send: r.admins_only_send,
                admins_only_edit: r.admins_only_edit,
                my_role: r.role,
                muted_until: r.muted_until,
                archived: r.archived,
                pinned: r.pinned,
                last_read_at: r.last_read_at,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        let ta = a.last_message.as_ref().map(|m| m.created_at).unwrap_or(a.created_at);
        let tb = b.last_message.as_ref().map(|m| m.created_at).unwrap_or(b.created_at);
        b.pinned.cmp(&a.pinned).then(tb.cmp(&ta))
    });
    Ok(out)
}

pub async fn load_chat(st: &AppState, viewer: Uuid, chat_id: Uuid) -> AppResult<ChatOut> {
    load_chats(st, viewer, Some(&[chat_id])).await?.into_iter().next().ok_or_else(AppError::not_found)
}

/// Returns the viewer's role in the chat, or 403 if they're not a member.
pub async fn member_role(db: &PgPool, chat_id: Uuid, user_id: Uuid) -> AppResult<String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2")
        .bind(chat_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?;
    row.map(|r| r.0).ok_or_else(|| AppError::forbidden("You're not a member of this chat"))
}

pub async fn chat_member_ids(db: &PgPool, chat_id: Uuid) -> AppResult<Vec<Uuid>> {
    Ok(sqlx::query_as::<_, (Uuid,)>("SELECT user_id FROM chat_members WHERE chat_id = $1")
        .bind(chat_id)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|r| r.0)
        .collect())
}

pub fn is_admin(role: &str) -> bool {
    role == "admin" || role == "owner"
}

/// Whether `sender` may message or call `recipient` under the recipient's "who can message me" setting.
pub async fn may_contact(db: &PgPool, sender: Uuid, recipient: Uuid) -> AppResult<bool> {
    let (allowed,): (bool,) = sqlx::query_as(
        "SELECT u.privacy_messages = 'everyone'
             OR EXISTS (SELECT 1 FROM contacts c WHERE c.owner_id = u.id AND c.contact_id = $1)
         FROM users u WHERE u.id = $2",
    )
    .bind(sender)
    .bind(recipient)
    .fetch_one(db)
    .await?;
    Ok(allowed)
}
