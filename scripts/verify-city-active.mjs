#!/usr/bin/env node
// City「活跃」口径守卫：活跃 = 今天（本机本地日）有过事件——与菜单栏「N sessions」同一口径。
// 曾是「last_event 距今 10 分钟内」：真机 22:12 时 City 显示 ZCode 0 active，菜单栏同时显示 ZCode 今天 2 sessions。
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const code = buildSync({ entryPoints: [new URL("../apps/agent-city/ui/src/cityModel.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, Date, Math, JSON, Map, Set, Number, String, Array, Object });
const { buildCityModel, isActiveToday } = mod.exports;

const local = (h, m, dayOffset = 0) => { const d = new Date(2026, 9, 5 + dayOffset, h, m, 0, 0); return d.getTime(); };
const iso = (ms) => new Date(ms).toISOString();
const now = local(22, 12);
const tokens = (total) => ({ uncached_input_tokens: total, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total });
const row = (ref, harness, first, last, total) => ({ session_ref: ref, harness, first_event_at: iso(first), last_event_at: iso(last),
  event_count: 10, model_ids: [], tokens: tokens(total), peak_tokens: total, cost_minor: null,
  cost_status: { state: "unavailable", reason: "test", has_unresolved: false } });

// 真机场景：两个今天的 zcode 会话（一个 21:21 停、一个 17:03 停）+ 一个昨天的会话。
const rows = [
  row("z-today-late", "harness:zcode", local(14, 11, -3), local(21, 21), 26_000_000),
  row("z-today-afternoon", "harness:zcode", local(14, 6), local(17, 3), 106_000_000),
  row("z-yesterday", "harness:zcode", local(0, 50, -1), local(1, 5, -1), 19_000_000),
];
const model = buildCityModel({ rows, findings: [], windowStartMs: now - 30 * 86_400_000, windowEndMs: now, windowLabel: "30d",
  totalSessions: rows.length, truncated: false, generatedAt: now, harnessNames: { "harness:zcode": "ZCode" } });
const zcode = model.districts.find((district) => district.id === "harness:zcode");
assert.equal(zcode.sessionCount, 3);
assert.equal(zcode.activeCount, 2, "active = sessions with an event today (local), same as the menu bar");
assert.equal(model.stats.activeCount, 2);
// 日界：昨天 23:59 不算，今天 00:00 算；未来时间（时钟漂移超过 1 分钟）不算。
assert.equal(isActiveToday(local(23, 59, -1), now), false);
assert.equal(isActiveToday(local(0, 0), now), true);
assert.equal(isActiveToday(now + 5 * 60_000, now), false);
console.log("City active: passed (active = event today in local time, matches the menu bar; day boundary; overflow counted).");
