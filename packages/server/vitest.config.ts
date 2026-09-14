import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Isolated in-memory DB + stable secret so the API is fully self-contained.
    env: {
      DATABASE_FILE: ":memory:",
      JWT_SECRET: "test-secret-test-secret-test-secret",
      WEB_DIST: "/nonexistent-web-dist",
      NODE_ENV: "test",
      CORS_ORIGINS: "*",
      ADMIN_USERNAMES: "admin",
    },
    // One fresh forked process per test file: each file gets its own
    // better-sqlite3 `:memory:` singleton and its own supertest ephemeral
    // servers, so files can never pollute each other's module/DB state.
    // Files still run sequentially (maxWorkers 1) to keep bcrypt contention low.
    pool: "forks",
    isolate: true,
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { concurrent: false },
    // Registration/login exercise bcrypt cost-12 in-process; under load a
    // single test can run well past the 5s default. Give it room.
    testTimeout: 30_000,
  },
});
