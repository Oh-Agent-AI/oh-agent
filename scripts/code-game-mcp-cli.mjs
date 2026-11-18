#!/usr/bin/env node
// Thin CLI over the Code Game MCP tools. It exists so a real Agent (DeepSeek
// Harness, Codex, Claude Code, …) can drive the loop without an MCP client:
//
//   node scripts/code-game-mcp-cli.mjs create --title "Tower Defense" --operation op-1
//   node scripts/code-game-mcp-cli.mjs read   --workspace gws-… --path src/index.ts --out /tmp/a.ts
//   node scripts/code-game-mcp-cli.mjs write  --workspace gws-… --path src/index.ts --revision <rev> --file /tmp/a.ts
//   node scripts/code-game-mcp-cli.mjs build  --workspace gws-… --revision <rev>
//   node scripts/code-game-mcp-cli.mjs test   --workspace gws-… --build <buildId> --ticks 1800
//   node scripts/code-game-mcp-cli.mjs preview --workspace gws-… --build <buildId>
//
// Every invocation starts the same `data-mcp serve --allow-local-writes` stdio
// server, performs one tools/call, prints the tool `data` as JSON and exits.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const command = args.shift();
if (!command) {
  console.error("usage: code-game-mcp-cli.mjs <create|info|read|write|build|test|preview|build-status|preview-status> [--flag value]");
  process.exit(2);
}
const flags = new Map();
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  if (!flag.startsWith("--")) continue;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    flags.set(flag.slice(2), "true");
    continue;
  }
  flags.set(flag.slice(2), value);
  index += 1;
}

const dataHome = path.resolve(
  flags.get("data-home") ?? process.env.AGENT_VITALS_HOME ?? path.join(os.tmpdir(), "oh-code-game-agent"),
);
fs.mkdirSync(dataHome, { recursive: true });
const binary = flags.get("bin") ?? process.env.AGENT_VITALS_BIN ?? path.resolve("target/debug/agent-vitals");
if (!fs.existsSync(binary)) {
  console.error(`MCP binary not found: ${binary} (run cargo build -p agent-vitals)`);
  process.exit(1);
}

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
const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

function send(method, params, notify = false) {
  const message = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (!notify) message.id = ++nextId;
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return message.id;
}

function wait(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP request timed out")), 180_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function required(name) {
  const value = flags.get(name);
  if (!value) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return value;
}

function optionalFile(name) {
  const file = flags.get(name);
  if (!file) return undefined;
  return fs.readFileSync(path.resolve(file), "utf8");
}

async function main() {
  await wait(send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "code-game-cli", version: "1" } }));
  send("notifications/initialized", undefined, true);

  const calls = {
    create: () => ["creator_code_project_create", {
      title: required("title"),
      template: flags.get("template") ?? "hello-city",
      operationId: flags.get("operation") ?? `op-${Date.now()}`,
    }],
    info: () => ["creator_code_workspace_info", { workspaceId: required("workspace") }],
    read: () => ["creator_code_file_read", { workspaceId: required("workspace"), relativePath: required("path") }],
    write: () => ["creator_code_file_write", {
      workspaceId: required("workspace"),
      relativePath: required("path"),
      content: optionalFile("file") ?? flags.get("content") ?? "",
      ...(flags.get("revision") ? { expectedRevision: flags.get("revision") } : {}),
    }],
    build: () => ["creator_code_build", {
      workspaceId: required("workspace"),
      ...(flags.get("revision") ? { expectedRevision: flags.get("revision") } : {}),
    }],
    test: () => ["creator_code_test", {
      workspaceId: required("workspace"),
      buildId: required("build"),
      ...(flags.get("seed") ? { seed: Number(flags.get("seed")) } : {}),
      ...(flags.get("ticks") ? { ticks: Number(flags.get("ticks")) } : {}),
    }],
    preview: () => ["creator_code_preview", {
      workspaceId: required("workspace"),
      buildId: required("build"),
      ...(flags.get("seed") ? { seed: Number(flags.get("seed")) } : {}),
    }],
    "build-status": () => ["creator_code_build_status", { buildId: required("build") }],
    "preview-status": () => ["creator_code_preview_status", {}],
  };
  const entry = calls[command];
  if (!entry) {
    console.error(`unknown command: ${command}`);
    process.exit(2);
  }
  const [name, toolArgs] = entry();
  const message = await wait(send("tools/call", { name, arguments: toolArgs }));
  const envelope = message.result?.structuredContent ?? {};
  if (envelope.error) {
    console.error(JSON.stringify({ ok: false, error: envelope.error }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (command === "read" && flags.get("out")) {
    fs.writeFileSync(path.resolve(flags.get("out")), envelope.data.content);
    console.log(JSON.stringify({ ok: true, relativePath: envelope.data.relativePath, gameRevision: envelope.data.gameRevision, bytes: envelope.data.content.length }, null, 2));
    return;
  }
  console.log(JSON.stringify(envelope.data, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: "cli_failed", message: String(error?.message ?? error) } }, null, 2));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.on("exit", () => {
    if (stderr.length && process.env.DEBUG) process.stderr.write(stderr.join(""));
  });
}
