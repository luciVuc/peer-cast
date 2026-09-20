# PeerCast — Production Readiness Audit

**Branch:** `webapp-nodejs` · **Version:** see root `package.json`
**Date:** audit performed against current `HEAD` (`0b6ec77`)
**Scope:** full monorepo — shared types, Node/Express server, React PWA, Chrome
extension, Docker/compose, TURN config, CI, docs.

## Executive summary

The project is in **good overall shape** and close to production ready. All
green on the automated gates:

| Gate                                     | Result                    |
| ---------------------------------------- | ------------------------- |
| `npm run build` (shared → web → server)  | ✅ pass                   |
| `npm run typecheck` (3 packages)         | ✅ pass                   |
| `npm test` (server + web)                | ✅ 48 server + 6 web pass |
| `npx prettier --check .`                 | ✅ clean                  |
| `npm -w @peer-cast/extension run check`  | ✅ pass                   |
| `npm audit --omit=dev` (production deps) | ✅ 0 vulnerabilities      |

The security architecture is thoughtful: two-gate access control, HttpOnly
rotating refresh tokens, opaque signaling tickets, timing-safe access-code
comparison, bcrypt(12), hard-fail on weak `JWT_SECRET` in production, rate
limiting, helmet CSP, and enumeration-resistant auth flows.

No **critical** or **high-severity runtime** defects were found. The issues
below are a mix of medium-priority correctness/consistency items and low-
priority polish. Nothing blocks a launch, but several items should be fixed
before publishing publicly (notably the stale CI workflow, the missing LICENSE,
and the extension still leaking the JWT into the signaling URL).

---

## 1. Critical

_None found._

---

## 2. High priority

### H-1 · Stale/broken GitHub Actions workflow references a non-existent package

**File:** `.github/workflows/pages.yml`

The workflow deploys `packages/viewer/**` to GitHub Pages. That directory does
**not exist** on this branch — it is a leftover from the `serverless` edition.
It triggers on `push` to `main` and on `workflow_dispatch`. If ever run it will
fail at `upload-pages-artifact` (path not found), and conceptually it
contradicts the Node edition's architecture (the README explicitly says the
serverless edition lives on another branch).

**Fix:** Delete the workflow, or replace it with CI that actually matches this
branch (e.g. `npm ci && npm run build && npm run typecheck && npm test`).
Recommended minimal replacement:

```yaml
name: CI
on: { push: { branches: [webapp-nodejs] }, pull_request: {} }
jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npm test
```

### H-2 · No LICENSE file

**File:** repository root

There is no `LICENSE`. "Publish as-is" without a license means the code is, by
default, **all rights reserved** — nobody may legally self-host, fork, or
redistribute it, which defeats the stated goal of a self-hostable project.

**Fix:** Add a license (MIT/Apache-2.0 are typical for this kind of tool) and
reference it in `README.md` and each `package.json` (`"license": "MIT"`).

### H-3 · Extension still puts the raw JWT in the PeerJS WebSocket URL

**Files:** `packages/extension/background.js:223`, `packages/server/src/signaling/peerServer.ts`

The web app was hardened to mint an **opaque, single-use signaling ticket**
(`POST /api/auth/signaling-ticket`) so the JWT never lands in reverse-proxy
access logs. The extension was **not** migrated — it still sends
`signalConfig.token = auth.token` (the JWT). The server only keeps the JWT path
as a "legacy/backward-compat" fallback, so every extension broadcaster leaks a
15-minute-valid bearer token into signaling-server/proxy logs.

**Fix:** Add a `getSignalingTicket()` call to `api-client.js` and have
`buildStartPayload()` fetch a ticket, passing that instead of the JWT. Then you
can eventually remove the JWT fallback in `peerServer.ts`.

---

## 3. Medium priority

### M-1 · Banned-user eviction at signaling is bypassable on reconnect

**File:** `packages/server/src/signaling/peerServer.ts`

