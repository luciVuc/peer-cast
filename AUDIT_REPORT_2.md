# PeerCast — Independent Verification Report (2nd pass)

**Branch:** `webapp-nodejs` · **Version:** 2.0.0
**Scope:** Fresh, independent re-audit of the full monorepo (shared, server,
web, extension, Docker, CI, docs), performed after the first `AUDIT_REPORT.md`
remediation pass. Goal: confirm the earlier fixes actually landed and surface
anything new.

## Automated gates (re-run)

| Gate                                     | Result                          |
| ---------------------------------------- | ------------------------------- |
| `npm run build` (shared → web → server)  | ✅ pass                         |
| `npm run typecheck` (3 packages)         | ✅ pass                         |
| `npm test` (server + web)                | ✅ 48 server + 6 web pass       |
| `npm audit --omit=dev` (production deps) | ✅ 0 vulnerabilities            |
| `npm audit` (incl. dev)                  | ⚠️ 5 (1 crit/1 high/3 mod, dev) |

Overall the project remains in strong shape and is close to production ready.
The security architecture (two-gate access, rotating HttpOnly refresh tokens,
opaque signaling tickets, timing-safe code compare, bcrypt(12), prod hard-fail
on weak `JWT_SECRET`, enumeration-resistant auth) all verified as sound.

**However, two items the first audit reported as "✅ Fixed" are not actually
fixed in the working tree, and four new issues were found.** None are critical,
but they should be addressed before publishing.

---

## A. Regressions — prior "fixed" items that are still broken

### A-1 · (was M-5) Test artifact is STILL tracked in git

**Severity:** Low · **File:** `tests/e2e/test-results/.last-run.json`

The first audit marked M-5 "✅ Fixed — untracked". The `.gitignore` entries
(`**/test-results/`, `**/.last-run.json`) were added, but the file itself was
never removed from the index, so it is **still tracked**:

```
$ git ls-files tests/e2e/test-results/
tests/e2e/test-results/.last-run.json      ← still tracked
```

A `.gitignore` rule does not untrack an already-committed file.

**Fix:**

```bash
git rm --cached tests/e2e/test-results/.last-run.json
git commit -m "chore: untrack Playwright run artifact"
```

### A-2 · (was M-2) CSP-from-ICE derivation is a no-op for real TURN/STUN URLs

**Severity:** Medium · **File:** `packages/server/src/app.ts` → `deriveIceCspHosts()`

M-2's fix was supposed to add configured TURN/STUN hosts to the CSP
`connect-src`. It uses `new URL(item)` and reads `u.hostname`. But ICE server
URLs use the opaque, non-special schemes `stun:` / `turn:` / `turns:`, for
which the WHATWG URL parser puts everything after the scheme into an opaque
path and leaves `hostname` **empty**:

```js
new URL("stun:stun.l.google.com:19302").hostname; // => ""  (skipped)
new URL("turn:turn.example.com:3478").hostname; // => ""  (skipped)
new URL("turns:turn.example.com:5349").hostname; // => ""  (skipped)
new URL("https://turn.example.com:443").hostname; // => "turn.example.com"
```

So for the way ICE servers are actually configured (`stun:`/`turn:`/`turns:`),
`deriveIceCspHosts()` returns `[]` and **nothing is added to the CSP**. The fix
only works for `https://`/`wss://` URLs, which is not the ICE URL format. The
stated goal — future-proofing TURN-over-TLS/WSS against a stricter
`connect-src` — is not achieved.

It "works today" only because current browsers don't gate ICE candidate
gathering through `connect-src`; the moment they do (or for TURN/TCP/TLS
transports that ride an actual socket), the relay host would be blocked.

**Fix:** Parse the ICE scheme manually instead of relying on `new URL()`:

```ts
function deriveIceCspHosts(): string[] {
  const hosts = new Set<string>();
  for (const s of config.signal.iceServers) {
    const urls = (s as { urls?: string | string[] }).urls;
    for (const item of ([] as string[]).concat(urls ?? [])) {
      // stun:HOST:PORT | turn:HOST:PORT?transport=… | turns:HOST:PORT | https://HOST
      const m = String(item).match(
        /^(?:stun|turn|turns|https|wss):\/*([^:/?#]+)(?::(\d+))?/i,
      );
      if (m?.[1]) hosts.add(m[2] ? `${m[1]}:${m[2]}` : m[1]);
    }
  }
  return [...hosts];
}
```

Then verify a real TURN relay negotiates end-to-end behind the CSP.

---

## B. New findings

