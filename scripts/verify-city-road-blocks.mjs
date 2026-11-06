import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { extractRoadFaces, generateRoadBlocks, ROAD_BLOCK_POLICY } = await loadCity({
  "engine/planner/roadFaces.ts": ["extractRoadFaces"], "engine/planner/roadBlocks.ts": ["generateRoadBlocks", "ROAD_BLOCK_POLICY"],
});
const point = (x, z) => ({ x, z });
const ring = (prefix, points, width = 8) => points.map((a, i) => ({ id: `${prefix}${i}`, from: `${a.x}:${a.z}`, to: `${points[(i + 1) % points.length].x}:${points[(i + 1) % points.length].z}`,
  width, kind: "local", points: [a, points[(i + 1) % points.length]] }));
const square = (prefix, x = 0, z = 0, size = 80, width = 8) => ring(prefix, [point(x, z), point(x + size, z), point(x + size, z + size), point(x, z + size)], width);
const inputFor = roads => ({ faces: extractRoadFaces(roads), roads, primaryAnchorNodeId: roads[0].from, networkVersion: 7,
  districtFor: () => "d", zoneFor: () => "residential", buildable: () => true, sites: [], highways: [], maxCandidates: 10000 });
const run = input => { const before = JSON.stringify({ faces: input.faces, roads: input.roads, sites: input.sites, highways: input.highways }), result = generateRoadBlocks(input);
  assert.equal(JSON.stringify({ faces: input.faces, roads: input.roads, sites: input.sites, highways: input.highways }), before);
  assert.deepEqual(generateRoadBlocks({ ...input, roads: [...input.roads].reverse(), faces: { ...input.faces, faces: [...input.faces.faces].reverse() } }), result);
  assert.equal(result.report.evaluated, result.report.accepted + Object.values(result.report.rejected).reduce((sum, count) => sum + count, 0));
  return result; };
