#!/usr/bin/env node
// planner/solve.ts 自检（CITY_ARCHITECTURE §2 迁移步 5b）：
//   (a) 策略表里每个 constraint id 都存在于 CONSTRAINTS；
//   (b) 修复不让它所针对的约束变差：6 个岛上「solve 前（skipSolve 草案）→ solve 后」的违规数，after <= before；
//   (c) 确定性：同一输入两次运行结果完全一致（含 skipSolve 草案）。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { createCityPlan, MIAMI_COASTAL, CONSTRAINTS, REPAIR_STRATEGIES, solvePlan, runRepairTransaction } = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/constraints.ts": ["CONSTRAINTS"],
  "engine/planner/solve.ts": ["REPAIR_STRATEGIES", "solvePlan", "runRepairTransaction"],
});

const ids = new Set(CONSTRAINTS.map((c) => c.id));
assert(REPAIR_STRATEGIES.length > 0 && typeof solvePlan === "function", "strategy table + solvePlan must exist");
for (const s of REPAIR_STRATEGIES) {
  assert(ids.has(s.constraint), `strategy ${s.name} targets unknown constraint ${s.constraint}`);
  assert.equal(typeof s.run, "function", `${s.name} needs run()`);
}
const targeted = [...new Set(REPAIR_STRATEGIES.map((s) => s.constraint))];

// The old fixture omitted real geometry. Invalid observations must reject
// before any candidate/strategy callback, not throw or synthesize a face.
{
  const malformed = { network: { nodes: new Map(), edges: new Map() }, publicSites: [], landmarks: [],
    blocks: [{ id: "block", parcels: [{ id: "parcel", x: 0, z: 0 }] }], core: { x: 0, z: 0 },
    geo: { terrain: { height: () => -1 }, river: null }, seaside: null, coast: [], coastRoadRuns: [], riverRoadRuns: [],
    carPaths: [], bridges: [], connectionLog: [] };
  const before = JSON.stringify(malformed); let called = false;
  const result = runRepairTransaction(malformed, { constraint: "siteInWater", name: "invalid-source", candidates() {
    called = true; throw new Error("must not enumerate invalid source");
  }, run() { called = true; return 1; } });
  assert.equal(result.changes, 0); assert.match(result.reason, /planning-world-initialization-refused/);
  assert.equal(called, false); assert.equal(JSON.stringify(malformed), before);
  assert.equal(malformed.planningWorld, undefined);
}

