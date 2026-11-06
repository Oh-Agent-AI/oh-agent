import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { createCityPlan, MIAMI_COASTAL, CONSTRAINTS, diagnoseNetwork, inspectModelGround, inspectEnvelopeRoad } = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan"], "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/constraints.ts": ["CONSTRAINTS"], "engine/planner/intent.ts": ["diagnoseNetwork"],
  "engine/planner/modelGround.ts": ["inspectModelGround"], "engine/planner/modelEnvelope.ts": ["inspectEnvelopeRoad"],
});
// 见证用「不开湾」的迈阿密配置（bayHalfWidth 0）：开湾（生成器版本 2）后庄园候选岸点排除了湾口，生产配置下
// 1703294958 起 80 个种子×档位都不再出现「地基落水 → 修复」，这条修复路径只在不开湾的岛形上还有真实见证。
const WITNESS = { ...MIAMI_COASTAL, bayHalfWidth: 0 };
// 环岛/匝道改变了按道路切块的容量校准，原见证在新半径下已是干地。固定旧地块模式以保留真实的湿地基见证；
// 下方物理、服务、容量与修复归因断言全部保留，不能把原 violation 改成 partial 来消除失败。
const plan = createCityPlan(1703310796, 2, WITNESS, { legacyGridParcels: true });
const before = createCityPlan(1703310796, 2, WITNESS, { skipSolve: true, legacyGridParcels: true });
const beforeOwner = before.landmarks.find(site => site.id === "landmark:villa-complex");
assert(beforeOwner, "the unrepaired witness must retain its owner");
assert.equal(inspectModelGround(beforeOwner, { height: before.terrain.height, inRiver: () => false }).status, "violation",
  "the fixture must still exercise a real foundation failure, not an already-valid placement");
const owner = plan.landmarks.find(site => site.id === "landmark:villa-complex");
assert(owner, "required regression model cannot disappear");
assert.equal(owner.radius, 34, "do not shrink the renderer or its plot");
assert.equal(inspectModelGround(owner, { height: plan.terrain.height, inRiver: () => false }).status, "partial");
assert.equal(plan.planningOutcome.status, "degraded");
assert.deepEqual(plan.planningOutcome.groundFailures, []);
assert.deepEqual(diagnoseNetwork(plan).unmet, []);
assert.equal(plan.capacity.satisfied, true);
assert.equal(plan.derivedFinalization.ok, true);
for (const constraint of CONSTRAINTS) assert.deepEqual(constraint.measure(plan), [], constraint.id);
for (const road of plan.roadEdges) {
  const result = inspectEnvelopeRoad(owner, road, { setback: 3 });
  assert.equal(result.status, "partial"); assert.equal(result.entity.relation, "clear", road.id);
}
for (const points of plan.highways) {
  const result = inspectEnvelopeRoad(owner, { width: 10.5, points }, { setback: 1 });
  assert.equal(result.status, "partial"); assert.equal(result.entity.relation, "clear");
}
assert(plan.solveReport.some(entry => ["siteInWater", "roadThroughSite"].includes(entry.constraint) && entry.changes > 0),
  "accepted physical repair must be attributed; a joint road-conflict repair may also restore dry support");
assert.notDeepEqual([owner.x, owner.z, owner.yaw], [beforeOwner.x, beforeOwner.z, beforeOwner.yaw],
  "the accepted owner pose must differ from the failed witness");
console.log("City villa placement: 1703310796/t2 keeps the owner/radius, admits actual ground and complete XY corridors, all registered constraints/required demands/capacity pass; full physics/global budgets remain pending.");
