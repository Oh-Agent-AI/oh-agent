#!/usr/bin/env node
// End-to-end proof of the Code Game creation loop over the real MCP stdio server:
//
//   create workspace → write broken TS → build fails with diagnostics
//   → fix → build succeeds → headless run succeeds
//   → change a value → rebuild (new buildId) → run result changes
//
// Usage: AGENT_VITALS_BIN=target/debug/agent-vitals node scripts/verify-code-game-loop.mjs
// The binary must be built from the current tree (`cargo build -p agent-vitals`).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const binary = process.env.AGENT_VITALS_BIN ?? path.resolve("target/debug/agent-vitals");
if (!fs.existsSync(binary)) throw new Error(`MCP binary not found: ${binary} (run cargo build -p agent-vitals)`);
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "code-game-loop-"));

const child = spawn(binary, ["data-mcp", "serve", "--allow-local-writes"], {
  env: { ...process.env, AGENT_VITALS_HOME: dataHome },
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 0;
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message.id === "number" && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
child.stderr.on("data", (chunk) => process.env.DEBUG && process.stderr.write(chunk));

function send(method, params, notify = false) {
  const message = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (!notify) message.id = ++nextId;
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return message.id;
}

function wait(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${id}`)), 120_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

async function call(name, args) {
  const message = await wait(send("tools/call", { name, arguments: args }));
  const result = message.result ?? {};
  const envelope = result.structuredContent ?? {};
  if (envelope.error) {
    const error = new Error(envelope.error.message);
    error.code = envelope.error.code;
    throw error;
  }
  assert.equal(envelope.ok, true, `${name}: ${JSON.stringify(envelope).slice(0, 500)}`);
  return envelope.data;
}

await wait(send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "loop", version: "1" } }));
send("notifications/initialized", undefined, true);

const created = await call("creator_code_project_create", { title: "Loop Test", template: "hello-city", operationId: "op-1" });
const workspaceId = created.workspaceId;
const info = await call("creator_code_workspace_info", { workspaceId });
assert.ok(info.files.some((file) => file.path === "src/index.ts"));

const entry = await call("creator_code_file_read", { workspaceId, relativePath: "src/index.ts" });
const original = entry.content;
assert.match(original, /speedMetersPerSecond = 10/);

const broken = await call("creator_code_file_write", {
  workspaceId,
  relativePath: "src/index.ts",
  content: `${original}\nconst broken: = 1;\n`,
  expectedRevision: created.gameRevision,
});
const failed = await call("creator_code_build", { workspaceId, expectedRevision: broken.gameRevision });
assert.equal(failed.status, "failed");
assert.equal(failed.diagnostics[0].relativePath, "src/index.ts");
assert.ok(failed.diagnostics[0].line > 0);

const fixed = await call("creator_code_file_write", {
  workspaceId,
  relativePath: "src/index.ts",
  content: original,
  expectedRevision: broken.gameRevision,
});
const firstBuild = await call("creator_code_build", { workspaceId, expectedRevision: fixed.gameRevision });
assert.equal(firstBuild.status, "succeeded");
const firstRun = await call("creator_code_test", { workspaceId, buildId: firstBuild.buildId, seed: 7, ticks: 900 });
assert.equal(firstRun.telemetry.outcome, "success");
assert.equal(firstRun.telemetry.entities, 0);

const faster = await call("creator_code_file_write", {
  workspaceId,
  relativePath: "src/index.ts",
  content: original.replace("speedMetersPerSecond = 10", "speedMetersPerSecond = 30"),
  expectedRevision: fixed.gameRevision,
});
const secondBuild = await call("creator_code_build", { workspaceId, expectedRevision: faster.gameRevision });
assert.notEqual(secondBuild.buildId, firstBuild.buildId);
const secondRun = await call("creator_code_test", { workspaceId, buildId: secondBuild.buildId, seed: 7, ticks: 900 });
assert.ok(secondRun.telemetry.tick < firstRun.telemetry.tick, `${secondRun.telemetry.tick} !< ${firstRun.telemetry.tick}`);

const status = await call("creator_code_build_status", { buildId: secondBuild.buildId });
assert.equal(status.buildId, secondBuild.buildId);

await assert.rejects(
  call("creator_code_file_write", {
    workspaceId,
    relativePath: "src/index.ts",
    content: "stale",
    expectedRevision: created.gameRevision,
  }),
  (error) => error.code === "workspace_revision_conflict",
);

console.log(JSON.stringify({
  ok: true,
  workspaceId,
  gameId: created.gameId,
  buildIds: [firstBuild.buildId, secondBuild.buildId],
  ticks: [firstRun.telemetry.tick, secondRun.telemetry.tick],
  firstDiagnostic: failed.diagnostics[0],
}, null, 2));
child.stdin.end();
