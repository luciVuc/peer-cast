import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import { configureApp } from "../src/app.js";
import { extractRtCookie, makeApp, resetDb, validUser } from "./helpers.js";
import { config } from "../src/config.js";
import { emailTokensRepo } from "../src/repos/emailTokens.js";
import { usersRepo } from "../src/repos/users.js";

const app = makeApp();

beforeEach(() => resetDb());
afterEach(() => vi.useRealTimers());

async function register() {
  const res = await request(app).post("/api/auth/register").send(validUser);
  return { token: res.body.accessToken as string, res };
}

describe("email verification", () => {
  it("registers with emailVerified=false", async () => {
    const { res } = await register();
    expect(res.body.user.emailVerified).toBe(false);
  });

  it("GET /verify-email?token= marks the user verified and redirects", async () => {
    await register();
    const token = emailTokensRepo.createVerification("alice");
    const res = await request(app).get(`/api/auth/verify-email?token=${token}`);
    // Server redirects to the app URL.
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("status=ok");
    const raw = usersRepo.getRaw("alice");
    expect(raw?.email_verified).toBe(1);
  });

  it("invalid token redirects to status=invalid", async () => {
    const res = await request(app).get("/api/auth/verify-email?token=badtoken");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("status=invalid");
  });

  it("expired token is rejected", async () => {
    await register();
    // Insert an already-expired verification token directly (deterministic —
    // no fake timers that can bleed across tests in the shared process).
    const { db } = await import("../src/db/index.js");
    const expiredToken = "expired-verify-token-abc123";
    db.prepare(
      `INSERT INTO email_verifications (token, username_lc, expires_at)
       VALUES (?, ?, ?)`,
    ).run(expiredToken, "alice", Date.now() - 1);
    const res = await request(app).get(
      `/api/auth/verify-email?token=${expiredToken}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("status=invalid");
  });

  it("send-verification resends a new token (authed endpoint)", async () => {
    const { token } = await register();
    const res = await request(app)
      .post("/api/auth/send-verification")
      .set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("REQUIRE_EMAIL_VERIFICATION blocks unverified login when enabled", async () => {
    (config as { requireEmailVerification: boolean }).requireEmailVerification =
      true;
    await register();
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "secret123" });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe("EMAIL_UNVERIFIED");

    // After verification, login works.
    usersRepo.markEmailVerified("alice");
    const ok = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "secret123" });
    expect(ok.status).toBe(200);
    (config as { requireEmailVerification: boolean }).requireEmailVerification =
      false;
  });
});

describe("password reset", () => {
  it("forgot-password always returns 200 (no email enumeration)", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "nobody@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("reset-password with valid token sets a new password", async () => {
    const { token } = await register();
    const reset = emailTokensRepo.createReset("alice");
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: reset, newPassword: "newpassword123" });
    expect(res.status).toBe(200);

    // Old password rejected.
    const oldLogin = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "secret123" });
    expect(oldLogin.status).toBe(401);

    // The pre-reset access JWT is invalidated immediately (token version bump).
    const stale = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${token}`);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe("TOKEN_STALE");

    // New password works.
    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "newpassword123" });
    expect(newLogin.status).toBe(200);
  });

  it("token is single-use — second use fails", async () => {
    await register();
    const token = emailTokensRepo.createReset("alice");
    await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "newpass123!" });
    const reuse = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "anotherpass1!" });
    expect(reuse.status).toBe(400);
    expect(reuse.body.code).toBe("TOKEN_INVALID");
  });

  it("expired token is rejected", async () => {
    await register();
    // Insert an already-expired reset token directly.
    const { db } = await import("../src/db/index.js");
    const expiredToken = "expired-test-token-abc123";
    db.prepare(
      `INSERT INTO password_resets (token, username_lc, expires_at) VALUES (?, ?, ?)`,
    ).run(expiredToken, "alice", Date.now() - 1);
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: expiredToken, newPassword: "latepass123!" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_INVALID");
  });
});

