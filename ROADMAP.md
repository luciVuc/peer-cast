# PeerCast — Roadmap

_Legend: ✅ done · 🚧 in progress · ⬜ planned_

This roadmap reflects the **`webapp-nodejs` branch** (current release), the self-hosted
Node.js + React PWA rewrite.

_Last updated from the `AUDIT_REPORT_3.md` comprehensive audit (June 2025, v1.1.6)._

---

## Shipped

| Feature                                                                                                             | Status |
| ------------------------------------------------------------------------------------------------------------------- | ------ |
| Node.js backend: Express API + SQLite + JWT + PeerJS signaling                                                      | ✅     |
| React PWA (Vite, Redux Toolkit, Tailwind): Landing, Dashboard, Broadcaster, Viewer, Settings                        | ✅     |
| Two-gate access control (public / members / code), tickets                                                          | ✅     |
| Auth-gated signaling (banned peers evicted at WS upgrade)                                                           | ✅     |
| Admin/moderation surface: ban, unban, takedown, report queue, role management                                       | ✅     |
| Invite-code registration (open / invite / closed modes; admin bootstrap bypass)                                     | ✅     |
| Email verification + password reset (Nodemailer/SMTP; stdout fallback for dev)                                      | ✅     |
| Toast notification system (replaces all inline error/success messages)                                              | ✅     |
| Viewer chat (P2P data channel, ticket-gated, relaying host ↔ all viewers)                                           | ✅     |
| Viewer stats overlay (viewer count + bitrate from the live feed)                                                    | ✅     |
| TURN credential rotation (TURN REST API / coturn use-auth-secret)                                                   | ✅     |
| Email change flow (verify the new address before it becomes active)                                                 | ✅     |
| Admin dashboard metrics (users, broadcasts/day, peak concurrent viewers)                                            | ✅     |
| PWA push notifications (VAPID Web Push — followers are notified when a followed user goes live)                     | ✅     |
| Per-broadcast recording + replay (MediaRecorder → chunked upload → server WebM storage → HTML5 replay in dashboard) | ✅     |
| Chrome MV3 extension (optional broadcaster): tab/screen capture, PeerJS host                                        | ✅     |
| Docker image + bundled coturn TURN relay (--profile turn)                                                           | ✅     |
| 86 automated tests: Vitest server (78) + web (8) + Playwright E2E (5)                                               | ✅     |

---

## P0 — Critical: Fix Before Next Release

Items that fix active security vulnerabilities or data-integrity bugs.
Deploy these before any feature work.

---

### SEC-1 ✅ Recording ID path-traversal guard

|               |                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §3.1 — HIGH                                                                                                                                                                                |
| **Risk**      | An attacker who controls `req.params.id` can read/write arbitrary files on the server filesystem. Although IDs are server-generated hex, the route reads `id` straight from the URL with no format check. |
| **Goal**      | Ensure every recording file operation is confined to `RECORDINGS_DIR`.                                                                                                                                    |

#### Spec

- Recording IDs are 18-character lowercase hex strings (from `randomBytes(9).toString("hex")`).
- Any route handler that touches the filesystem via a recording ID MUST validate the parameter first.
- If the ID doesn't match, return `400 { error: "invalid recording id", code: "BAD_ID" }`.

#### Implementation steps

1. **`packages/server/src/repos/recordings.ts`** — add a validation helper at the top:

   ```ts
   const RECORDING_ID_RE = /^[0-9a-f]{18}$/;
   export function assertValidId(id: string): void {
     if (!RECORDING_ID_RE.test(id)) {
       throw badRequest("invalid recording id", "BAD_ID");
     }
   }
   ```

   Import `badRequest` from `../lib/errors.js`.

2. **`packages/server/src/routes/recordings.ts`** — add a shared param middleware at
   the top of the router that runs before any `:id` route:

   ```ts
   recordingsRouter.param("id", (req, _res, next, id) => {
     recordingsRepo.assertValidId(id);
     next();
   });
   ```

   This intercepts every `/:id` sub-route (`PUT /:id/chunk`, `POST /:id/finalize`,
   `GET /:id`, `GET /:id/data`, `DELETE /:id`).

3. **Defence-in-depth** — in `partFileOf` and `replayFileOf`, resolve the path and
   assert it starts with the recordings directory:

   ```ts
   import { resolve } from "node:path";
   export function partFileOf(id: string): string {
     const p = resolve(config.recordings.dir, `${id}.webm.part`);
     if (!p.startsWith(resolve(config.recordings.dir)))
       throw new Error("path escape");
     return p;
   }
   ```

   Apply the same to `replayFileOf`.

4. **Tests** — add a test in `test/recordings.test.ts`:

   ```ts
   it("rejects path-traversal recording IDs", async () => {
     const res = await authed.get("/api/recordings/../../etc/passwd");
     expect(res.status).toBe(400);
     expect(res.body.code).toBe("BAD_ID");
   });
   ```

5. **Verification**: `npm test` green, `npm run typecheck` clean, manual curl test
   with `../` in the ID returning 400.

---

### SEC-2 ✅ CSRF hardening for cookie-dependent endpoints

|               |                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §3.1 — HIGH                                                                                                                                                 |
| **Risk**      | When `COOKIE_SAME_SITE` is set to `lax` or `none`, `POST /api/auth/refresh` and `/api/auth/logout` are CSRF-exploitable because the HttpOnly cookie is sent automatically. |
| **Goal**      | Prevent cross-origin form POSTs from consuming refresh tokens or logging users out.                                                                                        |

#### Spec — Origin / Referer check (simplest, no state)

Preferred approach: validate that state-changing requests to cookie-protected
endpoints come from the same origin. This is lighter than double-submit cookies
and requires no client changes.

#### Implementation steps

