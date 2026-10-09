import type {
  AccessPolicy,
  Broadcast,
  BroadcastStats,
  BroadcastWithUser,
  CaptureSource,
} from "@peer-cast/shared";
import { nanoid } from "nanoid";
import { timingSafeEqual, createHash } from "node:crypto";
import bcrypt from "bcrypt";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { usersRepo } from "./users.js";
import * as recordingsRepo from "./recordings.js";

interface BroadcastRow {
  id: string;
  username_lc: string;
  title: string;
  description: string | null;
  status: string;
  access: string;
  access_code: string | null;
  source: string;
  peer_id: string | null;
  started_at: number;
  ended_at: number | null;
  peak_viewers: number;
  total_views: number;
  stat_viewers: number | null;
  stat_bitrate: number | null;
  stat_fps: number | null;
  stat_width: number | null;
  stat_height: number | null;
  stat_at: number | null;
}

function toBroadcast(r: BroadcastRow): Broadcast {
  const owner = usersRepo.getRaw(r.username_lc);
  return {
    id: r.id,
    username: owner?.username ?? r.username_lc,
    title: r.title,
    description: r.description,
    status: r.status as Broadcast["status"],
    access: r.access as AccessPolicy,
    source: r.source as CaptureSource,
    // peerId is never exposed via list/search/profile mappings; only the
    // /sessions resolve endpoint reveals it (after access-control checks),
    // reading peer_id directly from the row.
    peerId: null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    peakViewers: r.peak_viewers,
    totalViews: r.total_views,
  };
}

function statsOf(r: BroadcastRow): BroadcastStats | undefined {
  if (r.status !== "live" || r.stat_at == null) return undefined;
  return {
    viewers: r.stat_viewers ?? 0,
    bitrateKbps: r.stat_bitrate,
    fps: r.stat_fps,
    width: r.stat_width,
    height: r.stat_height,
    updatedAt: r.stat_at,
  };
}

/** Exported so routes can attach stats without duplicating the mapping logic. */
export function rowStatsOf(r: BroadcastRow): BroadcastStats | undefined {
  return statsOf(r);
}

function withUser(r: BroadcastRow): BroadcastWithUser {
  const owner = usersRepo.getPublic(r.username_lc)!;
  return { ...toBroadcast(r), owner, stats: statsOf(r) };
}

/**
 * Access codes are stored as a bcrypt digest, never in plaintext — the DB may
 * end up in backups, dumps, or the Docker volume.
 *
 * bcrypt rather than a bare hash: ACCESS_CODE_MIN is 6 characters chosen by a
 * human, so the entropy is low and entirely guessable offline. Unsalted
 * SHA-256 over such an input is a dictionary attack measured in seconds on a
 * GPU — whoever obtains the DB file recovers every access code, and those
 * codes are the only thing gating the stream. bcrypt's cost factor makes that
 * offline attack expensive, exactly as it does for user passwords.
 *
 * Cost 10 rather than the 12 used for account passwords: this runs on the
 * viewer's connect path (every resolve with a code), and code verification is
 * additionally rate limited per (IP, broadcast), so 10 buys a large offline
 * work factor without a perceptible viewer delay.
 *
 * The `bcrypt$` prefix keeps the format self-describing and lets us
 * soft-migrate rows written under the old sha256 scheme (and, below, any
 * legacy plaintext row) — see hashMatches.
 */
const CODE_BCRYPT_COST = 10;

async function hashCode(code: string): Promise<string> {
  return `bcrypt$${await bcrypt.hash(code, CODE_BCRYPT_COST)}`;
}

/**
 * Constant-time-enough code comparison. bcrypt.compare is the timing-safe
 * primitive; the legacy branches pre-hash both operands so the plaintext-era
 * rows do not leak length via an early return, and are only reachable for
 * broadcasts created before this change (self-healing: re-broadcasting the
 * same code re-hashes it under bcrypt).
 */
async function hashMatches(
  stored: string,
  candidate: string,
): Promise<boolean> {
  if (stored.startsWith("bcrypt$")) {
    try {
      return await bcrypt.compare(candidate, stored.slice("bcrypt$".length));
    } catch {
      return false;
    }
  }
  if (stored.startsWith("sha256$")) {
    const a = Buffer.from(stored.slice("sha256$".length), "hex");
    const b = createHash("sha256").update(candidate).digest();
    return a.length === b.length && timingSafeEqual(a, b);
  }
  // Pre-hash legacy plaintext row (timing-safe, length-padded via digest).
  return timingSafeEqual(
    createHash("sha256").update(stored).digest(),
    createHash("sha256").update(candidate).digest(),
  );
}

