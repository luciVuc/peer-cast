import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";

const EMAIL_VERIFY_TTL_MS = 24 * 3600_000;
const PASSWORD_RESET_TTL_MS = 60 * 60_000; // 1 hour

function genToken() {
  return randomBytes(32).toString("base64url");
}

export const emailTokensRepo = {
  // ─── Email verification ─────────────────────────────────────────────────

  createVerification(usernameLc: string): string {
    const token = genToken();
    // Revoke any previous un-used verification token for this user.
    db.prepare(`DELETE FROM email_verifications WHERE username_lc = ?`).run(
      usernameLc,
    );
    db.prepare(
      `INSERT INTO email_verifications (token, username_lc, expires_at) VALUES (?, ?, ?)`,
    ).run(token, usernameLc, Date.now() + EMAIL_VERIFY_TTL_MS);
    return token;
  },

  /**
   * Consume a verification token. Returns the username_lc on success, null on
   * failure (invalid, expired). Always deletes the token row (matches
   * consumeReset pattern — single-use, expired tokens cleaned up immediately).
   */
  consumeVerification(token: string): string | null {
    const row = db
      .prepare(
        `SELECT username_lc, expires_at FROM email_verifications WHERE token = ?`,
      )
      .get(token) as { username_lc: string; expires_at: number } | undefined;
    // Always delete the token (whether valid, expired, or not found) so
    // expired tokens don't linger until the next periodic purge.
    if (row) {
      db.prepare(`DELETE FROM email_verifications WHERE username_lc = ?`).run(
        row.username_lc,
      );
    }
    if (!row || row.expires_at < Date.now()) return null;
    return row.username_lc;
  },

  // ─── Password reset ──────────────────────────────────────────────────────

  createReset(usernameLc: string): string {
    const token = genToken();
    db.prepare(`DELETE FROM password_resets WHERE username_lc = ?`).run(
      usernameLc,
    );
    db.prepare(
      `INSERT INTO password_resets (token, username_lc, expires_at) VALUES (?, ?, ?)`,
    ).run(token, usernameLc, Date.now() + PASSWORD_RESET_TTL_MS);
    return token;
  },

  /**
   * Consume a reset token. Single-use: the row is deleted on success.
   * Returns the username_lc or null.
   */
  consumeReset(token: string): string | null {
    const row = db
      .prepare(
        `SELECT username_lc, expires_at FROM password_resets WHERE token = ?`,
      )
      .get(token) as { username_lc: string; expires_at: number } | undefined;
    db.prepare(`DELETE FROM password_resets WHERE token = ?`).run(token);
    if (!row || row.expires_at < Date.now()) return null;
    return row.username_lc;
  },

  // ─── Email change ──────────────────────────────────────────────────────────

  /**
   * Issue a confirmation token for switching to `newEmail`. The new address is
   * NOT applied until the token is consumed. Re-issuing revokes the previous
   * pending change (one live token per user at a time).
   */
  createEmailChange(usernameLc: string, newEmail: string): string {
    const token = genToken();
    db.prepare(`DELETE FROM email_changes WHERE username_lc = ?`).run(
      usernameLc,
    );
    db.prepare(
      `INSERT INTO email_changes (token, username_lc, new_email, expires_at)
       VALUES (?, ?, ?, ?)`,
    ).run(token, usernameLc, newEmail, Date.now() + EMAIL_VERIFY_TTL_MS);
    return token;
  },

  /**
   * Consume an email-change token. Single-use: the row is deleted on any
   * attempt (valid or not), so a replayed token always fails. Returns the
   * pending (username_lc, new_email) pair or null.
   */
  consumeEmailChange(
    token: string,
  ): { username_lc: string; new_email: string } | null {
    const row = db
      .prepare(
        `SELECT username_lc, new_email, expires_at FROM email_changes
         WHERE token = ?`,
      )
      .get(token) as
      | { username_lc: string; new_email: string; expires_at: number }
      | undefined;
    db.prepare(`DELETE FROM email_changes WHERE token = ?`).run(token);
    if (!row || row.expires_at < Date.now()) return null;
    return { username_lc: row.username_lc, new_email: row.new_email };
  },

  purgeExpired() {
    const now = Date.now();
    db.prepare(`DELETE FROM email_verifications WHERE expires_at < ?`).run(now);
    db.prepare(`DELETE FROM password_resets WHERE expires_at < ?`).run(now);
    db.prepare(`DELETE FROM email_changes WHERE expires_at < ?`).run(now);
  },
};
