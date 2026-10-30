#!/usr/bin/env node
// Real compiled elevated-road decks must support a parked car and seamless short
// movement on the top face, while deep overlap with the same solid remains blocked.
import assert from "node:assert/strict";
import { loadCity, cachedPlan } from "./city-kit/index.mjs";

const k = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/surface/compileSurface.ts": ["compileCitySurface"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "engine/surface/compileCitySolidInputs.ts": ["compileCitySolidInputs"],
  "engine/surface/structureCompiler.ts": ["expresswayPieces", "highwayRampPieces"],
  "game/driving/ContinuousDrivingEnvironment.ts": ["ContinuousDrivingEnvironment"],
  "game/driving/vehicleFootprint.ts": ["GAMEPLAY_DRIVING_FOOTPRINT"],
  "game/driving/surfaceFootprint.ts": ["GAMEPLAY_FOOTPRINT_PARAMS", "footprintSupport", "mountableQueryOf"],
  "game/driving/CollisionIndex.ts": ["boxPoly", "buildCollisionIndex"],
  "game/driving/DrivingKernel.ts": ["DrivingKernel"],
  "game/DrivingSimulation.ts": ["initialDrivingState", "DRIVING_PARAMS"],
});

const plan = cachedPlan(k.createCityPlan, 42, 2);
const compiled = k.compileCitySurface(plan);
const revision = "expressway-driving-regression";
const surface = { ...compiled.surface, revision };
const regions = k.buildSurfaceRegions(surface, k.buildSurfaceIndex(surface));
assert.equal(regions.status, "ready");
const collision = k.compileCitySolidInputs({ revision, worldRevision: revision, obstacles: compiled.obstacles,
  sceneSolids: [], renderedSolids: [] });
assert.equal(collision.status, "ready");
const solids = collision.collisionIndex.solids();
const decks = solids.filter((solid) => solid.role === "expressway-deck");
assert.ok(decks.length > 0, "seed 42/tier 2 has compiled elevated-road deck solids");
assert.ok(decks.every((solid) => Number.isFinite(solid.mountableHeight) && solid.mountableHeight > 0 && solid.mountableHeight <= 0.9),
  "every expressway deck slab has a bounded top-edge mounting budget");
const env = new k.ContinuousDrivingEnvironment(regions, {
  surfaceRevision: revision, worldRevision: revision, solidRevision: revision, solids,
  dimensions: { halfLength: 1.3, halfWidth: 0.6, halfHeight: 0.575 }, centerHeight: 0.55, isCurrent: () => true,
}, k.GAMEPLAY_DRIVING_FOOTPRINT, k.GAMEPLAY_FOOTPRINT_PARAMS, {}, { boundarySlide: true, mountablePolicy: "gameplay" });
const controlSolids = solids.map((solid) => solid.role === "expressway-deck" ? { ...solid, mountableHeight: undefined } : solid);
const controlEnv = new k.ContinuousDrivingEnvironment(regions, {
  surfaceRevision: revision, worldRevision: revision, solidRevision: revision, solids: controlSolids,
  dimensions: { halfLength: 1.3, halfWidth: 0.6, halfHeight: 0.575 }, centerHeight: 0.55, isCurrent: () => true,
}, k.GAMEPLAY_DRIVING_FOOTPRINT, k.GAMEPLAY_FOOTPRINT_PARAMS, {}, { boundarySlide: true, mountablePolicy: "gameplay" });
const kernel = new k.DrivingKernel(env, {
  baseSnapshotHash: revision, vehicleConfigHash: "expressway-climb", kernelBuildId: "expressway-climb",
  physicsVersion: 3, collisionVersion: 4, queryVersion: 5,
});
const forward = { forward: true, backward: false, left: false, right: false };
let checked = 0;
let placed = 0;
let blockedWithoutDeckPolicy = 0;
for (const piece of k.expresswayPieces(plan).filter((part) => part.role === "expressway-deck")) {
  const layerId = `expressway:${piece.highway}`;
  const at = regions.classify(piece.x, piece.z, layerId);
  if (at.status !== "drivable") continue;
  const fitted = k.footprintSupport(regions, { x: piece.x, z: piece.z, heading: -piece.ry, y: at.y }, at.regionId,
    k.GAMEPLAY_DRIVING_FOOTPRINT, k.GAMEPLAY_FOOTPRINT_PARAMS, undefined, k.mountableQueryOf(solids));
  if (!fitted.ok) continue;
  const placement = env.place(piece.x, piece.z, -piece.ry, at.regionId, fitted.y);
  if (placement) {
    const state = { ...k.initialDrivingState(piece.x, piece.z, -piece.ry, at.regionId), ...placement };
    const result = env.move(state, { x: piece.x + Math.cos(-piece.ry) * 0.25, z: piece.z + Math.sin(-piece.ry) * 0.25,
      heading: -piece.ry, travelBudget: 0.25 });
    assert.equal(result.queryStatus, "resolved", `segment ${piece.highway}/${piece.segment}: ${result.reason}`);
    assert.equal(result.blocked, false, `car should roll on expressway segment ${piece.highway}/${piece.segment}: ${result.reason}`);
    placed++;
  }
  if (!controlEnv.place(piece.x, piece.z, -piece.ry, at.regionId)) blockedWithoutDeckPolicy++;
  checked++;
}
assert.ok(checked > 0, "at least one real elevated-road segment is tested");
assert.ok(placed > 0, "a full car can be placed and moved on actual expressway geometry");
assert.ok(blockedWithoutDeckPolicy > 0, "regression control without expressway mountable semantics must reproduce blocked deck poses");

