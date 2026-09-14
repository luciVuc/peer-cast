import type { Invite } from "@peer-cast/shared";
import { customAlphabet } from "nanoid";
import { db } from "../db/index.js";

// Human-friendly, unambiguous invite codes (no 0/O/1/I/l).
const genCode = customAlphabet("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 10);

interface InviteRow {
  code: string;
  note: string | null;
  max_uses: number | null;
  uses: number;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
  disabled: number;
}

function toInvite(r: InviteRow): Invite {
  return {
    code: r.code,
    note: r.note,
    maxUses: r.max_uses,
    uses: r.uses,
    expiresAt: r.expires_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    disabled: !!r.disabled,
  };
}

export const invitesRepo = {
  create(input: {
    note: string | null;
    maxUses: number | null;
    expiresAt: number | null;
    createdBy: string | null;
  }): Invite {
    const code = genCode();
    db.prepare(
      `INSERT INTO invites (code, note, max_uses, uses, expires_at, created_by, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      code,
      input.note,
      input.maxUses,
      input.expiresAt,
      input.createdBy,
      Date.now(),
    );
    return toInvite(
      db.prepare(`SELECT * FROM invites WHERE code = ?`).get(code) as InviteRow,
    );
  },

  list(limit = 200): Invite[] {
    const rows = db
      .prepare(`SELECT * FROM invites ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as InviteRow[];
    return rows.map(toInvite);
  },

  disable(code: string): Invite | null {
    const r = db.prepare(`SELECT * FROM invites WHERE code = ?`).get(code);
    if (!r) return null;
    db.prepare(`UPDATE invites SET disabled = 1 WHERE code = ?`).run(code);
    return toInvite(
      db.prepare(`SELECT * FROM invites WHERE code = ?`).get(code) as InviteRow,
    );
  },

  /**
   * Atomically validate + consume one use of a code. Returns true on success.
   * The conditional UPDATE guards against races (uses < max_uses).
   */
  consume(code: string): boolean {
    const now = Date.now();
    const info = db
      .prepare(
        `UPDATE invites SET uses = uses + 1
         WHERE code = ?
           AND disabled = 0
           AND (expires_at IS NULL OR expires_at > ?)
           AND (max_uses IS NULL OR uses < max_uses)`,
      )
      .run(code, now);
    return info.changes === 1;
  },
};
