import webpush from "web-push";
import { config } from "../config.js";
import {
  removeSubscription,
  subscriptionsForFollowers,
} from "../repos/notifications.js";

const PUSH_SERVICE_SUFFIXES = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
];

/** Accept only browser push-service origins, never arbitrary server URLs. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      config.nodeEnv === "test" &&
      (hostname === "push.example" || hostname.endsWith(".example"))
    )
      return true;
    return PUSH_SERVICE_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

/**
 * Web Push (RFC 8030 / VAPID). Server-side this is fire-and-forget: it must
 * never hold up the HTTP response that triggered a notification. The server
 * itself never sees message *content* for media/chat — this only carries a
 * terse "user X went live" alert to opted-in followers.
 *
 * Notifications are disabled unless the operator configured a VAPID keypair
 * (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY). The web app learns this via
 * GET /api/push/vapid-key and only then offers the "Enable notifications"
 * toggle in Settings.
 */

const { publicKey, privateKey, subject } = config.vapid;
const enabled = config.vapid.enabled();

if (enabled) {
  webpush.setVapidDetails(subject, publicKey as string, privateKey as string);
}

/** Public VAPID key clients need to call pushManager.subscribe(). */
export function getVapidPublicKey(): string | null {
  return enabled ? publicKey : null;
}

export function vapidEnabled(): boolean {
  return enabled;
}

/**
 * Notify every follower who has an active push subscription that the
 * broadcaster went live. Best-effort: expired/absent endpoints are pruned
 * (410 Gone from the push service) and every other failure is ignored.
 */
export async function notifyFollowersLive(followedLc: string): Promise<void> {
  if (!enabled) return;
  let broadcaster = followedLc;
  try {
    const { usersRepo } = await import("../repos/users.js");
    broadcaster = usersRepo.getRaw(followedLc)?.username ?? followedLc;
  } catch {
    /* keep the handle */
  }
  const data = JSON.stringify({
    title: `${config.appName} — ${broadcaster} is live`,
    body: `${broadcaster} just started a broadcast. Come watch!`,
    url: `/watch/${followedLc}`,
  });
  const subs = subscriptionsForFollowers(followedLc);
  await Promise.allSettled(
    subs.map((s) =>
      webpush
        .sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          data,
        )
        .catch(async (err: Error & { statusCode?: number }) => {
          // The push service says the endpoint is dead — prune it so we don't
          // hammer the push service on every future broadcast.
          if (err.statusCode === 404 || err.statusCode === 410) {
            removeSubscription(s.endpoint);
          }
          return undefined;
        }),
    ),
  );
}
