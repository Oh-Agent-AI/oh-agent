#!/usr/bin/env node
// 建筑与周边场景的物理依赖守卫（用户：「确认它和周边场景物理依赖关系」）。对 30 个岛（10 种子 × 1/2/5 档）的
// 每个地标与公共用地断言：
//   1. 立在陆地上：占地圈 16 点地形高于水面（岸边类允许 ≤4 点落在岸滩/水边）；
//   2. 门前有路：最近非桥路段离边缘 ≤ 20；
//   3. 不被道路穿过：中心到路 ≥ 0.7 半径（市政广场 = 环岛、凯旋门 = 骑路，按各自规则单独断言）；
//   4. 凯旋门骑路：有主干道从中心 3 内穿过，且开口轴（局部 z）与该路方向夹角 < 15°；
//   5. 互不重叠、不压地块：两两中心距 ≥ 半径和；没有地块中心落在用地半径内。
import assert from "node:assert/strict";
import { cachedPlan, loadCity } from "./city-kit/index.mjs";

// 原生加载（不进 vm）+ 进程内缓存：下面五段循环原先各自重新生成同一批 30 个岛。
const { createCityPlan: rawPlan, MIAMI_COASTAL, planAirport, roadSamples, CONSTRAINTS, planSites } = await loadCity({
  "engine/planner/constraints.ts": ["CONSTRAINTS", "planSites"],
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/cityAirport.ts": ["planAirport", "roadSamples"],
});
const createCityPlan = (seed, tier, config) => cachedPlan(rawPlan, seed, tier, config);

// 度量来自共享模块 engine/planner/constraints.ts（规划器与守卫同一份 measure）；容忍计数留在下面的断言里。
const byId = Object.fromEntries(CONSTRAINTS.map((c) => [c.id, c]));
const bad = { wet: [], noRoad: [], through: [], arch: [], overlap: [], parcel: [], frontage: [] };
let checked = 0;
for (const tier of [1, 2, 5]) for (let i = 0; i < 10; i += 1) {
  const seed = 1703294958 + i * 7919;
  const plan = createCityPlan(seed, tier, MIAMI_COASTAL);
  checked += planSites(plan).length;
  const tag = `${seed}/t${tier}`;
  const push = (list, id) => { for (const x of byId[id].measure(plan)) list.push(`${tag} ${x.detail}`); };
  push(bad.wet, "siteInWater");
  push(bad.noRoad, "siteWithoutDoorRoad");
  push(bad.frontage, "stationStadiumSetback");
  push(bad.frontage, "stationDoorFacesRoad");
  push(bad.arch, "archStraddlesRoad");
  push(bad.through, "roadThroughSite");
  push(bad.overlap, "sitesOverlap");
  push(bad.parcel, "parcelInsideSite");
}
const report = Object.entries(bad).map(([k, v]) => `${k} ${v.length}`).join(", ");
// 上限：沿用规划守卫口径——0 容忍穿路/压地块/凯旋门不骑路；陆地与入口给少量余量（岸边地形噪声）。
assert.equal(bad.arch.length, 0, `arch must straddle a main road:\n  ${bad.arch.join("\n  ")}`);
// F1 闭环（cityPlan 终筛前的「路穿用地」修复循环，含沿海岸换位兜底）之后不再有容忍项：必须为 0。
assert(bad.through.length === 0, `roads through sites:\n  ${bad.through.join("\n  ")}`);
assert(bad.frontage.length <= 2, `stations/stadiums set back from the road:\n  ${bad.frontage.join("\n  ")}`);
assert.equal(bad.parcel.length, 0, `lots inside sites:\n  ${bad.parcel.slice(0, 8).join("\n  ")}`);
assert(bad.overlap.length === 0, `overlapping sites:\n  ${bad.overlap.join("\n  ")}`);
assert(bad.wet.length <= 3, `sites standing in water:\n  ${bad.wet.join("\n  ")}`);
assert(bad.noRoad.length <= 3, `sites without a road at the door:\n  ${bad.noRoad.join("\n  ")}`);
console.log(`City context: ${checked} sites/landmarks on 30 islands — ${report} passed.`);