1. **`packages/server/src/middleware/csrf.ts`** — create a new middleware:

   ```ts
   import type { NextFunction, Request, Response } from "express";
   import { config } from "../config.js";
   import { forbidden } from "../lib/errors.js";

   /**
    * Reject cross-origin state-changing requests to cookie-dependent endpoints.
    *
    * Logic:
    *  1. Skip if COOKIE_SAME_SITE is "strict" (browser handles CSRF natively).
    *  2. For POST/PUT/DELETE, check `Origin` (or `Referer` fallback).
    *  3. Accept if the header matches the host in the `Host` header.
    *  4. Reject otherwise.
    *  5. Always allow requests with no Origin AND no Referer (same-origin
    *     XHR / fetch from some browsers).
    */
   export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
     if (config.cookieSameSite === "strict") return next();
     if (
       req.method === "GET" ||
       req.method === "HEAD" ||
       req.method === "OPTIONS"
     )
       return next();

     const origin = req.get("Origin") || req.get("Referer");
     if (!origin) return next(); // same-origin fetch often omits both

     try {
       const url = new URL(origin);
       const host = req.get("Host") || "";
       const expectedHost = host.split(":")[0];
       if (url.hostname === expectedHost) return next();
     } catch {
       /* malformed origin */
     }

     next(forbidden("cross-origin request blocked", "CSRF"));
   }
   ```

2. **`packages/server/src/app.ts`** — mount the guard on `/api/auth`:

   ```ts
   import { csrfGuard } from "./middleware/csrf.js";
   // After cookieParser, before route mounting:
   app.use("/api/auth", csrfGuard);
   ```

3. **Alternative: remove `none` from allowed `COOKIE_SAME_SITE` values** — in
   `config.ts`, change the default branch:

   ```ts
   cookieSameSite: ((): "strict" | "lax" => {
     const v = str("COOKIE_SAME_SITE", "strict").toLowerCase();
     if (v === "none") {
       console.warn("[config] COOKIE_SAME_SITE=none is insecure; falling back to lax");
       return "lax";
     }
     return v === "lax" ? v : "strict";
   })(),
   ```

   If you keep `none` for advanced cross-origin setups, apply step 1-2 as the
   compensating control.

4. **Tests** — add in `test/auth.test.ts`:

   ```ts
   describe("CSRF guard (non-strict cookie mode)", () => {
     it("rejects cross-origin refresh when SameSite is lax", async () => {
       // Set COOKIE_SAME_SITE=lax in test config
       const res = await request(app)
         .post("/api/auth/refresh")
         .set("Origin", "https://evil.example")
         .set("Cookie", `rt=${validRefreshToken}`);
       expect(res.status).toBe(403);
       expect(res.body.code).toBe("CSRF");
     });
   });
   ```

5. **Verification**: `npm test` green, manual test that `/api/auth/refresh` with a
   cross-origin `Origin` header returns 403.

---

### BUG-1 ✅ Filter stale broadcasts from `listLive` and `searchLive`

|               |                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Audit ref** | AUDIT_REPORT_3 §4.3                                                                                                                              |
| **Risk**      | Ghost broadcasts (host died without calling `/end`) appear on the landing page for up to 5 minutes. Clicking them leads to a connection failure. |
| **Goal**      | `listLive()` and `searchLive()` only return broadcasts with a recent heartbeat.                                                                  |

#### Spec

Apply the same staleness window (`COALESCE(stat_at, started_at) > ?`) used by
`liveForUser()` to both listing queries.

#### Implementation steps

1. **`packages/server/src/repos/broadcasts.ts`** — update `listLive`:

   ```ts
   listLive(limit = 60): BroadcastWithUser[] {
     const rows = db
       .prepare(
         `SELECT b.* FROM broadcasts b
          JOIN users u ON u.username_lc = b.username_lc
          WHERE b.status = 'live' AND u.discoverable = 1 AND u.banned = 0
            AND COALESCE(b.stat_at, b.started_at) > ?
          ORDER BY b.started_at DESC LIMIT ?`,
       )
       .all(Date.now() - config.staleLiveMs, limit) as BroadcastRow[];
     return rows.map(withUser);
   },
   ```

2. Apply the identical `AND COALESCE(b.stat_at, b.started_at) > ?` clause to
   `searchLive`, passing `Date.now() - config.staleLiveMs` as the first parameter.

3. **Tests** — in `test/broadcasts.test.ts`, add:

   ```ts
   it("listLive excludes stale broadcasts", async () => {
     // create a broadcast, set stat_at to 10 minutes ago
     db.prepare(`UPDATE broadcasts SET stat_at = ? WHERE id = ?`).run(
       Date.now() - 10 * 60_000,
       broadcastId,
     );
     const res = await request(app).get("/api/broadcasts/live");
     expect(res.body.broadcasts).toHaveLength(0);
   });
   ```

4. **Verification**: `npm test` green, landing page no longer shows ghost broadcasts.

---

### BUG-2 ✅ Fix `consumeVerification` to always delete on attempt

|               |                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §4.1                                                                      |
| **Risk**      | Expired verification tokens linger in the DB until the periodic purge.                   |
| **Goal**      | Match the pattern of `consumeReset`: always delete the token on any consumption attempt. |

#### Implementation steps

1. **`packages/server/src/repos/emailTokens.ts`** — rewrite `consumeVerification`:

   ```ts
   consumeVerification(token: string): string | null {
     const row = db
       .prepare(
         `SELECT username_lc, expires_at FROM email_verifications WHERE token = ?`,
       )
       .get(token) as { username_lc: string; expires_at: number } | undefined;
     // Always delete (match consumeReset pattern — single-use).
     if (row) {
       db.prepare(`DELETE FROM email_verifications WHERE username_lc = ?`).run(
         row.username_lc,
       );
     }
     if (!row || row.expires_at < Date.now()) return null;
     return row.username_lc;
   },
   ```

   Key change: the DELETE runs unconditionally when a row exists, before the
   expiry check. The function still returns `null` on expiry so the caller
   handles it correctly.

2. **Tests** — in `test/email.test.ts`, add:

   ```ts
   it("deletes expired verification tokens on consumption attempt", async () => {
     const token = emailTokensRepo.createVerification("testuser");
     // expire it manually
     db.prepare(
       `UPDATE email_verifications SET expires_at = 0 WHERE token = ?`,
     ).run(token);
     const result = emailTokensRepo.consumeVerification(token);
     expect(result).toBeNull();
     // token should be deleted now
     const row = db
       .prepare(`SELECT * FROM email_verifications WHERE token = ?`)
       .get(token);
     expect(row).toBeUndefined();
   });
   ```

3. **Verification**: `npm test` green.

---

## P1 — High: Next Sprint

Items that fix UX issues that actively confuse or frustrate users, close
important security gaps, or fix bugs that corrupt data/display.

---

