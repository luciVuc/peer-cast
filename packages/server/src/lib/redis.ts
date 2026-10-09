import { Redis } from "ioredis";
import { config } from "../config.js";

/**
 * Optional shared Redis client (ioredis). Enabled only when REDIS_URL is set.
 *
 * Used for:
 *   • Rate limiting (express-rate-limit RedisStore) — shared accross instances.
 *   • Signaling tickets (opaque, short-lived WS-auth tokens) — so any instance
 *     behind a load balancer can validate a ticket minted on another instance.
 *
 * When REDIS_URL is unset both features fall back to their in-process stores,
 * which is correct (and simpler) for single-process deployments.
 */
let client: Redis | null = null;
/** Throttle repeated connection-error logging to once a minute. */
let lastRedisLog = 0;

export function getRedis(): Redis | null {
  if (!config.redis.url) return null;
  if (!client) {
    client = new Redis(config.redis.url, {
      // Fail fast. `maxRetriesPerRequest: null` disables the client-side
      // command timeout entirely, which inverts the stated intent of failing
      // closed: during a Redis outage every command queues indefinitely
      // instead of erroring, and since all 13 rate-limit stores share this one
      // client, a Redis blip stalls the entire API rather than degrading.
      // 1 retry + bounded timeouts means a command errors quickly and the
      // limiter falls back to its in-memory store instead of hanging sockets.
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      commandTimeout: 1000,
      enableOfflineQueue: false,
    });
    client.on("error", (err: Error) => {
      // ioredis retries in a loop; an unreachable host would otherwise
      // flood the log with one line per retry tick.
      const now = Date.now();
      if (now - lastRedisLog > 60_000) {
        lastRedisLog = now;
        console.error(`[redis] ${err.message}`);
      }
    });
    if (config.nodeEnv !== "production") {
      client.on("connect", () => console.log("[redis] connected"));
      client.on("close", () => console.warn("[redis] connection closed"));
    }
  }
  return client;
}

export async function shutdownRedis(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  await c.quit().catch(() => {
    c.disconnect();
  });
}
