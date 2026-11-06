#!/usr/bin/env node
// Whole-vehicle coverage + continuous motion over surface regions, wired into the same
// DrivingKernel/runner/observer used by manual driving. --cities drives real planning layouts.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { makeFixtures } from "./city-kit/surface-region-fixtures.mjs";
const m = await loadCity({
  "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "engine/surface/groundRoadCompiler.ts": ["compileGroundRoadSurface"],
  "engine/surface/buildGroundSnapshot.ts": ["buildGroundSurfaceSnapshot"],
  "game/driving/surfaceFootprint.ts": ["footprintSupport", "validateMotion", "DEFAULT_FOOTPRINT_PARAMS", "segmentTouchesConvex"],
  "game/driving/SurfaceDrivingWorld.ts": ["SurfaceDrivingEnvironment", "SurfaceWorldValidator", "polylineProgress"],
  "game/driving/CollisionIndex.ts": ["buildCollisionIndex", "carBody", "polytopesIntersect", "boxPoly"],
  "game/driving/vehicleFootprint.ts": ["DRIVING_FOOTPRINT"],
  "game/driving/DrivingKernel.ts": ["DrivingKernel"],
  "game/driving/audit/DrivingRouteRunner.ts": ["DrivingRouteRunner"],
  "game/driving/audit/GateAuditObserver.ts": ["GateAuditObserver"],
  "game/DrivingSimulation.ts": ["initialDrivingState", "stepDriving"],
});
const { grid, patch, regionsOf } = makeFixtures(m);
{
  // Pure CPU boundary (spec §4): no THREE/React/engine systems/host/data provider/runtime planner.
  const { createRequire } = await import("node:module");
  const { buildSync } = createRequire(new URL("../apps/agent-city/ui/package.json", import.meta.url))("esbuild");
  for (const file of ["engine/surface/surfaceRegions.ts", "engine/surface/compileSurface.ts", "engine/surface/structureCompiler.ts", "engine/surface/citySurfacePort.ts",
    "engine/surface/terrainClip.ts", "game/driving/surfaceFootprint.ts", "game/driving/SurfaceDrivingWorld.ts", "game/driving/CollisionIndex.ts", "game/driving/citySolids.ts"]) {
    const built = buildSync({ entryPoints: [new URL(`../apps/agent-city/ui/src/${file}`, import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "esm", metafile: true });
    for (const input of Object.keys(built.metafile.inputs)) {
      assert.ok(!/node_modules|engine\/systems|engine\/render|host\.ts|cityPlan\.ts|cityLayout\.ts|\/data\/|CityEngine|react/i.test(input), `${file} leaked runtime dependency ${input}`);
    }
  }
}
const F = m.DRIVING_FOOTPRINT; const FP = m.DEFAULT_FOOTPRINT_PARAMS;
const W = F.halfWidth + FP.lateralMargin; // clearance half-width the body needs
const ready = (patches) => { const { regions } = regionsOf(patches); assert.equal(regions.status, "ready"); return regions; };
const support = (regions, x, z, heading = 0, region = regions.regions[0].id, params = FP) => m.footprintSupport(regions, { x, z, heading }, region, F, params);

// Straight road 6 wide with sidewalks (curbs on both sides).
const straight = ready([patch("road", "carriageway", grid(-50, -3, 50, 3, 25, 3)), patch("walk", "sidewalk", grid(-50, -4.2, 50, 4.2, 25, 3, () => -0.01))]);
const road = straight.regions[0].id;
{
  const ok = support(straight, 0, 0);
  assert.equal(ok.ok, true); assert.equal(ok.y, 0); assert.equal(ok.regionId, road);
  assert.ok(support(straight, 0, 3 - W - 0.01).ok, "inside the 0.2 lateral margin");
  const curb = support(straight, 0, 3 - W + 0.01);
  assert.equal(curb.ok, false); assert.equal(curb.reason, "unsupported-footprint"); assert.equal(curb.detail, "curb:sidewalk");
  assert.ok(curb.witness, "failures carry a locatable boundary witness");
  assert.equal(support(straight, 49, 0).detail, "closed:no-surface", "a road end without a portal is closed");
  assert.equal(support(straight, 0, 3.5).reason, "no-surface", "center on the sidewalk has no support");
  assert.equal(support(straight, 0, 0, 0, "region:ground:nope").reason, "invalid-input", "spawn needs an explicit known region");
  assert.equal(support(straight, NaN, 0).reason, "invalid-input");
}

// The four-wheels-and-four-corners trap: a small island between the wheels.
{
  const regions = ready([patch("road", "carriageway", grid(-20, -5, 20, 5, 20, 5)), patch("isle", "island", grid(0.2, -0.25, 0.6, 0.25, 1, 1, () => 0.15))]);
  const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([l, w]) => [l * F.halfLength, w * F.halfWidth]);
  const wheels = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([l, w]) => [l * F.wheelbase / 2, w * F.track / 2]);
  for (const [x, z] of [[0, 0], ...corners, ...wheels]) assert.equal(regions.classify(x, z, "ground").status, "drivable", "centre, every corner and every wheel are on asphalt");
  const result = support(regions, 0, 0);
  assert.equal(result.ok, false); assert.equal(result.detail, "curb:island", "the body still straddles the island");
  // A true mesh hole of the same size is equally rejected.
  const holed = ready([patch("holed", "carriageway", grid(-20, -5, 20, 5, 80, 20, () => 0, (i, j) => !(i === 40 && j === 10)))]);
  assert.equal(holed.classify(0.25, 0.25, "ground").cause, "no-surface");
  assert.equal(support(holed, 0, 0).detail, "closed:no-surface");
  assert.ok(support(holed, 6, 0).ok);
}