### BUG-3 ✅ Guard concurrent `resolve()` calls in ViewerPage

|               |                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| **Audit ref** | AUDIT_REPORT_3 §4.2                                                                                          |
| **Risk**      | Double-clicking "Retry" or a reconnect timer racing the initial mount can open two parallel P2P connections. |
| **Goal**      | Only one resolve → connect flow runs at a time.                                                              |

#### Implementation steps

1. **`packages/web/src/pages/ViewerPage.tsx`** — add a `resolvingRef`:

   ```ts
   const resolvingRef = useRef(false);
   ```

2. At the top of the `resolve()` function, add:

   ```ts
   async function resolve(withCode?: string) {
     if (disposedRef.current || resolvingRef.current) return;
     resolvingRef.current = true;
     try {
       // ... existing body ...
     } finally {
       resolvingRef.current = false;
     }
   }
   ```

3. In the reconnect timer callback (`onClose` inside `connect`), clear the timer ref
   before scheduling the next one to prevent double-scheduling:

   ```ts
   onClose: () => {
     if (disposedRef.current || handleRef.current !== handle) return;
     if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
     const delay = reconnectDelay.current;
     reconnectDelay.current = Math.min(delay * 2, 30_000);
     setPhase("resolving");
     reconnectTimer.current = window.setTimeout(
       () => void resolve(lastCodeRef.current ?? undefined),
       delay,
     );
   },
   ```

4. **Verification**: manual testing — open viewer page, rapidly click Retry; only one
   connection should be established at a time.

---

### SEC-3 ✅ Access code brute-force rate limiting

|               |                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §3.2                                                                                   |
| **Risk**      | A motivated attacker can try 120 access codes per 15 minutes against a code-gated broadcast (one IP). |
| **Goal**      | Reduce the effective brute-force surface for access codes.                                            |

#### Spec

Add a dedicated rate limiter for code-gated session resolves that only counts
failed code attempts. 5 failed code attempts per broadcast per IP per 15 minutes.

#### Implementation steps

1. **`packages/server/src/app.ts`** — after the existing session-ip limiter, add:

   ```ts
   // Code-gated broadcasts: 5 wrong codes / 15 min per (IP + username).
   // Only counts requests that actually carry a ?code= param.
   app.use(
     "/api/sessions",
     mkLim(
       "code-attempt",
       15 * 60_000,
       5,
       (req) => {
         const code = String(req.query?.code ?? "");
         if (!code) return `code:noop:${ipKeyGenerator(req.ip ?? "unknown")}`;
         const username = req.params?.username ?? req.path.split("/")[1] ?? "";
         return `code:${username.toLowerCase()}:${ipKeyGenerator(req.ip ?? "unknown")}`;
       },
       true, // only count failed (non-2xx) responses
     ),
   );
   ```

2. **Tests** — in `test/access.test.ts`:

   ```ts
   it("rate-limits wrong access codes", async () => {
     for (let i = 0; i < 6; i++) {
       await request(app).get(`/api/sessions/${broadcaster}?code=WRONG${i}`);
     }
     const res = await request(app).get(
       `/api/sessions/${broadcaster}?code=WRONG99`,
     );
     expect(res.status).toBe(429);
   });
   ```

   Note: tests must have `rateLimiting: true` for this specific suite (or use a
   separate app instance).

3. **Verification**: `npm test` green.

---

### UX-1 ✅ Confirmation dialogs for destructive admin actions

|               |                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §5.2                                                                                                          |
| **Risk**      | Clicking "Make admin", "Demote", or "Take down" fires immediately with no confirmation. Accidental clicks are unrecoverable. |
| **Goal**      | All destructive admin actions require an explicit confirmation step.                                                         |

#### Implementation steps

1. **Role changes** — in `packages/web/src/pages/AdminPage.tsx`, `UsersTab`:

   a. Add state for the role-change target:

   ```ts
   const [roleTarget, setRoleTarget] = useState<{
     user: AdminUser;
     role: "user" | "admin";
   } | null>(null);
   ```

   b. Replace the inline `setRole` call with:

   ```tsx
   <button
     className="btn-ghost"
     onClick={() => setRoleTarget({ user: u, role: "admin" })}
   >
     Make admin
   </button>
   ```

   c. Add a confirmation Modal below the existing ban modal:

   ```tsx
   {
     roleTarget && (
       <Modal
         title={`Change role for @${roleTarget.user.username}`}
         onClose={() => setRoleTarget(null)}
       >
         <p className="mb-3 text-sm text-slate-400">
           {roleTarget.role === "admin"
             ? "This will grant full admin privileges including ban, takedown, and role management."
             : "This will revoke admin privileges. The user keeps their account."}
         </p>
         <div className="mt-4 flex justify-end gap-2">
           <button className="btn-ghost" onClick={() => setRoleTarget(null)}>
             Cancel
           </button>
           <button
             className="btn-primary"
             onClick={async () => {
               await setRole({
                 username: roleTarget.user.username,
                 role: roleTarget.role,
               });
               setRoleTarget(null);
             }}
           >
             Confirm
           </button>
         </div>
       </Modal>
     );
   }
   ```

2. **Takedowns** — in the `LiveTab` component:

   a. Add state: `const [takedownTarget, setTakedownTarget] = useState<string | null>(null);`
   b. Replace inline `takedown(b.id)` with `setTakedownTarget(b.id)`.
   c. Add a confirmation Modal that calls `takedown(takedownTarget)` on confirm.

3. **Loading states** — add `disabled={isLoading}` to all confirmation buttons
   using the mutation's `isLoading` flag from RTK Query.

4. **Verification**: manual testing — click each action button, verify modal appears,
   confirm, verify toast.

---

### UX-2 🚧 Cursor-based pagination for list endpoints

|               |                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §5.2                                                                             |
| **Risk**      | At scale, endpoints return 60-200 rows in a single response. No way to page.                    |
| **Goal**      | All list endpoints support cursor-based pagination; web UI uses infinite scroll or "Load more". |

#### Spec

- Cursor is the `started_at` (or `created_at`) timestamp of the last item.
- Query param: `?cursor=<timestamp>&limit=<n>` (default limit=20, max=100).
- Response includes a `nextCursor: number | null` field.
- First request omits `cursor` (or sends `cursor=0`).

#### Implementation steps — server

