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

export function getRedis(): Redis | null {
  if (!config.redis.url) return null;
  if (!client) {
    client = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    client.on("error", (err: Error) => {
      console.error(`[redis] ${err.message}`);
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
