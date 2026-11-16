import type { Media } from "./types";

const SERVER_KEY = "relay.server";
const TOKEN_KEY = "relay.token";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isCapacitor = typeof window !== "undefined" && !!(window as any).Capacitor?.isNativePlatform?.();
export const isNative = isTauri || isCapacitor;

function safeGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
}

/** In the browser the app is served by the server itself, so the server is the page's origin. */
export function defaultServer(): string {
  const baked = import.meta.env.VITE_DEFAULT_SERVER as string | undefined;
  if (isNative && baked) return baked.replace(/\/+$/, "");
  if (!isNative && location.protocol.startsWith("http")) {
    // Vite dev server proxies /api and /ws, so same-origin works there too.
    return location.origin;
  }
  return "";
}

export function getServer(): string {
  return safeGet(SERVER_KEY) || defaultServer();
}
export function setServer(url: string) {
  safeSet(SERVER_KEY, url.replace(/\/+$/, ""));
}
export function getToken(): string | null {
  return safeGet(TOKEN_KEY);
}
export function setToken(t: string | null) {
  safeSet(TOKEN_KEY, t);
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(getServer() + "/api" + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "Can't reach the server");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && data?.error === "unauthorized") {
      setToken(null);
      window.dispatchEvent(new Event("relay:logout"));
    }
    throw new ApiError(res.status, data?.error || "error", data?.message || `Request failed (${res.status})`);
  }
  return data as T;
}

export function upload(file: Blob, filename: string, onProgress?: (p: number) => void): Promise<Media> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", getServer() + "/api/media");
    const token = getToken();
    if (token) xhr.setRequestHeader("authorization", "Bearer " + token);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(xhr.status, data?.error, data?.message || "Upload failed"));
      } catch {
        reject(new ApiError(xhr.status, "error", "Upload failed"));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "Upload failed"));
    const fd = new FormData();
    fd.append("file", file, filename);
    xhr.send(fd);
  });
}

export function mediaUrl(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  return `${getServer()}/api/media/${id}?token=${getToken()}`;
}

// ---------- realtime ----------

type Listener = (ev: any) => void;

class Realtime {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(up: boolean) => void>();
  private retry = 0;
  private stopped = true;
  private pingTimer: number | undefined;
  public connected = false;

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    const token = getToken();
    if (!token || this.stopped) return;
    const url = getServer().replace(/^http/, "ws") + "/ws?token=" + encodeURIComponent(token);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setConnected(true);
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ type: "ping" }), 25_000);
    };
    ws.onmessage = (e) => {
      let ev: any;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      this.listeners.forEach((l) => l(ev));
    };
    ws.onclose = () => {
      this.setConnected(false);
      clearInterval(this.pingTimer);
      if (this.stopped) return;
      const delay = Math.min(15_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private setConnected(up: boolean) {
    this.connected = up;
    this.statusListeners.forEach((l) => l(up));
  }

  send(ev: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ev));
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onStatus(l: (up: boolean) => void) {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }
}

export const realtime = new Realtime();