1. **`packages/shared/src/api.ts`** — add pagination types:

   ```ts
   export interface PaginatedMeta {
     nextCursor: number | null;
     limit: number;
   }
   export interface ListBroadcastsResponse {
     broadcasts: BroadcastWithUser[];
     pagination: PaginatedMeta;
   }
   ```

   Update `AdminUsersResponse`, `AdminReportsResponse`, `RecordingListResponse`
   similarly.

2. **`packages/server/src/repos/broadcasts.ts`** — update `listLive`:

   ```ts
   listLive(cursor = 0, limit = 20): { rows: BroadcastWithUser[]; nextCursor: number | null } {
     const rows = db.prepare(
       `SELECT b.* FROM broadcasts b
        JOIN users u ON u.username_lc = b.username_lc
        WHERE b.status = 'live' AND u.discoverable = 1 AND u.banned = 0
          AND COALESCE(b.stat_at, b.started_at) > ?
          AND b.started_at < CASE WHEN ? > 0 THEN ? ELSE 9999999999999 END
        ORDER BY b.started_at DESC LIMIT ?`,
     ).all(Date.now() - config.staleLiveMs, cursor, cursor, limit + 1) as BroadcastRow[];
     const hasMore = rows.length > limit;
     if (hasMore) rows.pop();
     return {
       rows: rows.map(withUser),
       nextCursor: hasMore ? rows[rows.length - 1].started_at : null,
     };
   },
   ```

   Apply the same pattern to `historyForUser`, `listForAdmin`, `listForUser` in
   recordings, and `list` in reports.

3. **Routes** — parse `cursor` and `limit` from query params:
   ```ts
   broadcastsRouter.get(
     "/live",
     asyncHandler(async (req, res) => {
       const cursor = Number(req.query.cursor) || 0;
       const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
       const { rows, nextCursor } = broadcastsRepo.listLive(cursor, limit);
       res.json({ broadcasts: rows, pagination: { nextCursor, limit } });
     }),
   );
   ```

#### Implementation steps — web

4. **`packages/web/src/store/api.ts`** — update the `listLive` query to accept
   cursor/limit and use RTK Query's `merge` for infinite scroll:

   ```ts
   listLive: b.query<ListBroadcastsResponse, { cursor?: number; limit?: number } | void>({
     query: (params) => {
       const p = params ?? {};
       const qs = new URLSearchParams();
       if (p.cursor) qs.set("cursor", String(p.cursor));
       if (p.limit) qs.set("limit", String(p.limit));
       return `/broadcasts/live?${qs}`;
     },
     providesTags: ["Live"],
   }),
   ```

5. **`packages/web/src/pages/LandingPage.tsx`** — add a "Load more" button:

   ```tsx
   {
     data?.pagination.nextCursor && (
       <button className="btn-ghost mx-auto mt-4" onClick={() => loadMore()}>
         Load more
       </button>
     );
   }
   ```

   Or implement `IntersectionObserver`-based infinite scroll.

6. Apply similarly to Dashboard (history), Admin (users, reports), Recordings.

7. **Verification**: `npm run build`, `npm test` green, manual test that pagination
   works with many broadcasts.

---

### UX-3 ✅ Avatar file-based storage (remove inline base64 from DB)

|               |                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §3.2 + §9.2                                                                                                    |
| **Risk**      | 200KB base64 strings in every API response inflate JSON payloads. A page listing 60 live broadcasts with avatars can be 12MB. |
| **Goal**      | Avatars stored as files on disk with CDN-cacheable URLs. DB stores only the file path.                                        |

#### Spec

- `PUT /api/users/me` still accepts `avatarDataUrl` (base64 data URL).
- Server decodes it, writes to `data/avatars/<username_lc>.<ext>`, stores
  `/api/avatars/<username_lc>.<ext>?v=<timestamp>` as `avatar_url`.
- New route: `GET /api/avatars/:filename` serves the file with
  `Cache-Control: public, max-age=604800, immutable` (the `?v=` param busts cache on update).
- Removing an avatar deletes the file and sets `avatar_url = NULL`.
- Migration: on first boot after upgrade, a one-time migration decodes any
  existing `data:image/…` values in the DB into files.

#### Implementation steps

1. **`packages/server/src/lib/avatar.ts`** — new module:

   ```ts
   import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
   import { join, resolve } from "node:path";
   import { config } from "../config.js";

   const AVATAR_DIR = resolve(config.db.file, "../avatars");
   mkdirSync(AVATAR_DIR, { recursive: true });

   const MIME_TO_EXT: Record<string, string> = {
     "image/png": "png",
     "image/jpeg": "jpg",
     "image/webp": "webp",
     "image/gif": "gif",
   };

   export function saveAvatar(usernameLc: string, dataUrl: string): string {
     const match = dataUrl.match(
       /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/s,
     );
     if (!match) throw new Error("invalid avatar data URL");
     const ext = MIME_TO_EXT[match[1]] || "png";
     const buffer = Buffer.from(match[2], "base64");
     const filename = `${usernameLc}.${ext}`;
     const filepath = resolve(AVATAR_DIR, filename);
     if (!filepath.startsWith(AVATAR_DIR)) throw new Error("path escape");
     writeFileSync(filepath, buffer);
     return `/api/avatars/${filename}?v=${Date.now()}`;
   }

   export function deleteAvatar(usernameLc: string): void {
     for (const ext of Object.values(MIME_TO_EXT)) {
       const p = join(AVATAR_DIR, `${usernameLc}.${ext}`);
       rmSync(p, { force: true });
     }
   }

   export function avatarDir(): string {
     return AVATAR_DIR;
   }
   ```

2. **`packages/server/src/routes/users.ts`** — in `PUT /me`, replace the inline
   data URL storage with `saveAvatar()`:

   ```ts
   if (typeof body.avatarDataUrl === "string") {
     const url = saveAvatar(req.auth!.usernameLc, body.avatarDataUrl);
     patch.avatarUrl = url;
   } else if (body.avatarDataUrl === null) {
     deleteAvatar(req.auth!.usernameLc);
     patch.avatarUrl = null;
   }
   ```

