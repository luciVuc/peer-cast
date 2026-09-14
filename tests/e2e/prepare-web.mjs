// Prepares a self-contained web root for the e2e server: a copy of the built
// PWA (packages/web/dist) plus a same-origin PeerJS bundle. The raw-peer specs
// inject the library with `addScriptTag({ url })` so it loads as a normal
// <script> — our production CSP (script-src 'self') blocks inline injection.
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const dest = resolve(here, ".tmp/webdist");

// Throwaway SQLite: remove any previous run's DB so admin bootstrap
// (ADMIN_USERNAMES=admin) always has a clean slate.
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(resolve(here, ".tmp", "e2e.db" + suffix), { force: true });
}
rmSync(dest, { recursive: true, force: true });

mkdirSync(dest, { recursive: true });
cpSync(resolve(repoRoot, "packages/web/dist"), dest, { recursive: true });

const peerjs = readFileSync(
  resolve(repoRoot, "packages/extension/lib/peerjs.min.js"),
);
mkdirSync(join(dest, "lib"), { recursive: true });
cpSync(
  resolve(repoRoot, "packages/extension/lib/peerjs.min.js"),
  join(dest, "lib", "peerjs.js"),
);

console.log(
  `[e2e] prepared web root at ${dest} (${peerjs.length} bytes peerjs)`,
);
