#!/usr/bin/env node
// Full loop test: MCP creates/builds a Code Game, then the built bundle is
// opened in a real City (Vite dev server + Chromium/WebGL) and must run.
//
//   create → build → preview(stage) → City runs → success
//   → change speed → rebuild → new preview → City finishes sooner
//
// Usage: node scripts/verify-code-game-city-loop.mjs
// Requires a built binary (`cargo build -p agent-vitals`), the City Studio
// dependencies and Playwright (apps/desktop/ui-dev).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const binary = process.env.AGENT_VITALS_BIN ?? path.join(repoRoot, "target/debug/agent-vitals");
const port = Number(process.env.CODE_GAME_PORT ?? 5288);
const base = `http://127.0.0.1:${port}`;
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "code-game-city-loop-"));

if (!fs.existsSync(binary)) throw new Error(`MCP binary not found: ${binary} (run cargo build -p agent-vitals)`);

// ── City dev server ───────────────────────────────────────────────
const vite = spawn("npx", ["--no-install", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: path.join(repoRoot, "apps/agent-city/ui"),
  stdio: ["ignore", "pipe", "pipe"],
});
vite.stderr.on("data", (chunk) => process.env.DEBUG && process.stderr.write(chunk));

async function waitForServer(url) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("City dev server did not start");
}

// ── MCP stdio client ──────────────────────────────────────────────
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
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${id}`)), 180_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
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

// ── City page checks ─────────────────────────────────────────────
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader"] });

async function runInCity(cityUrl, screenshot) {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  try {
    await page.goto(`${base}${cityUrl}`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => window.__ohAgentCodeGame !== undefined, null, { timeout: 60000 });
    await page.waitForFunction(() => window.__ohAgentCodeGame.status() === "running", null, { timeout: 60000 });
    const running = await page.evaluate(() => window.__ohAgentCodeGame.telemetry());
    assert.equal(running.entities, 1, "the built game must own exactly one entity while running");
    await page.screenshot({ path: screenshot });
    await page.waitForFunction(() => window.__ohAgentCodeGame.status() === "finished", null, { timeout: 60000 });
    const final = await page.evaluate(() => ({ state: window.__ohAgentCodeGame.state, telemetry: window.__ohAgentCodeGame.telemetry() }));
    assert.equal(final.telemetry.outcome, "success");
    assert.equal(final.telemetry.entities, 0, "the run must clean up every entity");
    const relevant = errors.filter((message) => !/favicon|WebGL|GPU|SwiftShader/i.test(message));
    assert.deepEqual(relevant, [], `City page errors: ${relevant.join("\n")}`);
    return final.telemetry.tick;
  } finally {
    await page.close();
  }
}

try {
  await waitForServer(`${base}/`);
  await wait(send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "city-loop", version: "1" } }));
  send("notifications/initialized", undefined, true);

  const created = await call("creator_code_project_create", { title: "City Loop", template: "hello-city", operationId: "op-1" });
  const workspaceId = created.workspaceId;
  const firstBuild = await call("creator_code_build", { workspaceId, expectedRevision: created.gameRevision });
  assert.equal(firstBuild.status, "succeeded", JSON.stringify(firstBuild.diagnostics));

  const firstPreview = await call("creator_code_preview", { workspaceId, buildId: firstBuild.buildId, seed: 7 });
  const firstTick = await runInCity(firstPreview.cityUrl, "/tmp/code-game-city-loop-1.png");

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
  const secondTick = await runInCity(secondPreview.cityUrl, "/tmp/code-game-city-loop-2.png");
  assert.ok(secondTick < firstTick, `expected a sooner finish: ${secondTick} !< ${firstTick}`);

  console.log(JSON.stringify({
    ok: true,
    workspaceId,
    gameId: created.gameId,
    buildIds: [firstBuild.buildId, secondBuild.buildId],
    ticks: [firstTick, secondTick],
    previewUrls: [firstPreview.cityUrl, secondPreview.cityUrl],
  }, null, 2));
} finally {
  await browser.close();
  child.stdin.end();
  vite.kill("SIGTERM");
}
