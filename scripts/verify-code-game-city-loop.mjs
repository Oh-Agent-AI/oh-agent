#!/usr/bin/env node
// Packaged-host loop: MCP creates/builds immutable Code Games, queues them for
// independent Preview windows, then reads host-published terminal evidence.
// Run the Oh Agent app with the same AGENT_VITALS_HOME before this script.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const binary = process.env.AGENT_VITALS_BIN ?? path.join(repoRoot, "target/debug/agent-vitals");
const dataHome = process.env.AGENT_VITALS_HOME;
if (!dataHome) throw new Error("Set AGENT_VITALS_HOME to the running Oh Agent app's data home.");
if (!fs.existsSync(binary)) throw new Error(`MCP binary not found: ${binary} (run cargo build -p agent-vitals)`);

const child = spawn(binary, ["data-mcp", "serve", "--allow-local-writes"], {
  env: { ...process.env, AGENT_VITALS_HOME: dataHome },
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 0;
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
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
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${id}`)), 180_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
  });
}
async function call(name, args) {
  const message = await wait(send("tools/call", { name, arguments: args }));
  const envelope = message.result?.structuredContent ?? {};
  if (envelope.error) {
    const error = new Error(envelope.error.message);
    error.code = envelope.error.code;
    throw error;
  }
  assert.equal(envelope.ok, true, `${name}: ${JSON.stringify(envelope).slice(0, 500)}`);
  return envelope.data;
}
async function waitForPreview(buildId) {
  let sawRunning = false;
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const status = await call("creator_code_preview_status", {});
    if (status.available && status.buildId === buildId && !status.stale) {
      if (status.status === "running") sawRunning = true;
      if (status.status === "finished") {
        assert.equal(status.outcome, "success");
        assert.equal(status.entities, 0, "the run must clean up every entity");
        assert.equal(sawRunning, true, "the host must publish a live running state before completion");
        return status.tick;
      }
      if (status.status === "error") throw new Error(`City preview failed: ${status.reason ?? "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the packaged City preview");
}

try {
  await wait(send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "city-loop", version: "1" } }));
  send("notifications/initialized", undefined, true);
  const created = await call("creator_code_project_create", { title: "City Loop", template: "hello-city", operationId: "op-1" });
  const workspaceId = created.workspaceId;
  const firstBuild = await call("creator_code_build", { workspaceId, expectedRevision: created.gameRevision });
  assert.equal(firstBuild.status, "succeeded", JSON.stringify(firstBuild.diagnostics));
  const firstPreview = await call("creator_code_preview", { workspaceId, buildId: firstBuild.buildId, seed: 7 });
  assert.equal(firstPreview.status, "queued");
  assert.ok(firstPreview.previewId);
  const firstTick = await waitForPreview(firstBuild.buildId);

  const entry = await call("creator_code_file_read", { workspaceId, relativePath: "src/index.ts" });
  const info = await call("creator_code_workspace_info", { workspaceId });
  const faster = await call("creator_code_file_write", {
    workspaceId,
    relativePath: "src/index.ts",
    content: entry.content.replace("speedMetersPerSecond = 10", "speedMetersPerSecond = 30"),
    expectedRevision: info.gameRevision,
  });
  const secondBuild = await call("creator_code_build", { workspaceId, expectedRevision: faster.gameRevision });
  assert.equal(secondBuild.status, "succeeded", JSON.stringify(secondBuild.diagnostics));
  const secondPreview = await call("creator_code_preview", { workspaceId, buildId: secondBuild.buildId, seed: 7 });
  assert.ok(secondPreview.previewId);
  assert.notEqual(secondPreview.previewId, firstPreview.previewId);
  const secondTick = await waitForPreview(secondBuild.buildId);
  assert.ok(secondTick < firstTick, `expected a sooner finish: ${secondTick} !< ${firstTick}`);
  console.log(JSON.stringify({ ok: true, workspaceId, gameId: created.gameId,
    buildIds: [firstBuild.buildId, secondBuild.buildId], ticks: [firstTick, secondTick],
    requestIds: [firstPreview.requestId, secondPreview.requestId], previewIds: [firstPreview.previewId, secondPreview.previewId] }, null, 2));
} finally {
  child.stdin.end();
}