3. **`packages/server/src/app.ts`** — add the static avatar route:

   ```ts
   app.use(
     "/api/avatars",
     express.static(avatarDir(), {
       maxAge: "7d",
       immutable: true,
       setHeaders: (res) => {
         res.setHeader("Cache-Control", "public, max-age=604800, immutable");
       },
     }),
   );
   ```

4. **Migration** — in `packages/server/src/db/index.ts`, after schema setup:

   ```ts
   // One-time migration: decode inline base64 avatars to files.
   const avatarRows = db
     .prepare(
       `SELECT username_lc, avatar_url FROM users WHERE avatar_url LIKE 'data:image/%'`,
     )
     .all() as { username_lc: string; avatar_url: string }[];
   for (const r of avatarRows) {
     try {
       const url = saveAvatar(r.username_lc, r.avatar_url);
       db.prepare(`UPDATE users SET avatar_url = ? WHERE username_lc = ?`).run(
         url,
         r.username_lc,
       );
     } catch {
       /* skip broken entries */
     }
   }
   ```

5. **Web** — `Avatar` component already uses `<img src={user.avatarUrl}>`, which
   will work with the new URL. No web changes needed.

6. **Docker** — the avatars directory lives under `/data/avatars` (inside the
   existing volume). No Dockerfile changes.

7. **Verification**: `npm run build`, `npm test`, upload an avatar via Settings,
   verify it appears as a `/api/avatars/` URL in the API response.

---

## P2 — Medium: Near-Term Improvements

Quality-of-life improvements, UX polish, accessibility fixes, and feature
requests that materially improve the product but are not blocking.

---

### UX-4 ✅ Public user profile page (`/user/:username`)

|               |                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| **Audit ref** | AUDIT_REPORT_3 §7.3, §8.2                                                                              |
| **Goal**      | Viewers can see a broadcaster's profile, bio, broadcast history, and follow them — even when not live. |

#### Spec

- New route: `/user/:username` (distinct from `/watch/:username` which is viewer-only).
- Shows: avatar, display name, about, account age, follow button (if authed),
  current live broadcast (if any, with "Watch now" link), and past broadcast
  history (public broadcasts only, paginated).
