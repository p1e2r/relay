import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, mediaUrl } from "../api";
import { useStore } from "../store";
import type { Chat, Message } from "../types";
import { useUI } from "../ui-state";
import { colorFor, duration, fileSize, systemText, timeOf } from "../util";
import { stopLive } from "./Dialogs";
import { Ticks, useName } from "./Sidebar";
import { attempt, Icon, QUICK_REACTIONS, toast, type MenuItem } from "./ui";

// ---- WhatsApp-style text formatting: *bold* _italic_ ~strike~ `code` ```block``` and links ----
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index!;
    const before = text[idx - 1];
    if (before && /\w/.test(before)) continue;
    if (idx > last) out.push(...links(text.slice(last, idx), `${keyBase}-t${i}`));
    const tok = m[0];
    const inner = tok.slice(1, -1);
    const k = `${keyBase}-f${i++}`;
    if (tok[0] === "*") out.push(<b key={k}>{inline(inner, k)}</b>);
    else if (tok[0] === "_") out.push(<i key={k}>{inline(inner, k)}</i>);
    else if (tok[0] === "~") out.push(<s key={k}>{inline(inner, k)}</s>);
    else out.push(<code key={k}>{inner}</code>);
    last = idx + tok.length;
  }
  if (last < text.length) out.push(...links(text.slice(last), `${keyBase}-end`));
  return out;
}

function links(text: string, keyBase: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    URL_RE.test(part) ? (
      <a key={`${keyBase}-${i}`} href={part} target="_blank" rel="noreferrer noopener">
        {part}
      </a>
    ) : (
      part
    )
  );
}

export function FormattedText({ text }: { text: string }) {
  const blocks = text.split("```");
  return (
    <>
      {blocks.map((b, i) =>
        i % 2 === 1 ? (
          <pre key={i}>{b.replace(/^\n/, "")}</pre>
        ) : (
          <span key={i}>{inline(b, String(i))}</span>
        )
      )}
    </>
  );
}

const onlyEmoji = (s: string) => /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s){1,8}$/u.test(s) && s.trim().length <= 12;

// ---- voice notes ----
function VoicePlayer({ m, mine }: { m: Message; mine: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [rate, setRate] = useState(1);
  const total = m.meta?.duration || 0;
  const reported = useRef(false);
  return (
    <div className="voice">
      <button
        className="voice-play"
        onClick={() => {
          const a = ref.current!;
          if (a.paused) {
            a.play();
            if (!mine && !reported.current) {
              reported.current = true;
              api("POST", `/messages/${m.id}/played`).catch(() => {});
            }
          } else a.pause();
        }}
      >
        <Icon name={playing ? "pause" : "play"} size={28} />
      </button>
      <input
        type="range"
        className="voice-bar"
        min={0}
        max={total || ref.current?.duration || 1}
        step={0.05}
        value={t}
        onChange={(e) => {
          if (ref.current) ref.current.currentTime = +e.target.value;
        }}
      />
      <span className="voice-time small">{duration(playing || t ? t : total)}</span>
      <button className="voice-rate small" onClick={() => {
        const r = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
        setRate(r);
        if (ref.current) ref.current.playbackRate = r;
      }}>
        {rate}×
      </button>
      <Icon name="mic" size={18} className={"voice-mic" + (m.played ? " read" : "")} />
      <audio
        ref={ref}
        src={mediaUrl(m.media?.id)}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setT(0);
        }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
      />
    </div>
  );
}

function LocationView({ m, mine }: { m: Message; mine: boolean }) {
  const { lat, lng, name, live_until } = m.meta || {};
  const live = live_until && new Date(live_until) > new Date();
  const d = 0.004;
  const embed = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d},${lat - d},${lng + d},${lat + d}&layer=mapnik&marker=${lat},${lng}`;
  return (
    <div className="location">
      <iframe title="map" src={embed} loading="lazy" />
      <a className="location-link" href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`} target="_blank" rel="noreferrer">
        {live ? "🔴 Live location" : name || "Location"} · {Number(lat).toFixed(5)}, {Number(lng).toFixed(5)}
      </a>
      {live && <div className="small muted">Live until {timeOf(live_until)}</div>}
      {live && mine && (
        <button className="link-btn danger" onClick={() => stopLive(m.id)}>
          Stop sharing
        </button>
      )}
    </div>
  );
}

