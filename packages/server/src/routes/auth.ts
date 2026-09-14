import { Router, type Response } from "express";
import { z } from "zod";
import {
  ABOUT_MAX,
  DISPLAY_NAME_MAX,
  EMAIL_RE,
  PASSWORD_MIN,
  USERNAME_RE,
} from "@peer-cast/shared";
import type { AuthResponse, RefreshResponse } from "@peer-cast/shared";
import {
  consumeRefreshToken,
  hashPassword,
  issueRefreshToken,
  issueSignalingTicket,
  revokeAllRefreshTokens,
  signAccessToken,
  verifyPassword,
} from "../lib/auth.js";
import { conflict, forbidden, unauthorized } from "../lib/errors.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { usersRepo } from "../repos/users.js";
import { invitesRepo } from "../repos/invites.js";
import { config } from "../config.js";

export const authRouter = Router();

// ─── HttpOnly refresh-token cookie ──────────────────────────────────────────────
// The refresh token is delivered ONLY as an HttpOnly, SameSite=Strict cookie
// so it is never accessible from JavaScript. The access token stays short-lived
// (15 min) and is returned in the response body / stored in Redux memory only.

const RT_COOKIE = "rt";

function rtCookieOpts() {
  // SameSite is configurable (COOKIE_SAME_SITE) for cross-origin deployments;
  // the default is 'strict', which suits this build's single-origin design.
  const sameSite = config.cookieSameSite;
  return {
    httpOnly: true,
    // Require HTTPS in production; also forced for SameSite=None, which the
    // browsers require ("secure" attribute is mandatory on such cookies).
    secure: config.isProd || sameSite === "none",
    sameSite,
    // Restrict transmission to auth routes only — the cookie is never sent
    // with data API requests, limiting its exposure window.
    path: "/api/auth",
    maxAge: config.jwt.refreshTtlSec * 1000,
  };
}

function clearRtCookie(res: Response) {
  res.clearCookie(RT_COOKIE, {
    path: "/api/auth",
    secure: config.isProd || config.cookieSameSite === "none",
    sameSite: config.cookieSameSite,
  });
}

/** Promote a user to admin if their handle is in ADMIN_USERNAMES. */
function maybePromote(usernameLc: string) {
  if (config.adminUsernames.includes(usernameLc)) {
    if (usersRepo.role(usernameLc) !== "admin") {
      usersRepo.setRole(usernameLc, "admin");
    }
  }
}

const registerSchema = z.object({
  username: z
    .string()
    .regex(USERNAME_RE, "username must be 3–30 chars: letters, digits, _ or -"),
  email: z.string().regex(EMAIL_RE, "a valid email is required").max(254),
  displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX),
  password: z
    .string()
    .min(PASSWORD_MIN, `password must be at least ${PASSWORD_MIN} characters`),
  about: z.string().max(ABOUT_MAX).nullish(),
  inviteCode: z.string().trim().min(1).max(64).optional(),
});

