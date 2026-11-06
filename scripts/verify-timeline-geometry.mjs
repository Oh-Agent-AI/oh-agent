#!/usr/bin/env node
// 断言通用时间线几何（src-tauri/ui/timeline.js）的 SVG 形状在 0/1/N 点、
// 缺口、累计序列、事件保真下的行为 —— docs/TRAJECTORY_TIMELINE_SPEC.md §9。
//
// 为什么是 node：几何是浏览器里的纯函数，但「错图不抛异常、单测全绿」是这类
// bug 的命门（Codex svTimelineSvg 踩过单桶退化、DSH timeline.ts 踩过抽稀丢
// 事件），必须能对几何产物下断言，而不是等人眼看出来。这个脚本由
// tests/test_timeline_geometry.py 调 node 执行，本地 unittest 与 CI python
// job 都跑它。

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildTimeline } = require("../apps/desktop/src-tauri/ui/timeline.js");

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log("  ok  " + msg);
  else { failed++; console.error("FAIL  " + msg); }
};

const pts = (vals) => vals.map((v, i) => ({ ordinal: i, values: { tokens: v } }));

console.log("# timeline 几何（0/1/N 点、缺口、累计、事件）");

// ── 0 点 → 空态，不是残图 ──
const empty = buildTimeline({ points: [], events: [] });
ok(empty.includes("tl-empty") && !empty.includes("<svg"), "0 点 → 空态消息且无 <svg>");

// ── 1 点 → 居中柱，不退化成零长线 ──
const one = buildTimeline({ points: pts([100]), events: [] });
ok(one.includes("<svg"), "1 点 → 产出 <svg>");
ok(one.includes('class="tl-bar"'), "1 点 → 画 <rect class=tl-bar>");
ok(!one.includes("tl-line"), "1 点 → 不再画退化折线");
const oneW = Number((one.match(/class="tl-bar" x="[\d.-]+" y="[\d.-]+" width="([\d.]+)"/) || [])[1]);
ok(oneW > 0, "1 点 → 柱宽 > 0（" + oneW + "）");

// ── N 点 → 一条折线，段首恰好一个 M ──
const three = buildTimeline({ points: pts([100, 500, 900]), events: [] });
const lineD = (three.match(/class="tl-line"[^>]* d="([^"]+)"/) || [])[1];
const mCount = (lineD.match(/M/g) || []).length;
ok(mCount === 1, "3 点全测 → 折线恰好 1 段（M 计数=" + mCount + "）");
ok(lineD.includes("L"), "3 点 → 折线含 L 连接");

// ── 缺数据断开：中间 null（原始值序列）→ 两段，不跨缺口插值 ──
const gappy = buildTimeline({ points: pts([100, null, 900]), events: [] });
const gapD = (gappy.match(/class="tl-line"[^>]* d="([^"]+)"/) || [])[1];
const gapM = (gapD.match(/M/g) || []).length;
ok(gapM === 2, "中缺值（原始序列）→ 折线断成 2 段（M 计数=" + gapM + "），不连直线");

// ── 累计序列：缺的是"这一笔加了多少"，沿用上一格、不产生缺口 ──
const cum = buildTimeline({
  points: pts([100, null, 900]),
  events: [],
  series: [{ name: "tokens", label: "tokens", cumulative: true }],
});
const cumD = (cum.match(/class="tl-line"[^>]* d="([^"]+)"/) || [])[1];
const cumM = (cumD.match(/M/g) || []).length;
ok(cumM === 1, "中缺值（累计序列）→ 连成 1 段（沿用上一格，M 计数=" + cumM + "）");

// ── 事件保真：每个有效 ordinal 的事件都画出来，且不聚合 ──
const evPoints = pts([10, 20, 30]);
const withEv = buildTimeline({
  points: evPoints,
  events: [
    { ordinal: 0, kind: "risk", label: "rm -rf", severity: "critical", targetId: "f1" },
    { ordinal: 1, kind: "waste", label: "retry" },
    { ordinal: 2, kind: "compaction", label: "prune" },
  ],
});
const evCount = (withEv.match(/class="tl-event"/g) || []).length;
ok(evCount === 3, "3 个事件 → 3 个标记（eventsIn === eventsOut，实际=" + evCount + "）");
ok(withEv.includes('data-kind="risk"') && withEv.includes('data-severity="critical"'),
  "事件标记带 data-kind / data-severity");
ok(withEv.includes('data-target="f1"'), "事件标记带 data-target（可聚焦到 finding）");

// ── 定位不到 ordinal 的事件：跳过，不画在猜的位置 ──
const orphan = buildTimeline({
  points: evPoints,
  events: [{ ordinal: 999, kind: "risk", label: "orphan" }],
});
const orphanCount = (orphan.match(/class="tl-event"/g) || []).length;
ok(orphanCount === 0, "定位不到 ordinal 的事件 → 跳过（不画在猜的位置）");

if (failed) { console.error("\n" + failed + " 项断言失败"); process.exit(1); }
console.log("\n通过。");
