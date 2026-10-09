/**
 * Regression guard: password hashing must not block the event loop.
 *
 * The defect: bcryptjs is a pure-JS implementation, so its "async" API still
 * computes synchronously — `await bcryptjs.compare(...)` monopolises the event
 * loop for the length of the hash. Measured at cost 12 on this machine:
 *
 *   bcryptjs.compare()  ~265 ms wall, 101 ms event-loop stall
 *   bcrypt.compare()    ~265 ms wall,   1 ms event-loop stall (threadpool)
 *
 * Wall-clock is a wash, so the point is not speed: at cost 12 the JS version
 * stalls every concurrent request (signaling tickets, stats heartbeats, viewer
 * resolves) behind each login, and concurrent logins serialise.
 *
 * This test asserts the property rather than a timing threshold, which would be
 * flaky on shared CI: it samples the event loop with setImmediate while
 * verifies run, and requires it to stay responsive.
 */
import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  DUMMY_PASSWORD_HASH,
} from "../src/lib/auth.js";

/** Run `work` while sampling how long the loop is unavailable. */
async function measureEventLoopStall(
  work: () => Promise<unknown>,
): Promise<number> {
  let maxGapMs = 0;
  let last = process.hrtime.bigint();
  let running = true;

  const sample = () => {
    const now = process.hrtime.bigint();
    const gapMs = Number(now - last) / 1e6;
    if (gapMs > maxGapMs) maxGapMs = gapMs;
    last = now;
    if (running) setImmediate(sample);
  };
  setImmediate(sample);

  await work();
  running = false;
  // Let the final sample land.
  await new Promise((r) => setTimeout(r, 20));
  return maxGapMs;
}

describe("password hashing does not block the event loop", () => {
  it("keeps the loop responsive across concurrent verifies", async () => {
    const hash = await hashPassword("secret123");

    // Sanity: the hash is usable and correctly rejecting.
    expect(await verifyPassword("secret123", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);

    // Concurrent work, the way a burst of logins arrives.
    const stall = await measureEventLoopStall(async () => {
      await Promise.all([
        verifyPassword("a", hash),
        verifyPassword("b", hash),
        verifyPassword("c", hash),
        verifyPassword("d", hash),
      ]);
    });

    // A bcryptjs build stalls for ~100 ms per compare and would blow straight
    // through this. The bound is loose enough to survive a loaded CI box while
    // still being an order of magnitude below the observed defect.
    expect(stall).toBeLessThan(50);
  }, 60_000);

  it("still provides a real dummy hash for constant-time login", async () => {
    // Must be a genuine cost-12 digest, or the timing-equalising compare in
    // routes/auth.ts stops working and usernames become enumerable again.
    expect(DUMMY_PASSWORD_HASH).toMatch(/^\$2[aby]\$12\$/);
    expect(DUMMY_PASSWORD_HASH).not.toContain("secret123");
    expect(await verifyPassword("secret123", DUMMY_PASSWORD_HASH)).toBe(false);
  }, 60_000);
});
