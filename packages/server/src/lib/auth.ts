import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { getRedis } from "./redis.js";

// ─── Passwords ──────────────────────────────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * A real cost-12 hash of 32 random bytes, computed once at boot, used as the
 * comparison target when the username doesn't exist. Logging in must cost the
 * same whether or not the account is real, or response time enumerates
 * usernames: `!!user && await verify(...)` skips bcrypt entirely for an unknown
 * user, making the no-user path sub-millisecond against a ~300 ms real compare.
 *
 * Derived at runtime rather than committed so it can never be mistaken for a
 * credential, and its plaintext is discarded immediately — it protects no
 * account.
 */
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  randomBytes(32).toString("hex"),
  12,
);

// ─── Access tokens (stateless JWT) ───────────────────────────────────────────

export interface AccessClaims {
  sub: string; // username_lc
  username: string; // display-case handle
  /** Token version — bumped on password/email changes so old access tokens
   * die immediately instead of lingering for the JWT TTL. Missing claim on
   * old tokens decodes as 0 (matches the default column value). */
  tv: number;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, config.jwt.secret, {
    expiresIn: config.jwt.accessTtl as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as jwt.JwtPayload;
    if (typeof decoded.sub !== "string" || typeof decoded.username !== "string")
      return null;
    return {
      sub: decoded.sub,
      username: decoded.username,
      tv: typeof decoded.tv === "number" ? decoded.tv : 0,
    };
  } catch {
    return null;
  }
}

// ─── Refresh tokens (opaque, rotating, stored hashed) ────────────────────────

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/**
 * Issue a refresh token and store it (hashed).
 * `family` groups rotations of one session; a fresh random family is created
 * when none is provided (new login). Reuse of a consumed token revokes the
 * whole family via consumeRefreshToken().
 */
