import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { resolveModelEnvelope, inspectEnvelopeRoad, inspectEnvelopePair, footprintUnionDistance, footprintPolylineDistance, THREE, buildVillaComplex, hashSeed, pointInRegion, relocatedSitePositionFailure, GROUND_MODEL_FACTORIES } = await loadCity({
  "engine/planner/modelEnvelope.ts": ["resolveModelEnvelope", "inspectEnvelopeRoad", "inspectEnvelopePair", "footprintUnionDistance", "footprintPolylineDistance"],
  "pkg:three": ["* as THREE"], "engine/cityLandmarkVilla.ts": ["buildVillaComplex"],
  "cityModel.ts": ["hashSeed"], "engine/models/physical.ts": ["pointInRegion"],
  "engine/planner/snapJunctions.ts": ["relocatedSitePositionFailure"], "engine/models/groundRegistry.ts": ["GROUND_MODEL_FACTORIES"],
});
const p = (x, z) => ({ x, z });
const rect = (x, z, width = 2, depth = 2) => ({ parts: [{ shape: "rect", center: p(x, z), width, depth }] });
const circle = (x, z, radius) => ({ parts: [{ shape: "circle", center: p(x, z), radius }] });
assert.equal(footprintUnionDistance(rect(0, 0), rect(5, 0)), 3);
assert.equal(footprintUnionDistance(rect(0, 0), rect(0, 0)), 0);
assert.equal(footprintUnionDistance(circle(0, 0, 1), rect(5, 0)), 3);
assert.equal(footprintPolylineDistance(rect(0, 0), [p(-100, 50), p(-50, 50), p(0, 0)]), 0);
assert.equal(footprintPolylineDistance(rect(0, 0), [p(-10, 5), p(10, 5)]), 4);
assert.equal(footprintPolylineDistance(rect(0, 0), [p(5, 0)]), 4);
for (const bad of [{ parts: [] }, { parts: [{ shape: "circle", center: p(0, 0), radius: -1 }] },
  { parts: [{ shape: "convex", vertices: [p(0, 0), p(2, 0), p(1, 1), p(2, 2), p(0, 2)] }] },
  { parts: [{ shape: "rect", center: p(NaN, 0), width: 2, depth: 2 }] },
  { parts: Array(100).fill(rect(0, 0).parts[0]) }]) assert(Number.isNaN(footprintUnionDistance(bad, rect(0, 0))));
