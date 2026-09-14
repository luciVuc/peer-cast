/**
 * Message protocol between the extension's popup / background / offscreen
 * contexts and the PeerCast backend. Re-exported for the extension package.
 */

export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,30}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PASSWORD_MIN = 8;
export const DISPLAY_NAME_MAX = 80;
export const ABOUT_MAX = 500;
export const TITLE_MAX = 120;
/** Minimum length for user-chosen broadcast access codes. */
export const ACCESS_CODE_MIN = 6;
/** Maximum length of a single chat line (P2P; enforced on send + relay). */
export const CHAT_MAX_LENGTH = 500;

export function isValidUsername(v: unknown): v is string {
  return typeof v === "string" && USERNAME_RE.test(v);
}

export function isValidEmail(v: unknown): v is string {
  return typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v);
}
