import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
// Isolate recordings on a throwaway temp dir AND keep the per-recording cap
// small (100 bytes) so the cap test needs no real data. Both must be set
// before config.ts evaluates (vi.hoisted runs first).
vi.hoisted(() => {
  const tmp = process.env.TMPDIR ?? "/tmp";
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.RECORDINGS_DIR = `${tmp}/peercast-rec-${tag}`;
  process.env.RECORDINGS_MAX_BYTES = "100";
});
import { makeApp, resetDb } from "./helpers.js";

const app = makeApp();
let token = "";

function api(method: "get" | "post" | "put" | "delete", url: string) {
  return request(app)[method](url).set("Authorization", `Bearer ${token}`);
}

function apiAs(
  method: "get" | "post" | "put" | "delete",
  url: string,
  bearer: string,
) {
  return request(app)[method](url).set("Authorization", `Bearer ${bearer}`);
}

async function register(username: string) {
  const res = await request(app)
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

describe("recordings (per-broadcast replay)", () => {
  beforeEach(async () => {
    resetDb();
    token = await register("alice");
  });

  it("creates a recording and lists it", async () => {
    const created = await api("post", "/api/recordings")
      .send({ title: "My stream" })
      .expect(201);
    expect(created.body.recording.status).toBe("recording");
    expect(created.body.recording.sizeBytes).toBe(0);

    const list = await api("get", "/api/recordings").expect(200);
    expect(list.body.recordings).toHaveLength(1);
    expect(list.body.recordings[0].title).toBe("My stream");
    expect(list.body.recordings[0].id).toBe(created.body.recording.id);
  });

  it("can be tied to an owned broadcast, rejects broadcasts of others", async () => {
    const b = await api("post", "/api/broadcasts")
      .send({
        title: "Live",
        access: "public",
        source: "screen",
        peerId: "peer-777",
      })
      .expect(201);

    const withBcast = await api("post", "/api/recordings")
      .send({ title: "Rec", broadcastId: b.body.broadcast.id })
      .expect(201);
    expect(withBcast.body.recording.broadcastId).toBe(b.body.broadcast.id);

    const bob = await register("bob");
    await apiAs("post", "/api/recordings", bob)
      .send({ title: "intrude", broadcastId: b.body.broadcast.id })
      .expect(400);
  });

  it("requires auth", async () => {
    await request(app).get("/api/recordings").expect(401);
    await request(app).post("/api/recordings").send({}).expect(401);
    await request(app)
      .post("/api/recordings/abc/finalize")
      .send({})
      .expect(401);
  });

  it("appends binary chunks, finalizes, and streams the exact bytes back", async () => {
    const created = await api("post", "/api/recordings").send({}).expect(201);
    const id = created.body.recording.id;

    const chunk1 = Buffer.from("first-chunk-");
    const chunk2 = Buffer.from("second");

    const r1 = await api("put", `/api/recordings/${id}/chunk`)
      .send(chunk1)
      .expect(200);
    expect(r1.body.sizeBytes).toBe(chunk1.length);

    const r2 = await api("put", `/api/recordings/${id}/chunk`)
      .send(chunk2)
      .expect(200);
    expect(r2.body.sizeBytes).toBe(chunk1.length + chunk2.length);

    await api("post", `/api/recordings/${id}/finalize`)
      .send({ durationMs: 4200 })
      .expect(200);

    const meta = await api("get", `/api/recordings/${id}`).expect(200);
    expect(meta.body.recording.status).toBe("complete");
    expect(meta.body.recording.durationMs).toBe(4200);
    expect(meta.body.recording.sizeBytes).toBe(r2.body.sizeBytes);

    const data = await api("get", `/api/recordings/${id}/data`)
      .expect("Content-Type", /video\/webm/)
      .expect(200)
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => cb(null, Buffer.concat(parts)));
      });
    expect(data.body).toEqual(Buffer.concat([chunk1, chunk2]));

    // In-progress recordings have no replay file yet.
    const live = await api("post", "/api/recordings").send({}).expect(201);
    await api("get", `/api/recordings/${live.body.recording.id}/data`).expect(
      404,
    );
  });

  it("supports HTTP Range for seeking", async () => {
    const created = await api("post", "/api/recordings").send({}).expect(201);
    const id = created.body.recording.id;
    await api("put", `/api/recordings/${id}/chunk`)
      .send(Buffer.from("0123456789"))
      .expect(200);
    await api("post", `/api/recordings/${id}/finalize`).send({}).expect(200);

    const range = await api("get", `/api/recordings/${id}/data`)
      .set("Range", "bytes=2-5")
      .expect(206)
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => cb(null, Buffer.concat(parts)));
      });
    expect(range.body.toString()).toBe("2345");
  });

  it("is owner-only — other users get 404", async () => {
    const created = await api("post", "/api/recordings").send({}).expect(201);
    const id = created.body.recording.id;

    const bob = await register("bob");
    await apiAs("get", `/api/recordings/${id}`, bob).expect(404);
    await apiAs("put", `/api/recordings/${id}/chunk`, bob)
      .send(Buffer.from("x"))
      .expect(404);
    await apiAs("post", `/api/recordings/${id}/finalize`, bob)
      .send({})
      .expect(404);
    await apiAs("get", `/api/recordings/${id}/data`, bob).expect(404);
    await apiAs("delete", `/api/recordings/${id}`, bob).expect(404);
  });

  it("rejects chunks after finalize and beyond the size cap", async () => {
    const created = await api("post", "/api/recordings").send({}).expect(201);
    const id = created.body.recording.id;

    await api("put", `/api/recordings/${id}/chunk`)
      .send(Buffer.alloc(64, 1))
      .expect(200);

    // Cap is 100 bytes: a second 64-byte chunk crosses it.
    await api("put", `/api/recordings/${id}/chunk`)
      .send(Buffer.alloc(64, 2))
      .expect(400)
      .expect((r) => expect(r.body.code).toBe("RECORDING_TOO_LARGE"));

    await api("post", `/api/recordings/${id}/finalize`).send({}).expect(200);
    await api("put", `/api/recordings/${id}/chunk`)
      .send(Buffer.from("late"))
      .expect(400);
    await api("post", `/api/recordings/${id}/finalize`).send({}).expect(400);
  });

  it("deletes the row and its files", async () => {
    const created = await api("post", "/api/recordings").send({}).expect(201);
    const id = created.body.recording.id;
    await api("put", `/api/recordings/${id}/chunk`)
      .send(Buffer.from("bye"))
      .expect(200);
    await api("post", `/api/recordings/${id}/finalize`).send({}).expect(200);

    const dir = process.env.RECORDINGS_DIR!;
    expect(existsSync(join(dir, `${id}.webm`))).toBe(true);

    await api("delete", `/api/recordings/${id}`).expect(200);
    await api("get", `/api/recordings/${id}`).expect(404);
    expect(existsSync(join(dir, `${id}.webm`))).toBe(false);
    expect(existsSync(join(dir, `${id}.webm.part`))).toBe(false);
  });
});
