import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { makeApp, resetDb } from "./helpers.js";

const app = makeApp();

async function register(a: Express, username: string) {
  const res = await request(a)
    .post("/api/auth/register")
    .send({
      username,
      email: `${username}@example.com`,
      displayName: username,
      password: "secret123",
    });
  return res.body.accessToken as string;
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Promote a user directly in the DB (simulates ADMIN_USERNAMES bootstrap). */
async function makeAdmin(usernameLc: string) {
  const { usersRepo } = await import("../src/repos/users.js");
  usersRepo.setRole(usernameLc, "admin");
}

beforeEach(() => resetDb());

describe("admin / moderation", () => {
  it("gates admin routes to admins only", async () => {
    const userToken = await register(app, "bob");
    const forbidden = await request(app)
      .get("/api/admin/users")
      .set(auth(userToken));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe("ADMIN_ONLY");

    const anon = await request(app).get("/api/admin/users");
    expect(anon.status).toBe(401);
  });

  it("exposes the admin role in the self view + admin user list", async () => {
    const token = await register(app, "mod");
    await makeAdmin("mod");
    const me = await request(app).get("/api/users/me").set(auth(token));
    // token was issued before promotion; role is re-read from DB per request
    expect(me.body.user.role).toBe("admin");

    const list = await request(app).get("/api/admin/users").set(auth(token));
    expect(list.status).toBe(200);
    expect(
      list.body.users.find((u: { username: string }) => u.username === "mod"),
    ).toBeTruthy();
  });

  it("bans a user: blocks login, announce, and force-ends live broadcasts", async () => {
    const adminToken = await register(app, "mod");
    await makeAdmin("mod");
    const badToken = await register(app, "spammer");

    // spammer goes live
    await request(app)
      .post("/api/broadcasts")
      .set(auth(badToken))
      .send({ title: "spam", access: "public", source: "screen", peerId: "p" });
    expect(
      (await request(app).get("/api/broadcasts/live")).body.broadcasts,
    ).toHaveLength(1);

    // admin bans them
    const ban = await request(app)
      .post("/api/admin/users/spammer/ban")
      .set(auth(adminToken))
      .send({ reason: "abuse" });
    expect(ban.status).toBe(200);
    expect(ban.body.user.banned).toBe(true);
    expect(ban.body.endedLive).toBe(1);

    // live feed is now empty
    expect(
      (await request(app).get("/api/broadcasts/live")).body.broadcasts,
    ).toHaveLength(0);

    // banned user cannot use existing token (immediate enforcement)
    const useOld = await request(app).get("/api/users/me").set(auth(badToken));
    expect(useOld.status).toBe(403);
    expect(useOld.body.code).toBe("BANNED");

    // banned user cannot log in
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "spammer", password: "secret123" });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe("BANNED");
  });

  it("banned broadcasters are not resolvable and not discoverable", async () => {
    const adminToken = await register(app, "mod");
    await makeAdmin("mod");
    const badToken = await register(app, "spammer");
    await request(app)
      .post("/api/broadcasts")
      .set(auth(badToken))
      .send({ title: "x", access: "public", source: "screen", peerId: "p" });

    await request(app)
      .post("/api/admin/users/spammer/ban")
      .set(auth(adminToken))
      .send({});

    expect((await request(app).get("/api/sessions/spammer")).status).toBe(404);
    expect(
      (await request(app).get("/api/users/search?q=spammer")).body.users,
    ).toHaveLength(0);
  });

  it("unbans a user, restoring login", async () => {
    const adminToken = await register(app, "mod");
    await makeAdmin("mod");
    await register(app, "carol");
    await request(app)
      .post("/api/admin/users/carol/ban")
      .set(auth(adminToken))
      .send({});
    await request(app)
      .post("/api/admin/users/carol/unban")
      .set(auth(adminToken));

    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "carol", password: "secret123" });
    expect(login.status).toBe(200);
  });

  it("refuses to ban another admin or yourself", async () => {
    const adminToken = await register(app, "mod");
    await makeAdmin("mod");
    const otherToken = await register(app, "mod2");
    await makeAdmin("mod2");

    const banAdmin = await request(app)
      .post("/api/admin/users/mod2/ban")
      .set(auth(adminToken))
      .send({});
    expect(banAdmin.status).toBe(403);

    const banSelf = await request(app)
      .post("/api/admin/users/mod/ban")
      .set(auth(adminToken))
      .send({});
    expect(banSelf.status).toBe(400);
    void otherToken;
  });

  it("takes down a specific broadcast", async () => {
    const adminToken = await register(app, "mod");
    await makeAdmin("mod");
    const uToken = await register(app, "dave");
    const started = await request(app)
      .post("/api/broadcasts")
      .set(auth(uToken))
      .send({ title: "x", access: "public", source: "screen", peerId: "p" });
    const id = started.body.broadcast.id;

    const td = await request(app)
      .post(`/api/admin/broadcasts/${id}/takedown`)
      .set(auth(adminToken));
    expect(td.status).toBe(200);
    expect(td.body.broadcast.status).toBe("ended");
    expect((await request(app).get("/api/sessions/dave")).status).toBe(404);
  });

  it("promotes and demotes via role endpoint", async () => {
    const adminToken = await register(app, "mod");
    await makeAdmin("mod");
    await register(app, "erin");

    const promote = await request(app)
      .put("/api/admin/users/erin/role")
      .set(auth(adminToken))
      .send({ role: "admin" });
    expect(promote.body.user.role).toBe("admin");

    const demote = await request(app)
      .put("/api/admin/users/erin/role")
      .set(auth(adminToken))
      .send({ role: "user" });
    expect(demote.body.user.role).toBe("user");
  });
});