- If the user has `discoverable: false`, return a 404-style message ("This user
  is not publicly discoverable").

#### Implementation steps

1. **Server** — `GET /api/users/:username` already exists and returns `UserProfileResponse`
   with `user` and `live`. No server changes needed initially. For past broadcasts,
   add a new endpoint:

   ```
   GET /api/users/:username/broadcasts?limit=20&cursor=...
   ```

   Route: `packages/server/src/routes/users.ts`

   ```ts
   usersRouter.get(
     "/:username/broadcasts",
     asyncHandler(async (req, res) => {
       const usernameLc = req.params.username.toLowerCase();
       const user = usersRepo.getRaw(usernameLc);
       if (!user || !user.discoverable || user.banned)
         throw notFound("user not found");
       const cursor = Number(req.query.cursor) || 0;
       const limit = Math.min(Number(req.query.limit) || 20, 50);
       const { rows, nextCursor } = broadcastsRepo.publicHistoryForUser(
         usernameLc,
         cursor,
         limit,
       );
       res.json({ broadcasts: rows, pagination: { nextCursor, limit } });
     }),
   );
   ```

2. **Shared** — add `PublicBroadcastHistoryResponse` to `api.ts`.

3. **Repo** — add `publicHistoryForUser` to `broadcastsRepo`:

   ```ts
   publicHistoryForUser(usernameLc: string, cursor = 0, limit = 20) {
     const rows = db.prepare(
       `SELECT * FROM broadcasts
        WHERE username_lc = ? AND status = 'ended' AND access = 'public'
          AND started_at < CASE WHEN ? > 0 THEN ? ELSE 9999999999999 END
        ORDER BY started_at DESC LIMIT ?`
     ).all(usernameLc, cursor, cursor, limit + 1) as BroadcastRow[];
     const hasMore = rows.length > limit;
     if (hasMore) rows.pop();
     return { rows: rows.map(withUser), nextCursor: hasMore ? rows[rows.length - 1].started_at : null };
   }
   ```

4. **Web** — create `packages/web/src/pages/UserProfilePage.tsx`:
   - Fetch `/api/users/:username` via `useGetUserQuery`.
   - Fetch `/api/users/:username/broadcasts` via new RTK Query endpoint.
   - Show avatar, display name, about, age, follow button.
   - If user has a live broadcast, show a prominent "Watch now" card.
   - Below, show past broadcast list (public only), paginated.

5. **Router** — add to `packages/web/src/App.tsx`:

   ```tsx
   <Route path="user/:username" element={<UserProfilePage />} />
   ```

6. **Link integration** — update `BroadcastCard.tsx` to link the owner name to
   `/user/:username` (currently links to `/watch/:username`).

7. **Verification**: `npm run build`, verify profile page shows correct data.

---

### UX-5 ✅ Broadcast preview before going live

|               |                                                                                         |
| ------------- | --------------------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §5.2, §7.2                                                               |
| **Goal**      | Broadcasters can see their camera/screen output and confirm before viewers can connect. |

#### Implementation steps

1. **`packages/web/src/pages/BroadcastPage.tsx`** — add a `previewing` status:
   - Add new broadcastSlice status: `"idle" | "previewing" | "starting" | "live" | "ending"`.
   - Alternatively, keep preview as local component state (simpler):
     ```ts
     const [previewStream, setPreviewStream] = useState<MediaStream | null>(
       null,
     );
     ```

2. Add a "Preview" button that captures the stream without calling the API:

   ```ts
   async function startPreview() {
     const stream = source === "camera" || ...
       ? await navigator.mediaDevices.getUserMedia({ ... })
       : await navigator.mediaDevices.getDisplayMedia({ ... });
     setPreviewStream(stream);
     if (videoRef.current) {
       videoRef.current.srcObject = stream;
       void videoRef.current.play().catch(() => {});
     }
   }
   ```

3. Show the preview in the video element. Replace the "Go live" button with two
   buttons: "Preview" (when no stream) and "Go live" (when previewing).

4. If the user cancels ("Cancel preview"), stop all tracks and clear the preview.

5. When "Go live" is clicked with an active preview stream, skip the media capture
   step in `goLive()` and reuse `previewStream`.

6. **Verification**: manual testing — click Preview, verify camera/screen appears,
   click Go Live, verify broadcast starts.

---

### UX-6 ✅ Collapsible chat panel on mobile

|               |                                                                           |
| ------------- | ------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §6.1                                                       |
| **Goal**      | Chat doesn't consume fixed 288px on mobile; users can expand/collapse it. |

#### Implementation steps

1. In both `BroadcastPage.tsx` and `ViewerPage.tsx`, wrap the chat `div` in a
   collapsible section:

   ```tsx
   const [chatOpen, setChatOpen] = useState(true);
   // ...
   <div className="card flex flex-col p-4 sm:p-5">
     <button
       className="mb-2 flex items-center justify-between sm:cursor-default"
       onClick={() => setChatOpen((o) => !o)}
     >
       <h3 className="font-semibold text-slate-200">Chat</h3>
       <span className="text-slate-400 sm:hidden">{chatOpen ? "▾" : "▸"}</span>
     </button>
     {chatOpen && <>{/* chat messages + input */}</>}
   </div>;
   ```

2. Use `max-h-[50vh]` instead of `h-72` for the message scroll area on mobile:

   ```tsx
   <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 text-sm
                    max-h-[50vh] sm:max-h-none sm:h-auto">
   ```

3. **Verification**: resize browser to mobile width, verify chat collapses.

---

### UX-7 ✅ Mobile search bar for unauthenticated users

|               |                                                                        |
| ------------- | ---------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §6.1                                                    |
| **Goal**      | Search is always discoverable on mobile, even for logged-out visitors. |

#### Implementation steps

1. **`packages/web/src/components/Layout.tsx`** — add a search icon button to the
   mobile header, visible to all users:

   ```tsx
   const [mobileSearch, setMobileSearch] = useState(false);
   // In the header, before the nav:
   <button
     type="button"
     aria-label="Search"
     onClick={() => setMobileSearch((o) => !o)}
     className="flex min-h-11 min-w-11 items-center justify-center rounded-lg
                text-slate-300 sm:hidden ..."
   >
     🔍
   </button>;
   ```

2. Conditionally render a full-width search bar below the header on mobile:

   ```tsx
   {
     mobileSearch && (
       <div className="border-b border-white/5 bg-ink-900/80 px-4 py-2 sm:hidden">
         <form onSubmit={onSearch}>
           <input
             className="input"
             placeholder="Search…"
             value={q}
             onChange={(e) => setQ(e.target.value)}
             autoFocus
           />
         </form>
       </div>
     );
   }
   ```

3. **Verification**: open on mobile, verify search icon is visible, tap to expand.

---

### A11Y-1 ✅ Accessibility pass: ARIA labels, contrast, focus management

|               |                                           |
| ------------- | ----------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §6.2                       |
| **Goal**      | Meet WCAG 2.1 AA for the most-used flows. |

#### Implementation steps

1. **Toasts** — in `Toasts.tsx`, add `role="alert"` and `aria-live="polite"` to the
   toast container:

   ```tsx
   <div className="fixed bottom-4 right-4 z-50 space-y-2"
        role="region" aria-label="Notifications" aria-live="polite">
   ```

2. **Header "Live" badge** — add `aria-label="Manage your live broadcast"`:

   ```tsx
   <NavLink to="/broadcast" aria-label="Manage your live broadcast" ...>
   ```

3. **Stats badges** — add `aria-label` to the viewer overlay in ViewerPage:

   ```tsx
   <span aria-label={`${liveStats.viewers} viewers, ${liveStats.bitrateKbps} kbps`} ...>
   ```

4. **Color contrast** — in `tailwind.config.js`, update `ink` and usage:
   - Replace `text-slate-500` in secondary text contexts with `text-slate-400`.
   - Replace footer `text-slate-500` with `text-slate-400`.
   - Verify with Chrome DevTools contrast checker or axe-core.

5. **Skip-to-content** — in `Layout.tsx`, add as the first child of the root div:

   ```tsx
   <a
     href="#main-content"
     className="sr-only focus:not-sr-only focus:absolute
     focus:top-2 focus:left-2 focus:z-50 focus:bg-brand-500 focus:text-white
     focus:px-4 focus:py-2 focus:rounded"
   >
     Skip to content
   </a>
   ```

   Add `id="main-content"` to the `<main>` element.

6. **Modal focus restore** — in `Modal.tsx`, track and restore focus:

   ```ts
   const triggerRef = useRef<HTMLElement | null>(null);
   useEffect(() => {
     triggerRef.current = document.activeElement as HTMLElement;
     return () => {
       triggerRef.current?.focus();
     };
   }, []);
   ```

7. **Verification**: run `npx axe-cli http://localhost:5173` or use the axe browser
   extension. Fix any remaining violations.

---

### UX-8 ✅ Admin tab state persistence in URL

|               |                                                     |
| ------------- | --------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §5.2                                 |
| **Goal**      | Refreshing the Admin page preserves the active tab. |

#### Implementation steps

1. **`packages/web/src/pages/AdminPage.tsx`** — replace the `useState` for `tab`:

   ```ts
   const [params, setParams] = useSearchParams();
   const tab = (params.get("tab") as Tab) || "metrics";
   function setTab(t: Tab) {
     setParams({ tab: t }, { replace: true });
   }
   ```

2. Update the tab buttons to use `setTab(...)` instead of the old setter.

3. **Verification**: navigate to `/admin?tab=reports`, refresh, verify tab persists.

---

### UX-9 ✅ Settings page unsaved-changes warning

|               |                                                                             |
| ------------- | --------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §5.2                                                         |
| **Goal**      | Users are warned before navigating away from Settings with unsaved changes. |

#### Implementation steps

1. **`packages/web/src/pages/SettingsPage.tsx`** — track dirty state:

   ```ts
   const [dirty, setDirty] = useState(false);
   ```

   Set `dirty = true` in every `onChange` handler.
   Set `dirty = false` after every successful save.

2. Add a `beforeunload` handler:

   ```ts
   useEffect(() => {
     const handler = (e: BeforeUnloadEvent) => {
       if (dirty) {
         e.preventDefault();
         e.returnValue = "";
       }
     };
     window.addEventListener("beforeunload", handler);
     return () => window.removeEventListener("beforeunload", handler);
   }, [dirty]);
   ```

3. Use React Router's `useBlocker` (v6.4+) to intercept in-app navigation:

   ```ts
   import { useBlocker } from "react-router-dom";
   const blocker = useBlocker(dirty);
   // Render a confirmation modal when blocker.state === "blocked"
   ```

4. **Verification**: change a setting, try to navigate away, verify prompt appears.

---

### SEC-4 ✅ Per-account failed-login lockout

|               |                                                                             |
| ------------- | --------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §3.2                                                         |
| **Goal**      | Distributed credential-stuffing attacks are throttled at the account level. |

#### Spec

- After 20 failed login attempts within 30 minutes (from any IPs), the account
  is temporarily locked for 30 minutes.
- The lock is tracked in the `users` table: `locked_until INTEGER`.
- Failed attempts are counted in a new `login_attempts` table (or a simple
  counter + timestamp in the users row).
- Successful login resets the counter.
- Email notification on lockout (fire-and-forget).

#### Implementation steps

1. **`packages/server/src/db/index.ts`** — add columns:

   ```sql
   ensureColumn("users", "failed_logins", "failed_logins INTEGER NOT NULL DEFAULT 0");
   ensureColumn("users", "failed_login_window", "failed_login_window INTEGER");
   ensureColumn("users", "locked_until", "locked_until INTEGER");
   ```

2. **`packages/server/src/repos/users.ts`** — add methods:

   ```ts
   recordFailedLogin(usernameLc: string): void { ... }
   resetFailedLogins(usernameLc: string): void { ... }
   isLocked(usernameLc: string): boolean { ... }
   ```

3. **`packages/server/src/routes/auth.ts`** — in the login handler, after
   credential verification:

   ```ts
   if (usersRepo.isLocked(user.username_lc)) {
     throw forbidden(
       "account temporarily locked — try again in 30 minutes",
       "ACCOUNT_LOCKED",
     );
   }
   if (!ok) {
     usersRepo.recordFailedLogin(user.username_lc);
     throw unauthorized("invalid credentials", "BAD_CREDENTIALS");
   }
   usersRepo.resetFailedLogins(user.username_lc);
   ```

4. **Tests** — in `test/auth.test.ts`:

   ```ts
   it("locks account after 20 failed attempts", async () => { ... });
   it("unlocks account after 30 minutes", async () => { ... });
   ```

5. **Verification**: `npm test` green.

---

### UX-10 ✅ Viewer stats for non-discoverable broadcasts

|               |                                                                               |
| ------------- | ----------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §5.2                                                           |
| **Goal**      | Viewers of members-only / code-gated broadcasts see viewer count and bitrate. |

#### Implementation steps

1. **`packages/server/src/routes/sessions.ts`** — in the resolve response,
   include stats from the broadcast row:

   ```ts
   const stats = statsOf(row);
   res.json({ ...base, peerId: row.peer_id, ticket, stats } as ResolveResponse);
   ```

2. **`packages/shared/src/api.ts`** — add `stats?: BroadcastStats` to `ResolveResponse`.

3. **`packages/web/src/pages/ViewerPage.tsx`** — use `result.data?.stats` as a
   fallback when `liveStats` from the public feed is unavailable:

   ```ts
   const resolveStats = result.data?.broadcast?.stats;
   const displayStats = liveStats || resolveStats;
   ```

4. **Verification**: start a members-only broadcast, join as viewer, verify stats appear.

---

## P3 — Low: Strategic & Future

Items that are not blocking but add significant long-term value. Include
tech debt, new feature tracks, and monetization enablers.

---

### FEAT-1 ✅ Chat moderation: mute/kick for broadcasters

|               |                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §8.1                                                                       |
| **Goal**      | Broadcasters can mute or kick individual viewers from chat without banning their account. |

#### Spec

- Mute: broadcaster sends a `{ kind: "mute", peerId: "..." }` message over the
  data channel. The host's `handleChat` drops messages from muted peers.
- Kick: broadcaster sends `{ kind: "kick", peerId: "..." }`. The host closes
  the media + data connections for that peer.
- The muted/kicked list is ephemeral (per broadcast session, in the BroadcastHost
  instance). It is not persisted.
- The UI shows a "Mute" / "Kick" action next to each viewer's chat line on the
  broadcaster page.

#### Implementation steps

1. **`packages/web/src/lib/peer.ts`** — in `BroadcastHost`:

   ```ts
   private mutedPeers = new Set<string>();
   mutePeer(peerId: string) { this.mutedPeers.add(peerId); }
   kickPeer(peerId: string) {
     for (const call of this.calls) { if (call.peer === peerId) call.close(); }
     for (const conn of this.dataConns) { if (conn.peer === peerId) conn.close(); }
   }
   ```

   In `handleChat`, check: `if (this.mutedPeers.has(fromConn.peer)) return;`

2. **`packages/web/src/pages/BroadcastPage.tsx`** — add mute/kick buttons next
   to each chat message (show peer id or viewer name from `names` map). Pass
   action up via `onChat` callback enriched with peer identity.

3. **Verification**: manual testing with two browser windows.

---

### FEAT-2 ⬜ Broadcast categories/tags for discovery

|               |                                                                         |
| ------------- | ----------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §8.1                                                     |
| **Goal**      | Viewers can browse broadcasts by category instead of searching by name. |

#### Spec

- Pre-defined categories: Gaming, Tutorial, Presentation, Meeting, Creative,
  Music, Other.
- Broadcaster selects one category when starting. Optional free-form tags (up to 5).
- Landing page shows category filter chips above the live feed.
- DB: `category TEXT` column on `broadcasts`, `broadcast_tags` junction table.
- Shared: `BroadcastCategory` type.

#### Implementation steps

1. **Shared** — `models.ts`: add `BroadcastCategory` type enum.
2. **Server** — `db/index.ts`: `ensureColumn("broadcasts", "category", ...)`.
3. **Server** — `repos/broadcasts.ts`: add `category` to `start()`, filter in
   `listLive()`.
4. **Server** — `routes/broadcasts.ts`: add `category` to `startSchema`.
5. **Web** — `BroadcastPage.tsx`: add category selector to the form.
6. **Web** — `LandingPage.tsx`: add filter chips above `LiveFeed`.

---

### FEAT-3 ✅ Embedded player (`<iframe>` embed code)

|               |                                                                         |
| ------------- | ----------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §8.1                                                     |
| **Goal**      | External websites can embed a PeerCast player with a simple `<iframe>`. |

#### Spec

- New route: `/embed/:username` — renders a minimal viewer (video + stats badge, no
  header/footer/chat).
- CSP `frame-ancestors` loosened for this route only (or configurable via
  `EMBED_ALLOWED_ORIGINS`).
- The broadcast page shows a "Copy embed code" button when live.

#### Implementation steps

1. **Web** — create `packages/web/src/pages/EmbedPage.tsx` — a stripped-down version
   of `ViewerPage` without Layout, chat, or report UI.
2. **Router** — add `<Route path="embed/:username" element={<EmbedPage />} />` outside
   the `<Route element={<Layout />}>` wrapper.
3. **Server** — in `configureApp`, allow `frame-ancestors` for the `/embed` path.
4. **Web** — `BroadcastPage.tsx`: show embed code snippet when live.

---

### FEAT-4 ✅ Admin audit log

|               |                                                                         |
| ------------- | ----------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §7.4                                                     |
| **Goal**      | All admin actions are recorded with who, what, when for accountability. |

#### Spec

- New table: `audit_log (id, actor_username_lc, action, target, detail, created_at)`.
- Actions: ban, unban, role_change, takedown, report_resolve, invite_create,
  invite_disable, user_delete.
- API: `GET /api/admin/audit?limit=50&cursor=...` (admin only).
- UI: new "Audit" tab on the Admin page.

#### Implementation steps

1. **DB** — add `audit_log` table in `db/index.ts`.
2. **Repo** — `packages/server/src/repos/audit.ts`:
   ```ts
   export function log(
     actor: string,
     action: string,
     target: string,
     detail?: string,
   ) {
     db.prepare(
       `INSERT INTO audit_log (id, actor_username_lc, action, target, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
     ).run(nanoid(16), actor, action, target, detail ?? null, Date.now());
   }
   ```
3. **Routes** — sprinkle `audit.log(req.auth!.usernameLc, "ban", lc, reason)` calls
   into every admin route handler.
4. **Shared** — `AuditEntry` type, `AuditLogResponse`.
5. **Admin route** — `GET /api/admin/audit`.
6. **Web** — new `AuditTab` in AdminPage.

---

### FEAT-5 ⬜ Stream thumbnails for broadcast cards

|               |                                                                     |
| ------------- | ------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §8.1                                                 |
| **Goal**      | Broadcast cards show a recent screenshot instead of a generic icon. |

#### Spec

- Broadcaster host captures a thumbnail via `canvas.drawImage(video)` every 30 seconds.
- Thumbnail is uploaded to `POST /api/broadcasts/:id/thumbnail` as a JPEG blob (≤ 50KB).
- Server stores in `data/thumbnails/<broadcast_id>.jpg`.
- `BroadcastWithUser` response includes `thumbnailUrl: string | null`.
- Thumbnails are deleted when the broadcast ends.

#### Implementation steps

1. **Server** — new route, new column, new static serve path.
2. **Web** — `BroadcastHost` gains a `captureThumb()` method on a 30s timer.
3. **Web** — `BroadcastCard.tsx` shows `<img src={b.thumbnailUrl}>` if present.

---

### FEAT-6 ⬜ SFU relay for large audiences (monetization enabler)

|               |                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------- |
| **Audit ref** | AUDIT_REPORT_3 §9.2, §10                                                                       |
| **Goal**      | Break the 5–15 viewer barrier by optionally routing media through a Selective Forwarding Unit. |

#### Spec

- Integrate mediasoup or Janus as an optional SFU.
- Broadcaster publishes one stream to the SFU; the SFU fans out to N viewers.
- Configuration: `SFU_ENABLED=true`, `SFU_URL=wss://...`.
- The web broadcaster auto-selects SFU mode when available, falls back to P2P.
- This is a premium/paid feature in the Open Core model.