// Narrow passage: road narrows to a neck slightly below/above the required clearance.
for (const [neck, expected] of [[2 * W - 0.05, false], [2 * W + 0.05, true]]) {
  const regions = ready([patch("wide", "carriageway", grid(-30, -3, 0, 3, 10, 2)), patch("neck", "carriageway", grid(-0.5, -neck / 2, 30, neck / 2, 10, 1))]);
  const r = m.validateMotion(regions, { x: -10, z: 0, heading: 0 }, { x: -10, z: 0, heading: 0 }, regions.regions[0].id, F);
  assert.equal(r.ok, true);
  let ok = true;
  for (let x = -10; x < 20 && ok; x += 0.2) ok = m.validateMotion(regions, { x, z: 0, heading: 0 }, { x: x + 0.2, z: 0, heading: 0 }, regions.regions[0].id, F).ok;
  assert.equal(ok, expected, `neck ${neck.toFixed(3)} passable=${expected}`);
}

// Continuous motion: a thin divider is jumped in one primitive; only the swept hull sees it.
{
  const regions = ready([patch("road", "carriageway", grid(-20, -8, 20, 8, 20, 8)), patch("divider", "island", grid(-20, -0.05, 20, 0.05, 20, 1, () => 0.15))]);
  const id = regions.regions[0].id; const coarse = { ...FP, maxSampleDistance: 100 };
  const from = { x: 0, z: -2.5, heading: Math.PI / 2 }; const to = { x: 0, z: 2.5, heading: Math.PI / 2 };
  assert.ok(support(regions, from.x, from.z, from.heading, id, coarse).ok && support(regions, to.x, to.z, to.heading, id, coarse).ok, "both end poses are legal");
  const jump = m.validateMotion(regions, from, to, id, F, coarse);
  assert.equal(jump.ok, false); assert.equal(jump.detail, "curb:island"); assert.equal(jump.lastValidFraction, 0);
}

// Rotation in a pocket: end poses fit, the sweep does not (corner arc).
{
  const side = 2 * Math.max(F.halfLength + FP.longitudinalMargin, W) + 0.1; // fits at 0° and 90°
  const regions = ready([patch("pocket", "carriageway", grid(-side / 2, -side / 2, side / 2, side / 2, 4, 4))]);
  const id = regions.regions[0].id;
  assert.ok(support(regions, 0, 0, 0, id).ok); assert.ok(support(regions, 0, 0, Math.PI / 2, id).ok);
  const spin = m.validateMotion(regions, { x: 0, z: 0, heading: 0 }, { x: 0, z: 0, heading: Math.PI / 2 }, id, F);
  assert.equal(spin.ok, false, "rotation sweeps the corners outside the pocket");
  assert.ok(spin.lastValidFraction > 0 && spin.lastValidFraction < 0.5);
  const unsubdivided = m.validateMotion(regions, { x: 0, z: 0, heading: 0 }, { x: 0, z: 0, heading: Math.PI / 2 }, id, F, { ...FP, maxAngleStep: 10 });
  assert.equal(unsubdivided.ok, false, "even one coarse primitive is inflated by the rotation sagitta");
  assert.equal(m.validateMotion(regions, { x: 0, z: 0, heading: 0 }, { x: 0, z: 0, heading: 4 }, id, F).reason, "invalid-input");
  assert.equal(m.validateMotion(regions, { x: 0, z: 0, heading: 0 }, { x: 0, z: 0, heading: 3 }, id, F, { ...FP, maxSamples: 4 }).reason, "query-budget");
}

