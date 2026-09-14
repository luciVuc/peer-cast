import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { makeApp, resetDb, validUser } from "./helpers.js";
import { db } from "../src/db/index.js";
import { broadcastsRepo } from "../src/repos/broadcasts.js";

const app = makeApp();

async function token(a: Express) {
  const res = await request(a).post("/api/auth/register").send(validUser);
  return res.body.accessToken as string;
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(() => resetDb());

describe("broadcasts", () => {
  it("starting a new broadcast ends the previous live one", async () => {
    const t = await token(app);
    const first = await request(app)
      .post("/api/broadcasts")
      .set(auth(t))
      .send({ title: "One", access: "public", source: "tab", peerId: "p1" });
    const firstId = first.body.broadcast.id;

    await request(app)
      .post("/api/broadcasts")
      .set(auth(t))
      .send({ title: "Two", access: "public", source: "tab", peerId: "p2" });

    const history = await request(app).get("/api/broadcasts/mine").set(auth(t));
    expect(history.body.broadcasts).toHaveLength(2);
    const firstRow = history.body.broadcasts.find(
      (b: { id: string }) => b.id === firstId,
    );
    expect(firstRow.status).toBe("ended");

    // Only one live broadcast resolves.
    const live = await request(app).get("/api/broadcasts/live");
    expect(live.body.broadcasts).toHaveLength(1);
    expect(live.body.broadcasts[0].title).toBe("Two");
  });

  it("records stats and tracks peak viewers", async () => {
    const t = await token(app);
    const started = await request(app)
      .post("/api/broadcasts")
      .set(auth(t))
      .send({ title: "S", access: "public", source: "tab", peerId: "p1" });
    const id = started.body.broadcast.id;

    await request(app)
      .post(`/api/broadcasts/${id}/stats`)
      .set(auth(t))
      .send({
        stats: {
          viewers: 5,
          bitrateKbps: 1200,
          fps: 30,
          width: 1280,
          height: 720,
        },
      });
    await request(app)
      .post(`/api/broadcasts/${id}/stats`)
      .set(auth(t))
      .send({
        stats: {
          viewers: 2,
          bitrateKbps: 900,
          fps: 30,
          width: 1280,
          height: 720,
        },
      });

    const live = await request(app).get("/api/broadcasts/live");
    const b = live.body.broadcasts[0];
    expect(b.stats.viewers).toBe(2);
    expect(b.peakViewers).toBe(5);
  });

  it("only the owner can end a broadcast", async () => {
    const t = await token(app);
    const started = await request(app)
      .post("/api/broadcasts")
      .set(auth(t))
      .send({ title: "S", access: "public", source: "tab", peerId: "p1" });
    const id = started.body.broadcast.id;

    // another user
    const other = await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, username: "bob", email: "bob@example.com" });
    const ended = await request(app)
      .post(`/api/broadcasts/${id}/end`)
      .set(auth(other.body.accessToken));
    expect(ended.status).toBe(403);

    const ok = await request(app)
      .post(`/api/broadcasts/${id}/end`)
      .set(auth(t));
    expect(ok.status).toBe(200);
    expect(ok.body.broadcast.status).toBe("ended");
  });

  it("requires an access code when access is 'code'", async () => {
    const t = await token(app);
    const res = await request(app)
      .post("/api/broadcasts")
      .set(auth(t))
      .send({ title: "C", access: "code", source: "tab", peerId: "p1" });
    expect(res.status).toBe(400);
  });

  it("endStale force-ends broadcasts whose host stopped reporting stats", async () => {
    const t = await token(app);
    const started = await request(app)
      .post("/api/broadcasts")
      .set(auth(t))
      .send({ title: "Ghost", access: "public", source: "tab", peerId: "p1" });
    const id = started.body.broadcast.id;

    // Simulate a host that went silent: backdate the last stats heartbeat.
    db.prepare(
      `UPDATE broadcasts SET stat_at = ?, stat_viewers = 1 WHERE id = ?`,
    ).run(Date.now() - 10 * 60 * 1000, id);

    const ended = broadcastsRepo.endStale(90_000);
    expect(ended).toBe(1);

    const live = await request(app).get("/api/broadcasts/live");
    expect(live.body.broadcasts).toHaveLength(0);

    const history = await request(app).get("/api/broadcasts/mine").set(auth(t));
    expect(history.body.broadcasts[0].status).toBe("ended");
    expect(history.body.broadcasts[0].stats).toBeUndefined();
  });

  it("endStale keeps broadcasts that are still reporting stats", async () => {
    const t = await token(app);
    await request(app)
      .post("/api/broadcasts")
      .set(auth(t))
      .send({ title: "Alive", access: "public", source: "tab", peerId: "p1" });
    const id = (await request(app).get("/api/broadcasts/live")).body
      .broadcasts[0].id;

    await request(app)
      .post(`/api/broadcasts/${id}/stats`)
      .set(auth(t))
      .send({
        stats: {
          viewers: 1,
          bitrateKbps: 500,
          fps: 30,
          width: 1280,
          height: 720,
        },
      });

    expect(broadcastsRepo.endStale(90_000)).toBe(0);
    const live = await request(app).get("/api/broadcasts/live");
    expect(live.body.broadcasts).toHaveLength(1);
  });
});