The ban check consumes the single-use signaling ticket on the first WebSocket
upgrade. PeerJS auto-reconnects on `disconnected` (`peer.reconnect()`) reusing
the **same** URL/token. On reconnect the ticket is already consumed and the
opaque value doesn't decode as a JWT, so the peer is treated as **anonymous and
allowed** — the ban check is skipped. This is acceptable per the documented
"rendezvous-only moderation" model (a banned user can't be discovered or start
a broadcast via the API anyway), but it is worth documenting explicitly so it
isn't mistaken for hard enforcement.

Also, when a banned user is detected the handler writes `403` and
`socket.destroy()` but does **not** stop propagation, so PeerJS's own `upgrade`
listener still runs against the destroyed socket (harmless, but noisy).

**Fix (optional hardening):** Consider a short-lived, non-consuming ban check
(e.g. cache `usernameLc → bannedUntil`) or accept and document the current
behavior. At minimum add a `return`/guard after `socket.destroy()`.

### M-2 · CSP `connect-src 'self'` may block external TURN/STUN under strict enforcement

**File:** `packages/server/src/app.ts` (helmet CSP)

`connectSrc: ["'self'"]` covers same-origin XHR/fetch/WebSocket (including the
`/peerjs` signaling socket). The default Google STUN works in current Chrome
because ICE candidate gathering isn't gated by `connect-src` today. However,
some browsers/versions (and the emerging `webrtc`/tightened `connect-src`
behavior) can block ICE to **external TURN** servers configured via
`ICE_SERVERS`. Since the docs actively encourage a bundled coturn relay, a
strict CSP could silently break symmetric-NAT users.

**Fix:** Verify TURN works end-to-end behind the current CSP. If it doesn't,
extend `connect-src` to include the configured TURN origins (or add them
dynamically from `config.signal.iceServers`).

### M-3 · Viewer reconnect drops the access code for `code` broadcasts

**File:** `packages/web/src/pages/ViewerPage.tsx`

On a dropped connection the auto-reconnect calls `resolve()` **without** the
code (`reconnectTimer … void resolve()`), so a `code`-gated viewer bounces back
to the "Access code required" screen on every network blip even though the code
is still held in component state.

**Fix:** Persist the last successful code in a ref and pass it on reconnect:

```ts
reconnectTimer.current = window.setTimeout(
  () => void resolve(lastCodeRef.current ?? undefined),
  delay,
);
```

### M-4 · Cross-origin deployment silently breaks token refresh

**Files:** `packages/server/src/routes/auth.ts` (`rtCookieOpts`), `app.ts` (CORS)

The refresh cookie is `SameSite=Strict` and scoped to `path=/api/auth`. This is
correct for the intended **single-origin** deployment (PWA + API served from one
process). But if an operator serves the PWA on a different origin than the API
and sets `CORS_ORIGINS` accordingly, a `SameSite=Strict` cookie will **not** be
sent on the cross-site `/auth/refresh` call, so sessions won't survive a reload
even though CORS `credentials:true` is enabled.

**Fix:** Document that this build is single-origin by design, or make the
cookie `SameSite` configurable (`Strict` for same-origin, `None; Secure` for
cross-origin) driven by an env flag.

### M-5 · Committed test artifact

**File:** `tests/e2e/test-results/.last-run.json` (tracked in git)

A Playwright run artifact is checked in. `.gitignore` ignores `dist`, `*.db`,
`.env`, etc. but not `test-results/`.

**Fix:** `git rm --cached tests/e2e/test-results/.last-run.json` and add
`**/test-results/` and `**/playwright-report/` to `.gitignore`.

---

## 4. Low priority / polish

### L-1 · Dev-dependency vulnerabilities (not shipped)

`npm audit` reports 5 advisories (1 critical, 1 high, 3 moderate) — **all** in
the `vitest → vite → esbuild` dev chain (the esbuild dev-server request
advisory). `npm audit --omit=dev` = **0**, so production is unaffected. Bump
`vite`/`vitest` when convenient (may be a major bump).

