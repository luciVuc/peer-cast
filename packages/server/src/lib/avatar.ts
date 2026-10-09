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
import sharp from "sharp";
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
export async function saveAvatar(
  usernameLc: string,
  dataUrl: string,
): Promise<string> {
  const match = dataUrl.match(
    /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/is,
  );
  if (!match) throw new Error("invalid avatar data URL");
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");

  // Re-encode rather than trusting the client's bytes. The allowlist above
  // already rejects non-raster types, but a permitted format can still carry
  // metadata: a JPEG straight off a phone retains GPS coordinates, device
  // serial, and capture timestamps. Those bytes are stored indefinitely and
  // served publicly from /api/avatars/ with a 7-day immutable cache, which
  // makes an avatar a standing doxxing and GDPR-erasure surface.
  //
  // Decoding and re-encoding strips all metadata by construction (sharp drops
  // EXIF/XMP/ICC unless asked to keep them) and normalises the format to PNG,
  // which also neutralises polyglot files — a payload that is a valid image to
  // one parser and something else to another.
  let png: Buffer;
  try {
    png = await sharp(buffer, { failOn: "error" })
      .rotate() // honour EXIF orientation before the metadata is discarded
      .png()
      .toBuffer();
  } catch {
    throw new Error("invalid avatar data URL");
  }

  const dir = avatarDir();
  const filename = `${usernameLc}.png`;
  const filepath = resolve(dir, filename);

  // Verify the resolved path stays inside the avatars directory.
  if (!filepath.startsWith(dir + "/") && filepath !== dir) {
    throw new Error("path escape detected");
  }

  // Remove any previously stored avatar in other formats.
  for (const oldExt of Object.values(MIME_TO_EXT)) {
    if (oldExt !== "png") {
      rmSync(resolve(dir, `${usernameLc}.${oldExt}`), { force: true });
    }
  }

  writeFileSync(filepath, png);

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
