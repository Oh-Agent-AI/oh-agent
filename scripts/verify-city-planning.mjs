#!/usr/bin/env node
// 道路与用地规划守卫（docs/CITY_ROAD_PLANNING_AUDIT.md R1/R2）。
// 真机反馈「道路混乱、地标胡乱摆放、门前没有路」：重写前 30 个岛（10 种子 × 1/2/5 档）实测
// 锐角路口 45、被道路穿过的用地 196、门前无路 10；R1/R2 后 5 / 3 / 3。阈值给少量余量，
// 防止退回旧的「最近节点直连」与「主干道穿过用地」。
import assert from "node:assert/strict";
import { cachedPlan, loadCity } from "./city-kit/index.mjs";

// 原生加载 + 进程内缓存（CITY_ARCHITECTURE 迁移步 1）。
const { createCityPlan: rawPlan, MIAMI_COASTAL, CONSTRAINTS, diagnoseNetwork, siteFootprintSeparation } = await loadCity({
  "engine/planFootprint.ts": ["siteFootprintSeparation"],
  "engine/planner/constraints.ts": ["CONSTRAINTS"],
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/intent.ts": ["diagnoseNetwork"],
});
const createCityPlan = (seed, tier, config) => {
  const trace = process.env.CITY_VERIFY_PROGRESS === "1", began = performance.now();
  if (trace) console.error(`City planning: start ${seed}/t${tier}`);
  const plan = cachedPlan(rawPlan, seed, tier, config);
  if (trace) console.error(`City planning: done ${seed}/t${tier} ${Math.round(performance.now() - began)}ms R=${plan.islandRadius} attempts=${plan.radiusAttempts} edges=${plan.roadEdges.length} parcels=${plan.capacity.available}/${plan.capacity.required}`);
  return plan;
};