// Seams: an alias seam (≤ tolerance) is driven across, a 0.15 step and a different region are not.
{
  const alias = ready([patch("a", "carriageway", grid(-20, -4, 1, 4, 6, 2)), patch("b", "junction", grid(-1, -4, 20, 4, 6, 2, () => 0.06))]);
  const id = alias.regions[0].id;
  let x = -8; let r;
  for (; x < 8; x += 0.2) { r = m.validateMotion(alias, { x, z: 0, heading: 0 }, { x: x + 0.2, z: 0, heading: 0 }, id, F); if (!r.ok) break; }
  assert.equal(r.ok, true, "alias seam within tolerance is continuous");
  assert.ok(Math.abs(r.support.y - 0.06) < 1e-6, "support is the upper envelope of the aliases");
  const stepped = ready([patch("a", "carriageway", grid(0, -5, 10, 5, 2, 2)), patch("b", "carriageway", grid(10, -5, 20, 5, 2, 2, () => 0.15)),
    patch("c", "junction", grid(9.6, -5, 10.4, -3, 1, 1, (px) => (px - 9.6) / 0.8 * 0.15))]);
  assert.equal(stepped.regions.length, 1);
  let blocked = null;
  for (let px = 6; px < 14 && !blocked; px += 0.2) { const v = m.validateMotion(stepped, { x: px, z: 1, heading: 0 }, { x: px + 0.2, z: 1, heading: 0 }, stepped.regions[0].id, F); if (!v.ok) blocked = v; }
  assert.ok(blocked); assert.equal(blocked.detail, "step:step");
  const split = ready([patch("a", "carriageway", grid(0, -5, 10, 5, 2, 2)), patch("b", "carriageway", grid(10, -5, 20, 5, 2, 2, () => 0.25))]);
  assert.equal(split.regions.length, 2, "a 0.25 seam is two regions, never an implicit portal");
  assert.equal(support(split, 11.6, 0, 0, split.regions[0].id).reason, "closed-portal");
}

// Slope limits: 10° ramp drives, 25° ramp is excessive-slope; a wheel off a step is excessive-step.
{
  for (const [deg, ok] of [[10, true], [25, false]]) {
    const t = Math.tan(deg * Math.PI / 180);
    const ramp = ready([patch("ramp", "ramp", grid(-20, -4, 20, 4, 4, 2, (x) => x * t))]);
    const r = support(ramp, 0, 0);
    assert.equal(r.ok, ok, `${deg}° ramp`);
    if (ok) assert.ok(Math.abs(r.pitch - deg * Math.PI / 180) < 1e-3, "pitch is fitted from four wheel contacts");
    else assert.equal(r.reason, "excessive-slope");
  }
  // Bank twist: two halves of a quad tilted opposite ways — a hanging wheel.
  const twist = ready([patch("twist", "carriageway", grid(-10, -4, 10, 4, 1, 1, (x, z) => x * z * 0.02))]);
  assert.equal(support(twist, 5, 2, 0).reason, "excessive-step");
}

// Layers: driving under a deck stays on the ground; the deck region ends at its edge.
{
  const regions = ready([patch("ground-road", "carriageway", grid(-30, -3, 30, 3, 10, 2)), patch("deck", "bridge-deck", grid(-3, -30, 3, 30, 2, 10, () => 6), "deck-1")]);
  const ground = "region:ground:ground-road"; const deck = "region:deck-1:deck";
  let ok = true; for (let x = -10; x < 10 && ok; x += 0.2) ok = m.validateMotion(regions, { x, z: 0, heading: 0 }, { x: x + 0.2, z: 0, heading: 0 }, ground, F).ok;
  assert.ok(ok, "passing under the deck is unaffected by the deck");
  assert.equal(support(regions, 0, 0, 0, ground).y, 0); assert.equal(support(regions, 0, 0, Math.PI / 2, deck).y, 6);
  assert.ok(m.validateMotion(regions, { x: 0, z: 0, heading: 0 }, { x: 0.2, z: 0, heading: 0 }, deck, F).ok);
  const edge = m.validateMotion(regions, { x: 1.2, z: 0, heading: 0 }, { x: 1.6, z: 0, heading: 0 }, deck, F);
  assert.equal(edge.ok, false, "the deck ends at its edge; the ground road below never continues it");
  assert.equal(edge.detail, "closed:no-surface");
}

