# AGENTS.md — PeerCast (Node.js edition, v2)

Guidance for AI agents (and humans) working on the **`webapp-nodejs`** branch.

## What this is

A self-hosted, Cloudflare-independent rewrite of PeerCast. Everything runs on
Node.js: REST API, PeerJS signaling, SQLite storage, and the installable React
PWA — served from one process, deployable via Docker/Podman or bare Node on any
device (VPS, laptop, Raspberry Pi).

> The original Cloudflare-Workers edition is preserved on the `serverless`
> branch. Do not port Workers/D1/KV concepts back here.

## Monorepo layout

```
peer-cast/
├── packages/
│   ├── shared/      TS types: domain models (models.ts) + API contracts (api.ts).
│   │               Built to dist/ and consumed by server + web as @peer-cast/shared.
│   ├── server/      Node + Express + better-sqlite3 + JWT + PeerJS + Nodemailer.
│   │   └── src/
│   │       ├── index.ts          bootstrap: promote admins on boot, listen
│   │       ├── app.ts            configureApp() — all middleware + routes, testable
│   │       ├── config.ts         env-driven config (dotenv)
│   │       ├── db/index.ts       better-sqlite3 connection + idempotent schema + ALTER migrations
│   │       ├── lib/
│   │       │   ├── auth.ts       bcrypt, JWT, refresh tokens, tickets, purgeExpired
│   │       │   ├── email.ts      Nodemailer transporter, sendEmail(), HTML templates
│   │       │   └── errors.ts     AppError + helpers (badRequest, unauthorized, forbidden…)
│   │       ├── middleware/       requireAuth / optionalAuth / requireAdmin, asyncHandler, errorHandler
│   │       ├── repos/
│   │       │   ├── users.ts      all user SQL (includes ban/role/email-verified methods)
│   │       │   ├── broadcasts.ts all broadcast SQL
│   │       │   ├── reports.ts    abuse report SQL
│   │       │   ├── invites.ts    invite-code SQL (atomic consume)
│   │       │   └── emailTokens.ts  email verification + password-reset tokens
│   │       ├── routes/
│   │       │   ├── auth.ts       register/login/refresh/logout + registration mode gate
│   │       │   ├── email.ts      send-verification, verify-email, forgot/reset-password
│   │       │   ├── users.ts      profile, settings, password change, public profile
│   │       │   ├── broadcasts.ts live/mine/start/stats/end
│   │       │   ├── sessions.ts   resolve + verify-ticket
│   │       │   ├── reports.ts    create report
│   │       │   ├── admin.ts      all admin-gated endpoints (ban, takedown, reports, invites)
│   │       │   └── config.ts     runtime config (signal params, registration mode)
│   │       └── signaling/
│   │           └── peerServer.ts ExpressPeerServer + WS upgrade guard for banned accounts
│   ├── web/         Vite + React + Redux Toolkit (+RTK Query) + Tailwind + vite-plugin-pwa.
│   │   └── src/
│   │       ├── store/
│   │       │   ├── index.ts       configureStore, RootState, typed hooks
│   │       │   ├── api.ts         RTK Query: all endpoints + tag invalidation
│   │       │   ├── authSlice.ts   JWT tokens + SelfUser, persisted to localStorage
│   │       │   └── toastSlice.ts  global toast queue (addToast / dismissToast)
│   │       ├── lib/peer.ts        PeerJS wrapper: connectAsViewer + BroadcastHost
│   │       ├── components/
│   │       │   ├── Layout.tsx     header nav (admin link if role=admin), footer
│   │       │   ├── Toasts.tsx     fixed bottom-right toast tray
│   │       │   ├── Modal.tsx      reusable overlay dialog
│   │       │   ├── BroadcastCard, Avatar, IllustratedMessage, Spinner
│   │       │   ├── ProtectedRoute.tsx  requires auth
│   │       │   └── AdminRoute.tsx      requires auth + admin role
│   │       └── pages/
│   │           ├── LandingPage       hero + live feed + search
│   │           ├── LoginPage         sign in + "Forgot password?" link
│   │           ├── RegisterPage      invite-code field when mode=invite, closed message
│   │           ├── ForgotPasswordPage  email input → sends reset link
│   │           ├── ResetPasswordPage   token from URL → new password form
│   │           ├── VerifyEmailPage     token/status from URL + resend UI
│   │           ├── DashboardPage     profile, history, email-unverified banner
│   │           ├── BroadcastPage     getDisplayMedia + BroadcastHost + live stats
│   │           ├── ViewerPage        resolve → P2P connect → play + report button
│   │           ├── SettingsPage      profile, avatar, password, defaults
│   │           ├── AdminPage         Reports / Users / Live / Invites tabs
│   │           └── NotFoundPage
│   └── extension/   Chrome MV3 (optional broadcaster). Vanilla JS, no build step.
│       ├── background.js  JWT auth, session state, builds START payload, stats forward
│       ├── offscreen.js   tabCapture/getDisplayMedia, PeerJS host, ticket verify, bitrate
│       ├── popup.html/js/css  self-contained login + broadcast controls (plain CSS)
│       └── lib/api-client.js  PeerCastApi global (importScripts + <script> compatible)
├── tests/e2e/       Playwright: UI flows + raw WebRTC + moderation/signaling eviction.
├── turn/            coturn config for the optional bundled TURN relay.
├── Dockerfile · docker-compose.yml · .env.example
├── package.json     npm workspaces root; version SSOT (2.0.0)
├── tsconfig.base.json
├── README.md · AGENTS.md · ROADMAP.md · CRYPTO.md (historical)
```

