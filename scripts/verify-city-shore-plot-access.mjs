#!/usr/bin/env node
// Declared plot proxy and transaction guards, not a model-door certification.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
// Connector-first bundling previously exposed a top-level cycle through
// cityPlan -> shorePlotAccess -> connect before CONNECTOR_CONFIG initialized.
const cold = await loadCity({
  "engine/planner/connect.ts": ["CONNECTOR_CONFIG"],
  "engine/planner/shorePlotAccess.ts": ["SHORE_PLOT_ACCESS_CONFIG"],
  "engine/planner/connectionBudget.ts": ["CONNECTION_BUDGET"],
});
assert.equal(cold.CONNECTION_BUDGET.bridgeCandidates, 40);
assert.equal(cold.CONNECTOR_CONFIG.bridgeCandidates, cold.CONNECTION_BUDGET.bridgeCandidates);
assert.equal(cold.SHORE_PLOT_ACCESS_CONFIG.maxHostCandidates, cold.CONNECTION_BUDGET.bridgeCandidates);
const { emptyNetwork, addNetworkEdge, proposeShorePlotAccess, specByKind, createCityPlan, MIAMI_COASTAL,
  diagnoseNetwork, CONSTRAINTS } = await loadCity({
  "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge"],
  "engine/planner/shorePlotAccess.ts": ["proposeShorePlotAccess"],
  "engine/planner/sitespec.ts": ["specByKind"],
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/intent.ts": ["diagnoseNetwork"],
  "engine/planner/constraints.ts": ["CONSTRAINTS"],
});
const snapshot = (world, owner) => JSON.stringify({ owner, network: { ...world.network,
  nodes: [...world.network.nodes], edges: [...world.network.edges] } });
for (const turns of [0, 1, 2, 3]) {
  const transform = (x, z) => { for (let i = 0; i < turns; i++) [x, z] = [-z, x]; return { x: x || 0, z: z || 0 }; };
  const network = emptyNetwork(), a = transform(100, -100), b = transform(100, 100);
  addNetworkEdge(network, a, b, true, false, true);
  network.version = 17;
  const owner = { id: "fixed-plot", kind: "renamed-shore-model", x: 0, z: 0, radius: 37, yaw: turns };
  const world = { network, geo: { height: () => 1.2, buildable: () => true, terrain: { slope: () => 0 } },
    inRiver: () => false, reservations: () => [owner] };
  const spec = { ...specByKind("harbor"), kind: owner.kind }, anchor = `${a.x}:${a.z}`;
  const before = snapshot(world, owner), result = proposeShorePlotAccess(world, owner, spec, anchor);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.attempted, 1); assert.equal(result.candidateLimit, 40);
  assert.equal(result.entranceEvidence, "plot-proxy");
  assert.deepEqual(result.gate, transform(43, 0));
  assert.deepEqual(result.bridgeSpans, []);
  assert.ok(result.network.version > 17, "draft starts from the actual network version");
  assert.equal(snapshot(world, owner), before, "successful proposal cannot publish or move its owner");
  for (const denial of ["missing", "wrong-schema", "ground-frontage", "offshore", "bound", "shore-bound", "global-reject"]) {
    const s = { ...spec }, o = { ...owner };
    if (denial === "missing") delete s.plotBoundaryAccess;
    if (denial === "wrong-schema") s.plotBoundaryAccess = { ...s.plotBoundaryAccess, schemaVersion: 99 };
    if (denial === "ground-frontage") s.planarAccess = specByKind("station").planarAccess;
    if (denial === "offshore") s.placement = "offshore-island";
    if (denial === "bound") o.access = { nodeId: anchor };
    if (denial === "shore-bound") o.shore = transform(1, 0);
    const denied = proposeShorePlotAccess(world, o, s, anchor,
      denial === "global-reject" ? () => "reserved parcel conflict" : undefined);
    assert.equal(denied.ok, false, denial);
    assert.equal(snapshot(world, owner), before, `${denial}: rejected drafts leave the authoritative graph unchanged`);
  }
}
{
  const network = emptyNetwork(), owner = { id: "bounded", kind: "new-shore-kind", x: 0, z: 0, radius: 37, yaw: 0 };
  for (let i = 0; i < 50; i++) {
    const x = 100 + i * 10;
    addNetworkEdge(network, { x, z: -100 }, { x, z: 100 }, true);
    if (i) addNetworkEdge(network, { x: x - 10, z: -100 }, { x, z: -100 }, true);
  }
  const world = { network, geo: { height: () => 1.2, buildable: () => true, terrain: { slope: () => 0 } },
    inRiver: () => false, reservations: () => [owner] };
  const before = snapshot(world, owner);
  const denied = proposeShorePlotAccess(world, owner, { ...specByKind("harbor"), kind: owner.kind }, "100:-100", () => "deny all proposals");
  assert.equal(denied.ok, false); assert.equal(denied.attempted, 40);
  assert.equal(snapshot(world, owner), before, "40-host exhaustion cannot publish any partial graph");
}
if (process.argv.includes("--named") || process.env.CITY_SHORE_NAMED === "1") {
  const plan = createCityPlan(2005445908, 1, MIAMI_COASTAL);
  const owner = plan.publicSites.find((site) => site.id === "working-harbor");
  assert.ok(owner);
  // 2026-10-15 开湾地理（生成器版本 2）后重钉：岛形定向、海湾与湾口排除改变了港口落点，下面的语义断言
  //（需求全满足、约束零违例、容量一致、港口有 plot-gate）照旧成立。曾为 -105.06/-660.44、yaw 2.081、R 551.54。
  assert.equal(owner.x, -208.4862353967711); assert.equal(owner.z, 663.4343380729366);
  assert.equal(owner.yaw, -2.7529294616059796); assert.equal(plan.islandRadius, 780.0000000000001);
  assert.equal(owner.access?.role, "plot-gate");
  assert.deepEqual(diagnoseNetwork(plan).unmet, []);
  assert.deepEqual(Object.fromEntries(CONSTRAINTS.map((c) => [c.id, c.measure(plan)]).filter(([, v]) => v.length)), {});
  assert.equal(plan.capacity.available, plan.blocks.reduce((sum, block) => sum + block.parcels.length, 0));
  assert.ok(plan.capacity.satisfied);
  console.log(`Named shore plot: required service restored without moving owner, capacity ${plan.capacity.available}/${plan.capacity.required}.`);
}
console.log("City shore plot access: transformed proxy proposals, fail-closed capability, rollback and shared 40-host bound passed.");