#### Implementation steps (high-level)

1. Research and select SFU (mediasoup recommended for Node.js).
2. Create `packages/sfu/` — a separate process/container running the SFU.
3. Server: when SFU is configured, the resolve endpoint returns an SFU-specific
   connection descriptor instead of a raw peer ID.
4. Web: add an SFU transport path alongside the existing PeerJS path.
5. Docker: add `sfu` service to `docker-compose.yml` with a `--profile sfu` flag.

---

### TECH-DEBT ⬜ Previously tracked hardening items

Carried forward from previous audits. See `AUDIT_REPORT.md` for full context.

| Item                                                        | Priority | Notes                                                                                                 |
| ----------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| **Dev toolchain security bump** (vite 5→8, vitest 2→5)      | Medium   | Dev-only; schedule as a dedicated effort with full regression pass.                                   |
| **Refresh-token reuse detection** (family-based revocation) | Low      | Already partially shipped (family column exists). Wire up full revocation on replayed consumed token. |
| **Test isolation: fake timers**                             | Low      | Wrap `vi.useFakeTimers` in try/finally.                                                               |
| **Configurable `trust proxy`**                              | Low      | Add `TRUST_PROXY` env var, document proxy depth.                                                      |
| **Coordinated housekeeping** for multi-instance             | Low      | Advisory lock or leader election. Only needed if multi-instance ever ships.                           |

---

## Extension Track

| Feature                        | Status | Notes                                                                                      |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------ |
| **Chrome Web Store**           | ⬜     | Package and submit the extension for public distribution.                                  |
| **Firefox MV3 port**           | ⬜     | Firefox lacks the offscreen API; needs a different architecture for background capture.    |
| **Extension recording parity** | ⬜     | The extension can record via its BroadcastHost lifecycle; today only the web page records. |

---

## Known limits (accepted)

- DRM content (Netflix etc.) refuses `tabCapture` — by browser design.
- System audio on screen/window capture depends on OS/browser support.
- Symmetric NAT requires a TURN server (`ICE_SERVERS`).
- The free PeerJS cloud is replaced by self-hosted signaling; no cloud fallback in v2.
- Pure P2P fan-out realistically supports 5–15 concurrent viewers per broadcaster
  (CPU/bandwidth-bound). See FEAT-6 (SFU) for the scaling path.
- P2P chat is ephemeral and unmoderated by design (rendezvous-only model). See
  FEAT-1 for broadcaster-side mute/kick. Server-side chat moderation would
  require a relay mode (not P2P).
