# Relay

A self-hosted, WhatsApp-style messenger. You run the server in Docker, and it comes with a web app (installable PWA), a desktop app (macOS and Windows, via Tauri) and mobile apps (Android and iOS, via Capacitor). Accounts are tied to a phone number and verified with an SMS code. There are no Statuses or Stories.

## Features

**Accounts**
- Sign in with a phone number and an SMS code.
- Optional two-step verification with a 6-digit PIN.
- Linked devices: phone, desktop and browser can be signed in at once, and you can log any of them out remotely.
- Profile with photo, name and About.
- Delete account.

**Chats**
- 1:1 chats, groups of up to 1024 people, broadcast lists and "Message yourself".
- Messages can be text (with `*bold*` `_italic_` `~strike~` `` `code` `` and links), photos, videos, GIFs, voice notes (playback speed, blue mic once played), audio files, documents, location, contact cards and polls.
- Live location for 15 minutes, 1 hour or 8 hours.
- Replies, reactions, forwarding (up to 5 chats), starred messages and message info (who it was delivered to, who read it, who played it).
- Ticks: one grey (sent), two grey (delivered), two blue (read).
- Typing and "recording audio…" indicators, online status and last seen.
- Edit within 15 minutes. Delete for me, or delete for everyone within 48 hours. Group admins can delete anyone's message.
- Disappearing messages: 24 hours, 7 days or 90 days.
- Pin (up to 3), archive, mute (8 hours, 1 week or always), mark as read, clear chat and delete chat.
- Search across all chats or within one chat. The chat info panel has Media, Docs and Links tabs.
- Drag and drop, paste images, multiple files with a caption, and per-chat drafts.

**Groups**
- Owner and admin roles: promote and dismiss admins, add and remove members.
- Invite links, which an admin can reset.
- "Only admins can send messages" and "Only admins can edit group info" settings.
- Group name, icon and description, plus system messages for every change.

**Calls**
- Voice and video calls, 1:1 and group (mesh, best with up to about 8 people).
- Ringing, accept and decline, mute, camera on/off, switch camera, and upgrading a voice call to video.
- Call log with missed, incoming and outgoing calls.
- STUN by default, with optional TURN (coturn is included in compose).

**Privacy and safety**
- Choose who sees your last seen and online status, profile photo and About (everyone, my contacts or nobody).
- Choose who can add you to groups.
- Read receipts can be turned off (groups always send them, as on WhatsApp).
- Block: the blocked person's messages stay on one tick forever and they can't call you.

## Run the server

```bash
cp .env.example .env        # set POSTGRES_PASSWORD and an SMS provider
docker compose up -d        # Relay on http://localhost:8080
```

The image serves the API, the WebSocket and the web app on one port. Opened in a normal browser tab, the web app shows only an install screen for the visitor's device: a one-tap install button on Chrome, Edge and Samsung Internet, step-by-step instructions on Safari, and a desktop download link on Mac, Windows and Linux. Inside an in-app browser (Instagram, Facebook and similar) it asks the visitor to open the link in a real browser. Messaging runs only in the installed app. Add `?browser` to the URL to use it in a tab anyway (handy for development or desktop Firefox). Invite links survive the install. Put it behind HTTPS (Caddy, Traefik, Nginx or a Cloudflare tunnel): browsers only allow the camera, microphone, notifications and PWA install on `https://` or `localhost`.

**SMS codes.** Set `TWILIO_*`, or set `SMS_WEBHOOK_URL` to have Relay POST `{"to","code","message"}` to any SMS gateway. If neither is set, codes are printed in the server log (`docker compose logs relay`), which is handy for testing.

**Calls on mobile data / CGNAT.** Run the bundled TURN relay: `docker compose --profile turn up -d`, with `TURN_SECRET` (any long random string), `TURN_EXTERNAL_IP` and `TURN_URLS` set in `.env`. On your router, forward **3478 UDP+TCP** and **49160-49200 UDP** to the server. `TURN_URLS` must reach your home IP directly: use the IP or a DNS-only (grey cloud) record such as `turn.example.com`, not the Cloudflare tunnel hostname, because calls use UDP. Relay gives each user short-lived credentials, so the secret never leaves the server. (A static `TURN_USERNAME`/`TURN_CREDENTIAL` also works for other TURN providers.)

