import { db } from "../db/index.js";

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// ─── Follows ─────────────────────────────────────────────────────────────
// A follow is a (follower, followed) pair. Follows power the "followed user
// goes live" push notifications; PRAGMA foreign_keys + ON DELETE CASCADE keep
// the graph tidy when an account is deleted.

export function follow(followerLc: string, followedLc: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO follows (follower_username_lc, followed_username_lc, created_at)
     VALUES (?, ?, ?)`,
  ).run(followerLc, followedLc, Date.now());
}

export function unfollow(followerLc: string, followedLc: string): void {
  db.prepare(
    `DELETE FROM follows
     WHERE follower_username_lc = ? AND followed_username_lc = ?`,
  ).run(followerLc, followedLc);
}

export function isFollowing(followerLc: string, followedLc: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM follows
       WHERE follower_username_lc = ? AND followed_username_lc = ?`,
    )
    .get(followerLc, followedLc);
  return !!row;
}

// ─── Push subscriptions ──────────────────────────────────────────────────

/** True when `endpoint` is already registered to a *different* account. */
export function isEndpointOwnedByOther(
  endpoint: string,
  usernameLc: string,
): boolean {
  const row = db
    .prepare(`SELECT username_lc FROM push_subscriptions WHERE endpoint = ?`)
    .get(endpoint) as { username_lc: string } | undefined;
  return !!row && row.username_lc !== usernameLc;
}

/** Upsert a Web Push subscription for a user (one per browser endpoint).
 *
 *  The upsert keeps a *same-owner* rotation working: a user switching browsers
 *  re-registers the same endpoint with fresh keys and must keep receiving
 *  their own notifications.
 *
 *  Cross-account reassignment is refused by the caller (see isEndpointOwnedByOther).
 *  Reassigning on conflict was previously done unconditionally, which is safe
 *  for the intended same-user case but a takeover in every other one: push
 *  endpoints appear in browser storage and in push-service URLs, so anyone who
 *  learns one could re-register it under their own account and start receiving
 *  that account's go-live notifications.
 */
export function saveSubscription(
  usernameLc: string,
  sub: PushSubscriptionRow,
): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, username_lc, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth
     WHERE push_subscriptions.username_lc = excluded.username_lc`,
  ).run(sub.endpoint, usernameLc, sub.p256dh, sub.auth, Date.now());
}

/** Remove a subscription regardless of owner. Used internally by the push
 *  daemon to prune endpoints the push service reports as dead (404/410). */
export function removeSubscription(endpoint: string): void {
  db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

/** Remove a subscription only when it belongs to the given user — the
 *  user-facing unsubscribe endpoint must not let one account delete another's. */
export function removeOwnedSubscription(
  endpoint: string,
  usernameLc: string,
): void {
  db.prepare(
    `DELETE FROM push_subscriptions WHERE endpoint = ? AND username_lc = ?`,
  ).run(endpoint, usernameLc);
}

/** All subscriptions owned by users who follow the given broadcaster. */
export function subscriptionsForFollowers(
  followedLc: string,
): PushSubscriptionRow[] {
  return db
    .prepare(
      `SELECT ps.endpoint, ps.p256dh, ps.auth
       FROM push_subscriptions ps
       JOIN follows f
         ON f.follower_username_lc = ps.username_lc
        AND f.followed_username_lc = ?
       ORDER BY ps.created_at`,
    )
    .all(followedLc) as PushSubscriptionRow[];
}

export default {
  follow,
  unfollow,
  isFollowing,
  saveSubscription,
  isEndpointOwnedByOther,
  removeSubscription,
  removeOwnedSubscription,
  subscriptionsForFollowers,
};
