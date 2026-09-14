import nodemailer from "nodemailer";
import { config } from "../config.js";

/**
 * Send transactional email via SMTP (Nodemailer).
 *
 * If SMTP is not configured (`SMTP_HOST` unset) the email body is printed to
 * stdout instead of sent — zero setup needed for dev or single-operator
 * instances where the admin can read server logs.
 */

let _transport: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransport() {
  if (_transport) return _transport;
  if (!config.email.enabled) return null;
  _transport = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: config.email.user
      ? { user: config.email.user, pass: config.email.pass }
      : undefined,
  });
  return _transport;
}

export interface MailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(opts: MailOptions): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    // Stdout fallback: useful in dev + single-operator self-hosted setups.
    console.log(
      `\n[email] ─────────────────────────────────────\n` +
        `To:      ${opts.to}\n` +
        `Subject: ${opts.subject}\n` +
        `─────────────────────────────────────────────\n` +
        `${opts.text}\n` +
        `─────────────────────────────────────────────\n`,
    );
    return;
  }
  await transport.sendMail({
    from: config.email.from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });
}

// ─── Templates ───────────────────────────────────────────────────────────────

/** Escape user-controlled strings before interpolating into email HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrap(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e2e8f0;margin:0;padding:40px 20px}
    .card{max-width:520px;margin:0 auto;background:#111a2e;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:32px}
    h1{margin:0 0 16px;font-size:22px;color:#fff}
    p{margin:0 0 16px;line-height:1.6;color:#94a3b8}
    .btn{display:inline-block;padding:12px 28px;background:#0ea5e9;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px}
    .note{font-size:12px;color:#475569}
    code{background:#0b1220;padding:4px 8px;border-radius:4px;font-size:14px;color:#38bdf8}
  </style>
</head>
<body>
  <div class="card">
    <h1>${config.appName}</h1>
    ${body}
    <p class="note" style="margin-top:32px">
      If you didn't request this, you can safely ignore this email.
    </p>
  </div>
</body>
</html>`;
}

export function verifyEmailTemplate(opts: {
  displayName: string;
  verifyUrl: string;
}) {
  const name = esc(opts.displayName);
  const html = wrap(
    "Verify your email",
    `<p>Hi ${name},</p>
     <p>Please verify your email address to complete your PeerCast account setup.</p>
     <p><a class="btn" href="${esc(opts.verifyUrl)}">Verify email address</a></p>
     <p class="note">This link expires in 24 hours. You can still use your account while unverified.</p>`,
  );
  const text =
    `Hi ${opts.displayName},\n\n` +
    `Please verify your email:\n${opts.verifyUrl}\n\n` +
    `This link expires in 24 hours.\n`;
  return { html, text, subject: `Verify your ${config.appName} email` };
}

export function resetPasswordTemplate(opts: {
  displayName: string;
  resetUrl: string;
}) {
  const name = esc(opts.displayName);
  const html = wrap(
    "Reset your password",
    `<p>Hi ${name},</p>
     <p>Someone (hopefully you) requested a password reset for your PeerCast account.</p>
     <p><a class="btn" href="${esc(opts.resetUrl)}">Reset password</a></p>
     <p class="note">This link expires in 1 hour and can only be used once.</p>`,
  );
  const text =
    `Hi ${opts.displayName},\n\n` +
    `Reset your password:\n${opts.resetUrl}\n\n` +
    `This link expires in 1 hour.\n`;
  return { html, text, subject: `Reset your ${config.appName} password` };
}

export function emailChangeTemplate(opts: {
  displayName: string;
  newEmail: string;
  confirmUrl: string;
}) {
  const name = esc(opts.displayName);
  const html = wrap(
    "Confirm your email change",
    `<p>Hi ${name},</p>
     <p>You asked to switch your ${config.appName} account to a new email address:</p>
     <p><code>${esc(opts.newEmail)}</code></p>
     <p>Click below to confirm. Until you do, your current address stays active.</p>
     <p><a class="btn" href="${esc(opts.confirmUrl)}">Confirm new email</a></p>
     <p class="note">This link expires in 24 hours and can only be used once.</p>`,
  );
  const text =
    `Hi ${opts.displayName},\n\n` +
    `Confirm switching your ${config.appName} email to: ${opts.newEmail}\n\n` +
    `${opts.confirmUrl}\n\n` +
    `This link expires in 24 hours.\n`;
  return { html, text, subject: `Confirm your ${config.appName} email change` };
}