### L-2 · Inaccurate user-facing string in extension

**File:** `packages/extension/offscreen.js:97` — "The free PeerJS signaling
server could not be reached." This edition is **self-hosted**; the wording is a
leftover and contradicts hard-rule #7. Reword to "the signaling server".

### L-3 · Documentation counts are out of date

`AGENTS.md` says "45 server tests + 5 web tests / 50 tests". Actual: **48
server + 6 web = 54** (plus e2e). Update the verification checklist counts.

### L-4 · Redundant root `qs` dependency

**File:** `package.json` — has both an `overrides.qs` (the meaningful security
pin) **and** a top-level `dependencies.qs`. `qs` is only a transitive dep; the
direct dependency entry is unnecessary. Keep the override, drop the direct dep.

### L-5 · `.env.example` ships `NODE_ENV=production` with the placeholder secret

**File:** `.env.example` — `NODE_ENV=production` + `JWT_SECRET=change-me-…`.
Copying it verbatim makes the server **refuse to boot** (by design, thanks to
the `jwtSecret()` hard-fail). That's the safe outcome, but it can confuse
first-timers who expect a runnable dev default. Consider defaulting the example
to `NODE_ENV=development` and calling out the production overrides, since
`QUICKSTART.md` targets newcomers.

### L-6 · Stale live broadcasts can still be resolved for up to the reap window

**Files:** `sessions.ts` → `broadcastsRepo.liveForUser`, `index.ts` housekeeping

`liveForUser` selects `status='live'` without a staleness filter, and the
reaper runs every 5 min. A crashed host's row can hand out a dead `peerId`/
ticket until reaped. The viewer's reconnect/backoff UI handles it gracefully,
so this is minor — but you could add `AND COALESCE(stat_at, started_at) > ?`
to the resolve query for immediacy.

### L-7 · No reuse-detection on refresh-token rotation

**File:** `packages/server/src/lib/auth.ts` (`consumeRefreshToken`)

Rotation is single-use (good), but a stolen-then-replayed token simply logs the
legitimate user out on their next refresh rather than triggering a
family-wide revocation. Fine for this threat model; note it as a possible
future hardening (store a token "family" id and revoke all on reuse).

---

## 5. Things verified as correct (no action needed)

- **Two-gate access control** intact: server withholds `peerId` + issues a
  ticket; broadcaster host re-verifies each ticket via `/verify-ticket`.
  (`sessions.ts`, `peer.ts`, `offscreen.js`).
- **`peerId` never leaks** in `/broadcasts/live`, `/users/search`,
  `/users/:u`, or `/broadcasts/:id` — `toBroadcast()` forces `peerId: null` and
  routes null it explicitly. Only `/sessions/:username` reads `peer_id` raw.
- **Access-code comparison** is SHA-256 + `timingSafeEqual` (constant time,
  length-hiding). `broadcasts.ts`.
- **Password storage** bcrypt cost 12; login does a dummy compare only when the
  user exists (acceptable) and returns a generic error.
- **Enumeration resistance**: `forgot-password` always 200; registration email
  conflict returns a soft message; email verification errors redirect.
