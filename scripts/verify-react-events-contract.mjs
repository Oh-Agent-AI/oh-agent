#!/usr/bin/env node
// Contract for the single local desktop event bus. The renderer receives only
// an allowlisted event type; payload fields are intentionally discarded.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(repo, "apps/desktop/ui-dev");
const uiRequire = createRequire(path.join(ui, "package.json"));
const { buildSync } = uiRequire("esbuild");
let callback = null;
let domCallback = null;
let subscribed = null;
let unsubscribed = false;
const built = buildSync({ entryPoints: [path.join(ui, "react/src/lib/tauri.ts")], bundle: true, format: "cjs", platform: "node", target: "node20", write: false, logLevel: "silent" });
const sandbox = {
  module: { exports: {} }, exports: {}, require: uiRequire,
  console: { error() {}, warn() {}, log() {} }, Intl, Date, Math, Promise, setTimeout, clearTimeout,
  window: {
    addEventListener: (event, handler) => { if (event === "agent-vitals-source-data-deleted") domCallback = handler; },
    removeEventListener: (event, handler) => { if (event === "agent-vitals-source-data-deleted" && domCallback === handler) domCallback = null; },
    __TAURI__: { event: { listen: async (event, handler) => { subscribed = event; callback = handler; return () => { unsubscribed = true; }; } } },
  },
};
vm.createContext(sandbox);
vm.runInContext(built.outputFiles[0].text, sandbox, { filename: "tauri-events.bundle.cjs" });
const { listenAppEvents } = sandbox.module.exports;
const events = [];
const unsubscribe = await listenAppEvents((event) => events.push(event));
assert.equal(subscribed, "app-event");
callback?.({ payload: { type: "SyncStatusChanged", secret: "must-not-cross" } });
callback?.({ payload: { type: "HarnessNavigationChanged", path: "/private/path" } });
callback?.({ payload: { type: "SourceDataDeleted", path: "/private/path" } });
callback?.({ payload: { type: "WatcherHealthChanged", mode: "active", topology_revision: 2, pending_roots: 0, reason_code: null } });
callback?.({ payload: { type: "WatcherHealthChanged", mode: "not-a-mode", raw: "/private/path" } });
callback?.({ payload: { type: "UnknownInternalEvent", secret: "drop" } });
// RUNTIME_INVALIDATION spec §6：Invalidated 只透 revision（限幅）+ harnesses（闭集过滤）。
callback?.({ payload: { type: "Invalidated", schema_version: 1, revision: 42, harnesses: ["dsh", "codex", "/private/path", 7], payload: { secret: "drop" } } });
callback?.({ payload: { type: "Invalidated", revision: -1, harnesses: "not-an-array" } });
callback?.({ payload: { type: "Invalidated", revision: 1e300 } });
// 退役类型：领域事件不再透传（spec §4.3）。
callback?.({ payload: { type: "FoldCompleted", at: 1 } });
callback?.({ payload: { type: "FactsIngested", harness: "dsh", inserted: 3 } });
callback?.({ payload: "malformed" });
domCallback?.();
assert.equal(JSON.stringify(events), JSON.stringify([
  { type: "SyncStatusChanged" },
  { type: "HarnessNavigationChanged" },
  { type: "SourceDataDeleted" },
  { type: "WatcherHealthChanged" },
  { type: "WatcherHealthChanged" },
  { type: "Invalidated", revision: 42, harnesses: ["dsh", "codex"] },
  { type: "Invalidated", harnesses: [] },
  { type: "Invalidated", harnesses: [] },
  { type: "SourceDataDeleted" },
]));
unsubscribe();
assert.equal(unsubscribed, true);
assert.equal(domCallback, null);

sandbox.window.__TAURI__.event.listen = async () => { throw new Error("webview closing"); };
const rejectedEvents = [];
const rejectedUnsubscribe = await listenAppEvents((event) => rejectedEvents.push(event));
assert.notEqual(domCallback, null);
domCallback?.();
assert.equal(JSON.stringify(rejectedEvents), JSON.stringify([{ type: "SourceDataDeleted" }]));
rejectedUnsubscribe();
assert.equal(domCallback, null);