const base = inputFor(square("s")), accepted = run(base);
assert.equal(accepted.report.status, "complete"); assert.equal(accepted.blocks.length, 1); assert.equal(accepted.access.length, 18);
assert.deepEqual(accepted.blocks[0].polygon, [point(4.5, 4.5), point(75.5, 4.5), point(75.5, 75.5), point(4.5, 75.5)]);
for (const parcel of accepted.blocks[0].parcels) {
  assert.equal(parcel.width, 7.2); assert.equal(parcel.depth, 8);
  const proof = accepted.access.find(p => p.parcelId === parcel.id);
  assert.equal(proof.networkVersion, 7); assert.equal(proof.scope, "parcel-frontage"); assert.equal(proof.terrainCoverage, "one-unit-sampling");
  assert.equal(proof.primaryNodePath.at(-1), base.primaryAnchorNodeId);
  assert.equal(proof.primaryNodePath.length, proof.primaryEdgePath.length + 1);
  for (let i = 0; i < proof.primaryEdgePath.length; i++) {
    const edge = base.roads.find(e => e.id === proof.primaryEdgePath[i]);
    assert.ok([edge.from, edge.to].includes(proof.primaryNodePath[i]) && [edge.from, edge.to].includes(proof.primaryNodePath[i + 1]));
  }
}
// Actual width, not arbitrary grid edges, drives insets and candidate placement.
const wide = run(inputFor(square("wide", 0, 0, 80, 20)));
assert.ok(wide.blocks[0].polygon.every(p => p.x >= 10.5 && p.x <= 69.5 && p.z >= 10.5 && p.z <= 69.5));
assert.ok(wide.blocks[0].parcels.every(p => p.z >= 20 / 2 + Math.hypot(7.2, 8) / 2 + 0.5 - 1e-9));
assert.ok(wide.access.length < accepted.access.length);
const blockedTerrain = run({ ...base, buildable: () => false }); assert.equal(blockedTerrain.access.length, 0);
const interiorWet = run({ ...base, buildable: (x, z) => !(x > 9.5 && x < 11 && z > 10.5 && z < 12.5) });
assert.ok(interiorWet.report.rejected["rectangle-terrain-or-reserve"] > 0);
const shoulderWet = run({ ...base, buildable: (_x, z) => !(z > 5 && z < 7) });
assert.ok(shoulderWet.report.rejected["frontage-corridor-blocked"] > 0);
assert.ok(run({ ...base, reserved: () => true }).access.length === 0);
assert.ok(run({ ...base, sites: [{ x: 40, z: 12, radius: 15 }] }).access.length < accepted.access.length);
assert.ok(run({ ...base, highways: [[point(-10, 12), point(90, 12)]] }).access.length < accepted.access.length);
const disconnected = run(inputFor([...square("a"), ...square("b", 120)]));
assert.ok(disconnected.report.rejected["frontage-not-on-primary-network"] > 0); assert.equal(disconnected.access.length, 18);
const missing = run({ ...base, primaryAnchorNodeId: "missing" }); assert.equal(missing.report.status, "unsupported"); assert.equal(missing.blocks.length, 0);
const exhausted = run({ ...base, maxCandidates: 1 }); assert.equal(exhausted.report.status, "budget-exhausted"); assert.equal(exhausted.blocks.length, 0); assert.equal(exhausted.access.length, 0);
assert.equal(exhausted.report.candidateDenominator, 18); assert.equal(exhausted.report.evaluated, 1); assert.equal(exhausted.report.published, 0);
const cancelled = run({ ...base, cancelled: () => true }); assert.equal(cancelled.report.status, "cancelled"); assert.equal(cancelled.blocks.length, 0);
let cancellationChecks = 0;
const cancelledAfterDraft = generateRoadBlocks({ ...base, cancelled: () => ++cancellationChecks >= 4 });
assert.equal(cancelledAfterDraft.report.status, "cancelled"); assert.ok(cancelledAfterDraft.report.accepted > 0);
assert.equal(cancelledAfterDraft.report.published, 0); assert.equal(cancelledAfterDraft.blocks.length, 0); assert.equal(cancelledAfterDraft.access.length, 0);
const concave = inputFor(ring("c", [point(0, 0), point(80, 0), point(80, 80), point(40, 40), point(0, 80)]));
const supportedConcave = run(concave); assert.equal(supportedConcave.report.status, "complete"); assert.equal(supportedConcave.report.faces, 1); assert.equal(supportedConcave.report.supportedFaces, 1);
assert.ok(supportedConcave.access.length > 0);
assert.deepEqual(supportedConcave.blocks[0].polygon, concave.faces.faces[0].boundary, "never replace a concave face by a convex hull");
assert.equal(supportedConcave.blocks[0].surfaceCoverage, "requires-envelope-clipping");
assert.ok(supportedConcave.report.surfacePending.length > 0);
assert.ok(supportedConcave.blocks[0].surfaceExclusions.some(exclusion => exclusion.kind === "road-corridor" && exclusion.width === 9));
const notch = run(inputFor(ring("notch", [point(0, 0), point(90, 0), point(90, 80), point(43.1, 80), point(43.1, 14), point(42.8, 14), point(42.8, 80), point(0, 80)])));
assert.equal(notch.report.status, "complete"); assert.ok(notch.access.length > 0);
// The slot at 41.2,12 has all four corners inside but its upper edge crosses the narrow notch.
assert.ok(notch.blocks[0].parcels.every(parcel => Math.abs(parcel.x - 41.2) > 0.001));
assert.ok(notch.report.rejected["rectangle-outside-inset-face"] > 0);
const excludedSurface = run({ ...base, sites: [{ id: "park-owner", x: 40, z: 40, radius: 10 }], highways: [[point(-10, 40), point(90, 40)]] });
assert.ok(excludedSurface.blocks[0].surfaceExclusions.some(exclusion => exclusion.kind === "site-circle" && exclusion.id === "park-owner" && exclusion.radius === 10));
assert.ok(excludedSurface.blocks[0].surfaceExclusions.some(exclusion => exclusion.kind === "highway-corridor" && exclusion.width === 12.5));
const forged = run({ ...base, faces: { ...base.faces, faces: base.faces.faces.map(face => ({ ...face, boundary: [point(10, 10), point(70, 10), point(70, 70), point(10, 70)] })) } });
assert.equal(forged.report.status, "unsupported"); assert.equal(forged.blocks.length, 0);
const narrow = run(inputFor(square("n", 0, 0, 20))); assert.equal(narrow.access.length, 0);
const opposingRows = run(inputFor(square("overlap", 0, 0, 30)));
assert.ok(opposingRows.report.rejected["parcel-overlap"] > 0, "opposing frontage rows must still reject exact rectangle overlaps");
const consumed = run(inputFor(square("consumed", 0, 0, 8)));
assert.equal(consumed.report.status, "complete"); assert.equal(consumed.report.faces, 1);
assert.equal(consumed.report.emptyFaces.length, 1); assert.equal(consumed.report.supportedFaces, 0);
assert.equal(consumed.access.length, 0); assert.equal(consumed.report.emptyFaces[0].capacity, 0);
const certificate = consumed.report.emptyFaces[0].evidence;
assert.ok(certificate.weights.every(weight => weight >= 0));
const nx = certificate.planes.reduce((sum, plane, i) => sum + plane.nx * certificate.weights[i], 0);
const nz = certificate.planes.reduce((sum, plane, i) => sum + plane.nz * certificate.weights[i], 0);
const lower = certificate.planes.reduce((sum, plane, i) => sum + plane.minimum * certificate.weights[i], 0);
const upper = Math.max(...certificate.boundary.map(p => p.x * nx + p.z * nz));
assert.equal(lower, certificate.weightedMinimum); assert.equal(upper, certificate.boundedMaximum); assert.ok(lower > upper);
assert.equal(consumed.report.faces, consumed.report.supportedFaces + consumed.report.emptyFaces.length + consumed.report.unsupported.length);
const nestedInput = inputFor([...square("outer", 0, 0, 100), ...square("inner", 20, 20, 30)]);
const unsupportedPresentation = run(nestedInput);
assert.ok(unsupportedPresentation.report.unsupported.some(item => item.reason === "hole-presentation-unsupported"));
const nested = run({ ...nestedInput, presentationSupportsHoles: true });
const withHole = nested.blocks.find(block => block.holes.length);
assert.ok(withHole); assert.ok(withHole.holes[0].some(p => p.x === 15.5));
assert.ok(withHole.parcels.every(parcel => !(parcel.x > 15.5 && parcel.x < 54.5 && parcel.z > 15.5 && parcel.z < 54.5)));
const overlappingHole = run({ ...inputFor([...square("outer", 0, 0, 100), ...square("inner", 8, 8, 30)]), presentationSupportsHoles: true });
assert.ok(overlappingHole.report.unsupported.some(item => item.reason === "expanded-hole-overlaps-boundary-or-hole"));
// Split boundaries preserve row count/density and identify the actual split host for each address.
const splitRoads = square("split"); splitRoads.splice(0, 1, ...ring("bottom", [point(0, 0), point(40, 0), point(80, 0)]).slice(0, 2));
const split = run(inputFor(splitRoads)); assert.equal(split.report.candidateDenominator, 18); assert.equal(split.access.length, 18);
assert.ok(split.access.some(proof => proof.hostEdgeId === "bottom0") && split.access.some(proof => proof.hostEdgeId === "bottom1"));
assert.equal(ROAD_BLOCK_POLICY.width, 7.2); assert.equal(ROAD_BLOCK_POLICY.depth, 8); assert.equal(ROAD_BLOCK_POLICY.siteMargin, 9);
console.log("City road blocks: real road-width insets, fixed parcels, corners/interior terrain/holes, reservations/highways, true host/primary paths, split density, explicit unsupported and atomic budget/cancel passed.");