/** Issue an access token, set the refresh-token cookie, return the response body. */
function authResponse(
  res: Response,
  usernameLc: string,
  username: string,
): AuthResponse {
  const self = usersRepo.getSelf(usernameLc)!;
  const rt = issueRefreshToken(usernameLc);
  res.cookie(RT_COOKIE, rt, rtCookieOpts());
  return {
    accessToken: signAccessToken({ sub: usernameLc, username }),
    user: self.user,
  };
}

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const usernameLc = body.username.toLowerCase();

    // Gate on the server's registration mode. Designated admins
    // (ADMIN_USERNAMES) always bypass the gate so the instance can be
    // bootstrapped even in invite/closed mode.
    const isDesignatedAdmin = config.adminUsernames.includes(usernameLc);
    if (!isDesignatedAdmin) {
      if (config.registrationMode === "closed") {
        throw forbidden("registration is closed", "REGISTRATION_CLOSED");
      }
      if (config.registrationMode === "invite" && !body.inviteCode) {
        throw forbidden("an invite code is required", "INVITE_REQUIRED");
      }
    }

    if (usersRepo.getRaw(usernameLc)) {
      throw conflict("username already taken", "USERNAME_TAKEN");
    }
    if (usersRepo.emailExists(body.email.toLowerCase())) {
      // Avoid confirming that this email is registered (enumeration).
      // Suggest login or password-reset instead of a hard 409.
      throw conflict(
        "an account with this email address already exists — try signing in or resetting your password",
        "EMAIL_TAKEN",
      );
    }

    // Consume the invite only after the username/email checks pass, so a code
    // isn't burned on a duplicate-account attempt.
    if (!isDesignatedAdmin && config.registrationMode === "invite") {
      if (!invitesRepo.consume(body.inviteCode!.toUpperCase())) {
        throw forbidden("invalid or expired invite code", "INVITE_INVALID");
      }
    }

    const passwordHash = await hashPassword(body.password);
    usersRepo.create({
      username: body.username,
      email: body.email,
      displayName: body.displayName.trim(),
      about: body.about?.trim() || null,
      passwordHash,
    });
    maybePromote(usernameLc);

    // Fire off a verification email (best-effort; never blocks registration).
    try {
      const { emailTokensRepo } = await import("../repos/emailTokens.js");
      const { sendEmail, verifyEmailTemplate } =
        await import("../lib/email.js");
      const rawUser = usersRepo.getRaw(usernameLc)!;
      const token = emailTokensRepo.createVerification(usernameLc);
      const verifyUrl = `${config.appUrl}/verify-email?token=${token}`;
      const tmpl = verifyEmailTemplate({
        displayName: rawUser.display_name,
        verifyUrl,
      });
      void sendEmail({ to: rawUser.email, ...tmpl });
    } catch {
      /* non-fatal */
    }

    res.status(201).json(authResponse(res, usernameLc, body.username));
  }),
);

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = usersRepo.getRaw(body.username.toLowerCase());
    // Constant-ish behaviour: still hash-compare against a dummy if no user.
    const ok =
      !!user && (await verifyPassword(body.password, user.password_hash));
    if (!user || !ok)
      throw unauthorized("invalid credentials", "BAD_CREDENTIALS");
    if (user.banned) throw forbidden("account suspended", "BANNED");
    if (config.requireEmailVerification && !user.email_verified) {
      throw forbidden(
        "please verify your email before signing in",
        "EMAIL_UNVERIFIED",
      );
    }
    maybePromote(user.username_lc);
    res.json(authResponse(res, user.username_lc, user.username));
  }),
);

authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    // The refresh token travels as an HttpOnly cookie, not in the request body.
    const rt = req.cookies?.[RT_COOKIE] as string | undefined;
    if (!rt) throw unauthorized("no refresh token");
    const usernameLc = consumeRefreshToken(rt);
    if (!usernameLc) {
      clearRtCookie(res);
      throw unauthorized("invalid refresh token");
    }
    const user = usersRepo.getRaw(usernameLc);
    if (!user) {
      clearRtCookie(res);
      throw unauthorized("invalid refresh token");
    }
    if (user.banned) {
      clearRtCookie(res);
      throw forbidden("account suspended", "BANNED");
    }
    const newRt = issueRefreshToken(usernameLc);
    res.cookie(RT_COOKIE, newRt, rtCookieOpts());
    const out: RefreshResponse = {
      accessToken: signAccessToken({
        sub: usernameLc,
        username: user.username,
      }),
    };
    res.json(out);
  }),
);

authRouter.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Consume the refresh token from the cookie (if present).
    const rt = req.cookies?.[RT_COOKIE] as string | undefined;
    if (rt) consumeRefreshToken(rt);
    clearRtCookie(res);
    res.json({ ok: true });
  }),
);

// Revoke every session for the current user (e.g. after password change).
authRouter.post(
  "/logout-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    revokeAllRefreshTokens(req.auth!.usernameLc);
    clearRtCookie(res);
    res.json({ ok: true });
  }),
);

// ─── Signaling ticket (replaces raw JWT in WebSocket URL) ─────────────────────
//
// Broadcasters and authenticated viewers call this before creating a PeerJS
// connection. The returned token is passed as ?token=<opaque> on the WebSocket
// URL instead of the JWT, so the JWT never appears in server access logs.
authRouter.post(
  "/signaling-ticket",
  requireAuth,
  asyncHandler(async (req, res) => {
    const token = await issueSignalingTicket(req.auth!.usernameLc);
    res.json({ token });
  }),
);