// 失效闸门（spec §6）：revision 严格前进才放行；同 revision 重复、其他类型都拒；
// SourceDataDeleted 恒放行；无 revision 的旧桌面进程保守放行。
const { makeInvalidationGate } = sandbox.module.exports;
const gate = makeInvalidationGate();
assert.equal(gate({ type: "Invalidated", revision: 5, harnesses: [] }), true, "first revision refreshes");
assert.equal(gate({ type: "Invalidated", revision: 5, harnesses: ["dsh"] }), false, "same revision swallowed");
assert.equal(gate({ type: "Invalidated", revision: 4, harnesses: [] }), false, "older revision swallowed");
assert.equal(gate({ type: "Invalidated", revision: 6, harnesses: [] }), true, "advance refreshes");
assert.equal(gate({ type: "SyncStatusChanged" }), false, "status is not data invalidation");
assert.equal(gate({ type: "HarnessNavigationChanged" }), false, "overview refreshes navigation explicitly");
assert.equal(gate({ type: "WatcherHealthChanged" }), false);
assert.equal(gate({ type: "TrustMonitorEvent" }), false);
assert.equal(gate({ type: "SourceDataDeleted" }), true, "deletion always refreshes");
assert.equal(gate({ type: "Invalidated", harnesses: [] }), true, "no revision (old desktop) refreshes conservatively");
assert.equal(gate({ type: "Invalidated", revision: 6, harnesses: [] }), false, "conservative path does not reset seenRevision");
// R1（REFRESH_STORM spec §4.1）：轮询合成的 SourceDataDeleted 带 revision——只比较、
// 不推进水位（各订阅者对不同事件类型的刷新集不同，外来信号不得吞掉 Invalidated 全量扇出）。
assert.equal(gate({ type: "SourceDataDeleted", revision: 6 }), false, "poll synthesis covered by watermark is swallowed");
assert.equal(gate({ type: "SourceDataDeleted", revision: 7 }), true, "newer poll synthesis refreshes");
assert.equal(gate({ type: "Invalidated", revision: 7, harnesses: [] }), true, "deletion does not advance watermark (full fan still runs)");
assert.equal(gate({ type: "Invalidated", revision: 7, harnesses: [] }), false, "and the watermark advances only via Invalidated");

const { parseWatcherHealth } = sandbox.module.exports;
// vm 跨 realm 对象不做 deepEqual（原型不同）——按本文件惯例用 JSON 串比较。
assert.equal(
  JSON.stringify(parseWatcherHealth({ status: "ok", mode: "active", reason_code: null, topology_revision: 7, pending_roots: 0 })),
  JSON.stringify({ mode: "active", reasonCode: null, topologyRevision: 7, pendingRoots: 0 }),
);
assert.equal(
  JSON.stringify(parseWatcherHealth({ mode: "degraded", reason_code: "backend_init_failed", topology_revision: 1e12, pending_roots: 3 })),
  JSON.stringify({ mode: "degraded", reasonCode: "backend_init_failed", topologyRevision: 0, pendingRoots: 3 }),
  "越界 revision 限幅为 0，mode 与短 reason 照收",
);
assert.equal(parseWatcherHealth({ mode: "escalated", topology_revision: 1, pending_roots: 0 }), null, "闭集外 mode 必须拒绝");
// REVIEW P4 自看护：throttled 是 2026-09-22 新增的第 9 个原因码，且必须能与
// mode: "active" 共存（watcher 后端没坏，只是 CPU 持续过高）。
assert.equal(
  JSON.stringify(parseWatcherHealth({ mode: "active", reason_code: "throttled", topology_revision: 1, pending_roots: 0 })),
  JSON.stringify({ mode: "active", reasonCode: "throttled", topologyRevision: 1, pendingRoots: 0 }),
  "throttled 与 active 共存必须被接受",
);
assert.equal(
  JSON.stringify(parseWatcherHealth({ mode: "active", reason_code: "/private/raw/path/error" })),
  JSON.stringify({ mode: "active", reasonCode: null, topologyRevision: 0, pendingRoots: 0 }),
  "超长/路径样 reason 拒为 null",
);
assert.equal(parseWatcherHealth(null), null);
assert.equal(parseWatcherHealth("string"), null);

const source = readFileSync(path.join(ui, "react/src/features/findings/FindingsPage.tsx"), "utf8");
assert.ok(source.includes("listenAppEvents"));
assert.ok(source.includes("eventRefreshTimer"));
// 五处数据订阅者都经失效闸门（spec §6）；Settings 主 effect 另按类型分流。
for (const file of ["app/App.tsx", "features/usage/UsagePage.tsx", "features/sessions/SessionsPage.tsx", "features/findings/FindingsPage.tsx", "features/settings/SettingsPage.tsx"]) {
  const text = readFileSync(path.join(ui, "react/src", file), "utf8");
  assert.ok(text.includes("makeInvalidationGate()"), `${file} refreshes through the invalidation gate`);
  assert.ok(!text.includes("listenAppEvents(() => refresh())"), `${file} no longer refreshes on every event`);
}
assert.ok(!source.includes('listen("sync-status-updated"'));
assert.ok(!source.includes('listen("usage-fold-updated"'));
assert.ok(!source.includes('listen("trust-monitor-updated"'));
assert.ok(!source.includes('listen("source-data-deleted"'));
console.log("React event bus contract: OK (app-event allowlist, Invalidated revision/harnesses, invalidation gate, payload redaction, cleanup, burst queue, watcher-health closed set)");
