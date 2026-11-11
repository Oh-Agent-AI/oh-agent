import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import Module from "node:module";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const sourcePath = fileURLToPath(new URL("../src/app-game.ts", import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-game-sdk-test-"));
const sourceDir = path.join(outputDir, "source");
fs.mkdirSync(sourceDir);
for (const filename of ["app-game.ts", "plugin-rpc.ts", "ui-host.ts"]) {
  fs.copyFileSync(path.join(path.dirname(sourcePath), filename), path.join(sourceDir, filename));
}
fs.writeFileSync(path.join(sourceDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const tsc = path.resolve(path.dirname(nodeRequire.resolve("typescript/package.json")), "bin/tsc");
const compileSource = path.join(sourceDir, "app-game.ts");
const compilation = spawnSync(process.execPath, [tsc, "--ignoreConfig", compileSource, "--target", "ES2022", "--module", "Node16",
  "--moduleResolution", "Node16", "--skipLibCheck", "--outDir", path.join(outputDir, "dist")], { encoding: "utf8" });
if (compilation.status !== 0) throw new Error(compilation.stderr || compilation.stdout || "app-game test compilation failed");
const compiledPath = path.join(outputDir, "dist", "app-game.js");
after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

function loadSdk({ invokeHost = async () => null, publish = async () => {}, pluginLocale = () => "en" } = {}) {
  const window = new EventTarget();
  window.__AV_PLUGIN_INSTANCE__ = "test-instance";
  globalThis.window = window;
  const compiled = fs.readFileSync(compiledPath, "utf8");
  const loaded = new Module(compiledPath, null);
  loaded.filename = compiledPath;
  loaded.paths = Module._nodeModulePaths(path.dirname(compiledPath));
  loaded.require = (specifier) => {
    if (specifier === "./ui-host.js") return { invokeHost, publish, pluginLocale };
    return nodeRequire(specifier);
  };
  loaded._compile(compiled, compiledPath);
  return { sdk: loaded.exports, window };
}

test("connectAppGame awaits start before publishing ready and disposes once", async () => {
  const calls = [];
  let finishStart;
  const { sdk } = loadSdk({ publish: async (type, payload) => calls.push([type, payload]) });
  const starting = new Promise((resolve) => { finishStart = resolve; });
  let disposals = 0;
  const connected = sdk.connectAppGame({ start: () => starting, suspend() {}, resume() {}, dispose() { disposals++; } });
  await Promise.resolve();
  assert.deepEqual(calls, []);
  finishStart();
  const dispose = await connected;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "toolbar.update");
  assert.deepEqual(calls[0][1].items, []);
  assert.ok(calls[0][1].revision > 0);
  dispose(); dispose();
  await Promise.resolve();
  assert.equal(disposals, 1);
});

test("start failure reports runtime.error and releases partially allocated resources", async () => {
  const calls = [];
  let disposals = 0;
  const { sdk } = loadSdk({ publish: async (type) => calls.push(type) });
  await assert.rejects(sdk.connectAppGame({
    async start() { throw new Error("start_failed"); }, suspend() {}, resume() {}, dispose() { disposals++; },
  }), /start_failed/);
  assert.deepEqual(calls, ["runtime.error"]);
  assert.equal(disposals, 1);
});

test("suspend/resume events are idempotent and pagehide cleanup is repeatable", async () => {
  const { sdk, window } = loadSdk();
  const calls = [];
  const dispose = await sdk.connectAppGame({
    start() {}, suspend() { calls.push("suspend"); }, resume() { calls.push("resume"); }, dispose() { calls.push("dispose"); },
  });
  window.dispatchEvent(new Event("__AV_PLUGIN_SUSPENDED__"));
  window.dispatchEvent(new Event("__AV_PLUGIN_SUSPENDED__"));
  window.dispatchEvent(new Event("__AV_PLUGIN_RESUMED__"));
  window.dispatchEvent(new Event("__AV_PLUGIN_RESUMED__"));
  assert.deepEqual(calls, ["suspend", "resume"]);
  window.dispatchEvent(new Event("pagehide"));
  dispose();
  await Promise.resolve();
  assert.deepEqual(calls, ["suspend", "resume", "dispose"]);
  window.dispatchEvent(new Event("__AV_PLUGIN_SUSPENDED__"));
  assert.deepEqual(calls, ["suspend", "resume", "dispose"]);
});

test("AppHostClient uses plugin_request state contract and validates its envelope", async () => {
  const requests = [];
  const { sdk } = loadSdk({ invokeHost: async (command, args) => {
    assert.equal(command, "plugin_request");
    const request = args.request;
    requests.push(request);
    if (request.method === "plugin.state.read") return {
      version: 1, requestId: request.requestId, ok: true,
      result: { value: { score: 3 }, revision: 4 }, error: null,
    };
    return { version: 1, requestId: request.requestId, ok: true, result: { revision: 5 }, error: null };
  } });
  const host = sdk.createAppHostClient();
  assert.equal(host.locale(), "en");
  assert.deepEqual(await host.state.read("progress:v1"), { value: { score: 3 }, revision: 4 });
  assert.deepEqual(await host.state.write({ key: "progress:v1", revision: 4, value: { score: 8 } }), { revision: 5 });
  assert.deepEqual(requests.map(({ method, payload }) => [method, payload]), [
    ["plugin.state.read", { key: "progress:v1" }],
    ["plugin.state.write", { key: "progress:v1", revision: 4, value: { score: 8 } }],
  ]);
  assert.ok(requests.every((request) => request.version === 1 && request.instanceId === "test-instance"));
});

test("AppHostClient rejects malformed state keys, values, response envelopes and host errors", async () => {
  const { sdk } = loadSdk({ invokeHost: async (_command, { request }) => ({
    version: 1, requestId: request.requestId, ok: false, result: null,
    error: { code: "state_key_denied", retryable: false },
  }) });
  const host = sdk.createAppHostClient();
  await assert.rejects(host.state.read("../escape:v1"), /invalid_state_key/);
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(host.state.write({ key: "progress:v1", revision: 0, value: cycle }), /invalid_state_value/);
  await assert.rejects(host.state.read("progress:v1"), /state_key_denied/);

  const badEnvelope = loadSdk({ invokeHost: async () => ({ version: 1, requestId: "other", ok: true, result: { value: null, revision: 0 }, error: null }) });
  await assert.rejects(badEnvelope.sdk.createAppHostClient().state.read("progress:v1"), /plugin_response_invalid/);
});
