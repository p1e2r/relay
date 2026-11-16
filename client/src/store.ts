import { create } from "zustand";
import { LocalNotifications } from "@capacitor/local-notifications";
import { api, isCapacitor, isTauri, realtime, setToken } from "./api";
import type { Chat, Me, Message, User } from "./types";
import { calls } from "./call";
import { messagePreview, chatTitle } from "./util";

interface TypingEntry {
  state: string;
  at: number;
}

interface State {
  me: Me | null;
  users: Record<string, User>;
  chats: Record<string, Chat>;
  chatsLoaded: boolean;
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  typing: Record<string, Record<string, TypingEntry>>;
  activeChat: string | null;
  connected: boolean;
  jumpTo: string | null;

  signIn(token: string, me: Me): Promise<void>;
  boot(): Promise<void>;
  signOut(): Promise<void>;
  setMe(me: Me): void;
  mergeUsers(list: User[]): void;
  loadChats(): Promise<void>;
  upsertChat(chat: Chat): void;
  refreshChat(id: string): Promise<void>;
  removeChat(id: string): void;
  openChat(id: string | null, jumpTo?: string | null): void;
  loadMessages(chatId: string, older?: boolean): Promise<void>;
  sendMessage(chatId: string, payload: Partial<Message> & { kind: string; media_id?: string }, local?: Partial<Message>): Promise<Message | null>;
  addMessage(m: Message): void;
  replaceMessage(m: Message, keepStar?: boolean): void;
  removeMessage(chatId: string, id: string): void;
  markRead(chatId: string): void;
}

let readTimers: Record<string, number> = {};

export const useStore = create<State>((set, get) => ({
  me: null,
  users: {},
  chats: {},
  chatsLoaded: false,
  messages: {},
  hasMore: {},
  typing: {},
  activeChat: null,
  connected: false,
  jumpTo: null,

  async signIn(token, me) {
    setToken(token);
    set({ me });
    await get().boot();
  },

  async boot() {
    const me = await api<Me>("GET", "/me");
    set({ me });
    realtime.start();
    await get().loadChats();
    api<User[]>("GET", "/contacts").then((c) => get().mergeUsers(c)).catch(() => {});
  },

  async signOut() {
    try {
      await api("POST", "/auth/logout");
    } catch {}
    realtime.stop();
    setToken(null);
    set({ me: null, chats: {}, messages: {}, users: {}, activeChat: null, chatsLoaded: false });
  },

  setMe(me) {
    set({ me });
  },

  mergeUsers(list) {
    if (!list.length) return;
    set((s) => {
      const users = { ...s.users };
      for (const u of list) users[u.id] = u;
      return { users };
    });
  },

  async loadChats() {
    const list = await api<Chat[]>("GET", "/chats");
    const chats: Record<string, Chat> = {};
    for (const c of list) chats[c.id] = c;
    get().mergeUsers(list.flatMap((c) => c.members.map((m) => m.user)));
    set({ chats, chatsLoaded: true });
  },

  upsertChat(chat) {
    get().mergeUsers(chat.members.map((m) => m.user));
    set((s) => ({ chats: { ...s.chats, [chat.id]: chat } }));
  },

  async refreshChat(id) {
    try {
      const chat = await api<Chat>("GET", `/chats/${id}`);
      get().upsertChat(chat);
    } catch (e: any) {
      if (e.status === 403 || e.status === 404) get().removeChat(id);
    }
  },

  removeChat(id) {
    set((s) => {
      const chats = { ...s.chats };
      delete chats[id];
      return { chats, activeChat: s.activeChat === id ? null : s.activeChat };
    });
  },

  openChat(id, jumpTo = null) {
    set({ activeChat: id, jumpTo });
    if (!id) return;
    if (!get().messages[id]) get().loadMessages(id);
    get().markRead(id);
  },

  async loadMessages(chatId, older = false) {
    const existing = get().messages[chatId] || [];
    const before = older && existing.length ? `&before=${encodeURIComponent(existing[0].created_at)}` : "";
    const list = await api<Message[]>("GET", `/chats/${chatId}/messages?limit=50${before}`);
    set((s) => ({
      messages: { ...s.messages, [chatId]: older ? [...list, ...(s.messages[chatId] || [])] : list },
      hasMore: { ...s.hasMore, [chatId]: list.length === 50 },
    }));
  },

  async sendMessage(chatId, payload, local = {}) {
    const me = get().me!;
    const tempId = "tmp-" + Math.random().toString(36).slice(2);
    const optimistic: Message = {
      id: tempId,
      chat_id: chatId,
      sender_id: me.id,
      kind: payload.kind,
      body: payload.body || "",
      media: null,
      reply_to: null,
      forwarded: false,
      meta: payload.meta || {},
      edited_at: null,
      deleted: false,
      expires_at: null,
      created_at: new Date().toISOString(),
      reactions: [],
      votes: [],
      status: "sent",
      played: false,
      starred: false,
      pending: true,
      ...local,
    };
    get().addMessage(optimistic);
    try {
      const body: any = { kind: payload.kind, body: payload.body || "", meta: payload.meta || {} };
      if (payload.media_id) body.media_id = payload.media_id;
      if ((payload as any).reply_to_id) body.reply_to = (payload as any).reply_to_id;
      const sent = await api<Message>("POST", `/chats/${chatId}/messages`, body);
      set((s) => {
        const list = (s.messages[chatId] || []).filter((m) => m.id !== tempId && m.id !== sent.id);
        return { messages: { ...s.messages, [chatId]: [...list, sent].sort(byTime) } };
      });
      return sent;
    } catch (e: any) {
      set((s) => ({
        messages: {
          ...s.messages,
          [chatId]: (s.messages[chatId] || []).map((m) => (m.id === tempId ? { ...m, pending: false, failed: true, meta: { ...m.meta, error: e.message } } : m)),
        },
      }));
      return null;
    }
  },

  addMessage(m) {
    set((s) => {
      const chat = s.chats[m.chat_id];
      const out: Partial<State> = {};
      const list = s.messages[m.chat_id];
      if (list && !list.some((x) => x.id === m.id)) {
        out.messages = { ...s.messages, [m.chat_id]: [...list, m].sort(byTime) };
      }
      if (chat && !m.pending) {
        const mine = m.sender_id === s.me?.id;
        const viewing = s.activeChat === m.chat_id && document.visibilityState === "visible";
        out.chats = {
          ...s.chats,
          [m.chat_id]: {
            ...chat,
            last_message: m,
            unread: mine || viewing || m.kind === "system" ? chat.unread : chat.unread + 1,
          },
        };
      }
      return out;
    });
  },

  replaceMessage(m, keepStar = true) {
    set((s) => {
      const out: Partial<State> = {};
      const list = s.messages[m.chat_id];
      if (list) {
        out.messages = {
          ...s.messages,
          [m.chat_id]: list.map((x) => (x.id === m.id ? { ...m, starred: keepStar ? x.starred : m.starred } : x)),
        };
      }
      const chat = s.chats[m.chat_id];
      if (chat?.last_message?.id === m.id) out.chats = { ...s.chats, [m.chat_id]: { ...chat, last_message: m } };
      return out;
    });
  },

  removeMessage(chatId, id) {
    set((s) => {
      const out: Partial<State> = {};
      if (s.messages[chatId]) out.messages = { ...s.messages, [chatId]: s.messages[chatId].filter((m) => m.id !== id) };
      const chat = s.chats[chatId];
      if (chat?.last_message?.id === id) {
        const list = (out.messages || s.messages)[chatId] || [];
        out.chats = { ...s.chats, [chatId]: { ...chat, last_message: list[list.length - 1] || null } };
      }
      return out;
    });
  },

  markRead(chatId) {
    const chat = get().chats[chatId];
    if (chat) set((s) => ({ chats: { ...s.chats, [chatId]: { ...chat, unread: 0 } } }));
    clearTimeout(readTimers[chatId]);
    readTimers[chatId] = window.setTimeout(() => api("POST", `/chats/${chatId}/read`).catch(() => {}), 300);
  },
}));

