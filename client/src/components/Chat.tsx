import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, realtime, upload } from "../api";
import { calls } from "../call";
import { useStore } from "../store";
import type { Chat, Message } from "../types";
import { useUI } from "../ui-state";
import { chatAvatarId, chatTitle, dayLabel, disappearingLabel, duration, lastSeenText, messagePreview, otherMember, userName } from "../util";
import { ContactShareDialog, LocationDialog, PollDialog } from "./Dialogs";
import { Bubble, ReplyQuote, type BubbleActions } from "./Message";
import { useName } from "./Sidebar";
import { attempt, Avatar, EmojiPicker, Icon, IconButton, toast, useMenu } from "./ui";

export function ChatView({ chat }: { chat: Chat }) {
  const me = useStore((s) => s.me)!;
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const menu = useMenu();

  useEffect(() => {
    setReply(null);
    setEditing(null);
  }, [chat.id]);

  const actions: BubbleActions = {
    reply: (m) => {
      setEditing(null);
      setReply(m);
    },
    edit: (m) => {
      setReply(null);
      setEditing(m);
    },
    jump: (id) => useStore.setState({ jumpTo: id }),
    menu: menu.open,
  };

  return (
    <div className="chat-view">
      <ChatHeader chat={chat} />
      <MessageList chat={chat} meId={me.id} actions={actions} />
      <Composer chat={chat} reply={reply} clearReply={() => setReply(null)} editing={editing} clearEdit={() => setEditing(null)} />
      {menu.node}
    </div>
  );
}

function ChatHeader({ chat }: { chat: Chat }) {
  const me = useStore((s) => s.me)!;
  const users = useStore((s) => s.users);
  const typing = useStore((s) => s.typing[chat.id]);
  const setRight = useUI((s) => s.setRight);
  const name = useName();
  const menu = useMenu();
  const title = chatTitle(chat, me.id, users);
  const other = otherMember(chat, me.id);
  const otherUser = other ? users[other.id] || other : undefined;
  const typers = Object.entries(typing || {}).filter(([u]) => u !== me.id);
  const muted = chat.muted_until && new Date(chat.muted_until) > new Date();

  let subtitle = "";
  if (typers.length) {
    const what = typers[0][1].state === "recording" ? "recording audio…" : "typing…";
    subtitle = chat.kind === "group" ? `${name(typers[0][0])} is ${what}` : what;
  } else if (chat.kind === "direct") {
    subtitle = otherUser ? lastSeenText(otherUser) : "Message yourself";
  } else {
    subtitle = chat.members
      .map((m) => (m.user.id === me.id ? "You" : userName(users[m.user.id] || m.user)))
      .sort((a, b) => (a === "You" ? 1 : b === "You" ? -1 : a.localeCompare(b)))
      .join(", ");
  }

  const settings = (body: object) => attempt(async () => useStore.getState().upsertChat(await api<Chat>("PATCH", `/chats/${chat.id}/settings`, body)));

  return (
    <div className="chat-head">
      <IconButton icon="back" title="Back" className="mobile-only" onClick={() => useStore.getState().openChat(null)} />
      <button className="plain chat-head-main" onClick={() => setRight("info")}>
        <Avatar id={chat.kind === "group" ? chat.id : other?.id || me.id} mediaId={chatAvatarId(chat, me.id, users)} name={title} size={40} group={chat.kind === "group"} />
        <div className="min0">
          <div className="chat-name">{title}</div>
          <div className={"chat-preview small" + (typers.length ? " accent" : "")}>{subtitle}</div>
        </div>
      </button>
      <IconButton icon="video" title="Video call" onClick={() => calls.start(chat.id, true)} disabled={!other && chat.kind === "direct"} />
      <IconButton icon="phone" title="Voice call" onClick={() => calls.start(chat.id, false)} disabled={!other && chat.kind === "direct"} />
      <IconButton icon="search" title="Search" onClick={() => setRight("search")} />
      <IconButton
        icon="more"
        title="Menu"
        onClick={(e) =>
          menu.open(e, [
            { label: chat.kind === "group" ? "Group info" : "Contact info", icon: "info", onClick: () => setRight("info") },
            { label: muted ? "Unmute notifications" : "Mute notifications", icon: "mute", onClick: () => settings({ mute_seconds: muted ? 0 : 8 * 3600 }) },
            {
              label: `Disappearing messages (${disappearingLabel(chat.disappearing_seconds)})`,
              icon: "timer",
              onClick: () => setRight("info"),
            },
            { label: chat.pinned ? "Unpin chat" : "Pin chat", icon: "pin", onClick: () => settings({ pinned: !chat.pinned }) },
            { label: chat.archived ? "Unarchive" : "Archive", icon: "archive", onClick: () => settings({ archived: !chat.archived }) },
            {
              label: "Clear chat",
              icon: "trash",
              danger: true,
              onClick: () => confirm("Clear all messages in this chat for you?") && attempt(() => api("POST", `/chats/${chat.id}/clear`)),
            },
            { label: "Close chat", icon: "close", onClick: () => useStore.getState().openChat(null) },
          ])
        }
      />
      {menu.node}
    </div>
  );
}