// Segment–convex polygon predicate.
{
  const sq = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }];
  assert.equal(m.segmentTouchesConvex({ ax: -1, az: 0.5, bx: 2, bz: 0.5 }, sq), true);
  assert.equal(m.segmentTouchesConvex({ ax: 0.2, az: 0.2, bx: 0.3, bz: 0.3 }, sq), true, "fully inside");
  assert.equal(m.segmentTouchesConvex({ ax: -1, az: 1.5, bx: 2, bz: 1.5 }, sq), false);
  assert.equal(m.segmentTouchesConvex({ ax: 1, az: -1, bx: 1, bz: 2 }, sq), true, "touching an edge counts");
  assert.equal(m.segmentTouchesConvex({ ax: 1.5, az: -1, bx: 3, bz: 0.4 }, sq), false);
}

// ── Kernel integration: same DrivingKernel, environment from regions, independent validator ──
const key = { baseSnapshotHash: "synthetic-surface-v1", vehicleConfigHash: "car-v1", kernelBuildId: "fixture-build-v1",
  surfaceVersion: 1, queryVersion: 1, snapshotCompilerVersion: 1, physicsVersion: 1, collisionVersion: 1,
  controllerVersion: 1, plannerVersion: 1, observerVersion: 1, manifestHash: "surface-straight-v1", releasePolicyVersion: 1, releaseBoundaryHash: null };