// 度量来自共享模块 engine/planner/constraints.ts（规划器与守卫同一份 measure）；上限留在下面的断言里。
const byId = Object.fromEntries(CONSTRAINTS.map((c) => [c.id, c]));
const totals = { acute: 0, inside: 0, far: 0, crowded: 0, islands: 0, loose: 0 };
const requiredFailures = [];
const crowdedFindings = [];
// Previously residual terminal corridors must connect by accepted realignment,
// not deletion of primary roads or increased snap/angle tolerances.
for (const seed of [1703342472, 1703350391]) {
  const plan = createCityPlan(seed, 1, MIAMI_COASTAL);
  assert.equal(byId.looseInlandRoadEnds.measure(plan).length, 0, `residual endpoint seed ${seed}`);
}
// The two true-crossing tuning fixtures now have real graph junctions. Keep
// these targeted assertions separate from the broader report-only baselines.
for (const seed of [2000000000, 2000733103]) {
  const plan = createCityPlan(seed, 1, MIAMI_COASTAL);
  assert.equal(byId.unjoinedGroundJunctions.measure(plan).length, 0, `residual crossing seed ${seed}`);
}
for (const tier of [1, 2, 5]) for (let i = 0; i < 10; i += 1) {
  const seed = 1703294958 + i * 7919;
  const plan = createCityPlan(seed, tier, MIAMI_COASTAL);
  const capacity = plan.blocks.reduce((sum, block) => sum + block.parcels.length, 0);
  assert.equal(plan.capacity.available, capacity, "capacity must describe the final filtered parcels");
  assert.equal(plan.capacity.satisfied, capacity >= plan.capacity.required);
  assert.equal(plan.radiusHistory.length, plan.radiusAttempts + 1, "every radius attempt must retain actual capacity evidence");
  assert.equal(plan.radiusHistory.at(-1).available, capacity);
  assert.equal(plan.radiusHistory.at(-1).radius, plan.islandRadius);
  assert.ok(plan.parcelGeneration.generated >= capacity, "raw/final capacity must not invert");
  const contacts = byId.unjoinedGroundJunctions.measure(plan);
  const ground = plan.planningOutcome.groundCoverage;
  assert.equal(ground.total, plan.publicSites.length + plan.landmarks.length, "ground coverage retains all model instances");
  assert.equal(ground.partial + ground.violations + ground.unsupported, ground.total);
  assert.deepEqual(plan.planningOutcome.groundFailures, [], `seed ${seed} tier ${tier}: registered model foundation must be admitted`);
  const intent = diagnoseNetwork(plan);
  assert.ok(Array.isArray(plan.demandCatalogue), "production must publish its retained demand catalogue");
  assert.equal(new Set(plan.demandCatalogue.map((demand) => demand.id)).size, plan.demandCatalogue.length, "retained demand IDs are unique");
  for (const ownerId of ["civic-square", "observation-tower", "riverside-park", "working-harbor", "central-station", "east-stadium"]) {
    assert.ok(plan.demandCatalogue.some((demand) => demand.id === `site:${ownerId}` && demand.required), "municipal commitments cannot disappear");
  }
  for (const demand of plan.demandCatalogue) assert.ok(intent?.demands.some((entry) => entry.demand.id === demand.id), "final diagnostics must retain the published catalogue denominator");
  if (contacts.length || !intent || intent.unmet.length || !plan.capacity.satisfied) requiredFailures.push({ seed, tier,
    radius: plan.islandRadius, contacts, unmet: intent?.unmet ?? "primary-missing", capacity: plan.capacity });
  assert.ok(Number.isInteger(plan.derivedNetworkVersion), "derived products must identify their accepted network version");
  totals.islands += 1;
  // 内陆断头（F1 修复 B/C 之后）：度为 1、离岸 ≥ 2.5、离任何用地边缘 > 12 的路端。
  totals.loose += byId.looseInlandRoadEnds.measure(plan).length;
  // 锐角路口：三路及以上的路口，相邻两条路夹角 < 30°。
  totals.acute += byId.acuteJunctions.measure(plan).length;
  // 用地：路不能穿过（中心到路 < 0.7 半径；核心广场、凯旋门除外），门前要有路（边缘到路 ≤ 20，含堤道桥）。
  totals.inside += byId.roadThroughSite.measure(plan).length;
  totals.far += byId.siteWithoutDoorRoad.measure(plan).length;
  for (const site of plan.landmarks.filter((landmark) => landmark.kind === "sail-opera" && landmark.shore)) {
    const id = (p) => `${Math.round(p.x * 100) / 100}:${Math.round(p.z * 100) / 100}`;
    const shoreId = id(site.shore);
    const atShore = (edge) => edge.from === shoreId || edge.to === shoreId;
    const hasCauseway = plan.roadEdges.some((edge) => edge.bridge && atShore(edge));
    const hasGroundApproach = plan.roadEdges.some((edge) => !edge.bridge && atShore(edge));
    const recordedFailure = plan.connections.some((attempt) => attempt.id === `causeway:${site.id}` && !attempt.ok);
    assert((hasCauseway && hasGroundApproach) || (!hasCauseway && recordedFailure),
      `seed ${seed} tier ${tier}: opera shore must have an atomic causeway plus ground approach or an explicit failed obligation`);
  }
  // 主干道不扎堆。
  const crowded = byId.crowdedArterials.measure(plan);
  totals.crowded += crowded.length;
  if (crowded.length) crowdedFindings.push({ seed, tier, findings: crowded });
}

// These are hard production contracts, not tolerances inferred from this
// tuning batch. Collect all cases before failing so one defect does not hide
// the remaining required-access/contact failures.
for (const failure of requiredFailures) console.error("City planning required failure: " + JSON.stringify(failure));
console.error("City planning batch measurements (not acceptance): " + JSON.stringify({ totals, crowdedFindings }));
assert.equal(requiredFailures.length, 0, "required access/capacity and real ground contacts must be satisfied across the complete planning batch");

// Production acute-junction regression: prevention during generation is valid;
// if the raw plan still has the conflict, the solver must attribute its repair.
{
  const seed = 2000837832;
  const before = rawPlan(seed, 1, MIAMI_COASTAL, { skipSolve: true });
  const after = createCityPlan(seed, 1, MIAMI_COASTAL);
  const measure = (id, plan) => byId[id].measure(plan).length;
  const beforeCrossings = measure("unjoinedGroundJunctions", before);
  const afterCrossings = measure("unjoinedGroundJunctions", after);
  const beforeComponents = measure("disconnectedComponents", before);
  const afterComponents = measure("disconnectedComponents", after);
  assert.equal(measure("acuteJunctions", after), 0, "acute junction must be resolved");
  assert.ok(afterCrossings <= beforeCrossings, "acute repair must not add unjoined road relations");
  assert.ok(afterComponents <= beforeComponents, "acute repair must not disconnect the road graph");
  if (measure("acuteJunctions", before) > 0) assert.ok(after.solveReport?.some((entry) => entry.name === "resolveAcuteJunctions" && entry.changes > 0),
    "solve report must attribute the protected-leg bend to acute repair");
}

