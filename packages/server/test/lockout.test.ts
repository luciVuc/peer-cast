/**
 * Regression guards for account lockout.
 *
 * The defect: the lockout fired after 20 failed logins in 30 minutes. The
 * counter only advances for an *existing* user, so anyone who knew a victim's
 * handle could lock that account on demand — 20 attempts is about three IP
 * addresses' worth of the 10/15min per-IP login budget. That is a
 * denial-of-service primitive against a named account, not a brute-force
 * defence, and it fails silently for the victim.
 *
 * The fix raises the threshold to 50/24h and emails the owner when it fires.
 * That costs no real brute-force protection: a single-source attacker is
 * stopped by the per-IP limiter long before 50 attempts (verified below), and
 * a distributed attacker is bounded by the bcrypt cost factor instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import { makeApp, resetDb } from "./helpers.js";
import { configureApp } from "../src/app.js";

const app: Express = makeApp();
const sendEmail = vi.fn(async () => {});

vi.mock("../src/lib/email.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Plain async fn, NOT vi.fn: vitest's mock wrapper attaches its own handler
    // to the returned promise, which would swallow a rejection. Plain here
    // because we only need to observe calls, and correctness of rejection
    // handling is covered by email-unhandled.test.ts.
    sendEmail: (opts: unknown) => {
      sendEmail(opts as { to: string });
      return actual.sendEmail(opts as never);
    },
    lockoutNoticeTemplate: () => ({
      subject: "locked",
      html: "<p>locked</p>",
      text: "locked",
    }),
  };
});

async function register(username: string) {
  await request(app)
    .post("/api/auth/register")
    .send({
      username,
      email: `${username}@example.com`,
      displayName: username,
      password: "correct-horse-1",
    })
    .expect(201);
}

const badLogin = (username: string) =>
  request(app)
    .post("/api/auth/login")
    .send({ username, password: "wrong-guess" });

describe("account lockout", () => {
  beforeEach(async () => {
    resetDb();
    sendEmail.mockClear();
    await register("alice");
    sendEmail.mockClear(); // drop the registration verification email
  });

  it("does not lock after the old 20-failure threshold", async () => {
    const { usersRepo } = await import("../src/repos/users.js");

    // Drive the repo directly: going through HTTP is blocked by the per-IP
    // limiter at 10/15min, which is itself part of the property under test.
    for (let i = 0; i < 20; i++) usersRepo.recordFailedLogin("alice");

    expect(usersRepo.isLocked("alice")).toBe(false);
    // …and the account still works.
    const ok = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "correct-horse-1" })
      .expect(200);
    expect(ok.body.accessToken).toBeTruthy();
  });

  it("emails the owner on the attempt that crosses the threshold", async () => {
    const { usersRepo } = await import("../src/repos/users.js");

    // One short of the threshold, then let the real HTTP path make the crossing
    // attempt. This matters: once `locked_until` is set, every later request
    // short-circuits on the `isLocked` guard before it ever reaches
    // recordFailedLogin, so the notification can only ever fire on the crossing
    // request itself. Driving all 50 through the repo (as a naive test would)
    // would skip the notification entirely.
    for (let i = 0; i < 49; i++) {
      expect(usersRepo.recordFailedLogin("alice")).toBe(false);
    }
    expect(usersRepo.isLocked("alice")).toBe(false);

    sendEmail.mockClear();
    await badLogin("alice");

    expect(usersRepo.isLocked("alice")).toBe(true);
    const notices = sendEmail.mock.calls.filter(
      (c) => (c[0] as { to: string }).to === "alice@example.com",
    );
    expect(notices).toHaveLength(1);
  });

  it("does not re-email on every attempt while already locked", async () => {
    const { usersRepo } = await import("../src/repos/users.js");
    for (let i = 0; i < 50; i++) usersRepo.recordFailedLogin("alice");

    sendEmail.mockClear();
    await badLogin("alice");
    await badLogin("alice");

    expect(sendEmail.mock.calls).toHaveLength(0);
  });

  it("reports the lock rather than pretending the password is wrong", async () => {
    const { usersRepo } = await import("../src/repos/users.js");
    for (let i = 0; i < 50; i++) usersRepo.recordFailedLogin("alice");

    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "correct-horse-1" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_LOCKED");
    // The message must state the real duration, not the old hardcoded 30 min.
    expect(String(res.body.error)).toContain("60 minutes");
  });

  it("clears the counter on a successful login", async () => {
    const { usersRepo } = await import("../src/repos/users.js");
    for (let i = 0; i < 10; i++) usersRepo.recordFailedLogin("alice");
    await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "correct-horse-1" })
      .expect(200);

    const row = usersRepo.getRaw("alice")!;
    expect(row.failed_logins).toBe(0);
    expect(row.locked_until).toBeNull();
  });
});

describe("lockout does not make brute force practical", () => {
  beforeEach(resetDb);

  it("stops a single-source attacker at the per-IP limiter first", async () => {
    const limited = configureApp(express(), {
      rateLimiting: true,
      quiet: true,
    });
    await request(limited)
      .post("/api/auth/register")
      .send({
        username: "bob",
        email: "bob@example.com",
        displayName: "bob",
        password: "correct-horse-1",
      })
      .expect(201);

    let throttled = 0;
    for (let i = 0; i < 15; i++) {
      const res = await request(limited)
        .post("/api/auth/login")
        .send({ username: "bob", password: `guess-${i}` });
      if (res.status === 429) throttled++;
    }
    // Login is 10/15min per IP, so the 50-failure lockout threshold is never
    // reachable from one address — the lockout is not the brute-force defence
    // and does not need to be.
    expect(throttled).toBeGreaterThan(0);

    const { usersRepo } = await import("../src/repos/users.js");
    expect(usersRepo.isLocked("bob")).toBe(false);
  });
});
