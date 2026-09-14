import type { Report, ReportStatus } from "@peer-cast/shared";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";

interface ReportRow {
  id: string;
  target_username: string;
  broadcast_id: string | null;
  reporter_username: string | null;
  reason: string;
  status: string;
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

function toReport(r: ReportRow): Report {
  return {
    id: r.id,
    targetUsername: r.target_username,
    broadcastId: r.broadcast_id,
    reporterUsername: r.reporter_username,
    reason: r.reason,
    status: r.status as ReportStatus,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
  };
}

export const reportsRepo = {
  create(input: {
    targetUsernameLc: string;
    broadcastId: string | null;
    reporterUsernameLc: string | null;
    reason: string;
  }): Report {
    const id = nanoid(16);
    db.prepare(
      `INSERT INTO reports
        (id, target_username, broadcast_id, reporter_username, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    ).run(
      id,
      input.targetUsernameLc,
      input.broadcastId,
      input.reporterUsernameLc,
      input.reason,
      Date.now(),
    );
    return toReport(
      db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id) as ReportRow,
    );
  },

  list(status: ReportStatus | "all", limit = 200): Report[] {
    const rows =
      status === "all"
        ? (db
            .prepare(`SELECT * FROM reports ORDER BY created_at DESC LIMIT ?`)
            .all(limit) as ReportRow[])
        : (db
            .prepare(
              `SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(status, limit) as ReportRow[]);
    return rows.map(toReport);
  },

  countOpen(): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`)
      .get() as { n: number };
    return row.n;
  },

  resolve(
    id: string,
    status: "resolved" | "dismissed",
    resolverLc: string,
  ): Report | null {
    const existing = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id);
    if (!existing) return null;
    db.prepare(
      `UPDATE reports SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?`,
    ).run(status, Date.now(), resolverLc, id);
    return toReport(
      db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id) as ReportRow,
    );
  },
};
