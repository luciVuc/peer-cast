/**
 * Audit log: immutable record of every admin action.
 *
 * Actions tracked:
 *   ban, unban, role_change, takedown, report_resolve,
 *   invite_create, invite_disable, user_delete
 */

import { nanoid } from "nanoid";
import { db } from "../db/index.js";

export interface AuditEntry {
  id: string;
  actorUsername: string;
  action: string;
  target: string;
  detail: string | null;
  createdAt: number;
}

interface AuditRow {
  id: string;
  actor_username_lc: string;
  action: string;
  target: string;
  detail: string | null;
  created_at: number;
}

function toEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    actorUsername: r.actor_username_lc,
    action: r.action,
    target: r.target,
    detail: r.detail,
    createdAt: r.created_at,
  };
}

export const auditRepo = {
  log(actorLc: string, action: string, target: string, detail?: string): void {
    db.prepare(
      `INSERT INTO audit_log (id, actor_username_lc, action, target, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(nanoid(16), actorLc, action, target, detail ?? null, Date.now());
  },

  list(
    cursor = 0,
    limit = 50,
  ): { entries: AuditEntry[]; nextCursor: number | null } {
    const rows = db
      .prepare(
        `SELECT * FROM audit_log
         WHERE (? = 0 OR created_at < ?)
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(cursor, cursor, limit + 1) as AuditRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return {
      entries: rows.map(toEntry),
      nextCursor: hasMore ? (rows[rows.length - 1]?.created_at ?? null) : null,
    };
  },
};
