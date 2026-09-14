import type {
  AdminMetrics,
  MetricsDay,
  MetricsPeakDay,
} from "@peer-cast/shared";
import { db } from "../db/index.js";

const DAY_MS = 86_400_000;
const UTC_DAY = 1000 * 3600 * 24;

const asInt = (v: unknown): number => {
  const row = v as { c?: unknown } | undefined;
  return typeof row?.c === "number" ? row.c : 0;
};

/** Milliseconds since epoch for the UTC midnight that `ms` falls in. */
function utcDayStart(ms: number): number {
  return ms - (ms % UTC_DAY);
}

/**
 * Aggregate admin statistics + last-N-day time series. Day buckets use UTC
 * midnight boundaries and epoch-millisecond integer division so they line up
 * across queries regardless of SQLite's local timezone.
 */
export const metricsRepo = {
  summary(days: number): AdminMetrics {
    const now = Date.now();
    const start = utcDayStart(now) - (days - 1) * DAY_MS;
    const thisDayStart = utcDayStart(now);

    const totals: AdminMetrics["totals"] = {
      users: asInt(db.prepare(`SELECT COUNT(*) c FROM users`).get()),
      admins: asInt(
        db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'admin'`).get(),
      ),
      banned: asInt(
        db.prepare(`SELECT COUNT(*) c FROM users WHERE banned = 1`).get(),
      ),
      unverified: asInt(
        db
          .prepare(`SELECT COUNT(*) c FROM users WHERE email_verified = 0`)
          .get(),
      ),
      broadcasts: asInt(
        db
          .prepare(`SELECT COUNT(*) c FROM broadcasts WHERE status = 'ended'`)
          .get(),
      ),
      liveBroadcasts: asInt(
        db
          .prepare(`SELECT COUNT(*) c FROM broadcasts WHERE status = 'live'`)
          .get(),
      ),
      currentViewers: asInt(
        db
          .prepare(
            `SELECT COALESCE(SUM(stat_viewers), 0) c
             FROM broadcasts WHERE status = 'live' AND stat_viewers IS NOT NULL`,
          )
          .get(),
      ),
      totalViews: asInt(
        db
          .prepare(
            `SELECT COALESCE(SUM(total_views), 0) c
             FROM broadcasts WHERE status = 'ended'`,
          )
          .get(),
      ),
      peakConcurrentViewers: asInt(
        db
          .prepare(`SELECT COALESCE(MAX(peak_viewers), 0) c FROM broadcasts`)
          .get(),
      ),
      peakConcurrentToday: asInt(
        db
          .prepare(
            `SELECT COALESCE(MAX(peak_viewers), 0) c
             FROM broadcasts WHERE started_at >= ?`,
          )
          .get(thisDayStart),
      ),
    };

    // Bucket per day in JS (SQLite float-division is unreliable for exact int
    // bucket keys). Timestamps are trimmed to the window in SQL for cheapness.
    const broadcastTs = db
      .prepare(`SELECT started_at AS ts FROM broadcasts WHERE started_at >= ?`)
      .all(start) as { ts: number }[];
    const userTs = db
      .prepare(`SELECT created_at AS ts FROM users WHERE created_at >= ?`)
      .all(start) as { ts: number }[];
    const peakRows = db
      .prepare(
        `SELECT started_at AS ts, peak_viewers AS peak
         FROM broadcasts WHERE started_at >= ?`,
      )
      .all(start) as { ts: number; peak: number }[];

    const broadcastCounts = new Map<number, number>();
    const userCounts = new Map<number, number>();
    const peakByDay = new Map<number, number>();
    for (const { ts } of broadcastTs) {
      const b = Math.floor((ts - start) / DAY_MS);
      broadcastCounts.set(b, (broadcastCounts.get(b) ?? 0) + 1);
    }
    for (const { ts } of userTs) {
      const b = Math.floor((ts - start) / DAY_MS);
      userCounts.set(b, (userCounts.get(b) ?? 0) + 1);
    }
    for (const { ts, peak } of peakRows) {
      const b = Math.floor((ts - start) / DAY_MS);
      peakByDay.set(b, Math.max(peakByDay.get(b) ?? 0, peak));
    }

    const broadcastsPerDay: MetricsDay[] = [];
    const usersPerDay: MetricsDay[] = [];
    const concurrentPeakPerDay: MetricsPeakDay[] = [];
    for (let i = 0; i < days; i++) {
      const date = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
      broadcastsPerDay.push({ date, count: broadcastCounts.get(i) ?? 0 });
      usersPerDay.push({ date, count: userCounts.get(i) ?? 0 });
      concurrentPeakPerDay.push({ date, peak: peakByDay.get(i) ?? 0 });
    }

    return {
      totals,
      broadcastsPerDay,
      usersPerDay,
      concurrentPeakPerDay,
    };
  },
};