const byTime = (a: Message, b: Message) => a.created_at.localeCompare(b.created_at);

// ---------- realtime events ----------

function notify(m: Message) {
  const s = useStore.getState();
  const chat = s.chats[m.chat_id];
  if (!chat || m.sender_id === s.me?.id || m.kind === "system") return;
  const muted = chat.muted_until && new Date(chat.muted_until) > new Date();
  if (muted) return;
  if (document.visibilityState === "visible" && document.hasFocus() && s.activeChat === m.chat_id) return;
  const sender = m.sender_id ? s.users[m.sender_id] : null;
  const title = chatTitle(chat, s.me!.id, s.users);
  const prefix = chat.kind === "group" && sender ? `${sender.contact_name || sender.name || sender.phone}: ` : "";
  const tauriNotify = (window as any).__TAURI__?.notification;
  if (isTauri && tauriNotify) {
    tauriNotify.sendNotification({ title, body: prefix + messagePreview(m) });
    return;
  }
  if (isCapacitor) {
    LocalNotifications.schedule({
      notifications: [{ id: Math.floor(Math.random() * 2 ** 31), title, body: prefix + messagePreview(m), extra: { chatId: m.chat_id } }],
    }).catch(() => {});
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body: prefix + messagePreview(m), tag: m.chat_id, icon: "./icon-192.png" });
    n.onclick = () => {
      window.focus();
      useStore.getState().openChat(m.chat_id);
    };
  } catch {}
}

if (isCapacitor) {
  LocalNotifications.requestPermissions().catch(() => {});
  LocalNotifications.addListener("localNotificationActionPerformed", (a) => {
    const chatId = a.notification.extra?.chatId;
    if (chatId) useStore.getState().openChat(chatId);
  }).catch(() => {});
}

