import { useState } from "react";
import { api, ApiError, getServer, isNative, setServer, setToken, upload } from "../api";
import { useStore } from "../store";
import type { Me } from "../types";
import { deviceName } from "../util";
import { Avatar, Icon } from "./ui";

type Step = "phone" | "code" | "pin" | "profile";

export function Login() {
  const [server, setServerInput] = useState(getServer());
  const [showServer, setShowServer] = useState(isNative || !getServer());
  const [phone, setPhone] = useState("+");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [step, setStep] = useState<Step>("phone");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<{ token: string; user: Me } | null>(null);

  const requestCode = async () => {
    setError("");
    if (!server.trim()) return setError("Enter your Relay server address");
    setServer(server.trim());
    setBusy(true);
    try {
      const r = await api<{ phone: string }>("POST", "/auth/request-code", { phone });
      setPhone(r.phone);
      setStep("code");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (withPin?: string) => {
    setError("");
    setBusy(true);
    try {
      const r = await api<{ token: string; new_user: boolean; user: Me }>("POST", "/auth/verify", {
        phone,
        code,
        pin: withPin,
        device_name: deviceName(),
      });
      if (r.new_user || !r.user.name) {
        setToken(r.token);
        setSession(r);
        setStep("profile");
      } else {
        await useStore.getState().signIn(r.token, r.user);
      }
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "pin_required") setStep("pin");
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-logo">
          <img src="/icon.svg" alt="" width={64} height={64} />
          <h1>Relay</h1>
        </div>

        {step === "phone" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              requestCode();
            }}
          >
            <p className="muted">Enter your phone number. We'll text you a 6-digit code.</p>
            {showServer ? (
              <label className="field">
                <span>Server</span>
                <input value={server} onChange={(e) => setServerInput(e.target.value)} placeholder="https://relay.example.com" autoCapitalize="off" autoCorrect="off" />
              </label>
            ) : (
              <button type="button" className="link-btn small" onClick={() => setShowServer(true)}>
                Server: {server} (change)
              </button>
            )}
            <label className="field">
              <span>Phone number</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d+ ]/g, ""))} placeholder="+62 812 3456 7890" inputMode="tel" autoFocus />
            </label>
            {error && <div className="error">{error}</div>}
            <button className="primary" disabled={busy || phone.replace(/\D/g, "").length < 8}>
              {busy ? "Sending…" : "Next"}
            </button>
          </form>
        )}

        {step === "code" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              verify();
            }}
          >
            <p className="muted">
              Enter the code sent to <b>{phone}</b>
            </p>
            <input className="code-input" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="––– –––" inputMode="numeric" autoComplete="one-time-code" autoFocus />
            {error && <div className="error">{error}</div>}
            <button className="primary" disabled={busy || code.length !== 6}>
              {busy ? "Verifying…" : "Verify"}
            </button>
            <div className="row-between">
              <button type="button" className="link-btn" onClick={() => setStep("phone")}>
                Wrong number?
              </button>
              <button type="button" className="link-btn" onClick={requestCode} disabled={busy}>
                Resend code
              </button>
            </div>
          </form>
        )}

        {step === "pin" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              verify(pin);
            }}
          >
            <Icon name="lock" size={40} className="accent" />
            <p className="muted">Two-step verification is on. Enter your 6-digit PIN.</p>
            <input className="code-input" type="password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoFocus />
            {error && <div className="error">{error}</div>}
            <button className="primary" disabled={busy || pin.length !== 6}>
              Continue
            </button>
          </form>
        )}

        {step === "profile" && session && <ProfileSetup session={session} />}
      </div>
      <p className="auth-foot muted small">Self-hosted. Your messages stay on your server.</p>
    </div>
  );
}

function ProfileSetup({ session }: { session: { token: string; user: Me } }) {
  const [name, setName] = useState(session.user.name);
  const [avatar, setAvatar] = useState<string | null>(session.user.avatar_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const m = await upload(f, f.name);
        setAvatar(m.id);
      } catch (e: any) {
        setError(e.message);
      }
    };
    input.click();
  };

  const finish = async () => {
    setBusy(true);
    try {
      const me = await api<Me>("PATCH", "/me", { name: name.trim(), avatar_id: avatar || undefined });
      await useStore.getState().signIn(session.token, me);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        finish();
      }}
    >
      <h2>Profile info</h2>
      <p className="muted">Add your name and an optional photo.</p>
      <button type="button" className="avatar-pick" onClick={pick} title="Choose photo">
        <Avatar id={session.user.id} mediaId={avatar} name={name || "?"} size={96} />
        <span className="avatar-pick-badge">
          <Icon name="camera" size={18} />
        </span>
      </button>
      <label className="field">
        <span>Your name</span>
        <input value={name} onChange={(e) => setName(e.target.value.slice(0, 25))} autoFocus />
      </label>
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy || !name.trim()}>
        Next
      </button>
    </form>
  );
}
