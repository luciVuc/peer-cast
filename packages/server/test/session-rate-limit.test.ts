import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import { makeApp, resetDb, validUser } from "./helpers.js";
import { configureApp } from "../src/app.js";

/**
 * Rate-limit guards on /api/sessions.
 *
 * Regression: viewers were getting `429 RATE_LIMITED` on
 * `GET /api/sessions/:username` during normal viewing. Two independent causes,
 * both rooted in the endpoint being treated like a hostile one:
 *
 *   1. The resolve limiter was keyed per IP at 120/15 min, so every viewer
 *      behind one NAT shared a single budget and locked out the whole egress IP.
 *   2. `verify-ticket` shared that budget even though its volume tracks the
 *      HOST's audience, not one client's rate.
 *   3. The code-attempt limiter counted every non-2xx — including 404 "host is
 *      offline" — against a 5/15 min bucket, so reconnecting to an ended
 *      broadcast locked a viewer out of a public stream that never had a gate.
 */

async function token(a: Express) {
  const res = await request(a).post("/api/auth/register").send(validUser);
  return res.body.accessToken as string;
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** App with rate limiting ON, for exercising the limiters. */
function limitedApp() {
  return configureApp(express(), { rateLimiting: true, quiet: true });
}

async function goLive(
  a: Express,
  t: string,
  peerId: string,
  access = "public",
): Promise<string> {
  const res = await request(a)
    .post("/api/broadcasts")
    .set(auth(t))
    .send({
      title: "Live",
      access,
      source: "tab",
      peerId,
      ...(access === "code" ? { accessCode: "open42" } : {}),
    });
  return res.body.broadcast.id as string;
}

beforeEach(() => resetDb());

describe("session rate limits", () => {
  it("serves far more resolves than the old 120/15min budget", async () => {
    // The reported failure: a viewer page re-resolving during a host restart.
    // ViewerPage's bounded backoff polls ~13 times per outage, and a busy
    // instance has many viewers behind one IP.
    const a = limitedApp();
    const t = await token(a);
    await goLive(a, t, "peer-1");

    for (let i = 0; i < 300; i++) {
      const r = await request(a).get("/api/sessions/alice");
      expect(r.status).toBe(200);
    }
  });

  it("does not share the anonymous IP budget with authenticated viewers", async () => {
    // The NAT case, stated so it cannot pass by accident: exhaust the anonymous
    // per-IP bucket, then show an authenticated viewer behind the SAME IP is
    // still served. This fails if the resolve limiter falls back to IP keying.
    const a = limitedApp();
    const host = await token(a);
    await goLive(a, host, "peer-1");

    const v1 = await request(a)
      .post("/api/auth/register")
      .send({ ...validUser, username: "bob", email: "bob@example.com" });
    const v2 = await request(a)
      .post("/api/auth/register")
      .send({ ...validUser, username: "carol", email: "carol@example.com" });
    const t1 = v1.body.accessToken as string;
    const t2 = v2.body.accessToken as string;

    // Exhaust the anonymous/IP bucket (limit is 600).
    let sawThrottle = false;
    for (let i = 0; i < 700; i++) {
      const r = await request(a).get("/api/sessions/alice");
      if (r.status === 429) sawThrottle = true;
    }
    expect(sawThrottle).toBe(true); // the anonymous bucket really is spent

    // Authenticated viewers share that IP but must have their own budgets.
    for (let i = 0; i < 100; i++) {
      const r = await request(a).get("/api/sessions/alice").set(auth(t1));
      expect(r.status).toBe(200);
    }
    const alsoFine = await request(a).get("/api/sessions/alice").set(auth(t2));
    expect(alsoFine.status).toBe(200);

    // And the anonymous bucket is still spent — the two are truly separate.
    const anon = await request(a).get("/api/sessions/alice");
    expect(anon.status).toBe(429);
  });

  it("does not let a host's ticket verification exhaust its viewers' budget", async () => {
    const a = limitedApp();
    const host = await token(a);
    await goLive(a, host, "peer-1", "authenticated");

    // The host verifies a ticket for every incoming call, so a popular stream
    // generates verify-ticket traffic from the host's own bucket.
    for (let i = 0; i < 200; i++) {
      const r = await request(a)
        .post("/api/sessions/verify-ticket")
        .send({ ticket: "nope", peerId: "peer-1" });
      expect(r.status).not.toBe(429);
    }

    // ...and the host's own session resolves still work.
    const resolve = await request(a).get("/api/sessions/alice").set(auth(host));
    expect(resolve.status).toBe(200);
  });

  it("does not count offline (404) resolves as failed code attempts", async () => {
    // The tight one: 5/15 min. A viewer reconnecting to an ENDED broadcast
    // used to burn this budget on 404s and then get 429 on a public stream.
    const a = limitedApp();
    const t = await token(a);
    const id = await goLive(a, t, "peer-1");
    await request(a).post(`/api/broadcasts/${id}/end`).set(auth(t));

    for (let i = 0; i < 20; i++) {
      const r = await request(a).get("/api/sessions/alice");
      expect(r.status).toBe(404); // never throttled, never "code attempt"
    }
  });

  it("still blocks brute-forced access codes", async () => {
    // The limit that actually matters must NOT be loosened by the above.
    const a = limitedApp();
    const t = await token(a);
    await goLive(a, t, "peer-1", "code");

    // A correct code is never penalised on its own.
    const first = await request(a).get("/api/sessions/alice?code=open42");
    expect(first.status).toBe(200);
    expect(first.body.peerId).toBe("peer-1");

    // Five wrong guesses are answered normally (so the client can retry) but
    // counted; the sixth trips the limiter.
    for (let i = 0; i < 5; i++) {
      const r = await request(a).get("/api/sessions/alice?code=wrong");
      expect(r.status).toBe(403);
    }
    const blocked = await request(a).get("/api/sessions/alice?code=wrong");
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("RATE_LIMITED");

    // Exhausting the budget locks the bucket, correct code included — the
    // limiter short-circuits before the code is ever evaluated.
    const alsoBlocked = await request(a).get("/api/sessions/alice?code=open42");
    expect(alsoBlocked.status).toBe(429);
  });
});

describe("session access gates (limiting off)", () => {
  const app = makeApp();

  it("still gates a members-only broadcast and resolves a public one", async () => {
    const t = await token(app);
    await request(app).post("/api/broadcasts").set(auth(t)).send({
      title: "Members",
      access: "authenticated",
      source: "tab",
      peerId: "p1",
    });

    const anon = await request(app).get("/api/sessions/alice");
    expect(anon.status).toBe(401);
    expect(anon.body.peerId).toBeNull();

    const member = await request(app).get("/api/sessions/alice").set(auth(t));
    expect(member.status).toBe(200);
    expect(member.body.peerId).toBe("p1");
  });
});
