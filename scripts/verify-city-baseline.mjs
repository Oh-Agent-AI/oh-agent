#!/usr/bin/env node
// 规划基线哈希（CITY_ARCHITECTURE 迁移步 2）：30 个岛（10 种子 × 1/2/5 档）的规划结果各取一个规范化哈希，
// 与 golden/city-plan-baseline.json 逐岛比较。用途是「重构不改行为」的机器证明——拆文件、换加载方式、
// 抽取约束时哈希必须不变；有意改规划时才 --update，且必须先看 --diff 确认变化是想要的。
//   node scripts/verify-city-baseline.mjs            校验
//   node scripts/verify-city-baseline.mjs --diff     校验并列出每个不一致岛的差异分区
//   node scripts/verify-city-baseline.mjs --update   重写基线（先确认！反射性 --update 会让这条守卫失去意义）
//
// 生成器版本（engine/generatorVersion.ts）跟基线绑在一起：基线文件记下写入时的 CITY_GENERATOR_VERSION。
//   · --update 时只要有岛的哈希变了，就要求版本已经递增——用户补丁按 id 引用这一代地图，布局变了而版本不变，
//     编辑器就不会重定位旧补丁，会把它原样套在新地图上。纯重构哈希不变，--update 也不会被拦。
//   · 校验时代码里的版本必须等于基线记下的版本：只递增版本、不重建基线，同样是漏了一半。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { cachedPlan, loadCity, repo } from "./city-kit/index.mjs";

const { createCityPlan: rawPlan, MIAMI_COASTAL, CITY_GENERATOR_VERSION } = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/generatorVersion.ts": ["CITY_GENERATOR_VERSION"],
});
const goldenPath = path.join(repo, "golden/city-plan-baseline.json");

const round = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
const norm = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "number" ? round(v) : v)));
const hash = (value) => crypto.createHash("sha1").update(JSON.stringify(norm(value))).digest("hex").slice(0, 16);

/** 分区哈希：出现差异时能指出是路网、用地、地块还是车流变了。 */
function sections(plan) {
  for (const ramp of plan.highwayRamps ?? []) {
    const end = ramp.points.at(-1);
    const touches = plan.roadEdges.some(edge => !edge.bridge && edge.structure !== "deck" && edge.points.slice(1).some((b, i) => {
      const a = edge.points[i], dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((end.x - a.x) * dx + (end.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      return Math.hypot(end.x - a.x - t * dx, end.z - a.z - t * dz) < 0.02;
    }));
    assert.ok(touches, "every accepted ramp must still touch a real ground host after solve and finalization");
  }
  return {
    roads: hash({ nodes: plan.roadNodes, edges: plan.roadEdges }),
    sites: hash({ publicSites: plan.publicSites, landmarks: plan.landmarks }),
    blocks: hash(plan.blocks.map((b) => ({ id: b.id, zone: b.zone, polygon: b.polygon, parcels: b.parcels.map((p) => [p.id, p.x, p.z, p.yaw, p.width, p.depth]) }))),
    skeleton: hash({ core: plan.core, coast: plan.coast, highways: plan.highways, bridges: plan.bridges, river: plan.river, islandRadius: plan.islandRadius }),
    infrastructure: hash({ junctionRings: plan.junctionRings, highwayRamps: plan.highwayRamps }),
    traffic: hash(plan.carPaths),
    seaside: hash(plan.seaside ?? null),
  };
}

const current = {};
for (const tier of [1, 2, 5]) for (let i = 0; i < 10; i += 1) {
  const seed = 1703294958 + i * 7919;
  const s = sections(cachedPlan(rawPlan, seed, tier, MIAMI_COASTAL));
  current[`${seed}/t${tier}`] = { all: hash(s), ...s };
}

// 基线里的岛条目之外只有这一个键；引入版本戳之前写下的基线没有它，按 1 读。
const goldenVersion = (golden) => golden.generatorVersion ?? 1;
const islandKeys = Object.keys(current);

if (process.argv.includes("--update")) {
  if (fs.existsSync(goldenPath)) {
    const previous = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
    const moved = islandKeys.filter((k) => previous[k]?.all !== current[k].all);
    assert(!moved.length || CITY_GENERATOR_VERSION > goldenVersion(previous),
      `plan changed on ${moved.length}/${islandKeys.length} islands but CITY_GENERATOR_VERSION is still ${CITY_GENERATOR_VERSION}. `
      + `有意改变布局要在同一提交递增 apps/agent-city/ui/src/engine/generatorVersion.ts（编辑器靠它重定位用户旧补丁），再 --update。`);
  }
  fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
  fs.writeFileSync(goldenPath, `${JSON.stringify({ generatorVersion: CITY_GENERATOR_VERSION, ...current }, null, 1)}\n`);
  console.log(`City baseline: rewrote ${islandKeys.length} island hashes (generator version ${CITY_GENERATOR_VERSION}).`);
  process.exit(0);
}

assert(fs.existsSync(goldenPath), "golden/city-plan-baseline.json missing — run with --update once and review");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const changed = islandKeys.filter((k) => golden[k]?.all !== current[k].all);
if (changed.length) {
  const lines = changed.map((k) => `${k}: ${Object.keys(current[k]).filter((s) => s !== "all" && golden[k]?.[s] !== current[k][s]).join(", ") || "(new island)"}`);
  assert.fail(`plan changed on ${changed.length}/${islandKeys.length} islands (differing sections below). 重构应保持哈希不变；有意改规划请先 --diff 审阅再 --update：\n  ${lines.join("\n  ")}`);
}
assert.equal(CITY_GENERATOR_VERSION, goldenVersion(golden),
  `CITY_GENERATOR_VERSION is ${CITY_GENERATOR_VERSION} but the baseline was written by version ${goldenVersion(golden)}: 递增版本与重建基线必须在同一提交。`);
console.log(`City baseline: ${islandKeys.length} island plans match golden/city-plan-baseline.json (roads, sites, blocks, skeleton, infrastructure, traffic, seaside; generator version ${CITY_GENERATOR_VERSION}).`);
