#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { makeFixtures } from "./city-kit/surface-region-fixtures.mjs";
const m = await loadCity({
  "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "game/driving/CollisionIndex.ts": ["buildVersionedCollisionIndex"],
  "game/driving/ContinuousDrivingEnvironment.ts": ["ContinuousDrivingEnvironment"],
  "game/runtime/diagnosticSpawn.ts": ["diagnosticSpawn", "diagnosticSpawnAsync"],
  "game/runtime/createCityCarSession.ts": ["createCityCarDiagnosticSession"],
  "game/runtime/GameRuntime.ts": ["GameRuntime"],
  "game/DrivingSimulation.ts": ["initialDrivingState"],
});
const { patch, grid, snapshot } = makeFixtures(m);
const surface = snapshot([patch("pad", "carriageway", grid(-20, -6, 20, 6, 10, 4))]);
const regions = m.buildSurfaceRegions(surface, m.buildSurfaceIndex(surface));
assert.equal(regions.status, "ready");
const wall = { id: "wall", role: "building", kind: "box", center: { x: -2, y: 1, z: 0 },
  halfAxes: [{ x: .5, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 2 }] };
const collision = m.buildVersionedCollisionIndex("w", [wall]);
assert.equal(collision.status, "ready");
const dimensions = { halfLength: 1.4, halfWidth: .7, halfHeight: .5 };
const binding = { surfaceRevision: surface.revision, worldRevision: "w", solidRevision: "w", solids: collision.index.solids(),
  dimensions, centerHeight: .55, isCurrent: () => true };
const environment = new m.ContinuousDrivingEnvironment(regions, binding);
const point = regions.classify(-8, 0, "ground");
assert.equal(point.status, "drivable");
const support = environment.place(-8, 0, 0, point.regionId);
assert.ok(support);
const start = { ...m.initialDrivingState(-8, 0, 0, point.regionId), ...support };
const desired = { x: -2, z: 0, heading: 0, travelBudget: 6 };
const normalize = (value) => JSON.parse(JSON.stringify(value));

// A host heartbeat actually executes while the same full-budget collision job
// is suspended. The synchronous motor and interactive job return identical traces.
let heartbeats = 0, checkpoints = 0;
const heartbeat = setInterval(() => heartbeats++, 0);
try {
  const expected = environment.move(start, desired);
  const actual = await environment.moveAsync(start, desired, async () => {
    checkpoints++; await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(checkpoints > 1 && heartbeats > 0, "motion preparation cannot starve the host heartbeat");
  assert.deepEqual(normalize(actual), normalize(expected), "yielding must preserve contacts, budgets and every trajectory pose");
  const budgeted = new m.ContinuousDrivingEnvironment(regions, binding, undefined, undefined, { maxTests: 1 });
  const syncBudget = budgeted.move(start, desired);
  const asyncBudget = await budgeted.moveAsync(start, desired, async () => {});
  assert.equal(syncBudget.queryStatus, "unresolved");
  assert.deepEqual(normalize(asyncBudget), normalize(syncBudget), "yields never reset a collision query's budget");
  const spawnProgress = [];
  const asyncSpawn = await m.diagnosticSpawnAsync(surface, regions, environment, undefined, undefined,
    (completed, limit) => spawnProgress.push({ completed, limit }));
  assert.deepEqual(normalize(asyncSpawn), normalize(m.diagnosticSpawn(surface, regions, environment)),
    "candidate ordering and bidirectional clearance are identical");
  assert.ok(spawnProgress.length > 0, "diagnostic spawn reports progress for a short search too");
  assert.ok(spawnProgress.every((item, index) => item.completed <= item.limit && (!index || item.completed > spawnProgress[index - 1].completed)),
    "candidate progress is monotonic and stays within the real candidate budget");
} finally { clearInterval(heartbeat); }

// Cancellation at each asynchronous preparation boundary must release the exact
// acquired scene, never install a frame hook or attach an adapter afterward.
const phases = ["world-capture", "world-read", "surface-index", "surface-regions", "static-solids", "collision-world"];
for (const cancelAt of phases) {
  let releases = 0, hooks = 0, released = false;
  const abort = new AbortController(), runtime = new m.GameRuntime();
  const world = { revision: "w", surface, obstacles: [], renderedSolids: [], sceneSolids: [], landings: [], counts: {}, obstacleCoverage: "structures-only" };
  const capture = { worldRevision: "w", revision: surface.revision, isLeaseCurrent: () => !released, verifyCurrent: () => !released, readWorld: () => world };
  const lease = { revision: "w", snapshot: { drivingWorld: capture, staticWorld: capture }, isCurrent: () => !released,
    setFrameHook: (next) => { if (next) hooks++; }, release: () => { if (!released) { releases++; released = true; } } };
  const entry = await m.createCityCarDiagnosticSession({ gameScenePort: { acquireResult: async () => ({ status: "ready", lease }) } }, runtime,
    { collider: { dimensions, centerHeight: .55, vehicleConfigHash: "fixture" }, present: () => assert.fail("cancelled prepare presented"),
      onPreparationMetric: (metric) => { runtime.recordPreparation(metric); if (metric.stage === cancelAt) abort.abort(); } }, abort.signal);
  assert.equal(entry.status, "unavailable", cancelAt);
  assert.equal(releases, 1, `${cancelAt}: exact lease released once`);
  assert.equal(hooks, 0); assert.equal(runtime.snapshot.phase, "idle");
  assert.ok(Object.keys(runtime.diagnostics.preparationMs).length <= phases.length);
  runtime.dispose();
}
console.log("Preparation: real host heartbeat during exact motion jobs, synchronous parity, shared query budgets, candidate parity and cancellation at every stage passed.");
