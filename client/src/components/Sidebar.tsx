import { useEffect, useMemo, useState } from "react";
import { api, upload } from "../api";
import { calls } from "../call";
import { useStore } from "../store";
import type { BroadcastList, CallLogEntry, Chat, Message, User } from "../types";
import { useUI } from "../ui-state";
import { chatAvatarId, chatTitle, listTime, messagePreview, systemText, userName } from "../util";
import { attempt, Avatar, Icon, IconButton, toast, useMenu } from "./ui";

export function Ticks({ m }: { m: Message }) {
  if (m.failed) return <span className="tick failed" title={m.meta?.error || "Not sent"}>!</span>;
  if (m.pending) return <Icon name="clock" size={14} className="tick" />;
  if (m.status === "sent") return <Icon name="check" size={16} className="tick" />;
  return <Icon name="checks" size={16} className={"tick" + (m.status === "read" ? " read" : "")} />;
}

export function useName() {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me);
  return (id: string | null | undefined) => (id ? (id === me?.id ? "You" : userName(users[id])) : "Unknown");
}

function PanelHeader({ title, onBack, children }: { title: string; onBack?: () => void; children?: React.ReactNode }) {
  return (
    <div className="panel-head">
      {onBack && <IconButton icon="back" title="Back" onClick={onBack} />}
      <h2>{title}</h2>
      <div className="grow" />
      {children}
    </div>
  );
}

export function Sidebar() {
  const left = useUI((s) => s.left);
  switch (left) {
    case "new-chat":
      return <NewChat />;
    case "new-group":
      return <NewGroup />;
    case "calls":
      return <CallsPanel />;
    case "starred":
      return <StarredPanel />;
    case "broadcasts":
      return <BroadcastsPanel />;
    case "archived":
      return <ChatList archived />;
    default:
      return <ChatList />;
  }
}

