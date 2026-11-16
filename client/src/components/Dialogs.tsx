import { useEffect, useState } from "react";
import { api, mediaUrl } from "../api";
import { useStore } from "../store";
import type { Message } from "../types";
import { useUI } from "../ui-state";
import { chatAvatarId, chatTitle, listTime, timeOf, userName } from "../util";
import { ContactPicker } from "./Sidebar";
import { attempt, Avatar, Icon, IconButton, Modal, toast } from "./ui";

// ---------- live location ----------
const watchers = new Map<string, number>();

export function startLive(messageId: string, untilIso: string) {
  if (!navigator.geolocation) return;
  const until = new Date(untilIso).getTime();
  let lastSent = 0;
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      if (Date.now() > until) return stopLive(messageId, false);
      if (Date.now() - lastSent < 10_000) return;
      lastSent = Date.now();
      api("POST", `/messages/${messageId}/location`, { lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(() => stopLive(messageId, false));
    },
    () => {},
    { enableHighAccuracy: true }
  );
  watchers.set(messageId, id);
}

export function stopLive(messageId: string, notifyServer = true) {
  const id = watchers.get(messageId);
  if (id !== undefined) navigator.geolocation.clearWatch(id);
  watchers.delete(messageId);
  if (notifyServer) attempt(() => api("POST", `/messages/${messageId}/stop-live`));
}

export function LocationDialog({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const [pos, setPos] = useState<GeolocationPosition | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!navigator.geolocation) return setErr("Location isn't available on this device");
    navigator.geolocation.getCurrentPosition(setPos, (e) => setErr(e.message || "Couldn't get your location"), { enableHighAccuracy: true, timeout: 15000 });
  }, []);
  const send = async (liveMinutes?: number) => {
    if (!pos) return;
    onClose();
    const meta: any = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
    if (liveMinutes) meta.live_minutes = liveMinutes;
    const sent = await useStore.getState().sendMessage(chatId, { kind: "location", meta });
    if (sent?.meta?.live_until) startLive(sent.id, sent.meta.live_until);
  };
  return (
    <Modal title="Send location" onClose={onClose}>
      {err && <div className="error">{err}</div>}
      {!pos && !err && <p className="muted">Finding your location…</p>}
      {pos && (
        <>
          <p className="muted small">
            {pos.coords.latitude.toFixed(5)}, {pos.coords.longitude.toFixed(5)} (±{Math.round(pos.coords.accuracy)} m)
          </p>
          <button className="list-btn" onClick={() => send()}>
            <Icon name="location" className="accent" /> Send your current location
          </button>
          <div className="section-label">Share live location</div>
          {[
            [15, "15 minutes"],
            [60, "1 hour"],
            [480, "8 hours"],
          ].map(([m, l]) => (
            <button key={m} className="list-btn" onClick={() => send(m as number)}>
              <Icon name="timer" className="accent" /> {l}
            </button>
          ))}
          <p className="muted small">Live location updates while Relay is open on this device.</p>
        </>
      )}
    </Modal>
  );
}

export function PollDialog({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const clean = opts.map((o) => o.trim()).filter(Boolean);
  return (
    <Modal title="Create poll" onClose={onClose}>
      <label className="field">
        <span>Question</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask question" autoFocus />
      </label>
      <div className="section-label">Options</div>
      {opts.map((o, i) => (
        <input
          key={i}
          className="full mb"
          value={o}
          placeholder={`Option ${i + 1}`}
          onChange={(e) => {
            const next = [...opts];
            next[i] = e.target.value;
            if (i === opts.length - 1 && e.target.value && opts.length < 12) next.push("");
            setOpts(next);
          }}
        />
      ))}
      <label className="row toggle-row">
        <div className="grow">Allow multiple answers</div>
        <input type="checkbox" className="switch" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
      </label>
      <button
        className="primary"
        disabled={!q.trim() || clean.length < 2}
        onClick={() => {
          useStore.getState().sendMessage(chatId, { kind: "poll", meta: { question: q.trim(), options: clean, multiple } });
          onClose();
        }}
      >
        Send
      </button>
    </Modal>
  );
}

export function ContactShareDialog({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const users = useStore((s) => s.users);
  const [sel, setSel] = useState<string[]>([]);
  return (
    <Modal title="Share contact" onClose={onClose}>
      <div className="picker-wrap">
        <ContactPicker selected={sel} onToggle={(id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))} />
      </div>
      <button
        className="primary"
        disabled={!sel.length}
        onClick={() => {
          for (const id of sel) {
            const u = users[id];
            if (u) useStore.getState().sendMessage(chatId, { kind: "contact", meta: { name: userName(u), phone: u.phone, user_id: u.id } });
          }
          onClose();
        }}
      >
        Send {sel.length || ""}
      </button>
    </Modal>
  );
}

export function ForwardDialog() {
  const messageId = useUI((s) => s.forward);
  const me = useStore((s) => s.me);
  const chats = useStore((s) => s.chats);
  const users = useStore((s) => s.users);
  const [sel, setSel] = useState<string[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => setSel([]), [messageId]);
  if (!messageId || !me) return null;
  const close = () => useUI.setState({ forward: null });
  const list = Object.values(chats)
    .filter((c) => chatTitle(c, me.id, users).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.last_message?.created_at || "").localeCompare(a.last_message?.created_at || ""));
  return (
    <Modal title="Forward message to" onClose={close}>
      <div className="search-box">
        <Icon name="search" size={18} />
        <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="picker-wrap scroll">
        {list.map((c) => (
          <label key={c.id} className="chat-row">
            <Avatar id={c.id} mediaId={chatAvatarId(c, me.id, users)} name={chatTitle(c, me.id, users)} size={40} group={c.kind === "group"} />
            <div className="grow chat-name">{chatTitle(c, me.id, users)}</div>
            <input
              type="checkbox"
              checked={sel.includes(c.id)}
              onChange={() => setSel((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : s.length >= 5 ? (toast("You can forward to up to 5 chats"), s) : [...s, c.id]))}
            />
          </label>
        ))}
      </div>
      <button
        className="primary"
        disabled={!sel.length}
        onClick={async () => {
          const r = await attempt(() => api<Message[]>("POST", `/messages/${messageId}/forward`, { chat_ids: sel }));
          if (r) {
            r.forEach((m) => useStore.getState().addMessage(m));
            toast(`Forwarded to ${sel.length} chat${sel.length > 1 ? "s" : ""}`);
            close();
          }
        }}
      >
        Forward
      </button>
    </Modal>
  );
}

