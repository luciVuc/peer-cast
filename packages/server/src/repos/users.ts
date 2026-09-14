import type {
  AdminUser,
  PublicUser,
  SelfUser,
  UserRole,
  UserSettings,
} from "@peer-cast/shared";
import { db } from "../db/index.js";

interface UserRow {
  username_lc: string;
  username: string;
  email: string;
  display_name: string;
  about: string | null;
  avatar_url: string | null;
  password_hash: string;
  default_access: string;
  default_title: string;
  discoverable: number;
  role: string;
  email_verified: number;
  banned: number;
  banned_reason: string | null;
  banned_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface NewUser {
  username: string;
  email: string;
  displayName: string;
  about: string | null;
  passwordHash: string;
}

function toPublic(r: UserRow): PublicUser {
  return {
    username: r.username,
    displayName: r.display_name,
    about: r.about,
    avatarUrl: r.avatar_url,
    createdAt: r.created_at,
  };
}

function toSelf(r: UserRow): SelfUser {
  return {
    ...toPublic(r),
    email: r.email,
    role: r.role as UserRole,
    emailVerified: !!r.email_verified,
    updatedAt: r.updated_at,
  };
}

function toAdmin(r: UserRow, live: boolean): AdminUser {
  return {
    ...toPublic(r),
    email: r.email,
    role: r.role as UserRole,
    discoverable: !!r.discoverable,
    banned: !!r.banned,
    bannedReason: r.banned_reason,
    bannedAt: r.banned_at,
    live,
  };
}

function toSettings(r: UserRow): UserSettings {
  return {
    defaultAccess: r.default_access as UserSettings["defaultAccess"],
    defaultTitle: r.default_title,
    discoverable: !!r.discoverable,
  };
}

export const usersRepo = {
  getRaw(usernameLc: string): UserRow | undefined {
    return db
      .prepare(`SELECT * FROM users WHERE username_lc = ?`)
      .get(usernameLc) as UserRow | undefined;
  },

  getPublic(usernameLc: string): PublicUser | null {
    const r = this.getRaw(usernameLc);
    return r ? toPublic(r) : null;
  },

  getSelf(
    usernameLc: string,
  ): { user: SelfUser; settings: UserSettings } | null {
    const r = this.getRaw(usernameLc);
    return r ? { user: toSelf(r), settings: toSettings(r) } : null;
  },

  emailExists(emailLc: string): boolean {
    return !!db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(emailLc);
  },

  create(u: NewUser): SelfUser {
    const now = Date.now();
    db.prepare(
      `INSERT INTO users
        (username_lc, username, email, display_name, about, avatar_url,
         password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      u.username.toLowerCase(),
      u.username,
      u.email.toLowerCase(),
      u.displayName,
      u.about,
      u.passwordHash,
      now,
      now,
    );
    return toSelf(this.getRaw(u.username.toLowerCase())!);
  },

  updateProfile(
    usernameLc: string,
    patch: {
      displayName?: string;
      about?: string | null;
      avatarUrl?: string | null;
    },
  ): SelfUser {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.displayName !== undefined) {
      sets.push("display_name = ?");
      vals.push(patch.displayName);
    }
    if (patch.about !== undefined) {
      sets.push("about = ?");
      vals.push(patch.about);
    }
    if (patch.avatarUrl !== undefined) {
      sets.push("avatar_url = ?");
      vals.push(patch.avatarUrl);
    }
    sets.push("updated_at = ?");
    vals.push(Date.now());
    vals.push(usernameLc);
    db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE username_lc = ?`).run(
      ...vals,
    );
    return toSelf(this.getRaw(usernameLc)!);
  },

  updateSettings(usernameLc: string, s: Partial<UserSettings>): UserSettings {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (s.defaultAccess !== undefined) {
      sets.push("default_access = ?");
      vals.push(s.defaultAccess);
    }
    if (s.defaultTitle !== undefined) {
      sets.push("default_title = ?");
      vals.push(s.defaultTitle);
    }
    if (s.discoverable !== undefined) {
      sets.push("discoverable = ?");
      vals.push(s.discoverable ? 1 : 0);
    }
    if (sets.length) {
      vals.push(usernameLc);
      db.prepare(
        `UPDATE users SET ${sets.join(", ")} WHERE username_lc = ?`,
      ).run(...vals);
    }
    return toSettings(this.getRaw(usernameLc)!);
  },

  setPassword(usernameLc: string, passwordHash: string): void {
    db.prepare(
      `UPDATE users SET password_hash = ?, updated_at = ? WHERE username_lc = ?`,
    ).run(passwordHash, Date.now(), usernameLc);
  },

  markEmailVerified(usernameLc: string): void {
    db.prepare(
      `UPDATE users SET email_verified = 1, updated_at = ? WHERE username_lc = ?`,
    ).run(Date.now(), usernameLc);
  },

  /**
   * Apply a verified email change: swap the address and mark it confirmed.
   * The old address is freed for reuse only after the new one is active.
   */
  setEmail(usernameLc: string, newEmail: string): void {
    db.prepare(
      `UPDATE users SET email = ?, email_verified = 1, updated_at = ?
       WHERE username_lc = ?`,
    ).run(newEmail, Date.now(), usernameLc);
  },

  findByEmail(emailLc: string): UserRow | undefined {
    return db.prepare(`SELECT * FROM users WHERE email = ?`).get(emailLc) as
      UserRow | undefined;
  },

  search(query: string, limit = 20): PublicUser[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    const rows = db
      .prepare(
        `SELECT * FROM users
         WHERE discoverable = 1 AND banned = 0
           AND (username LIKE ? OR display_name LIKE ?)
         ORDER BY display_name LIMIT ?`,
      )
      .all(like, like, limit) as UserRow[];
    return rows.map(toPublic);
  },

  // ─── Moderation ─────────────────────────────────────────────────────

  isBanned(usernameLc: string): boolean {
    const r = this.getRaw(usernameLc);
    return !!r && !!r.banned;
  },

  role(usernameLc: string): UserRole | null {
    const r = this.getRaw(usernameLc);
    return r ? (r.role as UserRole) : null;
  },

  setRole(usernameLc: string, role: UserRole): void {
    db.prepare(
      `UPDATE users SET role = ?, updated_at = ? WHERE username_lc = ?`,
    ).run(role, Date.now(), usernameLc);
  },

  ban(usernameLc: string, reason: string | null): void {
    db.prepare(
      `UPDATE users SET banned = 1, banned_reason = ?, banned_at = ?, updated_at = ?
       WHERE username_lc = ?`,
    ).run(reason, Date.now(), Date.now(), usernameLc);
  },

  unban(usernameLc: string): void {
    db.prepare(
      `UPDATE users SET banned = 0, banned_reason = NULL, banned_at = NULL, updated_at = ?
       WHERE username_lc = ?`,
    ).run(Date.now(), usernameLc);
  },

  /**
   * Permanently delete a user account and all owned data.
   * SQLite FK cascades handle broadcasts and refresh_tokens automatically.
   * We explicitly purge tickets and email tokens that reference the user.
   */
  delete(usernameLc: string): void {
    db.transaction(() => {
      db.prepare(`DELETE FROM tickets       WHERE username_lc = ?`).run(
        usernameLc,
      );
      db.prepare(
        `DELETE FROM reports       WHERE reporter_username = ? OR target_username = ?`,
      ).run(usernameLc, usernameLc);
      db.prepare(`DELETE FROM email_verifications WHERE username_lc = ?`).run(
        usernameLc,
      );
      db.prepare(`DELETE FROM password_resets     WHERE username_lc = ?`).run(
        usernameLc,
      );
      db.prepare(`DELETE FROM email_changes       WHERE username_lc = ?`).run(
        usernameLc,
      );
      db.prepare(`DELETE FROM invites              WHERE created_by = ?`).run(
        usernameLc,
      );
      // This also cascades to broadcasts and refresh_tokens via FK.
      db.prepare(`DELETE FROM users WHERE username_lc = ?`).run(usernameLc);
    })();
  },

  /** Admin directory: newest first, optional text filter, includes banned. */
  listForAdmin(
    query: string,
    isLive: (usernameLc: string) => boolean,
    limit = 100,
  ): AdminUser[] {
    let rows: UserRow[];
    if (query.trim()) {
      const like = `%${query.replace(/[%_]/g, "")}%`;
      rows = db
        .prepare(
          `SELECT * FROM users
           WHERE username LIKE ? OR display_name LIKE ? OR email LIKE ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(like, like, like, limit) as UserRow[];
    } else {
      rows = db
        .prepare(`SELECT * FROM users ORDER BY created_at DESC LIMIT ?`)
        .all(limit) as UserRow[];
    }
    return rows.map((r) => toAdmin(r, isLive(r.username_lc)));
  },

  getAdmin(usernameLc: string, live: boolean): AdminUser | null {
    const r = this.getRaw(usernameLc);
    return r ? toAdmin(r, live) : null;
  },
};
