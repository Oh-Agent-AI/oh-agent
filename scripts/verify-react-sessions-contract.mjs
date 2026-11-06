#!/usr/bin/env node
// React bridge contract for the Sessions list/detail path. This locks the
// desktop-facing spelling of detail pagination (`pageSize` — Tauri 2 commands
// only bind camelCase args; a snake_case key silently lands as None, which once
// degraded the city's 30-day window to "today" on the real app)
// `limit` field) and rejects unsafe windows or malformed page envelopes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(repo, "apps/desktop/ui-dev");
const sessionsSource = readFileSync(path.join(ui, "react/src/features/sessions/SessionsPage.tsx"), "utf8");
const navSource = readFileSync(path.join(ui, "react/src/lib/nav.ts"), "utf8");
const detailSource = readFileSync(path.join(ui, "react/src/features/sessions/SessionDetail.tsx"), "utf8");
// R1（OVERVIEW_DRILLDOWN spec §4.2/§7.2）：会话深链契约——白名单文法、
// 解码永不抛（spec §8 守卫）、一次性消费（防刷新回滚用户窗口选择）。
// 用字符串包含而非正则：断言的是源码里的字面文法串本身。
assert.ok(navSource.includes(String.raw`\d{4}-\d{2}-\d{2}`), "date deep-link pattern must be the strict Beijing-day shape");
assert.ok(navSource.includes(":[a-z0-9_-]{1,32}"), "harness whitelist must accept plugin:<slug> harnesses (parity with safeHarnessLabel)");
assert.ok(navSource.includes("catch { return null; }"), "decodeURIComponent must be guarded — malformed hash must never crash the app");
assert.ok(!navSource.includes("readSessionsDateFromHash"), "no dead deep-link exports");
assert.ok(sessionsSource.includes('value="day"'), "sessions window picker must expose the day window (deep-link target)");
assert.ok(sessionsSource.includes("replaceState"), "deep link must be consumed once (no refresh rollback of user window choice)");
assert.ok(sessionsSource.includes("hashchange"), "sessions page must follow same-page hash deep-link re-entry");
assert.match(sessionsSource, /rows\.find\(\(row\) => row\.session_ref === selectedSessionRef\)/, "selection must resolve against refreshed rows by stable session_ref");
assert.doesNotMatch(sessionsSource, /useState<SessionRow \| null>/, "the inspector must not retain a stale row object across list refreshes");
assert.match(sessionsSource, /refreshKey=\{detailRefreshKey\}/, "list invalidation must also refresh the selected inspector");
assert.match(detailSource, /\[sessionRef, refreshKey\]/, "detail query must rerun when its parent refresh revision changes");
assert.match(detailSource, /setLoadingMore\(false\)/, "detail refresh must release an in-flight pagination button");
const uiRequire = createRequire(path.join(ui, "package.json"));
const { buildSync } = uiRequire("esbuild");

function loadMock() {
  const sandbox = { console: { error() {}, warn() {}, log() {} }, Intl, Date, Math, Promise, setTimeout, clearTimeout, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(ui, "public/tauri-mock.js"), "utf8"), sandbox, { filename: "tauri-mock.js" });
  return sandbox.window.__TAURI__.core.invoke;
}

function loadBridge(invoke) {
  const built = buildSync({ entryPoints: [path.join(ui, "react/src/lib/tauri.ts")], bundle: true, format: "cjs", platform: "node", target: "node20", write: false, logLevel: "silent" });
  const sandbox = { module: { exports: {} }, exports: {}, require: uiRequire, console: { error() {}, warn() {}, log() {} }, Intl, Date, Math, Promise, setTimeout, clearTimeout, window: { __TAURI__: { core: { invoke } } } };
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: "tauri-sessions.bundle.cjs" });
  return sandbox.module.exports;
}

const originalInvoke = loadMock();
const calls = [];
const invoke = async (command, args) => {
  calls.push({ command, args });
  return originalInvoke(command, args);
};
const bridge = loadBridge(invoke);

const first = await bridge.readSessions({ month: "2026-09", page_size: 50 });
assert.equal(first.sessions.length, 1);
assert.equal(calls.at(-1).command, "sessions_list");
assert.equal(calls.at(-1).args.pageSize, 50);
assert.equal(calls.at(-1).args.month, "2026-09");

