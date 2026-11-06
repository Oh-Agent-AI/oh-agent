#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
// 原生加载同一生产函数；避免 vm 沙箱把完整规划放慢约八倍。
const { THREE, createCityPlan, clearsHighways, SegmentIndex, segmentDistance, buildSkeleton, emptyNetwork, buildInfrastructure, buildDistrictExpressways, expresswayRun, EXPRESSWAY_DECK_THICKNESS } = await loadCity({
  "pkg:three": ["* as THREE"],
  "engine/cityPlan.ts": ["createCityPlan", "clearsHighways", "SegmentIndex", "segmentDistance"],
  "engine/planner/skeleton.ts": ["buildSkeleton"],
  "engine/planner/network.ts": ["emptyNetwork"],
  "engine/systems/roadSystem.ts": ["buildInfrastructure", "buildDistrictExpressways"],
  "engine/surface/structureCompiler.ts": ["expresswayRun"],
  "engine/render/shared.ts": ["EXPRESSWAY_DECK_THICKNESS"],
});
class Harness {
  group = new THREE.Group(); disposables = [];
  positionVector = new THREE.Vector3(); euler = new THREE.Euler();
  quaternion = new THREE.Quaternion(); scaleVector = new THREE.Vector3();
  matrix = new THREE.Matrix4(); color = new THREE.Color();
  constructor(layout) { this.layout = layout; }
  makeInstanced(geometry, material, count) { return this.mesh = new THREE.InstancedMesh(geometry, material, count); }
  run() { buildInfrastructure(this); }
}
const harness = new Harness({ roadEdges: [{ bridge: true, width: 8, points: [{ x: -40, z: 0 }, { x: 40, z: 0 }] }],
  terrain: { height: (x) => Math.abs(x) >= 40 ? 1.2 : -3 } });
