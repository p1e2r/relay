import type { Chat, Message, User } from "./types";

export function userName(u: User | undefined | null, meId?: string): string {
  if (!u) return "Unknown";
  if (meId && u.id === meId) return "You";
  return u.contact_name || u.name || u.phone;
}

export function otherMember(chat: Chat, meId: string): User | undefined {
  return chat.members.find((m) => m.user.id !== meId)?.user;
}

export function chatTitle(chat: Chat, meId: string, users: Record<string, User>): string {
  if (chat.kind === "group") return chat.name;
  const other = otherMember(chat, meId);
  if (!other) return "Message yourself";
  return userName(users[other.id] || other);
}

export function chatAvatarId(chat: Chat, meId: string, users: Record<string, User>): string | null {
  if (chat.kind === "group") return chat.avatar_id;
  const o = otherMember(chat, meId);
  return o ? (users[o.id] || o).avatar_id : null;
}

export function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function timeOf(iso: string) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  const diff = (today.getTime() - d.getTime()) / 86400000;
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

export function listTime(iso: string) {
  const d = new Date(iso);
  const label = dayLabel(iso);
  if (label === "Today") return timeOf(iso);
  if (label === "Yesterday") return "Yesterday";
  const diff = (Date.now() - d.getTime()) / 86400000;
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString();
}

export function lastSeenText(u: User | undefined): string {
  if (!u) return "";
  if (u.online) return "online";
  if (!u.last_seen) return "";
  const label = dayLabel(u.last_seen);
  if (label === "Today") return `last seen today at ${timeOf(u.last_seen)}`;
  if (label === "Yesterday") return `last seen yesterday at ${timeOf(u.last_seen)}`;
  return `last seen ${label} at ${timeOf(u.last_seen)}`;
}

export function fileSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function duration(sec: number) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function initials(name: string) {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "#";
}

const PALETTE = ["#e17076", "#7bc862", "#e5ca77", "#65aadd", "#a695e7", "#ee7aae", "#6ec9cb", "#faa774"];
export function colorFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function messagePreview(m: Message): string {
  if (m.deleted) return "This message was deleted";
  switch (m.kind) {
    case "text":
      return m.body;
    case "image":
      return "📷 " + (m.body || "Photo");
    case "video":
      return "🎥 " + (m.body || "Video");
    case "gif":
      return "GIF";
    case "sticker":
      return "Sticker";
    case "voice":
      return "🎤 Voice message" + (m.meta?.duration ? ` (${duration(m.meta.duration)})` : "");
    case "audio":
      return "🎵 " + (m.media?.filename || "Audio");
    case "document":
      return "📄 " + (m.media?.filename || "Document");
    case "location":
      return m.meta?.live_until ? "📍 Live location" : "📍 Location";
    case "contact":
      return "👤 " + (m.meta?.name || m.meta?.phone);
    case "poll":
      return "📊 " + m.meta?.question;
    case "system":
      return "";
    default:
      return m.body;
  }
}

export function disappearingLabel(sec: number) {
  if (!sec) return "Off";
  if (sec === 86400) return "24 hours";
  if (sec === 604800) return "7 days";
  if (sec === 7776000) return "90 days";
  return `${sec}s`;
}

export function systemText(m: Message, name: (id: string) => string): string {
  const actor = m.sender_id ? name(m.sender_id) : "Someone";
  const meta = m.meta || {};
  const targets = (meta.targets || []).map((t: string) => name(t)).join(", ");
  switch (meta.action) {
    case "created":
      return `${actor} created group "${meta.name}"`;
    case "added":
      return `${actor} added ${targets}`;
    case "removed":
      return `${actor} removed ${targets}`;
    case "left":
      return `${actor} left`;
    case "joined_link":
      return `${actor} joined using this group's invite link`;
    case "renamed":
      return `${actor} changed the group name to "${meta.name}"`;
    case "description":
      return `${actor} changed the group description`;
    case "icon":
      return `${actor} changed this group's icon`;
    case "promoted":
      return `${actor} made ${targets} an admin`;
    case "demoted":
      return `${actor} dismissed ${targets} as admin`;
    case "disappearing":
      return meta.seconds
        ? `${actor} turned on disappearing messages. New messages will disappear ${disappearingLabel(meta.seconds)} after they're sent.`
        : `${actor} turned off disappearing messages.`;
    case "admins_only_send":
      return meta.value ? `${actor} changed this group's settings to allow only admins to send messages` : `${actor} changed this group's settings to allow all members to send messages`;
    default:
      return "";
  }
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  if ("__TAURI_INTERNALS__" in window) return `Relay Desktop (${os})`;
  if ((window as any).Capacitor?.isNativePlatform?.()) return `Relay for ${os}`;
  return `${browser}${os ? " on " + os : ""}`;
}