const forward = { forward: true, backward: false, left: false, right: false };
{
  const env = new m.SurfaceDrivingEnvironment(straight);
  const placed = env.place(-40, 0, 0, road); assert.ok(placed);
  const start = { ...m.initialDrivingState(-40, 0, 0, road), ...placed };
  const kernel = new m.DrivingKernel(env, key);
  const validator = new m.SurfaceWorldValidator(straight, m.polylineProgress([{ x: -40, z: 0 }, { x: 40, z: 0 }]));
  assert.equal(validator.validateStart(start), "valid");
  assert.equal(validator.validateStart({ ...start, y: 0.5 }), "simulation-invalid", "reported height must match fitted support");
  // Manual-style drive into the curb: blocked whole steps, never a footprint violation.
  let s = start; let blocks = 0;
  for (let i = 0; i < 400; i++) {
    const step = kernel.step(s, { ...forward, right: i > 30 });
    assert.equal(validator.validate(s, step), "valid", `tick ${i}`);
    if (step.motion.blocked) blocks++;
    s = step.state;
  }
  assert.ok(blocks > 0, "steering into the curb is blocked");
  assert.ok(m.footprintSupport(straight, s, road).ok, "the car never left the drivable body area");
  // Runner + observer: full-body exit gate on the same kernel.
  const test = { id: "surface-straight", units: ["edge"], start, corridor: { surfaceSequence: [road], portalSequence: [], waypoints: [{ x: -40, z: 0 }, { x: 40, z: 0 }] },
    policy: { cruiseSpeed: 7, maxReverseSpeed: 4 }, gates: [{ id: "exit", x: 0, y: 0, z: 0, forwardX: 1, forwardZ: 0, halfWidth: 2.9, heightTolerance: 0.05, surfaceIds: [road] }],
    maxTicks: 900, maxNoProgressTicks: 120 };
  const finish = (simulation) => { const run = new m.DrivingRouteRunner(key, test, simulation, { input: () => forward }, new m.GateAuditObserver(test, new m.SurfaceWorldValidator(straight, m.polylineProgress(test.corridor.waypoints))));
    let budget = 2000; while (!run.result && budget-- > 0) run.advance(50, run.key); return run.result; };
  assert.equal(finish(kernel).verdict, "passed");
  // An environment that ignores curbs lets the car through; the independent validator catches it.
  const leaky = new m.DrivingKernel({ move: (previous, desired) => ({ ...desired, y: 0, pitch: 0, roll: 0, surfaceId: previous.surfaceId, blocked: false }) }, key);
  const leakTest = { ...test, start: { ...start, heading: 0.35 } };
  const leakRun = new m.DrivingRouteRunner(key, leakTest, leaky, { input: () => forward }, new m.GateAuditObserver(leakTest, new m.SurfaceWorldValidator(straight, m.polylineProgress(test.corridor.waypoints))));
  let budget = 2000; while (!leakRun.result && budget-- > 0) leakRun.advance(50, leakRun.key);
  assert.equal(leakRun.result.cause, "simulation-invalid", "penetrating the curb is a simulation defect, never a pass");
  assert.equal(leakRun.result.verdict, "inconclusive");
}
// ── Cross-layer portal driving + solid collision (CollisionIndex) ──
{
  const portal = { id: "portal:ramp:road", fromPatch: "ramp", toPatch: "road", fromBoundary: { loop: 0, firstSegment: 0, segmentCount: 1 }, toBoundary: { loop: 0, firstSegment: 0, segmentCount: 1 },
    permittedDirection: "both", clearance: 2.2, maxHeightMismatch: 0.1, validated: false };
  const roadP = patch("road", "carriageway", grid(-10, -4, 40, 4, 25, 4));
  const rampP = patch("ramp", "ramp", grid(30, -4, 70, 4, 20, 4, (x) => (x - 30) * 0.05), "ramp:0");
  const snap = { revision: "fixture-rev", geometryVersion: 1, patches: [roadP, rampP], portals: [portal], renderBatches: [], report: { candidateLength: 0, geometricallyEligibleLength: 0, issues: [] } };
  const regions = m.buildSurfaceRegions(snap, m.buildSurfaceIndex(snap)); assert.equal(regions.status, "ready");
  const region = regions.regions[0].id;
  // The ramp slab (0.9 thick under its top face) is itself a solid: harmless to a car on it, a ceiling to one under it.
  const slope = 0.05; const n = Math.hypot(slope, 1); const normal = { x: -slope / n, y: 1 / n, z: 0 };
  const slab = { id: "slab", role: "expressway-deck", kind: "box", center: { x: 50 - normal.x * 0.45, y: 1 - normal.y * 0.45, z: 0 },
    halfAxes: [{ x: 20, y: 1, z: 0 }, { x: normal.x * 0.45, y: normal.y * 0.45, z: 0 }, { x: 0, y: 0, z: 4 }] };
  const collision = m.buildCollisionIndex([slab]);
  const climb = (solids) => {
    const env = new m.SurfaceDrivingEnvironment(regions, F, FP, solids); const kernel = new m.DrivingKernel(env, key);
    const validator = new m.SurfaceWorldValidator(regions, m.polylineProgress([{ x: 0, z: 0 }, { x: 66, z: 0 }]), F, FP, solids);
    let s = { ...m.initialDrivingState(0, 0, 0, region), ...env.place(0, 0, 0, region, 0) }; assert.equal(validator.validateStart(s), "valid");
    const layers = new Set();
    for (let tick = 0; tick < 3000 && s.x < 66; tick++) {
      const step = kernel.step(s, { forward: true, backward: false, left: s.heading > 0.01, right: s.heading < -0.01 });
      assert.equal(validator.validate(s, step), "valid", `tick ${tick}`);
      assert.ok(!step.motion.blocked, `climb blocked at x ${s.x.toFixed(2)}: ${step.motion.reason}`);
      s = step.state; layers.add(m.footprintSupport(regions, s, region).layerId);
    }
    return { s, layers };
  };
  for (const solids of [undefined, collision]) {
    const { s, layers } = climb(solids);
    assert.ok(s.x >= 66 && s.y > 1.7, "the kernel drives from the road over the portal up the ramp");
    assert.deepEqual([...layers].sort(), ["ground", "ramp:0"]); assert.equal(s.surfaceId, region, "a portal keeps the surface id");
  }
  const groundUnder = m.footprintSupport(regions, { x: 37, z: 0, heading: 0, y: 0 }, region);
  assert.ok(groundUnder.ok && Math.abs(groundUnder.y) < 1e-6, "the road continues under the ramp's low end");
  assert.equal(m.footprintSupport(regions, { x: 37, z: 0, heading: 0, y: 0 }, region, F, FP, collision).reason, "collision", "0.35 under the slab is no clearance");
  assert.ok(m.footprintSupport(regions, { x: 37, z: 0, heading: 0, y: 0.35 }, region, F, FP, collision).ok, "on the ramp at the same XZ is fine");

  // Solids on a straight road: a parked box blocks the kernel; an environment that ignores it is caught.
  const box = (id, x0, x1, y0, y1, z0 = -3, z1 = 3) => ({ id, role: "building", kind: "box", center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
    halfAxes: [{ x: (x1 - x0) / 2, y: 0, z: 0 }, { x: 0, y: (y1 - y0) / 2, z: 0 }, { x: 0, y: 0, z: (z1 - z0) / 2 }] });
  const parked = m.buildCollisionIndex([box("parked", 0, 2, 0, 3, -1, 1)]);
  const env = new m.SurfaceDrivingEnvironment(straight, F, FP, parked); const kernel = new m.DrivingKernel(env, key);
  const validator = new m.SurfaceWorldValidator(straight, m.polylineProgress([{ x: -40, z: 0 }, { x: 40, z: 0 }]), F, FP, parked);
  let s = { ...m.initialDrivingState(-40, 0, 0, road), ...env.place(-40, 0, 0, road) }; let blocked = false;
  for (let tick = 0; tick < 2000 && !blocked; tick++) {
    const step = kernel.step(s, forward); assert.equal(validator.validate(s, step), "valid");
    blocked = step.motion.blocked; if (blocked) assert.match(step.motion.reason, /^collision:building:parked/); s = step.state;
  }
  assert.ok(blocked && s.x < 0 - F.halfLength && s.x > -6, `stopped in front of the box (x ${s.x.toFixed(2)})`);
  const leaky = new m.DrivingKernel(new m.SurfaceDrivingEnvironment(straight), key);
  let t = { ...s }; let caught = false;
  for (let tick = 0; tick < 200 && !caught; tick++) { const step = leaky.step(t, forward); caught = validator.validate(t, step) === "simulation-invalid"; t = step.state; }
  assert.ok(caught, "driving through a solid is a simulation defect for the independent validator");
  // A 0.05-thin wall cannot be tunnelled by one long step; an overhead slab blocks only below 1.25.
  const wall = m.buildCollisionIndex([box("wall", 10, 10.05, 0, 3)]);
  assert.equal(m.validateMotion(straight, { x: 5, z: 0, heading: 0 }, { x: 15, z: 0, heading: 0 }, road, F, FP, wall).reason, "collision");
  assert.ok(m.validateMotion(straight, { x: 5, z: 0, heading: 0 }, { x: 15, z: 0, heading: 0 }, road, F, FP).ok);
  assert.equal(m.validateMotion(straight, { x: 15, z: 0, heading: 0 }, { x: 25, z: 0, heading: 0 }, road, F, FP, m.buildCollisionIndex([box("low", 20, 30, 1.0, 1.4)])).reason, "collision");
  assert.ok(m.validateMotion(straight, { x: 15, z: 0, heading: 0 }, { x: 25, z: 0, heading: 0 }, road, F, FP, m.buildCollisionIndex([box("high", 20, 30, 2.0, 2.4)])).ok);
  // Rotating in place sweeps the corners: a post just outside the static body but inside the swept arc.
  const reachBody = Math.hypot(F.halfLength + FP.longitudinalMargin, F.halfWidth + FP.lateralMargin);
  const post = m.buildCollisionIndex([box("post", -0.05, 0.05, 0, 2, reachBody - 0.15, reachBody - 0.05)]);
  assert.ok(m.footprintSupport(straight, { x: 0, z: 0, heading: 0 }, road, F, FP, post).ok, "the post is clear of the static body");
  assert.equal(m.validateMotion(straight, { x: 0, z: 0, heading: 0 }, { x: 0, z: 0, heading: Math.PI / 2 }, road, F, FP, post).reason, "collision");
  // SAT is exact for rotated boxes: corner-to-corner near miss vs touch.
  const unit = (cx, rot) => m.boxPoly({ x: cx, y: 0, z: 0 }, [{ x: Math.cos(rot), y: 0, z: Math.sin(rot) }, { x: 0, y: 1, z: 0 }, { x: -Math.sin(rot), y: 0, z: Math.cos(rot) }]);
  assert.equal(m.polytopesIntersect(unit(0, 0), unit(1 + Math.SQRT2 + 1e-6, Math.PI / 4)), false);
  assert.equal(m.polytopesIntersect(unit(0, 0), unit(1 + Math.SQRT2 - 1e-6, Math.PI / 4)), true);
}
console.log("Driving surface: whole-body coverage (islands/holes between wheels, lateral margin, necks), swept hull for jumps and rotation, alias/step/region seams, slope/twist, layers, kernel+runner integration and leaky-environment detection, cross-layer portal climb, solid collision (blocking, leaky detection, thin wall, ceiling, swept rotation, exact SAT) passed.");

