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

// ─── Access tokens (stateless JWT) ───────────────────────────────────────────

export interface AccessClaims {
  sub: string; // username_lc
  username: string; // display-case handle
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
    return { sub: decoded.sub, username: decoded.username };
  } catch {
    return null;
  }
}

// ─── Refresh tokens (opaque, rotating, stored hashed) ────────────────────────

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export function issueRefreshToken(usernameLc: string): string {
  const token = randomBytes(48).toString("base64url");
  const now = Date.now();
  db.prepare(
    `INSERT INTO refresh_tokens (token_hash, username_lc, expires_at, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(sha256(token), usernameLc, now + config.jwt.refreshTtlSec * 1000, now);
  return token;
}

/** Consume (rotate) a refresh token: verify + delete. Returns username_lc.
 * Rotation limits the blast radius of a leaked token. Future hardening:
 * track a token-family id per session and revoke the whole family when an
 * already-consumed (or expired) token is presented again (reuse detection). */
export function consumeRefreshToken(token: string): string | null {
  const hash = sha256(token);
  const row = db
    .prepare(
      `SELECT username_lc, expires_at FROM refresh_tokens WHERE token_hash = ?`,
    )
    .get(hash) as { username_lc: string; expires_at: number } | undefined;
  db.prepare(`DELETE FROM refresh_tokens WHERE token_hash = ?`).run(hash);
  if (!row || row.expires_at < Date.now()) return null;
  return row.username_lc;
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
