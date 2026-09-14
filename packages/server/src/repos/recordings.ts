import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index.js";
import { config } from "../config.js";

/** Row shape for a recorded replay (WebM stored on disk under config.recordings.dir). */
export interface RecordingRow {
  id: string;
  usernameLc: string;
  broadcastId: string | null;
  title: string;
  status: "recording" | "complete";
  sizeBytes: number;
  durationMs: number;
  createdAt: number;
  completedAt: number | null;
}

const COLUMNS =
  "id, username_lc, broadcast_id, title, status, size_bytes, duration_ms, created_at, completed_at";

function mapRow(r: {
  id: string;
  username_lc: string;
  broadcast_id?: string | null;
  title: string;
  status: "recording" | "complete";
  size_bytes: number;
  duration_ms: number;
  created_at: number;
  completed_at: number | null;
}): RecordingRow {
  return {
    id: r.id,
    usernameLc: r.username_lc,
    broadcastId: r.broadcast_id ?? null,
    title: r.title,
    status: r.status,
    sizeBytes: r.size_bytes,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? null,
  };
}

/** Directory holding the WebM files (+ .part files while recording). */
export function recordingsDir(): string {
  mkdirSync(config.recordings.dir, { recursive: true });
  return config.recordings.dir;
}

/** In-progress upload target (file) for a recording. */
export function partFileOf(id: string): string {
  return join(config.recordings.dir, `${id}.webm.part`);
}

/** Final replay file (created on finalize). */
export function replayFileOf(id: string): string {
  return join(config.recordings.dir, `${id}.webm`);
}

export function createRecording(params: {
  usernameLc: string;
  title: string;
  broadcastId?: string | null;
}): RecordingRow {
  const id = randomBytes(9).toString("hex"); // 18 hex chars — filesystem-safe
  db.prepare(
    `INSERT INTO recordings
       (id, username_lc, broadcast_id, title, status, size_bytes, duration_ms, created_at)
     VALUES (?, ?, ?, ?, 'recording', 0, 0, ?)`,
  ).run(
    id,
    params.usernameLc,
    params.broadcastId ?? null,
    params.title,
    Date.now(),
  );
  return getOwned(id, params.usernameLc)!;
}

/** A recording owned by the given user, or null. */
export function getOwned(id: string, usernameLc: string): RecordingRow | null {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM recordings WHERE id = ? AND username_lc = ?`,
    )
    .get(id, usernameLc);
  return row ? mapRow(row as Parameters<typeof mapRow>[0]) : null;
}

export function get(id: string): RecordingRow | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM recordings WHERE id = ?`)
    .get(id);
  return row ? mapRow(row as Parameters<typeof mapRow>[0]) : null;
}

export function listForUser(usernameLc: string): RecordingRow[] {
  return (
    db
      .prepare(
        `SELECT ${COLUMNS} FROM recordings
         WHERE username_lc = ?
         ORDER BY created_at DESC`,
      )
      .all(usernameLc) as Parameters<typeof mapRow>[0][]
  ).map(mapRow);
}

/** Total stored bytes (completed + in-progress) for an account. Used to
 *  enforce the per-user recording quota at chunk upload. */
export function totalBytesForUser(usernameLc: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS total
       FROM recordings WHERE username_lc = ?`,
    )
    .get(usernameLc) as { total: number };
  return row.total;
}

/** Accumulate uploaded bytes into the size counter. Returns new total. */
export function appendBytes(id: string, bytes: number): number {
  db.prepare(
    `UPDATE recordings SET size_bytes = size_bytes + ? WHERE id = ?`,
  ).run(bytes, id);
  const row = db
    .prepare(`SELECT size_bytes FROM recordings WHERE id = ?`)
    .get(id) as { size_bytes: number };
  return row.size_bytes;
}

/** Mark a recording complete with its final metadata. */
export function finalize(id: string, durationMs: number): RecordingRow | null {
  db.prepare(
    `UPDATE recordings
     SET status = 'complete', duration_ms = ?, completed_at = ?
     WHERE id = ? AND status = 'recording'`,
  ).run(durationMs, Date.now(), id);
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM recordings WHERE id = ?`)
    .get(id);
  return row ? mapRow(row as Parameters<typeof mapRow>[0]) : null;
}

/** Remove the row; returns true when a row existed. */
export function remove(id: string): boolean {
  const info = db.prepare(`DELETE FROM recordings WHERE id = ?`).run(id);
  return info.changes > 0;
}

/** Hard-delete an owner: removes every recording row + its files. */
export function deleteAllForUser(usernameLc: string): void {
  for (const r of listForUser(usernameLc)) {
    remove(r.id);
    try {
      rmSync(partFileOf(r.id), { force: true });
      rmSync(replayFileOf(r.id), { force: true });
    } catch {
      /* best-effort file cleanup */
    }
  }
}

export default {
  recordingsDir,
  partFileOf,
  replayFileOf,
  createRecording,
  getOwned,
  get,
  listForUser,
  totalBytesForUser,
  appendBytes,
  finalize,
  remove,
  deleteAllForUser,
};