## Commands (from repo root)

```bash
npm install
npm run build:shared     # ALWAYS build shared first — server + web import from dist/
npm run build            # shared → web → server
npm run typecheck        # typecheck all TS packages
npm run format           # prettier --write .

npm run dev:server       # API + signaling, tsx watch, :8787
npm run dev:web          # Vite dev server, :5173 (proxies /api + /peerjs)

npm -w @peer-cast/extension run check   # node --check all extension JS

npm test                 # server + web unit tests (Vitest, 98 tests)
npm run test:e2e         # full build + Playwright E2E (5 tests)
npm -w @peer-cast/e2e run install-browser   # one-time: download Playwright browser

docker compose up -d --build                   # single-container production
docker compose --profile turn up -d --build    # + bundled coturn TURN relay
```

## Hard rules

1. **Build `@peer-cast/shared` first.** server + web import it via the workspace
   symlink → `dist/`. If `dist/` is missing, both fail. Run `npm run build:shared`
   (or `npm run build`) before any server/web dev or typecheck.

2. **All SQL lives in `repos/`.** Routes never touch the DB directly. Keep the
   `better-sqlite3` prepared-statement style; it is synchronous — no `await`.

3. **`peerId` is a secret for non-public broadcasts.** Never expose it in list /
   search / profile responses. `broadcastsRepo.toBroadcast()` maps `peerId: null`
   by default; only `GET /api/sessions/:username` reveals it (after access
   checks) by reading `peer_id` directly from the raw row.

4. **Two-gate access control must stay intact.** (1) server withholds peerId +
   issues ticket; (2) broadcaster host verifies the ticket per call via
   `/api/sessions/verify-ticket`. Gate 1 alone is insufficient.

5. **PeerJS ≥1.x rejects `peer.call(id, null)`.** Viewers pass a real dummy
   stream — see `dummyStream()` in `web/src/lib/peer.ts`.

6. **Web app is the primary broadcaster** via `getDisplayMedia`. Extension is
   optional and mirrors the same API contract. Both POST to `/api/broadcasts`
   with a fresh random `peerId`, then host a PeerJS peer answering calls.

7. **PeerJS signaling is self-hosted** at `/peerjs` (key `peercast`). Clients
   derive `host/port/secure` from `window.location` and take `path+key` from
   `GET /api/config`. Never hardcode the PeerJS cloud.

8. **HTTPS is mandatory in production.** `getDisplayMedia` + secure WebRTC
   require a secure context. Set `PUBLIC_SECURE=true` behind TLS.

9. **Extension pages are plain, self-contained.** `popup.*` uses hand-written
   CSS (no Tailwind build). `api-client.js` is a global (`var PeerCastApi`) so
   it loads via both `importScripts` (service worker) and `<script>` (offscreen
   / popup) without ES module machinery.

