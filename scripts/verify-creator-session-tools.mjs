#!/usr/bin/env node
// End-to-end proof of the Studio session-profile contract over the real MCP stdio
// server. Unit tests prove the functions; only a packaged binary proves the wiring
// (the 2026-11-26 session left `creator_session_update` written but unreachable).
//
//   tools/list carries the five session tools
//   open → update(label/draft/preferredExecutor) → list round-trips the profile
//   another agent cannot update a session it does not own
//   restoring an archived session still respects the open-session cap
//
// Usage: AGENT_VITALS_BIN=target/release/agent-vitals node scripts/verify-creator-session-tools.mjs
// Packaged bundle (the artifact that actually ships):
//   AGENT_VITALS_BIN="<...>/Oh Agent.app/Contents/Resources/bin/agent-vitals" node scripts/verify-creator-session-tools.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const binary = process.env.AGENT_VITALS_BIN ?? path.resolve("target/release/agent-vitals");
if (!fs.existsSync(binary)) throw new Error(`MCP binary not found: ${binary} (run cargo build --release -p agent-vitals)`);
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "creator-session-tools-"));

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

/** Tool errors arrive as isError + an envelope whose `error.code` is the contract. */
function envelopeOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = (result?.content ?? []).find((part) => part.type === "text")?.text;
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

async function invoke(name, args) {
  const message = await wait(send("tools/call", { name, arguments: args }));
  assert.equal(message.error, undefined, `${name}: ${JSON.stringify(message.error)}`);
  const result = message.result ?? {};
  const envelope = envelopeOf(result);
  if (result.isError) {
    const error = new Error(envelope.error?.message ?? `${name} failed`);
    error.code = envelope.error?.code;
    throw error;
  }
  assert.equal(envelope.ok, true, `${name}: ${JSON.stringify(envelope).slice(0, 500)}`);
  return envelope.data;
}

async function expectCode(name, args, code) {
  try {
    await invoke(name, args);
  } catch (error) {
    assert.equal(error.code, code, `${name}: expected ${code}, got ${error.code} (${error.message})`);
    return;
  }
  assert.fail(`${name}: expected ${code}, call succeeded`);
}

async function main() {
  await wait(send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "creator-session-tools", version: "0" } }));
  send("notifications/initialized", undefined, true);
  const listed = await wait(send("tools/list", {}));
  const names = new Set(listed.result.tools.map((tool) => tool.name));
  for (const name of ["creator_session_open", "creator_session_list", "creator_session_update", "creator_session_status", "creator_session_close"]) {
    assert.ok(names.has(name), `missing tool ${name}`);
  }
  console.log(`tools/list: ${names.size} tools, session surface present`);

  // 1. Profile round-trip: label, draft and preferred executor all live on the Host row.
  const opened = await invoke("creator_session_open", { agentId: "smoke-owner", projectId: "project-smoke", createNew: true, label: "二进制冒烟" });
  const sessionId = opened.sessionId;
  await invoke("creator_session_update", { agentId: "smoke-owner", sessionId, draft: "检查出租车是否悬空", preferredExecutor: "acp:claude" });
  let rows = (await invoke("creator_session_list", { agentId: "smoke-owner", projectId: "project-smoke" })).sessions;
  let row = rows.find((entry) => entry.sessionId === sessionId);
  assert.equal(row.label, "二进制冒烟");
  assert.equal(row.draft, "检查出租车是否悬空");
  assert.equal(row.preferredExecutor, "acp:claude");
  console.log("profile round-trip: label + draft + preferredExecutor");

  // 2. Ownership: another agent must not be able to rewrite this session.
  await expectCode("creator_session_update", { agentId: "smoke-intruder", sessionId, label: "劫持" }, "creator_session_scope_mismatch");
  rows = (await invoke("creator_session_list", { agentId: "smoke-owner", projectId: "project-smoke" })).sessions;
  assert.equal(rows.find((entry) => entry.sessionId === sessionId).label, "二进制冒烟");
  console.log("ownership guard: creator_session_scope_mismatch, row unchanged");

  // 3. Archive/restore still occupies a seat: closing frees one, restoring needs one.
  const seats = [];
  for (let index = 0; index < 4; index += 1) {
    seats.push((await invoke("creator_session_open", { agentId: "smoke-cap", projectId: `cap-${index}`, createNew: true })).sessionId);
  }
  await invoke("creator_session_close", { sessionId: seats[0] });
  await invoke("creator_session_close", { sessionId: seats[1] });
  await invoke("creator_session_open", { agentId: "smoke-cap", projectId: "cap-4", createNew: true });
  await invoke("creator_session_open", { agentId: "smoke-cap", projectId: "cap-5", createNew: true });
  await expectCode("creator_session_open", { agentId: "smoke-cap", projectId: "cap-0", sessionId: seats[0] }, "creator_session_limit_exceeded");
  await invoke("creator_session_close", { sessionId: seats[2] });
  const restored = await invoke("creator_session_open", { agentId: "smoke-cap", projectId: "cap-0", sessionId: seats[0] });
  assert.equal(restored.state, "open");
  console.log("restore cap: blocked when full, succeeds after a seat is freed");

  const closed = await invoke("creator_session_close", { sessionId });
  assert.equal(closed.state, "closed");
  console.log("close: state=closed");
  console.log("CREATOR_SESSION_TOOLS_OK");
}

try {
  await main();
} finally {
  child.stdin.end();
  lines.close();
  await new Promise((resolve) => child.on("close", resolve));
  fs.rmSync(dataHome, { recursive: true, force: true });
}
