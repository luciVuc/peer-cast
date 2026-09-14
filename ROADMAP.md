# PeerCast — Roadmap

_Legend: ✅ done · 🚧 in progress · ⬜ planned_

This roadmap reflects the **`webapp-nodejs` branch** (v2.0.0), the self-hosted
Node.js + React PWA rewrite.

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

## Planned

| Feature                        | Notes                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| **Chrome Web Store**           | Package and submit the extension for public distribution.                                  |
| **Firefox MV3 port**           | Firefox lacks the offscreen API; needs a different architecture for background capture.    |
| **Extension recording parity** | The extension can record via its BroadcastHost lifecycle; today only the web page records. |

---

## Hardening & tech-debt (post-audit follow-ups)

Tracked from the v2.0.0 production-readiness audit (`AUDIT_REPORT.md`). These are
deferred, non-blocking items — the shipped build is production-ready without
them.

| Item                                      | Ref | Priority | Notes                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dev toolchain security bump**           | L-1 | Medium   | Remaining `npm audit` findings are **dev-only** (esbuild dev-server advisory via `vite`/`vitest`); production is clean (`npm audit --omit=dev` = 0). Fix needs a breaking multi-major upgrade: vite 5→8, vitest 2→5, `@vitejs/plugin-react`, `vite-plugin-pwa`. Schedule as a dedicated effort with a full regression pass.         |
| **Refresh-token reuse detection**         | L-7 | Low      | Rotation already limits blast radius. Add a per-session token-family id and revoke the whole family when an already-consumed/expired token is replayed (stolen-token detection). See `lib/auth.ts`.                                                                                                                                 |
| **Test isolation: fake timers**           | —   | Low      | `test/invites.test.ts` uses `vi.useFakeTimers()`/`vi.setSystemTime()` under `isolate:false` + `singleFork`; under load a leaked clock can bleed into the next test (rare flake). Wrap in `try/finally { vi.useRealTimers() }` or add a suite-level `afterEach(() => vi.useRealTimers())`. Pre-existing; production code unaffected. |
| **Redis-backed rate limiting & tickets**  | —   | Low      | Current in-memory `express-rate-limit` store and signaling-ticket map are correct for single-process deployments only. Swap to a shared store (e.g. Redis) before running multiple server instances behind a load balancer.                                                                                                         |
| **Configurable cross-origin cookie mode** | M-4 | Done¹    | `COOKIE_SAME_SITE` env added (strict/lax/none). Revisit if a first-class split-origin deployment topology is officially supported/documented.                                                                                                                                                                                       |

¹ Shipped in v2.0.0; listed here for traceability.

---

## Known limits (accepted)

- DRM content (Netflix etc.) refuses `tabCapture` — by browser design.
- System audio on screen/window capture depends on OS/browser support.
- Symmetric NAT requires a TURN server (`ICE_SERVERS`).
- Recording/replay is not yet implemented (above).
- The free PeerJS cloud is replaced by self-hosted signaling; no cloud fallback in v2.
