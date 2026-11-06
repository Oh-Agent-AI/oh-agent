#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { makeFixtures } from "./city-kit/surface-region-fixtures.mjs";
const m = await loadCity({
  "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
  "engine/surface/renderedSolidObstacles.ts": ["renderedSolidsToObstacles"],
  "game/runtime/createCityCarSession.ts": ["createCityCarSession", "createCityCarDiagnosticSession"],
  "game/runtime/GameRuntime.ts": ["GameRuntime"],
});
const { patch, grid, snapshot } = makeFixtures(m);
const surface = snapshot([patch("pad", "carriageway", grid(-30, -8, 30, 8, 10, 4))]);
function hostFixture(renderedSolids = [], sceneSolids = []) {
  const state = { releases: 0, hooks: 0, current: true, hook: null, deepChecks: 0, leaseChecks: 0 };
  const world = { revision: "world-fixture", surface, obstacles: [], renderedSolids, sceneSolids, landings: [], counts: {}, obstacleCoverage: renderedSolids.length ? "structures-and-rendered-buildings" : "structures-only" };
  const capture = { status: "ready", revision: surface.revision, worldRevision: world.revision,
    isCurrent: () => { state.deepChecks++; return state.current; },
    isLeaseCurrent: () => { state.leaseChecks++; return state.current; },
    verifyCurrent: () => { state.deepChecks++; return state.current; },
    readWorld: () => state.current ? world : null,
    setFrameHook: (hook) => { state.hook = hook; if (hook) state.hooks++; },
    release: () => { if (!state.current) return; state.current = false; state.releases++; state.hook = null; } };
  const lease = { revision: world.revision, snapshot: { drivingWorld: capture, staticWorld: capture }, isCurrent: () => state.current,
    setFrameHook: (hook) => { state.hook = hook; if (hook) state.hooks++; }, release: capture.release };
  return { state, host: { gameScenePort: { acquireResult: async () => ({ status: "ready", lease }) } } };
}
const request = { x: 0, z: 0, heading: 0, layerId: "ground",
  collider: { dimensions: { halfLength: 1.4, halfWidth: .7, halfHeight: .5 }, centerHeight: .55, vehicleConfigHash: "explicit-fixture-v1" }, present: () => {} };
{
  const f = hostFixture(); const runtime = new m.GameRuntime();
  const result = await m.createCityCarDiagnosticSession(f.host, runtime, request);
  assert.equal(result.status, "ready"); assert.equal(runtime.snapshot.phase, "paused");
  assert.equal(runtime.snapshot.revision, "world-fixture"); assert.equal(result.adapter.snapshot.surfaceId, "region:ground:pad");
  const entryChecks = f.state.deepChecks;
  runtime.resume(); runtime.setInput({ forward: true });
  for (let tick = 0; tick < 60; tick++) f.state.hook(1/60);
  assert.ok(result.adapter.snapshot.x > 0);
  assert.equal(f.state.deepChecks, entryChecks, "frame loop and collision binding must not perform deep scene checks");
  assert.ok(f.state.leaseChecks > 60, "runtime uses the cheap frozen lease check");
  runtime.exit(); assert.equal(f.state.releases, 1); assert.equal(f.state.hook, null);
}
{
  // 白名单场景代理没有对应的 renderedSolid 时仍参与碰撞并标注 coverage。
  const wallProxy = { id: "bld-1", role: "building", kind: "box", center: { x: 0, y: 2, z: 6 }, halfAxes: [{ x: 2, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: 0.5 }] };
  const f = hostFixture([], [wallProxy]); const runtime = new m.GameRuntime();
  const result = await m.createCityCarDiagnosticSession(f.host, runtime, request);
  assert.equal(result.status, "ready", `building city must be drivable via proxies: ${result.reason}`);
  assert.equal(result.coverage, "structures-and-scene-proxies");
  assert.equal(f.state.releases, 0, "successful entry keeps the freeze");
  // 墙代理在场时运行链路活着：恢复 → 设输入 → 帧推进，快照可读且有限。
  assert.equal(runtime.resume(), true, "resume from entry pause");
  runtime.setInput({ forward: true, backward: false, left: false, right: false });
  f.state.hook?.(1 / 60);
  const snapshot = result.adapter.snapshot;
  assert.ok([snapshot.x, snapshot.y, snapshot.z].every(Number.isFinite), "car state finite with building proxies");
  runtime.exit();
}
{
  // Malformed rendered solids fail closed and never start a frame hook.
  const f = hostFixture([Object.freeze({ id: "malformed-mesh", role: "building", positions: undefined, indices: undefined, transforms: new Float64Array(16) })]); const runtime = new m.GameRuntime();
  const result = await m.createCityCarDiagnosticSession(f.host, runtime, request);
  assert.equal(result.status, "unavailable"); assert.equal(result.reason, "invalid-rendered-solid");
  assert.equal(f.state.releases, 1, "entry refusal releases displayed geometry freeze");
  assert.equal(f.state.hooks, 0, "architecture without collision never starts a frame hook");
  assert.equal(runtime.snapshot.phase, "idle");
}
{
  const f = hostFixture(); const runtime = new m.GameRuntime();
  const result = await m.createCityCarSession(f.host, runtime, { ...request, x: 29.5 });
  assert.equal(result.status, "unavailable"); assert.equal(result.reason, "validated-spawn-required");
  assert.equal(f.state.releases, 0); assert.equal(f.state.hooks, 0);
}
{
  const f = hostFixture(); const runtime = new m.GameRuntime(); const abort = new AbortController();
  const result = await m.createCityCarDiagnosticSession(f.host, runtime, request, abort.signal);
  assert.equal(result.status, "ready"); abort.abort();
  assert.equal(runtime.snapshot.phase, "idle"); assert.equal(f.state.releases, 1);
}
console.log("City car bridge: frozen structure/proxy collision, rendered-solid fail-closed validation, unsafe spawn and abort lease handling");