### B-1 · SVG data-URL avatars accepted → stored-content risk

**Severity:** Medium · **File:** `packages/server/src/routes/users.ts` (`PUT /users/me`)

Avatar validation only checks the prefix:

```ts
if (!body.avatarDataUrl.startsWith("data:image/") || body.avatarDataUrl.length > MAX_AVATAR_BYTES)
```

`data:image/svg+xml,...` passes this check. SVG is an active-content format: it
can embed `<script>`, `<foreignObject>`, and external `<image href>` / CSS that
phones home. Rendered through an `<img src>` tag scripts won't execute, so this
isn't an immediate XSS, but:

- CSP `img-src` already allows `data:`, so the SVG loads.
- If an avatar is ever rendered outside an `<img>` (CSS `background`, inline
  `<svg>`, `<object>`, opened in a new tab, or an admin previews the raw URL),
  the script/exfil payload can fire.
- It's stored in the DB and re-served to every profile viewer.

**Fix:** Allowlist raster types only:

```ts
const OK = /^data:image\/(png|jpe?g|webp|gif);base64,/;
if (
  !OK.test(body.avatarDataUrl) ||
  body.avatarDataUrl.length > MAX_AVATAR_BYTES
) {
  throw badRequest("avatar must be a PNG/JPEG/WebP/GIF data URL ≤ 200 KB");
}
```

### B-2 · Per-username login limiter enables account-lockout DoS

**Severity:** Low-Medium · **File:** `packages/server/src/app.ts`

The second login limiter keys on the submitted username
(`l:u:${username}`, 10 requests / 15 min) and counts **every** attempt
(`skipSuccessfulRequests` is not set). An attacker who knows a victim's handle
can send 10 bogus logins and lock the real user out for 15 minutes — a cheap,
targeted denial-of-service that also can't be evaded by the victim (same key).

**Fix:** Count only failures and/or raise the ceiling:

```ts
rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true, // don't penalise the legit user's success
  keyGenerator: (req) =>
    `l:u:${String(req.body?.username ?? "").toLowerCase()}`,
  // …
});
```

(The per-IP login limiter already covers brute-force; the per-username one
should target failures only, or use progressive backoff.)

### B-3 · No rate limit on `reset-password` / `verify-email`

**Severity:** Low · **Files:** `packages/server/src/app.ts`, `routes/email.ts`

`forgot-password` and `send-verification` are rate-limited, but
`POST /auth/reset-password` and `GET /auth/verify-email` are not. Tokens are
256-bit random (`randomBytes(32)`), so brute-force is infeasible and there is
no bcrypt-DoS (an invalid token short-circuits before hashing). This is
defense-in-depth only: an unlimited endpoint invites DB hammering / scraping.

**Fix:** Add modest IP limiters, e.g.:

```ts
app.use("/api/auth/reset-password", mkLim(60 * 60_000, 10));
app.use("/api/auth/verify-email", mkLim(60 * 60_000, 30));
```

### B-4 · TURN credentials are served publicly via `/api/config`

**Severity:** Low (design) · **Files:** `routes/config.ts`, `config.ts`

`GET /api/config` returns `signal.iceServers` verbatim to any anonymous
client. This is required (browsers need ICE config), but if an operator puts
**static** long-lived TURN credentials in `ICE_SERVERS`
(`{urls:"turn:…", username:"u", credential:"secret"}`), those credentials are
handed to the entire internet and can be abused to relay arbitrary traffic
through the operator's TURN server.

**Fix / guidance:** Document that any authenticated TURN must use **ephemeral,
time-limited credentials** (the coturn `use-auth-secret` / REST-API HMAC
scheme), never static ones. Optionally mint per-session TURN credentials
server-side rather than shipping them in a public, cacheable config blob.

---

## C. Minor / informational

- **C-1 · Access codes stored in plaintext** (`broadcasts.access_code`).
  Low-value and ephemeral, but hashing at rest (you already hash for the
  timing-safe compare) would avoid leaking live codes if the DB is exposed.
- **C-2 · Dev-only `npm audit` findings persist** (esbuild/vite/vitest chain;
  1 critical + 1 high + 3 moderate). Production audit is clean. Same as prior
  L-1 — deferred pending a breaking vite 5→8 / vitest 2→5 bump.
- **C-3 · `email_verifications` / `password_resets` / `tickets` lack FK
  cascades.** Orphan cleanup is handled manually in `usersRepo.delete()` and by
  `purgeExpired()`, so this is fine — just note it if you add new delete paths.
