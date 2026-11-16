import { useEffect, useState } from "react";
import { getToken } from "./api";
import { calls } from "./call";
import { useStore } from "./store";
import { useUI } from "./ui-state";
import { Login } from "./components/Auth";
import { CallOverlay } from "./components/Call";
import { ChatView } from "./components/Chat";
import { RightPanel } from "./components/ChatInfo";
import { ForwardDialog, JoinDialog, Lightbox, MessageInfoDialog } from "./components/Dialogs";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { Avatar, Icon, Toasts } from "./components/ui";
import { InstallGate } from "./components/Install";
import { shouldGate, takePendingJoin } from "./install";
import type { LeftView } from "./ui-state";

function joinCodeFromUrl(): string | null {
  const m = location.pathname.match(/\/join\/([A-Za-z0-9]+)/) || location.hash.match(/join\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

const GATED = shouldGate();

export function App() {
  if (GATED) return <InstallGate />;
  return <RelayApp />;
}

function RelayApp() {
  const me = useStore((s) => s.me);
  const [booting, setBooting] = useState(!!getToken());
  const [joinCode, setJoinCode] = useState<string | null>(() => joinCodeFromUrl() || takePendingJoin());

  useEffect(() => {
    if (!getToken()) return;
    useStore
      .getState()
      .boot()
      .catch(() => {})
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (me) calls.meId = me.id;
  }, [me?.id]);

  // Unread count in the tab title.
  const unread = useStore((s) => Object.values(s.chats).reduce((n, c) => n + (c.unread > 0 && !(c.muted_until && new Date(c.muted_until) > new Date()) ? 1 : 0), 0));
  useEffect(() => {
    document.title = unread ? `(${unread}) Relay` : "Relay";
  }, [unread]);

  if (booting) return <div className="splash"><img src={import.meta.env.BASE_URL + "icon.svg"} alt="" width={72} /></div>;
  if (!me) return (<><Login /><Toasts /></>);

  return (
    <>
      <Main />
      {joinCode && (
        <JoinDialog
          code={joinCode}
          onClose={() => {
            setJoinCode(null);
            history.replaceState(null, "", import.meta.env.BASE_URL);
          }}
        />
      )}
      <ForwardDialog />
      <MessageInfoDialog />
      <Lightbox />
      <CallOverlay />
      <Toasts />
    </>
  );
}

function NavRail() {
  const me = useStore((s) => s.me)!;
  const left = useUI((s) => s.left);
  const setLeft = useUI((s) => s.setLeft);
  const unread = useStore((s) => Object.values(s.chats).filter((c) => c.unread > 0 && !c.archived).length);
  const items: { view: LeftView; icon: string; label: string; badge?: number }[] = [
    { view: "chats", icon: "chat", label: "Chats", badge: unread },
    { view: "calls", icon: "phone", label: "Calls" },
    { view: "starred", icon: "star", label: "Starred" },
    { view: "broadcasts", icon: "broadcast", label: "Broadcasts" },
  ];
  const isActive = (v: LeftView) => (v === "chats" ? ["chats", "archived", "new-chat", "new-group"].includes(left) : left === v);
  return (
    <nav className="rail" aria-label="Main">
      <img className="rail-logo" src={import.meta.env.BASE_URL + "icon.svg"} alt="Relay" width={36} height={36} />
      {items.map((it) => (
        <button key={it.view} className={"rail-btn" + (isActive(it.view) ? " active" : "")} onClick={() => setLeft(it.view)} title={it.label}>
          <span className="rail-icon">
            <Icon name={it.icon} size={22} />
            {!!it.badge && <span className="rail-badge">{it.badge}</span>}
          </span>
          <span className="rail-label">{it.label}</span>
        </button>
      ))}
      <div className="grow rail-spacer" />
      <button className={"rail-btn" + (left.startsWith("settings") ? " active" : "")} onClick={() => setLeft("settings")} title="Settings">
        <span className="rail-icon">
          <Icon name="settings" size={22} />
        </span>
        <span className="rail-label">Settings</span>
      </button>
      <button className="rail-me" onClick={() => setLeft("settings-profile")} title="Profile">
        <Avatar id={me.id} mediaId={me.avatar_id} name={me.name} size={36} />
      </button>
    </nav>
  );
}

function Main() {
  const activeId = useStore((s) => s.activeChat);
  const chat = useStore((s) => (s.activeChat ? s.chats[s.activeChat] : undefined));
  const left = useUI((s) => s.left);
  const right = useUI((s) => s.right);
  useEffect(() => {
    if (!chat) useUI.getState().setRight(null);
  }, [!!chat]);
  return (
    <div className={"app" + (activeId ? " has-chat" : "") + (right && chat ? " has-right" : "")}>
      <NavRail />
      <aside className="sidebar">{left.startsWith("settings") ? <Settings /> : <Sidebar />}</aside>
      <main className="main">
        {chat ? (
          <ChatView chat={chat} />
        ) : (
          <div className="empty-main">
            <img src={import.meta.env.BASE_URL + "icon.svg"} alt="" width={96} />
            <h1>Relay</h1>
            <p className="muted">Send and receive messages, photos, voice notes and calls.<br />Use Relay on your phone, computer and browser at the same time.</p>
          </div>
        )}
      </main>
      {chat && right && (
        <aside className="right">
          <RightPanel chat={chat} />
        </aside>
      )}
    </div>
  );
}
