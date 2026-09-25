import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { forbidden } from "../lib/errors.js";

/**
 * Lightweight CSRF guard for cookie-dependent endpoints.
 *
 * Strategy: Origin / Referer check (double-submit not required because the
 * access token in the Authorization header already makes these endpoints CSRF-
 * safe for JS callers; the cookie path is the only vulnerable surface).
 *
 * Logic:
 *  1. Skip entirely when COOKIE_SAME_SITE is "strict" — the browser handles
 *     CSRF natively in that mode.
 *  2. GET / HEAD / OPTIONS are safe methods — skip.
 *  3. Read the `Origin` header (set by browsers on cross-origin requests) or
 *     fall back to the `Referer` header.
 *  4. If neither header is present the request is treated as same-origin
 *     (older same-origin XHR / fetch omits both; it's a safe assumption here
 *     because an attacker form cannot suppress Origin on modern browsers).
 *  5. If an Origin/Referer IS present but its hostname doesn't match the
 *     request's `Host`, reject with 403 CSRF.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  // SameSite=Strict: browser already refuses cross-origin cookie sends.
  if (config.cookieSameSite === "strict") return next();

  // Safe HTTP methods carry no state-changing risk.
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS")
    return next();

  const origin = req.get("Origin") || req.get("Referer");
  // No origin header — treat as same-origin (safe).
  if (!origin) return next();

  try {
    const url = new URL(origin);
    const host = req.get("Host") || "";
    // Strip port from Host for bare-hostname comparison.
    const expectedHostname = host.split(":")[0];
    if (url.hostname === expectedHostname) return next();
  } catch {
    // Malformed Origin/Referer — reject.
  }

  next(forbidden("cross-origin request blocked", "CSRF"));
}
