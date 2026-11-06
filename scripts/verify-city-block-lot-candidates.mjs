#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { findBlockLotCandidate, inspectBlockPlacement } = await loadCity({
  "engine/planner/blockLotCandidates.ts": ["findBlockLotCandidate"],
  "engine/planner/blockPlacement.ts": ["inspectBlockPlacement"],
});
const p = (x, z) => ({ x, z });
const parcel = (id, x, z, yaw = 0) => ({ id, blockId: "face", x, z, yaw, zone: "residential", width: 2, depth: 2 });
const environment = () => ({ roads: [], sites: [], highways: [], buildable: () => true, terrainSampleBudget: 10000 });
const input = (block, overrides = {}) => ({ block, environment: environment(), minimumSize: { width: 2, depth: 2 }, candidateLimit: 30, ...overrides });
const square = () => ({ x: 0, z: 0, polygon: [p(-10, -10), p(10, -10), p(10, 10), p(-10, 10)], parcels: [parcel("address", 0, 0)] });
const freeze = (value) => { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
for (const turns of [0, 1, 2, 3]) {
  const transform = (point) => { let { x, z } = point; for (let i = 0; i < turns; i++) [x, z] = [-z, x]; return { x: x || 0, z: z || 0 }; };
  const raw = { x: 6, z: 6, polygon: [p(0, 0), p(12, 0), p(12, 4), p(4, 4), p(4, 12), p(0, 12)],
    parcels: [parcel("reserved-address", 2, 2), parcel("available-address", 2, 8)] };
  const block = freeze({ ...transform(raw), polygon: raw.polygon.map(transform),
    parcels: raw.parcels.map((entry) => ({ ...entry, ...transform(entry), yaw: -turns * Math.PI / 2 })) });
  const taken = transform(p(2, 2));
  const world = { ...environment(), reserved: (point) => Math.hypot(point.x - taken.x, point.z - taken.z) < 1.5 };
  const before = JSON.stringify(block), result = findBlockLotCandidate(input(block, { environment: world }));
  assert.equal(result.ok, true, result.reason);
  assert.equal(JSON.stringify(block), before, "real face and address parcels cannot be rewritten");
  assert.ok(result.coverage.attempted > 1, "the concave face's outside centre must be rejected, not convex-hulled");
  assert.equal(inspectBlockPlacement({ ...world, block, footprint: result.footprint }).ok, true);
  assert.equal(result.evidence.scope, "sampled-rectangle-and-declared-circle-proxies");
  assert.equal(result.evidence.terrainCoverage, "at-most-one-unit-grid");
  assert.ok(result.footprint.width >= 2 && result.footprint.depth >= 2);
  const reordered = findBlockLotCandidate(input({ ...block, parcels: [...block.parcels].reverse() }, { environment: world }));
  assert.deepEqual(reordered, result, "same real addresses and yaw give stable candidates independent of parcel array order");
}
{
  const block = square(); block.holes = [[p(-2, -2), p(2, -2), p(2, 2), p(-2, 2)]];
  block.parcels.push(parcel("side-address", -6, 0));
  const result = findBlockLotCandidate(input(block));
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.coverage.rejectionReasons["rectangle-crosses-hole"] > 0);
  assert.equal(inspectBlockPlacement({ ...environment(), block, footprint: result.footprint }).ok, true);
}
{
  const block = square();
  const world = { ...environment(), buildable: (x) => x > -8, terrainSampleBudget: 256 };
  const denied = findBlockLotCandidate(input(block, { environment: world }));
  assert.equal(denied.ok, false); assert.equal(denied.reason, "terrain-sample-budget-exhausted");
  assert.equal(denied.coverage.attempted, 2); assert.equal(denied.coverage.terrainSamples, 256);
  assert.equal(denied.coverage.rejectionReasons["rectangle-terrain-or-reserve-conflict"], 1);
  const accepted = findBlockLotCandidate(input(block, { environment: { ...world, terrainSampleBudget: 257 } }));
  assert.equal(accepted.ok, true, accepted.reason); assert.equal(accepted.coverage.terrainSamples, 257);
  assert.equal(accepted.footprint.width, 15);
  const budgetFirst = findBlockLotCandidate(input(block, { environment: { ...environment(), terrainSampleBudget: 10 } }));
  assert.equal(budgetFirst.ok, false); assert.equal(budgetFirst.reason, "terrain-sample-budget-exhausted");
  assert.equal(budgetFirst.coverage.attempted, 1, "cannot turn exhaustion into a smaller successful rectangle");
  let checks = 0;
  const cancelled = findBlockLotCandidate(input(block, { environment: { ...environment(), cancelled: () => ++checks > 80 } }));
  assert.equal(cancelled.ok, false); assert.equal(cancelled.reason, "cancelled");
  assert.equal(cancelled.coverage.attempted, 1);
}
{
  const block = square();
  const road = { id: "actual-crossing-road", from: "0:-20", to: "0:20", width: 5, kind: "local", points: [p(0, -20), p(0, 20)] };
  const result = findBlockLotCandidate(input(block, { environment: { ...environment(), roads: [road] } }));
  assert.equal(result.ok, false);
  assert.ok(result.coverage.rejectionReasons["actual-road-capsule-conflict"] > 0,
    "an actual internal road remains an obstacle, not a manufactured new face boundary");
}
{
  const block = square(); block.parcels = Array.from({ length: 20 }, (_, i) => parcel(`address-${i.toString().padStart(2, "0")}`, i / 10, 1));
  const blocked = { ...environment(), sites: [{ x: 0, z: 0, radius: 100 }] };
  const result = findBlockLotCandidate(input(block, { environment: blocked }));
  assert.equal(result.ok, false); assert.match(result.reason, /not-a-proof-of-infeasibility/);
  assert.equal(result.coverage.availableCentres, 21); assert.equal(result.coverage.selectedCentres, 5);
  assert.equal(result.coverage.unselectedCentres, 16); assert.ok(result.coverage.attempted <= 30);
  assert.equal(result.coverage.attempted, result.coverage.generatedCandidates);
  assert.equal(result.coverage.remainingCandidates, 0);
  for (const bad of [input(block, { candidateLimit: 31 }), input(block, { candidateLimit: 0 }),
    input(block, { minimumSize: { width: 0, depth: 2 } }), input(block, { environment: { ...environment(), terrainSampleBudget: -1 } })]) {
    assert.equal(findBlockLotCandidate(bad).ok, false);
  }
  assert.match(findBlockLotCandidate(input({ ...block, parcels: [] })).reason, /unsupported-missing-parcel-orientation/);
  assert.equal(findBlockLotCandidate(input(block, { minimumSize: { width: 30, depth: 30 } })).ok, false);
}
console.log("City block lot candidates: real concave/holed faces, declared address reservations, transforms, stable 30-candidate coverage and cumulative budget/cancellation passed.");
