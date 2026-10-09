import express from "express";
import { createServer } from "node:http";
import { configureApp } from "./app.js";
import { config } from "./config.js";
import { purgeExpired } from "./lib/auth.js";
import { shutdownRedis } from "./lib/redis.js";
import { broadcastsRepo } from "./repos/broadcasts.js";
import { emailTokensRepo } from "./repos/emailTokens.js";
import { migrateAvatars } from "./db/index.js";
import { db } from "./db/index.js";
import * as recordingsRepo from "./repos/recordings.js";

const app = express();
const httpServer = createServer(app);

configureApp(app, { httpServer });

// ─── Housekeeping ──────────────────────────────────────────────────────
function housekeeping(): void {
  purgeExpired();
  // Verification / reset / email-change tokens are bearer credentials. Nothing
  // consumes them past their TTL, so drop them on the same cadence as the auth
  // tables rather than letting them accumulate indefinitely.
  emailTokensRepo.purgeExpired();
  // Force-end broadcasts whose host went silent (closed tab, crash, lost
  // network) so they don't ghost the dashboard / discovery.
  const ended = broadcastsRepo.endStale(config.staleLiveMs);
  if (ended > 0) {
    console.log(`[server] force-ended ${ended} stale live broadcast(s)`);
  }
  // Reclaim recordings abandoned mid-upload. A crashed host leaves a row stuck
  // at status='recording' that nothing else ever transitions, holding the
  // owner's per-user byte quota indefinitely.
  const reaped = recordingsRepo.reapOrphaned(
    config.retention.orphanRecordingHours * 3600_000,
  );
  if (reaped > 0) {
    console.log(`[server] reaped ${reaped} orphaned recording(s)`);
  }
  // Optional retention for ended broadcasts. Off unless
  // RETENTION_BROADCAST_DAYS is set — deleting history is an operator policy
  // decision, not something to do silently.
  const purged = broadcastsRepo.purgeEndedOlderThan(
    config.retention.broadcastDays,
  );
  if (purged > 0) {
    console.log(`[server] purged ${purged} ended broadcast(s) past retention`);
  }
}
setInterval(housekeeping, 5 * 60 * 1000).unref();
housekeeping();

httpServer.on("error", (err) => {
  console.error("[server] http server error:", err);
  process.exit(1);
});

// Close the shared Redis client (if enabled) on shutdown so it drains cleanly.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdownRedis()
      .catch(() => {})
      .finally(() => {
        // Flush WAL before exiting. Without this an unflushed checkpoint is
        // lost, and the next boot replays from an older snapshot.
        try {
          db.close();
        } catch {
          /* already closed */
        }
        process.exit(0);
      });
  });
}

httpServer.listen(config.port, config.host, () => {
  console.log(
    `[server] PeerCast listening on http://${config.host}:${config.port}`,
  );
  console.log(
    `[server] signaling at ${config.signal.secure ? "wss" : "ws"}://${config.signal.host}:${config.signal.port}${config.signal.path} (key: ${config.signal.key})`,
  );
  // trust proxy drives every IP-keyed rate limiter's key. Getting it wrong is
  // either "every visitor shares one bucket" (too low) or "attackers spoof
  // their own X-Forwarded-For and bypass limits" (too high), and neither fails
  // loudly, so say it explicitly at boot.
  if (config.trustProxyHops === 0) {
    console.log(
      "[server] TRUST_PROXY_HOPS=0 (no proxy trusted). If TLS terminates at a " +
        "reverse proxy, set TRUST_PROXY_HOPS to your hop count — otherwise all " +
        "visitors share a single rate-limit bucket.",
    );
  } else {
    console.log(
      `[server] trusting ${config.trustProxyHops} reverse-proxy hop(s) for req.ip`,
    );
  }
  if (
    config.isProd &&
    !process.env.APP_URL &&
    config.appUrl.startsWith("http://localhost")
  ) {
    console.warn(
      "[config] WARNING: APP_URL is unset, so verification and password-reset " +
        "emails will contain dead localhost links. Set APP_URL to the public " +
        "origin of this instance.",
    );
  }
  // Run one-time data migrations after the server is ready.
  migrateAvatars();
});
