#!/usr/bin/env node
// Tests the browser-side native RPC adapter with a synthetic host, not Tauri or SQLite.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/__mecha_native_replay_test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Replay adapter fixture</title>" }));
  await page.addInitScript(() => {
    window.__AV_PLUGIN_INSTANCE__ = "plugin-city-synthetic";
    const rows = new Map();
    window.__replayHost = { rows, calls: [], mode: "normal" };
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      const host = window.__replayHost;
      if (command !== "plugin_request") throw new Error("unexpected_command");
      const request = args.request;
      host.calls.push(request);
      if (host.mode === "transport_error") throw new Error("plugin_instance_mismatch");
      const response = { version: 1, requestId: request.requestId, ok: true, result: { ok: true }, error: null };
      if (host.mode === "mismatch") response.requestId = "wrong-request";
      if (host.mode === "denied" || host.mode === "full") return { ...response, ok: false, result: null, error: { code: host.mode === "full" ? "replay_full" : "state_key_denied", retryable: false } };
      const { op, id, raw } = request.payload;
      if (op === "list") response.result = { entries: host.mode === "missing_readback" ? [] : [...rows].map(([key, value]) => ({ key, raw: value })) };
      else if (op === "insert") rows.set(id, raw);
      else if (op === "delete") rows.delete(id);
      return response;
    } } };
  });
  await page.goto(new URL("/__mecha_native_replay_test", base).href);
  const result = await page.evaluate(async () => {
    const { replayBackend, commitReplay } = await import("/src/game/mecha/replayRepository.ts");
    const host = window.__replayHost, backend = replayBackend();
    const key = "agent-city:mecha-local-replay-entry:v1:12345678-1234-4000-8000-123456789abc";
    const raw = "synthetic replay";
    const snap = await commitReplay(backend, key, raw);
    const saved = snap.getItem(key);
    const calls = host.calls.slice();
    await backend.delete(key);
    const deleted = (await backend.list()).length === 0;
    const errors = {};
    for (const mode of ["mismatch", "denied", "full", "transport_error", "missing_readback"]) {
      host.mode = mode;
      try { await commitReplay(backend, key, raw); errors[mode] = "accepted"; }
      catch (error) { errors[mode] = error.code ?? error.message; }
    }
    return { saved, deleted, calls, errors };
  });
  assert.equal(result.saved, "synthetic replay");
  assert.equal(result.deleted, true);
  assert.deepEqual(result.calls.map(call => [call.version, call.instanceId, call.method, call.payload.key, call.payload.op]), [
    [1, "plugin-city-synthetic", "plugin.state.write", "mecha-replays:v1", "insert"],
    [1, "plugin-city-synthetic", "plugin.state.read", "mecha-replays:v1", "list"],
  ]);
  assert.match(result.calls[0].requestId, /^city-replay-/);
  assert.notEqual(result.calls[0].requestId, result.calls[1].requestId);
  assert.deepEqual(result.errors, { mismatch: "storage", denied: "storage", full: "full", transport_error: "plugin_instance_mismatch", missing_readback: "storage" });
  console.log("Synthetic native-RPC adapter: insert/read-back/delete, envelope and failure handling passed (not Tauri/SQLite).");
  await context.close();
} finally { await browser.close(); }