realtime.onStatus((up) => {
  useStore.setState({ connected: up });
  if (up && useStore.getState().me) {
    // Catch up on anything missed while disconnected.
    const s = useStore.getState();
    s.loadChats().catch(() => {});
    if (s.activeChat) s.loadMessages(s.activeChat).catch(() => {});
  }
});

realtime.on((ev) => {
  const s = useStore.getState();
  switch (ev.type) {
    case "message.new": {
      const m: Message = ev.message;
      if (!s.chats[m.chat_id]) {
        s.refreshChat(m.chat_id);
        return;
      }
      if (m.sender_id && !s.users[m.sender_id]) {
        api<User>("GET", `/users/${m.sender_id}`).then((u) => s.mergeUsers([u])).catch(() => {});
      }
      s.addMessage(m);
      notify(m);
      if (s.activeChat === m.chat_id && document.visibilityState === "visible" && m.sender_id !== s.me?.id) s.markRead(m.chat_id);
      if (m.kind === "system") s.refreshChat(m.chat_id);
      // clear typing indicator for that sender
      if (m.sender_id && s.typing[m.chat_id]?.[m.sender_id]) {
        const t = { ...s.typing[m.chat_id] };
        delete t[m.sender_id];
        useStore.setState({ typing: { ...s.typing, [m.chat_id]: t } });
      }
      break;
    }
    case "message.updated":
      s.replaceMessage(ev.message);
      break;
    case "message.status": {
      const patch = (m: Message) => (m.id === ev.id ? { ...m, status: ev.status, played: ev.played } : m);
      useStore.setState((st) => {
        const out: any = {};
        if (st.messages[ev.chat_id]) out.messages = { ...st.messages, [ev.chat_id]: st.messages[ev.chat_id].map(patch) };
        const chat = st.chats[ev.chat_id];
        if (chat?.last_message && chat.last_message.id === ev.id) out.chats = { ...st.chats, [ev.chat_id]: { ...chat, last_message: patch(chat.last_message) } };
        return out;
      });
      break;
    }
    case "message.hidden":
    case "message.expired":
      s.removeMessage(ev.chat_id, ev.id);
      break;
    case "typing": {
      const chatTyping = { ...(s.typing[ev.chat_id] || {}) };
      if (ev.state === "stop") delete chatTyping[ev.user_id];
      else chatTyping[ev.user_id] = { state: ev.state, at: Date.now() };
      useStore.setState({ typing: { ...s.typing, [ev.chat_id]: chatTyping } });
      break;
    }
    case "presence": {
      const u = s.users[ev.user_id];
      if (u) s.mergeUsers([{ ...u, online: ev.online, last_seen: ev.last_seen || u.last_seen }]);
      break;
    }
    case "user.updated":
      if (ev.user_id === s.me?.id) api<Me>("GET", "/me").then((me) => s.setMe(me));
      else
        api<User>("GET", `/users/${ev.user_id}`)
          .then((u) => {
            s.mergeUsers([u]);
            Object.values(useStore.getState().chats)
              .filter((c) => c.members.some((m) => m.user.id === u.id))
              .forEach((c) => s.upsertChat({ ...c, members: c.members.map((m) => (m.user.id === u.id ? { ...m, user: u } : m)) }));
          })
          .catch(() => {});
      break;
    case "chat.updated":
      s.refreshChat(ev.chat_id);
      break;
    case "chat.removed":
      s.removeChat(ev.chat_id);
      break;
    case "chat.cleared":
      useStore.setState((st) => ({ messages: { ...st.messages, [ev.chat_id]: [] } }));
      s.refreshChat(ev.chat_id);
      break;
    case "chat.read": {
      const chat = s.chats[ev.chat_id];
      if (chat) useStore.setState({ chats: { ...s.chats, [ev.chat_id]: { ...chat, unread: 0 } } });
      break;
    }
  }
  if (ev.type?.startsWith("call.")) calls.handle(ev);
});

// Expire stale typing indicators.
setInterval(() => {
  const { typing } = useStore.getState();
  let changed = false;
  const next: State["typing"] = {};
  for (const [chat, users] of Object.entries(typing)) {
    next[chat] = {};
    for (const [u, t] of Object.entries(users)) {
      if (Date.now() - t.at < 6000) next[chat][u] = t;
      else changed = true;
    }
  }
  if (changed) useStore.setState({ typing: next });
}, 2000);

document.addEventListener("visibilitychange", () => {
  const s = useStore.getState();
  if (document.visibilityState === "visible" && s.activeChat) s.markRead(s.activeChat);
});

window.addEventListener("relay:logout", () => {
  realtime.stop();
  useStore.setState({ me: null, chats: {}, messages: {}, activeChat: null, chatsLoaded: false });
});
