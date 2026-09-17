import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

/**
 * Single shared SQLite connection (better-sqlite3 is synchronous and fast).
 * The schema is created idempotently on first import.
 */

mkdirSync(dirname(config.db.file), { recursive: true });

export const db: DB = new Database(config.db.file);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  username_lc      TEXT PRIMARY KEY,
  username         TEXT NOT NULL,
  email            TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  about            TEXT,
  avatar_url       TEXT,
  password_hash    TEXT NOT NULL,
  default_access   TEXT NOT NULL DEFAULT 'public',
  default_title    TEXT NOT NULL DEFAULT 'Live broadcast',
  discoverable     INTEGER NOT NULL DEFAULT 1,
  role             TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  email_verified   INTEGER NOT NULL DEFAULT 0,
  banned           INTEGER NOT NULL DEFAULT 0,
  banned_reason    TEXT,
  banned_at        INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_display ON users(display_name);

CREATE TABLE IF NOT EXISTS broadcasts (
  id            TEXT PRIMARY KEY,
  username_lc   TEXT NOT NULL REFERENCES users(username_lc) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL,            -- 'live' | 'ended'
  access        TEXT NOT NULL,            -- 'public' | 'authenticated' | 'code'
  access_code   TEXT,                     -- present when access = 'code'
  source        TEXT NOT NULL,            -- capture source
  peer_id       TEXT,                     -- null once ended
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  peak_viewers  INTEGER NOT NULL DEFAULT 0,
  total_views   INTEGER NOT NULL DEFAULT 0,
  -- live stats snapshot (transient; cleared when ended)
  stat_viewers  INTEGER,
  stat_bitrate  INTEGER,
  stat_fps      INTEGER,
  stat_width    INTEGER,
  stat_height   INTEGER,
  stat_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_owner ON broadcasts(username_lc, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status, started_at DESC);

-- Refresh tokens (rotating). Access tokens are stateless JWTs.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash   TEXT PRIMARY KEY,
  username_lc  TEXT NOT NULL REFERENCES users(username_lc) ON DELETE CASCADE,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(username_lc);

-- Short-lived viewer access tickets for authenticated/code broadcasts.
CREATE TABLE IF NOT EXISTS tickets (
  ticket       TEXT PRIMARY KEY,
  username_lc  TEXT,                      -- viewer (null for code-only anon)
  peer_id      TEXT NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- Abuse reports filed against a user / broadcast.
-- broadcast_id uses ON DELETE SET NULL so reports are preserved for audit
-- history even after the broadcast or user account is deleted.
CREATE TABLE IF NOT EXISTS reports (
  id                TEXT PRIMARY KEY,
  target_username   TEXT NOT NULL,        -- lowercased handle
  broadcast_id      TEXT REFERENCES broadcasts(id) ON DELETE SET NULL,
  reporter_username TEXT,                 -- lowercased handle, null if anon
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',  -- open|resolved|dismissed
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  resolved_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_username);

-- Invite codes (used when registration mode is 'invite').
CREATE TABLE IF NOT EXISTS invites (
  code        TEXT PRIMARY KEY,
  note        TEXT,
  max_uses    INTEGER,               -- null = unlimited
  uses        INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,               -- null = never
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  disabled    INTEGER NOT NULL DEFAULT 0
);

-- Email verification tokens.
CREATE TABLE IF NOT EXISTS email_verifications (
  token        TEXT PRIMARY KEY,
  username_lc  TEXT NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- Password reset tokens (single-use, short-lived).
CREATE TABLE IF NOT EXISTS password_resets (
  token        TEXT PRIMARY KEY,
  username_lc  TEXT NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- Pending email-change confirmations (new address is NOT active until the
-- token is consumed). One live token per user at a time.
CREATE TABLE IF NOT EXISTS email_changes (
  token        TEXT PRIMARY KEY,
  username_lc  TEXT NOT NULL,
  new_email    TEXT NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- Follow graph. A user hides a broadcaster from their home feed by
-- unfollowing; "followed user goes live" push notifications use this too.
CREATE TABLE IF NOT EXISTS follows (
  follower_username_lc  TEXT NOT NULL REFERENCES users(username_lc) ON DELETE CASCADE,
  followed_username_lc  TEXT NOT NULL REFERENCES users(username_lc) ON DELETE CASCADE,
  created_at            INTEGER NOT NULL,
  PRIMARY KEY (follower_username_lc, followed_username_lc)
);
CREATE INDEX IF NOT EXISTS idx_follows_followed
  ON follows(followed_username_lc);

-- Web Push (VAPID) subscriptions. endpoint is the stable browser identity.
-- A browser registers exactly one per account — upsert on the endpoint.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  username_lc  TEXT NOT NULL REFERENCES users(username_lc) ON DELETE CASCADE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(username_lc);

-- Per-broadcast recordings (WebM files stored under RECORDINGS_DIR).
-- broadcast_id uses ON DELETE SET NULL so a replay survives its broadcast's
-- deletion; deleting the OWNER account still cascades the row away, but the
-- files are cleaned up by the delete endpoints (recordingsRepo.deleteAllForUser).
CREATE TABLE IF NOT EXISTS recordings (
  id           TEXT PRIMARY KEY,
  username_lc  TEXT NOT NULL REFERENCES users(username_lc) ON DELETE CASCADE,
  broadcast_id TEXT REFERENCES broadcasts(id) ON DELETE SET NULL,
  title        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'recording',  -- recording | complete
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_recordings_user
  ON recordings(username_lc, created_at DESC);
`);

// ─── Lightweight migrations for pre-existing databases ───────────────────────
// The CREATE TABLE above only applies to fresh installs; add any columns that
// older databases are missing so upgrades are seamless.
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("users", "role", "role TEXT NOT NULL DEFAULT 'user'");
ensureColumn(
  "users",
  "email_verified",
  "email_verified INTEGER NOT NULL DEFAULT 0",
);
ensureColumn("users", "banned", "banned INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "banned_reason", "banned_reason TEXT");
ensureColumn("users", "banned_at", "banned_at INTEGER");

// ─── One-time data-integrity repairs ─────────────────────────────────────────
// These run on every boot but are idempotent and fast.

// Null out reports.broadcast_id values that point at deleted broadcasts.
// Pre-existing databases lack the FK constraint (it cannot be added via ALTER
// TABLE in SQLite); this keeps referential integrity for those installs.
db.exec(
  `UPDATE reports SET broadcast_id = NULL
   WHERE broadcast_id IS NOT NULL
     AND broadcast_id NOT IN (SELECT id FROM broadcasts)`,
);

export default db;
