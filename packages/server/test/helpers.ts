import express from "express";
import { configureApp } from "../src/app.js";
import { db } from "../src/db/index.js";

/** Build a fresh Express app with rate limiting off and no signaling. */
export function makeApp() {
  return configureApp(express(), { rateLimiting: false, quiet: true });
}

/** Wipe every table so each test starts from a clean slate. */
export function resetDb() {
  db.exec(`
    DELETE FROM tickets;
    DELETE FROM refresh_tokens;
    DELETE FROM broadcasts;
    DELETE FROM reports;
    DELETE FROM invites;
    DELETE FROM email_verifications;
    DELETE FROM password_resets;
    DELETE FROM email_changes;
    DELETE FROM follows;
    DELETE FROM push_subscriptions;
    DELETE FROM recordings;
    DELETE FROM users;
  `);
}

/**
 * Extract the HttpOnly refresh-token cookie value from a supertest response.
 * Returns the full `Set-Cookie` header string so it can be passed to
 * `.set('Cookie', cookie)` on subsequent requests.
 */
export function extractRtCookie(res: {
  headers: Record<string, unknown>;
}): string {
  const raw = res.headers["set-cookie"];
  const arr = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
  return arr.find((c: string) => c.startsWith("rt=")) ?? "";
}

export const validUser = {
  username: "alice",
  email: "alice@example.com",
  displayName: "Alice Johnson",
  password: "secret123",
};