function ContactCard({ m }: { m: Message }) {
  const { name, phone } = m.meta || {};
  return (
    <div className="contact-card">
      <div className="row gap">
        <div className="round-icon">
          <Icon name="person" />
        </div>
        <div>
          <div className="chat-name">{name || phone}</div>
          <div className="small muted">{phone}</div>
        </div>
      </div>
      <div className="row gap">
        <button
          className="link-btn"
          onClick={() =>
            attempt(async () => {
              const u = await api<{ id: string }>("GET", `/users/lookup?phone=${encodeURIComponent(phone)}`);
              const chat = await api<Chat>("POST", "/chats/direct", { user_id: u.id });
              useStore.getState().upsertChat(chat);
              useStore.getState().openChat(chat.id);
            })
          }
        >
          Message
        </button>
        <button className="link-btn" onClick={() => attempt(() => api("POST", "/contacts", { phone, name }), "Contact saved")}>
          Add contact
        </button>
      </div>
    </div>
  );
}

function Poll({ m, meId, memberCount }: { m: Message; meId: string; memberCount: number }) {
  const { question, options = [], multiple } = m.meta || {};
  const mine = new Set(m.votes.filter((v) => v.user_id === meId).map((v) => v.option_idx));
  const counts = options.map((_: string, i: number) => m.votes.filter((v) => v.option_idx === i).length);
  const voters = new Set(m.votes.map((v) => v.user_id)).size;
  const max = Math.max(1, ...counts);
  const vote = (i: number) => {
    const next = new Set(multiple ? mine : []);
    if (mine.has(i)) next.delete(i);
    else next.add(i);
    attempt(() => api("POST", `/messages/${m.id}/vote`, { options: [...next] }));
  };
  return (
    <div className="poll">
      <div className="poll-q">{question}</div>
      <div className="small muted">{multiple ? "Select one or more" : "Select one"}</div>
      {options.map((o: string, i: number) => (
        <button key={i} className="poll-opt" onClick={() => vote(i)}>
          <span className={"poll-check" + (mine.has(i) ? " on" : "")}>{mine.has(i) && <Icon name="check" size={14} />}</span>
          <span className="grow">
            <span className="row-between">
              <span>{o}</span>
              <span className="small">{counts[i]}</span>
            </span>
            <span className="poll-bar">
              <span style={{ width: `${(counts[i] / max) * 100}%` }} />
            </span>
          </span>
        </button>
      ))}
      <div className="small muted center">
        {voters} of {memberCount} voted
      </div>
    </div>
  );
}

function Body({ m, chat, meId, spacer }: { m: Message; chat: Chat; meId: string; spacer: number }) {
  const mine = m.sender_id === meId;
  const name = useName();
  if (m.deleted)
    return (
      <span className="italic muted">
        <span className="meta-spacer" style={{ width: spacer, float: "right" }} />
        <Icon name="block" size={14} /> {mine ? "You deleted this message" : m.meta?.deleted_by && m.meta.deleted_by !== m.sender_id ? `This message was deleted by ${name(m.meta.deleted_by)}` : "This message was deleted"}
      </span>
    );
  const caption = m.body ? (
    <div className="caption">
      <FormattedText text={m.body} />
      <span className="meta-spacer" style={{ width: spacer }} />
    </div>
  ) : null;
  const url = mediaUrl(m.media?.id);
  const open = () => m.media && useUI.setState({ lightbox: { mediaId: m.media.id, mime: m.media.mime } });
  switch (m.kind) {
    case "text":
      return (
        <div className={"text" + (onlyEmoji(m.body) ? " big-emoji" : "")}>
          <FormattedText text={m.body} />
          <span className="meta-spacer" style={{ width: spacer }} />
        </div>
      );
    case "image":
    case "gif":
    case "sticker":
      return (
        <>
          {m.pending && !m.media ? (
            <div className="media-placeholder">
              {m.meta?.localUrl ? <img src={m.meta.localUrl} alt="" className="dim" /> : null}
              <span className="spinner" />
            </div>
          ) : (
            <img className={m.kind === "sticker" ? "sticker" : "media"} src={url} alt="" loading="lazy" onClick={open} />
          )}
          {caption}
        </>
      );
    case "video":
      return (
        <>
          {m.media ? <video className="media" src={url} controls preload="metadata" playsInline /> : <div className="media-placeholder"><span className="spinner" /></div>}
          {caption}
        </>
      );
    case "voice":
      return m.media ? <VoicePlayer m={m} mine={mine} /> : <div className="voice muted">Sending voice message…</div>;
    case "audio":
      return (
        <>
          <div className="small">{m.media?.filename}</div>
          {m.media && <audio src={url} controls preload="none" />}
          {caption}
        </>
      );
    case "document":
      return (
        <>
          <a className="doc" href={url} target="_blank" rel="noreferrer" download={m.media?.filename}>
            <Icon name="file" size={32} />
            <div className="grow min0">
              <div className="ellipsis">{m.media?.filename || m.meta?.filename || "Document"}</div>
              <div className="small muted">
                {m.media ? `${fileSize(m.media.size)} · ${(m.media.filename.split(".").pop() || "").toUpperCase()}` : "Uploading…"}
              </div>
            </div>
            <Icon name="download" size={20} className="muted" />
          </a>
          {caption}
        </>
      );
    case "location":
      return <LocationView m={m} mine={mine} />;
    case "contact":
      return <ContactCard m={m} />;
    case "poll":
      return <Poll m={m} meId={meId} memberCount={chat.members.length} />;
    default:
      return <span className="muted">Unsupported message</span>;
  }
}