// Real ramp slabs are also collision solids. The route must climb from the low
// end under the same continuous kernel used by free drive; checking flat deck
// pieces alone missed a slab contact that reset the car's speed to zero.
{
  const ramps = k.highwayRampPieces(plan).filter((piece) => piece.role === "ramp-deck");
  assert.ok(ramps.length > 0, "seed 42 has compiled elevated-ramp deck slabs");
  const rampIds = new Set(ramps.map((piece) => piece.ramp));
  let climbed = null;
  for (const rampId of rampIds) {
    const pieces = ramps.filter((piece) => piece.ramp === rampId).sort((a, b) => a.segment - b.segment);
    const ramp = plan.highwayRamps[rampId];
    const points = ramp.points;
    const low = points[points.length - 2];
    const uphillPoint = points[points.length - 3];
    const heading = Math.atan2(uphillPoint.z - low.z, uphillPoint.x - low.x);
    const at = regions.classify(low.x, low.z, `expressway:${pieces[0].highway}`);
    if (at.status !== "drivable") continue;
    const fitted = k.footprintSupport(regions, { x: low.x, z: low.z, heading, y: at.y }, at.regionId,
      k.GAMEPLAY_DRIVING_FOOTPRINT, k.GAMEPLAY_FOOTPRINT_PARAMS, undefined, k.mountableQueryOf(solids));
    if (!fitted.ok) continue;
    const placement = env.place(low.x, low.z, heading, at.regionId, fitted.y);
    if (!placement) continue;
    let state = { ...k.initialDrivingState(low.x, low.z, heading, at.regionId), ...placement };
    let last = null;
    for (let tick = 0; tick < 600; tick++) {
      last = kernel.step(state, forward);
      state = last.state;
      if (last.motion.blocked) break;
    }
    climbed = { rampId, startY: placement.y, endY: state.y, blocked: last?.motion.reason ?? null };
    break;
  }
  assert.ok(climbed, "seed 42 has an uphill ramp spawn supported by the compiled driving surface");
  assert.equal(climbed.blocked, null, `the car must not collide with its ramp support slab: ${climbed.blocked}`);
  assert.ok(climbed.endY > climbed.startY + 4,
    `full throttle must climb from the ground end toward the elevated deck (${climbed.startY.toFixed(2)} → ${climbed.endY.toFixed(2)})`);
  console.log(`Ramp climb: ramp ${climbed.rampId} rose ${climbed.startY.toFixed(2)} → ${climbed.endY.toFixed(2)} without a support-slab collision.`);
}

// The same production slab still collides under strict policy. Gameplay may
// ignore a small penetration into the top face only; a deep overlap stays solid.
const deck = decks[0];
const deckPart = k.expresswayPieces(plan).find((part) => part.role === "expressway-deck" &&
  `expressway:${part.highway}:${String(part.segment).padStart(4, "0")}:slab` === deck.id);
assert.ok(deckPart);
const highVertex = deck.poly.vertices.reduce((best, vertex) => vertex.y > best.y ? vertex : best, deck.poly.vertices[0]);
const x = highVertex.x, z = highVertex.z, heading = -deckPart.ry;
const deckInput = collision.solids.find((solid) => solid.id === deck.id);
assert.ok(deckInput);
const isolatedIndex = k.buildCollisionIndex([deckInput]);
const topEdge = k.boxPoly({ x, y: deck.maxY + 0.475, z }, [{ x: 1.3, y: 0, z: 0 }, { x: 0, y: 0.575, z: 0 }, { x: 0, y: 0, z: 0.6 }]);
assert.equal(isolatedIndex.hit(topEdge).status, "hit",
  "strict collision keeps top-face penetration solid");
assert.equal(isolatedIndex.hit(topEdge, "gameplay").status, "clear",
  "gameplay can cross the bounded top-edge lip");
