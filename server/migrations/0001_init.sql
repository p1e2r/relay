CREATE TABLE users (
    id UUID PRIMARY KEY,
    phone TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    about TEXT NOT NULL DEFAULT 'Hey there! I am using Relay.',
    avatar_id UUID,
    pin_hash TEXT,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    privacy_last_seen TEXT NOT NULL DEFAULT 'everyone',
    privacy_photo TEXT NOT NULL DEFAULT 'everyone',
    privacy_about TEXT NOT NULL DEFAULT 'everyone',
    privacy_groups TEXT NOT NULL DEFAULT 'everyone',
    read_receipts BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
    phone TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts INT NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE NOT NULL,
    device_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (owner_id, contact_id)
);

CREATE TABLE blocks (
    blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE media (
    id UUID PRIMARY KEY,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    mime TEXT NOT NULL,
    size BIGINT NOT NULL,
    filename TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chats (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL, -- direct | group
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    avatar_id UUID,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    disappearing_seconds INT NOT NULL DEFAULT 0,
    invite_code TEXT UNIQUE,
    admins_only_send BOOLEAN NOT NULL DEFAULT false,
    admins_only_edit BOOLEAN NOT NULL DEFAULT false,
    direct_key TEXT UNIQUE
);

CREATE TABLE chat_members (
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member', -- member | admin | owner
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    muted_until TIMESTAMPTZ,
    archived BOOLEAN NOT NULL DEFAULT false,
    pinned BOOLEAN NOT NULL DEFAULT false,
    cleared_at TIMESTAMPTZ,
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX chat_members_user ON chat_members(user_id);

CREATE TABLE messages (
    id UUID PRIMARY KEY,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    media_id UUID REFERENCES media(id) ON DELETE SET NULL,
    reply_to UUID,
    forwarded BOOLEAN NOT NULL DEFAULT false,
    meta JSONB NOT NULL DEFAULT '{}',
    edited_at TIMESTAMPTZ,
    deleted BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_chat_time ON messages(chat_id, created_at DESC);
CREATE INDEX messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE receipts (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    played_at TIMESTAMPTZ,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX receipts_user_pending ON receipts(user_id) WHERE delivered_at IS NULL;

CREATE TABLE reactions (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);

CREATE TABLE stars (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, message_id)
);

CREATE TABLE hidden_messages (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, message_id)
);

CREATE TABLE poll_votes (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_idx INT NOT NULL,
    PRIMARY KEY (message_id, user_id, option_idx)
);

CREATE TABLE calls (
    id UUID PRIMARY KEY,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    caller_id UUID REFERENCES users(id) ON DELETE SET NULL,
    video BOOLEAN NOT NULL,
    status TEXT NOT NULL DEFAULT 'ringing', -- ringing | ongoing | ended | missed | rejected
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    answered_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ
);
CREATE INDEX calls_chat ON calls(chat_id, started_at DESC);

CREATE TABLE broadcast_lists (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE broadcast_members (
    list_id UUID NOT NULL REFERENCES broadcast_lists(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (list_id, user_id)
);
