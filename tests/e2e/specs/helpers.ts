import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

/** Vendored PeerJS build, injected into pages that act as raw peers. */
export const peerjsPath = resolve(
  repoRoot,
  "packages/extension/lib/peerjs.min.js",
);

/**
 * Same-origin URL for the vendored PeerJS build (served from the e2e web
 * root). Production CSP (script-src 'self') rejects inline injection, so raw
 * peers load the bundle as a normal <script src> instead.
 */
export const peerjsUrl = "/lib/peerjs.js";

/** Unique-ish handle per test run (the e2e DB persists across the run). */
export function uniqueUsername(prefix = "e2e") {
  return prefix + Math.random().toString(36).slice(2, 8);
}