describe("reports", () => {
  it("lets anyone file a report; admins list + resolve it", async () => {
    const adminToken = await register(app, "mod");
    await makeAdmin("mod");
    await register(app, "target");

    const filed = await request(app)
      .post("/api/reports")
      .send({ targetUsername: "target", reason: "inappropriate content" });
    expect(filed.status).toBe(201);
    const reportId = filed.body.report.id;

    const open = await request(app)
      .get("/api/admin/reports")
      .set(auth(adminToken));
    expect(open.body.reports).toHaveLength(1);
    expect(open.body.openCount).toBe(1);

    const resolved = await request(app)
      .post(`/api/admin/reports/${reportId}/resolve`)
      .set(auth(adminToken))
      .send({ status: "resolved" });
    expect(resolved.body.report.status).toBe("resolved");
    expect(resolved.body.report.resolvedBy).toBe("mod");

    const stillOpen = await request(app)
      .get("/api/admin/reports?status=open")
      .set(auth(adminToken));
    expect(stillOpen.body.reports).toHaveLength(0);
  });

  it("rejects reports against unknown users and self-reports", async () => {
    const token = await register(app, "frank");
    const unknown = await request(app)
      .post("/api/reports")
      .send({ targetUsername: "ghost", reason: "spam here" });
    expect(unknown.status).toBe(404);

    const self = await request(app)
      .post("/api/reports")
      .set(auth(token))
      .send({ targetUsername: "frank", reason: "testing self" });
    expect(self.status).toBe(400);
  });

  it("returns aggregate metrics for admins and 403 for regular users", async () => {
    const adminToken = await register(app, "mod");
    await makeAdmin("mod");
    await register(app, "streamer1");
    await register(app, "streamer2");

    // First broadcast: goes live with 7 viewers, then ends (samples totals).
    const b1 = await request(app)
      .post("/api/broadcasts")
      .set(auth(adminToken))
      .send({
        title: "first",
        access: "public",
        source: "screen",
        peerId: "p1",
      });
    const id1 = b1.body.broadcast.id as string;
    await request(app)
      .post(`/api/broadcasts/${id1}/stats`)
      .set(auth(adminToken))
      .send({
        stats: {
          viewers: 7,
          bitrateKbps: 1000,
          fps: 30,
          width: 1280,
          height: 720,
        },
      });
    await request(app).post(`/api/broadcasts/${id1}/end`).set(auth(adminToken));

    // Second broadcast stays live with 7 current viewers.
    const b2 = await request(app)
      .post("/api/broadcasts")
      .set(auth(adminToken))
      .send({
        title: "again",
        access: "public",
        source: "screen",
        peerId: "p2",
      });
    const id2 = b2.body.broadcast.id as string;
    await request(app)
      .post(`/api/broadcasts/${id2}/stats`)
      .set(auth(adminToken))
      .send({
        stats: {
          viewers: 7,
          bitrateKbps: 900,
          fps: 30,
          width: 1280,
          height: 720,
        },
      });

    const blocked = await request(app)
      .get("/api/admin/metrics")
      .set(auth(await register(app, "regular")));
    expect(blocked.status).toBe(403);

    const days = 30;
    const res = await request(app)
      .get(`/api/admin/metrics?days=${days}`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const m = res.body.metrics;
    expect(m.totals.users).toBeGreaterThanOrEqual(4);
    expect(m.totals.admins).toBe(1);
    expect(m.totals.broadcasts).toBeGreaterThanOrEqual(1);
    expect(m.totals.liveBroadcasts).toBe(1);
    expect(m.totals.currentViewers).toBe(7);
    expect(m.totals.peakConcurrentViewers).toBeGreaterThanOrEqual(7);
    expect(m.totals.peakConcurrentToday).toBeGreaterThanOrEqual(7);
    expect(m.totals.totalViews).toBeGreaterThanOrEqual(7);

    expect(m.broadcastsPerDay).toHaveLength(days);
    expect(m.usersPerDay).toHaveLength(days);
    expect(m.concurrentPeakPerDay).toHaveLength(days);
    // Today (UTC) has activity → nonzero count buckets for broadcasts+users.
    const todayI = days - 1;
    expect(m.broadcastsPerDay[todayI].count).toBeGreaterThanOrEqual(2);
    expect(m.broadcastsPerDay[todayI].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.usersPerDay[todayI].count).toBeGreaterThanOrEqual(4);
    expect(m.concurrentPeakPerDay[todayI].peak).toBe(7);
  });

  it("clamps the metrics window to the supported range", async () => {
    const adminToken = await register(app, "mod");
    await makeAdmin("mod");

    const res = await request(app)
      .get("/api/admin/metrics?days=1")
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7); // floor
    expect(res.body.metrics.broadcastsPerDay).toHaveLength(7);

    const hi = await request(app)
      .get("/api/admin/metrics?days=99999")
      .set(auth(adminToken));
    expect(hi.status).toBe(200);
    expect(hi.body.days).toBe(90); // ceiling
  });
});
