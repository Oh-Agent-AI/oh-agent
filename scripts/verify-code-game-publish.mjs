#!/usr/bin/env node
// Experience V2 publish/install loop over the real CLI + MCP server:
//
//   create → build → publish (self-contained package + contentDigest)
//   → list → install (digest verification) → uninstall
//   → tamper a package byte → install must refuse
//
// Usage: node scripts/verify-code-game-publish.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "scripts", "code-game-mcp-cli.mjs");
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "code-game-publish-"));
const env = { ...process.env, AGENT_VITALS_HOME: dataHome };

function run(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("exit", (code) => {
      if (code !== 0 && !allowFailure) return reject(new Error(`${args[0]} failed: ${err || out}`));
      resolve({ code, out, err });
    });
  });
}

async function json(args) {
  const { out } = await run(args);
  return JSON.parse(out);
}

const created = await json(["create", "--title", "Publish Test", "--operation", "op-publish-1"]);
const built = await json(["build", "--workspace", created.workspaceId, "--revision", created.gameRevision]);
assert.equal(built.status, "succeeded", JSON.stringify(built.diagnostics));
const published = await json([
  "publish", "--workspace", created.workspaceId, "--build", built.buildId,
  "--version", "0.1.0", "--operation", "op-publish-2",
]);
assert.equal(published.experienceId, created.gameId);
assert.match(published.contentDigest, /^[0-9a-f]{64}$/);
assert.ok(published.fileCount >= 4);

const packageRoot = path.join(dataHome, "code-games", "experiences", published.experienceId, "0.1.0");
for (const file of ["manifest.json", "code/game.js", "assets/cube.glb", "permissions.json", "world-binding.json", "provenance.json"]) {
  assert.ok(fs.existsSync(path.join(packageRoot, file)), `missing ${file}`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "manifest.json"), "utf8"));
assert.equal(manifest.kind, "code-game-experience");
assert.equal(manifest.buildId, built.buildId);
assert.equal(manifest.contentDigest, published.contentDigest);

const before = await json(["experiences"]);
assert.equal(before.installed.length, 0);
assert.equal(before.available.length, 1);
assert.equal(before.available[0].installed, false);

const installed = await json(["install", "--experience", published.experienceId, "--version", "0.1.0"]);
assert.equal(installed.alreadyInstalled, false);
const after = await json(["experiences"]);
assert.equal(after.installed.length, 1);
assert.equal(after.available[0].installed, true);

const again = await json(["install", "--experience", published.experienceId, "--version", "0.1.0"]);
assert.equal(again.alreadyInstalled, true, "same digest installs idempotently");

const removed = await json(["uninstall", "--experience", published.experienceId, "--version", "0.1.0"]);
assert.equal(removed.removed, true);

fs.appendFileSync(path.join(packageRoot, "code/game.js"), "\n// tampered\n");
const tampered = await run(["install", "--experience", published.experienceId, "--version", "0.1.0"], { allowFailure: true });
assert.equal(tampered.code, 1);
assert.match(tampered.err, /game_package_integrity_failed/);
assert.match(tampered.err, /Digest mismatch|Size mismatch/);

console.log(JSON.stringify({
  ok: true,
  experienceId: published.experienceId,
  version: published.version,
  buildId: published.buildId,
  contentDigest: published.contentDigest,
  fileCount: published.fileCount,
  tamperRefused: true,
}, null, 2));
