import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
import { makeApp, resetDb, validUser, extractRtCookie } from "./helpers.js";
import { db } from "../src/db/index.js";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

const app = makeApp();

beforeEach(() => resetDb());

describe("auth", () => {
  it("registers a new user and returns access token + user (no refreshToken in body)", async () => {
    const res = await request(app).post("/api/auth/register").send(validUser);
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    // Refresh token must NOT be in the body — it lives in an HttpOnly cookie.
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.user.username).toBe("alice");
    expect(res.body.user.email).toBe("alice@example.com");
    // Never leak the password hash.
    expect(res.body.user.passwordHash).toBeUndefined();
    // The HttpOnly cookie must be set.
    const cookie = extractRtCookie(res);
    expect(cookie).toBeTruthy();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/auth");
  });

  it("rejects a duplicate username (409 ACCOUNT_EXISTS)", async () => {
    await request(app).post("/api/auth/register").send(validUser);
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, email: "other@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNT_EXISTS");
  });

  it("rejects a duplicate email indistinguishably (409 ACCOUNT_EXISTS, no EMAIL_TAKEN)", async () => {
    await request(app).post("/api/auth/register").send(validUser);
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, username: "alice2" });
    // The response must be byte-for-byte identical to the username-collision
    // case so an anonymous probe cannot tell whether an email is registered.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNT_EXISTS");
    expect(res.body.error).toBe(
      "an account already exists with that username or email",
    );
  });

  it("validates input (short password → 400)", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, password: "short" });
    expect(res.status).toBe(400);
  });

  it("logs in with correct credentials and rejects wrong ones", async () => {
    await request(app).post("/api/auth/register").send(validUser);

    const ok = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "secret123" });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.refreshToken).toBeUndefined();
    const cookie = extractRtCookie(ok);
    expect(cookie).toBeTruthy();

    const bad = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "wrong" });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe("BAD_CREDENTIALS");

    // unknown user is also 401 (no user enumeration)
    const nouser = await request(app)
      .post("/api/auth/login")
      .send({ username: "ghost", password: "whatever" });
    expect(nouser.status).toBe(401);
  });

  it("rotates refresh tokens and survives a concurrent replay from a sibling tab", async () => {
    const reg = await request(app).post("/api/auth/register").send(validUser);
    const cookie = extractRtCookie(reg);

    // Refresh using the cookie — no request body needed.
    const r1 = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", cookie);
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toBeTruthy();
    expect(r1.body.refreshToken).toBeUndefined();
    const newCookie = extractRtCookie(r1);
    expect(newCookie).toBeTruthy();

    // Two tabs of the PWA share one refresh cookie, so both can present the
    // SAME token moments apart. That is a benign race, not theft: the session
    // must survive, and the freshly issued token must keep working.
    const replay = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", cookie);
    expect(replay.status).toBe(200);
    expect(replay.body.accessToken).toBeTruthy();
    const familyAlive = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", newCookie);
    expect(familyAlive.status).toBe(200);
  });

  it("revokes the whole family when a consumed token is replayed after the grace window", async () => {
    const reg = await request(app).post("/api/auth/register").send(validUser);
    const cookie = extractRtCookie(reg);
    const rtValue = cookie.split(";")[0].slice("rt=".length);

    const r1 = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", cookie);
    expect(r1.status).toBe(200);
    const newCookie = extractRtCookie(r1);

    // Backdate the rotation past the concurrent-replay grace window, standing
    // in for a stolen cookie presented well after the fact.
    db.prepare(
      `UPDATE refresh_tokens SET consumed_at = ?
       WHERE token_hash = ?`,
    ).run(Date.now() - 60_000, sha256(rtValue));

    // Replaying an already-consumed token is then a token-theft signal: the
    // server revokes the ENTIRE rotation family, killing even the fresh token
    // that the legit client was issued a moment ago.
    const reuse = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", cookie);
    expect(reuse.status).toBe(401);
    const familyDead = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", newCookie);
    expect(familyDead.status).toBe(401);

    // A fresh login starts a NEW family and works again.
    const relogin = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "secret123" });
    expect(relogin.status).toBe(200);
    const freshCookie = extractRtCookie(relogin);
    expect(freshCookie).toBeTruthy();
    const r2 = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", freshCookie);
    expect(r2.status).toBe(200);
  });

  it("password change invalidates outstanding access JWTs (token version)", async () => {
    const reg = await request(app).post("/api/auth/register").send(validUser);
    const oldToken = reg.body.accessToken as string;
    const oldCookie = extractRtCookie(reg);

    const me = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${oldToken}`);
    expect(me.status).toBe(200);

    await request(app)
      .put("/api/users/me/password")
      .set("Authorization", `Bearer ${oldToken}`)
      .send({ currentPassword: "secret123", newPassword: "brandnew456" });

    // The old access JWT is dead immediately (not just after the 15-min TTL).
    const stale = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${oldToken}`);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe("TOKEN_STALE");

    // The refresh cookie is revoked too.
    const refreshed = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", oldCookie);
    expect(refreshed.status).toBe(401);

    // New credentials issue a fresh, working session.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "brandnew456" });
    expect(login.status).toBe(200);
    const me2 = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(me2.status).toBe(200);
  });

  it("refresh with no cookie returns 401", async () => {
    const res = await request(app).post("/api/auth/refresh");
    expect(res.status).toBe(401);
  });

  it("guards /users/me behind a valid access token", async () => {
    const reg = await request(app).post("/api/auth/register").send(validUser);

    const noauth = await request(app).get("/api/users/me");
    expect(noauth.status).toBe(401);

    const authed = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${reg.body.accessToken}`);
    expect(authed.status).toBe(200);
    expect(authed.body.user.username).toBe("alice");
    expect(authed.body.settings.defaultAccess).toBe("public");
  });
});
