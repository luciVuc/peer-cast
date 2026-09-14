/**
 * Email verification + password reset + email-change routes.
 *
 * POST /auth/send-verification      Re-send the verification email.
 * GET  /auth/verify-email?token     Click the link → mark email verified.
 * POST /auth/forgot-password        Send a password-reset email.
 * POST /auth/reset-password         Consume token + set a new password.
 * POST /auth/change-email           Request a verified email change.
 * GET  /auth/verify-email-change?token  Confirm the new address → apply it.
 */

import { Router } from "express";
import { z } from "zod";
import { PASSWORD_MIN } from "@peer-cast/shared";
import {
  hashPassword,
  revokeAllRefreshTokens,
  verifyPassword,
} from "../lib/auth.js";
import {
  emailChangeTemplate,
  resetPasswordTemplate,
  sendEmail,
  verifyEmailTemplate,
} from "../lib/email.js";
import { badRequest, conflict } from "../lib/errors.js";
import { asyncHandler } from "../middleware/error.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { emailTokensRepo } from "../repos/emailTokens.js";
import { usersRepo } from "../repos/users.js";
import { config } from "../config.js";

export const emailRouter = Router();

// ─── Send / resend verification ────────────────────────────────────────────

emailRouter.post(
  "/send-verification",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = usersRepo.getRaw(req.auth!.usernameLc);
    if (!user) return res.json({ ok: true }); // silent
    if (user.email_verified) {
      return res.json({ ok: true, alreadyVerified: true });
    }
    const token = emailTokensRepo.createVerification(req.auth!.usernameLc);
    const verifyUrl = `${config.appUrl}/verify-email?token=${token}`;
    const tmpl = verifyEmailTemplate({
      displayName: user.display_name,
      verifyUrl,
    });
    // Fire-and-forget: a send failure must never block or fail the response.
    void sendEmail({ to: user.email, ...tmpl }).catch(() => {});
    res.json({ ok: true });
  }),
);

emailRouter.get(
  "/verify-email",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const token = String(req.query.token ?? "");
    if (!token) throw badRequest("token required");
    const usernameLc = emailTokensRepo.consumeVerification(token);
    if (!usernameLc) {
      // Respond with a redirect so clicking the link in an email lands on
      // the right page rather than a raw JSON 404.
      return res.redirect(`${config.appUrl}/verify-email?status=invalid`);
    }
    usersRepo.markEmailVerified(usernameLc);
    res.redirect(`${config.appUrl}/verify-email?status=ok`);
  }),
);

// ─── Change email (confirm the new address before applying it) ───────────────

const changeEmailSchema = z.object({
  newEmail: z.string().email(),
  currentPassword: z.string().min(1),
});

emailRouter.post(
  "/change-email",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = changeEmailSchema.safeParse(req.body);
    if (!parsed.success)
      throw badRequest("newEmail and currentPassword are required");
    const user = usersRepo.getRaw(req.auth!.usernameLc);
    if (!user) throw badRequest("user not found");
    // Re-authenticate with the current password: a hijacked JWT must not be
    // enough to reroute a victim's verified recovery address.
    const ok = await verifyPassword(
      parsed.data.currentPassword,
      user.password_hash,
    );
    if (!ok) throw badRequest("current password is incorrect", "BAD_PASSWORD");
    const newEmail = parsed.data.newEmail.toLowerCase();
    if (newEmail === user.email) {
      throw badRequest("that is already your email address", "EMAIL_SAME");
    }
    if (usersRepo.emailExists(newEmail)) {
      // Same-user rejects above; reach here only when owned by someone else.
      throw conflict("email is already in use", "EMAIL_TAKEN");
    }
    const token = emailTokensRepo.createEmailChange(
      req.auth!.usernameLc,
      newEmail,
    );
    const confirmUrl = `${config.appUrl}/verify-email-change?token=${token}`;
    const tmpl = emailChangeTemplate({
      displayName: user.display_name,
      newEmail,
      confirmUrl,
    });
    // Fire-and-forget: a send failure must never fail the request.
    void sendEmail({ to: newEmail, ...tmpl }).catch(() => {});
    res.json({ ok: true });
  }),
);

emailRouter.get(
  "/verify-email-change",
  asyncHandler(async (req, res) => {
    const token = String(req.query.token ?? "");
    if (!token) throw badRequest("token required");
    const pending = emailTokensRepo.consumeEmailChange(token);
    if (!pending) {
      return res.redirect(
        `${config.appUrl}/verify-email-change?status=invalid`,
      );
    }
    // Safety race: the pending address could have been claimed by another
    // registration in the 24 h window. Refuse the change if so.
    if (usersRepo.emailExists(pending.new_email)) {
      return res.redirect(`${config.appUrl}/verify-email-change?status=taken`);
    }
    usersRepo.setEmail(pending.username_lc, pending.new_email);
    // The recovery address changed: it must be re-verified out-of-band, so
    // every existing session (refresh tokens) is revoked. The confirmation
    // link itself needs no auth, so this doesn't break the click.
    revokeAllRefreshTokens(pending.username_lc);
    res.redirect(`${config.appUrl}/verify-email-change?status=ok`);
  }),
);

// ─── Forgot / reset password ─────────────────────────────────────────────

const forgotSchema = z.object({ email: z.string().email() });

emailRouter.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    // Always respond 200 so we don't leak whether an email exists.
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) return res.json({ ok: true });
    const emailLc = parsed.data.email.toLowerCase();
    const rows = usersRepo.findByEmail(emailLc);
    if (rows) {
      const token = emailTokensRepo.createReset(rows.username_lc);
      const resetUrl = `${config.appUrl}/reset-password?token=${token}`;
      const tmpl = resetPasswordTemplate({
        displayName: rows.display_name,
        resetUrl,
      });
      // Fire-and-forget: this endpoint always returns 200 to prevent email
      // enumeration, so a send failure must never change the response.
      void sendEmail({ to: rows.email, ...tmpl }).catch(() => {});
    }
    res.json({ ok: true });
  }),
);

const resetSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN),
});

emailRouter.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const { token, newPassword } = resetSchema.parse(req.body);
    const usernameLc = emailTokensRepo.consumeReset(token);
    if (!usernameLc)
      throw badRequest("invalid or expired reset link", "TOKEN_INVALID");
    usersRepo.setPassword(usernameLc, await hashPassword(newPassword));
    // Revoke all existing sessions so the old password can't be used.
    revokeAllRefreshTokens(usernameLc);
    res.json({ ok: true });
  }),
);
