# PeerCast

Broadcast a browser tab or your whole screen to anyone, **peer-to-peer over
WebRTC**. Media flows directly viewer↔broadcaster — only a tiny signaling
handshake touches a server.

This is the **self-hosted, Node.js edition** (v2). The entire stack — REST API,
PeerJS signaling, SQLite storage, and the installable PWA — runs from a single
Node process you can host anywhere: a VPS, a Docker/Podman container, an old
laptop, or a Raspberry Pi. No Cloudflare, no third-party services required.

> Looking for the original Cloudflare-Workers edition? It lives on the
> `serverless` branch.

---

## Table of contents

1. [What's in the box](#whats-in-the-box)
2. [Quick start — development](#quick-start--development)
3. [Quick start — production](#quick-start--production)
4. [Updating the OCI production deployment](#updating-the-oci-production-deployment)
5. [First-run checklist](#first-run-checklist)
6. [Features at a glance](#features-at-a-glance)
7. [Pages](#pages)
8. [How it works](#how-it-works)
9. [Security & identity model](#security--identity-model)
10. [Email — verification & password reset](#email--verification--password-reset)
11. [Moderation](#moderation-in-a-peer-to-peer-system)
12. [API surface](#api-surface-api)
13. [Configuration reference](#configuration-reference)
14. [TURN relay (symmetric-NAT viewers)](#turn-relay-symmetric-nat-viewers)
15. [The Chrome extension (optional)](#the-chrome-extension-optional)
16. [Testing](#testing)
17. [Development commands](#development-commands)
18. [Limitations](#limitations)

---

## What's in the box

| Package              | Stack                                                     | Role                                                          |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/shared`    | TypeScript                                                | Domain models + REST API contracts shared by all packages     |
| `packages/server`    | Node · Express · better-sqlite3 · JWT · PeerJS            | REST API + PeerJS signaling + SQLite storage + serves the PWA |
| `packages/web`       | Vite · React · Redux Toolkit · Tailwind · vite-plugin-pwa | Installable PWA: landing, dashboard, broadcaster, viewer      |
| `packages/extension` | Chrome MV3 (vanilla JS)                                   | **Optional** broadcaster — one-click tab capture              |

The web app can broadcast **directly from the browser** via `getDisplayMedia`,
so the extension is optional — install it only for one-click tab capture or
background broadcasting.

---

## Quick start — development

**Requires Node.js 20+.**

```bash
# 1. Clone and install
git clone <repo-url> peer-cast && cd peer-cast
npm install
npm run build:shared      # shared types must exist before the server or web app imports them

# 2. Terminal A — backend on :8787  (API + PeerJS signaling)
npm run dev:server

# 3. Terminal B — frontend on :5173  (/api and /peerjs are proxied to :8787)
npm run dev:web
```

Open <http://localhost:5173> and register an account.
In dev mode, if you haven't configured SMTP, **verification emails are printed
to the server terminal** — copy the link from there to verify your address.

> **Tip:** set `ADMIN_USERNAMES=yourhandle` and a random
> `ADMIN_BOOTSTRAP_SECRET` in `.env`. Enter that secret in the registration
> form only when creating the designated admin account.

---

## Quick start — production

### Automatic OCI deployment

Pushes to `master` are tested and then deployed automatically to the configured
Oracle Cloud VM by GitHub Actions. The deployment uses the existing
`peercast` systemd service and keeps SQLite data in `/opt/peercast-data`.

Configure these repository secrets before enabling the workflow:

| Secret                | Value                                 |
| --------------------- | ------------------------------------- |
| `OCI_HOST`            | The VM public IP or DNS name          |
| `OCI_USER`            | `opc`                                 |
| `OCI_SSH_PRIVATE_KEY` | The private key used to SSH to the VM |
| `OCI_KNOWN_HOSTS`     | Output of `ssh-keyscan -H <OCI_HOST>` |

The `production` environment can optionally require an approval before a
deployment. Pull requests run CI only; only successful pushes to `master`
deploy.

### Deploying a code change

The OCI workflow deploys the commit that lands on `master`; it does not deploy
every branch or pull request. A normal update is:

```bash
# Work on a feature branch
git switch -c fix/short-description

# Make changes, then run the relevant checks
npm run build
npm run typecheck
npm test

# Commit and publish the branch
git add <changed-files>
git commit -m "fix: describe the change"
git push -u origin fix/short-description
```

Open a pull request into `master`. After it is reviewed and merged, the merge
commit triggers the `CI` workflow. The `build-test` job must pass before
`Deploy to OCI` runs. A direct push to `master` also triggers deployment, but
pull-request runs by themselves never change production.

To monitor or troubleshoot a deployment:

1. Open the repository's **Actions** tab and select the `CI` workflow.
2. Open the run for the merge commit and confirm `build-test` succeeded.
3. Confirm `Deploy to OCI` succeeded. If the `production` environment requires
   approval, approve the waiting job before it can upload the release.
4. Verify the public endpoints after deployment:

   ```bash
   curl -fsS https://your-domain.example/api/health
   curl -fsS https://your-domain.example/api/config
   ```

The workflow packages the built shared, web, and server artifacts, uploads a
versioned release over SSH, restarts the `peercast` systemd service, and checks
`/api/health`. If activation or the health check fails, it restores the
previous release and fails the workflow. It does not replace the persistent
SQLite data directory.

### PWA and live-broadcast updates

The PWA downloads the new service worker and hashed assets automatically, but a
page that is already open continues running its previous JavaScript bundle.
After a deployment, viewers should refresh or reopen the page before testing
the change. A broadcaster must stop the current broadcast, close or fully
reload the PWA, and start a new broadcast so the host uses the new bundle.
Do not reload a broadcaster during an active broadcast unless ending that
broadcast is intentional.

If a deployment is healthy but an old page still behaves as before, close all
PeerCast tabs/windows and open the site again. Check the browser's network
requests for a newly hashed `assets/index-*.js` file before reproducing the
issue.

### Option A — Docker (recommended)

```bash
# 1. Copy and configure the environment file
cp .env.example .env
```

Open `.env` and set **at minimum**:

```dotenv
JWT_SECRET=<output of: openssl rand -hex 32>
PUBLIC_HOST=peercast.example.com   # your domain or public IP
PUBLIC_SECURE=true                  # you ARE putting this behind TLS, right?
APP_URL=https://peercast.example.com
ADMIN_USERNAMES=alice               # the handle you'll register as admin
ADMIN_BOOTSTRAP_SECRET=<separate random secret>
```

```bash
# 2. Build and start
docker compose up -d --build

# 3. (Optional) also start the bundled TURN relay for symmetric-NAT viewers
docker compose --profile turn up -d --build
```

The container serves **everything on one port** (default `8787`):

| Path      | What it serves              |
| --------- | --------------------------- |
| `/`       | The installable PWA         |
| `/api/*`  | The REST API                |
| `/peerjs` | The WebRTC signaling server |

Put it behind a TLS-terminating reverse proxy. HTTPS is **required** in
production — `getDisplayMedia` and secure WebRTC only work in a secure context.

<details>
<summary>Example Caddy config (simplest option)</summary>

```caddy
peercast.example.com {
  reverse_proxy localhost:8787
}
```

Caddy auto-provisions TLS via Let's Encrypt. That's it.
</details>

<details>
<summary>Example nginx config</summary>

```nginx
server {
    listen 443 ssl http2;
    server_name peercast.example.com;

    ssl_certificate     /etc/letsencrypt/live/peercast.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/peercast.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # required for WebSocket (PeerJS)
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

</details>

### Option B — Bare Node (no Docker)

```bash
npm install
npm run build
JWT_SECRET=$(openssl rand -hex 32) \
  NODE_ENV=production \
  PUBLIC_HOST=peercast.example.com \
  PUBLIC_SECURE=true \
  APP_URL=https://peercast.example.com \
  DATABASE_FILE=./data/peercast.db \
  ADMIN_USERNAMES=alice \
  node packages/server/dist/index.js
```

Or set all variables in a `.env` file and just run `npm start`.

---

## First-run checklist

After the server is up, work through this list in order.

### 1 — Register the admin account

Navigate to `https://your-domain/register` and create the account whose
username you put in `ADMIN_USERNAMES`. Enter `ADMIN_BOOTSTRAP_SECRET` in the
optional admin bootstrap field. The server promotes it to admin only when both
the configured handle and secret match. You'll see an **Admin** link appear in
the navigation bar.

> **Registration modes:** By default, registration is `open` — anyone can
> create an account. Lock this down after your initial setup if you want a
> private instance:
>
> | Mode             | Behaviour                       |
> | ---------------- | ------------------------------- |
> | `open` (default) | Anyone can register             |
> | `invite`         | A valid invite code is required |
> | `closed`         | No new registrations            |
>
> Switch mode by setting `REGISTRATION_MODE=invite` (or `closed`) in `.env`
> and restarting. A designated admin still needs the bootstrap secret for the
> first registration; keep that secret offline and do not commit it.

### 2 — Set up email (optional but strongly recommended)

Without email configured, verification links and password-reset links are
**printed to the server log** instead of sent. This is fine for a
single-operator instance where you can read the logs, but not for a
multi-user deployment.

Edit `.env`:

```dotenv
# Works with Resend, Mailgun, SendGrid, SES, Gmail, or a local Postfix.
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_SECURE=false          # use true for port 465
SMTP_USER=resend
SMTP_PASS=re_xxxxxxxxxxxx  # your API key / SMTP password
SMTP_FROM=PeerCast <noreply@yourdomain.com>
APP_URL=https://peercast.example.com   # used in the links inside emails
```

Restart the server. Now verify your admin email — click **Resend email** on
the Dashboard, or visit `/verify-email`.

> **Resend** (https://resend.com) is the easiest provider for self-hosted:
> free tier (100 emails/day), plain SMTP with `smtp.resend.com:587`, and a
> single API key as the SMTP password.
>
> For a truly self-contained server with no external dependencies, install
> `postfix` on the same host and use `SMTP_HOST=localhost SMTP_PORT=25`.

#### Hard vs soft verification

By default email verification is **soft** — users can log in and broadcast
while unverified, but see a yellow banner on the Dashboard with a resend
button. To require verification before login:

```dotenv
REQUIRE_EMAIL_VERIFICATION=true
```

### 3 — Configure a TURN server (for symmetric-NAT viewers)

Direct P2P connections fail when one side is behind a symmetric NAT (common
in corporate networks). A TURN relay solves this. See the
[TURN section](#turn-relay-symmetric-nat-viewers) below.

### 4 — Mint invite codes (if using invite mode)

Log in as an admin, go to **Admin → Invites**, and click **Generate code**.
You can set an optional max-use limit and expiry time. Share the code with
people you want to invite.

### 5 — Install the Chrome extension (optional)

If you want one-click tab capture or background broadcasting in addition to
the browser-based broadcaster:

1. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select `packages/extension/`.
2. Click the PeerCast icon, enter your **server URL**, username, and password.
3. Pick a title + access policy, then **Broadcast this tab** or **Broadcast screen…**.

Keyboard shortcuts: `Ctrl+Shift+Y` (start tab), `Ctrl+Shift+K` (toggle),
`Alt+Shift+P` (open popup). Customise at `chrome://extensions/shortcuts`.

---

## Features at a glance

| Feature                          | Details                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **True P2P**                     | Media flows directly viewer↔broadcaster over WebRTC. Only the brief signaling handshake uses a server. |
| **Find by @username**            | Viewers type `@alice` — the server maps username → current live peer ID.                               |
| **In-browser broadcaster**       | `getDisplayMedia` → PeerJS host, no extension required. Screen, window, or tab.                        |
| **Access control**               | Public, members-only (signed-in), or code-gated broadcasts. Two-gate enforcement.                      |
| **Admin/moderation**             | Ban users (evicted at signaling), broadcast takedown, report queue, role management.                   |
| **Invite codes**                 | `invite` registration mode; admins mint codes with optional max-uses and expiry.                       |
| **Email verification**           | Soft (banner) or hard (blocks login). Resend from dashboard.                                           |
| **Password reset**               | Forgot-password flow via email link (1-hour single-use token).                                         |
| **Live stats**                   | Viewers, bitrate, FPS, resolution — updated every 2 s on the broadcaster page.                         |
| **Viewer auto-reconnect**        | Drops and comes back up; last frame stays on screen while redialling.                                  |
| **Toast notifications**          | All user feedback via a global dismissible toast tray.                                                 |
| **Installable PWA**              | Service-worker shell for offline launch; Add to Home Screen.                                           |
| **Docker-ready**                 | Multi-stage image, single container, persistent SQLite volume.                                         |
| **Self-hosted PeerJS signaling** | No cloud dependency; your `/peerjs` broker handles all handshakes.                                     |
| **TURN relay**                   | Bundled `coturn` via `--profile turn` for symmetric-NAT viewers.                                       |

---

## Pages

| Page                   | URL                       | Who can access                                 |
| ---------------------- | ------------------------- | ---------------------------------------------- |
| **Landing**            | `/`                       | Everyone                                       |
| **Register**           | `/register`               | Unauthenticated (gated by `REGISTRATION_MODE`) |
| **Sign in**            | `/login`                  | Unauthenticated                                |
| **Forgot password**    | `/forgot-password`        | Everyone                                       |
| **Reset password**     | `/reset-password?token=…` | Link from email                                |
| **Verify email**       | `/verify-email?token=…`   | Link from email                                |
| **Watch**              | `/watch/:username`        | Everyone (access gates per broadcast)          |
| **Dashboard**          | `/dashboard`              | Authenticated                                  |
| **Broadcaster**        | `/broadcast`              | Authenticated                                  |
| **Settings**           | `/settings`               | Authenticated                                  |
| **Admin / Moderation** | `/admin`                  | Admin role                                     |

---

## How it works

```
Broadcaster (web page or extension)          PeerCast server (Node)
  getDisplayMedia() / tabCapture                ┌──────────────────────────┐
        │  fresh random peerId                  │ Express  /api/*          │
        ├── POST /api/broadcasts ───────────────▶│  SQLite (users,          │
        │        {peerId, access, ...}          │  broadcasts, tokens,     │
   PeerJS host  ◀── signaling ──────────────────▶│  invites, email tokens)  │
        │  (opaque signaling ticket, never JWT) │  PeerJS   /peerjs         │
        │                                        │ Static   /  (PWA)        │
        │                                        └──────────────────────────┘
Viewer (web page)                                        ▲
  GET /api/sessions/:username ── resolve peerId + ticket ─┘
  peer.call(peerId, dummy, { metadata:{ ticket } })
        ▲ WebRTC media (direct P2P) ◀── host verifies ticket per call
```

**Access control — two gates for non-public broadcasts:**

1. `GET /api/sessions/:username` only reveals the live peer ID to authorised
   callers (signed-in for _members_, correct code for _code_ broadcasts) and
   issues a short-lived access ticket.
2. The broadcaster host independently verifies each viewer's ticket via
   `POST /api/sessions/verify-ticket` before answering the call — so knowing
   the peer ID out-of-band is not enough.

**Auth:** bcrypt password hashing + stateless JWT access tokens (15 min) +
rotating refresh tokens (7 days, stored hashed, single-use). Passwords never
leave the server as plaintext beyond the TLS boundary.

---

## Security & identity model

- **No predefined admin, root, or superuser.** A fresh database is completely
  empty (schema created with `CREATE TABLE IF NOT EXISTS` — no seeding). The
  first account you register is just the first user, with no special powers.
- **Admins are bootstrapped with `ADMIN_USERNAMES` plus
  `ADMIN_BOOTSTRAP_SECRET`**. The handle alone never grants admin privileges.
- **Two roles: `user` and `admin`.** Regular users own only their own resources.
  Admins get the `/admin` moderation surface and can promote/demote others.
- **Registration modes** (`REGISTRATION_MODE`):
  - `open` — anyone can create an account (default).
  - `invite` — a valid invite code is required. Admins mint codes in
    **Admin → Invites**.
  - `closed` — no new registrations.
- **`JWT_SECRET` is critical.** Keep it secret and stable — rotating it
  invalidates all sessions. Never commit it. Generate with:
  `openssl rand -hex 32`.
- **Bans are enforced immediately** — `requireAuth` re-reads the user row on
  every request, so a ban takes effect without waiting for the current token to
  expire.
- No plaintext passwords are stored — bcrypt hashes only. Refresh tokens are
  hashed and single-use. Access tickets are peer-ID-bound and expire in 5
  minutes.

---

## Email — verification & password reset

PeerCast uses **Nodemailer** for all transactional email. It works with any
SMTP provider via a common configuration interface.

### Email providers

| Provider                          | SMTP host                           | Port | Notes                                                           |
| --------------------------------- | ----------------------------------- | ---- | --------------------------------------------------------------- |
| **Resend** (recommended for ease) | `smtp.resend.com`                   | 587  | Free 100/day; `SMTP_USER=resend`, API key as password           |
| **Mailgun**                       | `smtp.mailgun.org`                  | 587  | Free 1000/day trial                                             |
| **SendGrid**                      | `smtp.sendgrid.net`                 | 587  | `SMTP_USER=apikey`, API key as password                         |
| **AWS SES**                       | `email-smtp.<region>.amazonaws.com` | 587  | Needs verified domain                                           |
| **Gmail**                         | `smtp.gmail.com`                    | 587  | Requires an App Password                                        |
| **Self-hosted Postfix**           | `localhost`                         | 25   | Zero external dependency; install `postfix` on the same machine |

### Configuration

```dotenv
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_SECURE=false            # true for port 465 (SMTPS)
SMTP_USER=resend
SMTP_PASS=re_xxxxxxxxxxxx
SMTP_FROM=PeerCast <noreply@yourdomain.com>
APP_URL=https://peercast.example.com   # base URL embedded in email links
```

### Dev / offline mode (no SMTP configured)

If `SMTP_HOST` is not set, **emails are printed to the server log** instead of
sent:

```
[email] ─────────────────────────────────────
To:      alice@example.com
Subject: Verify your PeerCast email
─────────────────────────────────────────────
Hi Alice,

Please verify your email:
http://localhost:8787/verify-email?token=abc123...
─────────────────────────────────────────────
```

This is intentional — it makes development and single-operator deployments work
out of the box with zero SMTP setup.

### Email verification

All new accounts start with `emailVerified = false`. By default this is
**soft enforcement**: users can log in and broadcast, but see a yellow banner
on the Dashboard with a **Resend email** button.

To require verification before login:

```dotenv
REQUIRE_EMAIL_VERIFICATION=true
```

Verification flow:

1. User registers → verification email sent automatically.
2. User clicks the link → redirected to `/verify-email?status=ok`.
3. If the link expired, `/verify-email?status=invalid` is shown with an option
   to request a new one.
4. Logged-in users can resend from the Dashboard banner or by visiting
   `/verify-email` directly.

### Password reset

1. User visits `/forgot-password`, enters their email address.
2. Server always responds `200 OK` (prevents email enumeration).
3. If the email is registered, a reset link is emailed (`POST /api/auth/forgot-password`).
4. User clicks the link → arrives at `/reset-password?token=…`.
5. User enters a new password → old password immediately blocked, all existing
   sessions revoked (`POST /api/auth/reset-password`).
6. Reset tokens are **single-use** and expire after **1 hour**.

---

## Moderation in a peer-to-peer system

Media flows **directly host↔viewer over WebRTC** — the server never sees a
frame or audio sample, and v2 keeps no recording. **Content moderation in the
"scan what's on screen" sense is architecturally impossible.** That is the
deliberate privacy trade-off of true P2P.

What the server _does_ own is the **rendezvous** — identity, discovery,
ticketing, and the signaling server. PeerCast's moderation surface
(**`/admin`**, Reports · Users · Live · Invites tabs) controls those
chokepoints:

| Lever                                                          | Effect                                                                                                                  | Status               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **Ban** (`POST /admin/users/:u/ban`)                           | Revokes all sessions + refresh tokens, force-ends live broadcasts, blocks login; enforced on every subsequent request   | ✅                   |
| **Auth-gated signaling**                                       | A banned account's JWT is **rejected at the `/peerjs` WebSocket upgrade** — the peer never registers, no media can flow | ✅ (strongest lever) |
| **Discovery de-listing**                                       | Banned users' broadcasts vanish from `/broadcasts/live`, `/users/search`, and `/sessions/:u`                            | ✅                   |
| **Broadcast takedown** (`POST /admin/broadcasts/:id/takedown`) | Force-ends a specific live broadcast                                                                                    | ✅                   |
| **Reports** (`POST /api/reports`)                              | Anyone can flag a user/broadcast; admins triage in the Reports queue                                                    | ✅                   |
| **Role management** (`PUT /admin/users/:u/role`)               | Promote/demote admins                                                                                                   | ✅                   |

**Honest bottom line:** the server governs the rendezvous, not the pixels.
A banned user is undiscoverable and evicted from signaling, but the server
cannot terminate an already-established direct WebRTC connection, nor stop
a custom client that never presents a token. Peer IDs are random per
broadcast, so ending the host broadcast is what truly stops a broadcast.

---

## API surface (`/api`)

| Method                            | Path                             | Auth     | Purpose                                              |
| --------------------------------- | -------------------------------- | -------- | ---------------------------------------------------- |
| GET                               | `/health`                        | —        | Health check `{"ok":true}`                           |
| GET                               | `/config`                        | —        | Runtime config (signaling params, reg. mode)         |
| **Auth**                          |                                  |          |                                                      |
| POST                              | `/auth/register`                 | —        | Create account → `{accessToken, refreshToken, user}` |
| POST                              | `/auth/login`                    | —        | Sign in → `{accessToken, refreshToken, user}`        |
| POST                              | `/auth/refresh`                  | —        | Rotate refresh token → `{accessToken, refreshToken}` |
| POST                              | `/auth/logout`                   | Bearer   | Revoke current refresh token                         |
| POST                              | `/auth/logout-all`               | Bearer   | Revoke all sessions                                  |
| POST                              | `/auth/signaling-ticket`         | Bearer   | Mint short-lived opaque token for the PeerJS URL     |
| POST                              | `/auth/send-verification`        | Bearer   | (Re)send verification email                          |
| GET                               | `/auth/verify-email?token=`      | —        | Consume verification token → redirect                |
| POST                              | `/auth/forgot-password`          | —        | Send password-reset email (always 200)               |
| POST                              | `/auth/reset-password`           | —        | Set new password using reset token                   |
| **Profile**                       |                                  |          |                                                      |
| GET                               | `/users/me`                      | Bearer   | Own profile + settings                               |
| PUT                               | `/users/me`                      | Bearer   | Update display name / bio / avatar                   |
| PUT                               | `/users/me/settings`             | Bearer   | Broadcast defaults, discoverable flag                |
| PUT                               | `/users/me/password`             | Bearer   | Change password                                      |
| **Directory**                     |                                  |          |                                                      |
| GET                               | `/users/search?q=`               | —        | Search users + live broadcasts                       |
| GET                               | `/users/:username`               | —        | Public profile + live status                         |
| **Broadcasts**                    |                                  |          |                                                      |
| GET                               | `/broadcasts/live`               | —        | All currently live discoverable broadcasts           |
| GET                               | `/broadcasts/mine`               | Bearer   | Own broadcast history                                |
| POST                              | `/broadcasts`                    | Bearer   | Start a broadcast (register peer ID)                 |
| POST                              | `/broadcasts/:id/stats`          | Bearer   | Push live stats heartbeat                            |
| POST                              | `/broadcasts/:id/end`            | Bearer   | End own broadcast                                    |
| **Viewer sessions**               |                                  |          |                                                      |
| GET                               | `/sessions/:username`            | Optional | Resolve live peer ID + ticket                        |
| POST                              | `/sessions/verify-ticket`        | —        | Host verifies a viewer's access ticket               |
| **Reports**                       |                                  |          |                                                      |
| POST                              | `/reports`                       | Optional | File an abuse report                                 |
| **Admin** (requires `admin` role) |                                  |          |                                                      |
| GET                               | `/admin/users?q=`                | Admin    | User directory (includes banned)                     |
| GET                               | `/admin/users/:u`                | Admin    | Single user admin view                               |
| POST                              | `/admin/users/:u/ban`            | Admin    | Ban (revokes sessions + ends live)                   |
| POST                              | `/admin/users/:u/unban`          | Admin    | Restore access                                       |
| PUT                               | `/admin/users/:u/role`           | Admin    | Set role (`user` \| `admin`)                         |
| DELETE                            | `/admin/users/:u`                | Admin    | Permanently delete account + all data (irreversible) |
| POST                              | `/admin/broadcasts/:id/takedown` | Admin    | Force-end any broadcast                              |
| GET                               | `/admin/reports?status=`         | Admin    | Report queue (open \| resolved \| dismissed \| all)  |
| POST                              | `/admin/reports/:id/resolve`     | Admin    | Mark resolved or dismissed                           |
| GET                               | `/admin/invites`                 | Admin    | List invite codes                                    |
| POST                              | `/admin/invites`                 | Admin    | Generate a new invite code                           |
| POST                              | `/admin/invites/:code/disable`   | Admin    | Disable a code                                       |

---

## Configuration reference

All configuration is via **environment variables**. Copy `.env.example` to
`.env` and edit. Variables marked **required in production** will either cause
a startup warning or break the feature if unset.

### Server

| Variable        | Default                   | Required  | Description                                                   |
| --------------- | ------------------------- | --------- | ------------------------------------------------------------- |
| `PORT`          | `8787`                    | —         | HTTP port                                                     |
| `HOST`          | `0.0.0.0`                 | —         | Bind address                                                  |
| `NODE_ENV`      | `development`             | —         | Set to `production` in production                             |
| `PUBLIC_HOST`   | `localhost`               | **Yes**   | Domain / IP advertised to clients for PeerJS signaling        |
| `PUBLIC_SECURE` | `false`                   | **Yes**   | `true` when serving over HTTPS/WSS                            |
| `APP_NAME`      | `PeerCast`                | —         | Displayed in the UI and email subjects                        |
| `APP_URL`       | `http://localhost:<PORT>` | **Email** | Base URL embedded in email links — must be publicly reachable |

### Auth & sessions

| Variable              | Default               | Required | Description                                                                                                |
| --------------------- | --------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`          | _(random, ephemeral)_ | **Yes**  | Signs all JWT tokens. Generate: `openssl rand -hex 32`. Changing it invalidates all sessions.              |
| `JWT_ACCESS_TTL`      | `15m`                 | —        | Access token lifetime (any `ms`-compatible string)                                                         |
| `JWT_REFRESH_TTL_SEC` | `604800` (7 days)     | —        | Refresh token lifetime in seconds                                                                          |
| `COOKIE_SAME_SITE`    | `strict`              | —        | Refresh-cookie SameSite: `strict` (single-origin default) \| `lax` \| `none` (cross-origin, forces Secure) |

> **Single-origin by design.** The refresh token ships as an HttpOnly cookie
> scoped to `Path=/api/auth` with `SameSite=Strict` by default. The PWA, the
> API, and the PeerJS signaling server are all served from the **same origin**
> (one process behind one TLS terminator), so the cookie works fully
> automatically. If you absolutely must split origins, set `COOKIE_SAME_SITE=none`
> (requires HTTPS + `PUBLIC_SECURE=true`); otherwise refresh-token rotation will
> not cross the origin boundary and clients must re-authenticate when the access
> token expires.

### Data

| Variable        | Default              | Required | Description                                               |
| --------------- | -------------------- | -------- | --------------------------------------------------------- |
| `DATABASE_FILE` | `./data/peercast.db` | —        | SQLite file path. Mount as a Docker volume in production. |

### Admin & access control

| Variable                     | Default  | Required | Description                                                                            |
| ---------------------------- | -------- | -------- | -------------------------------------------------------------------------------------- |
| `ADMIN_USERNAMES`            | _(none)_ | —        | Comma-separated handles allowed to use the operator-controlled admin bootstrap secret. |
| `ADMIN_BOOTSTRAP_SECRET`     | _(none)_ | —        | Secret required with a configured handle to bootstrap its first admin account.         |
| `REGISTRATION_MODE`          | `open`   | —        | `open` (anyone) \| `invite` (needs a code) \| `closed` (no new accounts)               |
| `REQUIRE_EMAIL_VERIFICATION` | `false`  | —        | `true` = hard-block login until email verified. Default is soft (banner only).         |

### Signaling (PeerJS)

| Variable      | Default       | Required | Description                                                                                                                         |
| ------------- | ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `SIGNAL_PATH` | `/peerjs`     | —        | URL path of the PeerJS broker                                                                                                       |
| `SIGNAL_KEY`  | `peercast`    | —        | PeerJS connection key                                                                                                               |
| `SIGNAL_HOST` | `PUBLIC_HOST` | —        | Hostname clients connect to for signaling                                                                                           |
| `SIGNAL_PORT` | `PORT`        | —        | Port clients connect to for signaling                                                                                               |
| `ICE_SERVERS` | Google STUN   | —        | JSON array of STUN/TURN servers advertised to all clients via `/api/config`. See [TURN section](#turn-relay-symmetric-nat-viewers). |

### Email (Nodemailer / SMTP)

All SMTP variables are optional. When `SMTP_HOST` is unset, emails are printed
to stdout (see [Dev / offline mode](#dev--offline-mode-no-smtp-configured)).

| Variable      | Default                             | Description                                                  |
| ------------- | ----------------------------------- | ------------------------------------------------------------ |
| `SMTP_HOST`   | _(unset → stdout)_                  | SMTP server hostname, e.g. `smtp.resend.com`                 |
| `SMTP_PORT`   | `587`                               | SMTP port (587 for STARTTLS, 465 for SMTPS)                  |
| `SMTP_SECURE` | `false`                             | `true` for SMTPS (port 465); `false` for STARTTLS (port 587) |
| `SMTP_USER`   | _(unset)_                           | SMTP username (e.g. `resend`, `apikey`)                      |
| `SMTP_PASS`   | _(unset)_                           | SMTP password or API key                                     |
| `SMTP_FROM`   | `PeerCast <noreply@peercast.local>` | `From:` address in sent emails                               |

### CORS & networking

| Variable       | Default           | Description                                     |
| -------------- | ----------------- | ----------------------------------------------- |
| `CORS_ORIGINS` | `*`               | Comma-separated allowed origins, or `*` for any |
| `WEB_DIST`     | _(auto-detected)_ | Override path to the built PWA directory        |

---

## TURN relay (symmetric-NAT viewers)

Direct WebRTC connections (host candidates + STUN) fail when either party is
behind a **symmetric NAT** — common on corporate networks, some mobile carriers,
and certain home routers. A TURN relay provides a fallback.

> **Privacy note:** In direct P2P mode both the broadcaster and each viewer
> can see each other's IP address — this is inherent to WebRTC and independent
> of any server-side privacy measures. If a participant needs to hide their IP,
> configure a TURN server and set
> `iceTransportPolicy: 'relay'` in their browser. The `ICE_SERVERS` config
> already points all clients at the relay; adding `'relay'` forces traffic
> through it so direct host candidates (and IP addresses) are never exchanged.

### With the bundled coturn container

```bash
# Edit turn/turnserver.conf first:
#   - Set external-ip=<your public IP>
#   - Set UNIQUE credentials (CHANGE_ME_USERNAME / CHANGE_ME_CREDENTIAL)
#   - Open UDP 3478 and the relay range 49160-49200 on your firewall

# Update .env with the matching credentials:
ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:YOUR_HOST:3478","username":"CHANGE_ME_USERNAME","credential":"CHANGE_ME_CREDENTIAL"}]

# Start PeerCast + coturn:
docker compose --profile turn up -d --build
```

On **Linux** the coturn container uses `network_mode: host` (recommended —
avoids port-mapping the entire relay range). On **Docker Desktop** (macOS /
Windows), comment out `network_mode: host` in `docker-compose.yml` and
uncomment the explicit port mappings.

### With an external TURN service

Set `ICE_SERVERS` to a JSON array referencing your provider's credentials:

```dotenv
ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.yourdomain.com:3478","username":"user","credential":"pass"}]
```

The server advertises this via `GET /api/config`, so all clients — the web
viewer, the web broadcaster, and the Chrome extension — pick it up
automatically without any additional configuration.

---

## The Chrome extension (optional)

The browser-based broadcaster (`/broadcast`) is the primary way to go live,
but the extension offers advantages for specific use cases:

- **Whole-tab capture with audio** — the browser's `getDisplayMedia` can
  capture a tab's audio only on Chrome; the extension uses `tabCapture` which
  always includes audio.
- **Background broadcasting** — the capture and PeerJS host live in an offscreen
  document that survives popup/tab closes.
- **Keyboard shortcuts** — go live in one keystroke without opening the app.

### Install

1. `chrome://extensions` → enable **Developer mode** (top-right toggle).
2. Click **Load unpacked** → select the `packages/extension/` folder.
3. Pin the PeerCast icon to the toolbar.

### First use

Click the icon and fill in:

| Field          | What to enter                                             |
| -------------- | --------------------------------------------------------- |
| **Server URL** | Your PeerCast server, e.g. `https://peercast.example.com` |
| **Username**   | Your registered @handle                                   |
| **Password**   | Your account password                                     |

Click **Sign in**. From then on, use the popup to configure your broadcast
title and access policy before going live.

### Keyboard shortcuts

| Shortcut       | Action                               |
| -------------- | ------------------------------------ |
| `Ctrl+Shift+Y` | Broadcast the current tab            |
| `Ctrl+Shift+K` | Toggle (start if idle, stop if live) |
| `Alt+Shift+P`  | Open the PeerCast popup              |

Customise at `chrome://extensions/shortcuts`. On Linux, `Alt+Shift` is often
grabbed by the layout switcher — remap if needed.

---

## Testing

```bash
npm test                 # Vitest: server (78 tests) + web (8 tests) unit tests
npm run test:e2e         # build → Playwright E2E (5 tests: UI flows + real WebRTC)

# First time only — downloads the Playwright browser
npm -w @peer-cast/e2e run install-browser
```

### What the tests cover

**Server unit tests** (`packages/server/test/`):

| File                    | What it covers                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `auth.test.ts`          | Register, duplicate detection, login, token refresh rotation, auth guards                                              |
| `access.test.ts`        | Public / members / code broadcast gating, ticket verify, `peerId` never leaks                                          |
| `broadcasts.test.ts`    | Start ends previous, stats + peak tracking, owner-only end, code validation                                            |
| `admin.test.ts`         | Ban (blocks login + live + signaling), unban, takedown, role change, reports                                           |
| `invites.test.ts`       | Mode gating, invite consume/exhaust/expire/disable, admin-only mint, bootstrap bypass                                  |
| `email.test.ts`         | Verification redirect, expired/invalid tokens, resend, `REQUIRE_EMAIL_VERIFICATION`, password reset, single-use tokens |
| `notifications.test.ts` | Follows (follow/unfollow/listing/self-follow), push subscriptions, follower notification on go-live, VAPID key gating  |
| `recordings.test.ts`    | Chunked upload + finalize + byte-accurate streaming (incl. HTTP Range), ownership gating, size cap, delete cleanup     |

**Web unit tests** (`packages/web/src/**/*.test.*`):
Auth slice (login/rotate/logout + localStorage persistence), BroadcastCard rendering,
P2P chat protocol (pack/unpack + relaying rules) in `lib/peer.test.ts`.

**Playwright E2E** (`tests/e2e/specs/`):
Landing page renders; register → discover live broadcast → **receive real P2P video**;
offline viewer message; banned account evicted at signaling handshake;
raw two-peer WebRTC session over self-hosted `/peerjs`.

---

## Development commands

```bash
npm run build:shared     # must run first; web + server import from its dist/
npm run build            # full build: shared → web → server
npm run build:web        # rebuild the PWA only
npm run build:server     # rebuild the server only

npm run dev:server       # API + signaling with hot-reload (tsx watch), :8787
npm run dev:web          # Vite dev server, :5173 (proxies /api + /peerjs → :8787)

npm run typecheck        # typecheck all TS packages
npm run format           # prettier --write .

npm -w @peer-cast/extension run check   # node --check all extension JS files
```

---

## Limitations

- **DRM content** (Netflix, Disney+…) refuses `tabCapture` — by browser design.
- **System audio** on screen/window capture depends on the OS and browser. Windows
  full-screen mode typically works; macOS window capture is video-only.
- **Symmetric NAT** requires a TURN server (see above).
- **Recording / replay** is not implemented in v2 — broadcast history stores
  metadata and stats only. See `ROADMAP.md`.
- **WebRTC exposes participant IPs.** In direct P2P mode both parties' IP
  addresses are visible to each other. Force relay-only mode (`iceTransportPolicy:
'relay'`) and deploy a TURN server to avoid this.

---

See `AGENTS.md` for contributor conventions, `ROADMAP.md` for what's planned,
and `CRYPTO.md` for the original cryptographic-ownership design (historical,
superseded in v2 by the registry-backed identity model).

---

## License

[MIT](LICENSE) © PeerCast contributors
