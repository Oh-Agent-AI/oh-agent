#!/usr/bin/env node
// E-line prereq: exact rendered building solids now JOIN car collision as
// per-instance conservative world boxes instead of refusing the session.
// Cases: ready coverage, building blocks motion, spawn inside building refused,
// budget fail-closed, empty renderedSolids stays structures-only, degenerate
// instances skipped-but-counted, no rendered path unchanged.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { makeFixtures } from "./city-kit/surface-region-fixtures.mjs";
const m = await loadCity({
  "engine/surface/renderedSolidObstacles.ts": ["renderedSolidsToObstacles", "RENDERED_OBSTACLE_LIMITS"],
  "engine/surface/compileCitySolidInputs.ts": ["compileCitySolidInputs", "CITY_SOLID_BUILD_BUDGET", "CITY_SOLID_QUERY_CANDIDATE_BUDGET"],
  "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
  "game/runtime/createCityCarSession.ts": ["createCityCarSession", "createCityCarDiagnosticSession"],
  "game/runtime/GameRuntime.ts": ["GameRuntime"],
  "game/driving/CollisionIndex.ts": ["buildVersionedCollisionIndex"],
});
const { patch, grid, snapshot } = makeFixtures(m);
const surface = snapshot([patch("pad", "carriageway", grid(-30, -8, 30, 8, 10, 4))]);

/** Two-instance building: local unit box with base at y=0, like the city's instanced boxes. */
function buildingSolid(id, at) {
  const positions = new Float32Array([-.5,0,-.5, .5,0,-.5, .5,0,.5, -.5,0,.5, -.5,1,-.5, .5,1,-.5, .5,1,.5, -.5,1,.5]);
  const indices = new Uint32Array([0,1,2, 0,2,3, 4,6,5, 4,7,6, 0,4,5, 0,5,1, 1,5,6, 1,6,2, 2,6,7, 2,7,3, 3,7,4, 3,4,0]);
  const transforms = new Float64Array(at.length * 16);
  for (let i = 0; i < at.length; i += 1) {
    const [x, z, sx, sy, sz] = at[i];
    const mat = [sx,0,0,0, 0,sy,0,0, 0,0,sz,0, x,0,z,1]; // column-major; scale then translate (y stays 0 base)
    transforms.set(mat, i * 16);
  }
  return { id, role: "building", positions, indices, transforms };
}

