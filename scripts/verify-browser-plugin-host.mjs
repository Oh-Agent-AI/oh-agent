#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../apps/desktop/ui-dev/public/browser-plugin-host.js", import.meta.url), "utf8");
const registry = JSON.parse(await readFile(new URL("../apps/desktop/plugins.json", import.meta.url), "utf8"));
registry.plugins.push({ id: "metrics", name: "Metrics", entry: "plugins/Metrics.plugin/ui/index.html", commandNamespace: "metrics" });
const listeners = new Map(), replies = [], frames = [];
let tick, now = 1000;
const location = { origin: "http://127.0.0.1:5178" };
const window = {
  __AV_PLUGIN_REGISTRY__: registry,
  __TAURI__: { core: { invoke: async () => "preview-fallback" } },
  addEventListener: (name, callback) => listeners.set(name, callback),
  dispatchEvent: () => {}, setInterval: (callback) => { tick = callback; },
};
window.parent = window;
const document = {
  body: { append: () => {} },
  createElement: () => {
    const frame = { dataset: {}, style: {}, removed: false, remove() { this.removed = true; }, contentWindow: { postMessage: (message) => replies.push(message) } };
    frames.push(frame); return frame;
  },
};
vm.runInNewContext(source, { window, document, location, Event, structuredClone, Date: { now: () => now } });
const invoke = window.__TAURI__.core.invoke;
const bounds = { x: 0, y: 40, width: 900, height: 600 };
const id = await invoke("plugin_open", { pluginId: "city", restart: true, bounds });
const message = async (type, payload = {}, overrides = {}) => listeners.get("message")({
  origin: location.origin, source: frames.at(-1).contentWindow,
  data: { channel: "av-plugin-rpc", version: 1, instanceId: id, type: "request", requestId: "rpc-test", command: "plugin_message",
    args: { message: { version: 1, instanceId: id, type, ...payload } } }, ...overrides,
});
const pluginRequest = async (request) => listeners.get("message")({
  origin: location.origin, source: frames.at(-1).contentWindow,
  data: { channel: "av-plugin-rpc", version: 1, instanceId: id, type: "request", requestId: "rpc-data", command: "plugin_request", args: { request } },
});
const tools = [{ id: "window", label: "时间范围", commandId: "city.window", kind: "select", enabled: true, value: "30", options: [{ value: "7", label: "7 天" }, { value: "30", label: "30 天" }] }];
await message("toolbar.update", { revision: 1, items: tools });
assert.equal((await invoke("plugin_snapshot")).status, "ready");
const resized = { x: 154, y: 48, width: 646, height: 602 };
await invoke("plugin_set_bounds", { instanceId: id, bounds: resized, seq: 2 });
assert.equal(frames[0].style.left, "154px");
assert.equal(frames[0].style.width, "646px");
await invoke("plugin_set_bounds", { instanceId: id, bounds, seq: 1 });
assert.equal(frames[0].style.width, "646px", "late resize must not restore stale bounds");
await assert.rejects(invoke("plugin_set_bounds", { instanceId: "stale", bounds, seq: 3 }), /plugin_unavailable/);
await assert.rejects(invoke("plugin_set_bounds", { instanceId: id, bounds: { ...bounds, height: -1 }, seq: 3 }), /invalid_bounds/);
await invoke("plugin_close", { instanceId: id, suspend: true });
assert.equal(frames[0].removed, false);
assert.equal(frames[0].style.display, "none");
now += 20000; tick();
assert.equal((await invoke("plugin_snapshot")).status, "ready");
assert.equal(await invoke("plugin_open", { pluginId: "city", restart: false, bounds }), id);
assert.equal(frames[0].style.display, "");
await invoke("plugin_set_bounds", { instanceId: id, bounds: resized, seq: 1 });
assert.equal(frames[0].style.width, "646px", "resumed layout accepts a new sequence");
await pluginRequest({ version: 1, instanceId: id, requestId: "data-1", method: "data.read", payload: { projection: "city" } });
assert.equal(JSON.stringify(replies.at(-1).result), JSON.stringify({ version: 1, requestId: "data-1", ok: false, result: null, error: { code: "provider_unavailable", retryable: true } }));
await pluginRequest({ version: 1, instanceId: "stale", requestId: "data-stale", method: "data.read", payload: {} });
assert.equal(replies.at(-1).error, "preview_request_rejected");
await message("toolbar.update", { revision: 2, items: [{ ...tools[0], label: {}, options: null }] });
assert.equal(replies.at(-1).error, "preview_request_rejected");
assert.equal((await invoke("plugin_snapshot")).revision, 1);
await message("toolbar.update", { revision: 1, items: tools });
assert.equal(replies.at(-1).error, "preview_request_rejected");
const before = replies.length;
await message("runtime.error", {}, { origin: "https://untrusted.invalid" });
await message("runtime.error", {}, { source: {} });
assert.equal(replies.length, before);
assert.equal((await invoke("plugin_snapshot")).status, "ready");
await assert.rejects(invoke("plugin_open", { pluginId: "city", restart: true, bounds: { ...bounds, width: -1 } }), /invalid_bounds/);
await assert.rejects(invoke("plugin_open", { pluginId: "unknown", restart: true, bounds }), /plugin_unknown/);
assert.equal((await invoke("plugin_snapshot")).instanceId, id);
assert.equal(frames[0].removed, false);
await assert.rejects(invoke("plugin_command", { instanceId: id, commandId: "city.window", value: "999" }), /rejected/);
const requestId = await invoke("plugin_command", { instanceId: id, commandId: "city.window", value: "7" });
await message("command.result", { requestId: "old-request", ok: true });
assert.equal((await invoke("plugin_snapshot")).pending, requestId);
await message("command.result", { requestId, ok: true });
assert.equal((await invoke("plugin_snapshot")).pending, null);
await invoke("plugin_command", { instanceId: id, commandId: "city.window", value: "7" });
now += 30001; tick();
assert.equal((await invoke("plugin_snapshot")).error, "plugin_command_timeout");
await message("toolbar.update", { revision: 3, items: tools });
assert.equal((await invoke("plugin_snapshot")).status, "failed");
const oldFrame = frames[0];
const nextId = await invoke("plugin_open", { pluginId: "city", restart: true, bounds });
assert.notEqual(nextId, id);
await message("runtime.error", {}, { source: oldFrame.contentWindow });
assert.equal((await invoke("plugin_snapshot")).status, "loading");
await invoke("plugin_close", { instanceId: id });
assert.equal((await invoke("plugin_snapshot")).instanceId, nextId);
now += 15001; tick();
assert.equal((await invoke("plugin_snapshot")).error, "plugin_boot_timeout");
await invoke("plugin_close", { instanceId: nextId });
assert.equal(await invoke("plugin_snapshot"), null);
// Second plugin uses the SAME adapter, its own entry, namespace and provider.
const metricsId = await invoke("plugin_open", { pluginId: "metrics", restart: true, bounds });
assert.ok(frames.at(-1).src.startsWith("/plugins/Metrics.plugin/ui/index.html?"));
const metricsMessage = (type, payload = {}) => listeners.get("message")({
  origin: location.origin, source: frames.at(-1).contentWindow,
  data: { channel: "av-plugin-rpc", version: 1, instanceId: metricsId, type: "request", requestId: "metrics-rpc", command: "plugin_message",
    args: { message: { version: 1, instanceId: metricsId, type, ...payload } } },
});
await metricsMessage("toolbar.update", { revision: 1, items: [{ id: "refresh", label: "Refresh", commandId: "metrics.refresh", kind: "button", enabled: true }] });
assert.equal((await invoke("plugin_snapshot")).status, "ready");
await metricsMessage("toolbar.update", { revision: 2, items: tools });
assert.equal(replies.at(-1).error, "preview_request_rejected", "cross-plugin command namespaces are rejected");
let forwarded;
window.__AV_BROWSER_PROVIDERS__ = { metrics: async (request) => { forwarded = request; return { count: 42 }; } };
await listeners.get("message")({ origin: location.origin, source: frames.at(-1).contentWindow,
  data: { channel: "av-plugin-rpc", version: 1, instanceId: metricsId, type: "request", requestId: "metrics-read", command: "plugin_request",
    args: { request: { version: 1, instanceId: metricsId, requestId: "read-1", method: "metrics.read", payload: { arbitraryField: "retained" } } } } });
assert.equal(forwarded.payload.arbitraryField, "retained");
assert.equal(replies.at(-1).result.result.count, 42);
await invoke("plugin_close", { instanceId: metricsId });
assert.equal(await invoke("plugin_snapshot"), null);
const nativeInvoke = () => {};
const nativeWindow = { __TAURI_INTERNALS__: {}, __TAURI__: { core: { invoke: nativeInvoke } } };
nativeWindow.parent = nativeWindow;
vm.runInNewContext(source, { window: nativeWindow });
assert.equal(nativeWindow.__TAURI__.core.invoke, nativeInvoke, "Browser adapter must not replace native IPC");
console.log("Browser plugin adapter: passed (DTO validation, source/origin, bounds, stale revision/request/instance, sticky faults, timeouts, native guard).");
