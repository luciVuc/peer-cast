import { config as loadEnv } from "dotenv";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

loadEnv();

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const PLACEHOLDER_SECRET = "change-me-to-a-long-random-secret";
const DB_FILE = str(
  "DATABASE_FILE",
  resolve(process.cwd(), "data/peercast.db"),
);

/** Resolve JWT_SECRET; fail hard in production if missing or placeholder. */
function jwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  const isProd = process.env.NODE_ENV === "production";

  if (fromEnv && fromEnv.length >= 32 && fromEnv !== PLACEHOLDER_SECRET) {
    return fromEnv;
  }

  if (isProd) {
    // Hard fail: a weak/missing secret in production is a critical vulnerability.
    console.error(
      "[config] FATAL: JWT_SECRET is missing, too short (<32 chars), or still set " +
        "to the placeholder value. Set a strong random secret in production. " +
        "Generate one with:  openssl rand -hex 32",
    );
    process.exit(1);
  }

  // Dev/test fallback — ephemeral, sessions won't survive a restart.
  console.warn(
    "[config] JWT_SECRET not set or too short — using a random ephemeral secret. " +
      "Sessions will not survive a server restart. Set JWT_SECRET for development.",
  );
  return randomBytes(32).toString("hex");
}

const PORT = int("PORT", 8787);
const PUBLIC_HOST = str("PUBLIC_HOST", "localhost");
const SECURE = bool("PUBLIC_SECURE", false);

/** Resolve the built web app directory if present (for single-container serve). */
function resolveWebDir(): string | null {
  const candidates = [
    process.env.WEB_DIST,
    resolve(process.cwd(), "../web/dist"),
    resolve(process.cwd(), "packages/web/dist"),
    resolve(process.cwd(), "web"), // Docker copies build here
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(resolve(c, "index.html"))) return resolve(c);
  }
  return null;
}

export const config = {
  port: PORT,
  host: str("HOST", "0.0.0.0"),
  nodeEnv: str("NODE_ENV", "development"),
  isProd: str("NODE_ENV", "development") === "production",

  jwt: {
    secret: jwtSecret(),
    accessTtl: str("JWT_ACCESS_TTL", "15m"),
    refreshTtlSec: int("JWT_REFRESH_TTL_SEC", 7 * 24 * 3600),
  },

  db: {
    file: DB_FILE,
  },

  /** Public-facing signaling parameters advertised to clients. */
  signal: {
    host: str("SIGNAL_HOST", PUBLIC_HOST),
    port: int("SIGNAL_PORT", PORT),
    path: str("SIGNAL_PATH", "/peerjs"),
    secure: SECURE,
    key: str("SIGNAL_KEY", "peercast"),
    iceServers: parseIceServers(),
  },

  webDir: resolveWebDir(),
  appName: str("APP_NAME", "PeerCast"),
  version: str("APP_VERSION", "2.0.0"),

  /** URL clients use to reach the app (for email links). No trailing slash. */
  appUrl: str("APP_URL", `http://localhost:${PORT}`),

  email: {
    host: str("SMTP_HOST", ""),
    port: int("SMTP_PORT", 587),
    secure: bool("SMTP_SECURE", false), // true for port 465
    user: str("SMTP_USER", ""),
    pass: str("SMTP_PASS", ""),
    from: str("SMTP_FROM", `PeerCast <noreply@peercast.local>`),
    enabled: !!str("SMTP_HOST", ""),
  },

  /** Whether to hard-block login for unverified emails. */
  requireEmailVerification: bool("REQUIRE_EMAIL_VERIFICATION", false),

  /** Refresh-cookie SameSite policy. This build is single-origin by design, so
   * 'strict' is the safest default. 'lax' covers top-level navigations only.
   * 'none' is only for genuinely cross-origin deployments behind TLS (cookies
   * with SameSite=None must be Secure, which rtCookieOpts then forces). */
  cookieSameSite: ((): "strict" | "lax" | "none" => {
    const v = str("COOKIE_SAME_SITE", "strict").toLowerCase();
    return v === "lax" || v === "none" ? v : "strict";
  })(),

  /** A "live" broadcast whose last stats heartbeat is older than this is dead.
   * Web + extension hosts report stats every ~2 s; 90 s tolerates drops. */
  staleLiveMs: int("STALE_LIVE_MS", 90_000),

  /** Usernames (comma-separated) promoted to admin on boot / registration. */
  adminUsernames: str("ADMIN_USERNAMES", "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /** How new accounts may be created: open | invite | closed. */
  registrationMode: ((): "open" | "invite" | "closed" => {
    const m = str("REGISTRATION_MODE", "open").toLowerCase();
    return m === "invite" || m === "closed" ? m : "open";
  })(),

  /** Optional shared Redis (single URL). When set, rate limits and signaling
   * tickets are shared across server instances (multi-instance deployments
   * behind a load balancer). When unset, both stay in-process, which is correct
   * for single-process deployments. */
  redis: {
    url: str("REDIS_URL", ""),
  },

  /** Time-limited TURN credentials (TURN REST API / coturn use-auth-secret).
   * When TURN_SHARED_SECRET is set, GET /api/config issues fresh ephemeral
   * credentials for every TURN server advertised in ICE_SERVERS, and any
   * static username/credential in the JSON is ignored. */
  turn: {
    sharedSecret: str("TURN_SHARED_SECRET", ""),
    // TTL in seconds. coturn's REST flow embeds the expiry in the username;
    // 24 h is the conventional default (matches the well-known TURN services).
    ttlSec: int("TURN_TTL_SEC", 24 * 3600),
    userid: str("TURN_USERID", "peercast"),
  },

  /** Web Push. Requires a VAPID keypair; generate one with
   * `npx web-push generate-vapid-keys`. When unset, the push API advertises
   * itself as disabled and clients never prompt for notification permission. */
  vapid: {
    publicKey: str("VAPID_PUBLIC_KEY", ""),
    privateKey: str("VAPID_PRIVATE_KEY", ""),
    /** RFC 8030 contact: an email (`mailto:`) or a website URL. */
    subject: str("VAPID_SUBJECT", "mailto:admin@peercast.local"),
    enabled: (): boolean =>
      !!str("VAPID_PUBLIC_KEY", "") && !!str("VAPID_PRIVATE_KEY", ""),
  },

  /** Per-broadcast recording/replay: WebM files stored on disk.
   * Defaulting next to the SQLite DB (data/recordings) keeps the Docker volume
   * story unchanged — /data is already a mounted volume in docker-compose. */
  recordings: {
    dir: str("RECORDINGS_DIR", resolve(dirname(DB_FILE), "recordings")),
    /** Hard cap per recording (bytes). Chunks beyond this are rejected. */
    maxBytes: int("RECORDINGS_MAX_BYTES", 512 * 1024 * 1024),
    /** Cap on the total bytes a single account may hold across ALL of its
     *  recordings (completed + in-progress). Enforced at chunk upload. */
    maxBytesPerUser: int("RECORDINGS_MAX_PER_USER", 5 * 1024 * 1024 * 1024),
  },

  cors: {
    /** Comma-separated allowed origins; "*" allows any (dev default). */
    origins: str("CORS_ORIGINS", "*"),
  },
} as const;

function parseIceServers() {
  const raw = process.env.ICE_SERVERS;
  if (!raw) {
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("[config] ICE_SERVERS is not valid JSON; ignoring.");
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }
}
