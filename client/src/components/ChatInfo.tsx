import { useEffect, useState } from "react";
import { api, getServer, isNative, mediaUrl, upload } from "../api";
import { useStore } from "../store";
import type { Chat, Message } from "../types";
import { useUI } from "../ui-state";
import { chatAvatarId, chatTitle, disappearingLabel, listTime, messagePreview, otherMember, userName } from "../util";
import { FormattedText } from "./Message";
import { ContactPicker, useName } from "./Sidebar";
import { attempt, Avatar, Icon, IconButton, Modal, toast, Toggle, useMenu } from "./ui";

export function RightPanel({ chat }: { chat: Chat }) {
  const right = useUI((s) => s.right);
  if (right === "search") return <SearchPanel chat={chat} />;
  if (right === "info") return <ChatInfo chat={chat} />;
  return null;
}

function SearchPanel({ chat }: { chat: Chat }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Message[]>([]);
  const name = useName();
  useEffect(() => {
    if (q.trim().length < 2) return setRes([]);
    const t = setTimeout(() => api<Message[]>("GET", `/search?q=${encodeURIComponent(q.trim())}&chat_id=${chat.id}`).then(setRes).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q, chat.id]);
  return (
    <div className="side-panel">
      <div className="panel-head">
        <IconButton icon="close" title="Close" onClick={() => useUI.getState().setRight(null)} />
        <h2>Search messages</h2>
      </div>
      <div className="search-box">
        <Icon name="search" size={18} />
        <input autoFocus placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="scroll">
        {res.map((m) => (
          <button key={m.id} className="chat-row" onClick={() => useStore.setState({ jumpTo: m.id })}>
            <div className="grow min0">
              <div className="row-between small muted">
                <span>{name(m.sender_id)}</span>
                <span>{listTime(m.created_at)}</span>
              </div>
              <div className="chat-preview">{messagePreview(m)}</div>
            </div>
          </button>
        ))}
        {q.length >= 2 && !res.length && <div className="empty-list muted">No messages found</div>}
      </div>
    </div>
  );
}

function MediaTabs({ chat }: { chat: Chat }) {
  const [tab, setTab] = useState<"media" | "docs" | "links">("media");
  const [items, setItems] = useState<Message[]>([]);
  useEffect(() => {
    api<Message[]>("GET", `/chats/${chat.id}/media?kind=${tab}`).then(setItems).catch(() => {});
  }, [chat.id, tab]);
  return (
    <div className="info-card">
      <div className="chips">
        {(["media", "docs", "links"] as const).map((t) => (
          <button key={t} className={"chip" + (tab === t ? " active" : "")} onClick={() => setTab(t)}>
            {t === "media" ? "Media" : t === "docs" ? "Docs" : "Links"}
          </button>
        ))}
      </div>
      {tab === "media" ? (
        <div className="media-grid">
          {items.map((m) =>
            m.media ? (
              <button key={m.id} onClick={() => useUI.setState({ lightbox: { mediaId: m.media!.id, mime: m.media!.mime } })}>
                {m.kind === "video" ? <video src={mediaUrl(m.media.id)} preload="metadata" muted /> : <img src={mediaUrl(m.media.id)} alt="" loading="lazy" />}
              </button>
            ) : null
          )}
        </div>
      ) : (
        items.map((m) => (
          <button key={m.id} className="chat-row" onClick={() => useStore.setState({ jumpTo: m.id })}>
            <Icon name={tab === "docs" ? "file" : "link"} className="muted" />
            <div className="grow min0 chat-preview">{tab === "docs" ? m.media?.filename : <FormattedText text={m.body} />}</div>
          </button>
        ))
      )}
      {!items.length && <div className="muted small pad">Nothing here yet</div>}
    </div>
  );
}

function DisappearingPicker({ chat, disabled }: { chat: Chat; disabled: boolean }) {
  return (
    <label className="row info-row">
      <Icon name="timer" className="muted" />
      <div className="grow">
        <div>Disappearing messages</div>
        <div className="small muted">{disappearingLabel(chat.disappearing_seconds)}</div>
      </div>
      <select
        disabled={disabled}
        value={chat.disappearing_seconds}
        onChange={(e) => attempt(async () => useStore.getState().upsertChat(await api<Chat>("PATCH", `/chats/${chat.id}`, { disappearing_seconds: +e.target.value })))}
      >
        <option value={0}>Off</option>
        <option value={86400}>24 hours</option>
        <option value={604800}>7 days</option>
        <option value={7776000}>90 days</option>
      </select>
    </label>
  );
}

function MuteRow({ chat }: { chat: Chat }) {
  const muted = !!chat.muted_until && new Date(chat.muted_until) > new Date();
  const set = (mute_seconds: number) => attempt(async () => useStore.getState().upsertChat(await api<Chat>("PATCH", `/chats/${chat.id}/settings`, { mute_seconds })));
  return (
    <label className="row info-row">
      <Icon name="mute" className="muted" />
      <div className="grow">
        <div>Mute notifications</div>
        {muted && <div className="small muted">{new Date(chat.muted_until!).getFullYear() > 9000 ? "Always" : `Until ${listTime(chat.muted_until!)}`}</div>}
      </div>
      <select value={muted ? "on" : "0"} onChange={(e) => set(+e.target.value)}>
        <option value="0">Off</option>
        {muted && <option value="on" disabled>On</option>}
        <option value={8 * 3600}>8 hours</option>
        <option value={7 * 86400}>1 week</option>
        <option value={-1}>Always</option>
      </select>
    </label>
  );
}

function ChatInfo({ chat }: { chat: Chat }) {
  const me = useStore((s) => s.me)!;
  const users = useStore((s) => s.users);
  const chats = useStore((s) => s.chats);
  const close = () => useUI.getState().setRight(null);
  const title = chatTitle(chat, me.id, users);

  if (chat.kind === "direct") {
    const o = otherMember(chat, me.id);
    const u = o ? users[o.id] || o : null;
    const common = u ? Object.values(chats).filter((c) => c.kind === "group" && c.members.some((m) => m.user.id === u.id)) : [];
    return (
      <div className="side-panel">
        <div className="panel-head">
          <IconButton icon="close" title="Close" onClick={close} />
          <h2>Contact info</h2>
        </div>
        <div className="scroll">
          <div className="info-hero">
            <Avatar id={u?.id || me.id} mediaId={chatAvatarId(chat, me.id, users)} name={title} size={160} />
            <h2>{title}</h2>
            <div className="muted">{u?.phone || me.phone}</div>
            {u && !u.contact_name && (
              <button className="link-btn" onClick={() => {
                const name = prompt("Save contact as", u.name);
                if (name !== null)
                  attempt(async () => {
                    const saved = await api("POST", "/contacts", { phone: u.phone, name });
                    useStore.getState().mergeUsers([saved]);
                  }, "Contact saved");
              }}>
                Add to contacts
              </button>
            )}
          </div>
          {u?.about && (
            <div className="info-card">
              <div className="small muted">About</div>
              <div>{u.about}</div>
            </div>
          )}
          <MediaTabs chat={chat} />
          <div className="info-card">
            <MuteRow chat={chat} />
            <DisappearingPicker chat={chat} disabled={false} />
          </div>
          {common.length > 0 && (
            <div className="info-card">
              <div className="small muted">{common.length} groups in common</div>
              {common.map((g) => (
                <button key={g.id} className="chat-row" onClick={() => useStore.getState().openChat(g.id)}>
                  <Avatar id={g.id} mediaId={g.avatar_id} name={g.name} size={40} group />
                  <div className="chat-name">{g.name}</div>
                </button>
              ))}
            </div>
          )}
          {u && (
            <div className="info-card">
              <button
                className="list-btn danger"
                onClick={() =>
                  attempt(async () => {
                    await api(u.blocked_by_me ? "DELETE" : "POST", `/blocks/${u.id}`);
                    useStore.getState().mergeUsers([{ ...u, blocked_by_me: !u.blocked_by_me }]);
                    useStore.getState().refreshChat(chat.id);
                  }, u.blocked_by_me ? "Unblocked" : "Blocked")
                }
              >
                <Icon name="block" /> {u.blocked_by_me ? "Unblock" : "Block"} {title}
              </button>
              <button className="list-btn danger" onClick={() => confirm("Delete this chat?") && attempt(() => api("DELETE", `/chats/${chat.id}`))}>
                <Icon name="trash" /> Delete chat
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
  return <GroupInfo chat={chat} />;
}

function GroupInfo({ chat }: { chat: Chat }) {
  const me = useStore((s) => s.me)!;
  const users = useStore((s) => s.users);
  const menu = useMenu();
  const [adding, setAdding] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [editName, setEditName] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState<string | null>(null);
  const isAdmin = chat.my_role === "admin" || chat.my_role === "owner";
  const canEdit = isAdmin || !chat.admins_only_edit;
  const patch = (body: object) => attempt(async () => useStore.getState().upsertChat(await api<Chat>("PATCH", `/chats/${chat.id}`, body)));
  const webBase = isNative ? `${getServer()}/` : `${location.origin}${import.meta.env.BASE_URL}`;
  const inviteLink = chat.invite_code ? `${webBase}join/${chat.invite_code}` : "";

  const members = [...chat.members].sort((a, b) => {
    if (a.user.id === me.id) return -1;
    if (b.user.id === me.id) return 1;
    const r = (x: string) => (x === "owner" ? 0 : x === "admin" ? 1 : 2);
    return r(a.role) - r(b.role) || userName(users[a.user.id] || a.user).localeCompare(userName(users[b.user.id] || b.user));
  });

  return (
    <div className="side-panel">
      <div className="panel-head">
        <IconButton icon="close" title="Close" onClick={() => useUI.getState().setRight(null)} />
        <h2>Group info</h2>
      </div>
      <div className="scroll">
        <div className="info-hero">
          <button
            className="avatar-pick"
            disabled={!canEdit}
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "image/*";
              input.onchange = async () => {
                const f = input.files?.[0];
                if (!f) return;
                const m = await attempt(() => upload(f, f.name));
                if (m) patch({ avatar_id: m.id });
              };
              input.click();
            }}
          >
            <Avatar id={chat.id} mediaId={chat.avatar_id} name={chat.name} size={160} group />
            {canEdit && (
              <span className="avatar-pick-badge">
                <Icon name="camera" size={20} />
              </span>
            )}
          </button>
          {editName !== null ? (
            <form
              className="row gap"
              onSubmit={(e) => {
                e.preventDefault();
                patch({ name: editName });
                setEditName(null);
              }}
            >
              <input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus maxLength={100} />
              <button className="primary">Save</button>
            </form>
          ) : (
            <h2 onClick={() => canEdit && setEditName(chat.name)} className={canEdit ? "editable" : ""}>
              {chat.name} {canEdit && <Icon name="edit" size={16} className="muted" />}
            </h2>
          )}
          <div className="muted">Group · {chat.members.length} members</div>
        </div>

        <div className="info-card">
          {editDesc !== null ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                patch({ description: editDesc });
                setEditDesc(null);
              }}
            >
              <textarea className="full" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} autoFocus rows={3} maxLength={2048} />
              <button className="primary">Save</button>
            </form>
          ) : (
            <div onClick={() => canEdit && setEditDesc(chat.description)} className={canEdit ? "editable" : ""}>
              {chat.description ? <FormattedText text={chat.description} /> : <span className="accent">{canEdit ? "Add group description" : "No description"}</span>}
            </div>
          )}
          <div className="small muted">Created {listTime(chat.created_at)}</div>
        </div>

        <MediaTabs chat={chat} />

        <div className="info-card">
          <MuteRow chat={chat} />
          <DisappearingPicker chat={chat} disabled={!canEdit} />
          {isAdmin && (
            <>
              <Toggle label="Only admins can send messages" checked={chat.admins_only_send} onChange={(v) => patch({ admins_only_send: v })} />
              <Toggle label="Only admins can edit group info" checked={chat.admins_only_edit} onChange={(v) => patch({ admins_only_edit: v })} />
            </>
          )}
        </div>

        <div className="info-card">
          <div className="small muted">{chat.members.length} members</div>
          {isAdmin && (
            <button className="chat-row" onClick={() => setAdding(true)}>
              <div className="round-icon">
                <Icon name="plus" />
              </div>
              <div className="chat-name">Add members</div>
            </button>
          )}
          {isAdmin && inviteLink && (
            <button
              className="chat-row"
              onClick={(e) =>
                menu.open(e, [
                  { label: "Copy link", icon: "copy", onClick: () => navigator.clipboard?.writeText(inviteLink).then(() => toast("Link copied")) },
                  {
                    label: "Reset link",
                    icon: "link",
                    danger: true,
                    onClick: () =>
                      attempt(async () => {
                        await api("POST", `/chats/${chat.id}/invite`);
                        await useStore.getState().refreshChat(chat.id);
                      }, "Invite link reset"),
                  },
                ])
              }
            >
              <div className="round-icon">
                <Icon name="link" />
              </div>
              <div className="grow min0">
                <div className="chat-name">Invite via link</div>
                <div className="chat-preview small">{inviteLink}</div>
              </div>
            </button>
          )}
          {members.map((mem) => {
            const u = users[mem.user.id] || mem.user;
            const isMe = u.id === me.id;
            return (
              <button
                key={u.id}
                className="chat-row"
                onClick={(e) => {
                  if (isMe) return;
                  const items = [
                    {
                      label: `Message ${userName(u)}`,
                      icon: "chat",
                      onClick: () =>
                        attempt(async () => {
                          const c = await api<Chat>("POST", "/chats/direct", { user_id: u.id });
                          useStore.getState().upsertChat(c);
                          useStore.getState().openChat(c.id);
                        }),
                    },
                  ];
                  if (isAdmin && mem.role !== "owner") {
                    items.push({
                      label: mem.role === "admin" ? "Dismiss as admin" : "Make group admin",
                      icon: "settings",
                      onClick: () => attempt(() => api("PATCH", `/chats/${chat.id}/members/${u.id}`, { role: mem.role === "admin" ? "member" : "admin" })),
                    });
                    items.push({
                      label: `Remove ${userName(u)}`,
                      icon: "trash",
                      onClick: () => confirm(`Remove ${userName(u)} from "${chat.name}"?`) && attempt(() => api("DELETE", `/chats/${chat.id}/members/${u.id}`)),
                    } as any);
                  }
                  menu.open(e, items);
                }}
              >
                <Avatar id={u.id} mediaId={u.avatar_id} name={userName(u)} size={40} />
                <div className="grow min0">
                  <div className="chat-name">{isMe ? "You" : userName(u)}</div>
                  <div className="chat-preview small">{u.about || u.phone}</div>
                </div>
                {mem.role !== "member" && <span className="role-tag">{mem.role === "owner" ? "Group admin" : "Admin"}</span>}
              </button>
            );
          })}
        </div>

        <div className="info-card">
          <button
            className="list-btn danger"
            onClick={() => confirm(`Exit "${chat.name}"?`) && attempt(() => api("POST", `/chats/${chat.id}/leave`))}
          >
            <Icon name="logout" /> Exit group
          </button>
        </div>
      </div>
      {adding && (
        <Modal title="Add members" onClose={() => setAdding(false)}>
          <div className="picker-wrap">
            <ContactPicker selected={sel} exclude={chat.members.map((m) => m.user.id)} onToggle={(id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))} />
          </div>
          <button
            className="primary"
            disabled={!sel.length}
            onClick={async () => {
              const r = await attempt(() => api<{ added: string[]; skipped: string[] }>("POST", `/chats/${chat.id}/members`, { user_ids: sel }));
              if (r?.skipped.length) toast(`${r.skipped.length} couldn't be added due to their privacy settings. Send them the invite link.`);
              setSel([]);
              setAdding(false);
            }}
          >
            Add {sel.length || ""}
          </button>
        </Modal>
      )}
      {menu.node}
    </div>
  );
}
