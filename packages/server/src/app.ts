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

  app.set("trust proxy", config.isProd ? 1 : false);
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
        },
      },
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
    // Session resolve: 120/15 min per IP.  Viewers may reconnect legitimately
    // after network drops; exponential backoff in ViewerPage prevents storms,
    // but give enough headroom so a normal session never hits the limit.
    app.use("/api/sessions", mkLim("session-ip", 15 * 60_000, 120));
    // Reports: 10/h per IP.
    app.use("/api/reports", mkLim("report-ip", 60 * 60_000, 10));
    // Follow writes: 60/15 min per IP (prevents follow-graph spam).
    app.use("/api/users/:username/follow", mkLim("follow-ip", 15 * 60_000, 60));
    // Push subscribe: 5/h per IP (prevents subscription-table bloat).
    app.use("/api/push/subscribe", mkLim("push-ip", 60 * 60_000, 5));
    // Recording chunk uploads: headroom for a real broadcast (MediaRecorder
    // emits a chunk every few seconds); 600/15min ≈ one chunk/s, generous.
    app.use(
      "/api/recordings/:id/chunk",
      mkLim("rec-chunk-ip", 15 * 60_000, 600),
    );
    // Creating recordings: 20/h per IP.
    app.use("/api/recordings", mkLim("rec-create-ip", 60 * 60_000, 20));
  }

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
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
