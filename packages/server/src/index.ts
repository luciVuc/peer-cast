import express from "express";
import { createServer } from "node:http";
import { configureApp } from "./app.js";
import { config } from "./config.js";
import { purgeExpired } from "./lib/auth.js";
import { shutdownRedis } from "./lib/redis.js";
import { broadcastsRepo } from "./repos/broadcasts.js";

const app = express();
const httpServer = createServer(app);

configureApp(app, { httpServer });

// ─── Housekeeping ──────────────────────────────────────────────────────
function housekeeping(): void {
  purgeExpired();
  // Force-end broadcasts whose host went silent (closed tab, crash, lost
  // network) so they don't ghost the dashboard / discovery.
  const ended = broadcastsRepo.endStale(config.staleLiveMs);
  if (ended > 0) {
    console.log(`[server] force-ended ${ended} stale live broadcast(s)`);
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
    void shutdownRedis().finally(() => process.exit(0));
  });
}

httpServer.listen(config.port, config.host, () => {
  console.log(
    `[server] PeerCast listening on http://${config.host}:${config.port}`,
  );
  console.log(
    `[server] signaling at ${config.signal.secure ? "wss" : "ws"}://${config.signal.host}:${config.signal.port}${config.signal.path} (key: ${config.signal.key})`,
  );
});
