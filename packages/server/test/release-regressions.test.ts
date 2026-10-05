/**
 * Release regression guards for two bugs found in the pre-release audit.
 * (The registration-email crash has its own file: email-unhandled.test.ts —
 * it needs a plain-function module mock, because Vitest's `vi.fn` wrapper
 * attaches a handler that swallows the very rejection under test.)
 *
 *   1. `app.use("/api/recordings", ...)` is a prefix mount, so the 20/hour
 *      "create" limiter also swallowed PUT /api/recordings/:id/chunk. MediaRecorder
 *      emits a chunk every few seconds, so a recording silently lost its tail.
 *   2. Login short-circuited `!!user && await verifyPassword(...)`, skipping
 *      bcrypt entirely for an unknown username — a sub-millisecond response
 *      against a ~300 ms real compare enumerates accounts remotely.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import { makeApp, resetDb } from "./helpers.js";
import { configureApp } from "../src/app.js";

// Isolate recordings on a throwaway temp dir so the chunk-upload test cannot
// write artifacts into the repo. Must run before config.ts is evaluated.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR ?? "/tmp";
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.RECORDINGS_DIR = `${tmp}/peercast-relreg-${tag}`;
});

/** App with rate limiting ON, for exercising the limiters. */
function limitedApp(): Express {
  return configureApp(express(), { rateLimiting: true, quiet: true });
}

async function register(a: Express, username = "alice") {
  const res = await request(a)
    .post("/api/auth/register")
    .send({
      username,
      email: `${username}@example.com`,
      displayName: username,
      password: "secret123",
    })
    .expect(201);
  return res.body.accessToken as string;
}

describe("release regressions", () => {
  beforeEach(() => {
    resetDb();
  });

  // ─── Chunk uploads must not consume the create budget ──────────────────

  describe("recording chunk uploads are not throttled by the create limiter", () => {
    it("accepts well over 20 chunks on a single recording", async () => {
      const app = limitedApp();
      const token = await register(app);

      // Go live, then open a recording.
      await request(app)
        .post("/api/broadcasts")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "Live", access: "public", source: "tab", peerId: "p1" })
        .expect(201);

      const rec = await request(app)
        .post("/api/recordings")
        .set("Authorization", `Bearer ${token}`)
        .send({ broadcastId: (await listBroadcastIds(app, token))[0] })
        .expect(201);
      const recId = rec.body.recording.id as string;

      // The create limiter allows 20/h. Push 25 chunks: with the prefix-mount
      // bug, chunks 21+ return 429 and the replay is truncated.
      let rejected = 0;
      for (let i = 0; i < 25; i++) {
        const res = await request(app)
          .put(`/api/recordings/${recId}/chunk`)
          .set("Authorization", `Bearer ${token}`)
          .set("Content-Type", "application/octet-stream")
          .send(Buffer.from("x"));
        if (res.status === 429) rejected++;
      }
      expect(rejected).toBe(0);
    });

    it("still rate-limits creating many recordings (the limiter is not just removed)", async () => {
      const app = limitedApp();
      const token = await register(app);
      const id = (await listBroadcastIds(app, token))[0];

      let created = 0;
      let limited = 0;
      for (let i = 0; i < 25; i++) {
        const res = await request(app)
          .post("/api/recordings")
          .set("Authorization", `Bearer ${token}`)
          .send({ broadcastId: id });
        if (res.status === 201) created++;
        if (res.status === 429) limited++;
      }
      // The create budget must still bite somewhere in 25 attempts.
      expect(limited).toBeGreaterThan(0);
      expect(created).toBeLessThanOrEqual(21);
    });
  });

  // ─── Login must not enumerate by timing ────────────────────────────────

  describe("login timing does not reveal whether a user exists", () => {
    it("performs a bcrypt compare even for an unknown username", async () => {
      const app = makeApp();
      await register(app, "knownuser");

      // A real compare at cost 12 costs hundreds of ms; the unknown-user path
      // used to skip bcrypt entirely and return sub-millisecond. Sample both
      // and assert the gap is not the ~300 ms that gives enumeration away.
      const time = async (body: object) => {
        const t0 = performance.now();
        await request(app).post("/api/auth/login").send(body).expect(401);
        return performance.now() - t0;
      };

      // Warm up so JIT/first-call cost isn't attributed to the unknown path.
      await time({ username: "knownuser", password: "wrongpassword" });

      const known = await time({ username: "knownuser", password: "wrongpw2" });
      const unknown = await time({
        username: "nosuchuser",
        password: "wrongpw3",
      });

      // Generous ceiling: we only assert the unknown path is no longer
      // trivially fast, which is the enumerable signature.
      expect(unknown).toBeGreaterThan(known * 0.25);
    });
  });
});

/** The most recent broadcast id for the token owner. */
async function listBroadcastIds(app: Express, token: string) {
  const res = await request(app)
    .post("/api/broadcasts")
    .set("Authorization", `Bearer ${token}`)
    .send({ title: "Live", access: "public", source: "tab", peerId: "p-list" })
    .expect(201);
  return [res.body.broadcast.id as string];
}
