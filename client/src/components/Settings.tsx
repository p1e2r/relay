import { useEffect, useState } from "react";
import { api, getServer, upload } from "../api";
import { useStore } from "../store";
import type { Me, Privacy, Session, User } from "../types";
import { useUI, type LeftView } from "../ui-state";
import { listTime, userName } from "../util";
import { attempt, Avatar, Icon, IconButton, toast, Toggle } from "./ui";

function Head({ title, back }: { title: string; back: LeftView }) {
  return (
    <div className="panel-head">
      <IconButton icon="back" title="Back" onClick={() => useUI.getState().setLeft(back)} />
      <h2>{title}</h2>
    </div>
  );
}

async function patchMe(body: Partial<Me> & { remove_avatar?: boolean }) {
  const me = await api<Me>("PATCH", "/me", body);
  useStore.getState().setMe(me);
  return me;
}

export function Settings() {
  const left = useUI((s) => s.left);
  switch (left) {
    case "settings-profile":
      return <Profile />;
    case "settings-privacy":
      return <PrivacySettings />;
    case "settings-devices":
      return <Devices />;
    case "settings-blocked":
      return <Blocked />;
    case "settings-security":
      return <Security />;
    case "settings-notifications":
      return <Notifications />;
    default:
      return <SettingsHome />;
  }
}

function SettingsHome() {
  const me = useStore((s) => s.me)!;
  const go = useUI((s) => s.setLeft);
  const items: { icon: string; label: string; hint: string; to: LeftView }[] = [
    { icon: "lock", label: "Privacy", hint: "Last seen, profile photo, read receipts, groups", to: "settings-privacy" },
    { icon: "settings", label: "Security", hint: "Two-step verification", to: "settings-security" },
    { icon: "devices", label: "Linked devices", hint: "Everywhere you're signed in", to: "settings-devices" },
    { icon: "block", label: "Blocked contacts", hint: "People who can't message or call you", to: "settings-blocked" },
    { icon: "mute", label: "Notifications", hint: "Desktop & browser alerts", to: "settings-notifications" },
  ];
  return (
    <div className="panel">
      <Head title="Settings" back="chats" />
      <div className="scroll">
        <button className="chat-row profile-row" onClick={() => go("settings-profile")}>
          <Avatar id={me.id} mediaId={me.avatar_id} name={me.name} size={72} />
          <div className="grow min0">
            <div className="chat-name big">{me.name}</div>
            <div className="chat-preview">{me.about}</div>
          </div>
        </button>
        {items.map((it) => (
          <button key={it.to} className="chat-row" onClick={() => go(it.to)}>
            <Icon name={it.icon} className="muted" />
            <div className="grow min0">
              <div className="chat-name">{it.label}</div>
              <div className="chat-preview">{it.hint}</div>
            </div>
          </button>
        ))}
        <button className="chat-row" onClick={() => useStore.getState().signOut()}>
          <Icon name="logout" className="danger" />
          <div className="chat-name danger">Log out</div>
        </button>
        <div className="pad muted small">
          Connected to {getServer()} · Signed in as {me.phone}
        </div>
      </div>
    </div>
  );
}