describe("email change", () => {
  it("requires an authenticated session", async () => {
    const res = await request(app)
      .post("/api/auth/change-email")
      .send({ newEmail: "new@example.com" });
    expect(res.status).toBe(401);
  });

  it("rejects the current email and an email owned by someone else", async () => {
    const { token } = await register();
    const same = await request(app)
      .post("/api/auth/change-email")
      .set({ Authorization: `Bearer ${token}` })
      .send({ newEmail: validUser.email, currentPassword: "secret123" });
    expect(same.status).toBe(400);
    expect(same.body.code).toBe("EMAIL_SAME");

    await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, username: "bob", email: "bob@example.com" });
    const taken = await request(app)
      .post("/api/auth/change-email")
      .set({ Authorization: `Bearer ${token}` })
      .send({ newEmail: "bob@example.com", currentPassword: "secret123" });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("EMAIL_TAKEN");
  });

  it("keeps the old email until the confirmation link is clicked", async () => {
    const { token } = await register();
    const req = await request(app)
      .post("/api/auth/change-email")
      .set({ Authorization: `Bearer ${token}` })
      .send({ newEmail: "NEW@example.com", currentPassword: "secret123" });
    expect(req.status).toBe(200);
    expect(req.body.ok).toBe(true);

    // The email is NOT applied yet.
    const me = await request(app)
      .get("/api/users/me")
      .set({ Authorization: `Bearer ${token}` });
    expect(me.body.user.email).toBe("alice@example.com");

    const changeToken = emailTokensRepo.createEmailChange(
      "alice",
      "new@example.com",
    );
    const res = await request(app).get(
      `/api/auth/verify-email-change?token=${changeToken}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("status=ok");

    const updated = await request(app)
      .get("/api/users/me")
      .set({ Authorization: `Bearer ${token}` });
    expect(updated.status).toBe(401); // session revoked on the identity change

    // A fresh login sees the new address.
    const relogin = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "secret123" });
    expect(relogin.status).toBe(200);
    const fresh = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${relogin.body.accessToken}`);
    expect(fresh.body.user.email).toBe("new@example.com");
    expect(fresh.body.user.emailVerified).toBe(true);
  });

  it("confirmation token is single-use — the replay is rejected", async () => {
    await register();
    const changeToken = emailTokensRepo.createEmailChange(
      "alice",
      "new@example.com",
    );
    await request(app).get(
      `/api/auth/verify-email-change?token=${changeToken}`,
    );
    const replay = await request(app).get(
      `/api/auth/verify-email-change?token=${changeToken}`,
    );
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toContain("status=invalid");
  });

  it("expired confirmation token is rejected", async () => {
    await register();
    const changeToken = "expired-change-token-abc123";
    const { db } = await import("../src/db/index.js");
    db.prepare(
      `INSERT INTO email_changes (token, username_lc, new_email, expires_at)
       VALUES (?, ?, ?, ?)`,
    ).run(changeToken, "alice", "new@example.com", Date.now() - 1);
    const res = await request(app).get(
      `/api/auth/verify-email-change?token=${changeToken}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("status=invalid");
  });

  it("pending new email claimed by another registration is refused", async () => {
    await register();
    const changeToken = emailTokensRepo.createEmailChange(
      "alice",
      "new@example.com",
    );
    await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, username: "bob", email: "new@example.com" });
    const res = await request(app).get(
      `/api/auth/verify-email-change?token=${changeToken}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("status=taken");
  });

  it("requires the current password to request a change", async () => {
    const { token } = await register();
    const missing = await request(app)
      .post("/api/auth/change-email")
      .set({ Authorization: `Bearer ${token}` })
      .send({ newEmail: "new@example.com" });
    expect(missing.status).toBe(400);

    const wrong = await request(app)
      .post("/api/auth/change-email")
      .set({ Authorization: `Bearer ${token}` })
      .send({ newEmail: "new@example.com", currentPassword: "wrong-password" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("BAD_PASSWORD");
  });

  it("accepts a valid current password and revokes sessions on confirmation", async () => {
    const { token, res } = await register();
    const rtCookie = extractRtCookie(res);

    // Request the change (password gate passes).
    const req = await request(app)
      .post("/api/auth/change-email")
      .set({ Authorization: `Bearer ${token}` })
      .send({ newEmail: "new@example.com", currentPassword: "secret123" });
    expect(req.status).toBe(200);

    // Confirm the link → the refresh token is revoked.
    const changeToken = emailTokensRepo.createEmailChange(
      "alice",
      "new@example.com",
    );
    await request(app).get(
      `/api/auth/verify-email-change?token=${changeToken}`,
    );

    const refreshed = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", rtCookie);
    expect(refreshed.status).toBe(401);
    // The access JWT is also dead: the identity change bumps the token version.
    const me = await request(app)
      .get("/api/users/me")
      .set({ Authorization: `Bearer ${token}` });
    expect(me.status).toBe(401);
    expect(me.body.code).toBe("TOKEN_STALE");

    // Fresh login confirms the session was really revoked, and the new email.
    const relogin = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "secret123" });
    expect(relogin.status).toBe(200);
    const freshMe = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${relogin.body.accessToken}`);
    expect(freshMe.body.user.email).toBe("new@example.com");
  });
});

describe("email rate limits (rate limiting enabled)", () => {
  // Each test builds a fresh app so the in-memory limiter counters never bleed
  // across cases. Routing logic is short-circuited by the limiters, so no
  // account registration is needed — the requests never reach payload parsing.
  const rateApp = () =>
    configureApp(express(), { rateLimiting: true, quiet: true });

  it("reset-password: 10/h per IP", async () => {
    const a = rateApp();
    for (let i = 0; i < 10; i++) {
      const r = await request(a)
        .post("/api/auth/reset-password")
        .send({ token: `spent-${i}`, newPassword: "newpass123!" });
      expect(r.status).toBe(400); // invalid token, but counted
    }
    const blocked = await request(a)
      .post("/api/auth/reset-password")
      .send({ token: "spent-10", newPassword: "newpass123!" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("RATE_LIMITED");
  });

  it("verify-email: 30/h per IP", async () => {
    const a = rateApp();
    let last = 0;
    for (let i = 0; i < 30; i++) {
      last = (await request(a).get("/api/auth/verify-email?token=nope")).status;
    }
    expect(last).toBe(302); // all 30 were handled
    const blocked = await request(a).get("/api/auth/verify-email?token=nope");
    expect(blocked.status).toBe(429);
  });

  it("change-email: 5/h per IP", async () => {
    const a = rateApp();
    // Each request uses a distinct target address so only the per-IP limiter
    // accumulates (the ce-email secondary limiter would otherwise cap at 3).
    for (let i = 0; i < 5; i++) {
      const r = await request(a)
        .post("/api/auth/change-email")
        .send({ newEmail: `a${i}@example.com`, currentPassword: "x" });
      expect(r.status).toBe(401); // unauthenticated, but counted
    }
    const blocked = await request(a)
      .post("/api/auth/change-email")
      .send({ newEmail: "a@example.com", currentPassword: "x" });
    expect(blocked.status).toBe(429);
  });
});