// 拒绝和异常都不能泄漏草稿修改，包括数组/嵌套地块与日志；容量不许靠删地块过关。
{
  const a = { id: "100:20", x: 100, z: 20 }, b = { id: "120:20", x: 120, z: 20 };
  const road = { id: "100:20/120:20", from: a.id, to: b.id, width: 5, kind: "local", structure: "ground-road", points: [a, b] };
  const ctx = { network: { nodes: new Map([[a.id, a], [b.id, b]]), edges: new Map([[road.id, road]]), version: 0 }, primaryAnchorNodeId: a.id, publicSites: [], landmarks: [],
    blocks: [{ id: "block", x: 0, z: 0, polygon: [{ x: -4, z: -4 }, { x: 4, z: -4 }, { x: 4, z: 4 }, { x: -4, z: 4 }],
      parcels: [{ id: "parcel", x: 0, z: 0, yaw: 0, width: 2, depth: 2 }] }], core: { x: 0, z: 0 },
    geo: { terrain: { height: () => -1 }, river: null }, seaside: null, coast: [], coastRoadRuns: [], riverRoadRuns: [],
    carPaths: [], bridges: [], connectionLog: [] };
  const snapshot = () => JSON.stringify([ctx.publicSites, ctx.blocks, ctx.connectionLog, [...ctx.network.nodes], [...ctx.network.edges]]);
  const before = snapshot();
  const rejected = runRepairTransaction(ctx, { constraint: "siteInWater", name: "unsafe", run(draft) {
    draft.publicSites.push({ id: "unsafe", kind: "park", x: 0, z: 0, radius: 10, yaw: 0 });
    draft.blocks[0].parcels[0].x = 999; draft.connectionLog.push({ id: "draft", ok: true, purpose: "site-access" }); return 1;
  } });
  assert.ok(rejected.reason && !rejected.changes);
  assert.equal(snapshot(), before);
  const discarded = runRepairTransaction(ctx, { constraint: "parcelInsideSite", name: "discard", run(draft) { draft.blocks[0].parcels = []; return 1; } });
  assert.match(discarded.reason, /capacity/);
  assert.equal(snapshot(), before);
  assert.throws(() => runRepairTransaction(ctx, { constraint: "siteInWater", name: "throw", run(draft) { draft.blocks[0].parcels = []; throw new Error("interrupted"); } }), /interrupted/);
  assert.equal(snapshot(), before);
  const blocksRef = ctx.blocks; const nodesRef = ctx.network.nodes;
  const noProgress = runRepairTransaction(ctx, { constraint: "siteInWater", name: "no-progress", run(draft) { draft.blocks[0].parcels[0].x = 1; return 1; } });
  assert.match(noProgress.reason, /no verified/);
  assert.equal(snapshot(), before);
  ctx.geo.terrain.height = (x) => x > 50 ? 1.2 : -1;
  ctx.publicSites.push({ id: "wet", kind: "park", x: 0, z: 0, radius: 10, yaw: 0 });
  const accepted = runRepairTransaction(ctx, { constraint: "siteInWater", name: "safe-data", run(draft) { draft.publicSites[0].x = 100; return 1; } });
  assert.equal(accepted.changes, 1);
  assert.equal(ctx.publicSites[0].x, 100);
  assert.equal(ctx.blocks, blocksRef);
  assert.equal(ctx.network.nodes, nodesRef);
  assert.equal(ctx.network.version, 0, "site-only publication must not fabricate a network revision");
  assert.equal(ctx.planningWorld.versions.site, 1);
}

const count = (plan, id) => CONSTRAINTS.find((c) => c.id === id).measure(plan).length;
const islands = [[1, 0, null], [2, 3, MIAMI_COASTAL], [5, 7, MIAMI_COASTAL], [1, 11, null], [2, 13, MIAMI_COASTAL], [5, 17, null]];
const rows = [];
for (const [tier, i, cfg] of islands) {
  const seed = 1703294958 + i * 7919;
  const before = createCityPlan(seed, tier, cfg, { skipSolve: true });
  const after = createCityPlan(seed, tier, cfg);
  for (const id of targeted) {
    const b = count(before, id); const a = count(after, id);
    // 事务接受后不再允许断头净增 1 的过渡松弛。
    assert(a <= b, `island seed=${seed} tier=${tier}: ${id} got worse after solve (${b} -> ${a})`);
    rows.push(`${id} ${b}->${a}`);
  }
  assert.equal(JSON.stringify(createCityPlan(seed, tier, cfg)), JSON.stringify(after), `solve not deterministic for seed=${seed} tier=${tier}`);
  assert.equal(JSON.stringify(createCityPlan(seed, tier, cfg, { skipSolve: true })), JSON.stringify(before), `skipSolve draft not deterministic for seed=${seed} tier=${tier}`);
}
console.log(`City solve: ${REPAIR_STRATEGIES.length} strategies over ${targeted.length} constraints (${targeted.join(", ")}); ${islands.length} islands never worse after solve; deterministic.`);
console.log(`  ${rows.join(" | ")}`);

// Long-road subdivision must not reveal a crowded corridor after publication.
const crowdedWitness = createCityPlan(2001361477, 3, MIAMI_COASTAL);
assert.equal(count(crowdedWitness, "crowdedArterials"), 0, "late trunk splits must not strand a protected crowded arterial");