// Shared S2 assembler: exact structure descriptors, approved proxies and rendered
// envelopes have one stable order/identity source. Total-build and query limits stay distinct.
{
  const structure = { id: "structure:deck", role: "bridge-deck", shape: "box", corners: [
    { x: 20, y: 0, z: 0 }, { x: 21, y: 0, z: 0 }, { x: 21, y: 1, z: 0 }, { x: 20, y: 1, z: 0 },
    { x: 20, y: 0, z: 1 }, { x: 21, y: 0, z: 1 }, { x: 21, y: 1, z: 1 }, { x: 20, y: 1, z: 1 }] };
  const proxy = { id: "proxy:landmark", role: "landmark", kind: "box", center: { x: 30, y: 2, z: 0 },
    halfAxes: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: 1 }] };
  const rendered = buildingSolid("rendered:building:0:0", [[40, 0, 2, 8, 2]]);
  const world = { revision: "world-fixture", surface, obstacles: [structure], sceneSolids: [proxy], renderedSolids: [rendered],
    landings: [], counts: {}, obstacleCoverage: "structures-and-rendered-buildings" };
  const result = m.compileCitySolidInputs(world);
  assert.equal(result.status, "ready");
  assert.equal(result.collisionIndex.revision, world.revision, "compiler exports the geometry-validated query index for exact compiled inputs");
  assert.deepEqual(result.solids.map((solid) => solid.id), ["proxy:landmark", "rendered:building:0:0#0", "structure:deck"].sort());
  assert.equal(result.counts.buildBudget, m.CITY_SOLID_BUILD_BUDGET);
  assert.equal(result.counts.queryCandidateBudget, m.CITY_SOLID_QUERY_CANDIDATE_BUDGET);
  assert.equal(m.compileCitySolidInputs(world, 2).status, "unavailable", "world-build cap is separate and fail-closed");
  const malformed = {
    ...world,
    sceneSolids: [{
      ...proxy,
      halfAxes: [{ x: NaN, y: 0, z: 0 }, proxy.halfAxes[1], proxy.halfAxes[2]],
    }],
  };
  assert.equal(m.compileCitySolidInputs(malformed).status, "unavailable", "malformed exported solids cannot be marked ready for consumers that skip later index validation");

  const thinLandmark = {
    id: "rendered:landmark:thin-oblique",
    role: "landmark",
    positions: new Float32Array([-.2,-.025,0, .2,-.025,0, .2,-.025,2, -.2,-.025,2, -.2,.025,0, .2,.025,0, .2,.025,2, -.2,.025,2]),
    indices: new Uint32Array([0,1,2,0,2,3,4,6,5,4,7,6,0,4,5,0,5,1,1,5,6,1,6,2,2,6,7,2,7,3,3,7,4,3,4,0]),
    transforms: new Float64Array([-0.9807347059249878,-6.938893903907228e-18,-0.19534443318843842,0,
      0.08496809750795364,0.9004471302032471,-0.4265857934951782,0,
      0.17589733004570007,-0.4349655210971832,-0.8830997347831726,0,
      186.13530333414613,8.66891164779663,256.3240946213946,1]),
  };
  const oblique = m.compileCitySolidInputs({ ...world, sceneSolids: [], renderedSolids: [thinLandmark] });
  assert.equal(oblique.status, "ready", "city-scale thin oblique rendered solids retain their captured center/half axes without lossy corner reconstruction");
  const compiledThin = oblique.solids.find((solid) => solid.id === "rendered:landmark:thin-oblique#0");
  assert.ok(compiledThin && compiledThin.kind === "box", "thin landmark remains in the shared compiled collision source");
  assert.ok(Math.abs(compiledThin.center.x - 186.31120066463922) < 1e-9 &&
    Math.abs(compiledThin.center.y - 8.233946126699448) < 1e-9 &&
    Math.abs(compiledThin.center.z - 255.44099488661084) < 1e-9, "fixture center is transformed from the captured world matrix");
  assert.ok(Math.abs(compiledThin.halfAxes[1].x - 0.002124202443957591) < 1e-8 &&
    Math.abs(compiledThin.halfAxes[1].y - 0.02251117825507927) < 1e-8 &&
    Math.abs(compiledThin.halfAxes[1].z + 0.01066464483737958) < 1e-8, "thin transformed axis is preserved without filtering or shrinking");
  for (const offset of [-10000, 0, 10000]) {
    const solid = { ...compiledThin, center: { x: compiledThin.center.x + offset, y: compiledThin.center.y, z: compiledThin.center.z - offset } };
    const built = m.buildVersionedCollisionIndex("thin-preserved", [solid]);
    assert.equal(built.status, "ready", "affine source axes remain valid across city coordinates");
    assert.equal(built.index.report.rejected, 0);
    assert.equal(built.index.solids().length, 1);
    const pose = { ...solid.center, heading: 0, pitch: 0, roll: 0 };
    assert.equal(built.index.overlap(pose, { halfLength: .1, halfWidth: .1, halfHeight: .1 }).status, "contact", "thin solid stays collidable");
    assert.equal(built.index.sweep({ ...pose, x: pose.x - 5 }, { ...pose, x: pose.x + 5 },
      { halfLength: .1, halfWidth: .1, halfHeight: .1 }).status, "contact", "sweep retains the rotated solid");
  }
  const axes = compiledThin.halfAxes;
  const parked = { id: "captured-small-instance", role: "rendered-building", kind: "box", center: { x: 21.063983917236328, y: -39.99995000000126, z: 95.01443481445312 },
    halfAxes: [{ x: .00004999999873689376, y: 0, z: 0 }, { x: 0, y: .00004999999873689376, z: 0 }, { x: 0, y: 0, z: .00004999999873689376 }] };
  const small = m.buildVersionedCollisionIndex("actual-parked-instance", [parked]);
  assert.equal(small.status, "ready", "real captured small but nondegenerate instances use a scale-relative volume test");
  assert.equal(small.index.report.rejected, 0);
  assert.equal(small.index.solids().length, 1, "small captured instances are retained, not silently skipped");
  for (const halfAxes of [[axes[0], axes[0], axes[2]], [axes[0], { x: 0, y: 0, z: 0 }, axes[2]],
    [axes[0], { x: NaN, y: 1, z: 0 }, axes[2]]]) {
    assert.equal(m.buildVersionedCollisionIndex("invalid-affine", [{ ...compiledThin, halfAxes }]).status, "unresolved", "degenerate affine inputs still fail closed");
  }
}