- **C-4 · `docker-compose.yml` defaults `CORS_ORIGINS=*`.** Harmless here (auth
  is Bearer-token, not cookie; the refresh cookie is `SameSite=strict`), but a
  production compose should set an explicit origin allowlist.
- **C-5 · `.env.example` ships the placeholder `JWT_SECRET`.** By design the
  server hard-fails in production with it — correct and safe — just worth the
  QUICKSTART call-out it already has.

---

## D. Verified correct (spot-checked this pass)

- Two-gate access control intact (`sessions.ts` withholds `peerId` + issues
  ticket; `peer.ts`/`offscreen.js` re-verify each call via `/verify-ticket`).
- `peerId` never leaks in `/broadcasts/live|/:id`, `/users/search|/:u` —
  `toBroadcast()` forces `peerId:null`; only `/sessions/:u` reads `peer_id` raw.
- Extension no longer puts the raw JWT in the PeerJS URL — it mints an opaque
  signaling ticket (`getSignalingTicket` → `background.js` → START payload).
  (Prior H-3 confirmed fixed.)
- `ViewerPage` keeps the last successful access code in `lastCodeRef` and
  re-sends it on reconnect. (Prior M-3 confirmed fixed.)
- `liveForUser` filters stale rows via `COALESCE(stat_at, started_at) > ?`.
  (Prior L-6 confirmed fixed.)
- Ban enforcement re-reads the live row on every authed request; ban revokes
  refresh tokens + force-ends live + rejects WS upgrade.
- Admin rails: no self-ban/self-role-change/self-delete; can't ban another
  admin; all admin routes gated by `requireAuth + requireAdmin`.
- Invite consume is atomic (`UPDATE … WHERE uses < max_uses`).
- Reset/verify tokens are single-use / short-lived with delete-on-consume.
- All SQL is parameterized; `LIKE` wildcards stripped from user input.
- Malformed JSON → 400 (`errorHandler`), email HTML escaped, email
  fire-and-forget + stdout fallback preserved.
- Dockerfile runs as unprivileged `node`, SQLite on a volume, multi-stage.
- `LICENSE` present; `.github/workflows/ci.yml` present (build/typecheck/test).

---

## E. Suggested fix order before publishing

1. **A-2** — fix `deriveIceCspHosts()` (real bug; the CSP/TURN fix is currently
   a no-op).
2. **B-1** — restrict avatars to raster image types (stored-content risk).
3. **A-1** — `git rm --cached` the tracked Playwright artifact.
4. **B-2** — make the per-username login limiter skip successful requests.
5. **B-3 / B-4** — add reset/verify rate limits; document ephemeral-TURN-creds.
6. **C-1 / C-2 / C-4** — schedule as hardening / hygiene.

Net: still a well-engineered, security-conscious codebase. The only genuine
defect that affects runtime correctness is **A-2** (and it only bites once
browsers tighten `connect-src` or you run TURN-over-TLS); **B-1** is the most
worthwhile pre-publish security hardening.

---

# Addendum — Review of the uncommitted changeset (3rd pass)

**Scope:** Full review of the large staged/uncommitted changeset (68 files)
that adds P2P chat, per-broadcast recordings/replay, Web Push (VAPID) go-live
notifications, a follow graph, admin metrics, optional Redis (shared rate
limits + signaling tickets), and ephemeral TURN credentials — plus a
vite/vitest major-version bump.

## Gate results (re-run against the changeset)

| Gate                                                          | Result                                 |
| ------------------------------------------------------------- | -------------------------------------- |
| `npm run build` (shared → web → server)                       | ✅ pass                                |
| `npm run typecheck` (incl. `tsconfig.sw.json`)                | ✅ pass                                |
| `npm test`                                                    | ✅ 87 server + 11 web pass             |
| `npm audit` (incl. dev)                                       | ✅ 0 vulnerabilities                   |
| `npm audit --omit=dev`                                        | ✅ 0 vulnerabilities                   |
| `npm -w @peer-cast/extension run check`                       | ✅ pass                                |
| `npx prettier --check .`                                      | ✅ clean                               |
| `npm run test:e2e`                                            | ✅ 5 Playwright tests pass (this pass) |
| Server boot + smoke (`/api/health`, `/peerjs`, `/api/config`) | ✅ pass (this pass)                    |

**Overall verdict: ready to commit (Addendum items implemented).** Every
A/B/C/G finding from this report is now fixed; gates re-ran green this pass
(see above). The only item not re-verified here is the Docker image build
(`docker compose up --build`) because no Docker daemon was available during the
final pass — the Dockerfile change (G-7) is a version-pinned variable + comment.