function ChatList({ archived = false }: { archived?: boolean }) {
  const me = useStore((s) => s.me)!;
  const chats = useStore((s) => s.chats);
  const users = useStore((s) => s.users);
  const connected = useStore((s) => s.connected);
  const setLeft = useUI((s) => s.setLeft);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "unread" | "groups">("all");
  const [results, setResults] = useState<Message[] | null>(null);
  const menu = useMenu();

  useEffect(() => {
    if (q.trim().length < 2) return setResults(null);
    const t = setTimeout(() => api<Message[]>("GET", `/search?q=${encodeURIComponent(q.trim())}`).then(setResults).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return Object.values(chats)
      .filter((c) => c.archived === archived)
      .filter((c) => c.kind === "group" || c.last_message) // empty / deleted direct chats stay hidden
      .filter((c) => filter === "all" || (filter === "unread" ? c.unread > 0 : c.kind === "group"))
      .filter((c) => !term || chatTitle(c, me.id, users).toLowerCase().includes(term))
      .sort((a, b) => {
        if (!archived && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const ta = a.last_message?.created_at || a.created_at;
        const tb = b.last_message?.created_at || b.created_at;
        return tb.localeCompare(ta);
      });
  }, [chats, users, q, filter, archived, me.id]);

  const archivedCount = Object.values(chats).filter((c) => c.archived).length;
  const archivedUnread = Object.values(chats).filter((c) => c.archived && c.unread > 0).length;

  return (
    <div className="panel">
      {archived ? (
        <PanelHeader title="Archived" onBack={() => setLeft("chats")} />
      ) : (
        <div className="panel-head list-head">
          <h1 className="title">Chats</h1>
          <div className="grow" />
          <IconButton icon="plus" title="New chat" className="accent-btn" onClick={() => setLeft("new-chat")} />
          <IconButton
            icon="more"
            title="Menu"
            onClick={(e) =>
              menu.open(e, [
                { label: "New group", icon: "group", onClick: () => setLeft("new-group") },
                { label: "Broadcast lists", icon: "broadcast", onClick: () => setLeft("broadcasts") },
                { label: "Starred messages", icon: "star", onClick: () => setLeft("starred") },
                { label: "Settings", icon: "settings", onClick: () => setLeft("settings") },
                { label: "Log out", icon: "logout", onClick: () => useStore.getState().signOut() },
              ])
            }
          />
        </div>
      )}
      {!connected && <div className="banner">Connecting…</div>}
      <div className="search-box">
        <Icon name="search" size={18} />
        <input placeholder="Search or start a new chat" value={q} onChange={(e) => setQ(e.target.value)} />
        {q && <IconButton icon="close" title="Clear" size={18} onClick={() => setQ("")} />}
      </div>
      {!archived && (
        <div className="chips">
          {(["all", "unread", "groups"] as const).map((f) => (
            <button key={f} className={"chip" + (filter === f ? " active" : "")} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      )}
      <div className="scroll">
        {!archived && archivedCount > 0 && !q && (
          <button className="chat-row archived-row" onClick={() => setLeft("archived")}>
            <div className="archived-icon">
              <Icon name="archive" size={20} />
            </div>
            <div className="grow">Archived</div>
            {archivedUnread > 0 && <span className="muted small">{archivedUnread}</span>}
          </button>
        )}
        {list.map((c) => (
          <ChatRow key={c.id} chat={c} />
        ))}
        {results && results.length > 0 && (
          <>
            <div className="section-label">Messages</div>
            {results.map((m) => (
              <SearchResult key={m.id} m={m} />
            ))}
          </>
        )}
        {list.length === 0 && !results?.length && (
          <div className="empty-list muted">
            {q ? "No chats found" : archived ? "No archived chats" : "No chats yet. Tap the chat icon to start one."}
          </div>
        )}
      </div>
      {menu.node}
    </div>
  );
}

function SearchResult({ m }: { m: Message }) {
  const me = useStore((s) => s.me)!;
  const chats = useStore((s) => s.chats);
  const users = useStore((s) => s.users);
  const chat = chats[m.chat_id];
  if (!chat) return null;
  return (
    <button className="chat-row" onClick={() => useStore.getState().openChat(chat.id, m.id)}>
      <div className="grow min0">
        <div className="row-between">
          <span className="chat-name">{chatTitle(chat, me.id, users)}</span>
          <span className="muted small">{listTime(m.created_at)}</span>
        </div>
        <div className="chat-preview">{messagePreview(m)}</div>
      </div>
    </button>
  );
}

function ChatRow({ chat }: { chat: Chat }) {
  const me = useStore((s) => s.me)!;
  const users = useStore((s) => s.users);
  const active = useStore((s) => s.activeChat === chat.id);
  const typing = useStore((s) => s.typing[chat.id]);
  const name = useName();
  const menu = useMenu();
  const title = chatTitle(chat, me.id, users);
  const m = chat.last_message;
  const muted = chat.muted_until && new Date(chat.muted_until) > new Date();
  const typers = Object.entries(typing || {}).filter(([u]) => u !== me.id);

  let preview: React.ReactNode = "";
  if (typers.length) {
    const what = typers[0][1].state === "recording" ? "recording audio…" : "typing…";
    preview = <span className="accent">{chat.kind === "group" ? `${name(typers[0][0])} is ${what}` : what}</span>;
  } else if (m) {
    const mine = m.sender_id === me.id;
    const text = m.kind === "system" ? systemText(m, name) : messagePreview(m);
    preview = (
      <>
        {mine && m.kind !== "system" && !m.deleted && <Ticks m={m} />}
        {chat.kind === "group" && !mine && m.kind !== "system" && <span>{name(m.sender_id)}: </span>}
        <span className={m.deleted ? "italic" : ""}>{text}</span>
      </>
    );
  }

  const settings = (body: object) =>
    attempt(async () => useStore.getState().upsertChat(await api<Chat>("PATCH", `/chats/${chat.id}/settings`, body)));

  return (
    <>
      <button
        className={"chat-row" + (active ? " active" : "")}
        onClick={() => useStore.getState().openChat(chat.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          menu.open(e, [
            { label: chat.archived ? "Unarchive chat" : "Archive chat", icon: "archive", onClick: () => settings({ archived: !chat.archived }) },
            { label: muted ? "Unmute notifications" : "Mute notifications", icon: "mute", onClick: () => settings({ mute_seconds: muted ? 0 : -1 }) },
            { label: chat.pinned ? "Unpin chat" : "Pin chat", icon: "pin", onClick: () => settings({ pinned: !chat.pinned }) },
            { label: "Mark as read", icon: "checks", onClick: () => useStore.getState().markRead(chat.id) },
          ]);
        }}
      >
        <Avatar id={chat.kind === "group" ? chat.id : chat.members.find((x) => x.user.id !== me.id)?.user.id || chat.id} mediaId={chatAvatarId(chat, me.id, users)} name={title} group={chat.kind === "group"} />
        <div className="grow min0">
          <div className="row-between">
            <span className="chat-name">{title}</span>
            <span className={"small " + (chat.unread ? "accent" : "muted")}>{m ? listTime(m.created_at) : ""}</span>
          </div>
          <div className="row-between">
            <span className="chat-preview">{preview}</span>
            <span className="row-icons">
              {muted && <Icon name="mute" size={16} className="muted" />}
              {chat.pinned && <Icon name="pin" size={16} className="muted" />}
              {chat.unread > 0 && <span className={"badge" + (muted ? " muted-badge" : "")}>{chat.unread}</span>}
            </span>
          </div>
        </div>
      </button>
      {menu.node}
    </>
  );
}

// ---------- new chat ----------

function useContacts() {
  const [contacts, setContacts] = useState<User[]>([]);
  const reload = () =>
    api<User[]>("GET", "/contacts")
      .then((c) => {
        setContacts(c);
        useStore.getState().mergeUsers(c);
      })
      .catch(() => {});
  useEffect(() => {
    reload();
  }, []);
  return { contacts, reload };
}

async function openDirect(userId: string) {
  const chat = await api<Chat>("POST", "/chats/direct", { user_id: userId });
  useStore.getState().upsertChat(chat);
  useStore.getState().openChat(chat.id);
  useUI.getState().setLeft("chats");
}

function AddContactForm({ onAdded }: { onAdded: (u: User) => void }) {
  const [phone, setPhone] = useState("+");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="add-contact"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const u = await attempt(() => api<User>("POST", "/contacts", { phone, name }));
        setBusy(false);
        if (u) {
          setPhone("+");
          setName("");
          onAdded(u);
        }
      }}
    >
      <input placeholder="Phone number (+62…)" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
      <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="primary" disabled={busy || phone.replace(/\D/g, "").length < 8}>
        Add contact
      </button>
    </form>
  );
}

function NewChat() {
  const setLeft = useUI((s) => s.setLeft);
  const me = useStore((s) => s.me)!;
  const { contacts, reload } = useContacts();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const filtered = contacts.filter((c) => (userName(c) + c.phone).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="panel">
      <PanelHeader title="New chat" onBack={() => setLeft("chats")} />
      <div className="search-box">
        <Icon name="search" size={18} />
        <input placeholder="Search name or number" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="scroll">
        <button className="chat-row" onClick={() => setLeft("new-group")}>
          <div className="round-icon">
            <Icon name="group" />
          </div>
          <div className="chat-name">New group</div>
        </button>
        <button className="chat-row" onClick={() => setAdding(!adding)}>
          <div className="round-icon">
            <Icon name="person" />
          </div>
          <div className="chat-name">New contact</div>
        </button>
        {adding && (
          <AddContactForm
            onAdded={(u) => {
              setAdding(false);
              reload();
              toast(`${userName(u)} added`);
            }}
          />
        )}
        <button className="chat-row" onClick={() => attempt(() => openDirect(me.id))}>
          <Avatar id={me.id} mediaId={me.avatar_id} name={me.name} />
          <div className="grow min0">
            <div className="chat-name">{me.name} (You)</div>
            <div className="chat-preview">Message yourself</div>
          </div>
        </button>
        <div className="section-label">Contacts on Relay</div>
        {filtered.map((u) => (
          <button key={u.id} className="chat-row" onClick={() => attempt(() => openDirect(u.id))}>
            <Avatar id={u.id} mediaId={u.avatar_id} name={userName(u)} />
            <div className="grow min0">
              <div className="chat-name">{userName(u)}</div>
              <div className="chat-preview">{u.about || u.phone}</div>
            </div>
          </button>
        ))}
        {!filtered.length && <div className="empty-list muted">No contacts yet. Add one by phone number.</div>}
      </div>
    </div>
  );
}

export function ContactPicker({ selected, onToggle, exclude = [] }: { selected: string[]; onToggle: (id: string) => void; exclude?: string[] }) {
  const { contacts } = useContacts();
  const [q, setQ] = useState("");
  const list = contacts.filter((c) => !exclude.includes(c.id) && (userName(c) + c.phone).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="search-box">
        <Icon name="search" size={18} />
        <input placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="scroll">
        {list.map((u) => (
          <label key={u.id} className="chat-row">
            <Avatar id={u.id} mediaId={u.avatar_id} name={userName(u)} size={40} />
            <div className="grow min0">
              <div className="chat-name">{userName(u)}</div>
              <div className="chat-preview">{u.about || u.phone}</div>
            </div>
            <input type="checkbox" checked={selected.includes(u.id)} onChange={() => onToggle(u.id)} />
          </label>
        ))}
        {!list.length && <div className="empty-list muted">No contacts to show</div>}
      </div>
    </>
  );
}

function NewGroup() {
  const setLeft = useUI((s) => s.setLeft);
  const [step, setStep] = useState<1 | 2>(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const create = async () => {
    setBusy(true);
    const r = await attempt(() => api<{ chat: Chat; skipped: string[] }>("POST", "/chats/group", { name, member_ids: selected, avatar_id: avatar || undefined }));
    setBusy(false);
    if (r) {
      if (r.skipped.length) toast(`${r.skipped.length} people couldn't be added because of their privacy settings. Share the invite link instead.`);
      useStore.getState().upsertChat(r.chat);
      useStore.getState().openChat(r.chat.id);
      setLeft("chats");
    }
  };

  return (
    <div className="panel">
      <PanelHeader title={step === 1 ? "Add group members" : "New group"} onBack={() => (step === 2 ? setStep(1) : setLeft("new-chat"))} />
      {step === 1 ? (
        <>
          <ContactPicker selected={selected} onToggle={toggle} />
          <div className="panel-foot">
            <button className="primary" onClick={() => setStep(2)}>
              Next {selected.length ? `(${selected.length})` : ""}
            </button>
          </div>
        </>
      ) : (
        <div className="scroll pad">
          <button
            className="avatar-pick"
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "image/*";
              input.onchange = async () => {
                const f = input.files?.[0];
                if (f) {
                  const m = await attempt(() => upload(f, f.name));
                  if (m) setAvatar(m.id);
                }
              };
              input.click();
            }}
          >
            <Avatar id="new-group" mediaId={avatar} name={name || "Group"} size={96} group />
            <span className="avatar-pick-badge">
              <Icon name="camera" size={18} />
            </span>
          </button>
          <label className="field">
            <span>Group name</span>
            <input value={name} onChange={(e) => setName(e.target.value.slice(0, 100))} autoFocus />
          </label>
          <button className="primary" disabled={busy || !name.trim()} onClick={create}>
            Create group
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- calls ----------

function CallsPanel() {
  const setLeft = useUI((s) => s.setLeft);
  const me = useStore((s) => s.me)!;
  const chats = useStore((s) => s.chats);
  const users = useStore((s) => s.users);
  const [log, setLog] = useState<CallLogEntry[]>([]);
  useEffect(() => {
    api<CallLogEntry[]>("GET", "/calls").then(setLog).catch(() => {});
  }, []);
  return (
    <div className="panel">
      <PanelHeader title="Calls" onBack={() => setLeft("chats")} />
      <div className="scroll">
        {log.map((c) => {
          const chat = chats[c.chat_id];
          if (!chat) return null;
          const title = chatTitle(chat, me.id, users);
          const outgoing = c.caller_id === me.id;
          const missed = !outgoing && (c.status === "missed" || c.status === "rejected");
          const dur = c.answered_at && c.ended_at ? Math.round((+new Date(c.ended_at) - +new Date(c.answered_at)) / 1000) : 0;
          return (
            <div key={c.id} className="chat-row">
              <Avatar id={chat.id} mediaId={chatAvatarId(chat, me.id, users)} name={title} group={chat.kind === "group"} />
              <div className="grow min0">
                <div className={"chat-name" + (missed ? " danger" : "")}>{title}</div>
                <div className="chat-preview">
                  <Icon name={outgoing ? "outgoing" : "incoming"} size={14} className={missed ? "danger" : "accent"} /> {listTime(c.started_at)}
                  {dur > 0 && ` · ${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`}
                </div>
              </div>
              <IconButton icon={c.video ? "video" : "phone"} title="Call back" onClick={() => calls.start(chat.id, c.video)} />
            </div>
          );
        })}
        {!log.length && <div className="empty-list muted">No calls yet</div>}
      </div>
    </div>
  );
}

// ---------- starred ----------

function StarredPanel() {
  const setLeft = useUI((s) => s.setLeft);
  const me = useStore((s) => s.me)!;
  const chats = useStore((s) => s.chats);
  const users = useStore((s) => s.users);
  const name = useName();
  const [list, setList] = useState<Message[]>([]);
  useEffect(() => {
    api<Message[]>("GET", "/starred").then(setList).catch(() => {});
  }, []);
  return (
    <div className="panel">
      <PanelHeader title="Starred messages" onBack={() => setLeft("chats")} />
      <div className="scroll">
        {list.map((m) => {
          const chat = chats[m.chat_id];
          return (
            <button key={m.id} className="chat-row" onClick={() => chat && useStore.getState().openChat(chat.id, m.id)}>
              <div className="grow min0">
                <div className="row-between">
                  <span className="chat-name small">
                    {name(m.sender_id)} {chat && `▸ ${chatTitle(chat, me.id, users)}`}
                  </span>
                  <span className="muted small">{listTime(m.created_at)}</span>
                </div>
                <div className="chat-preview">
                  <Icon name="star" size={14} className="muted" /> {messagePreview(m)}
                </div>
              </div>
            </button>
          );
        })}
        {!list.length && <div className="empty-list muted">Tap and hold on any message to star it, so you can easily find it later.</div>}
      </div>
    </div>
  );
}

// ---------- broadcasts ----------

function BroadcastsPanel() {
  const setLeft = useUI((s) => s.setLeft);
  const users = useStore((s) => s.users);
  const [lists, setLists] = useState<BroadcastList[]>([]);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [open, setOpen] = useState<BroadcastList | null>(null);
  const [text, setText] = useState("");
  const reload = () => api<BroadcastList[]>("GET", "/broadcasts").then(setLists).catch(() => {});
  useEffect(() => {
    reload();
  }, []);

  if (open)
    return (
      <div className="panel">
        <PanelHeader title={open.name} onBack={() => setOpen(null)}>
          <IconButton
            icon="trash"
            title="Delete list"
            onClick={async () => {
              await attempt(() => api("DELETE", `/broadcasts/${open.id}`));
              setOpen(null);
              reload();
            }}
          />
        </PanelHeader>
        <div className="scroll pad">
          <p className="muted small">
            Messages go out as individual chats. Only contacts who have saved your number will receive them.
          </p>
          <p className="small">{open.member_ids.map((id) => userName(users[id])).join(", ")}</p>
        </div>
        <form
          className="composer"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            const r = await attempt(() => api<Message[]>("POST", `/broadcasts/${open.id}/send`, { kind: "text", body: text }));
            if (r) {
              toast(`Sent to ${r.length} of ${open.member_ids.length}`);
              setText("");
            }
          }}
        >
          <input className="composer-input" placeholder="Broadcast message" value={text} onChange={(e) => setText(e.target.value)} />
          <IconButton icon="send" title="Send" className="send-btn" onClick={() => {}} />
        </form>
      </div>
    );

  if (creating)
    return (
      <div className="panel">
        <PanelHeader title="New broadcast" onBack={() => setCreating(false)} />
        <div className="pad">
          <input className="full" placeholder="List name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <ContactPicker selected={selected} onToggle={(id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))} />
        <div className="panel-foot">
          <button
            className="primary"
            disabled={selected.length < 2}
            onClick={async () => {
              const r = await attempt(() => api<BroadcastList>("POST", "/broadcasts", { name, member_ids: selected }));
              if (r) {
                setCreating(false);
                setSelected([]);
                setName("");
                reload();
              }
            }}
          >
            Create ({selected.length})
          </button>
        </div>
      </div>
    );

  return (
    <div className="panel">
      <PanelHeader title="Broadcast lists" onBack={() => setLeft("chats")} />
      <div className="scroll">
        <button className="chat-row" onClick={() => setCreating(true)}>
          <div className="round-icon">
            <Icon name="plus" />
          </div>
          <div className="chat-name">New list</div>
        </button>
        {lists.map((l) => (
          <button key={l.id} className="chat-row" onClick={() => setOpen(l)}>
            <div className="round-icon muted-bg">
              <Icon name="broadcast" />
            </div>
            <div className="grow min0">
              <div className="chat-name">{l.name}</div>
              <div className="chat-preview">{l.member_ids.length} recipients</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