export interface StartInput {
  usernameLc: string;
  title: string;
  description: string | null;
  access: AccessPolicy;
  source: CaptureSource;
  peerId: string;
  accessCode?: string | null;
}

export const broadcastsRepo = {
  getRaw(id: string): BroadcastRow | undefined {
    return db.prepare(`SELECT * FROM broadcasts WHERE id = ?`).get(id) as
      BroadcastRow | undefined;
  },

  get(id: string): Broadcast | null {
    const r = this.getRaw(id);
    return r ? toBroadcast(r) : null;
  },

  getWithUser(id: string): BroadcastWithUser | null {
    const r = this.getRaw(id);
    return r ? withUser(r) : null;
  },

  /**
   * Whether `viewerLc` (or an anonymous caller when null) may see this
   * broadcast's *metadata*. Media access is decided separately at /sessions;
   * this only governs whether the existence, title, and audience size are
   * disclosed. Owner and any signed-in viewer always pass for `authenticated`
   * so a member can see the stream before joining; `code` requires the owner,
   * since possession of the code is not something the server can infer here.
   */
  canViewMetadata(access: string, ownerLc: string, viewerLc: string | null) {
    if (access === "public") return true;
    if (viewerLc && viewerLc === ownerLc) return true;
    if (access === "authenticated") return viewerLc !== null;
    return false;
  },

  /**
   * Latest live broadcast for a user. A row whose last stats heartbeat (or
   * start time, if it never reported stats) is older than `stalenessMs` is
   * treated as not live: its host went silent and the reaper will force-end
   * it, so viewers must not receive a stale peer id during the reap window.
   */
  liveForUser(
    usernameLc: string,
    stalenessMs: number = config.staleLiveMs,
  ): BroadcastRow | undefined {
    return db
      .prepare(
        `SELECT * FROM broadcasts WHERE username_lc = ? AND status = 'live'
           AND COALESCE(stat_at, started_at) > ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(usernameLc, Date.now() - stalenessMs) as BroadcastRow | undefined;
  },

  liveWithUser(usernameLc: string): BroadcastWithUser | null {
    const r = this.liveForUser(usernameLc);
    return r ? withUser(r) : null;
  },

  /**
   * Return both the raw DB row and the joined BroadcastWithUser in one query.
   * Use this when the caller needs peer_id (raw) AND the public-facing shape
   * simultaneously, to avoid hitting the DB twice.
   */
  liveForUserFull(
    usernameLc: string,
  ): { row: BroadcastRow; live: BroadcastWithUser } | null {
    const row = this.liveForUser(usernameLc);
    if (!row) return null;
    return { row, live: withUser(row) };
  },

  /** End any existing live broadcast(s) for a user, then start a new one. */
  async start(input: StartInput): Promise<Broadcast> {
    // Hash BEFORE opening the transaction: better-sqlite3 transactions are
    // synchronous, so an await inside one would commit early and interleave
    // with other writers. Access-code hashing moved to the async bcrypt API
    // specifically so this connect-path work never blocks the event loop.
    const accessCodeHash = input.accessCode
      ? await hashCode(input.accessCode)
      : null;
    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE broadcasts SET status = 'ended', ended_at = ?, peer_id = NULL
         WHERE username_lc = ? AND status = 'live'`,
      ).run(now, input.usernameLc);

      const id = nanoid(16);
      db.prepare(
        `INSERT INTO broadcasts
          (id, username_lc, title, description, status, access, access_code,
           source, peer_id, started_at, peak_viewers, total_views)
         VALUES (?, ?, ?, ?, 'live', ?, ?, ?, ?, ?, 0, 0)`,
      ).run(
        id,
        input.usernameLc,
        input.title,
        input.description,
        input.access,
        accessCodeHash,
        input.source,
        input.peerId,
        now,
      );
      return id;
    });
    const id = tx();
    return toBroadcast(this.getRaw(id)!);
  },

  end(id: string, usernameLc: string): Broadcast | null {
    const r = this.getRaw(id);
    if (!r || r.username_lc !== usernameLc) return null;
    db.prepare(
      `UPDATE broadcasts SET status = 'ended', ended_at = ?, peer_id = NULL,
         stat_viewers = NULL, stat_bitrate = NULL, stat_fps = NULL,
         stat_width = NULL, stat_height = NULL, stat_at = NULL
       WHERE id = ?`,
    ).run(Date.now(), id);
    return toBroadcast(this.getRaw(id)!);
  },

  updateStats(
    id: string,
    usernameLc: string,
    s: Omit<BroadcastStats, "updatedAt">,
  ) {
    const r = this.getRaw(id);
    if (!r || r.username_lc !== usernameLc || r.status !== "live") return null;
    const peak = Math.max(r.peak_viewers, s.viewers);
    // total_views tracks cumulative accepted connections, supplied by the
    // broadcaster host as s.totalConnections.  Fall back to Math.max so rows
    // updated by old clients (extension without the field) still grow sensibly.
    const total =
      s.totalConnections != null
        ? Math.max(r.total_views, s.totalConnections)
        : Math.max(r.total_views, r.peak_viewers, s.viewers);
    db.prepare(
      `UPDATE broadcasts SET
         stat_viewers = ?, stat_bitrate = ?, stat_fps = ?,
         stat_width = ?, stat_height = ?, stat_at = ?,
         peak_viewers = ?, total_views = ?
       WHERE id = ?`,
    ).run(
      s.viewers,
      s.bitrateKbps,
      s.fps,
      s.width,
      s.height,
      Date.now(),
      peak,
      total,
      id,
    );
    return withUser(this.getRaw(id)!);
  },

  historyForUser(usernameLc: string, limit = 100): BroadcastWithUser[] {
    const rows = db
      .prepare(
        `SELECT * FROM broadcasts WHERE username_lc = ?
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(usernameLc, limit) as BroadcastRow[];
    return rows.map(withUser);
  },

  /**
   * Public discovery feed. Only `access = 'public'` rows are listed.
   *
   * Restricting by access (not just withholding peerId) is deliberate: a
   * broadcaster who marks a stream `code` to limit it to a private audience
   * still expects its *existence* to stay private. Listing title, owner, and
   * viewer count for a gated stream publishes exactly what the access level
   * was chosen to conceal, even though the media itself stays protected.
   * Gated streams are still reachable via /sessions after the access check.
   */
  listLive(limit = 60): BroadcastWithUser[] {
    const rows = db
      .prepare(
        `SELECT b.* FROM broadcasts b
         JOIN users u ON u.username_lc = b.username_lc
         WHERE b.status = 'live' AND u.discoverable = 1 AND u.banned = 0
           AND b.access = 'public'
           AND COALESCE(b.stat_at, b.started_at) > ?
         ORDER BY b.started_at DESC LIMIT ?`,
      )
      .all(Date.now() - config.staleLiveMs, limit) as BroadcastRow[];
    return rows.map(withUser);
  },

  /** See listLive: gated broadcasts are excluded from search too. */
  searchLive(query: string, limit = 20): BroadcastWithUser[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    const rows = db
      .prepare(
        `SELECT b.* FROM broadcasts b
         JOIN users u ON u.username_lc = b.username_lc
         WHERE b.status = 'live' AND u.discoverable = 1 AND u.banned = 0
           AND b.access = 'public'
           AND COALESCE(b.stat_at, b.started_at) > ?
           AND (b.title LIKE ? OR u.username LIKE ? OR u.display_name LIKE ?)
         ORDER BY b.started_at DESC LIMIT ?`,
      )
      .all(
        Date.now() - config.staleLiveMs,
        like,
        like,
        like,
        limit,
      ) as BroadcastRow[];
    return rows.map(withUser);
  },

  /** Force-end every live broadcast for a user (moderation / ban). */
  endAllForUser(usernameLc: string): number {
    const info = db
      .prepare(
        `UPDATE broadcasts SET status = 'ended', ended_at = ?, peer_id = NULL,
           stat_viewers = NULL, stat_bitrate = NULL, stat_fps = NULL,
           stat_width = NULL, stat_height = NULL, stat_at = NULL
         WHERE username_lc = ? AND status = 'live'`,
      )
      .run(Date.now(), usernameLc);
    return info.changes;
  },

  /**
   * Force-end live broadcasts that stopped reporting stats (reaper).  A host
   * that dies without calling the end API — closed tab, crashed browser, lost
   * network — stops heartbeating; without this, its row stays "live" forever
   * and ghosts the dashboard / discovery.  Rows that never reported stats are
   * judged from their start time so a broken host still has a finite life.
   */
  endStale(olderThanMs: number): number {
    const info = db
      .prepare(
        `UPDATE broadcasts SET status = 'ended', ended_at = ?, peer_id = NULL,
           stat_viewers = NULL, stat_bitrate = NULL, stat_fps = NULL,
           stat_width = NULL, stat_height = NULL, stat_at = NULL
         WHERE status = 'live' AND COALESCE(stat_at, started_at) < ?`,
      )
      .run(Date.now(), Date.now() - olderThanMs);
    return info.changes;
  },

  /**
   * Purge ended broadcasts (and their recordings) older than the retention
   * window. Without this the table grows without bound on a long-lived
   * instance — nothing else ever deletes an ended row.
   *
   * No-op when the window is 0, which is the default: retention is a policy
   * decision for the operator, so it is opt-in rather than silently deleting
   * data someone may still want. Returns the number of broadcasts removed.
   */
  purgeEndedOlderThan(days: number): number {
    if (days <= 0) return 0;
    const cutoff = Date.now() - days * 86_400_000;
    const ids = db
      .prepare(
        `SELECT id FROM broadcasts WHERE status = 'ended'
           AND COALESCE(ended_at, started_at) < ?`,
      )
      .all(cutoff) as { id: string }[];
    for (const { id } of ids) {
      // recordings.broadcast_id is ON DELETE SET NULL (they can outlive the
      // broadcast), so the FK does NOT clean these up — look them up by
      // broadcast_id and delete each via its own primary key so the on-disk
      // .webm/.part files go too. A recording kept past its broadcast is still
      // reachable from the dashboard, so leave those alone.
      const recs = db
        .prepare(`SELECT id FROM recordings WHERE broadcast_id = ?`)
        .all(id) as { id: string }[];
      for (const r of recs) recordingsRepo.remove(r.id);
      db.prepare(`DELETE FROM broadcasts WHERE id = ?`).run(id);
    }
    return ids.length;
  },

  /** Admin force-end a specific broadcast (any owner). */
  adminEnd(id: string): Broadcast | null {
    const r = this.getRaw(id);
    if (!r) return null;
    db.prepare(
      `UPDATE broadcasts SET status = 'ended', ended_at = ?, peer_id = NULL,
         stat_viewers = NULL, stat_bitrate = NULL, stat_fps = NULL,
         stat_width = NULL, stat_height = NULL, stat_at = NULL
       WHERE id = ?`,
    ).run(Date.now(), id);
    return toBroadcast(this.getRaw(id)!);
  },

  /**
   * Verify that `code` matches the stored access code for broadcast `id`.
   * The stored value is a bcrypt digest (see `hashCode`) — we never compare
   * plaintext. Comparison is constant-time to prevent timing-based
   * brute-force enumeration of access codes. Async because bcrypt runs off the
   * event loop; this sits on the viewer connect path.
   */
  async verifyAccessCode(id: string, code: string): Promise<boolean> {
    const r = this.getRaw(id);
    if (!r || r.access !== "code" || !r.access_code) return false;
    return hashMatches(r.access_code, code);
  },

  /**
   * Public broadcast history for a user's profile page.
   * Only returns ended public broadcasts, cursor-paginated.
   */
  publicHistoryForUser(
    usernameLc: string,
    cursor = 0,
    limit = 20,
  ): { rows: BroadcastWithUser[]; nextCursor: number | null } {
    const rows = db
      .prepare(
        `SELECT * FROM broadcasts
         WHERE username_lc = ? AND status = 'ended' AND access = 'public'
           AND (? = 0 OR started_at < ?)
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(usernameLc, cursor, cursor, limit + 1) as BroadcastRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return {
      rows: rows.map(withUser),
      nextCursor: hasMore ? (rows[rows.length - 1]?.started_at ?? null) : null,
    };
  },
};
