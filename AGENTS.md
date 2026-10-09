# AGENTS.md — PeerCast

Guidance for AI agents (and humans) working on PeerCast.

## What this is

A self-hosted, Cloudflare-independent P2P broadcasting app. Everything runs on
Node.js: REST API, PeerJS signaling, SQLite storage, and the installable React
PWA — served from one process, deployable via Docker/Podman or bare Node on any
device (VPS, laptop, Raspberry Pi).

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
├── package.json     npm workspaces root; version SSOT
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

npm test                 # server + web unit tests (Vitest, 129 tests)
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

   **Withholding `peerId` is not enough for a gated broadcast.** Existence,
   title, owner and audience size are themselves what `access: code` /
   `authenticated` was chosen to conceal. Discovery queries therefore filter on
   `access = 'public'`, and `GET /api/broadcasts/:id` plus the profile live card
   return 404 / null for callers who may not see the stream
   (`broadcastsRepo.canViewMetadata`). Keep all three together — adding a
   discovery query without the `access` filter re-leaks gated streams.

4. **Two-gate access control must stay intact.** (1) server withholds peerId +
   issues ticket; (2) broadcaster host verifies the ticket per call via
   `/api/sessions/verify-ticket`. Gate 1 alone is insufficient. Gate 2 must
   complete **before** the host answers: `call.answer(stream)` begins sending
   frames immediately, so verifying afterwards hands the broadcast to anyone
   who merely learned the peerId. Both hosts (`BroadcastHost` in
   `packages/web/src/lib/peer.ts` and `answerCall` in
   `packages/extension/offscreen.js`) must fail **closed** — an unverifiable
   ticket or a missing server URL means decline, never skip.

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

   **`TRUST_PROXY_HOPS` is a security control, not a convenience setting.** It
   sets `req.ip`, the key for every IP-rate-limited endpoint. Default `0`
   (trust nothing) is correct for direct connections; an operator terminating
   TLS at Caddy/nginx MUST set it to their hop count or every visitor behind
   the proxy shares one bucket and locks each other out. Never infer it from
   `NODE_ENV` — there is no safe default, so it is explicit and logged at boot.
   HSTS is keyed off this (plus `PUBLIC_SECURE`), not off `PUBLIC_SECURE`
   alone, so a proxied deploy still gets the header.

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

13. **Version SSOT is root `package.json`.** `npm run check:versions` asserts
    every version-carrying file matches it (workspace `package.json`s,
    extension `manifest.json` + `package.json`, `openapi.yaml`, image tag,
    popup badge). Do NOT copy the version into code or docs — derive it from
    the root manifest. This includes `server/src/config.ts`: its fallback is a
    marker (`dev`), never a literal version. Set `APP_VERSION` to override.
    **Bump with `npm version <x.y.z>` from the repo root** — npm only rewrites
    the root manifest, so a `version` lifecycle hook
    (`scripts/sync-version.mjs`) mirrors it into every carrier _before_ npm
    commits and tags, and a `postversion` hook re-runs the checker. Both share
    the file list in `scripts/version-files.mjs` with the checker so the fixer
    and the guard can't drift apart. The fixer stages what it changed because
    npm otherwise stages only `package.json` + the lockfile, which would leave
    the tag pointing at a commit with stale carriers. `npm version --workspaces`
    bypasses root lifecycle hooks entirely — don't use it here. To repair
    drift by hand: `npm run sync:versions` (`-- --dry-run` to preview).

14. **SQLite path is a Docker volume** (`/data`). Never commit `*.db` files.

15. **Admin is opt-in via `ADMIN_USERNAMES` + `ADMIN_BOOTSTRAP_SECRET`.** A fresh
    DB is empty — no implicit first-user-is-admin, and a claimable username
    never grants admin. The configured handle must supply the operator secret
    during first registration. Two roles only: `user` | `admin`. Bans are enforced on every
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

    **Peer ids are unique by construction — do not re-implement this.** An audit
    once claimed a second socket could claim a live broadcaster's `peerId` and
    shadow its inbound calls, and proposed a binding layer in `peerServer.ts`.
    That is wrong: the `peer` package calls `getClientById` on every registration
    and answers `ID-TAKEN` (surfacing client-side as `unavailable-id`) unless the
    socket presents the _same_ per-client token, which only the incumbent holds.
    A home-grown binding layer duplicates that and risks evicting a legitimate
    reconnecting peer. `tests/e2e/specs/peer-id-shadow.spec.ts` pins the upstream
    behaviour — if it fails after a PeerJS bump, the guarantee is genuinely gone.

17. **Email tokens are short-lived and single-use.** Verification: 24 h, revoked
    on re-issue (only one live token per user at a time). Reset: 1 h, single-use
    (deleted on first consumption, whether valid or expired). `consumeReset`
    always deletes the row — a second attempt always fails. Never reuse tokens.
    `emailTokensRepo.purgeExpired()` runs from `housekeeping()` in `index.ts` —
    these are unreferenced bearer credentials once expired, so never let them
    accumulate.

18. **Email → stdout fallback is intentional.** When `SMTP_HOST` is unset,
    `sendEmail()` prints to stdout instead of throwing. Do not change this to a
    throw — it is what makes dev and single-operator deployments work without
    SMTP config. The fallback message format must remain human-readable in the
    log, **including the recovery link**: with no SMTP the log is the only
    delivery channel, so redacting the token makes verification and password
    reset impossible. `EMAIL_REDACT_LINKS=true` is the opt-in escape hatch for
    operators who must ship logs somewhere less trusted than the server.

19. **`sendEmail` is always fire-and-forget** from routes — never `await` it in
    the HTTP response path. Registration sends a verification email best-effort;
    if the send fails, registration still succeeds. Wrap `sendEmail` calls in
    `try/catch` and never let email failures propagate to the HTTP response.

