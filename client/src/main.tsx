import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./install";
import { App } from "./App";
import { isNative, isTauri } from "./api";
import "@fontsource-variable/plus-jakarta-sans";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

if ("serviceWorker" in navigator && !isNative && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js").catch(() => {});
}

if (isTauri) {
  const t = (window as any).__TAURI__;
  // Desktop: ask once for notification permission, and open links in the system browser.
  t?.notification?.isPermissionGranted?.().then((ok: boolean) => ok || t.notification.requestPermission());
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
    if (a && /^https?:/.test(a.href) && !a.href.startsWith(location.origin)) {
      e.preventDefault();
      t?.opener?.openUrl?.(a.href);
    }
  });
}
