#!/usr/bin/env node
/**
 * Version-SSOT guard: every version-carrying file must match the root
 * package.json (the single source of truth per AGENTS.md rule 13).
 *
 * Dependency-free, so it runs anywhere (`node scripts/check-versions.mjs`).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const json = (p) => JSON.parse(read(p));

const version = json("package.json").version;

const failures = [];
const mustEqual = (label, actual) => {
  if (actual !== version) failures.push(`${label} (${actual})`);
};

for (const pkg of [
  "packages/shared",
  "packages/server",
  "packages/web",
  "packages/extension",
  "tests/e2e",
]) {
  mustEqual(`${pkg}/package.json`, json(`${pkg}/package.json`).version);
}

mustEqual(
  "packages/extension/manifest.json",
  json("packages/extension/manifest.json").version,
);

// openapi.yaml — read the info block version value.
const yaml = read("openapi.yaml");
const infoMatch = yaml.match(/^info:\s*$/m);
if (!infoMatch) {
  failures.push("openapi.yaml missing info block");
} else {
  const after = yaml.slice(infoMatch.index);
  const v = after.match(/^\s*version:\s*(.+)$/m);
  if (!v || v[1].trim().replace(/^"|"$/g, "") !== version) {
    failures.push(`openapi.yaml info.version (${v ? v[1].trim() : "missing"})`);
  }
}

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
      failures.map((f) => `  - ${f}`).join("\n"),
  );
  process.exit(1);
}

console.log(`check:versions OK — all version-carrying files match ${version}.`);
