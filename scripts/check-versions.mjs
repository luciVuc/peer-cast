#!/usr/bin/env node
/**
 * Version-SSOT guard: every version-carrying file must match the root
 * package.json (the single source of truth per AGENTS.md rule 13).
 *
 * The file list and the readers come from `version-files.mjs`, which
 * `sync-version.mjs` also uses — so the checker and the fixer can't drift apart
 * on which files matter. This script additionally asserts the *negative*
 * cases: places that must never carry a hardcoded version literal.
 *
 * Dependency-free, so it runs anywhere (`node scripts/check-versions.mjs`).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  JSON_VERSION_FILES,
  OPENAPI_FILE,
  readJsonVersion,
  readOpenapiVersion,
  rootVersion,
} from "./version-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const version = rootVersion();

const failures = [];
const mustEqual = (label, actual) => {
  if (actual !== version) failures.push(`${label} (${actual})`);
};

for (const file of JSON_VERSION_FILES) {
  mustEqual(file, readJsonVersion(file));
}
mustEqual(`${OPENAPI_FILE} info.version`, readOpenapiVersion() ?? "missing");

// server config interprets versions only from environment or manifests — it
// must never carry a hardcoded copy of the version (that is exactly the drift
// bug this guard exists to prevent).
if (/return "\d+\.\d+\.\d+/.test(read("packages/server/src/config.ts"))) {
  failures.push("config.ts packageVersion() hardcodes a version literal");
}

// Extension popup version badge: derived at runtime from the manifest (see
// popup.js) — the markup must NOT hardcode a version literal.
if (/>v\d+\.\d+\.\d+</.test(read("packages/extension/popup.html"))) {
  failures.push("popup.html hardcodes a version badge");
}

// Docker image tag: runtime-interpolated via ${PEERCAST_TAG} — compose must
// not hardcode a version literal as the tag.
if (/: \d+\.\d+\.\d+(\s|$|#)/.test(read("docker-compose.yml"))) {
  failures.push("docker-compose.yml hardcodes an image tag version");
}

if (failures.length) {
  console.error(
    `Version SSOT mismatch (root package.json = ${version}):\n` +
      failures.map((f) => `  - ${f}`).join("\n") +
      "\n\nFix with: npm run sync:versions",
  );
  process.exit(1);
}

console.log(`check:versions OK — all version-carrying files match ${version}.`);