export function ReplyQuote({ r, onClick }: { r: NonNullable<Message["reply_to"]>; onClick?: () => void }) {
  const name = useName();
  const label =
    r.kind === "text"
      ? r.body
      : { image: "📷 Photo", video: "🎥 Video", voice: "🎤 Voice message", audio: "🎵 Audio", document: "📄 Document", location: "📍 Location", contact: "👤 Contact", poll: "📊 Poll", gif: "GIF", sticker: "Sticker" }[r.kind] || r.body;
  return (
    <div className="quote" onClick={onClick} style={{ borderColor: r.sender_id ? colorFor(r.sender_id) : undefined }}>
      <div className="quote-name" style={{ color: r.sender_id ? colorFor(r.sender_id) : undefined }}>
        {name(r.sender_id)}
      </div>
      <div className="quote-text">{r.deleted ? "This message was deleted" : label}</div>
    </div>
  );
}

export interface BubbleActions {
  reply(m: Message): void;
  edit(m: Message): void;
  jump(id: string): void;
  menu(e: { clientX: number; clientY: number }, items: MenuItem[]): void;
}

export function Bubble({ m, chat, meId, showName, actions, highlight }: { m: Message; chat: Chat; meId: string; showName: boolean; actions: BubbleActions; highlight: boolean }) {
  const name = useName();
  const [reactOpen, setReactOpen] = useState(false);
  const mine = m.sender_id === meId;
  const isAdmin = chat.my_role === "admin" || chat.my_role === "owner";
  const ageMin = (Date.now() - new Date(m.created_at).getTime()) / 60000;

  useEffect(() => {
    if (!reactOpen) return;
    const close = () => setReactOpen(false);
    setTimeout(() => window.addEventListener("mousedown", close, { once: true }), 0);
  }, [reactOpen]);

  if (m.kind === "system") {
    return (
      <div className="system-msg" id={"msg-" + m.id}>
        <span>{systemText(m, name)}</span>
      </div>
    );
  }

  const react = (emoji: string) => {
    const current = m.reactions.find((r) => r.user_id === meId)?.emoji;
    attempt(() => api("POST", `/messages/${m.id}/react`, { emoji: current === emoji ? "" : emoji }));
    setReactOpen(false);
  };

  const openMenu = (e: { clientX: number; clientY: number }) => {
    if (m.pending) return;
    const items: MenuItem[] = [];
    if (!m.deleted) {
      items.push({ label: "Reply", icon: "reply", onClick: () => actions.reply(m) });
      items.push({ label: "React", icon: "emoji", onClick: () => setReactOpen(true) });
      if (m.body) items.push({ label: "Copy", icon: "copy", onClick: () => navigator.clipboard?.writeText(m.body).then(() => toast("Copied")) });
      items.push({ label: "Forward", icon: "forward", onClick: () => useUI.setState({ forward: m.id }) });
      items.push({
        label: m.starred ? "Unstar" : "Star",
        icon: "star",
        onClick: async () => {
          await attempt(() => api(m.starred ? "DELETE" : "POST", `/messages/${m.id}/star`));
          useStore.getState().replaceMessage({ ...m, starred: !m.starred }, false);
        },
      });
      if (mine && ["text", "image", "video", "document", "gif"].includes(m.kind) && ageMin < 15) items.push({ label: "Edit", icon: "edit", onClick: () => actions.edit(m) });
      if (mine) items.push({ label: "Info", icon: "info", onClick: () => useUI.setState({ messageInfo: m.id }) });
      if (m.media) items.push({ label: "Download", icon: "download", onClick: () => window.open(mediaUrl(m.media!.id), "_blank") });
    }
    items.push({ label: "Delete for me", icon: "trash", danger: true, onClick: () => attempt(() => api("DELETE", `/messages/${m.id}?scope=me`)) });
    if (!m.deleted && ((mine && ageMin < 48 * 60) || (chat.kind === "group" && isAdmin)))
      items.push({ label: "Delete for everyone", icon: "trash", danger: true, onClick: () => attempt(() => api("DELETE", `/messages/${m.id}?scope=everyone`)) });
    actions.menu(e, items);
  };

  // group reactions
  const grouped = new Map<string, number>();
  m.reactions.forEach((r) => grouped.set(r.emoji, (grouped.get(r.emoji) || 0) + 1));

  let pressTimer: number | undefined;
  // Room reserved at the end of the text for the absolutely-positioned time/ticks.
  const spacer = 40 + (mine && !m.deleted ? 20 : 0) + (m.edited_at && !m.deleted ? 42 : 0) + (m.starred ? 14 : 0) + (m.expires_at ? 14 : 0);
  const inlineMeta = (m.kind === "text" || (m.deleted)) || (!!m.body && ["image", "video", "gif", "document", "audio"].includes(m.kind));

  return (
    <div className={"msg-row" + (mine ? " mine" : "") + (highlight ? " highlight" : "")} id={"msg-" + m.id}>
      <div
        className={"bubble kind-" + m.kind + (m.reactions.length ? " has-reactions" : "") + (inlineMeta ? "" : " meta-below")}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e);
        }}
        onDoubleClick={() => !m.deleted && actions.reply(m)}
        onTouchStart={(e) => {
          const t = e.touches[0];
          pressTimer = window.setTimeout(() => openMenu({ clientX: t.clientX, clientY: t.clientY }), 450);
        }}
        onTouchEnd={() => clearTimeout(pressTimer)}
        onTouchMove={() => clearTimeout(pressTimer)}
      >
        <button className="bubble-caret" onClick={(e) => openMenu(e)} aria-label="Message menu">
          ▾
        </button>
        {showName && !mine && chat.kind === "group" && (
          <div className="sender" style={{ color: colorFor(m.sender_id || "") }}>
            {name(m.sender_id)}
          </div>
        )}
        {m.forwarded && !m.deleted && (
          <div className="forwarded small muted">
            <Icon name="forward" size={14} /> Forwarded
          </div>
        )}
        {m.reply_to && <ReplyQuote r={m.reply_to} onClick={() => actions.jump(m.reply_to!.id)} />}
        <Body m={m} chat={chat} meId={meId} spacer={spacer} />
        <span className="meta">
          {m.expires_at && <Icon name="timer" size={12} />}
          {m.starred && <Icon name="star" size={12} />}
          {m.edited_at && !m.deleted && <span>Edited</span>}
          <span>{timeOf(m.created_at)}</span>
          {mine && !m.deleted && <Ticks m={m} />}
        </span>
        {m.failed && (
          <button className="link-btn danger small" onClick={() => useStore.getState().removeMessage(m.chat_id, m.id)}>
            Not sent: {m.meta?.error} · Dismiss
          </button>
        )}
        {grouped.size > 0 && (
          <button className="reactions" onClick={() => setReactOpen(true)}>
            {[...grouped.entries()].map(([e, n]) => (
              <span key={e}>
                {e}
                {n > 1 && <small>{n}</small>}
              </span>
            ))}
          </button>
        )}
        {reactOpen && (
          <div className="react-bar" onMouseDown={(e) => e.stopPropagation()}>
            {QUICK_REACTIONS.map((e) => (
              <button key={e} onClick={() => react(e)} className={m.reactions.some((r) => r.user_id === meId && r.emoji === e) ? "on" : ""}>
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
