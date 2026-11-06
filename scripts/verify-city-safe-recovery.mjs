#!/usr/bin/env node
// SafeRecovery (B): bounded deterministic search for the nearest whole-body-legal pose in the SAME region of
// the SAME frozen world; commits only to that world while it is current; budget exhaustion is not evidence.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { makeFixtures } from "./city-kit/surface-region-fixtures.mjs";
const m = await loadCity({
  "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "game/driving/SafeRecovery.ts": ["findSafePose", "commitRecovery", "SAFE_RECOVERY_VERSION"],
  "game/driving/CollisionIndex.ts": ["buildCollisionIndex"],
  "game/driving/surfaceFootprint.ts": ["footprintSupport"],
  "game/driving/SurfaceDrivingWorld.ts": ["SurfaceWorldValidator"],
});
const { grid, patch, regionsOf } = makeFixtures(m);
const regionsFor = (patches) => { const { regions } = regionsOf(patches); assert.equal(regions.status, "ready"); return regions; };
const box = (id, x0, x1, y0, y1, z0, z1) => ({ id, role: "building", kind: "box", center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
  halfAxes: [{ x: (x1 - x0) / 2, y: 0, z: 0 }, { x: 0, y: (y1 - y0) / 2, z: 0 }, { x: 0, y: 0, z: (z1 - z0) / 2 }] });
// 6-wide road with sidewalks along x.
const regions = regionsFor([patch("road", "carriageway", grid(-30, -3, 30, 3, 30, 6)), patch("walk", "sidewalk", grid(-30, 3, 30, 4.5, 15, 1))]);
const region = regions.regions[0].id;
const world = (extra = {}) => ({ worldRevision: "world-a", regions, isCurrent: () => true, ...extra });
const legal = (w, state) => new m.SurfaceWorldValidator(w.regions, () => 0, undefined, undefined, w.collision).validateStart(state) === "valid";

{
  // Already legal: returned unchanged (zero displacement, no heading change).
  const r = m.findSafePose(world(), { x: 0, z: 0, heading: 0, regionId: region });
  assert.equal(r.status, "recovered"); assert.equal(r.alreadySafe, true); assert.equal(r.displacement, 0); assert.equal(r.version, m.SAFE_RECOVERY_VERSION);
}
{
  // Body over the north curb: moved back inside by the smallest ring that clears it, same heading.
  const w = world();
  assert.equal(m.footprintSupport(regions, { x: 0, z: 2.5, heading: 0 }, region).ok, false, "the start really is illegal");
  const r = m.findSafePose(w, { x: 0, z: 2.5, heading: 0, regionId: region });
  assert.equal(r.status, "recovered"); assert.equal(r.headingChange, 0);
  assert.ok(r.displacement > 0 && r.displacement <= 1.5, `nearest legal pose (${r.displacement})`);
  assert.ok(r.state.z < 2.5 && legal(w, r.state), "inside the road and accepted by the independent validator");
  assert.deepEqual(m.findSafePose(w, { x: 0, z: 2.5, heading: 0, regionId: region }), r, "deterministic");
}
{
  // Overlapping a parked solid: recovered clear of it.
  const w = world({ collision: m.buildCollisionIndex([box("van", -1, 1, 0, 2, -1, 1)]) });
  assert.equal(m.footprintSupport(regions, { x: 0, z: 0, heading: 0 }, region, undefined, undefined, w.collision).reason, "collision");
  const r = m.findSafePose(w, { x: 0, z: 0, heading: 0, regionId: region });
  assert.equal(r.status, "recovered"); assert.ok(legal(w, r.state)); assert.ok(r.displacement > 1);
}
{
  // A 2.4-wide lane: a car standing across it needs a 90° turn; the heading bound decides.
  const lane = regionsFor([patch("lane", "carriageway", grid(-30, -1.2, 30, 1.2, 30, 2))]);
  const w = { worldRevision: "world-a", regions: lane, isCurrent: () => true };
  const req = { x: 0, z: 0, heading: Math.PI / 2, regionId: lane.regions[0].id };
  const bounded = m.findSafePose(w, req, { maxHeadingChange: Math.PI / 4, allowReverse: false, maxDistance: 2 });
  assert.equal(bounded.status, "unrecoverable"); assert.equal(bounded.reason, "no-safe-pose-within-bound");
  const turned = m.findSafePose(w, req, { maxHeadingChange: Math.PI / 2, allowReverse: false, maxDistance: 2 });
  assert.equal(turned.status, "recovered"); assert.ok(Math.abs(turned.headingChange - Math.PI / 2) < 1e-9);
  const starved = m.findSafePose(w, req, { maxHeadingChange: Math.PI / 2, maxCandidates: 3 });
  assert.equal(starved.status, "unrecoverable"); assert.equal(starved.reason, "budget", "running out of budget is not 'no road here'");
}
{
  // Never switches region: a stub road whose only nearby legal space belongs to another region.
  const two = regionsFor([patch("a", "carriageway", grid(-30, -3, -0.5, 3, 15, 6)), patch("b", "carriageway", grid(0.5, -3, 30, 3, 15, 6))]);
  const [ra] = two.regions.map((r) => r.id).sort();
  const r = m.findSafePose({ worldRevision: "world-a", regions: two, isCurrent: () => true }, { x: 0.8, z: 0, heading: 0, regionId: ra });
  assert.equal(r.status, "recovered"); assert.equal(r.state.surfaceId, ra); assert.ok(r.state.x < -0.5, "stays on its own region's side of the gap");
}
{
  // Commit is bound to the world the pose was computed on.
  let current = true; const w = world({ isCurrent: () => current });
  const r = m.findSafePose(w, { x: 0, z: 2.5, heading: 0, regionId: region });
  assert.equal(m.commitRecovery(r, w), r.state);
  assert.equal(m.commitRecovery(r, { ...w, worldRevision: "world-b" }), null, "another revision never takes an old pose");
  current = false;
  assert.equal(m.commitRecovery(r, w), null, "a stale world never takes it either");
  assert.equal(m.findSafePose(w, { x: 0, z: 2.5, heading: 0, regionId: region }).reason, "stale-world");
  assert.equal(m.findSafePose(world(), { x: 0, z: 0, heading: 0, regionId: "region:nope" }).reason, "unknown-region");
  assert.equal(m.findSafePose(world(), { x: NaN, z: 0, heading: 0, regionId: region }).reason, "invalid-input");
}
console.log("Safe recovery: already-safe passthrough, nearest legal pose off a curb and out of a solid (independently validated, deterministic), heading bound, budget ≠ no-road, no implicit region change, revision-bound commit passed.");