function Profile() {
  const me = useStore((s) => s.me)!;
  const [name, setName] = useState(me.name);
  const [about, setAbout] = useState(me.about);
  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const m = await attempt(() => upload(f, f.name));
      if (m) attempt(() => patchMe({ avatar_id: m.id }));
    };
    input.click();
  };
  return (
    <div className="panel">
      <Head title="Profile" back="settings" />
      <div className="scroll pad">
        <div className="center">
          <button className="avatar-pick" onClick={pick}>
            <Avatar id={me.id} mediaId={me.avatar_id} name={me.name} size={160} />
            <span className="avatar-pick-badge">
              <Icon name="camera" size={20} />
            </span>
          </button>
          {me.avatar_id && (
            <button className="link-btn danger" onClick={() => attempt(() => patchMe({ remove_avatar: true }))}>
              Remove photo
            </button>
          )}
        </div>
        <label className="field">
          <span>Name</span>
          <input value={name} maxLength={25} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== me.name && attempt(() => patchMe({ name }))} />
        </label>
        <p className="muted small">This is not your username or PIN. This name will be visible to your Relay contacts.</p>
        <label className="field">
          <span>About</span>
          <input value={about} maxLength={139} onChange={(e) => setAbout(e.target.value)} onBlur={() => about !== me.about && attempt(() => patchMe({ about }))} />
        </label>
        <div className="chips wrap">
          {["Available", "Busy", "At school", "At work", "Battery about to die", "In a meeting", "Sleeping", "Urgent calls only"].map((a) => (
            <button key={a} className="chip" onClick={() => {
              setAbout(a);
              attempt(() => patchMe({ about: a }));
            }}>
              {a}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Phone</span>
          <input value={me.phone} disabled />
        </label>
      </div>
    </div>
  );
}

function PrivacyChoice({ label, value, onChange }: { label: string; value: Privacy; onChange: (v: Privacy) => void }) {
  return (
    <label className="row">
      <div className="grow">{label}</div>
      <select value={value} onChange={(e) => onChange(e.target.value as Privacy)}>
        <option value="everyone">Everyone</option>
        <option value="contacts">My contacts</option>
        <option value="nobody">Nobody</option>
      </select>
    </label>
  );
}

function PrivacySettings() {
  const me = useStore((s) => s.me)!;
  const set = (body: Partial<Me>) => attempt(() => patchMe(body));
  return (
    <div className="panel">
      <Head title="Privacy" back="settings" />
      <div className="scroll pad">
        <div className="section-label">Who can see my personal info</div>
        <PrivacyChoice label="Last seen & online" value={me.privacy_last_seen} onChange={(v) => set({ privacy_last_seen: v })} />
        <PrivacyChoice label="Profile photo" value={me.privacy_photo} onChange={(v) => set({ privacy_photo: v })} />
        <PrivacyChoice label="About" value={me.privacy_about} onChange={(v) => set({ privacy_about: v })} />
        <PrivacyChoice label="Who can add me to groups" value={me.privacy_groups} onChange={(v) => set({ privacy_groups: v })} />
        <Toggle
          label="Read receipts"
          hint="If turned off, you won't send or receive read receipts in personal chats. Read receipts are always sent in groups."
          checked={me.read_receipts}
          onChange={(v) => set({ read_receipts: v })}
        />
        <button className="chat-row" onClick={() => useUI.getState().setLeft("settings-blocked")}>
          <Icon name="block" className="muted" />
          <div className="chat-name">Blocked contacts</div>
        </button>
      </div>
    </div>
  );
}

function Devices() {
  const [list, setList] = useState<Session[]>([]);
  const reload = () => api<Session[]>("GET", "/auth/sessions").then(setList).catch(() => {});
  useEffect(() => {
    reload();
  }, []);
  return (
    <div className="panel">
      <Head title="Linked devices" back="settings" />
      <div className="scroll">
        <p className="pad muted small">
          Sign in on another phone, computer or browser with your number to link it. Each one shows up here and can be logged out remotely.
        </p>
        {list.map((s) => (
          <div key={s.id} className="chat-row">
            <Icon name="devices" className="muted" />
            <div className="grow min0">
              <div className="chat-name">
                {s.device_name} {s.current && <span className="accent small">· This device</span>}
              </div>
              <div className="chat-preview">Last active {listTime(s.last_active)}</div>
            </div>
            {!s.current && (
              <button className="link-btn danger" onClick={async () => {
                await attempt(() => api("DELETE", `/auth/sessions/${s.id}`), "Device logged out");
                reload();
              }}>
                Log out
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Blocked() {
  const [list, setList] = useState<User[]>([]);
  const reload = () => api<User[]>("GET", "/blocks").then(setList).catch(() => {});
  useEffect(() => {
    reload();
  }, []);
  return (
    <div className="panel">
      <Head title="Blocked contacts" back="settings" />
      <div className="scroll">
        {list.map((u) => (
          <div key={u.id} className="chat-row">
            <Avatar id={u.id} mediaId={u.avatar_id} name={userName(u)} size={40} />
            <div className="grow min0">
              <div className="chat-name">{userName(u)}</div>
              <div className="chat-preview">{u.phone}</div>
            </div>
            <button className="link-btn" onClick={async () => {
              await attempt(() => api("DELETE", `/blocks/${u.id}`), `${userName(u)} unblocked`);
              reload();
            }}>
              Unblock
            </button>
          </div>
        ))}
        {!list.length && <div className="empty-list muted">No blocked contacts. Blocked contacts can't call you or send you messages.</div>}
      </div>
    </div>
  );
}

function Security() {
  const me = useStore((s) => s.me)!;
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const refresh = async () => useStore.getState().setMe(await api<Me>("GET", "/me"));
  return (
    <div className="panel">
      <Head title="Security" back="settings" />
      <div className="scroll pad">
        <div className="section-label">Two-step verification</div>
        <p className="muted small">For extra security, require a 6-digit PIN whenever your number is registered on a new device.</p>
        {me.has_pin ? (
          <>
            <p className="accent">Two-step verification is on.</p>
            <button className="secondary danger" onClick={async () => {
              await attempt(() => api("DELETE", "/me/pin"), "Two-step verification turned off");
              refresh();
            }}>
              Turn off
            </button>
          </>
        ) : null}
        <label className="field">
          <span>{me.has_pin ? "Change PIN" : "New PIN"}</span>
          <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        </label>
        <label className="field">
          <span>Confirm PIN</span>
          <input type="password" inputMode="numeric" value={confirm} onChange={(e) => setConfirm(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        </label>
        <button
          className="primary"
          disabled={pin.length !== 6 || pin !== confirm}
          onClick={async () => {
            await attempt(() => api("PUT", "/me/pin", { pin }), "PIN saved");
            setPin("");
            setConfirm("");
            refresh();
          }}
        >
          Save PIN
        </button>

        <div className="section-label danger">Delete account</div>
        <p className="muted small">Deletes your account, profile, direct chats and removes you from all groups. This can't be undone.</p>
        {deleting ? (
          <div className="row gap">
            <button className="secondary" onClick={() => setDeleting(false)}>
              Cancel
            </button>
            <button
              className="primary danger-bg"
              onClick={async () => {
                try {
                  await api("DELETE", "/me");
                  window.dispatchEvent(new Event("relay:logout"));
                } catch (e: any) {
                  toast(e.message);
                }
              }}
            >
              Yes, delete my account
            </button>
          </div>
        ) : (
          <button className="secondary danger" onClick={() => setDeleting(true)}>
            Delete my account
          </button>
        )}
      </div>
    </div>
  );
}

function Notifications() {
  const [perm, setPerm] = useState(typeof Notification !== "undefined" ? Notification.permission : "denied");
  return (
    <div className="panel">
      <Head title="Notifications" back="settings" />
      <div className="scroll pad">
        {typeof Notification === "undefined" ? (
          <p className="muted">This device doesn't support notifications.</p>
        ) : perm === "granted" ? (
          <p>Notifications are on. Mute individual chats from the chat menu.</p>
        ) : (
          <>
            <p className="muted">Get notified about new messages while Relay is in the background.</p>
            <button
              className="primary"
              onClick={async () => {
                const p = await Notification.requestPermission();
                setPerm(p);
                if (p === "denied") toast("Notifications are blocked in your browser settings");
              }}
            >
              Turn on notifications
            </button>
          </>
        )}
      </div>
    </div>
  );
}