if (process.argv.includes("--cities")) {
  const { cachedPlan } = await import("./city-kit/index.mjs");
  const { createCityPlan } = await loadCity({ "engine/cityPlan.ts": ["createCityPlan"] });
  let totalDriven = 0;
  for (const seed of [1, 7, 42, 2026, 65537]) for (const tier of [1, 2, 3]) {
    const plan = cachedPlan(createCityPlan, seed, tier);
    const snap = m.buildGroundSurfaceSnapshot(m.compileGroundRoadSurface(plan));
    const regions = m.buildSurfaceRegions(snap, m.buildSurfaceIndex(snap));
    assert.equal(regions.status, "ready");
    const env = new m.SurfaceDrivingEnvironment(regions); const kernel = new m.DrivingKernel(env, key);
    const outcomes = {}; let driven = 0;
    const degree = new Map(); for (const e of plan.roadEdges) for (const n of [e.from, e.to]) degree.set(n, (degree.get(n) ?? 0) + 1);
    // Straight single-segment roads: spawn on the centreline 4 units in, drive 12 units along it.
    const edges = plan.roadEdges.filter((e) => e.points.length === 2 && !e.bridge && Math.hypot(e.points[1].x - e.points[0].x, e.points[1].z - e.points[0].z) > 30)
      .sort((a, b) => a.id < b.id ? -1 : 1).slice(0, 40);
    for (const edge of edges) {
      const [a, b] = edge.points; const len = Math.hypot(b.x - a.x, b.z - a.z);
      const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len, heading = Math.atan2(dz, dx);
      const sx = a.x + dx * 12, sz = a.z + dz * 12;
      const center = regions.classify(sx, sz, "ground");
      if (center.status !== "drivable") { outcomes[`spawn:${center.cause}`] = (outcomes[`spawn:${center.cause}`] ?? 0) + 1; continue; }
      const placed = env.place(sx, sz, heading, center.regionId);
      if (!placed) { const why = m.footprintSupport(regions, { x: sx, z: sz, heading }, center.regionId); outcomes[`spawn:${why.reason}`] = (outcomes[`spawn:${why.reason}`] ?? 0) + 1; continue; }
      let s = { ...m.initialDrivingState(sx, sz, heading, center.regionId), ...placed };
      const validator = new m.SurfaceWorldValidator(regions, m.polylineProgress([a, b]));
      assert.equal(validator.validateStart(s), "valid");
      // Drive along the edge, through its end node and 6 units beyond (junction fills,
      // alias seams, curb corners). Outcomes are reported, not asserted to pass.
      const target = len - 12 + 6;
      let blocked = null;
      for (let tick = 0; tick < 3000 && (s.x - sx) * dx + (s.z - sz) * dz < target; tick++) {
        // Hold the centreline with a bounded proportional steer (buttons only).
        const lateral = -(s.x - a.x) * dz + (s.z - a.z) * dx; const err = Math.atan2(Math.sin(heading - s.heading), Math.cos(heading - s.heading)) - lateral * 0.3;
        const step = kernel.step(s, { forward: true, backward: false, left: err < -0.02, right: err > 0.02 });
        assert.equal(validator.validate(s, step), "valid", `seed ${seed} tier ${tier} ${edge.id} tick ${tick}`);
        if (step.motion.blocked) { blocked = step.motion.reason; break; }
        s = step.state;
      }
      const along = (s.x - sx) * dx + (s.z - sz) * dz;
      if (along >= 12) driven++;
      const outcome = blocked ? `${along >= len - 12 - 2 ? `at-node-deg${degree.get(edge.to)}` : "mid-road"}:${blocked}` : along >= target ? "through-node" : "timeout";
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    totalDriven += driven;
    console.log(`Driving surface: seed ${seed}, tier ${tier}: ${edges.length} straight roads → ${JSON.stringify(outcomes)}.`);
  }
  assert.ok(totalDriven > 0, "at least some real road segments must be continuously drivable on the compiled surface");
  console.log(`Driving surface: ${totalDriven} real road runs covered ≥12 units, every tick independently validated; node outcomes are diagnostics, not a city release certificate.`);
}
