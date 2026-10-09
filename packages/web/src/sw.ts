/// <reference lib="webworker" />
/* eslint-disable @typescript-eslint/no-explicit-any */

import { clientsClaim } from "workbox-core";
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null } | string>;
};

self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);

// SPA fallback: serve the app shell for any navigation that isn't an API or
// signaling request (those go to the network and out of the worker's scope).
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api/, /^\/peerjs/],
  }),
);

// ─── Push notifications ────────────────────────────────────────────────────
// Payload arrives as JSON from the server: { title, body, url }.

self.addEventListener("push", (event) => {
  let data: Partial<{ title: string; body: string; url: string }> = {};
  try {
    data = event.data ? (event.data.json() as typeof data) : {};
  } catch {
    /* payload not JSON — show a generic alert */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "PeerCast", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

/**
 * Constrain a push-supplied URL to this origin.
 *
 * `data.url` originates from the push payload, i.e. the server. Resolving it
 * with `new URL(target, origin)` alone is not enough: a protocol-relative
 * "//evil.tld/x" resolves cross-origin, and `client.navigate()` /
 * `openWindow()` would then point a focused tab or a brand-new window at
 * attacker-controlled content. Cheap to check, and the notification surface is
 * exactly the kind of thing that gets abused once a server is compromised.
 */
function sameOriginPath(raw: string | undefined): string {
  if (!raw) return "/";
  try {
    const u = new URL(raw, self.location.origin);
    if (u.origin !== self.location.origin) return "/";
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}

self.addEventListener("notificationclick", (event) => {
  const target = sameOriginPath(
    (event.notification.data as { url?: string } | undefined)?.url,
  );
  event.notification.close();
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const w of wins) {
        // Focus + navigate an existing tab when possible; otherwise open one.
        if ("focus" in w) {
          const client = w as WindowClient;
          await client.focus();
          await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