export function MessageInfoDialog() {
  const id = useUI((s) => s.messageInfo);
  const users = useStore((s) => s.users);
  const [data, setData] = useState<{ user_id: string; delivered_at: string | null; read_at: string | null; played_at: string | null }[] | null>(null);
  useEffect(() => {
    setData(null);
    if (id) api<{ receipts: any[] }>("GET", `/messages/${id}/info`).then((r) => setData(r.receipts)).catch((e) => toast(e.message));
  }, [id]);
  if (!id) return null;
  const close = () => useUI.setState({ messageInfo: null });
  const fmt = (t: string | null) => (t ? `${listTime(t)} ${timeOf(t)}` : "—");
  const section = (title: string, icon: string, cls: string, rows: any[], key: "read_at" | "delivered_at" | "played_at") =>
    rows.length > 0 && (
      <>
        <div className="section-label">
          <Icon name={icon} size={16} className={cls} /> {title}
        </div>
        {rows.map((r) => (
          <div key={r.user_id + key} className="chat-row">
            <Avatar id={r.user_id} mediaId={users[r.user_id]?.avatar_id} name={userName(users[r.user_id])} size={36} />
            <div className="grow">{userName(users[r.user_id])}</div>
            <span className="small muted">{fmt(r[key])}</span>
          </div>
        ))}
      </>
    );
  return (
    <Modal title="Message info" onClose={close}>
      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {section("Played", "mic", "read", data.filter((r) => r.played_at), "played_at")}
          {section("Read by", "checks", "read", data.filter((r) => r.read_at && !r.played_at), "read_at")}
          {section("Delivered to", "checks", "muted", data.filter((r) => r.delivered_at && !r.read_at), "delivered_at")}
          {section("Not delivered yet", "check", "muted", data.filter((r) => !r.delivered_at), "delivered_at")}
          {!data.length && <p className="muted">No recipients.</p>}
        </>
      )}
    </Modal>
  );
}

export function Lightbox() {
  const lb = useUI((s) => s.lightbox);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useUI.setState({ lightbox: null });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!lb) return null;
  const url = mediaUrl(lb.mediaId);
  return (
    <div className="lightbox" onClick={() => useUI.setState({ lightbox: null })}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <a href={url} download target="_blank" rel="noreferrer" className="icon-btn" title="Download">
          <Icon name="download" />
        </a>
        <IconButton icon="close" title="Close" onClick={() => useUI.setState({ lightbox: null })} />
      </div>
      {lb.mime.startsWith("video") ? (
        <video src={url} controls autoPlay onClick={(e) => e.stopPropagation()} />
      ) : (
        <img src={url} alt="" onClick={(e) => e.stopPropagation()} />
      )}
    </div>
  );
}

export function JoinDialog({ code, onClose }: { code: string; onClose: () => void }) {
  const [info, setInfo] = useState<{ id: string; name: string; description: string; avatar_id: string | null; member_count: number } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api("GET", `/join/${code}`).then(setInfo).catch((e) => setErr(e.message));
  }, [code]);
  return (
    <Modal title="Group invite" onClose={onClose}>
      {err && <div className="error">{err}</div>}
      {info && (
        <div className="center">
          <Avatar id={info.id} mediaId={info.avatar_id} name={info.name} size={96} group />
          <h3>{info.name}</h3>
          <p className="muted">{info.member_count} members</p>
          {info.description && <p>{info.description}</p>}
          <button
            className="primary"
            onClick={async () => {
              const chat = await attempt(() => api("POST", `/join/${code}`));
              if (chat) {
                useStore.getState().upsertChat(chat);
                useStore.getState().openChat(chat.id);
                onClose();
              }
            }}
          >
            Join group
          </button>
        </div>
      )}
    </Modal>
  );
}
