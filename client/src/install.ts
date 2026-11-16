// Detects how Relay is running and whether the browser can install it.
import { create } from "zustand";
import { isNative } from "./api";

export type Platform = "android" | "ios" | "mac" | "windows" | "linux" | "other";

export function platform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support gives it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac OS X/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux|CrOS/.test(ua)) return "linux";
  return "other";
}

/** Apps like Instagram, Facebook, TikTok and LINE open links in a webview that can't install anything. */
export function inAppBrowser(): boolean {
  return /FBAN|FBAV|Instagram|Line\/|TikTok|musical_ly|Snapchat|Twitter|MicroMessenger|; wv\)/.test(navigator.userAgent);
}

export function browserName(): "chrome" | "edge" | "samsung" | "firefox" | "safari" | "opera" | "other" {
  const ua = navigator.userAgent;
  if (/SamsungBrowser/.test(ua)) return "samsung";
  if (/Edg(A|iOS)?\//.test(ua)) return "edge";
  if (/OPR\/|Opera/.test(ua)) return "opera";
  if (/Firefox|FxiOS/.test(ua)) return "firefox";
  if (/Chrome|CriOS/.test(ua)) return "chrome";
  if (/Safari/.test(ua)) return "safari";
  return "other";
}

/** True when running as the installed web app (home screen / dock / app list). */
export function isStandalone(): boolean {
  return (
    ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"].some((m) => window.matchMedia(`(display-mode: ${m})`).matches) ||
    (navigator as any).standalone === true
  );
}

/**
 * The full app only runs when installed (or in the native desktop/mobile apps).
 * `?browser` in the URL opts this tab out of the gate, e.g. for development or Firefox on desktop.
 */
export function shouldGate(): boolean {
  if (isNative || isStandalone() || import.meta.env.DEV) return false;
  try {
    if (new URLSearchParams(location.search).has("browser")) sessionStorage.setItem("relay.browser", "1");
    if (sessionStorage.getItem("relay.browser") === "1") return false;
  } catch {}
  return true;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export const useInstall = create<{ prompt: BeforeInstallPromptEvent | null; installed: boolean }>(() => ({
  prompt: null,
  installed: false,
}));

// Chrome, Edge and Samsung Internet fire this when Relay can be installed with one tap.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  useInstall.setState({ prompt: e as BeforeInstallPromptEvent });
});
window.addEventListener("appinstalled", () => useInstall.setState({ installed: true, prompt: null }));

export async function promptInstall(): Promise<boolean> {
  const p = useInstall.getState().prompt;
  if (!p) return false;
  await p.prompt();
  const { outcome } = await p.userChoice;
  useInstall.setState({ prompt: null, installed: outcome === "accepted" });
  return outcome === "accepted";
}

/** Keep an invite link's code so the installed app can open it after install. */
export function rememberJoinCode() {
  const m = location.pathname.match(/\/join\/([A-Za-z0-9]+)/);
  if (m) {
    try {
      localStorage.setItem("relay.pendingJoin", m[1]);
    } catch {}
  }
}

export function takePendingJoin(): string | null {
  try {
    const c = localStorage.getItem("relay.pendingJoin");
    if (c) localStorage.removeItem("relay.pendingJoin");
    return c;
  } catch {
    return null;
  }
}