// Required station/stadium: the selected generation path must produce a legal
// connected placement without weakening terrain, footprint, highway,
// road-clearance, or access checks. Bounded route retries are exercised by the
// dedicated joint-frontage fixture when the initial candidate actually needs one.
{
  const plan = createCityPlan(2000628374, 1, MIAMI_COASTAL);
  const required = new Map(plan.publicSites.filter((site) => site.id === "central-station" || site.id === "east-stadium").map((site) => [site.id, site]));
  assert.equal(required.size, 2, "both required station and stadium must be placed after bounded fallback");
  for (const id of ["central-station", "east-stadium"]) assert.equal(required.get(id)?.access?.role, "plot-gate", `${id} must keep its accepted plot gate`);
  assert.ok(plan.siteObligations?.every((obligation) => obligation.placed), "required placement obligations must be satisfied");
  assert.ok(required.get("east-stadium")?.access?.capability === "ground-frontage", "stadium must retain a real ground-frontage gate");
  assert.equal(byId.siteWithoutDoorRoad.measure(plan).length, 0, "recovered required sites must be connected and must not leave a legacy door-road violation");
}

// Previously failed required-site seeds: optional-site relocation must commit with the gate,
// preserve physical separation, and leave no road-through-site violation.
for (const seed of [2005655366, 2005864824, 2005969553]) {
  const plan = createCityPlan(seed, 1, MIAMI_COASTAL);
  const sites = [...plan.publicSites, ...plan.landmarks];
  const required = sites.filter((site) => site.id === "central-station" || site.id === "east-stadium");
  assert.equal(required.length, 2, `seed ${seed}: required station and stadium must be jointly placed`);
  for (const owner of required) {
    assert.equal(owner.access?.role, "plot-gate", `seed ${seed}: ${owner.id} must retain its accepted gate`);
    assert.ok(sites.filter((site) => site !== owner && site.radius).every((site) =>
      siteFootprintSeparation(site, owner) >= 0), `seed ${seed}: ${owner.id} must not overlap another site's real projection`);
  }
  assert.equal(byId.roadThroughSite.measure(plan).length, 0, `seed ${seed}: relocation must not put a road through a site`);
  assert.ok(plan.siteObligations?.every((obligation) => obligation.placed), `seed ${seed}: all required placement obligations must be satisfied`);
  const intent = diagnoseNetwork(plan);
  assert.ok(intent, `seed ${seed}: required placement recovery must retain a primary network`);
  assert.deepEqual(intent.unmet, [], `seed ${seed}: restoring required sites must also satisfy retained connection obligations`);
}

// 2026-10-07 碎边合并后 2，收紧到 5；同日固定地标增至 5 座后路网变动到 6（两条短支路之间的夹角），放到 8（仍低于原 10、远低于起点 45）。
// 2026-10-08 solve 循环新增 resolveAcuteJunctions / resolveCrowdedArterials / joinNearMissEnds / pruneShortSpurs 后实测 0 / 3 / 2，阈值收紧到实测 + 少量余量。
assert(totals.acute <= 2, `acute junctions ${totals.acute} > 2 across ${totals.islands} islands (was 45 before R1, 8 before the solve repairs)`);
assert(totals.inside <= 8, `sites with a road through them ${totals.inside} > 8 (was 196 before R2)`);
// 2026-10-08 网络优先批次 1：断头豁免从 height≥2.5 地形代理改为语义判定（planner/endpoints.ts），检测口径 30 岛实测 65；
// 修复策略同步语义化后回落到 16；批次 3-2（repairs.ts 全部 height 门切语义 + 河岸段豁免合并）后 9；
// 批次 4-3（孤立分量 tolerance 不校验直连删除）后 10——被水/地形围死的分量保持隔离，断头如实计数。上限=实测值。
assert(totals.loose <= 10, `loose inland road ends ${totals.loose} > 10 over 30 islands`);
assert(totals.far <= 5, `sites without a road at the door ${totals.far} > 3`);
assert(totals.crowded <= 5, `crowded arterial pairs ${totals.crowded} > 5`);
console.log(`City planning: ${totals.islands} islands — acute junctions ${totals.acute}, roads through sites ${totals.inside}, sites without access ${totals.far}, crowded arterials ${totals.crowded}, loose inland ends ${totals.loose} passed.`);
