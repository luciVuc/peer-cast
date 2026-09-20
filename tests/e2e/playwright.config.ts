import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const PORT = 8899;

/**
 * Boots the *built* PeerCast server (API + PeerJS signaling + static PWA) on a
 * dedicated port with a throwaway SQLite file, then runs the browser suite
 * against it — exercising the exact production single-container topology.
 *
 * Prereq: `npm run build` at the repo root (shared + web + server).
 */
export default defineConfig({
  testDir: "./specs",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    // Fake media devices so getUserMedia/canvas capture need no user gesture.
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
  },
  webServer: {
    command:
      "node tests/e2e/prepare-web.mjs && node packages/server/dist/index.js",
    cwd: repoRoot,
    url: `http://localhost:${PORT}/api/health`,
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret",
      DATABASE_FILE: resolve(here, ".tmp/e2e.db"),
      WEB_DIST: resolve(here, ".tmp/webdist"),
      PUBLIC_HOST: "localhost",
      PUBLIC_SECURE: "false",
      CORS_ORIGINS: "*",
      ADMIN_USERNAMES: "admin",
      ADMIN_BOOTSTRAP_SECRET: "e2e-admin-secret",
    },
  },
});
