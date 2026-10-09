import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express, type Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type { Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import { config } from "./config.js";
import { getRedis } from "./lib/redis.js";
import { errorHandler } from "./middleware/error.js";
import { optionalAuth } from "./middleware/auth.js";
import { csrfGuard } from "./middleware/csrf.js";
import { avatarDir } from "./lib/avatar.js";
import { authRouter } from "./routes/auth.js";
import { broadcastsRouter } from "./routes/broadcasts.js";
import { configRouter } from "./routes/config.js";
import { sessionsRouter } from "./routes/sessions.js";
import { usersRouter } from "./routes/users.js";
import { reportsRouter } from "./routes/reports.js";
import { pushRouter } from "./routes/push.js";
import { recordingsRouter } from "./routes/recordings.js";
import { adminRouter } from "./routes/admin.js";
import { emailRouter } from "./routes/email.js";
import { createPeerServer } from "./signaling/peerServer.js";

export interface AppOptions {
  /** When provided, mount the PeerJS signaling server on it. */
  httpServer?: Server;
  /** Disable auth rate limiting (useful for tests). */
  rateLimiting?: boolean;
  /** Log startup lines (default true). */
  quiet?: boolean;
}

/**
 * Derive CSP host-sources from the configured TURN/STUN servers. Classic ICE
 * gathering isn't shaped by CSP in current browsers, but TURN-over-TLS/WS and
 * future WebRTC enforcements are — allowing these origins in connect-src costs
 * nothing and keeps external relays working. A host-source without a scheme
 * matches every scheme per CSP3.
 */
// ICE server URLs are NOT RFC 3986 URL objects: `new URL()` throws for the
// `stun:`/`turn:`/`turns:` schemes Node doesn't know, so the previous
// implementation silently dropped every relay from the CSP. Parse the host
// with a regex that covers the schemes we actually emit instead. A missing
// port matches any port under CSP3, so we only pin one when the config
// explicitly lists it.
const ICE_URL_RE =
  /^(?:stun|stuns|turn|turns|https?|wss?):\/\/([^/:?#]+)(?::(\d+))?/i;

function deriveIceCspHosts(): string[] {
  const hosts = new Set<string>();
  const raw: string[] = [];
  for (const s of config.signal.iceServers) {
    const urls = (s as { urls?: string | string[] }).urls;
    if (typeof urls === "string") raw.push(urls);
    else if (Array.isArray(urls)) raw.push(...urls.map((u) => String(u)));
  }
  for (const item of raw) {
    const m = ICE_URL_RE.exec(item);
    if (!m || !m[1]) continue; // skip malformed ICE URL
    hosts.add(m[2] ? `${m[1]}:${m[2]}` : m[1]);
  }
  return [...hosts];
}

/**
 * Configure the given Express app with all PeerCast middleware, routes,
 * signaling, and static hosting. Split from `index.ts` so tests can exercise
 * the API without binding a port or starting the signaling server.
 */
export function configureApp(app: Express, opts: AppOptions = {}): Express {
  const { httpServer, rateLimiting = true, quiet = false } = opts;

  // Explicit, not inferred from NODE_ENV. See config.trustProxyHops: this
  // value decides `req.ip`, which is the key for every IP-rate-limited
  // endpoint. Default 0 means a client cannot spoof its own X-Forwarded-For to
  // escape login/register/code-guessing limits.
  app.set("trust proxy", config.trustProxyHops);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          fontSrc: ["'self'", "data:"],
          // 'self' covers same-origin WebSocket (ws:/wss:) per CSP3.
          // Extra hosts come from configured TURN/STUN relays (see above).
          connectSrc: ["'self'", ...deriveIceCspHosts()],
          mediaSrc: ["'self'", "blob:"],
          workerSrc: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: config.signal.secure ? [] : null,
        },
      },
      // Keyed off TRUST_PROXY_HOPS rather than signal.secure: those are
      // independent facts, and an operator who terminates TLS at a proxy sets
      // TRUST_PROXY_HOPS=1 while PUBLIC_SECURE describes what clients see. Tying
      // HSTS to PUBLIC_SECURE silently dropped the header for exactly the
      // proxied deployments that need it most.
      hsts:
        config.trustProxyHops > 0 || config.signal.secure
          ? { maxAge: 31_536_000, includeSubDomains: true }
          : false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(
    cors({
      // Never combine wildcard/reflected origin with credentials:true.
      // If CORS_ORIGINS is "*" (dev default) we allow any origin but do NOT
      // send credentials headers — callers use Bearer tokens, not cookies.
      origin:
        config.cors.origins === "*" ? true : config.cors.origins.split(","),
      credentials: config.cors.origins !== "*",
    }),
  );
  app.use(cookieParser());
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  // CSRF guard: reject cross-origin state-changing requests to cookie-dependent
  // auth endpoints when SameSite is not strict.
  app.use("/api/auth", csrfGuard);

  // Allow the /embed/* routes to be framed by any origin.
  // All other routes keep frame-ancestors: 'none' from Helmet above.
  // We override the CSP and X-Frame-Options headers on embed routes only.
  app.use("/embed", (_req, res, next) => {
    res.removeHeader("X-Frame-Options");
    res.setHeader(
      "Content-Security-Policy",
      res.getHeader("Content-Security-Policy")
        ? String(res.getHeader("Content-Security-Policy")).replace(
            /frame-ancestors [^;]+/,
            "frame-ancestors *",
          )
        : "frame-ancestors *",
    );
    next();
  });

  // ── PeerJS signaling (only when an http server is available) ──────────────
  if (httpServer) {
    app.use(config.signal.path, createPeerServer(httpServer));
  }

  // ── REST API ──────────────────────────────────────────────────────────
  //
  // Rate limiting is per-IP (trust proxy:1 in prod) with optional per-key
  // secondary limiters (username for login, email for forgot-password).
  //
  // Store: in-memory by default (correct for single-process deployments).
  // When REDIS_URL is set the limiters share a Redis store so counters are
  // consistent across multiple instances behind a load balancer. Each limiter
  // uses its own prefix to keep keyspaces disjoint. If Redis is configured but
  // unreachable, rate-limited endpoints fail closed (429s / 500s are safer than
  // silently un-limiting auth in a multi-instance deployment).
  //
  // All limiters are disabled when rateLimiting:false (tests).
  //
  // Limiters are mounted as standalone middleware BEFORE the routers so they
  // intercept the matching path and short-circuit with 429 if needed, then
  // call next() to continue to the actual router.

  if (rateLimiting) {
    const mkLim = (
      ns: string,
      windowMs: number,
      limit: number,
      keyFn?: (req: Request) => string,
      /** Only count failed requests for this limiter (prevents a successful
       *  login/logout loop from locking a legitimate user/email out). */
      skipSuccessful = false,
      /** Full control over what reaches the counter at all. Evaluated BEFORE
       *  the route handler runs, so it can only inspect the request — the
       *  status-code half is what skipSuccessfulRequests is for. */
      skip?: (req: Request) => boolean,
    ) => {
      const redis = getRedis();
      const store = redis
        ? new RedisStore({
            prefix: `rl:${ns}:`,
            sendCommand: (...args: string[]): Promise<RedisReply> =>
              redis.call(
                ...(args as [string, ...(string | number)[]]),
              ) as Promise<RedisReply>,
          })
        : undefined; // default in-memory store
      return rateLimit({
        windowMs,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
        store,
        skipSuccessfulRequests: skipSuccessful,
        skip,
        keyGenerator: keyFn ?? ((req) => ipKeyGenerator(req.ip ?? "unknown")),
        handler: (_req, res) =>
          res.status(429).json({
            error: "too many requests, please try again later",
            code: "RATE_LIMITED",
          }),
      });
    };

    // Login: 10/15 min per IP + 10/15 min per username.
    app.use("/api/auth/login", mkLim("login-ip", 15 * 60_000, 10));
    app.use(
      "/api/auth/login",
      mkLim(
        "login-user",
        15 * 60_000,
        10,
        (req) => `l:u:${String(req.body?.username ?? "").toLowerCase()}`,
        // Only failed logins count toward the per-username budget — a user
        // hammering their own (correct) password must not get bricked.
        true,
      ),
    );
    // Registration: 5/h per IP.
    app.use("/api/auth/register", mkLim("register-ip", 60 * 60_000, 5));
    // Token refresh: 30/15 min per IP.
    app.use("/api/auth/refresh", mkLim("refresh-ip", 15 * 60_000, 30));
    // Forgot-password: 5/h per IP + 3/h per target email (prevents mail-bombing).
    app.use("/api/auth/forgot-password", mkLim("fp-ip", 60 * 60_000, 5));
    app.use(
      "/api/auth/forgot-password",
      mkLim(
        "fp-email",
        60 * 60_000,
        3,
        (req) => `fp:${String(req.body?.email ?? "").toLowerCase()}`,
      ),
    );
    // Resend-verification: 5/h per IP.
    app.use("/api/auth/send-verification", mkLim("ver-ip", 60 * 60_000, 5));
    // Verify-email (link click): 30/h per IP — a delivered link is hit at most
    // a handful of times per address, so this only stops token brute-forcing.
    app.use("/api/auth/verify-email", mkLim("ve-ip", 60 * 60_000, 30));
    // Reset-password: 10/h per IP (the token is single-use + 60 min TTL, so the
    // limiter protects the guess surface, not the token itself).
    app.use("/api/auth/reset-password", mkLim("rp-ip", 60 * 60_000, 10));
    // Change-email: 5/h per IP + 3/h per target address (mirrors
    // forgot-password; requires a valid currentPassword so failures here mean
    // a credential misuse attempt or a heavy-handed client).
    app.use("/api/auth/change-email", mkLim("ce-ip", 60 * 60_000, 5));
    app.use(
      "/api/auth/change-email",
      mkLim(
        "ce-email",
        60 * 60_000,
        3,
        (req) => `ce:${String(req.body?.newEmail ?? "").toLowerCase()}`,
      ),
    );
    // Populate req.auth BEFORE the limiters below so they can key per user.
    //
    // `optionalAuth` is normally attached inside the route handler, which runs
    // *after* any app-level middleware — so a limiter mounted ahead of the
    // router sees no identity and silently falls back to IP keying for every
    // request, logged-in or not. It never blocks, so running it here is safe,
    // and the route's own use is idempotent. Cost is one JWT verify + one
    // indexed SQLite row read per request (the same read the route would do
    // anyway).
    app.use("/api/sessions", optionalAuth);
    // Session resolve: viewer-facing, read-only, and hit by *every* viewer of a
    // broadcast — plus again on every reconnect (ViewerPage re-resolves, and
    // during a host restart its bounded backoff polls ~13 times).
    //
    // Keyed per authenticated user, falling back to IP. Keying this on IP alone
    // put every viewer behind one NAT (home router, office, corporate proxy)
    // into a single shared budget, so a busy instance locked out an entire
    // egress IP at once. `usernameLc` is the canonical key, so "Alice" and
    // "alice" can't be used to obtain two budgets for one account.
    //
    // 600/15 min ≈ 40/min: comfortably above real reconnect churn, still a
    // ceiling on abuse of a cheap endpoint. Access-code guessing — the one
    // genuinely guessable thing here — is bounded separately and far tighter by
    // the code-attempt limiter below.
    app.use(
      "/api/sessions",
      mkLim(
        "session",
        15 * 60_000,
        600,
        (req) =>
          req.auth
            ? `u:${req.auth.usernameLc}`
            : `ip:${ipKeyGenerator(req.ip ?? "unknown")}`,
        false,
        // Ticket verification gets its own bucket below — its volume tracks
        // the host's audience size, not any one client's request rate, so it
        // must not compete with viewers resolving sessions.
        (req) => req.path === "/verify-ticket",
      ),
    );
    // Ticket verification: called by the HOST once per incoming viewer call, so
    // its volume scales with the audience rather than with one client. It needs
    // real headroom for that reason — and it is unauthenticated, so it can only
    // be keyed by IP. Exhausting a host's budget here is worse than a plain
    // 429: hosts fail closed on an unverifiable ticket (AGENTS rule 4), so the
    // audience would be silently refused rather than shown an error.
    app.use(
      "/api/sessions/verify-ticket",
      mkLim("ticket-verify-ip", 15 * 60_000, 1500),
    );
    // Code-gated resolves: 5 wrong codes / 15 min per (IP + username).
    //
    // Counts ONLY non-2xx responses to requests that actually supplied a code.
    // Previously every non-2xx counted, including "host is offline" (404) — so a
    // viewer reconnecting to an ended broadcast burned this 5/15 min budget and
    // then got 429 on a *public* stream that never had a code gate at all. A
    // 404 with no code is not a failed code attempt.
    //
    // A 404 or 401 that *does* carry a code still counts: probing for a valid
    // username with codes is exactly the guessing this limiter exists to stop.
    //
    // Note: `skip` is evaluated BEFORE the route handler runs (express-rate-limit
    // calls it on the way in), so it can only inspect the request — the
    // status-code half is handled by skipSuccessfulRequests, which decrements
    // after the response. Don't try to read res.statusCode from `skip`.
    app.use(
      "/api/sessions",
      mkLim(
        "code-attempt",
        15 * 60_000,
        5,
        (req) => {
          const username =
            (req.params as Record<string, string>)?.username ??
            req.path.split("/")[1] ??
            "";
          return `code:${username.toLowerCase()}:${ipKeyGenerator(req.ip ?? "unknown")}`;
        },
        true, // only count non-2xx (see note above)
        (req) =>
          // Nothing supplied a code — nothing to guess, never counts.
          !String((req.query as Record<string, string>)?.code ?? ""),
      ),
    );
    // Second, coarser code-guess limiter keyed on the *username alone*, with
    // no IP component. The per-(IP, username) limiter above is trivially
    // multiplied by source address: an attacker with a rotating IP pool gets an
    // unbounded aggregate budget against a single broadcaster's code. This one
    // cannot be spread, so a distributed guessing run still hits a ceiling —
    // deliberately generous (50) so one household behind a NAT, or a viewer
    // mistyping their code repeatedly, never trips it.
    app.use(
      "/api/sessions",
      mkLim(
        "code-attempt-user",
        15 * 60_000,
        50,
        (req) => {
          const username =
            (req.params as Record<string, string>)?.username ??
            req.path.split("/")[1] ??
            "";
          return `code-user:${username.toLowerCase()}`;
        },
        true, // only count non-2xx, matching the per-IP bucket
        (req) => !String((req.query as Record<string, string>)?.code ?? ""),
      ),
    );
    // Reports: 10/h per IP.
    app.use("/api/reports", mkLim("report-ip", 60 * 60_000, 10));
    // Search: 60/15 min per IP. Unauthenticated and it feeds a LIKE '%…%'
    // full-table scan on both users and broadcasts, so it needs a ceiling of
    // its own — it is not covered by any other mount.
    app.use("/api/users/search", mkLim("search-ip", 15 * 60_000, 60));
    // Follow writes: 60/15 min per IP (prevents follow-graph spam).
    // Scoped to POST: a prefix mount would also cap DELETE /follow, so an
    // account unfollowing in bulk (or a user cleaning up several accounts)
    // would hit the write limit at a quarter of its intended rate.
    const followLim = mkLim("follow-ip", 15 * 60_000, 60);
    app.use("/api/users/:username/follow", (req, res, next) => {
      if (req.method !== "POST") return next();
      return followLim(req, res, next);
    });
    // Push subscribe: 5/h per IP (prevents subscription-table bloat).
    // Scoped to POST so unsubscribing is never throttled by the subscribe
    // budget — a user rotating browsers must always be able to opt out.
    const pushSubLim = mkLim("push-ip", 60 * 60_000, 5);
    app.use("/api/push/subscribe", (req, res, next) => {
      if (req.method !== "POST") return next();
      return pushSubLim(req, res, next);
    });
    // Recording chunk uploads: headroom for a real broadcast (MediaRecorder
    // emits a chunk every few seconds); 600/15min ≈ one chunk/s, generous.
    app.use(
      "/api/recordings/:id/chunk",
      mkLim("rec-chunk-ip", 15 * 60_000, 600),
    );
    // Creating recordings: 20/h per IP.
    // Scope to the create endpoint EXACTLY, same reason as bstartLim below:
    // `app.use` is a prefix mount, so a bare limiter on "/api/recordings"
    // also swallows PUT /api/recordings/:id/chunk. MediaRecorder emits a
    // chunk every few seconds, so a 20/hour budget truncates the recording
    // after ~20 chunks — silently losing the tail of the replay.
    const recCreateLim = mkLim("rec-create-ip", 60 * 60_000, 20);
    app.use("/api/recordings", (req, res, next) => {
      if (req.method !== "POST" || req.path !== "/") return next();
      return recCreateLim(req, res, next);
    });
    // Going live: 60/h per IP. POST /api/broadcasts writes a row and fans a
    // push notification out to every follower, so without a ceiling a tight
    // start/end loop grows the table and mailboxes for free.
    //
    // Scope this to the start endpoint EXACTLY. `app.use` is a prefix mount, so
    // a bare POST check would also swallow `/api/broadcasts/:id/stats` (the
    // host heartbeat, one every 2 s ≈ 1800/h) and `/api/broadcasts/:id/end`,
    // which would exhaust the start budget within minutes of going live — and
    // leave the broadcaster unable to stop. Inside a mount, `req.path` is
    // relative to it, so the collection route is "/".
    const bstartLim = mkLim("bstart-ip", 60 * 60_000, 60);
    app.use("/api/broadcasts", (req, res, next) => {
      if (req.method !== "POST" || req.path !== "/") return next();
      return bstartLim(req, res, next);
    });
  }

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  // Serve avatar images with long-lived caching (URL ?v= param busts the cache).
  app.use(
    "/api/avatars",
    express.static(avatarDir(), {
      maxAge: "7d",
      immutable: true,
      index: false,
      setHeaders: (res) => {
        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      },
    }),
  );
  app.use("/api/config", configRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/auth", emailRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/broadcasts", broadcastsRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/push", pushRouter);
  app.use("/api/recordings", recordingsRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

  // ── Static PWA ──────────────────────────────────────────────────────────
  if (config.webDir) {
    if (!quiet) console.log(`[server] serving web app from ${config.webDir}`);
    app.use(
      express.static(config.webDir, {
        index: false,
        setHeaders: (res, path) => {
          if (path.endsWith("index.html") || path.endsWith("sw.js")) {
            res.setHeader("Cache-Control", "no-cache");
          }
        },
      }),
    );
    app.get(["/", "/*path"], (req, res, next) => {
      if (
        req.path.startsWith("/api") ||
        req.path.startsWith(config.signal.path)
      )
        return next();
      // Root-relative on purpose: Express 5's send() resolves sendFile paths
      // against the `root` option, so an absolute external path 404s.
      const indexFile = "index.html";
      if (existsSync(join(config.webDir!, indexFile)))
        return res.sendFile(indexFile, { root: config.webDir! });
      next();
    });
  } else if (!quiet) {
    console.log(
      "[server] no built web app found — API + signaling only. " +
        "Run the Vite dev server separately, or build the web package.",
    );
  }

  app.use(errorHandler);
  return app;
}