const deepOverlap = k.boxPoly({ x, y: deck.maxY - 0.4, z }, [{ x: 1.3, y: 0, z: 0 }, { x: 0, y: 0.575, z: 0 }, { x: 0, y: 0, z: 0.6 }]);
assert.equal(isolatedIndex.hit(deepOverlap, "gameplay").status, "hit",
  "deep overlap remains a physical obstruction");
const rampSlab = solids.find((solid) => solid.role === "ramp-deck");
assert.ok(rampSlab && rampSlab.mountableHeight <= 1.1, "ramp deck has a bounded pitched-body mounting envelope");
const rampInput = collision.solids.find((solid) => solid.id === rampSlab.id);
assert.ok(rampInput);
const rampIndex = k.buildCollisionIndex([rampInput]);
const rampX = (rampSlab.minX + rampSlab.maxX) / 2, rampZ = (rampSlab.minZ + rampSlab.maxZ) / 2;
const rampTopEdge = k.boxPoly({ x: rampX, y: rampSlab.maxY + 0.475, z: rampZ },
  [{ x: 1.3, y: 0, z: 0 }, { x: 0, y: 0.575, z: 0 }, { x: 0, y: 0, z: 0.6 }]);
assert.equal(rampIndex.hit(rampTopEdge, "gameplay").status, "clear", "the bounded ramp top edge is mountable in gameplay");
const rampDeepOverlap = k.boxPoly({ x: rampX, y: rampSlab.maxY - 1.2, z: rampZ },
  [{ x: 1.3, y: 0, z: 0 }, { x: 0, y: 0.575, z: 0 }, { x: 0, y: 0, z: 0.6 }]);
assert.equal(rampIndex.hit(rampDeepOverlap, "gameplay").status, "hit", "deep ramp overlap remains a physical obstruction");
console.log(`Expressway driving: ${placed}/${checked} real elevated-road samples accepted parked + rolling cars (control without deck policy blocked ${blockedWithoutDeckPolicy}); bounded deck/ramp top edges are gameplay-mountable, deep overlap remains physical; ${decks.length} elevated slabs checked.`);

// A mountable deck used to subtract the whole vertical rise from the travel
// budget, so speedFraction stayed near 1-sin(pitch) and full throttle equilibrated
// at a few km/h. Real grade must stay in the 3D charge; only the unexplained step is free.
{
  let climbed = null;
  for (const piece of k.expresswayPieces(plan).filter((part) => part.role === "expressway-deck")) {
    const layerId = `expressway:${piece.highway}`;
    const at = regions.classify(piece.x, piece.z, layerId);
    if (at.status !== "drivable") continue;
    const heading = -piece.ry;
    const fitted = k.footprintSupport(regions, { x: piece.x, z: piece.z, heading, y: at.y }, at.regionId,
      k.GAMEPLAY_DRIVING_FOOTPRINT, k.GAMEPLAY_FOOTPRINT_PARAMS, undefined, k.mountableQueryOf(solids));
    if (!fitted.ok || Math.abs(fitted.pitch) < 0.1) continue;
    const uphill = fitted.pitch >= 0 ? heading : heading + Math.PI;
    const placement = env.place(piece.x, piece.z, uphill, at.regionId, fitted.y);
    if (!placement || placement.pitch <= 0.1) continue;
    const cruise = 8;
    const dt = 1 / 60;
    const horizontal = cruise * Math.cos(placement.pitch);
    const held = env.move({ ...k.initialDrivingState(piece.x, piece.z, uphill, at.regionId), ...placement, speed: cruise }, {
      x: piece.x + Math.cos(uphill) * horizontal * dt,
      z: piece.z + Math.sin(uphill) * horizontal * dt,
      heading: uphill, travelBudget: cruise * dt,
    });
    let state = { ...k.initialDrivingState(piece.x, piece.z, uphill, at.regionId), ...placement };
    let peak = 0;
    for (let tick = 0; tick < 90 && peak < 4; tick++) {
      const next = kernel.step(state, forward);
      if (next.motion.blocked || next.motion.contact) break;
      state = next.state;
      peak = Math.max(peak, state.speed);
    }
    climbed = { segment: `${piece.highway}/${piece.segment}`, pitch: placement.pitch, fraction: held.speedFraction, peak };
    break;
  }
  assert.ok(climbed, "seed 42 has an uphill expressway deck steeper than 0.1 rad");
  assert.ok(climbed.fraction > 0.98, `grade must be charged as road travel, not dropped as a curb step (fraction ${climbed.fraction})`);
  assert.ok(climbed.peak > 3, `full throttle on pitch ${climbed.pitch.toFixed(3)} must keep accelerating (peak ${climbed.peak.toFixed(2)}; the curb exemption used to stall near 1)`);
  console.log(`Expressway climb: pitch ${climbed.pitch.toFixed(3)} keeps fraction ${climbed.fraction.toFixed(3)} and reaches ${climbed.peak.toFixed(2)} u/s.`);
}
