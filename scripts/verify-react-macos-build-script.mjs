#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(path.join(repo, "scripts/build-macos-react-app.sh"), "utf8");

assert.match(script, /tauri\.react\.conf\.json/, "candidate build must use the React Tauri config");
assert.match(script, /--bundles app/, "candidate build must produce an app bundle");
assert.match(script, /cargo build --release -p agent-vitals/, "candidate build must include the bundled CLI");
assert.match(script, /verify-macos-app-bundle\.mjs/, "candidate build must verify the app bundle");
assert.match(script, /open \"\$app\"/, "candidate launch must use open on the app bundle");
assert.doesNotMatch(script, /tauri\.conf\.json(?!\.react)/, "candidate build must not silently fall back to production config");

console.log("React macOS candidate build contract: OK (real .app path, candidate config, CLI and open launch)");
