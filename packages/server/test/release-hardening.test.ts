/**
 * Regression guards for the second release-hardening pass.
 *
 * Each test here corresponds to a defect that shipped and would not have been
 * caught by the existing suite:
 *
 *   1. trust proxy was inferred from NODE_ENV, so a directly-exposed instance
 *      let clients spoof X-Forwarded-For and rotate their rate-limit bucket.
 *   2. Gated broadcasts leaked their existence/title/owner/audience through
 *      /broadcasts/live, /users/search and /api/broadcasts/:id.
 *   3. Login enumerated usernames by response time.
 *   4. An orphaned in-progress recording held the owner's quota forever.
 *   5. A push endpoint could be re-pointed at another account.
 *   6. Account deletion left the handle in audit_log.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import { makeApp, resetDb } from "./helpers.js";
import { configureApp } from "../src/app.js";

vi.hoisted(() => {
  const tmp = process.env.TMPDIR ?? "/tmp";
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.RECORDINGS_DIR = `${tmp}/peercast-hardening-${tag}`;
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

function limitedApp(): Express {
  return configureApp(express(), { rateLimiting: true, quiet: true });
}

async function register(a: Express, username: string) {
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

async function goLive(
  a: Express,
  token: string,
  peerId: string,
  access: "public" | "authenticated" | "code" = "public",
) {
  const res = await request(a)
    .post("/api/broadcasts")
    .set(auth(token))
    .send({
      title: `Stream ${peerId}`,
      access,
      source: "screen",
      peerId,
      ...(access === "code" ? { accessCode: "open42" } : {}),
    })
    .expect(201);
  return res.body.broadcast.id as string;
}

describe("release hardening", () => {
  beforeEach(() => resetDb());

  // ─── 1. trust proxy ───────────────────────────────────────────────────────

  describe("rate-limit keying", () => {
    it("does not trust X-Forwarded-For by default", async () => {
      const app = limitedApp();
      const token = await register(app, "alice");
      await goLive(app, token, "peer-tp", "code");

      // Each attempt carries a different spoofed XFF. With trust proxy > 0
      // these are distinct limiter keys and the per-IP code bucket never
      // fills; with the default 0 every one of them lands in the same bucket.
      let limited = 0;
      for (let i = 0; i < 12; i++) {
        const res = await request(app)
          .get("/api/sessions/alice?code=guess123")
          .set("X-Forwarded-For", `10.0.0.${i + 1}`);
        if (res.status === 429) limited++;
      }
      // The per-(IP, username) limiter allows 5/15 min, so a non-rotating
      // bucket must trip within 12 attempts.
      expect(limited).toBeGreaterThan(0);
    });
  });

  // ─── 2. gated broadcast metadata ──────────────────────────────────────────

  describe("gated broadcast metadata is not publicly discoverable", () => {
    it("omits a code-gated stream from the live feed and search", async () => {
      const app = makeApp();
      const token = await register(app, "alice");
      await goLive(app, token, "peer-secret", "code");

      const live = await request(app).get("/api/broadcasts/live");
      expect(live.body.broadcasts).toHaveLength(0);
      expect(JSON.stringify(live.body)).not.toContain("Stream peer-secret");

      const search = await request(app).get("/api/users/search?q=Stream");
      expect(JSON.stringify(search.body)).not.toContain("peer-secret");
    });

    it("404s a code-gated broadcast detail for anonymous callers", async () => {
      const app = makeApp();
      const token = await register(app, "alice");
      const id = await goLive(app, token, "peer-secret2", "code");

      const anon = await request(app).get(`/api/broadcasts/${id}`);
      expect(anon.status).toBe(404);
      expect(JSON.stringify(anon.body)).not.toContain("peer-secret2");

      // The owner still sees their own stream's metadata (never the peerId).
      const owner = await request(app)
        .get(`/api/broadcasts/${id}`)
        .set(auth(token));
      expect(owner.status).toBe(200);
      expect(owner.body.broadcast.peerId).toBeNull();
      expect(owner.body.broadcast.title).toBe("Stream peer-secret2");
    });

    it("keeps public broadcasts fully visible", async () => {
      const app = makeApp();
      const token = await register(app, "alice");
      const id = await goLive(app, token, "peer-open", "public");

      const live = await request(app).get("/api/broadcasts/live");
      expect(live.body.broadcasts).toHaveLength(1);
      expect(live.body.broadcasts[0].peerId).toBeNull();

      const anon = await request(app).get(`/api/broadcasts/${id}`);
      expect(anon.status).toBe(200);
    });

    it("lets a signed-in member see an authenticated-gated stream's card", async () => {
      const app = makeApp();
      const token = await register(app, "alice");
      const id = await goLive(app, token, "peer-members", "authenticated");

      // Anonymous: hidden.
      const anon = await request(app).get(`/api/broadcasts/${id}`);
      expect(anon.status).toBe(404);

      // A different signed-in user: the gate is "members only", and being
      // signed in is what that means. Media still needs a ticket from
      // /sessions; this only covers metadata.
      const bob = await register(app, "bob");
      const member = await request(app)
        .get(`/api/broadcasts/${id}`)
        .set(auth(bob));
      expect(member.status).toBe(200);
      expect(member.body.broadcast.peerId).toBeNull();
    });
  });

  // ─── 3. login timing ──────────────────────────────────────────────────────

  it("spends comparable time whether or not the account exists", async () => {
    const app = makeApp();
    await register(app, "knownuser");

    const time = async (body: object) => {
      const t0 = performance.now();
      await request(app).post("/api/auth/login").send(body).expect(401);
      return performance.now() - t0;
    };
    // Warm up so first-call JIT cost is not charged to the unknown-user path.
    await time({ username: "knownuser", password: "wrongpassword" });

    const known = await time({ username: "knownuser", password: "wrongpw2" });
    const unknown = await time({
      username: "nosuchuser",
      password: "wrongpw3",
    });

    // The enumerable signature was ~20x; assert only that the unknown path is
    // no longer trivially fast.
    expect(unknown).toBeGreaterThan(known * 0.25);
  });

  // ─── 4. orphaned recordings ───────────────────────────────────────────────

  describe("retention", () => {
    it("reaps recordings abandoned mid-upload", async () => {
      const app = makeApp();
      const token = await register(app, "alice");
      const bcId = await goLive(app, token, "peer-rec");

      const created = await request(app)
        .post("/api/recordings")
        .set(auth(token))
        .send({ broadcastId: bcId })
        .expect(201);
      const recId = created.body.recording.id as string;

      const { db } = await import("../src/db/index.js");
      const recordingsRepo = await import("../src/repos/recordings.js");
      const reapOrphaned =
        recordingsRepo.reapOrphaned ?? recordingsRepo.default.reapOrphaned;

      // Fresh row: must survive a reaper run.
      expect(reapOrphaned(24 * 3600_000)).toBe(0);
      expect(
        db.prepare(`SELECT id FROM recordings WHERE id = ?`).get(recId),
      ).toBeTruthy();

      // Aged past the threshold: reaped, reclaiming the owner's quota.
      db.prepare(`UPDATE recordings SET created_at = ? WHERE id = ?`).run(
        Date.now() - 48 * 3600_000,
        recId,
      );
      expect(reapOrphaned(24 * 3600_000)).toBe(1);
      expect(
        db.prepare(`SELECT id FROM recordings WHERE id = ?`).get(recId),
      ).toBeUndefined();
    });

    it("does not purge ended broadcasts unless a retention window is set", async () => {
      const { db } = await import("../src/db/index.js");
      const { broadcastsRepo } = await import("../src/repos/broadcasts.js");
      await register(makeApp(), "alice"); // FK parent for the broadcast row
      db.prepare(
        `INSERT INTO broadcasts (id, username_lc, title, status, access, source, started_at)
         VALUES ('old', 'alice', 'Old', 'ended', 'public', 'screen', ?)`,
      ).run(Date.now() - 90 * 86_400_000);

      expect(broadcastsRepo.purgeEndedOlderThan(0)).toBe(0);
      expect(
        db.prepare(`SELECT id FROM broadcasts WHERE id = 'old'`).get(),
      ).toBeTruthy();

      expect(broadcastsRepo.purgeEndedOlderThan(30)).toBe(1);
      expect(
        db.prepare(`SELECT id FROM broadcasts WHERE id = 'old'`).get(),
      ).toBeUndefined();
    });
  });

  // ─── 5. push endpoint takeover ────────────────────────────────────────────

  it("refuses to re-point another account's push endpoint", async () => {
    // The route only accepts allowlisted push-service endpoints and requires
    // VAPID, so assert the repo-level invariant the route relies on. Both
    // accounts must exist: push_subscriptions.username_lc is a real FK.
    await register(makeApp(), "alice");
    await register(makeApp(), "bob");
    const notificationsModule = await import("../src/repos/notifications.js");
    // The repo exposes a default object plus named functions.
    const notificationsRepo = {
      ...notificationsModule,
      ...(notificationsModule.default ?? {}),
    } as typeof notificationsModule.default;
    notificationsRepo.saveSubscription("alice", {
      endpoint: "https://push.example/push-1",
      p256dh: "a",
      auth: "a",
    });
    expect(
      notificationsRepo.isEndpointOwnedByOther(
        "https://push.example/push-1",
        "bob",
      ),
    ).toBe(true);
    expect(
      notificationsRepo.isEndpointOwnedByOther(
        "https://push.example/push-1",
        "alice",
      ),
    ).toBe(false);

    notificationsRepo.saveSubscription("bob", {
      endpoint: "https://push.example/push-1",
      p256dh: "b",
      auth: "b",
    });
    const { db } = await import("../src/db/index.js");
    const row = db
      .prepare(
        `SELECT username_lc, p256dh FROM push_subscriptions WHERE endpoint = ?`,
      )
      .get("https://push.example/push-1") as {
      username_lc: string;
      p256dh: string;
    };
    // A direct upsert must not hand the row to bob either.
    expect(row.username_lc).toBe("alice");
    expect(row.p256dh).toBe("a");
  });

  // ─── 6. erasure reaches audit_log ─────────────────────────────────────────

  it("redacts a deleted account's handle from the audit log", async () => {
    const app = makeApp();
    const token = await register(app, "alice");
    const { db } = await import("../src/db/index.js");

    db.prepare(
      `INSERT INTO audit_log (id, actor_username_lc, action, target, created_at)
       VALUES ('a1', 'admin', 'ban', 'alice', ?)`,
    ).run(Date.now());
    db.prepare(
      `INSERT INTO audit_log (id, actor_username_lc, action, target, created_at)
       VALUES ('a2', 'alice', 'report_resolve', 'bob', ?)`,
    ).run(Date.now());

    await request(app)
      .delete("/api/users/me")
      .set(auth(token))
      .send({ password: "secret123" })
      .expect(200);

    const rows = db
      .prepare(`SELECT actor_username_lc, target FROM audit_log`)
      .all() as {
      actor_username_lc: string;
      target: string;
    }[];
    const serialised = JSON.stringify(rows);
    // The handle must survive nowhere as an identifier.
    expect(serialised).not.toContain("alice");
    // …but the trail itself is kept.
    expect(rows).toHaveLength(2);
  });

  // ─── 7. password length bound ─────────────────────────────────────────────

  it("rejects passwords longer than bcrypt's 72-byte input limit", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        username: "longpw",
        email: "longpw@example.com",
        displayName: "Long",
        // Silently truncated past 72 bytes by bcrypt, so accepting it would
        // imply more entropy than the stored credential actually has.
        password: "a".repeat(73),
      });
    expect(res.status).toBe(400);

    // Exactly at the limit is accepted.
    const ok = await request(app)
      .post("/api/auth/register")
      .send({
        username: "atlimit",
        email: "atlimit@example.com",
        displayName: "At",
        password: "a".repeat(72),
      });
    expect(ok.status).toBe(201);
  });
});