20. **Malformed JSON bodies → 400, not 500.** The `errorHandler` catches
    `SyntaxError` with `status === 400` (set by body-parser) and returns
    `{error:"invalid JSON body", code:"BAD_JSON"}`. Do not remove this case.

21. **Refresh-token reuse detection has a 15 s grace window.** The `rt` cookie is
    per-browser but shared by every open tab, so two tabs can legitimately
    present the _same_ token within milliseconds of each other.
    `consumeRefreshToken()` treats a replay of a just-rotated token inside
    `ROTATION_GRACE_MS` as that race and continues the family; anything later
    still nukes the whole family (the real theft signal). Do not "tighten" this
    back to zero — strict reuse detection signs multi-tab users out of every
    session at once, which is the bug the window exists to prevent.

22. **Access codes and secrets are hashed with a work factor.** Access codes are
    `bcrypt$`-prefixed digests (cost 10), never unsalted SHA-256: `ACCESS_CODE_MIN`
    is 6 human-chosen characters, so a bare digest is a seconds-long offline
    dictionary attack for anyone holding the DB file. Legacy `sha256$` and
    plaintext rows stay verifiable and self-heal on re-broadcast. Code guessing
    is limited twice — per `(IP, username)` (5/15 min) _and_ per username alone
    (50/15 min) — because the per-IP bucket is trivially multiplied by rotating
    source addresses. Same reasoning for the admin bootstrap secret, which is
    compared with `timingSafeEqual`, never `===`.

23. **Avatars are re-encoded, never stored as uploaded.** `saveAvatar` is async:
    it decodes with `sharp` and re-encodes to PNG, which strips EXIF/GPS/device
    metadata and normalises polyglots. A phone photo carries coordinates, is
    stored indefinitely and served publicly with a long immutable cache — write
    the client's bytes verbatim and that becomes a standing doxxing surface.

24. **Native bcrypt, async API only.** `bcryptjs` is pure JS, so its "async"
    `compare()` still blocks the event loop for the length of the hash (~101 ms
    measured at cost 12). Native `bcrypt` on the async API hands the work to
    libuv's threadpool (~1 ms stall) for the same wall clock. Use the async
    functions on any request path — `hashSync`/`compareSync` block in _both_
    implementations and are only safe at module load (see
    `DUMMY_PASSWORD_HASH`). This made `broadcastsRepo.start()` and
    `verifyAccessCode()` async; access-code hashing is computed **before** the
    better-sqlite3 transaction, never inside one. Hash format is `$2b$` and stays
    compatible with the existing `$2a$` rows.

25. **Account lockout is a backstop, not the brute-force defence.** It counts
    failures only for an existing user, so a low threshold is a denial-of-service
    primitive against any known handle — 20 failures/30 min was roughly three IPs'
    worth of the 10/15min login budget. It is now 50/24h with a 60-minute lock,
    and emails the owner on the attempt that crosses the threshold (once, not on
    every later attempt — those short-circuit on the `isLocked` guard).
    Single-source guessing is stopped by the per-IP limiter well before 50
    attempts; do not lower the threshold to "improve" brute-force protection.

26. **Rate limits are sized for the endpoint's real traffic, keyed per user when
    possible.** `app.use` is a prefix mount, so a limiter mounted on a path
    silently covers every sub-route under it — two limiters got mis-scoped this
    way (`/api/broadcasts` swallowed the 2 s `stats` heartbeat, `/api/sessions`
    swallowed `verify-ticket`, `/api/recordings` swallowed chunk uploads,
    `/api/push/subscribe` + `/api/users/:u/follow` swallowed their DELETEs).
    Scope with an explicit method + `req.path` test
    (relative to the mount) rather than assuming the mount means one endpoint.
    `/api/config` and `/api/health` are unauthenticated by necessity and carry
    their own ceilings rather than inheriting a neighbour's — config does an
    HMAC plus a TURN-credential mint per request when TURN_SHARED_SECRET is set.
    Beyond that:
    - **Key viewer-facing endpoints per authenticated user, falling back to IP.**
      Keying on IP alone puts every viewer behind one NAT into a single shared
      budget, so a busy instance locks out a whole egress IP at once.
    - **Split by whose traffic it is.** A host's `verify-ticket` volume scales
      with its audience, not with any client's rate, so it must not share a
      bucket with viewers resolving sessions.
    - **Tight limits only on guessable things.** Code guessing is the one
      genuinely abusable input to `GET /api/sessions/:username`; keep that at
      5/15 min and never count a request that supplied no code toward it.
    - `skip` runs BEFORE the handler, so it cannot read `res.statusCode` — use
      `skipSuccessfulRequests` for the status half.

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
- [ ] `npm test` green — 100 server tests + 29 web tests.
- [ ] `npm run check:versions` green (version SSOT).
- [ ] `npm run test:e2e` green — 5 Playwright tests (UI, WebRTC, moderation).
- [ ] `npm -w @peer-cast/extension run check` passes.
- [ ] `npx prettier --check .` clean.
- [ ] Server boots, `GET /api/health` → `{ok:true}`, `GET /peerjs` serves the
      PeerJS info JSON, `GET /api/config` includes `registration` field.
- [ ] Access gates: anon resolve of members/code broadcast → 401/403 + no peerId;
      authed resolve → peerId + ticket; `verify-ticket` ok only for matching
      peerId. (`test/access.test.ts`)
- [ ] Rate limits: viewer resolves are never throttled by ordinary watching,
      reconnect polling, or a co-located viewer behind the same IP; verified
      access-code guessing still trips. (`test/session-rate-limit.test.ts`,
      `test/broadcasts.test.ts`)
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
