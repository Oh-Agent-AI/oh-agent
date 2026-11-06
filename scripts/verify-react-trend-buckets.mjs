#!/usr/bin/env node
// OVERVIEW_TREND_RANGE_SPEC §2：趋势图桶装配纯函数契约。
// 直接 esbuild 打包真实的 trendBuckets.ts 来执行（不是读源码字符串），钉住：
// 周起点（周一）、跨月周、月初/月末、未来桶、null≠0、unavailable≠0、niceMax。
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(repo, "apps/desktop/ui-dev");
const uiRequire = createRequire(path.join(ui, "package.json"));
const { buildSync } = uiRequire("esbuild");

const out = buildSync({
  entryPoints: [path.join(ui, "react/src/features/usage/trendBuckets.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent",
});
const mod = { exports: {} };
vm.runInNewContext(out.outputFiles[0].text, { module: mod, exports: mod.exports });
const t = mod.exports;
// vm 上下文的数组原型与本进程不同，deepStrictEqual 需先规整。
const plain = (value) => JSON.parse(JSON.stringify(value));

// —— 周起点：周一 ——
assert.equal(t.weekStartOf("2026-10-01"), "2026-09-28", "2026-10-01 是周四，所在周周一 = 09-28（跨月）");
assert.equal(t.weekStartOf("2026-09-28"), "2026-09-28", "周一自己");
assert.equal(t.weekStartOf("2026-10-04"), "2026-09-28", "周日归属本周（不是下周）");
assert.equal(t.weekStartOf("2026-10-05"), "2026-10-05", "下个周一开新周");
assert.equal(t.weekStartOf("2026-01-01"), "2025-12-29", "跨年：2026-01-01 周四 → 2025-12-29");
assert.deepEqual(plain(t.weekDates("2026-10-01")), ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
assert.equal(t.weekExtraMonth("2026-10-01"), "2026-09", "周跨月 → 需补读上月");
assert.equal(t.weekExtraMonth("2026-10-07"), null, "周全在本月 → 不补读");

// —— 月 ——
assert.equal(t.daysInMonth("2026-02"), 28);
assert.equal(t.daysInMonth("2028-02"), 29, "闰年");
assert.equal(t.daysInMonth("2026-10"), 31);
assert.equal(t.monthDates("2026-04").length, 30);
assert.equal(t.monthDates("2026-04")[0], "2026-04-01");
assert.equal(t.addDays("2026-03-01", -1), "2026-02-28", "月初倒推不经本地时区");
assert.equal(t.addDays("2026-03-08", 1), "2026-03-09", "美国 DST 换日附近仍恰好 +1 天");

// —— niceMax ——
assert.equal(t.niceMax(0), 1);
assert.equal(t.niceMax(-5), 1, "非正数不炸");
assert.equal(t.niceMax(1), 1);
assert.equal(t.niceMax(130000), 200000);
assert.equal(t.niceMax(246000), 500000);
assert.equal(t.niceMax(520000), 1000000);

// —— 小时桶 ——
const hourly = { date: "2026-10-01", harnesses_available: {}, hours: Array.from({ length: 24 }, (_, hour) => ({ hour, dsh_tokens: hour === 9 ? 100 : null, claude_tokens: hour === 9 ? 50 : 0, codex_tokens: null })) };
const hb = t.buildHourBuckets(hourly, { "9": 3 });
assert.equal(hb.length, 24, "恒 24 桶");
assert.equal(hb[9].failures, 3);
assert.equal(hb[10].failures, 0, "读到失败表且该小时无失败 = 真零");
assert.equal(t.bucketTotal(hb[9]), 150, "null 执行环境按 0 计入合计，不抛");
assert.equal(hb[9].codex, null, "读不到的执行环境保持 null，不被洗成 0");
assert.equal(t.buildHourBuckets(hourly, null)[9].failures, null, "失败表读不到 → failures null（不是 0）");
const hbDown = t.buildHourBuckets(null, {});
assert.ok(hbDown.every((b) => b.state === "unavailable") && hbDown.every((b) => t.bucketTotal(b) === 0), "小时数据读不到 → 全桶 unavailable");
assert.deepEqual(plain(hb.filter((b) => b.label).map((b) => b.label)), ["00", "06", "12", "18", "23"], "稀疏轴标签");

// —— 日桶 ——
const day = (date, dsh, claude, codex) => ({ date, total_tokens: dsh + claude + codex, dsh_tokens: dsh, claude_tokens: claude, codex_tokens: codex, costs: {}, cost_lines: [] });
const cals = {
  "2026-10": { month: "2026-10", days: [day("2026-10-01", 10, 20, 30)] },
  "2026-09": { month: "2026-09", days: [day("2026-09-29", 1, 2, 3)] },
};
const wk = t.buildDayBuckets(t.weekDates("2026-10-01"), "2026-10-01", cals, { "2026-10-01": 4, "2026-09-29": 2 });
assert.equal(wk.length, 7);
assert.equal(wk[0].state, "ok");
assert.equal(t.bucketTotal(wk[0]), 0, "日历读到但没这天 = 0 柱（无已观测事实）");
assert.equal(wk[0].failures, 0);
assert.equal(t.bucketTotal(wk[1]), 6, "跨月：上月日历补进 09-29");
assert.equal(wk[1].failures, 2);
assert.equal(wk[3].failures, 4);
assert.equal(t.bucketTotal(wk[3]), 60);
assert.ok(wk.slice(4).every((b) => b.state === "future" && b.failures === null && t.bucketTotal(b) === 0), "今天之后是 future 空位，不是 0 柱");
const wkMissingPrev = t.buildDayBuckets(t.weekDates("2026-10-01"), "2026-10-01", { "2026-10": cals["2026-10"], "2026-09": null }, {});
assert.ok(wkMissingPrev.slice(0, 3).every((b) => b.state === "unavailable"), "上月日历读不到 → unavailable，不是 0");
assert.equal(wkMissingPrev[3].state, "ok");
const noFail = t.buildDayBuckets(["2026-10-01"], "2026-10-01", cals, null);
assert.equal(noFail[0].failures, null, "失败日表读不到 → null，不是 0");
const mb = t.buildDayBuckets(t.monthDates("2026-10"), "2026-10-01", cals, {}, undefined, 5);
assert.equal(mb.length, 31);
assert.equal(mb.filter((b) => b.state === "future").length, 30, "月初只有 1 柱 + 30 个未来位");
assert.deepEqual(plain(mb.filter((b) => b.label).map((b) => b.label)), ["1", "6", "11", "16", "21", "26", "31"], "月档稀疏标签每 5 天");
assert.throws(() => t.weekStartOf("2026-1-1"), /非法日期/, "非法日期显式失败，不猜");

console.log("trend buckets contract: ok");
