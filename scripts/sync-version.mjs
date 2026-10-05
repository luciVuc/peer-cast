#!/usr/bin/env node
/**
 * Version-SSOT fixer: point every version-carrying file at the root
 * package.json version.
 *
 * Wired as npm's `version` lifecycle script, so a plain `npm version 1.1.13`
 * updates the whole repo in one step. Two details matter:
 *
 *   1. npm only stages `package.json` and the lockfile before it commits and
 *      tags, so this script also stages what it changed. Without that the
 *      `v1.1.13` tag would point at a commit whose workspace manifests still
 *      said 1.1.12. npm requires a clean tree to run `version` at all, so the
 *      extra staging can't pick up anything unrelated.
 *   2. It is idempotent and a no-op when everything already matches, so it is
 *      safe to run by hand (`npm run sync:versions`).
 *
 * Dependency-free, so it runs anywhere (`node scripts/sync-version.mjs`).
 *
 * Usage:
 *   node scripts/sync-version.mjs [--no-git-add] [--dry-run]
 */

import { execFileSync } from "node:child_process";

import {
  JSON_VERSION_FILES,
  OPENAPI_FILE,
  readJsonVersion,
  readOpenapiVersion,
  rootVersion,
  writeJsonVersion,
  writeOpenapiVersion,
} from "./version-files.mjs";

const argv = new Set(process.argv.slice(2));
const dryRun = argv.has("--dry-run");
const gitAdd = !argv.has("--no-git-add");

const version = rootVersion();
const changed = [];

// A write throws rather than guessing if it can't find the field it expects, so
// any throw here aborts before we've touched the rest of the tree.
for (const file of JSON_VERSION_FILES) {
  if (dryRun) {
    if (readJsonVersion(file) !== version) changed.push(file);
  } else if (writeJsonVersion(file, version)) changed.push(file);
}
if (dryRun) {
  if (readOpenapiVersion() !== version) changed.push(OPENAPI_FILE);
} else if (writeOpenapiVersion(version)) changed.push(OPENAPI_FILE);

if (changed.length === 0) {
  console.log(`All version-carrying files already at ${version}.`);
  process.exit(0);
}

if (dryRun) {
  console.log(
    `Would update to ${version}:\n${changed.map((f) => `  - ${f}`).join("\n")}`,
  );
  process.exit(1); // non-zero so `npm run sync:versions -- --dry-run` can gate CI
}

// npm stages only package.json + lockfile before committing, so stage the rest.
if (gitAdd) {
  execFileSync("git", ["add", "--", ...changed], { stdio: "inherit" });
}

console.log(
  `Synced ${changed.length} file(s) to ${version}:\n${changed.map((f) => `  - ${f}`).join("\n")}`,
);
