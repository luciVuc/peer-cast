import type {
  AccessPolicy,
  Broadcast,
  BroadcastStats,
  BroadcastWithUser,
  CaptureSource,
} from "@peer-cast/shared";
import { nanoid } from "nanoid";
import { timingSafeEqual, createHash } from "node:crypto";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { usersRepo } from "./users.js";

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
 * Access codes are stored only as a salted-style SHA-256 digest, never in
 * plaintext — the DB may end up in backups, dumps, or the Docker volume.
 * Prefix keeps the format self-describing and lets us soft-migrate any
 * plaintext rows written before this change (only live code broadcasts, and
 * they self-heal on the next re-broadcast).
 */
function hashCode(code: string): string {
  return `sha256$${createHash("sha256").update(code).digest("hex")}`;
}

function hashMatches(stored: string, candidate: string): boolean {
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
  start(input: StartInput): Broadcast {
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
        input.accessCode ? hashCode(input.accessCode) : null,
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

  searchLive(query: string, limit = 20): BroadcastWithUser[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    const rows = db
      .prepare(
        `SELECT b.* FROM broadcasts b
         JOIN users u ON u.username_lc = b.username_lc
         WHERE b.status = 'live' AND u.discoverable = 1 AND u.banned = 0
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
   * The stored value is a SHA-256 digest (see `hashCode`) — we never compare
   * plaintext. Comparison is constant-time to prevent timing-based
   * brute-force enumeration of access codes.
   */
  verifyAccessCode(id: string, code: string): boolean {
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