// 海上岛地标（歌剧院）：必须有堤道桥连到岸、岸点踩在实地上、占地圈在深水里。
for (const tier of [1, 5]) for (let i = 0; i < 10; i += 1) {
  const plan = createCityPlan(1703294958 + i * 7919, tier, MIAMI_COASTAL);
  const opera = plan.landmarks.find((s) => s.kind === "sail-opera");
  if (!opera || !opera.shore) continue;
  assert(plan.terrain.height(opera.shore.x, opera.shore.z) > 0.2, `opera causeway lands in water (tier ${tier} #${i})`);
  const bridge = plan.roadEdges.find((e) => e.bridge && (Math.hypot(e.points[0].x - opera.shore.x, e.points[0].z - opera.shore.z) < 1 || Math.hypot(e.points[1].x - opera.shore.x, e.points[1].z - opera.shore.z) < 1));
  assert(bridge, `opera causeway missing (tier ${tier} #${i})`);
}

// 机场岛：整个 240×110 平台必须全在水里（用户截图：平台一角压在陆地上）。逐岛按渲染同一套参数选址，再独立采样平台范围。
let airports = 0; let airportIslands = 0;
for (const tier of [1, 2, 5]) for (let i = 0; i < 10; i += 1) {
  const seed = 1703294958 + i * 7919;
  const plan = createCityPlan(seed, tier, MIAMI_COASTAL); airportIslands += 1;
  const avoid = [...plan.publicSites.filter((x) => x.kind === "harbor"), ...plan.landmarks.filter((x) => x.kind === "sail-opera"), ...(plan.seaside && !plan.seaside.degraded ? plan.seaside.samples.filter((x) => x.valid).map((x) => x.waterline) : [])];
  const a = planAirport(plan.coast, plan.core ?? { x: 0, z: 0 }, avoid, roadSamples(plan.roadEdges), (x, z) => plan.terrain.height(x, z) < -0.6);
  if (!a) continue; airports += 1;
  const c = Math.cos(a.yaw), sn = Math.sin(a.yaw);
  for (let lx = -120; lx <= 120; lx += 12) for (let lz = -55; lz <= 55; lz += 11) {
    const h = plan.terrain.height(a.centre.x + lx * c + lz * sn, a.centre.z - lx * sn + lz * c);
    assert(h < 0.3, `airport platform stands on land (seed ${seed} t${tier}, h=${h.toFixed(2)})`);
  }
}
assert(airports >= airportIslands - 3, `airport placed on only ${airports}/${airportIslands} islands`);
console.log(`City airport: ${airports}/${airportIslands} islands placed with the whole platform over water.`);

// 悬索桥（门式塔高 34）不得被环线高架穿过：桥身整段离高架 ≥ 36（用户截图：高架从塔架中间穿过）。
let suspension = 0;
for (const tier of [1, 2, 5]) for (let i = 0; i < 10; i += 1) {
  const seed = 1703294958 + i * 7919;
  const plan = createCityPlan(seed, tier, MIAMI_COASTAL);
  const bridge = plan.landmarks.find((l) => l.kind === "suspension-bridge");
  if (!bridge) continue; suspension += 1;
  assert.equal(byId.suspensionBridgeClearOfHighways.measure(plan).length, 0, `expressway runs through the suspension bridge (seed ${seed} t${tier})`);
}
console.log(`City suspension bridge: ${suspension}/30 islands have one, none crossed by the elevated ring road.`);

// 市政广场必须在环岛中心：广场与核心点（环岛/放射主干道的圆心）重合（用户截图：广场偏在环岛一旁）。
let plazaOff = 0;
for (const tier of [1, 2, 5]) for (let i = 0; i < 10; i += 1) {
  const seed = 1703294958 + i * 7919;
  const plan = createCityPlan(seed, tier, MIAMI_COASTAL);
  plazaOff += byId.civicPlazaCentred.measure(plan).length;
}
assert.equal(plazaOff, 0, `civic plaza is off the roundabout centre on ${plazaOff} islands`);
console.log("City plaza: the civic plaza sits at the roundabout centre on all 30 islands.");
