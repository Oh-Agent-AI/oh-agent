#!/usr/bin/env node
// 修复城市面板中英文案守卫：controller.ts / planAudit.ts 直接产出中文，面板在呈现期经 repairCopy.ts 翻译。
//   (a) controller.ts 里所有「代码或提示 → 中文」的映射值（阻断原因、警告、提示、标签）英文下必须不含汉字——
//       新增一条中文消息却忘了补译文，这里就红；
//   (b) 带数字/标签/列表的模板消息抽样：英文下无汉字，且数字、标签原样保留；
//   (c) zh 下原样返回；未知文案原样返回（不编造译文）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCity } from "./city-kit/index.mjs";

globalThis.window ??= globalThis;
const k = await loadCity({ "planRepair/repairCopy.ts": ["repairText", "EXACT"] });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasCjk = (text) => /[一-鿿]/.test(text);
const en = (text) => k.repairText(text, "en");

// (a) 从 controller.ts 源码取映射值：`"key": "中文"`、`key: "中文"`、`text: "中文"` 的单行字面量。
const source = readFileSync(path.join(repo, "apps/agent-city/ui/src/planRepair/controller.ts"), "utf8");
const literals = new Set();
for (const line of source.split("\n")) {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
  for (const match of line.matchAll(/(?:^\s*"?[\w-]+"?|text|reason|warning):\s*"([^"`$\\]*[一-鿿][^"`$\\]*)"/g)) literals.add(match[1]);
}
const panel = readFileSync(path.join(repo, "apps/agent-city/ui/src/planRepair/PlanRepairPanel.tsx"), "utf8");
for (const match of panel.matchAll(/(?:label|hint|\b\w+Label|\b[a-zA-Z]+):\s*"([^"`$\\]*[\u4e00-\u9fff][^"`$\\]*)"/g)) literals.add(match[1]);
for (const match of panel.matchAll(/\b(?:title|aria-label)="([^"{]*[\u4e00-\u9fff][^"{]*)"/g)) literals.add(match[1]);
assert.ok(literals.size > 70, `expected to find the controller's message tables, got ${literals.size}`);
const missing = [...literals].filter((zh) => hasCjk(en(zh)));
assert.deepEqual(missing, [], `controller 文案缺英文译文（补进 planRepair/repairCopy.ts）:\n  ${missing.join("\n  ")}`);

// (b) 模板消息
const samples = [
  ["将在交叉处自动生成 3 个路口", "3 junction"],
  ["开发商安置了 4 栋会话楼", "rehomed 4"],
  ["在新位置补了一条 52 长的接入路", "length 52"],
  ["已撤回一个点（还有 2 个）", "2 left"],
  ["不能这样画：新路必须接到现有道路上；路口夹角太小（小于 30°）", "A new road must connect to an existing road; Junction angle too small"],
  ["已搬过去（移动距离很远；会留下一个断头路）", "A long move; It would leave a dead-end road"],
  ["已改成主干道（主干道会变窄）", "arterial"],
  ["已选中学校，附近有 5 个可搬去的空街区（绿色）；点任一处搬过去，或点「拆除」", "School selected; 5 open block"],
  ["已拆除摩天轮（撤销可恢复）", "Ferris wheel demolished"],
  ["将推平 2 座设施（预估，鼠标停住后给出确切结果）", "estimate"],
  ["会话楼 abc 与 def 的占地相交", "abc and def"],
  ["街区 b7 有楼但离最近道路 63（> 40）", "63"],
  ["12 处", "12 edit"],
  ["17 个问题（显示前 8 个）", "first 8 shown"],
];
for (const [zh, expected] of samples) {
  const out = en(zh);
  assert.ok(!hasCjk(out), `still Chinese: ${zh} → ${out}`);
  assert.ok(out.includes(expected), `${zh} → ${out} (expected to contain "${expected}")`);
}

// (c) zh / 未知文案
assert.equal(k.repairText("已搬过去", "zh-Hans"), "已搬过去");
assert.equal(en("某条没登记过的新文案"), "某条没登记过的新文案");
console.log(`City repair copy: ${literals.size} controller strings + ${samples.length} template samples translate with no Chinese left; zh and unknown text pass through.`);
