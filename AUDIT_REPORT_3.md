# PeerCast — Comprehensive Audit Report

**Date:** June 2025
**Version audited:** 1.1.6
**Codebase size:** ~15,300 lines (TS/TSX/JS/CSS, excluding tests)
**Branch:** webapp-nodejs (v2 — self-hosted Node.js edition)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture & Engineering](#2-architecture--engineering)
3. [Security & Privacy](#3-security--privacy)
4. [Potential Bugs & Logical Errors](#4-potential-bugs--logical-errors)
5. [UX/UI Design Review](#5-uxui-design-review)
6. [Responsiveness & Accessibility](#6-responsiveness--accessibility)
7. [End-User Perspective](#7-end-user-perspective)
8. [Feature Gaps & Improvement Suggestions](#8-feature-gaps--improvement-suggestions)
9. [Performance & Scalability](#9-performance--scalability)
10. [Monetization Strategies](#10-monetization-strategies)
11. [Priority Action Items](#11-priority-action-items)

---

## 1. Executive Summary

PeerCast is a well-engineered, self-hosted peer-to-peer screen broadcasting platform. It leverages WebRTC for direct media transmission between broadcaster and viewers, with only signaling touching the server. The architecture is clean, the security posture is strong for a self-hosted application, and the feature set is comprehensive.

### Strengths
- **Excellent separation of concerns**: shared types → server → web → extension
- **Strong security model**: two-gate access control, auth-gated signaling, timing-safe comparisons, access codes stored hashed
- **Thoughtful JWT handling**: HttpOnly cookies for refresh tokens, short-lived access tokens, token version bumping on credential changes
- **Comprehensive rate limiting** with Redis scaling path
- **Good test coverage**: 98+ unit tests, 5 E2E tests
- **Production-ready Docker setup** with proper multi-stage builds
- **P2P-first design** keeps media private — the server never sees it

### Key Concerns
- Several medium-severity security items need attention
- Missing CSRF protection on cookie-based endpoints
- Some UX rough edges on mobile
- No content delivery optimization for multi-viewer scenarios
- Limited observability/monitoring infrastructure

---

## 2. Architecture & Engineering

### 2.1 What Works Well

| Aspect | Assessment |
|--------|------------|
| **Monorepo structure** | ✅ Clean npm workspace layout with shared types preventing drift |
| **Database layer** | ✅ All SQL in repos/, idempotent migrations, WAL mode, FK cascades |
| **Auth architecture** | ✅ Stateless JWT access + rotating refresh in HttpOnly cookies is best practice |
| **Signaling security** | ✅ Opaque signaling tickets prevent JWT leakage in WebSocket URLs |
| **Error handling** | ✅ Consistent AppError → status/code pattern, Zod validation, SyntaxError catch |
| **Broadcast lifecycle** | ✅ Stale broadcast reaper, forced cleanup on ban, transactional start |
| **Token management** | ✅ Token version bump on password/email change invalidates all JWTs immediately |
| **Email flow** | ✅ Fire-and-forget, stdout fallback, tokens single-use |

### 2.2 Architectural Concerns

#### MEDIUM: Single-process SQLite bottleneck
SQLite with WAL is excellent for single-process deployments, but the architecture has no horizontal scaling path beyond what Redis provides for rate limits and signaling tickets. The database itself, recordings, and broadcast state are all process-local.

**Recommendation:** This is acceptable for the current use case (self-hosted, single node) but document the ceiling explicitly. If multi-instance is ever needed, consider PostgreSQL migration with a compatibility layer.

#### MEDIUM: Recording storage is co-located with the DB
WebM recordings stored on the same filesystem as SQLite (`data/recordings/`) mean disk I/O from large recording uploads can impact database performance, and disk space is shared.

**Recommendation:** Add configurable separate mount points. Consider object storage (S3/MinIO) for recordings as an optional backend.

#### LOW: No message queue / event bus
Push notifications, email sends, and stat forwards are all fire-and-forget inline. At scale, a message queue would decouple these.

**Recommendation:** Not blocking for v1, but design a minimal event emitter interface in the server so that a Redis pub/sub or bull queue can be plugged in later.

#### LOW: Housekeeping runs on timer, not coordinated
The 5-minute `setInterval` housekeeping loop (stale broadcast reaping, token purging) works for single-instance but would double-run in multi-instance.

**Recommendation:** Add a simple advisory lock or leader election if multi-instance becomes a goal.

---

## 3. Security & Privacy

### 3.1 Critical/High Priority

#### HIGH: Missing CSRF protection on state-changing cookie endpoints
The refresh token is sent as an HttpOnly `SameSite=Strict` cookie scoped to `/api/auth`. While `SameSite=Strict` mitigates most CSRF vectors, the `COOKIE_SAME_SITE` config allows operators to set `lax` or `none`. When set to `lax` or `none`, `POST /api/auth/refresh` and `POST /api/auth/logout` become vulnerable to CSRF because:
- No CSRF token is checked
- The cookie is automatically attached by the browser
- `SameSite=Lax` still sends cookies on top-level POST navigations in some edge cases

**Recommendation:** Add a CSRF token (double-submit cookie pattern, or check `Origin`/`Referer` headers) to all cookie-dependent endpoints. Alternatively, remove the `none` option from `COOKIE_SAME_SITE` or require an explicit opt-in with prominent warnings.

#### HIGH: Recording replay path traversal potential
In `recordings.ts`, `partFileOf` and `replayFileOf` construct file paths by interpolating `id`:
```ts
export function partFileOf(id: string): string {
  return join(config.recordings.dir, `${id}.webm.part`);
}
```
The `id` is generated server-side with `randomBytes(9).toString("hex")`, so in normal flow it's safe. However, `getOwned()` takes the `id` from `req.params.id` — if an attacker could inject a path-traversal ID (e.g., `../../../etc/passwd`), the `join()` would resolve outside the recordings directory.

**Recommendation:** Validate that `req.params.id` matches `/^[0-9a-f]+$/` before any file operation, or use `path.resolve()` + verify the result starts with the recordings dir.

### 3.2 Medium Priority

#### MEDIUM: Access code brute-force on code-gated broadcasts
The session resolve endpoint (`GET /api/sessions/:username?code=...`) has rate limiting (120/15 min per IP), but for code-gated broadcasts, each request with a wrong code returns 403. The minimum code length is 6 characters. With 120 attempts per 15 minutes, a determined attacker could probe codes.

**Recommendation:** Add per-broadcast code-attempt limiting (e.g., 5 wrong codes per broadcast per IP per 15 min) or implement progressive delay after failed code attempts.

#### MEDIUM: Email enumeration via timing on registration
The registration route does `usersRepo.getRaw(usernameLc) || usersRepo.emailExists(body.email.toLowerCase())`. While the error message is identical for both cases (good!), the `await hashPassword(body.password)` only runs after the check passes. An attacker can measure response time: a fast 409 means the username/email exists; a slow 409 would require password hashing. However, since both collisions skip hashing, the timing is consistent — this is handled well. ✅

#### MEDIUM: Avatar data URL stored directly in DB
Avatar images are stored as `data:image/*;base64,...` strings directly in the SQLite database (up to 200KB each). This:
1. Bloats the DB file size significantly at scale
2. Transfers the full base64 string every time user data is fetched (API responses, broadcast cards, etc.)
3. No CDN caching possible

**Recommendation:** Store avatars as files on disk (like recordings) and serve them via a static route with proper caching headers. Return a URL in the API.

#### MEDIUM: No account lockout after repeated failed logins
Rate limiting exists (10/15 min per username), but there's no account-level lockout. A distributed attacker using multiple IPs could attempt credential stuffing.

**Recommendation:** Consider a per-account failed-login counter that triggers a temporary lockout (e.g., 30 min after 20 failed attempts from any IP combination), with email notification.

### 3.3 Low Priority

#### LOW: `trust proxy` set to `1` in production
This trusts the first `X-Forwarded-For` header, which is correct for a single reverse proxy. If the deployment is behind multiple proxies (CDN → load balancer → app), the IP used for rate limiting could be spoofed.

**Recommendation:** Document the expected proxy depth and recommend operators set `TRUST_PROXY` to the appropriate value.

#### LOW: JWT secret in memory
The JWT secret is held in a plain JavaScript variable in process memory. In a compromised-server scenario, it's extractable via heap dump.

**Assessment:** This is the standard pattern for Node.js JWT libraries. No action needed unless the threat model includes server-memory compromise, in which case HSM/KMS integration would be appropriate.

#### LOW: Signaling tickets not bound to IP
Signaling tickets (`issueSignalingTicket`) are bound to the user but not the IP. A stolen ticket can be used from any IP within its 2-minute TTL.

**Assessment:** The 2-minute TTL and single-use nature make this a very narrow window. IP binding would break users behind carrier-grade NAT. Acceptable.

#### LOW: Chat messages not persisted or auditable
P2P chat rides the data channel and the server never sees it. This is by design (rendezvous-only moderation) but means:
- No chat history for viewers who join late
- No content moderation of chat (only user-level bans)
- Abusive chat can only be reported after the fact, with no evidence

**Recommendation:** Document this explicitly as a design choice. Consider an optional server-relay chat mode for instances that need moderation.

---

## 4. Potential Bugs & Logical Errors

### 4.1 Bug: `consumeReset` always deletes but `consumeVerification` doesn't on expiry

In `emailTokensRepo.consumeVerification()`:
```ts
const row = db.prepare(`SELECT ... WHERE token = ?`).get(token);
if (!row || row.expires_at < Date.now()) return null;
db.prepare(`DELETE FROM email_verifications WHERE username_lc = ?`).run(row.username_lc);
```
If the token exists but is expired, it returns `null` but does NOT delete the expired token. The expired token stays in the DB until the next `purgeExpired()` or until the user re-issues a verification.

Meanwhile, `consumeReset()` correctly always deletes:
```ts
db.prepare(`DELETE FROM password_resets WHERE token = ?`).run(token);
if (!row || row.expires_at < Date.now()) return null;
```

**Impact:** Minor — expired verification tokens are cleaned up by the periodic purge, but the inconsistency is a code smell.

**Recommendation:** Make `consumeVerification` always delete the token on any consumption attempt, matching the reset token pattern.

### 4.2 Bug: Viewer page `resolve()` doesn't handle concurrent calls
The `resolve()` function in `ViewerPage.tsx` is called from:
- Initial mount effect
- Retry buttons
- Reconnect timer
- Code submission

Multiple concurrent calls are possible (e.g., user clicks "Retry" while a reconnect timer fires). Each call triggers `setPhase("resolving")` and potentially `connect()`, which calls `teardown()` first — but there's a race window where two calls could both pass the `disposedRef` check.

**Impact:** Could cause double-connection attempts, leading to two peers being established. The `connect()` function does call `teardown()` first, which partially mitigates this.

**Recommendation:** Add a `resolvingRef` guard to prevent concurrent resolve calls.

### 4.3 Bug: `listLive` doesn't filter stale broadcasts
`broadcastsRepo.listLive()` returns all broadcasts with `status = 'live'` and `discoverable = 1`, but does NOT apply the staleness check that `liveForUser()` uses:
```ts
// liveForUser has: AND COALESCE(stat_at, started_at) > ?
// listLive doesn't have this check
listLive(limit = 60): BroadcastWithUser[] {
    const rows = db.prepare(
      `SELECT b.* FROM broadcasts b JOIN users u ... WHERE b.status = 'live' ...`
    ).all(limit)
```

**Impact:** Ghost broadcasts that have stopped heartbeating (but haven't been reaped yet by the 5-minute housekeeping loop) appear in the landing page live feed. They'll disappear at the next reap cycle, but in the meantime, viewers clicking on them will get a connection error.

**Recommendation:** Apply the same staleness filter to `listLive()` and `searchLive()`.

### 4.4 Bug: Broadcast stats `totalConnections` fallback logic
In `updateStats`:
```ts
const total = s.totalConnections != null
  ? Math.max(r.total_views, s.totalConnections)
  : Math.max(r.total_views, r.peak_viewers, s.viewers);
```
The fallback path (`Math.max(r.total_views, r.peak_viewers, s.viewers)`) means that if a broadcaster's viewer count ever decreases (viewers leave), `total_views` grows monotonically but may overcount since `peak_viewers` is used as a proxy.

**Impact:** Minor inaccuracy in total view counts for old extension clients.

### 4.5 Potential issue: `endLive` race in BroadcastPage
The `endLive()` function uses `endingRef.current` as a guard:
```ts
if (endingRef.current) return;
```
But the function is `async` — there's a gap between setting `endingRef.current = true` and the `await endBroadcastMutation(id).unwrap()`. If the function is called again during that `await`, it returns early (correct). But `broadcastService.cleanup()` is called synchronously before the await, which is correct.

**Assessment:** The guard logic is sound. The `statusRef` + `endingRef` pattern works correctly.

---

## 5. UX/UI Design Review

### 5.1 Strengths
- **Consistent dark theme** with a professional, modern aesthetic
- **Clear visual hierarchy**: cards, badges, buttons follow a coherent design system
- **Good component reuse**: `BroadcastCard`, `Avatar`, `IllustratedMessage`, `Modal`, `Spinner`
- **Toast notification system** replaces scattered inline messages
- **Helpful empty states** with icons and descriptions
- **PWA installability** provides native-app-like experience

### 5.2 Issues

#### HIGH: No loading states for destructive actions
Admin actions (ban, takedown, role change) have no loading indicators or confirmation beyond the ban modal. Clicking "Make admin" or "Demote" fires immediately.

**Recommendation:** Add confirmation modals for role changes and takedowns. Show inline loading spinners on destructive action buttons.

#### HIGH: No pagination on any list view
- `/broadcasts/live` returns up to 60 broadcasts
- `/admin/users` returns up to 100 users
- `/broadcasts/mine` returns up to 100 broadcasts
- `/recordings` has no limit
- Admin reports have no limit

For instances with moderate usage, these will all load in one request. At scale, the frontend will freeze.

**Recommendation:** Implement cursor-based pagination for all list endpoints, with infinite scroll or "Load more" buttons in the UI.

#### MEDIUM: Settings page has no unsaved-changes warning
Navigating away from the Settings page with unsaved changes provides no prompt.

**Recommendation:** Use `beforeunload` or React Router's navigation blocking to warn about unsaved changes.

#### MEDIUM: Broadcast page capture source UX confusion
The capture source dropdown shows "Camera and microphone" / "Camera only" / "Microphone only" / "Entire screen" options. On mobile, the screen options are hidden, but on desktop, users unfamiliar with `getDisplayMedia` may not understand the difference between "Entire screen", "Application window", and "Browser tab".

**Recommendation:** Add brief descriptions under each option (tooltip or helper text) explaining what they capture.

#### MEDIUM: Viewer page has no real-time viewer count for non-public broadcasts
The viewer stats overlay uses the live feed polling (`useListLiveQuery`) to show viewer count, but this only works for discoverable broadcasts. Non-discoverable or members-only broadcasts won't appear in the live feed, so their viewers see no stats.

**Recommendation:** Include stats in the `ResolveResponse` or add a dedicated stats endpoint that respects the same access control.

#### LOW: No visual feedback when copying invite codes / viewer links
The "Copy" button for invite codes changes text to "Copied" for 1.5 seconds, but the viewer link copy only shows a toast. The behavior should be consistent.

#### LOW: Admin page tab state not preserved in URL
Switching between Metrics / Users / Reports / Live / Invites tabs doesn't update the URL. Refreshing always returns to the first tab.

**Recommendation:** Persist the active tab in a URL query parameter (`?tab=reports`).

#### LOW: No broadcast preview before going live
The video element shows a placeholder until the broadcast starts. Users can't verify their camera/screen selection before committing.

**Recommendation:** Add a "Preview" step that captures the stream, shows it in the video element, and requires a "Confirm & Go Live" button.

---

## 6. Responsiveness & Accessibility

### 6.1 Responsive Design

#### GOOD
- Layout uses Tailwind's responsive breakpoints (`sm:`, `lg:`)
- Mobile hamburger menu with slide-out drawer
- Grid layouts adapt from 1 → 2 → 3 columns
- `min-h-11` on interactive elements ensures touch targets ≥ 44px

#### ISSUES

##### MEDIUM: Chat panel fixed height on small screens
The chat panel on both Broadcast and Viewer pages uses `h-72` (288px fixed height). On mobile devices with small viewports, the video + chat + controls may not all fit, requiring excessive scrolling. The chat doesn't collapse.

**Recommendation:** Make the chat panel collapsible on mobile, or use a bottom sheet pattern. Consider `max-h-[50vh]` instead of a fixed height.

##### MEDIUM: Admin table layout breaks on small screens
The Users and Reports tabs in the Admin page render complex rows with avatars, multiple badges, and action buttons. On screens < 640px, content overflows or buttons stack awkwardly.

**Recommendation:** Switch to a card-based layout on mobile for admin lists instead of horizontal rows.

##### LOW: Search input not visible on mobile without drawer
On mobile, the search bar is hidden in the hamburger drawer. Users must open the drawer to search, which is not immediately discoverable. For unauthenticated users, there's no drawer at all — search is inaccessible on mobile unless they're logged in.

**Recommendation:** Add a search icon to the mobile header that expands to an inline search bar.

### 6.2 Accessibility

#### ISSUES

##### MEDIUM: Missing ARIA labels on several interactive elements
- The "Go live" badge in the header (`NavLink`) lacks `aria-label`
- Stats overlay badges lack descriptive text for screen readers
- Toast notifications don't use `role="alert"` or `aria-live="polite"`

##### MEDIUM: Color contrast issues
- `text-slate-500` on `bg-ink-900/80` (footer, secondary text) may not meet WCAG AA contrast ratio (4.5:1)
- `text-slate-400` is used extensively for secondary text on dark backgrounds

**Recommendation:** Run an automated contrast check (axe-core) and adjust the slate palette. Consider `text-slate-300` as the minimum secondary text color.

##### LOW: No skip-to-content link
The header navigation doesn't include a skip link for keyboard users.

##### LOW: Focus management after modal close
When modals (Report, Ban, Delete Account) close, focus doesn't return to the trigger element.

**Recommendation:** Use a `useEffect` hook to restore focus to the element that opened the modal.

---

## 7. End-User Perspective

### 7.1 Onboarding Experience
- **Good**: Registration form is clean, with invite code field appearing only when relevant
- **Issue**: New users have no tour or tutorial. The landing page explains the concept but doesn't guide through first broadcast.
- **Issue**: After registration, users land on the dashboard which shows empty states. No prompt to "Start your first broadcast" or "Set up your profile".

**Recommendation:** Add a first-time user onboarding flow — either a simple banner or a 3-step walkthrough.

### 7.2 Broadcaster Experience
- **Good**: Clean broadcast setup form with sensible defaults from user settings
- **Good**: Live stats (viewers, bitrate, FPS, resolution) are useful
- **Good**: Chat integration is seamless
- **Good**: Recording feature for replays
- **Issue**: No preview before going live
- **Issue**: No way to change broadcast title/access while live
- **Issue**: No "scheduled broadcast" feature — viewers must check manually or rely on push notifications

### 7.3 Viewer Experience
- **Good**: Clean player with access control flows (login, access code)
- **Good**: Automatic reconnection with exponential backoff
- **Good**: Follow/notification system
- **Issue**: No way to find a broadcaster except by @username or search — no categories, tags, or directory
- **Issue**: No chat history for late-joining viewers
- **Issue**: No way to see a broadcaster's schedule or past broadcasts (profile page doesn't exist in the web app — only the API endpoint)
- **Issue**: Viewer page refreshes reconnect from scratch, losing chat history

### 7.4 Admin Experience
- **Good**: Comprehensive metrics dashboard with time-series charts
- **Good**: Ban workflow with reason tracking and immediate enforcement
- **Good**: Invite code management
- **Issue**: No audit log (who did what and when)
- **Issue**: No bulk actions (ban multiple users, resolve multiple reports)
- **Issue**: No email notification to admins for new reports
- **Issue**: Can't search reports by reporter or target username

---

## 8. Feature Gaps & Improvement Suggestions

### 8.1 High-Value Additions

| Feature | Effort | Impact | Notes |
|---------|--------|--------|-------|
| **User profile page** (`/user/:username`) | Medium | High | Show bio, avatar, broadcast history, follow button. Currently only API-accessible. |
| **Broadcast categories/tags** | Medium | High | Allow broadcasters to tag their streams; enable discovery by category |
| **Chat moderation (mute/kick)** | Medium | High | Broadcaster should be able to mute individual viewers in chat |
| **Scheduled broadcasts** | Medium | Medium | Let broadcasters announce upcoming streams; notify followers |
| **Embedded player** | Low | High | `<iframe>` embed code for external websites to host a PeerCast player |
| **Watch party / co-broadcasting** | High | Medium | Multiple broadcasters sharing a session |
| **Mobile app (React Native)** | High | High | Native push notifications, better camera control |
| **Stream thumbnails** | Medium | Medium | Auto-capture a frame every N seconds for preview cards |
| **VOD / replay for public broadcasts** | Medium | High | Currently recordings are private; allow public replays |

### 8.2 Quick Wins

| Feature | Effort | Impact |
|---------|--------|--------|
| Broadcast preview before going live | Low | Medium |
| Admin audit log | Low | Medium |
| URL-based admin tab persistence | Trivial | Low |
| Unsaved-changes warning on Settings | Low | Low |
| Mobile search always visible | Low | Medium |
| Public user profile page (web route) | Low | Medium |
| Stale broadcast filter on `listLive` | Trivial | Medium |
| Recording ID validation (hex only) | Trivial | High (security) |

### 8.3 Features to Consider Removing

| Feature | Rationale |
|---------|-----------|
| **"Microphone only" capture source** | Very niche use case for a screen-sharing platform; adds UI complexity |
| **Anonymous reporting** | Reports without a `reporter_username` are harder to action and can be abused for spam |

---

## 9. Performance & Scalability

### 9.1 Current Performance Profile

| Metric | Assessment |
|--------|------------|
| **API response time** | ✅ Excellent — SQLite synchronous reads are sub-millisecond |
| **Memory usage** | ✅ Lean — Express + SQLite + PeerJS signaling |
| **Startup time** | ✅ Fast — no external dependency blocking boot |
| **WebRTC efficiency** | ⚠️ Each viewer opens a separate peer connection to the broadcaster |

### 9.2 Scaling Concerns

#### HIGH: WebRTC fan-out limit
Each viewer opens a direct peer connection to the broadcaster's browser. A single browser realistically handles 5-15 concurrent outbound streams before CPU/bandwidth saturates. This is a fundamental limitation of pure P2P broadcasting.

**Recommendation:** For larger audiences, consider:
1. **SFU integration** (Selective Forwarding Unit, e.g., mediasoup, Janus) as an optional relay
2. **Cascaded P2P** where some viewers act as relays
3. Document the viewer limit prominently

#### MEDIUM: Recording chunk uploads bypass body size limits
The recording chunk route uses a custom raw body reader with a 25MB per-chunk limit. Express's global `json({ limit: "1mb" })` doesn't apply. This is correct behavior but means the server must handle up to 25MB in memory per request.

**Recommendation:** Consider streaming to disk instead of buffering the full chunk. Use `appendFileSync` only after streaming, not after accumulating in memory.

#### LOW: Avatar base64 in every API response
Every broadcast card, user search result, and admin list includes the full base64 avatar. For a page showing 60 live broadcasts with avatars, this could be 12MB of JSON.

**Recommendation:** Move avatars to static file hosting (as noted in §3.2) and return URLs.

---

## 10. Monetization Strategies

### 10.1 Hosted SaaS ("PeerCast Cloud")

The most straightforward monetization: run a managed PeerCast instance.

| Tier | Price | Features |
|------|-------|----------|
| **Free** | $0/mo | 1 concurrent broadcast, 5 viewers max, no recordings, PeerCast branding |
| **Creator** | $9/mo | Unlimited broadcasts, 25 viewers, 5GB recordings, custom access codes |
| **Pro** | $29/mo | 50 viewers, 50GB recordings, priority TURN relay, custom branding |
| **Team** | $99/mo | Multi-user org, 100 viewers, 200GB recordings, SFU relay, analytics |

### 10.2 Self-Hosted License (Open Core)

Keep the current MIT core free, offer premium features as a paid add-on:

| Free (MIT) | Paid (Proprietary License) |
|------------|---------------------------|
| All current features | SFU relay integration (break the 15-viewer barrier) |
| Community support | Advanced analytics dashboard |
| | Custom branding / white-labeling |
| | LDAP/SAML SSO integration |
| | Priority email support |
| | Multi-node clustering |
| | S3-backed recording storage |

**Pricing:** $49/mo per instance or $499/year.

### 10.3 Browser Extension Premium

The extension is currently free. Monetization options:
- **Freemium extension**: Free for public broadcasts; paid for code-gated/members-only broadcasting from the extension
- **Chrome Web Store listing with subscription**: $4.99/mo for advanced extension features (quality caps, multi-tab capture, recording from extension)

### 10.4 API-as-a-Service

Offer the PeerCast signaling + TURN infrastructure as a managed API for third-party developers building real-time features:
- Pay per signaling connection
- Pay per TURN relay minute
- REST API for broadcast management

### 10.5 Marketplace / Tips

Add viewer-to-broadcaster tipping:
- Integrate Stripe for one-click tips during a broadcast
- PeerCast takes a 10-15% platform fee
- This aligns incentives: broadcasters earn, platform earns, viewers show appreciation

### 10.6 Enterprise Deployment Consulting

Offer professional services:
- Custom deployment on customer infrastructure
- Integration with existing auth systems (LDAP, SAML, OAuth)
- Custom moderation workflows
- SLA-backed support contracts

### Recommended Path
Start with **10.2 (Open Core)** + **10.1 (Hosted SaaS)**. The self-hosted audience provides word-of-mouth; the hosted offering captures users who don't want to manage infrastructure. Add **10.5 (Tips)** once you have an active broadcaster community.

---

## 11. Priority Action Items

### P0 — Fix Before Next Release

1. **Add recording ID path validation** — Prevent path traversal in recording file operations
2. **Apply staleness filter to `listLive`/`searchLive`** — Prevent ghost broadcasts on the landing page
3. **Add CSRF protection** or hard-remove the `SameSite=none` option

### P1 — Next Sprint

4. Add confirmation dialogs for destructive admin actions (role changes, takedowns)
5. Fix `consumeVerification` to always delete the token (match `consumeReset` pattern)
6. Add concurrent-resolve guard in ViewerPage
7. Move avatars from inline base64 to file-based storage with URLs
8. Add pagination to list endpoints (live, admin users, recordings)

### P2 — Near-Term Improvements

9. Add a public user profile web route (`/user/:username`)
10. Implement broadcast preview before going live
11. Add chat moderation (mute/kick) for broadcasters
12. Make chat panel collapsible on mobile
13. Add mobile-visible search bar
14. Improve ARIA labels and color contrast for accessibility
15. Add admin audit log

### P3 — Strategic Features

16. Broadcast categories/tags for discovery
17. Embedded player for external websites
18. Stream thumbnails for broadcast cards
19. Scheduled broadcasts with follower notifications
20. SFU integration for larger audiences (monetization enabler)

---

*This report was generated from a thorough review of all source files across the shared, server, web, and extension packages. The codebase demonstrates strong engineering discipline and a thoughtful security model. The identified issues are typical of a maturing v1 product and none represent showstoppers for the current self-hosted deployment model.*
