import type { PushSubscriptionData } from "@peer-cast/shared";

/**
 * Web Push helpers (client side). The actual subscription is stored on the
 * server via POST /api/push/subscribe so go-live alerts can reach this device.
 */

/** Convert a base64url VAPID public key into a Uint8Array for
 * `pushManager.subscribe({ applicationServerKey })`. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Url = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Url);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Whether the browser + current context can do push at all. */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

/**
 * Ensure a push subscription exists for this device/app and return it.
 * Returns null when the user denied permission (or push is unavailable).
 */
export async function ensurePushSubscription(
  vapidPublicKey: string,
): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
}

/** Current subscription (or null). Does not prompt. */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Unsubscribe this device from all push. Returns true when fully removed. */
export async function destroyPushSubscription(): Promise<boolean> {
  if (!pushSupported()) return true;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return true;
  return sub.unsubscribe();
}

/** Convert a browser PushSubscription into the wire shape the API expects. */
export function subscriptionToData(
  sub: PushSubscription,
): PushSubscriptionData {
  const key = (k: "p256dh" | "auth") =>
    sub.getKey(k)
      ? btoa(String.fromCharCode(...new Uint8Array(sub.getKey(k)!)))
      : "";
  return {
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime ?? null,
    keys: { p256dh: key("p256dh"), auth: key("auth") },
  };
}