## F. Status of earlier findings in this changeset

| Ref     | Status in changeset | Notes                                                                                                                                                                                                                                              |
| ------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-4** | ✅ Fixed (correct)  | Ephemeral TURN implemented end-to-end: `lib/turn.ts` (HMAC-SHA1 TURN REST flow), `config.turn.*`, `routes/config.ts` enrichment, `turnserver.conf` `use-auth-secret`, and `docker-compose.yml` wiring all consistent. Static creds no longer sent. |
| **C-2** | ✅ Fixed            | Toolchain bumped (vite 5→8, vitest 2→5, plugin-react 4→5, vite-plugin-pwa 0.21→1.3). `npm audit` now 0 (dev + prod).                                                                                                                               |
| **A-1** | ✅ Fixed            | Untracked via `git rm --cached tests/e2e/test-results/.last-run.json` (now a staged deletion; `.gitignore` already covers it).                                                                                                                     |
| **A-2** | ✅ Fixed            | `deriveIceCspHosts()` rewritten with `ICE_URL_RE` (`stun                                                                                                                                                                                           | stuns | turn | turns                                                                                                          | https? | wss?`) extracting host:port per ICE entry — no more `new URL()`. |
| **B-1** | ✅ Fixed            | Avatar field now allowlists `data:image/(png                                                                                                                                                                                                       | jpe?g | webp | gif);base64,[A-Za-z0-9+/=\s]+`on the API; web picker adds`accept="image/png,image/jpeg,image/webp,image/gif"`. |
| **B-2** | ✅ Fixed            | Per-username login limiter now passes `skipSuccessfulRequests: true`.                                                                                                                                                                              |
| **B-3** | ✅ Fixed            | `reset-password` limited 10/h per IP; `verify-email` limited 30/h per IP. Both exercised by tests.                                                                                                                                                 |

## G. New issues introduced by the changeset

### G-1 · `change-email` has no current-password re-authentication (HIGH)

**File:** `packages/server/src/routes/email.ts` (`POST /auth/change-email`)

`PUT /users/me/password` and `DELETE /users/me` both re-verify the password,
but `change-email` only requires the 15-minute access token. With a stolen
token an attacker can point the account at their own address, confirm it, then
run a password reset → **full account takeover**. Changing the email also does
not revoke sessions.

**Fix:** Add `currentPassword` to the request body and `verifyPassword` against
the stored hash before issuing the change token (mirror `PUT /me/password`).
Consider revoking refresh tokens on a successful email change.

### G-2 · `change-email` is an unrate-limited email-bombing vector (MEDIUM)

**Files:** `packages/server/src/app.ts`, `routes/email.ts`

`change-email` sends a confirmation email to an attacker-supplied `newEmail`
with no limiter. Registration is open by default, so one throwaway account lets
an attacker mail-bomb any address. `forgot-password` is per-email rate-limited
for exactly this reason.

**Fix:** Add per-IP + per-target-email limiters mirroring the `fp-ip` /
`fp-email` pattern already in `app.ts`.

### G-3 · Push subscription keeps the wrong owner on a shared browser (MEDIUM)

**File:** `packages/server/src/repos/notifications.ts` (`saveSubscription`)

`ON CONFLICT(endpoint) DO UPDATE SET p256dh = …, auth = …` updates the keys but
**not** `username_lc`. If user B subscribes on a browser previously used by
user A (same push endpoint), the row stays owned by A — B's go-live alerts
misfire and A may receive notifications on a device they no longer use.

**Fix:** Add `username_lc = excluded.username_lc, created_at = excluded.created_at`
to the upsert.

### G-4 · `DELETE /push/subscribe` is not scoped to the caller (LOW)

**Files:** `routes/push.ts`, `repos/notifications.ts` (`removeSubscription`)

`removeSubscription(endpoint)` deletes by endpoint regardless of owner, so a
user who learns another user's endpoint can unsubscribe them.

**Fix:** Scope the delete to `req.auth.usernameLc`
(`DELETE … WHERE endpoint = ? AND username_lc = ?`).

### G-5 · Chat identity is spoofable + no length cap (LOW)

**Files:** `packages/web/src/lib/peer.ts`, `pages/ViewerPage.tsx`, `pages/BroadcastPage.tsx`

The host relays viewer-supplied `raw.from`, so a viewer can post as "Host" or
impersonate another viewer. There is also no length cap on chat text (no
`maxLength` on the inputs, no `slice` in `packChat`), so a peer can send
oversized messages that the host relays to everyone. React escapes `{m.text}`,
so this is **not** an XSS — it's an integrity/abuse concern only.

