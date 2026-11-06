#!/usr/bin/env node
// Endpoint routing regression, not the complete frozen City acceptance gate.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { emptyNetwork, addNetworkEdge, runConnection, corridorViolation, CONNECTOR_CONFIG,
  createCityPlan, MIAMI_COASTAL, diagnoseNetwork, CONSTRAINTS } = await loadCity({
  "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge"],
  "engine/planner/connect.ts": ["runConnection", "CONNECTOR_CONFIG"],
  "engine/planner/validation.ts": ["corridorViolation"],
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/intent.ts": ["diagnoseNetwork"],
  "engine/planner/constraints.ts": ["CONSTRAINTS"],
});

const snapshot = (network) => JSON.stringify({ version: network.version,
  nodes: [...network.nodes], edges: [...network.edges] });
// Coarse centre-only clearance admits a tempting path through the extra
// half-road-width ring. The same deterministic search must find a capsule-safe
// route without relaxing its angle, length or expansion budget.
for (const quarterTurns of [0, 1, 2, 3]) for (const shift of [0, 120]) {
  const transform = (x, z) => {
    for (let i = 0; i < quarterTurns; i++) [x, z] = [-z, x];
    return { x: x + shift, z: z - shift };
  };
  const network = emptyNetwork(), source = transform(10, -5);
  addNetworkEdge(network, transform(-16, 20), source, true, false, true);
  addNetworkEdge(network, transform(-90, -70), transform(-90, -35), true);
  const original = new Map([...network.edges].map(([id, edge]) => [id, JSON.stringify(edge)]));
  const sites = [{ ...transform(-33, -15), radius: 26 }, { ...transform(41, 62), radius: 46 }];
  const world = { network, geo: { height: () => 1.2, buildable: () => true,
    terrain: { slope: () => 0 } }, inRiver: () => false, reservations: () => sites };
  const target = transform(-90, -70);
  const request = { id: `capsule-endpoint:${quarterTurns}:${shift}`, source,
    target: { kind: "node", id: `${target.x}:${target.z}` }, purpose: "district-access",
    allowBridge: false, maxLength: 320, roadClass: "arterial", primary: true };
  const beforeBudget = snapshot(network);
  const exhausted = runConnection({ ...request, searchBudget: 1 }, world, { strategies: ["grid-astar"] });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.reason, "search-budget");
  assert.equal(snapshot(network), beforeBudget, "exhaustion cannot publish a partial endpoint route");
  const denied = runConnection(request, { ...world,
    reservations: () => [...sites, { ...source, radius: 350 }] }, { strategies: ["grid-astar"] });
  assert.equal(denied.ok, false, "a source inside a fixed reservation must not gain an unsafe escape");
  assert.equal(snapshot(network), beforeBudget, "physical rejection preserves the complete original graph");
  const result = runConnection(request, world, { strategies: ["grid-astar"] });
  assert.equal(result.ok, true, result.detail);
  assert.ok(result.cost <= request.maxLength);
  for (const [id, serialized] of original) {
    assert.equal(JSON.stringify(network.edges.get(id)), serialized, "necessary original roads stay unchanged");
  }
  const sourceId = `${source.x}:${source.z}`;
  assert.equal([...network.edges.values()].filter((edge) => edge.from === sourceId || edge.to === sourceId).length, 2);
  for (const edge of network.edges.values()) if (!original.has(edge.id)) {
    assert.equal(edge.width, 12, "routing cannot narrow the necessary arterial");
    for (let i = 1; i < edge.points.length; i++) {
      assert.equal(corridorViolation(world, edge.points[i - 1], edge.points[i], result.policy), null);
    }
  }
}
assert.equal(CONNECTOR_CONFIG.gridStep, 12);
assert.equal(CONNECTOR_CONFIG.aStarBudget, 12000);
assert.equal(CONNECTOR_CONFIG.endpointClearAngleDeg, 35);

if (process.argv.includes("--named")) for (const [seed, tier] of [[2005655366, 1], [1703326634, 5]]) {
  const plan = createCityPlan(seed, tier, MIAMI_COASTAL);
  assert.equal(diagnoseNetwork(plan).demands.filter((entry) => entry.demand.required && !entry.satisfied).length, 0);
  const violations = Object.fromEntries(CONSTRAINTS.map((constraint) => [constraint.id, constraint.measure(plan)])
    .filter(([, findings]) => findings.length));
  assert.deepEqual(violations, {}, "named endpoint regression: every registered constraint must pass");
  for (const ownerId of ["central-station", "east-stadium"]) {
    assert.ok(plan.publicSites.some((site) => site.id === ownerId), `required owner ${ownerId} cannot disappear`);
  }
  assert.ok(plan.capacity.available >= plan.capacity.required);
  console.log(`Named endpoint regression passed: ${seed}/t${tier} radius=${plan.islandRadius}`);
}
console.log("City endpoint routing: 8 transformed capsule-safe cases and budget/physical rollback passed.");
