import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { makeApp, resetDb } from "./helpers.js";
import { config } from "../src/config.js";

const app = makeApp();

async function register(a: Express, username: string, inviteCode?: string) {
  return request(a)
    .post("/api/auth/register")
    .send({
      username,
      email: `${username}@example.com`,
      displayName: username,
      password: "secret123",
      inviteCode,
    });
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function adminToken(a: Express) {
  const res = await register(a, "admin");
  const { usersRepo } = await import("../src/repos/users.js");
  usersRepo.setRole("admin", "admin");
  return res.body.accessToken as string;
}

beforeEach(() => resetDb());
afterEach(() => {
  // restore default mode after each test
  (config as { registrationMode: string }).registrationMode = "open";
});

describe("registration modes", () => {
  it("open mode: registers without a code", async () => {
    (config as { registrationMode: string }).registrationMode = "open";
    const res = await register(app, "alice");
    expect(res.status).toBe(201);
  });

  it("closed mode: refuses all registration", async () => {
    (config as { registrationMode: string }).registrationMode = "closed";
    const res = await register(app, "alice");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("REGISTRATION_CLOSED");
  });

  it("invite mode: requires a valid code", async () => {
    // Bootstrap an admin while open, then flip to invite mode.
    const token = await adminToken(app);
    (config as { registrationMode: string }).registrationMode = "invite";

    const noCode = await register(app, "bob");
    expect(noCode.status).toBe(403);
    expect(noCode.body.code).toBe("INVITE_REQUIRED");

    const badCode = await register(app, "bob", "NOPECODE99");
    expect(badCode.status).toBe(403);
    expect(badCode.body.code).toBe("INVITE_INVALID");

    // Admin mints a single-use code.
    const created = await request(app)
      .post("/api/admin/invites")
      .set(auth(token))
      .send({ note: "for bob", maxUses: 1 });
    expect(created.status).toBe(201);
    const code = created.body.invite.code as string;

    const ok = await register(app, "bob", code);
    expect(ok.status).toBe(201);

    // Single-use code is now exhausted.
    const exhausted = await register(app, "carol", code);
    expect(exhausted.status).toBe(403);
    expect(exhausted.body.code).toBe("INVITE_INVALID");
  });

  it("invite mode: a duplicate-username attempt does not burn the code", async () => {
    const token = await adminToken(app);
    (config as { registrationMode: string }).registrationMode = "invite";
    const created = await request(app)
      .post("/api/admin/invites")
      .set(auth(token))
      .send({ maxUses: 1 });
    const code = created.body.invite.code as string;

    // "admin" already exists → conflict before the code is consumed.
    const dup = await register(app, "admin", code);
    expect(dup.status).toBe(409);

    // The code is still usable.
    const ok = await register(app, "dave", code);
    expect(ok.status).toBe(201);
  });

  it("admin can disable a code", async () => {
    const token = await adminToken(app);
    (config as { registrationMode: string }).registrationMode = "invite";
    const created = await request(app)
      .post("/api/admin/invites")
      .set(auth(token))
      .send({ maxUses: 5 });
    const code = created.body.invite.code as string;

    await request(app)
      .post(`/api/admin/invites/${code}/disable`)
      .set(auth(token));

    const blocked = await register(app, "erin", code);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("INVITE_INVALID");
  });

  it("expired codes are rejected", async () => {
    const token = await adminToken(app);
    (config as { registrationMode: string }).registrationMode = "invite";
    const created = await request(app)
      .post("/api/admin/invites")
      .set(auth(token))
      .send({ expiresInHours: 1 });
    const code = created.body.invite.code as string;

    // Backdate the invite directly (deterministic — avoids fake timers, which
    // can bleed into the next test when isolated in a shared process).
    const { db } = await import("../src/db/index.js");
    db.prepare(`UPDATE invites SET expires_at = ? WHERE code = ?`).run(
      Date.now() - 1,
      code,
    );
    const res = await register(app, "frank", code);
    expect(res.status).toBe(403);
  });

  it("only admins can create invites", async () => {
    const userRes = await register(app, "grace");
    const res = await request(app)
      .post("/api/admin/invites")
      .set(auth(userRes.body.accessToken))
      .send({});
    expect(res.status).toBe(403);
  });

  it("exposes the registration mode via /api/config", async () => {
    (config as { registrationMode: string }).registrationMode = "invite";
    const res = await request(app).get("/api/config");
    expect(res.body.registration).toBe("invite");
  });

  it("lets a designated admin bootstrap even in closed/invite mode", async () => {
    // 'admin' is in ADMIN_USERNAMES (set by the test env in vitest.config).
    (config as { registrationMode: string }).registrationMode = "closed";
    const res = await register(app, "admin");
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("admin");
  });
});
