#!/usr/bin/env node
// Production road-first addresses, not full model/vehicle-path certification.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { createCityPlan, MIAMI_COASTAL, diagnoseNetwork } = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan"], "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/intent.ts": ["diagnoseNetwork"],
});
const plan = createCityPlan(2003037141, 1, MIAMI_COASTAL);
assert.equal(plan.parcelSource, "accepted-road-faces");
assert.ok(plan.derivedFinalization.ok, plan.derivedFinalization.reason);
assert.ok(plan.capacity.satisfied);
assert.deepEqual(diagnoseNetwork(plan).unmet, []);
const roads = new Map(plan.roadEdges.map(edge => [edge.id, edge]));
const report = plan.roadBlockReport;
assert.equal(report.faces, report.supportedFaces + report.emptyFaces.length + report.unsupported.length);
assert.equal(report.published, plan.capacity.available);
for (const block of plan.blocks) {
  assert.ok(block.sourceFaceId && block.roadBoundary.length >= 3);
  assert.equal(block.networkVersion, plan.derivedNetworkVersion);
  assert.ok(block.surfaceExclusions, "the actual presentation consumes envelope exclusions");
  for (const parcel of block.parcels) {
    const proof = parcel.frontage;
    assert.ok(proof);
    assert.equal(proof.parcelId, parcel.id); assert.equal(proof.blockId, block.id);
    assert.equal(proof.sourceFaceId, block.sourceFaceId);
    assert.equal(proof.networkVersion, plan.derivedNetworkVersion);
    assert.equal(proof.scope, "parcel-frontage");
    assert.equal(proof.terrainCoverage, "one-unit-sampling");
    const host = roads.get(proof.hostEdgeId);
    assert.ok(host && !host.bridge && host.structure !== "deck");
    assert.ok(host.points[proof.hostSegmentIndex + 1]);
    const a = host.points[proof.hostSegmentIndex], b = host.points[proof.hostSegmentIndex + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const cross = (proof.roadPoint.x - a.x) * (b.z - a.z) - (proof.roadPoint.z - a.z) * (b.x - a.x);
    assert.ok(Math.abs(cross) / length < 1e-7, "proof attaches to the actual polyline, never an endpoint chord");
    assert.equal(proof.primaryNodePath.at(-1), plan.primaryAnchorNodeId);
    assert.equal(proof.primaryEdgePath.length + 1, proof.primaryNodePath.length);
    for (let index = 0; index < proof.primaryEdgePath.length; index++) {
      const edge = roads.get(proof.primaryEdgePath[index]), from = proof.primaryNodePath[index], to = proof.primaryNodePath[index + 1];
      assert.ok(edge && ((edge.from === from && edge.to === to) || (edge.to === from && edge.from === to)));
    }
  }
}
console.log(`City road-derived production: real accepted faces, explicit empty coverage, versioned parcel frontage and actual primary paths passed (${plan.capacity.available}/${plan.capacity.required}); model physics and visual QA remain separate.`);
