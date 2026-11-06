#!/usr/bin/env node
// 断言 codex_session.html 模板的时间线几何 == 共享 timeline.js（锁步），且调用点走
// 共享的 TimelineGeometry.buildTimeline，不再有内联的 svTimelineSvg 第二份拷贝。
//
// 为什么：几何「只写一份」（docs/TRAJECTORY_TIMELINE_SPEC.md §6）。模板内联的
// 几何一旦与 src-tauri/ui/timeline.js 漂移，就会回到「三份各画各的、比例尺算错
// 不报错」的旧坑。这里的锁步是 pricing.json 同款——源文件是唯一真相，内联副本
// 逐字节对齐，漂移当天下一个 CI 就红。
//
// 几何本身的形状断言在 verify-timeline-geometry.mjs（对源文件下断言，一次不是
// 三次）；这里只守「模板内联副本 == 源」与「调用点不旁路」。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tpl = readFileSync(
  join(here, "..", "assets", "templates", "codex_session.html"),
  "utf8",
);
const src = readFileSync(join(here, "..", "apps", "desktop", "src-tauri", "ui", "timeline.js"), "utf8");

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log("  ok  " + msg);
  else { failed++; console.error("FAIL  " + msg); }
};

console.log("# codex_session.html 时间线几何锁步");

// 1) 抽取 >>> sv-timeline-geometry 块，逐字节对齐源 timeline.js（容忍尾随换行差）。
const m = tpl.match(/\/\/ >>> sv-timeline-geometry[^\n]*\n([\s\S]*?)\n\s*\/\/ <<< sv-timeline-geometry/);
if (!m) { console.error("FAIL  找不到 sv-timeline-geometry 标记块"); process.exit(1); }
const inlined = m[1];
ok(
  inlined.trimEnd() === src.trimEnd(),
  `模板内联几何 == src-tauri/ui/timeline.js（内联 ${inlined.length}B / 源 ${src.length}B）`
);

// 2) 调用点走 TimelineGeometry.buildTimeline，不旁路成手写 svTimelineSvg。
ok(tpl.includes("TimelineGeometry.buildTimeline({"), "调用点走 TimelineGeometry.buildTimeline()");
ok(!tpl.includes("svTimelineSvg("), "模板里不再有内联 svTimelineSvg 第二份拷贝");
// 3) 事件叠加已接线：buildTimeline 收 events（findings 对齐到小时桶），对齐字典
//    读 turn_timeline 执行环境侧折好的 hour 键——浏览器不重算北京时间。
ok(tpl.includes("events: tlEvents"), "调用点把 tlEvents 传给 buildTimeline");
ok(tpl.includes("seqToHour[te.source_order]"), "事件对齐读 turn_timeline.source_order→hour");
ok(tpl.includes("var seqToHour"), "对齐字典在模板内声明（hour 键来自执行环境，不在浏览器算）");

// 4) 内联副本真的能用：eval 出 TimelineGeometry，画一个 3 点序列确认产出 sv-* SVG。
//    （形状的完整断言在 verify-timeline-geometry.mjs，这里只证明内联副本不是死代码。）
let geoModule = null;
new Function(inlined + "\n;globalThis.__inline_geo = (typeof module !== 'undefined' && module.exports) ? module.exports : this.TimelineGeometry;")();
geoModule = globalThis.__inline_geo;
const svg = geoModule.buildTimeline({
  points: [{ ordinal: 0, values: { tokens: 100 } }, { ordinal: 1, values: { tokens: 500 } }],
  classPrefix: "sv",
});
ok(svg.includes("<svg") && svg.includes("sv-line"), "内联副本 eval 后能产出 sv-* SVG");

if (failed) { console.error("\n" + failed + " 项断言失败"); process.exit(1); }
console.log("\n通过。");
