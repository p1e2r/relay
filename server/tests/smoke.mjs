// End-to-end smoke test against a running server.
// Usage: node tests/smoke.mjs [base_url] [server_log_path]
// Reads OTP codes from the server log (console SMS provider).
import { readFileSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:8080";
const LOG = process.argv[3] || "/tmp/relaytest/server.log";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

async function api(token, method, path, body) {
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data };
}

async function login(phone) {
  await api(null, "POST", "/auth/request-code", { phone });
  await sleep(200);
  const log = readFileSync(LOG, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  const m = [...log.matchAll(new RegExp(`login code for \\${phone}: (\\d{6})`, "g"))].pop();
  const r = await api(null, "POST", "/auth/verify", { phone, code: m[1], device_name: "smoke" });
  return r.data;
}

function socket(token) {
  const ws = new WebSocket(BASE.replace("http", "ws") + "/ws?token=" + token);
  const events = [];
  ws.onmessage = (e) => events.push(JSON.parse(e.data));
  return new Promise((res) => (ws.onopen = () => res({ ws, events })));
}

const suffix = String(Date.now()).slice(-7);
const a = await login(`+6281${suffix}1`);
const b = await login(`+6281${suffix}2`);
const c = await login(`+6281${suffix}3`);
ok(a?.token && b?.token && a.new_user, "phone OTP login creates accounts");

await api(a.token, "PATCH", "/me", { name: "Alice" });
await api(b.token, "PATCH", "/me", { name: "Bob" });
await api(c.token, "PATCH", "/me", { name: "Carol" });

const contact = await api(a.token, "POST", "/contacts", { phone: b.user.phone, name: "Bobby" });
ok(contact.data?.contact_name === "Bobby", "add contact by phone");

const sb = await socket(b.token);
const sa = await socket(a.token);
await sleep(200);

const chat = (await api(a.token, "POST", "/chats/direct", { user_id: b.user.id })).data;
ok(chat?.kind === "direct" && chat.members.length === 2, "open direct chat");

const sent = await api(a.token, "POST", `/chats/${chat.id}/messages`, { kind: "text", body: "hello bob" });
ok(sent.data?.status === "delivered", "message delivered to online user");
await sleep(200);
ok(sb.events.some((e) => e.type === "message.new" && e.message.body === "hello bob"), "realtime message over websocket");

sb.ws.send(JSON.stringify({ type: "typing", chat_id: chat.id, state: "typing" }));
await sleep(200);
ok(sa.events.some((e) => e.type === "typing" && e.user_id === b.user.id), "typing indicator");

const bChats = (await api(b.token, "GET", "/chats")).data;
ok(bChats[0]?.unread === 1, "unread count");
await api(b.token, "POST", `/chats/${chat.id}/read`);
await sleep(200);
ok(sa.events.some((e) => e.type === "message.status" && e.status === "read"), "blue ticks (read receipt)");

const reply = await api(b.token, "POST", `/chats/${chat.id}/messages`, { kind: "text", body: "hi!", reply_to: sent.data.id });
ok(reply.data?.reply_to?.body === "hello bob", "reply to message");

const react = await api(b.token, "POST", `/messages/${sent.data.id}/react`, { emoji: "👍" });
ok(react.data?.reactions?.[0]?.emoji === "👍", "reaction");

const edit = await api(a.token, "PATCH", `/messages/${sent.data.id}`, { body: "hello bob (edited)" });
ok(edit.data?.edited_at && edit.data.body.includes("edited"), "edit message");

await api(a.token, "POST", `/messages/${sent.data.id}/star`);
ok((await api(a.token, "GET", "/starred")).data.length === 1, "star message");

const del = await api(a.token, "DELETE", `/messages/${reply.data.id}?scope=everyone`);
ok(del.status === 403, "can't delete someone else's message for everyone");
await api(b.token, "DELETE", `/messages/${reply.data.id}?scope=everyone`);
const msgs = (await api(a.token, "GET", `/chats/${chat.id}/messages`)).data;
ok(msgs.find((m) => m.id === reply.data.id)?.deleted === true, "delete for everyone");

// media
const fd = new FormData();
fd.append("file", new Blob([new Uint8Array(2048).fill(7)], { type: "image/png" }), "pic.png");
const up = await fetch(BASE + "/api/media", { method: "POST", headers: { authorization: "Bearer " + a.token }, body: fd }).then((r) => r.json());
ok(up.size === 2048 && up.mime === "image/png", "upload media");
const img = await api(a.token, "POST", `/chats/${chat.id}/messages`, { kind: "image", media_id: up.id, body: "caption" });
ok(img.data?.media?.id === up.id, "send image");
const dl = await fetch(`${BASE}/api/media/${up.id}?token=${b.token}`, { headers: { range: "bytes=0-99" } });
ok(dl.status === 206 && dl.headers.get("content-type") === "image/png", "download media with range");

// group
const g = (await api(a.token, "POST", "/chats/group", { name: "Squad", member_ids: [b.user.id, c.user.id] })).data;
ok(g?.chat?.members?.length === 3, "create group");
const poll = await api(b.token, "POST", `/chats/${g.chat.id}/messages`, { kind: "poll", meta: { question: "Lunch?", options: ["Nasi goreng", "Sate"], multiple: false } });
const voted = await api(c.token, "POST", `/messages/${poll.data.id}/vote`, { options: [1] });
ok(voted.data?.votes?.[0]?.option_idx === 1, "poll vote");
const nonAdmin = await api(b.token, "POST", `/chats/${g.chat.id}/members/${c.user.id}`.replace("/members/" + c.user.id, "/invite"));
ok(nonAdmin.status === 403, "non-admin can't reset invite link");
await api(a.token, "PATCH", `/chats/${g.chat.id}/members/${b.user.id}`, { role: "admin" });
const reset = await api(b.token, "POST", `/chats/${g.chat.id}/invite`);
ok(!!reset.data?.invite_code, "promoted admin can reset invite link");
await api(a.token, "DELETE", `/chats/${g.chat.id}/members/${c.user.id}`);
const joined = await api(c.token, "POST", `/join/${reset.data.invite_code}`);
ok(joined.data?.id === g.chat.id, "join via invite link");
await api(a.token, "PATCH", `/chats/${g.chat.id}`, { admins_only_send: true });
const blockedSend = await api(c.token, "POST", `/chats/${g.chat.id}/messages`, { kind: "text", body: "x" });
ok(blockedSend.status === 403, "admins-only messaging");

// disappearing + location + forward
await api(a.token, "PATCH", `/chats/${chat.id}`, { disappearing_seconds: 86400 });
const loc = await api(a.token, "POST", `/chats/${chat.id}/messages`, { kind: "location", meta: { lat: -6.2, lng: 106.8, live_minutes: 15 } });
ok(loc.data?.expires_at && loc.data.meta.live_until, "disappearing timer + live location");
const fwd = await api(a.token, "POST", `/messages/${img.data.id}/forward`, { chat_ids: [g.chat.id] });
ok(fwd.data?.[0]?.forwarded === true, "forward message");

// block
await api(b.token, "POST", `/blocks/${a.user.id}`);
const toBlocked = await api(a.token, "POST", `/chats/${chat.id}/messages`, { kind: "text", body: "are you there?" });
ok(toBlocked.data?.status === "sent", "message to someone who blocked you stays single-tick");
const bView = (await api(b.token, "GET", `/chats/${chat.id}/messages`)).data;
ok(!bView.some((m) => m.body === "are you there?"), "blocker doesn't receive it");
const fromBlocker = await api(b.token, "POST", `/chats/${chat.id}/messages`, { kind: "text", body: "x" });
ok(fromBlocker.status === 403, "blocker must unblock to send");

// search + calls
const found = (await api(a.token, "GET", "/search?q=edited")).data;
ok(found.length === 1, "message search");
await api(b.token, "DELETE", `/blocks/${a.user.id}`);
sa.ws.send(JSON.stringify({ type: "call.start", chat_id: chat.id, video: true }));
await sleep(300);
const incoming = sb.events.find((e) => e.type === "call.incoming");
ok(!!incoming, "incoming call ring");
sb.ws.send(JSON.stringify({ type: "call.accept", call_id: incoming.call.id }));
await sleep(200);
ok(sb.events.some((e) => e.type === "call.peers" && e.peers.includes(a.user.id)), "call accept returns peers");
sb.ws.send(JSON.stringify({ type: "call.signal", call_id: incoming.call.id, to: a.user.id, data: { sdp: "x" } }));
await sleep(200);
ok(sa.events.some((e) => e.type === "call.signal" && e.from === b.user.id), "WebRTC signalling relay");
sa.ws.send(JSON.stringify({ type: "call.leave", call_id: incoming.call.id }));
await sleep(300);
const log = (await api(a.token, "GET", "/calls")).data;
ok(log[0]?.status === "ended", "call log");

// sessions + PIN
const sessions = (await api(a.token, "GET", "/auth/sessions")).data;
ok(sessions.length >= 1 && sessions.some((s) => s.current), "linked devices list");
await api(a.token, "PUT", "/me/pin", { pin: "123456" });
await api(null, "POST", "/auth/request-code", { phone: a.user.phone });
await sleep(200);
const log2 = readFileSync(LOG, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
const code = [...log2.matchAll(new RegExp(`login code for \\${a.user.phone}: (\\d{6})`, "g"))].pop()[1];
const noPin = await api(null, "POST", "/auth/verify", { phone: a.user.phone, code });
ok(noPin.data?.error === "pin_required", "two-step PIN required");
const withPin = await api(null, "POST", "/auth/verify", { phone: a.user.phone, code, pin: "123456" });
ok(!!withPin.data?.token, "login with PIN");

sa.ws.close();
sb.ws.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