**Fix:** Attribute chat from the name resolved via the verified ticket rather
than the wire `from`; cap chat length (e.g. 500 chars) on send and on relay,
and add `maxLength` to the inputs.

### G-6 · Unbounded per-account recording storage (LOW)

**Files:** `routes/recordings.ts`, `config.ts`

There is a per-recording byte cap (`RECORDINGS_MAX_BYTES`, default 512 MB) and a
create rate limit (20/h), but nothing caps the number of recordings or total
disk per user. Sustained use can exhaust the `/data` volume.

**Fix:** Add a per-user recording quota and/or a retention policy (max count or
max aggregate bytes; prune oldest on overflow).

### G-7 · Fragile Dockerfile rollup native-binary workaround (LOW)

**File:** `Dockerfile`

The added step hardcodes `@rollup/rollup-linux-${ARCH}-gnu@4` (glibc, rollup
major 4) to work around npm/cli#4828. It works on the current
`node:22-bookworm-slim` base but will silently break on a rollup major bump or a
musl-based image.

**Fix:** Pin/track the rollup major alongside the `vite` dependency, or add a CI
check that the SW build succeeds in the container. At minimum leave a comment
tying the `@4` to the installed rollup version.

## H. Verified correct in the changeset (no action needed)

- Redis-backed rate limiting + signaling tickets with a **synchronous fallback**
  that preserves the WS-upgrade ban-check timing (`peerServer.ts` branches on
  `config.redis.url`; `auth.ts` exposes both `consumeSignalingTicket` (async)
  and `consumeSignalingTicketSync`). Async caller updated in `routes/auth.ts`.
  Clean Redis drain on SIGTERM/SIGINT in `index.ts`.
- **Recordings:** server-generated hex IDs (no path traversal), ownership check
  on every op (`getOwned`), per-chunk 25 MB + per-recording cap, octet-stream
  correctly bypasses `express.json`, and files are cleaned up **before** the FK
  cascade on both admin and self account deletion. Replay auth handled via
  blob-fetch with the Bearer header (a `<video src>` can't send it).
- **Email change:** single-use 24 h token, sent to the _new_ address, re-checks
  uniqueness on confirm (race guard), purged on expiry and account deletion.
- **Push:** only public broadcasts notify; fire-and-forget; prunes 404/410
  endpoints; fully disabled without a VAPID keypair.
- **Metrics:** read-only, admin-gated, parameterized, day-count bounded 7–90.
- **Follow graph:** FK `ON DELETE CASCADE`, parameterized, self-follow blocked.
- New DB tables (`email_changes`, `follows`, `push_subscriptions`, `recordings`)
  created idempotently; `docker-compose.yml` `JWT_SECRET` now quoted.

## I. TODO checklist before committing this changeset

**Required (security / correctness):**

- [x] **G-1** — require `currentPassword` on `POST /auth/change-email`; revoke
      sessions on success.
- [x] **G-2** — add per-IP + per-email rate limits to `change-email`.
- [x] **G-3** — update `username_lc` in the `saveSubscription` upsert.
- [x] **A-1** — `git rm --cached tests/e2e/test-results/.last-run.json`.
- [x] **A-2** — fix `deriveIceCspHosts()` to parse `stun:`/`turn:`/`turns:`
      hosts (regex, not `new URL`); verify a real TURN relay works behind CSP.

**Recommended (hardening, can be same commit or fast-follow):**

- [x] **B-1** — restrict avatars to raster types (`png|jpe?g|webp|gif`).
- [x] **G-4** — scope `DELETE /push/subscribe` to the authenticated user.
- [x] **G-5** — attribute chat from the verified ticket; cap chat length +
      add input `maxLength`.
- [x] **B-2** — `skipSuccessfulRequests` on the per-username login limiter.
- [x] **B-3** — rate-limit `reset-password` / `verify-email`.

**Follow-up (schedule):**

- [x] **G-6** — per-user recording quota / retention.
- [x] **G-7** — document/guard the Dockerfile rollup workaround.
- [x] **C-1** — hash access codes at rest.
- [x] **B-4** — TURN credential exposure note is now moot (ephemeral creds
      shipped); keep the "never use static TURN creds" guidance in docs.

**Add tests alongside the fixes:** `change-email` password gate + rate limit,
push upsert owner reassignment, and (if implemented) chat length cap. Keep the
suite green (currently 87 server + 11 web) before committing.
