import { useState } from "react";
import { browserName, inAppBrowser, platform, promptInstall, rememberJoinCode, useInstall, type Platform } from "../install";
import { Icon } from "./ui";

const DESKTOP_DOWNLOAD = "https://github.com/p1e2r/relay/releases/latest";

const DEVICE: Record<Platform, string> = {
  android: "your Android phone",
  ios: "your iPhone or iPad",
  mac: "your Mac",
  windows: "your PC",
  linux: "your computer",
  other: "this device",
};

const DESKTOP_NAME: Partial<Record<Platform, string>> = { mac: "macOS", windows: "Windows", linux: "Linux" };

function ShareGlyph() {
  return (
    <svg className="inline-glyph" width="18" height="18" viewBox="0 0 24 24" aria-label="Share">
      <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Steps({ os }: { os: Platform }) {
  const b = browserName();
  if (os === "ios")
    return (
      <ol className="install-steps">
        <li>
          Tap the Share button <ShareGlyph /> {b === "safari" ? "at the bottom of Safari" : "in the address bar"}.
        </li>
        <li>
          Scroll down and tap <b>Add to Home Screen</b>.
        </li>
        <li>
          Tap <b>Add</b>, then open Relay from your Home Screen.
        </li>
      </ol>
    );
  if (os === "android")
    return (
      <ol className="install-steps">
        <li>
          Tap the menu <b>⋮</b> {b === "samsung" ? "(☰ at the bottom)" : "at the top right"}.
        </li>
        <li>
          Tap <b>{b === "firefox" ? "Install" : b === "samsung" ? "Add page to → Home screen" : "Install app"}</b>
          {b === "chrome" && <> (or <b>Add to Home screen</b>)</>}.
        </li>
        <li>Open Relay from your home screen.</li>
      </ol>
    );
  if (os === "mac" && b === "safari")
    return (
      <ol className="install-steps">
        <li>
          In the menu bar, choose <b>File → Add to Dock</b>.
        </li>
        <li>
          Click <b>Add</b>, then open Relay from your Dock.
        </li>
      </ol>
    );
  if (b === "chrome" || b === "edge")
    return (
      <ol className="install-steps">
        <li>
          Click the install icon at the right end of the address bar, or open the menu <b>⋮</b> and choose <b>{b === "edge" ? "Apps → Install Relay" : "Cast, save and share → Install page as app"}</b>.
        </li>
        <li>Relay opens in its own window.</li>
      </ol>
    );
  return <p className="muted">This browser can't install web apps. Download the desktop app instead.</p>;
}

export function InstallGate() {
  rememberJoinCode();
  const os = platform();
  const canPrompt = useInstall((s) => !!s.prompt);
  const installed = useInstall((s) => s.installed);
  const [showSteps, setShowSteps] = useState(false);
  const [copied, setCopied] = useState(false);
  const desktop = os === "mac" || os === "windows" || os === "linux";
  const webInstallable = os === "ios" || os === "android" || canPrompt || ((os === "mac" || os === "windows" || os === "linux") && ["chrome", "edge"].includes(browserName())) || (os === "mac" && browserName() === "safari");

  if (inAppBrowser()) {
    return (
      <div className="install">
        <div className="install-card">
          <img src="/icon.svg" alt="" width={84} height={84} className="install-logo" />
          <h1>Open in your browser</h1>
          <p className="muted">Relay can't be installed from inside this app. Open this page in {os === "ios" ? "Safari" : "Chrome"} to install it.</p>
          <p className="muted small">Tap the menu (⋯ or ⋮) and choose <b>Open in browser</b>, or copy the link.</p>
          <button
            className="primary"
            onClick={() => {
              navigator.clipboard?.writeText(location.href).then(() => setCopied(true));
            }}
          >
            {copied ? "Link copied" : "Copy link"}
          </button>
        </div>
      </div>
    );
  }

  const install = async () => {
    if (canPrompt) {
      const ok = await promptInstall();
      if (!ok) setShowSteps(true);
    } else {
      setShowSteps(true);
    }
  };

  return (
    <div className="install">
      <div className="install-card">
        <img src="/icon.svg" alt="" width={84} height={84} className="install-logo" />
        <h1>Get Relay</h1>
        {installed ? (
          <>
            <p className="muted">Relay is installed. Open it from {desktop ? "your apps" : "your home screen"} to sign in.</p>
            <div className="install-done">
              <Icon name="check" size={28} />
            </div>
          </>
        ) : (
          <>
            <p className="muted">Install Relay on {DEVICE[os]} to start messaging. It works like a regular app, with its own icon and notifications.</p>
            {webInstallable && (
              <button className="primary install-btn" onClick={install}>
                <Icon name="download" size={20} /> Install Relay
              </button>
            )}
            {(showSteps || (!canPrompt && os === "ios")) && webInstallable && <Steps os={os} />}
            {!webInstallable && <Steps os={os} />}
            {desktop && (
              <a className={webInstallable ? "secondary install-alt" : "primary install-btn"} href={DESKTOP_DOWNLOAD} target="_blank" rel="noreferrer">
                Download for {DESKTOP_NAME[os]}
              </a>
            )}
          </>
        )}
      </div>
      <p className="install-foot muted small">Self-hosted messaging. Your chats stay on your server.</p>
    </div>
  );
}