### Build and push the Docker image

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u p1e2r --password-stdin   # token needs write:packages
./scripts/push-image.sh                  # ghcr.io/p1e2r/relay-server:latest (amd64 + arm64)
TAG=0.1.0 ./scripts/push-image.sh        # ghcr.io/p1e2r/relay-server:0.1.0
```

Pushing to `main` (or a `v*` tag) also builds and pushes the image to GHCR automatically (`.github/workflows/docker.yml`). No secrets needed: it uses the repo's `GITHUB_TOKEN`. On first publish the package is private; make it public under GitHub → Packages → relay-server → Settings if you want to pull it without logging in.

### Server configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | `postgres://relay:relay@localhost:5432/relay` | Postgres connection |
| `PORT` | `8080` | |
| `MEDIA_DIR` | `/data/media` | Uploaded files (mount a volume) |
| `MAX_UPLOAD_MB` | `100` | |
| `STUN_URLS` / `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | Google STUN | Sent to clients for calls |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | | SMS through Twilio |
| `SMS_WEBHOOK_URL` / `SMS_WEBHOOK_AUTH` | | SMS through your own gateway |

## Web app on GitHub Pages

The web app can also be hosted on GitHub Pages at `https://p1e2r.github.io/relay/`, talking to your own server:

1. Settings → Pages → Source: **GitHub Actions**.
2. Settings → Secrets and variables → Actions → Variables: add `RELAY_DEFAULT_SERVER` = your server's HTTPS address (for example your Cloudflare tunnel hostname).
3. Push to `main` (or run the "Web app (GitHub Pages)" workflow). Invite links then point at the Pages URL.

The server must be HTTPS: Pages is HTTPS, and browsers block calls from an HTTPS page to a plain-http server.

## Apps

All three use the same React client in `client/`. In the desktop and mobile apps, the sign-in screen asks for your server address.

```bash
cd client && npm install
npm run dev              # web dev server on :5173 (proxies to a server on :8080)
npm run desktop:dev      # Tauri desktop app (needs Rust)
npm run desktop:build    # .dmg / .msi / .exe installers
npm run android          # build, sync and open Android Studio
npm run ios              # build, sync and open Xcode (macOS only)
```

Pushing a `v*` tag builds the macOS (Apple Silicon and Intel), Windows and Linux desktop installers plus an Android APK, and attaches them to a draft GitHub release (`.github/workflows/apps.yml`).

## Publishing the Android app (Galaxy Store / APK)

1. Create the upload key once with `./scripts/android-upload-key.sh`, then add the repo secrets it prints (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`).
2. Set the repo variable `RELAY_DEFAULT_SERVER` (for example `https://relay.example.com`). The store build then opens straight onto your server instead of asking for an address.
3. Set `REVIEW_PHONE` and `REVIEW_CODE` on the server. That number always accepts the fixed code and gets no SMS. Give both to the store reviewer.
4. Push a `v*` tag. The release gets a signed `app-release.apk` (for the Galaxy Store and direct download) and an `.aab`.
5. Privacy policy URL: `https://<your server>/privacy.html`. Edit `client/public/privacy.html` first with your name and contact email.

## Development

```bash
cd server
DATABASE_URL=postgres://relay:relay@localhost/relay WEB_DIR=../client/dist cargo run
node tests/smoke.mjs http://localhost:8080 /path/to/server.log   # 36 end-to-end API checks
```

Stack: Rust (axum, sqlx, tokio) + Postgres on the server; React, TypeScript, Vite and zustand on the client; WebRTC for calls.

## Not included (yet)

- **End-to-end encryption.** Messages are encrypted in transit (TLS) and stored on *your* server, but the server can read them. Signal-protocol E2EE is the biggest missing piece.
- **Push notifications when the app is closed** (FCM/APNs, Web Push). Notifications work while the app or tab is open or in the background.
- Communities, Channels, payments, stickers/GIF search, view-once media and chat backups/export.
- Live location only updates while the sharer has Relay open.

## License

MIT
