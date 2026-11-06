#!/usr/bin/env node
// Named placement regression, separate from full independent/frozen acceptance.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { createCityPlan, MIAMI_COASTAL, diagnoseNetwork, CONSTRAINTS } = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/intent.ts": ["diagnoseNetwork"],
  "engine/planner/constraints.ts": ["CONSTRAINTS"],
});
for (const [seed, tier] of [...[2003037141, 2005655366, 4004503347, 4001047290, 4001256748, 4001989851, 4003037141, 4003456057].map(seed => [seed, 1]),
  [1703342472, 5], [4000104729, 3]]) {
const plan = createCityPlan(seed, tier, MIAMI_COASTAL);
assert.ok(plan.derivedFinalization.ok, plan.derivedFinalization.reason);
assert.equal(plan.planningOutcome.status, "degraded", "pending physics/budget cannot be certified as success");
assert.deepEqual(plan.planningOutcome.unmetDemandIds, []);
assert.ok(!plan.planningOutcome.reasons.some((reason) => reason.includes("stale")), "final products must match the published world");
for (const ownerId of ["central-station", "east-stadium"]) {
  const owners = plan.publicSites.filter((site) => site.id === ownerId);
  assert.equal(owners.length, 1, `required owner ${ownerId} must be placed exactly once`);
  assert.ok(owners[0].access && plan.roadNodes.some((node) => node.id === owners[0].access.nodeId));
  assert.equal(plan.siteObligations.filter((obligation) => obligation.ownerId === ownerId && obligation.placed).length, 1);
  assert.ok(plan.demandCatalogue.some((demand) => demand.id === `site:${ownerId}` && demand.required),
    "a late placement cannot drop the original stable demand");
}
assert.deepEqual(diagnoseNetwork(plan).unmet, [], "placement must restore real service, not only a model instance");
const violations = Object.fromEntries(CONSTRAINTS.map((constraint) => [constraint.id, constraint.measure(plan)])
  .filter(([, findings]) => findings.length));
assert.deepEqual(violations, {}, "every registered invariant stays in force");
assert.equal(plan.capacity.available, plan.blocks.reduce((sum, block) => sum + block.parcels.length, 0));
assert.ok(plan.capacity.satisfied && plan.capacity.available >= plan.capacity.required);
console.log(`City required placement: ${seed}/t${tier} passed, R=${plan.islandRadius}, capacity=${plan.capacity.available}/${plan.capacity.required}.`);
}