harness.run();
assert(harness.mesh.count >= 4, "bridge includes deck, rails and piers");
const matrix = new THREE.Matrix4();
harness.mesh.getMatrixAt(0, matrix);
assert(Math.abs(matrix.elements[0] - 80.5) < 0.001, "deck connects both banks");
assert(Math.abs(matrix.elements[13] + matrix.elements[5] - 1.2) < 0.001, "deck top meets approaches above water");
assert(harness.mesh.count > 12, "bridge includes edge lines and dashed center markings in the furniture batch");
// 出口的连续短弧不能被桥面渲染的旧 6 单位阈值吃掉（用户截图：桥面断开但桥墩还在）。
{
  const points = [{ x: -120, z: 0 }, { x: -9, z: 0 }, { x: -6, z: 2 }, { x: -3, z: 4 }, { x: 0, z: 6 }];
  const short = new Harness({ highways: [points], terrain: { height: () => 1.2 } });
  buildDistrictExpressways(short);
  // 桥面板是连续网格（2026-10-21，弯道不再张开楔形裂口）：每个重采样段的中点都要落在桥面顶面上。
  const mesh = short.group.getObjectByName("city-district-expressway-deck");
  assert.ok(mesh, "the expressway deck is rendered");
  const pos = mesh.geometry.getAttribute("position"); const tops = [];
  for (let i = 0; i < pos.count; i += 3) {
    const t = [0, 1, 2].map((k) => ({ x: pos.getX(i + k), y: pos.getY(i + k), z: pos.getZ(i + k) }));
    if (Math.abs((t[1].x - t[0].x) * (t[2].z - t[0].z) - (t[1].z - t[0].z) * (t[2].x - t[0].x)) > 1e-6) tops.push(t);
  }
  const inside = (p, t) => { const d = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x); const d1 = d(t[0], t[1], p), d2 = d(t[1], t[2], p), d3 = d(t[2], t[0], p);
    return !((d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9) && (d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9)); };
  const sampled = expresswayRun(short.layout, points).points;
  assert.ok(sampled.length > points.length, "long ramp segments are resampled");
  for (let i = 1; i < sampled.length; i += 1) {
    const mid = { x: (sampled[i - 1].x + sampled[i].x) / 2, z: (sampled[i - 1].z + sampled[i].z) / 2 };
    assert.ok(tops.some((t) => inside(mid, t)), `every resampled segment, including consecutive short exit arcs, has a bridge deck (segment ${i})`);
  }
  for (const disposable of short.disposables) disposable.dispose();
}
const distant = new SegmentIndex([[{ x: 150, z: 0 }, { x: 150, z: 10 }]]);
assert(distant.closerThan({ x: 0, z: 0 }, 160), "large footprint queries search beyond adjacent cells");
assert(!distant.closerThan({ x: 0, z: 0 }, 140), "large footprint guard remains distance-based");
let corpusRuns = 0;
for (const seed of [1927, 42, 1485618003, 987654]) {
  const plan = createCityPlan(seed, 2);
  for (const run of plan.highways) {
    if (Math.hypot(run[0].x - run.at(-1).x, run[0].z - run.at(-1).z) < 0.01) continue;
    for (const endpoint of [run[0], run.at(-1)]) {
      assert(plan.roadEdges.some((edge) => !edge.bridge && segmentDistance(endpoint, edge.points[0], edge.points[1]) < 0.02), `seed ${seed}: ramp ends on a ground road`);
      assert(plan.terrain.height(endpoint.x, endpoint.z) >= 1.2, `seed ${seed}: ramp ends on land`);
    }
  }
  assert.deepEqual(plan.highways, createCityPlan(seed, 2).highways, `seed ${seed}: deterministic exits`);
  corpusRuns += plan.highways.length;
}
assert.ok(corpusRuns > 0, "seed corpus: at least one expressway run survives at tier 2");
// 档位：每档 400 栋，最多 10 档 = 4000 栋（scaleTierFor 夹在 MAX_TIER = 10）。
// 2026-10-16 起干线筛查收紧（plan-repair 残余收敛：跨水地面段按 water-span 拒绝，
// 见 skeleton.ts screenTrunkRoute），环线出口不再有跨水地面宿主可接——环线是否成环
// 变成地理依赖（seed 42 各档保留，1485618003/1927/987654 目前全无）。
// 「每档保留跨水高架」因此从固定单 seed 改为语料级不变量；单 seed 全档必有的旧断言
// 依赖的是已被移除的非法跨水地面路，不恢复。
// 档 1 不要求语料里有高架（footprint guard 照查）：上面的语料级断言（2c960e15）写在驾驶线上，
// 当时规划器还没有 ad697cfa 的「出口只接朝前干道」（弦与环线切线 ≤60°，不行就回缩最多 8 点，
// 两端凑不齐就整条剪掉——为消除 150°–180° 回折尖刺，有意为之）。合并 8c647cf2 把两边断言融合，
// 但合并验证清单没有跑本脚本：ad697cfa 起 seed 42 档 1（R 542）主环 72 点只找到 1 个朝前出口、
// 被剪，四个 seed 档 1 全部无高架（档 2/5/10 仍由 seed 42 保留）。小档城市半径小、环线贴岸，
// 本来就最容易凑不齐朝前出口；这是规划器的有意取舍，不是渲染回归，所以存在性只在 5/10 档断言。
const tierSeeds = [1927, 42, 987654, 1485618003];
const tiersWithExpressways = new Set([5, 10]);
for (const tier of [1, 5, 10]) {
  let runs = 0; let crossings = 0;
  for (const seed of tierSeeds) {
    const plan = createCityPlan(seed, tier);
    runs += plan.highways.length;
    crossings += plan.highways.reduce((sum, run) => sum + run.filter((p) => plan.terrain.height(p.x, p.z) < 0).length, 0);
    for (const block of plan.blocks) for (const parcel of block.parcels) {
      assert(clearsHighways(parcel, parcel.width, parcel.depth, plan.highways), `tier ${tier}/seed ${seed}: expressway footprint guard`);
    }
  }
  if (!tiersWithExpressways.has(tier)) continue;
  assert.ok(runs > 0, `tier ${tier}: at least one expressway run survives in the seed corpus`);
  assert.ok(crossings > 0, `tier ${tier}: elevated river crossing retained somewhere in the seed corpus`);
}
// 双保险：语料级不变量（上）依赖真实 seed 的地理运气；再用显式的平岛/窄河检验
// 真实骨架函数——地面不可建的河岸退让必须不截断架空环线（合成地理，确定性）。
{
  const R = 600, coastDistance = (x, z) => R - Math.hypot(x, z);
  const inRiver = (x, z) => coastDistance(x, z) > 0 && Math.abs(x) < 18;
  const height = (x, z) => coastDistance(x, z) > 0 && !inRiver(x, z) ? 1.2 : -3;
  const buildable = (x, z) => coastDistance(x, z) > 12 && Math.abs(x) > 30;
  const geo = { R, hasRiver: true, maxWaterSpan: 140, coastDistance, landClearance: (x, z) => Math.min(coastDistance(x, z), Math.abs(x) - 18),
    coast: Array.from({ length: 96 }, (_, i) => ({ x: R * Math.cos(i / 96 * Math.PI * 2), z: R * Math.sin(i / 96 * Math.PI * 2) })),
    river: [], riverX: () => 0, riverWidth: () => 18, riverShift: 0,
    hillDir: { x: 0, z: 0 }, hillProj: () => 0, hillLine: 10000, height, buildable,
    terrain: { height, buildable, slope: () => 0 }, islets: [], waterEdges: [], isletClearance: () => -Infinity };
  const result = buildSkeleton({ geo, seed: 42, core: { x: -100, z: 0 }, publicSites: [], landmarks: [],
    shoreSiteKinds: new Set(), random: () => 0.5, network: emptyNetwork(), inRiver });
  assert(result.ringRuns.some(run => run.some(p => inRiver(p.x, p.z))), "explicit river fixture retains an elevated crossing");
  assert(result.ringRuns.some(run => run.some(p => !buildable(p.x, p.z))), "the witness really crosses ground setbacks");
}
console.log("City infrastructure: real bridge deck/rails/piers and expressway clearance/crossings across tiers passed.");
