import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { makeApp } from "./helpers.js";
import { config } from "../src/config.js";

/**
 * The bitrate policy is delivered to clients through GET /api/config, which is
 * unauthenticated by necessity. What matters is not secrecy (there is none — it
 * is a tuning hint) but ABSENCE: an operator who has configured nothing must
 * get no policy at all, because the client reads a missing policy as "apply no
 * caps". A default policy leaking into the response would silently reshape
 * every broadcast on the instance for operators who never opted in.
 */
describe("bitrate shaping config", () => {
  const original = config.bitrate;
  afterEach(() => {
    (config as { bitrate: unknown }).bitrate = original;
  });

  it("omits the policy entirely when the operator configured none", async () => {
    (config as { bitrate: unknown }).bitrate = undefined;
    const res = await request(makeApp()).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body.bitrate).toBeUndefined();
  });

  it("serves the configured policy to clients", async () => {
    (config as { bitrate: unknown }).bitrate = {
      budgetKbps: 6000,
      safetyFactor: 0.8,
      tiersKbps: [2500, 1200, 600, 300],
      ratchetSamples: 3,
    };
    const res = await request(makeApp()).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body.bitrate).toEqual({
      budgetKbps: 6000,
      safetyFactor: 0.8,
      tiersKbps: [2500, 1200, 600, 300],
      ratchetSamples: 3,
    });
  });

  it("never advertises a zero or negative budget to clients", async () => {
    // parseBitrate() rejects these at boot; this guards the route against a
    // hand-edited or future config path letting a 0 kbps policy reach a client,
    // where it would look like a broken broadcast rather than a misconfig.
    for (const bad of [
      { budgetKbps: 0, safetyFactor: 0.8, tiersKbps: [1000] },
      { budgetKbps: -1, safetyFactor: 0.8, tiersKbps: [1000] },
    ]) {
      (config as { bitrate: unknown }).bitrate = bad;
      const res = await request(makeApp()).get("/api/config");
      expect(res.body.bitrate).toBeUndefined();
    }
  });
});
