-- Who may start conversations and calls with this user: everyone | contacts
ALTER TABLE users ADD COLUMN privacy_messages TEXT NOT NULL DEFAULT 'everyone';