export function issueRefreshToken(usernameLc: string, family?: string): string {
  const token = randomBytes(48).toString("base64url");
  const fam = family ? family : randomBytes(16).toString("base64url");
  const now = Date.now();
  db.prepare(
    `INSERT INTO refresh_tokens
       (token_hash, username_lc, family, consumed_at, expires_at, created_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(
    sha256(token),
    usernameLc,
    fam,
    now + config.jwt.refreshTtlSec * 1000,
    now,
  );
  return token;
}

/**
 * How long after a rotation a replayed refresh token is treated as a benign
 * concurrent refresh rather than a credential replay.
 *
 * The refresh cookie is per-browser, but every tab of the PWA shares it. When a
 * broadcaster has the app open in two tabs and both hit an expired access token
 * at once, both POST /auth/refresh with the *same* cookie. Under strict reuse
 * detection the second request looks exactly like a stolen token, so the whole
 * family is revoked and the user is silently signed out of every tab. A short
 * grace window keeps a genuine late replay (the actual theft signal) fatal.
 */
const ROTATION_GRACE_MS = 15_000;

/**
 * Rotate a refresh token. The token is not deleted on use — it is marked
 * `consumed_at` so replay is observable. Returns the account (and token
 * family) to continue the session, or null on invalid/expired input.
 *
 * Reuse detection: presenting an already-consumed token outside
 * ROTATION_GRACE_MS is the classic token-theft signal, so the entire family is
 * revoked (all rotations of that login's chain die; the victim re-authenticates
 * with the password). Expired tokens are also treated as fatal to the family.
 */
export function consumeRefreshToken(token: string): {
  usernameLc: string;
  family: string;
} | null {
  const hash = sha256(token);
  const row = db
    .prepare(
      `SELECT username_lc, family, consumed_at, expires_at
       FROM refresh_tokens WHERE token_hash = ?`,
    )
    .get(hash) as
    | {
        username_lc: string;
        family: string | null;
        consumed_at: number | null;
        expires_at: number;
      }
    | undefined;

  if (!row) return null;

  const now = Date.now();

  if (row.consumed_at) {
    // Replayed within the grace window: a sibling tab racing the same cookie,
    // not a thief. Continue the family so the client stays signed in.
    if (now - row.consumed_at <= ROTATION_GRACE_MS && row.family) {
      return { usernameLc: row.username_lc, family: row.family };
    }
    if (row.family) {
      db.prepare(`DELETE FROM refresh_tokens WHERE family = ?`).run(row.family);
    }
    return null;
  }

  if (row.expires_at < now) {
    if (row.family) {
      db.prepare(`DELETE FROM refresh_tokens WHERE family = ?`).run(row.family);
    }
    return null;
  }

  db.prepare(
    `UPDATE refresh_tokens SET consumed_at = ? WHERE token_hash = ?`,
  ).run(now, hash);

  return { usernameLc: row.username_lc, family: row.family ?? "" };
}

export function revokeAllRefreshTokens(usernameLc: string): void {
  db.prepare(`DELETE FROM refresh_tokens WHERE username_lc = ?`).run(
    usernameLc,
  );
}

// ─── Access tickets (short-lived viewer authorisation) ───────────────────────

const TICKET_TTL_MS = 5 * 60 * 1000;

export function issueTicket(usernameLc: string | null, peerId: string): string {
  const ticket = randomBytes(24).toString("base64url");
  db.prepare(
    `INSERT INTO tickets (ticket, username_lc, peer_id, expires_at) VALUES (?, ?, ?, ?)`,
  ).run(ticket, usernameLc, peerId, Date.now() + TICKET_TTL_MS);
  return ticket;
}

export function verifyTicket(
  ticket: string,
  peerId: string,
): { ok: boolean; username: string | null } {
  const row = db
    .prepare(
      `SELECT username_lc, peer_id, expires_at FROM tickets WHERE ticket = ?`,
    )
    .get(ticket) as
    | { username_lc: string | null; peer_id: string; expires_at: number }
    | undefined;
  if (!row || row.expires_at < Date.now() || row.peer_id !== peerId) {
    return { ok: false, username: null };
  }
  return { ok: true, username: row.username_lc };
}

/** Periodic cleanup of expired tickets, refresh tokens, and email tokens. */
export function purgeExpired(): void {
  const now = Date.now();
  db.prepare(`DELETE FROM tickets WHERE expires_at < ?`).run(now);
  db.prepare(`DELETE FROM refresh_tokens WHERE expires_at < ?`).run(now);
  db.prepare(`DELETE FROM email_verifications WHERE expires_at < ?`).run(now);
  db.prepare(`DELETE FROM password_resets WHERE expires_at < ?`).run(now);
  purgeSignalingTickets();
}

// ─── Signaling tickets (short-lived, in-memory, opaque) ──────────────────────
//
// These replace the JWT access token that was previously passed as
// ?token=<jwt> on the PeerJS WebSocket URL (and thus leaked into server logs).
// Signaling tickets are:
//   • Opaque random bytes — no user information is present in the value
//   • Single-use (deleted on first consumption)
//   • Short-lived (2 minutes) — even if captured from a log, they expire fast
//   • Stored in process memory only (not the DB)
//
// The peerServer upgrade handler accepts these tokens and falls back to the
// raw JWT path for backward compatibility with old clients.

const SIGNALING_TICKET_TTL_MS = 2 * 60_000;
const signalingTickets = new Map<
  string,
  { usernameLc: string; expiresAt: number }
>();

const ticketKey = (token: string) => `signalingTicket:${token}`;

export async function issueSignalingTicket(
  usernameLc: string,
): Promise<string> {
  const token = randomBytes(16).toString("base64url");
  const redis = getRedis();
  if (redis) {
    // Shared store: any instance can later consume the ticket. TTL handles
    // expiry, so no explicit purge is needed on this path.
    await redis.setex(
      ticketKey(token),
      Math.ceil(SIGNALING_TICKET_TTL_MS / 1000),
      usernameLc,
    );
  } else {
    signalingTickets.set(token, {
      usernameLc,
      expiresAt: Date.now() + SIGNALING_TICKET_TTL_MS,
    });
  }
  return token;
}

/**
 * Consume a signaling ticket (single-use). Returns the username_lc or null.
 * The entry is always deleted, even if expired.
 *
 * The in-memory (default) path is synchronous for the WebSocket-upgrade hot
 * path so the ban check still runs before PeerJS's own upgrade listener.
 * The Redis path is async (shared store); see peerServer.ts.
 */
export function consumeSignalingTicketSync(token: string): string | null {
  const entry = signalingTickets.get(token);
  signalingTickets.delete(token);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.usernameLc;
}

export async function consumeSignalingTicket(
  token: string,
): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return consumeSignalingTicketSync(token);
  const usernameLc = await redis.get(ticketKey(token));
  // Always delete: single-use, whether the token was valid or expired.
  await redis.del(ticketKey(token));
  return usernameLc;
}

export function purgeSignalingTickets(): void {
  // Redis entries expire via TTL; only the in-memory store needs purging.
  if (getRedis()) return;
  const now = Date.now();
  for (const [k, v] of signalingTickets) {
    if (v.expiresAt < now) signalingTickets.delete(k);
  }
}
