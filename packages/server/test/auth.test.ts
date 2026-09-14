import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { makeApp, resetDb, validUser, extractRtCookie } from "./helpers.js";

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

  it("rejects a duplicate username (409 USERNAME_TAKEN)", async () => {
    await request(app).post("/api/auth/register").send(validUser);
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, email: "other@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("USERNAME_TAKEN");
  });

  it("rejects a duplicate email (409 EMAIL_TAKEN)", async () => {
    await request(app).post("/api/auth/register").send(validUser);
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, username: "alice2" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMAIL_TAKEN");
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

  it("rotates refresh tokens via cookie and revokes the old one", async () => {
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

    // The original cookie's token is now consumed — reuse must be rejected.
    const reuse = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", cookie);
    expect(reuse.status).toBe(401);

    // The new cookie still works.
    const r2 = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", newCookie);
    expect(r2.status).toBe(200);
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