function hostFixture(renderedSolids = []) {
  const state = { releases: 0, hooks: 0, current: true, hook: null };
  const world = { revision: "world-fixture", surface, obstacles: [], sceneSolids: [], renderedSolids, landings: [], counts: {}, obstacleCoverage: renderedSolids.length ? "structures-and-rendered-buildings" : "structures-only" };
  const capture = { status: "ready", revision: surface.revision, worldRevision: world.revision,
    isCurrent: () => state.current,
    isLeaseCurrent: () => state.current,
    verifyCurrent: () => state.current,
    readWorld: () => state.current ? world : null,
    setFrameHook: (hook) => { state.hook = hook; if (hook) state.hooks++; },
    release: () => { if (!state.current) return; state.current = false; state.releases++; state.hook = null; } };
  const lease = { revision: world.revision, snapshot: { drivingWorld: capture, staticWorld: capture }, isCurrent: () => state.current,
    setFrameHook: (hook) => { state.hook = hook; if (hook) state.hooks++; }, release: capture.release };
  return { state, host: { gameScenePort: { acquireResult: async () => ({ status: "ready", lease }) } } };
}
const request = (over = {}) => ({ x: 0, z: 0, heading: 0, layerId: "ground",
  collider: { dimensions: { halfLength: 1.4, halfWidth: .7, halfHeight: .5 }, centerHeight: .55, vehicleConfigHash: "explicit-fixture-v1" }, present: () => {}, ...over });

// Converter unit: two 6×20×6 buildings at (12,0) and (-12,4), one flat degenerate.
{
  const solid = buildingSolid("rendered:building:0:0", [[12, 0, 6, 20, 6], [-12, 4, 6, 20, 6], [0, 0, 6, 0, 6]]);
  const result = m.renderedSolidsToObstacles([solid]);
  assert.equal(result.status, "ready");
  assert.equal(result.instances, 2);
  assert.equal(result.skippedDegenerate, 1);
  const [a] = result.obstacles;
  assert.ok(a.corners.length === 8);
  const ys = a.corners.map((c) => c.y);
  assert.equal(Math.min(...ys), 0, "base at ground");
  assert.equal(Math.max(...ys), 20, "height 20 preserved through transform");
  const xs = a.corners.map((c) => c.x);
  assert.ok(Math.min(...xs) >= 12 - 3.01 && Math.max(...xs) <= 12 + 3.01, "x extents around instance origin");
}