const second = await bridge.readSessions({ month: "2026-09", page_size: 50, cursor: first.next_cursor });
assert.equal(second.sessions.length, 1);
assert.equal(calls.at(-1).args.cursor, "preview-next");
assert.notEqual(second.sessions[0].session_ref, first.sessions[0].session_ref);

const detail = await bridge.readSessionDetail("sr_browser_mock_01");
assert.equal(calls.at(-1).command, "sessions_read");
assert.equal(calls.at(-1).args.sessionRef, "sr_browser_mock_01");
assert.equal(calls.at(-1).args.pageSize, 200);
assert.equal(calls.at(-1).args.limit, undefined);
const detailPage = await bridge.readSessionDetail("sr_browser_mock_01", "detail-next");
assert.equal(calls.at(-1).args.cursor, "detail-next");
assert.equal(detailPage.session_ref, detail.session_ref);

// The authority detail contract does not include the search row's peak_tokens.
// A valid detail must not be rejected or silently given a fabricated peak of 0.
const withoutListOnlyPeak = loadBridge(async (command, args) => {
  const value = await originalInvoke(command, args);
  if (command !== "sessions_read") return value;
  const copy = structuredClone(value);
  delete copy.data.peak_tokens;
  return copy;
});
const detailWithoutPeak = await withoutListOnlyPeak.readSessionDetail("sr_browser_mock_01");
assert.equal(Object.hasOwn(detailWithoutPeak, "peak_tokens"), false);

await assert.rejects(() => bridge.readSessions({ date_from: "2026-09-10" }), /成对/);
await assert.rejects(() => bridge.readSessions({ date_from: "2026-09-11", date_to: "2026-09-10" }), /起点不能晚于终点/);
await assert.rejects(() => bridge.readSessionDetail("native-session-id"), /session_ref 不安全/);

const malformed = async (command, args) => {
  if (command === "sessions_read") {
    return { data: { ...await originalInvoke(command, args).then((value) => value.data), session_ref: "sr_browser_mock_01", timeline: [], workflow_timeline: [], billing_breakdown: [], has_more: true, next_cursor: null, workflow_has_more: false } };
  }
  return originalInvoke(command, args);
};
const malformedBridge = loadBridge(malformed);
await assert.rejects(() => malformedBridge.readSessionDetail("sr_browser_mock_01"), /分页缺少 next_cursor/);

console.log("React Sessions contract: OK (split inspector, stable selection, list/detail pagination, safe filters, malformed rejection)");

// Session trace geometry under the production condition. The Vite build wraps the whole app in
// one CommonJS wrapper (`module.exports` exists) and runs it in a browser (`self` = window).
// timeline.js used to be an either/or UMD — export when `module` exists, else set the global —
// so the global was never set and every trace in the packaged app showed "轨迹暂不可用".
// (An earlier fix preferred the module's default export; Rollup statically resolves that to
// undefined, so it did nothing in the real bundle. This check models the wrapper + self.)
{
  const built = buildSync({
    entryPoints: [path.join(ui, "react/src/features/sessions/SessionTrace.tsx")],
    bundle: true, format: "cjs", platform: "node", target: "node20", write: false, logLevel: "silent",
    loader: { ".css": "empty" }, external: ["react", "react/jsx-runtime", "react-dom"],
  });
  const window = {};
  const sandbox = { module: { exports: {} }, exports: {}, require: uiRequire, console: { error() {}, warn() {}, log() {} }, Math, Number, Object, Array, JSON, String, window, self: window };
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: "session-trace.bundle.cjs" });
  assert.equal(typeof window.TimelineGeometry?.buildTimeline, "function", "timeline.js must publish the global even inside a CommonJS wrapper");
  const svg = sandbox.module.exports.traceMarkup({
    points: [{ ordinal: 0, values: { tool_call_count: 0 } }, { ordinal: 1, values: { tool_call_count: 3 } }, { ordinal: 2, values: { tool_call_count: 1 } }],
    events: [], series: [{ name: "tool_call_count" }], unplaced_events: 0,
  });
  assert.match(svg, /<svg/, "trace must render inside the production CommonJS wrapper");
}
console.log("React session trace geometry: OK (global published inside CommonJS wrapper)");
