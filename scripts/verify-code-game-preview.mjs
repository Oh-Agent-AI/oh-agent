#!/usr/bin/env node
// Preview one already-built Code Game in the real City and assert it runs to a
// terminal state. Uses the MCP CLI to stage the bundle, then a browser.
//
//   node scripts/verify-code-game-preview.mjs --workspace gws-… --build <buildId>
//
// Requires a running City? No: it starts Vite on --port (default 5290) itself.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const workspaceId = flag("workspace");
const buildId = flag("build");
const port = Number(flag("port", "5290"));
const dataHome = process.env.AGENT_VITALS_HOME;
if (!workspaceId || !buildId) throw new Error("usage: --workspace <id> --build <buildId>");
if (!dataHome) throw new Error("AGENT_VITALS_HOME must point at the MCP data home");

const vite = spawn("npx", ["--no-install", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: path.join(repoRoot, "apps/agent-city/ui"),
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer(url) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("City dev server did not start");
}

function preview(workspace, build) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "scripts/code-game-mcp-cli.mjs"), "preview", "--workspace", workspace, "--build", build], {
      env: { ...process.env, AGENT_VITALS_HOME: dataHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(err || `preview exited ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`preview did not return JSON: ${out.slice(0, 300)}`));
      }
    });
  });
}

const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader"] });
try {
  await waitForServer(`http://127.0.0.1:${port}/`);
  const staged = await preview(workspaceId, buildId);
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const base = `http://127.0.0.1:${port}`;
  await page.goto(`${base}${staged.cityUrl}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__ohAgentCodeGame !== undefined, null, { timeout: 60000 });
  await page.waitForFunction(() => ["running", "finished"].includes(window.__ohAgentCodeGame.status()), null, { timeout: 60000 });
  await page.screenshot({ path: "/tmp/code-game-agent-running.png" });
  await page.waitForFunction(() => ["finished", "error"].includes(window.__ohAgentCodeGame.status()), null, { timeout: 240000 });
  const final = await page.evaluate(() => ({ state: window.__ohAgentCodeGame.state, telemetry: window.__ohAgentCodeGame.telemetry() }));
  assert.equal(final.state.status, "finished", JSON.stringify(final.state));
  assert.equal(final.telemetry.outcome, "success", JSON.stringify(final.telemetry));
  assert.equal(final.telemetry.entities, 0);
  await page.screenshot({ path: "/tmp/code-game-agent-finished.png" });
  const relevant = errors.filter((message) => !/favicon|WebGL|GPU|SwiftShader/i.test(message));
  assert.deepEqual(relevant, []);
  await page.close();
  console.log(JSON.stringify({ ok: true, workspaceId, buildId, cityUrl: staged.cityUrl, telemetry: final.telemetry }, null, 2));
} finally {
  await browser.close();
  vite.kill("SIGTERM");
}