function MessageList({ chat, meId, actions }: { chat: Chat; meId: string; actions: BubbleActions }) {
  const messages = useStore((s) => s.messages[chat.id]);
  const hasMore = useStore((s) => s.hasMore[chat.id]);
  const jumpTo = useStore((s) => s.jumpTo);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevHeight = useRef(0);
  const loadingOlder = useRef(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [showDown, setShowDown] = useState(false);
  const firstUnread = useRef<string | null>(null);

  // Remember where the unread divider goes when the chat opens.
  useEffect(() => {
    firstUnread.current = null;
    stick.current = true;
  }, [chat.id]);
  useEffect(() => {
    if (!messages || firstUnread.current !== null) return;
    const lr = chat.last_read_at;
    const m = messages.find((x) => x.created_at > lr && x.sender_id !== meId && x.kind !== "system");
    firstUnread.current = chat.unread > 0 && m ? m.id : "";
  }, [messages, chat.id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (loadingOlder.current) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      loadingOlder.current = false;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Jump to a message (reply quote, search, starred), loading older pages if needed.
  useEffect(() => {
    if (!jumpTo || !messages) return;
    const el = document.getElementById("msg-" + jumpTo);
    if (el) {
      stick.current = false;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setHighlight(jumpTo);
      setTimeout(() => setHighlight(null), 1800);
      useStore.setState({ jumpTo: null });
    } else if (hasMore) {
      loadOlder();
    } else {
      useStore.setState({ jumpTo: null });
      toast("Message not found");
    }
  }, [jumpTo, messages]);

  const loadOlder = useCallback(() => {
    if (loadingOlder.current || !hasMore) return;
    loadingOlder.current = true;
    prevHeight.current = ref.current?.scrollHeight || 0;
    useStore
      .getState()
      .loadMessages(chat.id, true)
      .catch(() => (loadingOlder.current = false));
  }, [chat.id, hasMore]);

  const onScroll = () => {
    const el = ref.current!;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = fromBottom < 80;
    setShowDown(fromBottom > 400);
    if (el.scrollTop < 200) loadOlder();
  };

  if (!messages)
    return (
      <div className="messages">
        <div className="center muted pad">Loading…</div>
      </div>
    );

  let lastDay = "";
  return (
    <div className="messages" ref={ref} onScroll={onScroll}>
      <div className="encryption-note small">
        <Icon name="lock" size={12} /> Messages are stored on your own Relay server and sent over TLS.
      </div>
      {messages.map((m, i) => {
        const day = dayLabel(m.created_at);
        const showDay = day !== lastDay;
        lastDay = day;
        const prev = messages[i - 1];
        const showName = !prev || prev.sender_id !== m.sender_id || prev.kind === "system" || showDay;
        return (
          <Fragment key={m.id}>
            {showDay && (
              <div className="day-sep">
                <span>{day}</span>
              </div>
            )}
            {firstUnread.current === m.id && (
              <div className="unread-sep">
                <span>Unread messages</span>
              </div>
            )}
            <Bubble m={m} chat={chat} meId={meId} showName={showName} actions={actions} highlight={highlight === m.id} />
          </Fragment>
        );
      })}
      {showDown && (
        <button
          className="scroll-down"
          onClick={() => {
            const el = ref.current!;
            el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
        >
          <Icon name="back" size={20} />
          {chat.unread > 0 && <span className="badge">{chat.unread}</span>}
        </button>
      )}
    </div>
  );
}

// ---------- composer ----------

interface Pending {
  file: File;
  url: string;
}

function kindFor(mime: string): string {
  if (mime === "image/gif") return "gif";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

async function sendFile(chatId: string, file: File, caption: string, replyTo?: string, asDocument = false) {
  const kind = asDocument ? "document" : kindFor(file.type);
  const localUrl = kind === "image" || kind === "gif" ? URL.createObjectURL(file) : undefined;
  const tempId = "tmp-" + Math.random().toString(36).slice(2);
  const s = useStore.getState();
  s.addMessage({
    id: tempId,
    chat_id: chatId,
    sender_id: s.me!.id,
    kind,
    body: caption,
    media: null,
    reply_to: null,
    forwarded: false,
    meta: { localUrl, filename: file.name },
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
  });
  try {
    const media = await upload(file, file.name);
    s.removeMessage(chatId, tempId);
    await s.sendMessage(chatId, { kind, body: caption, media_id: media.id, meta: { filename: file.name }, reply_to_id: replyTo } as any);
  } catch (e: any) {
    s.removeMessage(chatId, tempId);
    toast(e.message || "Upload failed");
  }
}

function Composer({ chat, reply, clearReply, editing, clearEdit }: { chat: Chat; reply: Message | null; clearReply: () => void; editing: Message | null; clearEdit: () => void }) {
  const me = useStore((s) => s.me)!;
  const users = useStore((s) => s.users);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [emoji, setEmoji] = useState(false);
  const [dialog, setDialog] = useState<null | "poll" | "contact" | "location">(null);
  const [recording, setRecording] = useState<null | { started: number }>(null);
  const [, tick] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const cancelRec = useRef(false);
  const lastTyping = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const menu = useMenu();
  const drafts = useRef<Record<string, string>>({});

  // keep a draft per chat
  useEffect(() => {
    setText(drafts.current[chat.id] || "");
    setPending([]);
    input.current?.focus();
  }, [chat.id]);
  useEffect(() => {
    drafts.current[chat.id] = text;
  }, [text]);
  useEffect(() => {
    if (editing) {
      setText(editing.body);
      input.current?.focus();
    }
  }, [editing]);
  useEffect(() => {
    if (reply) input.current?.focus();
  }, [reply]);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [recording]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }, [text]);

  const other = otherMember(chat, me.id);
  const otherUser = other ? users[other.id] || other : null;
  const isAdmin = chat.my_role === "admin" || chat.my_role === "owner";

  if (chat.kind === "group" && chat.admins_only_send && !isAdmin) {
    return <div className="composer-locked muted">Only admins can send messages</div>;
  }
  if (otherUser?.blocked_by_me) {
    return (
      <button className="composer-locked link-btn" onClick={() => attempt(async () => {
        await api("DELETE", `/blocks/${otherUser.id}`);
        useStore.getState().mergeUsers([{ ...otherUser, blocked_by_me: false }]);
      })}>
        You blocked this contact. Tap to unblock.
      </button>
    );
  }

  const typingPing = (state: string) => {
    if (state !== "stop" && Date.now() - lastTyping.current < 3000) return;
    lastTyping.current = state === "stop" ? 0 : Date.now();
    realtime.send({ type: "typing", chat_id: chat.id, state });
  };

  const send = async () => {
    const body = text.trim();
    if (editing) {
      if (body && body !== editing.body) {
        const m = await attempt(() => api<Message>("PATCH", `/messages/${editing.id}`, { body }));
        if (m) useStore.getState().replaceMessage(m);
      }
      clearEdit();
      setText("");
      return;
    }
    if (pending.length) {
      const files = pending;
      setPending([]);
      setText("");
      typingPing("stop");
      const replyId = reply?.id;
      clearReply();
      for (let i = 0; i < files.length; i++) {
        await sendFile(chat.id, files[i].file, i === 0 ? body : "", i === 0 ? replyId : undefined);
        URL.revokeObjectURL(files[i].url);
      }
      return;
    }
    if (!body) return;
    setText("");
    typingPing("stop");
    const local: Partial<Message> = reply ? { reply_to: { id: reply.id, sender_id: reply.sender_id, kind: reply.kind, body: reply.body, deleted: false } } : {};
    const replyId = reply?.id;
    clearReply();
    await useStore.getState().sendMessage(chat.id, { kind: "text", body, reply_to_id: replyId } as any, local);
  };

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 30);
    setPending((p) => [...p, ...list.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
    input.current?.focus();
  };

  const pickFiles = (accept: string, asDocument = false) => {
    const el = document.createElement("input");
    el.type = "file";
    el.multiple = true;
    el.accept = accept;
    el.onchange = () => {
      if (!el.files?.length) return;
      if (asDocument) Array.from(el.files).forEach((f) => sendFile(chat.id, f, "", undefined, true));
      else addFiles(el.files);
    };
    el.click();
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      cancelRec.current = false;
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      const started = Date.now();
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        typingPing("stop");
        setRecording(null);
        if (cancelRec.current) return;
        const secs = (Date.now() - started) / 1000;
        if (secs < 0.8) return toast("Hold to record, release to send");
        const type = rec.mimeType || "audio/webm";
        const blob = new Blob(chunks.current, { type });
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        try {
          const media = await upload(blob, `voice-${Date.now()}.${ext}`);
          await useStore.getState().sendMessage(chat.id, { kind: "voice", media_id: media.id, meta: { duration: secs }, reply_to_id: reply?.id } as any);
          clearReply();
        } catch (e: any) {
          toast(e.message);
        }
      };
      rec.start(250);
      recorder.current = rec;
      setRecording({ started });
      realtime.send({ type: "typing", chat_id: chat.id, state: "recording" });
    } catch {
      toast("Microphone access is needed to record voice messages");
    }
  };

  const stopRecording = (cancel: boolean) => {
    cancelRec.current = cancel;
    recorder.current?.stop();
    recorder.current = null;
  };

  const canSend = text.trim().length > 0 || pending.length > 0;

  return (
    <div
      className="composer-wrap"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {(reply || editing) && (
        <div className="composer-context">
          {reply && <ReplyQuote r={{ id: reply.id, sender_id: reply.sender_id, kind: reply.kind, body: messagePreview(reply), deleted: false }} />}
          {editing && (
            <div className="quote">
              <div className="quote-name accent">Edit message</div>
              <div className="quote-text">{editing.body}</div>
            </div>
          )}
          <IconButton
            icon="close"
            title="Cancel"
            onClick={() => {
              clearReply();
              if (editing) {
                clearEdit();
                setText("");
              }
            }}
          />
        </div>
      )}
      {pending.length > 0 && (
        <div className="pending-files">
          {pending.map((p, i) => (
            <div key={p.url} className="pending-file">
              {p.file.type.startsWith("image/") ? <img src={p.url} alt="" /> : p.file.type.startsWith("video/") ? <video src={p.url} muted /> : <div className="pending-doc"><Icon name="file" /><span>{p.file.name}</span></div>}
              <button className="pending-remove" onClick={() => setPending((list) => list.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <button className="pending-add" onClick={() => pickFiles("image/*,video/*")}>
            <Icon name="plus" />
          </button>
        </div>
      )}
      <div className="composer">
        {recording ? (
          <>
            <IconButton icon="trash" title="Cancel recording" className="danger" onClick={() => stopRecording(true)} />
            <div className="recording grow">
              <span className="rec-dot" /> {duration((Date.now() - recording.started) / 1000)}
            </div>
            <IconButton icon="send" title="Send voice message" className="send-btn" onClick={() => stopRecording(false)} />
          </>
        ) : (
          <>
            <div className="composer-tools">
              <IconButton icon="emoji" title="Emoji" onClick={() => setEmoji(!emoji)} />
              {!editing && (
                <IconButton
                  icon="plus"
                  title="Attach"
                  onClick={(e) =>
                    menu.open(e, [
                      { label: "Photos & videos", icon: "image", onClick: () => pickFiles("image/*,video/*") },
                      { label: "Document", icon: "file", onClick: () => pickFiles("*/*", true) },
                      { label: "Audio", icon: "headphones", onClick: () => pickFiles("audio/*") },
                      { label: "Location", icon: "location", onClick: () => setDialog("location") },
                      { label: "Contact", icon: "person", onClick: () => setDialog("contact") },
                      { label: "Poll", icon: "poll", onClick: () => setDialog("poll") },
                    ])
                  }
                />
              )}
            </div>
            <textarea
              ref={input}
              className="composer-input"
              rows={1}
              placeholder={pending.length ? "Add a caption" : "Type a message"}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (e.target.value) typingPing("typing");
              }}
              onBlur={() => text && typingPing("stop")}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                const mobile = window.matchMedia("(pointer: coarse)").matches;
                if (e.key === "Enter" && !e.shiftKey && !mobile) {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape") {
                  clearReply();
                  if (editing) {
                    clearEdit();
                    setText("");
                  }
                }
              }}
            />
            {canSend || editing ? (
              <IconButton icon={editing ? "check" : "send"} title="Send" className="send-btn" onClick={send} />
            ) : (
              <IconButton icon="mic" title="Record voice message" className="send-btn" onClick={startRecording} />
            )}
          </>
        )}
      </div>
      {emoji && <EmojiPicker onPick={(e) => setText((t) => t + e)} onClose={() => setEmoji(false)} />}
      {dialog === "poll" && <PollDialog chatId={chat.id} onClose={() => setDialog(null)} />}
      {dialog === "contact" && <ContactShareDialog chatId={chat.id} onClose={() => setDialog(null)} />}
      {dialog === "location" && <LocationDialog chatId={chat.id} onClose={() => setDialog(null)} />}
      {menu.node}
    </div>
  );
}