// Budget fail-closed.
{
  const emptyInstances = buildingSolid("empty-instances", []);
  const emptyDraw = { ...buildingSolid("empty-draw", [[0, 0, 1, 1, 1]]), indices: new Uint32Array() };
  const converted = m.renderedSolidsToObstacles([emptyInstances, emptyDraw]);
  assert.equal(converted.status, "ready", "valid captured meshes with no drawn triangles are empty collision");
  assert.equal(converted.obstacles.length, 0);
  const malformed = { ...emptyInstances, indices: new Uint32Array([999, 0, 1]) };
  assert.equal(m.renderedSolidsToObstacles([malformed]).status, "unavailable", "empty instances do not excuse malformed geometry");
  const f = hostFixture([emptyInstances, emptyDraw]); const runtime = new m.GameRuntime();
  assert.equal((await m.createCityCarDiagnosticSession(f.host, runtime, request())).status, "ready");
  runtime.exit(); assert.equal(f.state.releases, 1);
}

// Budget fail-closed.
{
  const many = Array.from({ length: m.RENDERED_OBSTACLE_LIMITS.solids + 1 }, (_, i) => buildingSolid(`s${i}`, [[i, 0, 1, 1, 1]]));
  assert.equal(m.renderedSolidsToObstacles(many).status, "unavailable");
  const one = buildingSolid("many-instances", Array.from({ length: m.RENDERED_OBSTACLE_LIMITS.obstacles + 1 }, (_, i) => [i, 0, 1, 1, 1]));
  assert.equal(m.renderedSolidsToObstacles([one]).status, "unavailable");
  assert.equal(m.renderedSolidsToObstacles([buildingSolid("bad-transform", [[0, 0, 1, 1, 1]])], { obstacles: 2, solids: 2 }).status, "ready");
}

// Session: building on the pad → coverage structures-and-buildings; driving into
// the building is blocked by exact-instance collision; spawn inside refused.
{
  const solids = [buildingSolid("rendered:building:0:0", [[12, 0, 6, 20, 6]])];
  const f = hostFixture(solids); const runtime = new m.GameRuntime();
  const result = await m.createCityCarDiagnosticSession(f.host, runtime, request());
  assert.equal(result.status, "ready", JSON.stringify(result));
  assert.equal(result.coverage, "structures-and-buildings");
  runtime.resume();
  // Drive forward (heading 0 → +x) for 3 simulated seconds: car must stop before x≈9.
  runtime.setInput({ forward: true });
  for (let i = 0; i < 180; i += 1) f.state.hook(1 / 60);
  const snap = result.adapter.snapshot;
  assert.ok(snap.x < 9.2, `car must not enter building, x=${snap.x}`);
  assert.ok(snap.x > 5, `car should approach the building, x=${snap.x}`);
  runtime.exit();
  assert.equal(f.state.releases, 1);
}
{
  // Formal admission cannot use a bare coordinate even if the rendered world is known.
  const solids = [buildingSolid("rendered:building:0:0", [[0, 0, 6, 20, 6]])];
  const f = hostFixture(solids); const runtime = new m.GameRuntime();
  const result = await m.createCityCarSession(f.host, runtime, request());
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "validated-spawn-required");
  assert.equal(f.state.hooks, 0);
  assert.equal(f.state.releases, 0, "credential rejection happens before acquiring a host lease");
}
{
  // No rendered solids: behaviour identical to before (structures-only).
  const f = hostFixture(); const runtime = new m.GameRuntime();
  const result = await m.createCityCarDiagnosticSession(f.host, runtime, request());
  assert.equal(result.status, "ready");
  assert.equal(result.coverage, "structures-only");
  runtime.exit();
}
{
  // Over-budget rendered solids fail closed with a distinct reason, no hook.
  const over = [buildingSolid("rendered:building:0:0", Array.from({ length: m.RENDERED_OBSTACLE_LIMITS.obstacles + 1 }, (_, i) => [i, 0, 1, 1, 1]))];
  const f = hostFixture(over); const runtime = new m.GameRuntime();
  const result = await m.createCityCarDiagnosticSession(f.host, runtime, request());
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "rendered-solids-budget");
  assert.equal(f.state.hooks, 0);
  assert.equal(f.state.releases, 1);
}
console.log("City car rendered-solids collision: shared compiler identity, build/query budget separation, diagnostic collision and formal credential gate passed");