10. **Offscreen cannot read `chrome.storage` reliably.** All session writes go
    through `background.js` via `{target:"background", type:"STATE_PATCH"}`.
    Config arrives in the START message.

11. **tabCapture token is minted in the popup under the genuine click**, then
    passed via `START_TAB_CAST`. The `chromeMediaSourceId` constraint key is
    required (not `chromeMediaStreamId`).

12. **JWT_SECRET must be set in production** or sessions reset every restart.
    The config module warns and uses a random ephemeral secret as a fallback.

13. **Version SSOT is root `package.json`** (2.0.0). Keep the extension
    `manifest.json`, extension `package.json`, and `server/src/config.ts`
    `APP_VERSION` default in sync.

14. **SQLite path is a Docker volume** (`/data`). Never commit `*.db` files.

15. **Admin is opt-in via `ADMIN_USERNAMES`.** A fresh DB is empty — no implicit
    first-user-is-admin. Designated handles are promoted on register/login and
    on every boot. They can **always register** even in `invite`/`closed` mode
    (bootstrap). Two roles only: `user` | `admin`. Bans are enforced on every
    authenticated request (`requireAuth` re-reads the live row) — keep this.
    `REGISTRATION_MODE` (open|invite|closed) gates non-admin registration; invite
    codes live in the `invites` table, minted via `/admin`.

16. **Moderation is rendezvous-only, by design.** The server never sees media.
    Implemented levers: ban (revoke sessions + force-end live + block login +
    announce), broadcast takedown, discovery de-listing, reports, role
    management, and **auth-gated signaling** — a banned account is rejected at
    the `/peerjs` WebSocket upgrade (in `signaling/peerServer.ts`) before OPEN
    is sent. Clients authenticate signaling with a short-lived opaque ticket
    minted by `POST /api/auth/signaling-ticket` (never the raw JWT, which would
    leak into reverse-proxy logs). The server resolves tickets to the account
    and can fall back to a raw JWT for old clients. Anonymous peers (no token
    or unrecognised token) are allowed; on reconnect a consumed ticket falls
    back to anonymous — this is by design. Don't imply server-side content
    control.

17. **Email tokens are short-lived and single-use.** Verification: 24 h, revoked
    on re-issue (only one live token per user at a time). Reset: 1 h, single-use
    (deleted on first consumption, whether valid or expired). `consumeReset`
    always deletes the row — a second attempt always fails. Never reuse tokens.

18. **Email → stdout fallback is intentional.** When `SMTP_HOST` is unset,
    `sendEmail()` prints to stdout instead of throwing. Do not change this to a
    throw — it is what makes dev and single-operator deployments work without
    SMTP config. The fallback message format must remain human-readable in the
    log.

19. **`sendEmail` is always fire-and-forget** from routes — never `await` it in
    the HTTP response path. Registration sends a verification email best-effort;
    if the send fails, registration still succeeds. Wrap `sendEmail` calls in
    `try/catch` and never let email failures propagate to the HTTP response.

20. **Malformed JSON bodies → 400, not 500.** The `errorHandler` catches
    `SyntaxError` with `status === 400` (set by body-parser) and returns
    `{error:"invalid JSON body", code:"BAD_JSON"}`. Do not remove this case.

## Data model (SQLite — `packages/server/src/db/index.ts`)

Tables are created with `CREATE TABLE IF NOT EXISTS`. Missing columns on
pre-existing databases are added with `ensureColumn()` (ALTER TABLE).

| Table                 | Key columns                                                                                                                                           | Notes                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `users`               | `username_lc` PK, `email` UNIQUE, `password_hash`, `role`, `email_verified`, `banned`, `banned_reason`, `banned_at`, `default_access`, `discoverable` | `username` = display-case; `username_lc` = lowercased canonical key |
| `broadcasts`          | `id`, `username_lc` FK, `status` (live\|ended), `access`, `peer_id` (null once ended), `access_code`, `started_at`, stat_* columns                    | stat_* cleared on end                                               |
| `refresh_tokens`      | `token_hash` PK, `username_lc` FK, `expires_at`                                                                                                       | Stored SHA-256 hashed; rotating                                     |
| `tickets`             | `ticket` PK, `username_lc`, `peer_id`, `expires_at`                                                                                                   | Short-lived (5 min), peer-ID-bound                                  |
| `reports`             | `id`, `target_username`, `broadcast_id`, `reporter_username`, `reason`, `status` (open\|resolved\|dismissed)                                          |                                                                     |
| `invites`             | `code` PK, `max_uses`, `uses`, `expires_at`, `disabled`                                                                                               | Atomic consume with `uses < max_uses` check                         |
| `email_verifications` | `token` PK, `username_lc`, `expires_at`                                                                                                               | 24 h TTL; old token deleted on re-issue                             |
| `password_resets`     | `token` PK, `username_lc`, `expires_at`                                                                                                               | 1 h TTL; row deleted on any consume attempt                         |

