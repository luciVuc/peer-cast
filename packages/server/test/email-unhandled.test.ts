/**
 * Regression guard: a failed verification email must never escape as an
 * unhandled rejection during registration.
 *
 * Registration fires the verification email best-effort (AGENTS.md rule 19:
 * email must never affect the HTTP response). The original code was:
 *
 *     try   { … void sendEmail({ to, ...tmpl }); }
 *     catch { /* non-fatal *\/ }
 *
 * sendEmail is `async`, so that try/catch only catches *synchronous* throws.
 * A transport-level failure — SMTP host refuses the connection, missing
 * STARTTLS, greylisting, DNS blackhole — rejects the returned promise instead,
 * which escapes as an unhandled rejection. Node >= 15 (this repo requires >= 20)
 * defaults to `--unhandled-rejections=throw` and terminates the process, so a
 * single misconfigured SMTP host made every registration kill the server and
 * take down all live broadcasts and signaling with it.
 *
 * Two deliberate choices make this guard real rather than decorative:
 *
 *   - `lib/email.js` is mocked with *plain* functions, not `vi.fn`. Vitest's
 *     mock wrapper attaches its own handler to the promise it returns for call
 *     tracking, which silently swallows the rejection — a `vi.fn` mock makes
 *     this test pass even against the buggy code.
 *   - The listener is registered before the request, and we wait a macrotask
 *     turn so Node's end-of-tick unhandled-rejection detection has run.
 */
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import { configureApp } from "../src/app.js";
import { db } from "../src/db/index.js";

const rejections: string[] = [];

vi.mock("../src/lib/email.js", () => ({
  // Plain async function: rejects the way a dead SMTP host does.
  sendEmail: async () => {
    throw new Error("SMTP connection refused");
  },
  verifyEmailTemplate: () => ({
    subject: "Verify",
    html: "<p>hi</p>",
    text: "hi",
  }),
  resetTransporter: () => {},
}));

describe("registration with a failing mail transport", () => {
  it("returns 201 and raises no unhandled rejection", async () => {
    db.exec("DELETE FROM users; DELETE FROM email_verifications;");
    rejections.length = 0;

    const onUnhandled = (reason: unknown) => {
      rejections.push(String(reason));
    };
    process.on("unhandledRejection", onUnhandled);

    const app = configureApp(express(), { rateLimiting: false, quiet: true });

    try {
      const res = await request(app).post("/api/auth/register").send({
        username: "smtp-fail",
        email: "smtp-fail@example.com",
        displayName: "SMTP Fail",
        password: "secret123",
      });

      // Registration itself must succeed — a mail outage is not a reason to
      // refuse an account (AGENTS.md rule 19).
      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBeTruthy();

      // Let the rejected promise settle and Node's unhandled-rejection
      // detection run.
      await new Promise((r) => setTimeout(r, 150));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
