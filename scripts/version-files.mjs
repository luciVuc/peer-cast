/**
 * Shared definition of "which files carry the version".
 *
 * The root package.json is the single source of truth (AGENTS.md rule 13);
 * everything else mirrors it. Both the checker (`check-versions.mjs`) and the
 * fixer (`sync-version.mjs`) import this module so the two can never disagree
 * about the file list — a fixer that missed a file the checker knows about
 * would be worse than no fixer at all.
 *
 * Writes here are surgical string replacements, never a JSON round-trip:
 * `JSON.stringify(json.parse(src))` reformats hand-laid-out files (the compact
 * `"suggested_key": { "default": "Alt+Shift+P" }` objects in the extension
 * manifest, for one) and would bury a version bump in unrelated noise.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const read = (p) => readFileSync(resolve(root, p), "utf8");
const json = (p) => JSON.parse(read(p));
const write = (p, s) => writeFileSync(resolve(root, p), s);

/** Root package.json — holds the authoritative version. */
export const ROOT_FILE = "package.json";

/** Workspace manifests plus the extension's manifest.json. */
export const JSON_VERSION_FILES = [
  "packages/shared/package.json",
  "packages/server/package.json",
  "packages/web/package.json",
  "packages/extension/package.json",
  "tests/e2e/package.json",
  "packages/extension/manifest.json",
];

/** The only other version carrier: the OpenAPI info block. */
export const OPENAPI_FILE = "openapi.yaml";

/** The authoritative version. */
export const rootVersion = () => json(ROOT_FILE).version;

/**
 * First top-level `"version": "..."` in a JSON document.
 *
 * A nested object can't shadow it because every key that merely *ends* in
 * `version` (`manifest_version`) has an underscore before the word, so the
 * leading `"` in the pattern can't match it. Anything that legitimately
 * declares its own `version` key before the top-level one would be caught by
 * the post-write assertion below rather than silently written.
 */
const JSON_VERSION_RE = /("version"\s*:\s*)"(?:[^"\\]|\\.)*"/;

export const readJsonVersion = (file) => json(file).version;

/**
 * Point a JSON file's version at `version`, preserving all other formatting.
 * Returns true when the file changed.
 */
export function writeJsonVersion(file, version) {
  if (readJsonVersion(file) === version) return false;
  const src = read(file);
  if (!JSON_VERSION_RE.test(src)) {
    throw new Error(`${file}: no "version" field found — refusing to guess`);
  }
  const out = src.replace(
    JSON_VERSION_RE,
    (_match, prefix) => `${prefix}${JSON.stringify(version)}`,
  );
  if (JSON.parse(out).version !== version) {
    throw new Error(
      `${file}: write did not take effect — check for a duplicate "version" key`,
    );
  }
  write(file, out);
  return true;
}

/** The text of openapi.yaml's `info:` block, where `info.version` lives. */
function openapiInfoBlock(src) {
  const at = src.search(/^info:[ \t]*$/m);
  return at === -1 ? null : src.slice(at);
}

/** Read `info.version` out of openapi.yaml (unquoted, as we write it). */
export function readOpenapiVersion() {
  const info = openapiInfoBlock(read(OPENAPI_FILE));
  if (info === null) return undefined;
  const m = info.match(/^[ \t]+version:[ \t]*(.+)$/m);
  return m ? m[1].trim().replace(/^"|"$/g, "") : undefined;
}

/** Set `info.version` in openapi.yaml, preserving everything else. */
export function writeOpenapiVersion(version) {
  if (readOpenapiVersion() === version) return false;
  const src = read(OPENAPI_FILE);
  const at = src.search(/^info:[ \t]*$/m);
  if (at === -1) throw new Error(`${OPENAPI_FILE}: missing info block`);
  const head = src.slice(0, at);
  const tail = src.slice(at);
  const m = tail.match(/^([ \t]+version:[ \t]*)(.+)$/m);
  if (!m) throw new Error(`${OPENAPI_FILE}: missing info.version`);
  const out =
    head +
    tail.slice(0, m.index) +
    m[1] +
    version +
    tail.slice(m.index + m[0].length);
  write(OPENAPI_FILE, out);
  if (readOpenapiVersion() !== version) {
    throw new Error(`${OPENAPI_FILE}: write did not take effect`);
  }
  return true;
}
