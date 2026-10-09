import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import bcrypt from "bcrypt";
import request from "supertest";
import type { Express } from "express";
import { makeApp, resetDb, validUser } from "./helpers.js";

const app = makeApp();

async function registerAndToken(a: Express): Promise<string> {
  const res = await request(a).post("/api/auth/register").send(validUser);
  return res.body.accessToken as string;
}

function start(a: Express, token: string, body: Record<string, unknown>) {
  return request(a)
    .post("/api/broadcasts")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

beforeEach(() => resetDb());

describe("access control", () => {
  it("public: resolves peerId for anyone, no ticket", async () => {
    const token = await registerAndToken(app);
    await start(app, token, {
      title: "Public",
      access: "public",
      source: "screen",
      peerId: "peer-public",
    });

    const res = await request(app).get("/api/sessions/alice");
    expect(res.status).toBe(200);
    expect(res.body.peerId).toBe("peer-public");
    expect(res.body.ticket).toBeNull();
  });

  it("authenticated: hides peerId from anon, issues ticket to members", async () => {
    const token = await registerAndToken(app);
    await start(app, token, {
      title: "Members",
      access: "authenticated",
      source: "screen",
      peerId: "peer-members",
    });

    const anon = await request(app).get("/api/sessions/alice");
    expect(anon.status).toBe(401);
    expect(anon.body.peerId).toBeNull();
    expect(anon.body.ticket).toBeNull();

    const authed = await request(app)
      .get("/api/sessions/alice")
      .set("Authorization", `Bearer ${token}`);
    expect(authed.status).toBe(200);
    expect(authed.body.peerId).toBe("peer-members");
    expect(authed.body.ticket).toBeTruthy();

    // Host verifies the ticket only for the matching peerId.
    const good = await request(app)
      .post("/api/sessions/verify-ticket")
      .send({ ticket: authed.body.ticket, peerId: "peer-members" });
    expect(good.body.ok).toBe(true);
    expect(good.body.username).toBe("alice");

    const bad = await request(app)
      .post("/api/sessions/verify-ticket")
      .send({ ticket: authed.body.ticket, peerId: "peer-WRONG" });
    expect(bad.body.ok).toBe(false);
  });

  it("code: gates on the correct access code", async () => {
    const token = await registerAndToken(app);
    await start(app, token, {
      title: "Coded",
      access: "code",
      source: "screen",
      peerId: "peer-coded",
      accessCode: "open42",
    });

    const noCode = await request(app).get("/api/sessions/alice");
    expect(noCode.status).toBe(401);
    expect(noCode.body.needsCode).toBe(true);
    expect(noCode.body.peerId).toBeNull();

    const wrong = await request(app).get("/api/sessions/alice?code=nope");
    expect(wrong.status).toBe(403);
    expect(wrong.body.peerId).toBeNull();

    const right = await request(app).get("/api/sessions/alice?code=open42");
    expect(right.status).toBe(200);
    expect(right.body.peerId).toBe("peer-coded");
    expect(right.body.ticket).toBeTruthy();
  });

  it("hashes access codes at rest (never plaintext in the DB)", async () => {
    const token = await registerAndToken(app);
    await start(app, token, {
      title: "Coded",
      access: "code",
      source: "screen",
      peerId: "peer-coded",
      accessCode: "open42",
    });
    const { db } = await import("../src/db/index.js");
    const row = db
      .prepare(`SELECT access_code FROM broadcasts WHERE access = 'code'`)
      .get() as { access_code: string };
    // bcrypt, not a bare digest: a 6-char human-chosen code has almost no
    // entropy, so an unsalted SHA-256 is a seconds-long offline dictionary
    // attack for anyone who obtains the DB file.
    expect(row.access_code).toMatch(/^bcrypt\$\$2[aby]\$\d{2}\$/);
    expect(row.access_code).not.toContain("open42");
    // …and it must actually verify against the stored digest.
    expect(
      bcrypt.compareSync("open42", row.access_code.slice("bcrypt$".length)),
    ).toBe(true);
    expect(
      bcrypt.compareSync("wrong42", row.access_code.slice("bcrypt$".length)),
    ).toBe(false);
    // The gate still works against the digest.
    const right = await request(app).get("/api/sessions/alice?code=open42");
    expect(right.status).toBe(200);
    const wrong = await request(app).get("/api/sessions/alice?code=wrong42");
    expect(wrong.status).toBe(403);
  });

  it("soft-migrates legacy plaintext access codes", async () => {
    const token = await registerAndToken(app);
    await start(app, token, {
      title: "Coded",
      access: "code",
      source: "screen",
      peerId: "peer-coded",
      accessCode: "open42",
    });
    // Simulate a row written before hashing existed.
    const { db } = await import("../src/db/index.js");
    db.prepare(
      `UPDATE broadcasts SET access_code = ? WHERE access = 'code'`,
    ).run("open42");
    const right = await request(app).get("/api/sessions/alice?code=open42");
    expect(right.status).toBe(200);
    expect(right.body.peerId).toBe("peer-coded");
    const wrong = await request(app).get("/api/sessions/alice?code=nope");
    expect(wrong.status).toBe(403);
  });

  it("never leaks peerId via list/search/profile endpoints", async () => {
    const token = await registerAndToken(app);
    await start(app, token, {
      title: "Members",
      access: "authenticated",
      source: "screen",
      peerId: "secret-peer-id",
    });

    // Gated broadcasts are not listed in public discovery at all (see below),
    // so assert the members-only title is absent rather than merely redacted.
    const live = await request(app).get("/api/broadcasts/live");
    for (const b of live.body.broadcasts) expect(b.peerId).toBeNull();
    expect(JSON.stringify(live.body)).not.toContain("Members");

    const search = await request(app).get("/api/users/search?q=alice");
    for (const b of search.body.broadcasts) expect(b.peerId).toBeNull();

    // Anonymous callers get no live card for a gated stream either.
    const profile = await request(app).get("/api/users/alice");
    expect(profile.body.live?.peerId ?? null).toBeNull();

    // Sanity: the secret id is nowhere in the serialized responses.
    expect(JSON.stringify(live.body)).not.toContain("secret-peer-id");
    expect(JSON.stringify(profile.body)).not.toContain("secret-peer-id");
  });

  it("hides gated broadcast metadata from anonymous callers but not from members", async () => {
    const token = await registerAndToken(app);
    const { body: started } = await start(app, token, {
      title: "Secret meeting",
      access: "code",
      source: "screen",
      peerId: "gated-peer-id",
      accessCode: "hunter22",
    });
    const id = started.broadcast.id as string;

    // Anonymous: the broadcast must not be discoverable at all. Title, owner,
    // and audience size are exactly what `access: code` was chosen to conceal.
    const anonList = await request(app).get("/api/broadcasts/live");
    expect(JSON.stringify(anonList.body)).not.toContain("Secret meeting");
    const anonDetail = await request(app).get(`/api/broadcasts/${id}`);
    expect(anonDetail.status).toBe(404);
    const anonProfile = await request(app).get("/api/users/alice");
    expect(anonProfile.body.live).toBeNull();

    // Owner still sees their own stream (and still never the peerId here).
    const ownerDetail = await request(app)
      .get(`/api/broadcasts/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(ownerDetail.status).toBe(200);
    expect(ownerDetail.body.broadcast.peerId).toBeNull();
    expect(ownerDetail.body.broadcast.title).toBe("Secret meeting");
  });

  it("still serves public broadcasts to anonymous callers", async () => {
    const token = await registerAndToken(app);
    const { body: started } = await start(app, token, {
      title: "Open stream",
      access: "public",
      source: "screen",
      peerId: "public-peer-id",
    });

    const list = await request(app).get("/api/broadcasts/live");
    expect(list.body.broadcasts[0].title).toBe("Open stream");
    expect(list.body.broadcasts[0].peerId).toBeNull();

    const detail = await request(app).get(
      `/api/broadcasts/${started.broadcast.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.broadcast.peerId).toBeNull();

    const profile = await request(app).get("/api/users/alice");
    expect(profile.body.live.title).toBe("Open stream");
    expect(profile.body.live.peerId).toBeNull();
  });

  it("returns 404 when the user is not live", async () => {
    await registerAndToken(app);
    const res = await request(app).get("/api/sessions/alice");
    expect(res.status).toBe(404);
  });

  it("signaling tickets are authed, opaque, and single-use", async () => {
    const token = await registerAndToken(app);

    // Requires a valid access token.
    const noauth = await request(app).post("/api/auth/signaling-ticket");
    expect(noauth.status).toBe(401);

    const res = await request(app)
      .post("/api/auth/signaling-ticket")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const { token: ticket } = res.body as { token: string };
    expect(ticket).toBeTruthy();
    // Opaque, not a JWT: no dots, no base64 header.payload.
    expect(ticket).not.toContain(".");

    // Single-use: first consume succeeds, the replay is a miss.
    const { consumeSignalingTicketSync } = await import("../src/lib/auth.js");
    expect(consumeSignalingTicketSync(ticket)).toBe("alice");
    expect(consumeSignalingTicketSync(ticket)).toBeNull();

    // The async wrapper (Redis-aware) falls back to the in-memory store when
    // no REDIS_URL is configured — same single-use semantics.
    const { consumeSignalingTicket } = await import("../src/lib/auth.js");
    const again = await request(app)
      .post("/api/auth/signaling-ticket")
      .set("Authorization", `Bearer ${token}`);
    const second = (again.body as { token: string }).token;
    expect(await consumeSignalingTicket(second)).toBe("alice");
    expect(await consumeSignalingTicket(second)).toBeNull();
  });
});