assert(Number.isNaN(footprintPolylineDistance(rect(0, 0), [p(NaN, 0)])));
const owner = { id: "landmark:villa-complex", kind: "villa-complex", x: 0, z: 0, yaw: 0, radius: 34 };
const before = JSON.stringify(owner), envelope = resolveModelEnvelope(owner);
assert.equal(envelope.status, "partial"); assert.equal(envelope.wholeModelReady, false);
assert.equal(JSON.stringify(owner), before);
assert.equal(envelope.plotReservation.semantic, "nominal-plot-reservation");
assert.equal(envelope.relocationCorridorEnvelope.schemaVersion, 1);
assert.equal(envelope.relocationCorridorEnvelope.coverage, "complete-conservative-renderer-xy");
assert.equal(inspectEnvelopePair(owner, { ...owner, id: "other-villa" }).entity.relation, "conflict", "zero requested setback cannot exempt overlapping entities");
assert.equal(inspectEnvelopePair(owner, { ...owner, id: "far-villa", x: 200 }).entity.relation, "clear");
assert.equal(inspectEnvelopeRoad(owner, { width: 12, points: [p(-100, 0), p(100, 0)] }).entity.relation, "conflict");
assert.equal(inspectEnvelopeRoad(owner, { width: 12, points: [p(-100, 100), p(100, 100)] }).entity.relation, "clear");
assert.equal(inspectEnvelopeRoad(owner, { width: 12, points: [p(0, NaN), p(100, 0)] }).status, "unsupported");
const unknown = { ...owner, kind: "unregistered-model" };
assert.equal(inspectEnvelopePair(owner, unknown).status, "unsupported");
assert.equal(inspectEnvelopePair(owner, unknown).proxySemantic, "actual-projection-and-nominal-plot");
assert.equal(resolveModelEnvelope({ ...unknown, radius: 0 }).status, "unsupported");
const rotate = point => p(point.z, -point.x);
const road = { width: 8, points: [p(-100, 100), p(0, 0), p(100, 100)] };
const original = inspectEnvelopeRoad(owner, road);
const transformed = inspectEnvelopeRoad({ ...owner, yaw: Math.PI / 2 }, { ...road, points: road.points.map(rotate) });
assert.equal(transformed.entity.relation, original.entity.relation);
assert(Math.abs(transformed.entity.distance - original.entity.distance) < 1e-9);
// Each actual mesh must fit wholly inside one convex declared projection part,
// not merely have scattered vertices in different parts of the union.
let checkedMeshes = 0;
for (const id of ["landmark:villa-complex", "villa:a", "villa:b", "villa:c", "villa:d", "villa:e"]) for (const yaw of [0, 0.4, Math.PI / 2, -1.2]) for (const neon of [false, true]) {
  const placed = { ...owner, id, x: 120, z: -240, yaw }, resolved = resolveModelEnvelope(placed);
  assert.equal(resolved.status, "partial");
  const build = buildVillaComplex(hashSeed(id), neon);
  build.group.position.set(placed.x, 1.2, placed.z); build.group.rotation.y = yaw; build.group.updateMatrixWorld(true);
  build.group.traverse(object => {
    if (!object.isMesh) return;
    const positions = object.geometry.getAttribute("position"), points = [];
    for (let i = 0; i < positions.count; i++) {
      const vertex = object.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, i));
      points.push({ x: vertex.x, z: vertex.z });
    }
    assert(resolved.conservativeProjection.parts.some(region => points.every(point => pointInRegion(point, region, 1e-5))),
      `${id}/${yaw}/${neon}: every actual mesh must have a continuous convex XY enclosure`);
    checkedMeshes++;
  });
  for (const disposable of build.disposables) disposable.dispose();
}
assert(checkedMeshes > 1000, "actual renderer coverage cannot be vacuous");
const context = site => ({ geo: { height: () => 1.2, coastDistance: () => 0, hasRiver: false },
  inRiver: () => false, ringRuns: [], publicSites: [], landmarks: [site], SHORE_SITE_KINDS: new Set([site.kind]),
  network: { edges: new Map([["road", { width: 12, points: [p(-100, 25), p(100, 25)] }]]) } });
assert.equal(relocatedSitePositionFailure(context(owner), owner, p(0, 0), true), null);
const factory = GROUND_MODEL_FACTORIES[owner.kind];
GROUND_MODEL_FACTORIES["test-complete-xy-alias"] = factory;
GROUND_MODEL_FACTORIES["test-ground-only-alias"] = input => {
  const result = factory(input);
  if (result.status === "unsupported") return result;
  const { relocationCorridorEnvelope, ...groundOnly } = result; return groundOnly;
};
try {
  const alias = { ...owner, kind: "test-complete-xy-alias" };
  assert.equal(relocatedSitePositionFailure(context(alias), alias, p(0, 0), true), null, "declared capability, not model name, selects the corridor policy");
  for (const kind of ["test-ground-only-alias", "unregistered-model"]) {
    const legacy = { ...owner, kind };
    assert.equal(relocatedSitePositionFailure(context(legacy), legacy, p(0, 0), true), "owner-road-envelope", "missing XY coverage retains the circle protection");
  }
  const crossing = context(owner); crossing.network.edges.get("road").points = [p(-100, 0), p(100, 0)];
  assert.equal(relocatedSitePositionFailure(crossing, owner, p(0, 0), true), "owner-road-envelope");
} finally {
  delete GROUND_MODEL_FACTORIES["test-complete-xy-alias"]; delete GROUND_MODEL_FACTORIES["test-ground-only-alias"];
}
console.log("City model envelope: true unions/rotation/whole polylines, separate nominal plots, zero-setback overlap refusal, unknown coverage and bounded malformed geometry rejection passed. XY facts remain partial, not foundation/entrance admission.");
