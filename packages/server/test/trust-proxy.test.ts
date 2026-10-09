/**
 * Regression guard: TRUST_PROXY_HOPS is wired to `app.set("trust proxy")`.
 *
 * The defect: `trust proxy` was derived from NODE_ENV, so a directly-exposed
 * instance trusted exactly one hop and any client could set its own
 * X-Forwarded-For — which is the key every IP-rate-limited endpoint uses. That
 * made login, register, search and access-code guessing trivially bypassable.
 *
 * Why this needs its own file: config.ts reads the environment at module load,
 * so a test cannot flip TRUST_PROXY_HOPS and re-import app.js in the same
 * process that already loaded it with the defaults. Each direction therefore
 * gets a fresh module registry via vi.resetModules(), with the env set before
 * the import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

const ORIGINAL = process.env.TRUST_PROXY_HOPS;

/** Boot a fresh app with TRUST_PROXY_HOPS set, and report whether the
 *  express-rate-limit key for a request changes when XFF is spoofed. */
async function probe(trustProxyHops: string | undefined) {
  vi.resetModules();
  if (trustProxyHops === undefined) delete process.env.TRUST_PROXY_HOPS;
  else process.env.TRUST_PROXY_HOPS = trustProxyHops;

  const [{ configureApp }] = await Promise.all([
    import("../src/app.js"),
    import("../src/config.js"),
  ]);
  const { db } = await import("../src/db/index.js");
  db.exec("DELETE FROM users; DELETE FROM broadcasts;");

  const app = configureApp(express(), { rateLimiting: true, quiet: true });

  // Register a host with a code-gated stream so /api/sessions/:u?code= is a
  // 403 for a wrong code (which the code-guess limiter counts).
  const reg = await request(app)
    .post("/api/auth/register")
    .send({
      username: "alice",
      email: "alice@example.com",
      displayName: "Alice",
      password: "secret123",
    })
    .expect(201);
  await request(app)
    .post("/api/broadcasts")
    .set("Authorization", `Bearer ${reg.body.accessToken}`)
    .send({
      title: "Secret",
      access: "code",
      source: "screen",
      peerId: "peer-x",
      accessCode: "open42",
    })
    .expect(201);

  // 12 wrong-code attempts, each claiming a different source address.
  let limited = 0;
  for (let i = 0; i < 12; i++) {
    const res = await request(app)
      .get("/api/sessions/alice?code=guess123")
      .set("X-Forwarded-For", `10.0.0.${i + 1}`);
    if (res.status === 429) limited++;
  }
  return limited;
}

describe("TRUST_PROXY_HOPS", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = ORIGINAL;
    vi.resetModules();
  });

  it("defaults to trusting nothing, so spoofed XFF cannot rotate the bucket", async () => {
    const limited = await probe(undefined);
    // Every request lands in one bucket → the 5/15min per-(IP,user) limit
    // trips well inside 12 attempts.
    expect(limited).toBeGreaterThan(0);
  }, 60_000);

  it("trusts a configured hop count, so a real proxy's XFF is honoured", async () => {
    const limited = await probe("1");
    // With one trusted hop each spoofed XFF is a distinct limiter key, so the
    // per-IP bucket never fills. This is exactly why operators behind a proxy
    // MUST set this: it is the mechanism the rate limiter depends on, and
    // proof that the variable is actually wired to `app.set("trust proxy")`.
    expect(limited).toBe(0);
  }, 60_000);
});
