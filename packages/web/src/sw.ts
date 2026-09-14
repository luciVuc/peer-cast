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

self.addEventListener("notificationclick", (event) => {
  const target = (event.notification.data as { url?: string } | undefined)?.url;
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
          if (target) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(
        target ? new URL(target, self.location.origin).toString() : "/",
      );
    })(),
  );
});
