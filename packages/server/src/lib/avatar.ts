/**
 * Avatar storage: decode an incoming base64 data URL, write it to disk, and
 * return a server-relative URL that can be stored in the DB and served to
 * clients with HTTP caching.
 *
 * Files live at:  <DB_DIR>/avatars/<username_lc>.<ext>
 * Served at:      /api/avatars/<username_lc>.<ext>?v=<timestamp>
 *
 * The ?v= cache-buster is embedded in the URL so each upload is treated as a
 * fresh asset by browsers/CDNs while still being immutably cacheable.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { config } from "../config.js";

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Absolute path to the avatars directory (created on first use). */
export function avatarDir(): string {
  const dir = resolve(dirname(config.db.file), "avatars");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Decode a data URL and persist the image file.
 * Returns the server-relative URL to store as avatar_url.
 * Throws if the data URL is malformed or has an unsupported MIME type.
 */
export function saveAvatar(usernameLc: string, dataUrl: string): string {
  const match = dataUrl.match(
    /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/is,
  );
  if (!match) throw new Error("invalid avatar data URL");
  const mime = match[1].toLowerCase().replace("jpeg", "jpg");
  const ext = MIME_TO_EXT[mime] ?? "png";
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");

  const dir = avatarDir();
  const filename = `${usernameLc}.${ext}`;
  const filepath = resolve(dir, filename);

  // Verify the resolved path stays inside the avatars directory.
  if (!filepath.startsWith(dir + "/") && filepath !== dir) {
    throw new Error("path escape detected");
  }

  // Remove any previously stored avatar in other formats.
  for (const oldExt of Object.values(MIME_TO_EXT)) {
    if (oldExt !== ext) {
      rmSync(resolve(dir, `${usernameLc}.${oldExt}`), { force: true });
    }
  }

  writeFileSync(filepath, buffer);

  // Include a timestamp cache-buster so clients fetch the new file on update.
  return `/api/avatars/${filename}?v=${Date.now()}`;
}

/** Delete all avatar files for a user (called on profile clear or account delete). */
export function deleteAvatar(usernameLc: string): void {
  const dir = avatarDir();
  for (const ext of Object.values(MIME_TO_EXT)) {
    rmSync(resolve(dir, `${usernameLc}.${ext}`), { force: true });
  }
}