- **Email is fire-and-forget** and never awaited in the response path; stdout
  fallback preserved when `SMTP_HOST` is unset (hard-rules #18/#19).
- **Malformed JSON → 400** (`BAD_JSON`) handled in `errorHandler`.
- **Email HTML is escaped** (`esc()`) before interpolation — no template
  injection.
- **SQL** is entirely parameterized prepared statements; `LIKE` wildcards are
  stripped from user input before interpolation.
- **Ban enforcement** re-reads the live user row on every authenticated request
  (`requireAuth`), and ban revokes refresh tokens + force-ends live broadcasts.
- **Admin safety rails**: can't ban/role-change/self-delete yourself, can't ban
  another admin; all admin routes gated by `requireAuth + requireAdmin`.
- **Invite consume** is atomic via a conditional `UPDATE … WHERE uses < max_uses`.
- **Reset/verify tokens** are single-use / short-lived with the documented
  delete-on-consume semantics.
- **Dockerfile** runs as unprivileged `node`, persists SQLite on a volume,
  multi-stage build, correct workspace layout preservation.
- **`docker-compose.yml`** hard-requires `JWT_SECRET` via `${JWT_SECRET:?…}`.
- **Config** hard-fails on missing/short/placeholder `JWT_SECRET` in prod.
- **Version SSOT** is root `package.json`; consistency is enforced by
  `npm run check:versions` across workspace manifests, the extension
  `manifest.json`/`package.json`, `openapi.yaml`, and image tag (hard-rule #13).
  Server/config code never embeds a version literal — `config.ts` falls back to
  `APP_VERSION` env or the `dev` marker.
- **Express 5** is in use, so the `/*path` SPA catch-all wildcard is valid.

---

## 6. Suggested fix order before publishing

1. **H-1** delete/replace the dead Pages workflow (prevents red CI + confusion).
2. **H-2** add a LICENSE (legal blocker for "publish as-is").
3. **H-3** migrate the extension to signaling tickets (or drop the JWT-in-URL).
4. **M-5 / L-3 / L-4 / L-2** quick hygiene: untrack test artifact, fix doc
   counts, drop redundant `qs` dep, reword extension string.
5. **M-3** viewer reconnect keeps the access code.
6. **M-2** confirm TURN works under the CSP (only if you ship TURN).
7. **M-1 / M-4 / L-1 / L-5 / L-6 / L-7** document or schedule as hardening.

Overall: a well-engineered, security-conscious codebase. Addressing H-1→H-3
and the M-tier hygiene items makes it comfortably publishable.

---

## 7. Resolution status (2026-09-09)

| Ref     | Status      | Notes                                                                                                                                                                                                                                                                                               |
| ------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H-1** | ✅ Fixed    | `pages.yml` replaced by `.github/workflows/ci.yml`: build → typecheck → test → extension check → prettier.                                                                                                                                                                                          |
| **H-2** | ✅ Fixed    | `LICENSE` (MIT) added; `"license":"MIT"` in root + all 5 workspace `package.json` files; README License section.                                                                                                                                                                                    |
| **H-3** | ✅ Fixed    | Extension now mints an opaque signaling ticket (`getSignalingTicket`) in `api-client.js` + `background.js`; the JWT no longer lands in the PeerJS WebSocket URL. Server keeps the JWT fallback for legacy clients.                                                                                  |
| **M-1** | ✅ Fixed    | `return` guard added after `socket.destroy()` in `signaling/peerServer.ts`; reconnect/anonymous-fallback semantics documented.                                                                                                                                                                      |
| **M-2** | ✅ Fixed    | helmet CSP `connect-src` now includes host-sources derived from configured `ICE_SERVERS` (TURN/STUN).                                                                                                                                                                                               |
| **M-3** | ✅ Fixed    | `ViewerPage` keeps the last successful access code in a ref and re-sends it on automatic reconnect.                                                                                                                                                                                                 |
| **M-4** | ✅ Fixed    | `COOKIE_SAME_SITE` env (strict/lax/none; none forces Secure); single-origin design documented in README + `.env.example`.                                                                                                                                                                           |
| **M-5** | ✅ Fixed    | `tests/e2e/test-results/.last-run.json` untracked; `**/test-results/`, `**/playwright-report/`, `**/.last-run.json` added to `.gitignore`.                                                                                                                                                          |
| **L-1** | ⏸️ Deferred | Remaining `npm audit` findings are dev-only (vitest critical → vitest 5, vite high → vite 8). Production audit is clean (`npm audit --omit=dev` = 0). Fixing requires a breaking multi-major toolchain bump (vite 5→8, vitest 2→5, plugin-react, vite-plugin-pwa) — schedule as a dedicated effort. |
| **L-2** | ✅ Fixed    | `offscreen.js` "free PeerJS signaling server" message reworded to reference "the signaling server".                                                                                                                                                                                                 |
| **L-3** | ✅ Fixed    | AGENTS.md + README.md test counts updated → 48 server + 6 web (54).                                                                                                                                                                                                                                 |
| **L-4** | ✅ Fixed    | Redundant root `qs` dependency dropped; `overrides` retained. Lockfile refreshed.                                                                                                                                                                                                                   |
| **L-5** | ✅ Fixed    | `.env.example` defaults to `NODE_ENV=development` with a production note.                                                                                                                                                                                                                           |
| **L-6** | ✅ Fixed    | `liveForUser` (and resolve path) treats live rows older than `STALE_LIVE_MS` as offline — stale peer IDs are no longer handed out during the reap window.                                                                                                                                           |
| **L-7** | ✅ Fixed    | Refresh-token reuse-detection (token families / revoke-on-reuse) documented as future hardening in `lib/auth.ts`.                                                                                                                                                                                   |

All H- and M-tier items and every actionable L-item are resolved; L-1 is the
only deferred item (dev-only, breaking toolchain bump). The changeset was
re-reviewed and passes build / typecheck / test (48 + 6) / extension check /
prettier.

---

## 8. Post-remediation review — optional polish (non-blocking)

The following are minor observations from reviewing the fix changeset. **None
block committing or releasing** — they are cosmetic or comment-accuracy nits
that can be folded into the same commit or deferred.

### P-1 · `peerServer.ts` comment overstates what `return` does

**File:** `packages/server/src/signaling/peerServer.ts`

Node fires **all** registered `upgrade` listeners; the added `return` only
exits our own handler — it does **not** stop PeerJS's separate `upgrade`
listener from also running. The actual eviction is performed by
`socket.destroy()` (PeerJS then operates on a dead socket, harmlessly). The
inline comment ("without returning, the socket can still reach PeerJS's own
upgrade handler") implies the `return` prevents that, which is inaccurate. The
behavior is correct; only the wording is misleading.

**Suggestion:** Reword to something like: "Socket already destroyed above;
return to skip the rest of our handler. PeerJS's own upgrade listener still
fires but operates on a closed socket."

### P-2 · `LICENSE` has no trailing newline

**File:** `LICENSE`

The file ends without a final newline (`\ No newline at end of file`). Purely
cosmetic; some POSIX-tidy tooling nags about it.

**Suggestion:** Add a trailing newline.

### P-3 · README ASCII diagram right-border misalignment

**File:** `README.md` (architecture diagram)

The edited line `(opaque signaling ticket, never JWT)` is ~1 column wider than
the original, so its closing `│` no longer lines up with the rows above/below.
Purely visual.

**Suggestion:** Trim one space so the right border re-aligns.

### P-4 · This audit document is tracked in the repo

**File:** `AUDIT_REPORT.md`

Useful as a historical record, but it is an internal audit artifact shipping in
a (potentially public) release. This is a judgment call, not a defect.

**Suggestion:** Keep it, move it under `docs/`, or leave it untracked —
whichever fits your release conventions.

---

## 9. Post-remediation resolution status (2026-09-09)

| Ref     | Status   | Notes                                                                                                                                         |
| ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **P-1** | ✅ Fixed | `peerServer.ts` comment reworded: destroyed-socket semantics clarified; reconnect/re-register nuance already covered by the module docstring. |
| **P-2** | ✅ Fixed | `LICENSE` now ends with a trailing newline.                                                                                                   |
| **P-3** | ✅ Fixed | Diagram right border re-aligned: `(opaque signaling ticket, never JWT)` row now closes on the same column as the rows above/below.            |
| **P-4** | ✅ Kept  | Kept at repo root — matches the existing root-level docs convention (`README.md`, `QUICKSTART.md`, `AGENTS.md`, `ROADMAP.md`).                |

All post-remediation items are resolved. The changeset remains green on
build / typecheck / test (48 + 6) / extension check / prettier.
