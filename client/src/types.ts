export type Privacy = "everyone" | "contacts" | "nobody";

export interface Me {
  id: string;
  phone: string;
  name: string;
  about: string;
  avatar_id: string | null;
  privacy_last_seen: Privacy;
  privacy_photo: Privacy;
  privacy_about: Privacy;
  privacy_groups: Privacy;
  privacy_messages: "everyone" | "contacts";
  read_receipts: boolean;
  has_pin: boolean;
  created_at: string;
}

export interface User {
  id: string;
  phone: string;
  name: string;
  about: string | null;
  avatar_id: string | null;
  last_seen: string | null;
  online: boolean;
  contact_name: string | null;
  blocked_by_me: boolean;
}

export interface Media {
  id: string;
  mime: string;
  size: number;
  filename: string;
}

export interface ReplyPreview {
  id: string;
  sender_id: string | null;
  kind: string;
  body: string;
  deleted: boolean;
}

export interface Message {
  id: string;
  chat_id: string;
  sender_id: string | null;
  kind: string;
  body: string;
  media: Media | null;
  reply_to: ReplyPreview | null;
  forwarded: boolean;
  meta: any;
  edited_at: string | null;
  deleted: boolean;
  expires_at: string | null;
  created_at: string;
  reactions: { user_id: string; emoji: string }[];
  votes: { user_id: string; option_idx: number }[];
  status: "sent" | "delivered" | "read";
  played: boolean;
  starred: boolean;
  /** client-only: still uploading/sending */
  pending?: boolean;
  failed?: boolean;
}

export interface Member {
  user: User;
  role: "owner" | "admin" | "member";
}

export interface Chat {
  id: string;
  kind: "direct" | "group";
  name: string;
  description: string;
  avatar_id: string | null;
  created_by: string | null;
  created_at: string;
  disappearing_seconds: number;
  invite_code: string | null;
  admins_only_send: boolean;
  admins_only_edit: boolean;
  members: Member[];
  my_role: Member["role"];
  muted_until: string | null;
  archived: boolean;
  pinned: boolean;
  last_read_at: string;
  unread: number;
  last_message: Message | null;
}

export interface CallLogEntry {
  id: string;
  chat_id: string;
  caller_id: string | null;
  video: boolean;
  status: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
}

export interface CallInfo {
  id: string;
  chat_id: string;
  caller_id: string;
  video: boolean;
  answered: boolean;
  started_at: string;
  participants: string[];
}

export interface Session {
  id: string;
  device_name: string;
  created_at: string;
  last_active: string;
  current: boolean;
}

export interface BroadcastList {
  id: string;
  name: string;
  member_ids: string[];
}