Shared TS shapes: `packages/shared/src/models.ts` — update DB schema + shared
types together.

## Message protocol (extension: popup ↔ background ↔ offscreen)

| Message              | From → To              | Purpose                                                              |
| -------------------- | ---------------------- | -------------------------------------------------------------------- |
| `STORE_AUTH`         | popup → background     | Save `{token, username}` + serverUrl (JWT session)                   |
| `SIGN_OUT`           | popup → background     | Stop if live, clear auth                                             |
| `GET_PROFILE`        | popup → background     | `{ serverUrl, loggedIn, username }`                                  |
| `SET_BROADCAST_META` | popup → background     | Persist chosen `{title, access, accessCode}`                         |
| `START_TAB_CAST`     | popup → background     | Start tab capture (streamId minted in popup)                         |
| `PICK_DESKTOP_MEDIA` | popup → background     | Open native screen picker (+ meta)                                   |
| `STOP_BROADCAST`     | popup → background     | Stop                                                                 |
| `START` / `STOP`     | background → offscreen | Host lifecycle (START carries signalConfig + opaque signaling token) |
| `STATE_PATCH`        | offscreen → background | Session state (viewers/bitrate → forwarded to API)                   |
| `ANNOUNCE_SESSION`   | offscreen → background | Go-live w/ peerId → background POSTs `/api/broadcasts`               |
| `GET_STREAM_ID`      | offscreen → background | Re-mint a tab capture token for retry                                |

## Verification checklist before handing back

- [ ] `npm run build` succeeds (shared → web → server).
- [ ] `npm run typecheck` clean for all three TS packages.
- [ ] `npm test` green — 87 server tests + 11 web tests.
- [ ] `npm run test:e2e` green — 5 Playwright tests (UI, WebRTC, moderation).
- [ ] `npm -w @peer-cast/extension run check` passes.
- [ ] `npx prettier --check .` clean.
- [ ] Server boots, `GET /api/health` → `{ok:true}`, `GET /peerjs` serves the
      PeerJS info JSON, `GET /api/config` includes `registration` field.
- [ ] Access gates: anon resolve of members/code broadcast → 401/403 + no peerId;
      authed resolve → peerId + ticket; `verify-ticket` ok only for matching
      peerId. (`test/access.test.ts`)
- [ ] `peerId` absent from `/broadcasts/live`, `/users/search`, `/users/:u`.
- [ ] Moderation: ban blocks login/announce + force-ends live + evicts at WS
      upgrade; admin routes 403 for non-admins; reports create/resolve; invite
      codes create/consume/exhaust/expire/disable; admin bootstrap bypass works
      in invite/closed mode; `DELETE /admin/users/:u` hard-deletes the account
      and cascades (admin-only, self-delete blocked). (`test/admin.test.ts`,
      `test/invites.test.ts`, `tests/e2e/specs/moderation.spec.ts`)
- [ ] Email: verification token consumed correctly → `email_verified=1`; invalid/
      expired token → `status=invalid` redirect; `forgot-password` always 200;
      reset token single-use, 1 h expiry; `REQUIRE_EMAIL_VERIFICATION` blocks
      unverified login. (`test/email.test.ts`)
- [ ] Email stdout fallback: with `SMTP_HOST` unset, `sendEmail()` logs to stdout
      and does NOT throw.
- [ ] If web pages/styles changed: `npm run build:web` and verify in a browser.
- [ ] Docker: `docker compose up --build` → container starts, serves PWA + API + signaling, runs as unprivileged `node` user.
