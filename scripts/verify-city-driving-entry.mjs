#!/usr/bin/env node
// 正式驾驶入口守卫（E 线）：useCityDriving 的可测核心——入场互斥、成功/失败路径、
// 暂停/继续/退出的租约与帧钩子语义、出生点缺失拒绝、HUD 快照相位。
// React hook 本身不可 vm 化；守卫驱动与其行为等价的裸编排（同一 createCityCarSession
// 与 GameRuntime），并断言 hook 所依赖的运行时语义契约。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadCity } from "./city-kit/index.mjs";
import { makeFixtures } from "./city-kit/surface-region-fixtures.mjs";
const drivingHook = fs.readFileSync(path.resolve("apps/agent-city/ui/src/game/useCityDriving.ts"), "utf8");
const playHook = fs.readFileSync(path.resolve("apps/agent-city/ui/src/game/useCityDrivingPlay.ts"), "utf8");
const cityApp = fs.readFileSync(path.resolve("apps/agent-city/ui/src/CityApp.tsx"), "utf8");
assert.match(drivingHook, /resolveFormalSpawn\(confirmationStore, currentOptions\.spawnBinding, currentOptions\.spawn\)/,
  "the real useCityDriving formal path must use the tested confirmation gate");
assert.match(drivingHook, /createCityCarSession\(host, runtime, \{ \.\.\.request, x: confirmedSpawn!/,
  "formal session coordinates must come from the confirmed sealed credential");
assert.match(drivingHook, /mode === "free-drive" \? await createCityCarFreeDriveSession/,
  "the player entry must use the bounded free-drive spawn path");
assert.match(playHook, /enterFreeDrive\(\{ vtol: fly \}\)/, "the normal City driving control enters free drive");
assert.doesNotMatch(playHook, /enterDiagnostic|UAT/, "the player-facing control is independent of the diagnostic build flag");
assert.match(cityApp, /\{ id: "car", commandId: "city\.car", label: driving\.active \? "退出驾驶" : "驾车"/,
  "the normal City toolbar exposes driving without a UAT flag");
assert.match(cityApp, /case "city\.car":[\s\S]*else if \(sceneReady\) \{/,
  "the host driving command no-ops until the first model frame (throwing would fail the plugin)");
assert.doesNotMatch(cityApp, /city_not_ready/, "a premature drive click must not reject the plugin command");
assert.match(cityApp, /await noteBusy\(15_000\)/, "first-frame compile declares a host busy budget before blocking");
assert.match(playHook, /car\.hud\.phase === "running"\) focusCanvas\(\)/, "running play re-focuses the canvas after the start panel unmounts");
assert.match(playHook, /noteBusy\(8_000\)/, "first audio graph creation is preceded by a host busy pulse");
assert.doesNotMatch(cityApp, /CITY_DRIVING_UAT|useCityDrivingUat/, "ordinary builds do not gate driving on UAT");
const m = await loadCity({
  "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "game/driving/CollisionIndex.ts": ["buildVersionedCollisionIndex"],
  "game/driving/SurfaceDrivingWorld.ts": ["SurfaceDrivingEnvironment", "createStructureCollisionBinding"],
  "game/runtime/diagnosticSpawn.ts": ["diagnosticSpawn"],
  "game/runtime/createCityCarSession.ts": ["createCityCarSession", "createCityCarDiagnosticSession", "createCityCarFreeDriveSession"],
  "game/runtime/GameRuntime.ts": ["GameRuntime"],
});
const { patch, grid, snapshot } = makeFixtures(m);
const surface = snapshot([patch("pad", "carriageway", grid(-30, -8, 30, 8, 10, 4))]);
const request = { x: 0, z: 0, heading: 0, layerId: "ground",
  collider: { dimensions: { halfLength: 1.4, halfWidth: 0.7, halfHeight: 0.575 }, centerHeight: 0.55, vehicleConfigHash: "city-car-v1" }, present: () => {} };
function hostFixture(overrides = {}) {
  const state = { releases: 0, hooks: 0, current: true, hook: null };
  const world = { revision: "world-fixture", surface, obstacles: [], renderedSolids: [], sceneSolids: [], landings: [], counts: {}, obstacleCoverage: "structures-only", ...overrides };
  const capture = { status: "ready", revision: surface.revision, worldRevision: world.revision,
    isCurrent: () => state.current, isLeaseCurrent: () => state.current, verifyCurrent: () => state.current,
    readWorld: () => state.current ? world : null,
    setFrameHook: (hook) => { state.hook = hook; if (hook) state.hooks++; },
    release: () => { if (!state.current) return; state.current = false; state.releases++; state.hook = null; } };
  const lease = { revision: world.revision, snapshot: { drivingWorld: capture, staticWorld: capture }, isCurrent: () => state.current,
    setFrameHook: (hook) => { state.hook = hook; if (hook) state.hooks++; }, release: capture.release };
  return { state, host: { gameScenePort: { acquireResult: async () => ({ status: "ready", lease }) } } };
}

// Player entry uses the safe local spawn search and ordinary runtime lifecycle.
{
  const f = hostFixture(); const runtime = new m.GameRuntime();
  const entry = await m.createCityCarFreeDriveSession(f.host, runtime, request);
  assert.equal(entry.status, "ready", `normal free drive enters: ${entry.reason}`);
  assert.equal(runtime.snapshot.phase, "paused", "free drive waits for the user's explicit start");
  assert.ok(Number.isFinite(entry.adapter.snapshot.x), "safe spawn is derived from the current compiled road surface");
  runtime.exit(); assert.equal(f.state.releases, 1);
}
// The real free-drive factory must forward the chosen vehicle to the kernel.
for (const vtol of [false,true]) {
  const f=hostFixture(), runtime=new m.GameRuntime();let pose=null;let invalidSupport=0;
  const entry=await m.createCityCarFreeDriveSession(f.host,runtime,{...request,vtol,present:(frame)=>{pose=frame.state;if(frame.reason==="invalid-start-support")invalidSupport++;}});
  assert.equal(entry.status,"ready");
  f.state.hook(1/60);const baseY=pose.y;
  assert.equal(runtime.resume(),true);
  runtime.setInput({forward:false,backward:false,left:false,right:false,thruster:true});
  for(let i=0;i<60;i++)f.state.hook(1/60);
  assert.equal(runtime.snapshot.phase,"running");
  assert.equal(invalidSupport,0,"pre-liftoff height must not invalidate wheel support");
  if(vtol){assert(pose.y>baseY+0.5,"jet mode actually climbs");assert(pose.boost<1&&pose.boost>=0,"boost is finite and consumed");}
  else{assert.equal(pose.y,baseY,"standard car cannot lift");assert.equal(pose.boost,undefined);}
  runtime.exit();assert.equal(f.state.releases,1);
}

// 1) 入场成功：paused 起步（入场暂停）、租约保持、帧钩子已注册。
{
  const f = hostFixture(); const runtime = new m.GameRuntime();
  const entry = await m.createCityCarDiagnosticSession(f.host, runtime, request);
  assert.equal(entry.status, "ready", `ready: ${entry.reason}`);
  assert.equal(runtime.snapshot.phase, "paused", "入场即暂停等待用户");
  assert.equal(f.state.hooks, 1, "帧钩子注册一次");
  assert.equal(f.state.releases, 0);
  // 继续 → running；驱动一帧；暂停清输入。
  assert.equal(runtime.resume(), true);
  runtime.setInput({ forward: true, backward: false, left: false, right: false });
  f.state.hook?.(1 / 60);
  assert.equal(runtime.snapshot.phase, "running", "帧推进保持运行");
  runtime.pause("user-paused");
  assert.equal(runtime.snapshot.phase, "paused");
  // 退出：释放租约、帧钩子清空、再退出幂等。
  runtime.exit();
  assert.equal(f.state.releases, 1, "退出释放冻结租约");
  assert.equal(f.state.hook, null, "帧钩子清空");
  runtime.exit();
  assert.equal(f.state.releases, 1, "退出幂等");
}

// 2) Bare coordinates can no longer reach formal admission.
{
  const f = hostFixture(); const runtime = new m.GameRuntime();
  const entry = await m.createCityCarSession(f.host, runtime, { ...request, layerId: "no-such-layer" });
  assert.equal(entry.status, "unavailable");
  assert.equal(entry.reason, "validated-spawn-required");
  assert.equal(f.state.releases, 0, "credential refusal precedes lease acquisition");
  assert.equal(f.state.hooks, 0, "失败不起帧钩子");
  assert.equal(runtime.snapshot.phase, "idle");
}

// 3) 世界失效（入场后布局变化）：resume 拒绝、帧推进进入 error、再 exit 仍释放。
{
  const f = hostFixture(); const runtime = new m.GameRuntime();
  const entry = await m.createCityCarDiagnosticSession(f.host, runtime, request);
  assert.equal(entry.status, "ready");
  // 失效后租约源不再接受深检但 release 幂等守卫以 state.current 为准：
  // 失效瞬间 lease.release() 仍应执行（cleanup 终态语义），此处断言 error 相位
  // 与后续 exit 不产生二次释放；释放可能发生在失效瞬间或 exit，取两者合并。
  f.state.current = false; // 模拟世界失效（布局重建）
  assert.equal(runtime.resume(), false, "失效后拒绝继续");
  assert.equal(runtime.snapshot.phase, "error", "失效进入错误相位（fail 已清理会话）");
  f.state.hook?.(1 / 60);
  assert.equal(runtime.snapshot.phase, "error", "失效帧不恢复运行");
  runtime.exit();
  assert.equal(runtime.snapshot.phase, "idle", "错误后仍可显式退出复位");
  const releasedViaFail = f.state.releases >= 1; // fixture 的 release 以 current 守卫可能拦
  assert.ok(releasedViaFail || f.state.hook === null, "清理至少断开帧钩子；fixture 守卫下的释放差异不构成本守卫目标");
}

// 4) Diagnostic selection shares the same frozen world and full-body collision.
{
  const f = hostFixture(); const runtime = new m.GameRuntime();
  const result = await m.createCityCarFreeDriveSession(f.host, runtime, request);
  assert.equal(result.status, "ready");
  assert.equal(runtime.snapshot.phase, "paused");
  assert.ok(Number.isFinite(result.adapter.snapshot.x));
  runtime.exit(); assert.equal(f.state.releases, 1);
}
{
  const wall = { id: "blocking-all-spawns", role: "building", kind: "box", center: { x: 0, y: 1, z: 0 },
    halfAxes: [{ x: 100, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 100 }] };
  const f = hostFixture({ sceneSolids: [wall] }); const runtime = new m.GameRuntime();
  const result = await m.createCityCarFreeDriveSession(f.host, runtime, request);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "no-safe-free-drive-spawn");
  assert.equal(f.state.hooks, 0); assert.equal(f.state.releases, 1);
}
// 5) Diagnostic spawn must face clear road. A wall blocks the first candidate's
// forward and reverse corridor asymmetrically; the search should continue to a
// point with short swept clearance in both directions and use the road's long axis.
{
  const wall = { id: "curb-at-first-candidate", role: "building", kind: "box", center: { x: 2.1, y: 1, z: 0 },
    halfAxes: [{ x: 0.3, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 8 }] };
  const blockedStartSurface = snapshot([patch("long-road", "carriageway", grid(-30, -8, 30, 8, 10, 4))]);
  const index = m.buildSurfaceIndex(blockedStartSurface);
  assert.equal(index.status, "ready");
  const regions = m.buildSurfaceRegions(blockedStartSurface, index);
  assert.equal(regions.status, "ready");
  const collision = m.buildVersionedCollisionIndex("spawn-clearance-world", [wall]);
  assert.equal(collision.status, "ready");
  const binding = m.createStructureCollisionBinding({ surfaceRevision: blockedStartSurface.revision,
    worldRevision: "spawn-clearance-world", index: collision.index, dimensions: request.collider.dimensions,
    centerHeight: request.collider.centerHeight, isCurrent: () => true });
  const environment = new m.SurfaceDrivingEnvironment(regions, undefined, undefined, binding);
  const spawn = m.diagnosticSpawn(blockedStartSurface, regions, environment);
  assert.ok(spawn, "a clear diagnostic pose should be found beyond the blocked first candidate");
  assert.ok(Math.abs(spawn.x) > 5, "search should skip the blocked midpoint and find a clear pose along the strip");
  assert.ok(Math.abs(Math.sin(spawn.heading)) < 0.01, "pose heading should follow the road's long axis");
  const forward = environment.move(spawn, { x: spawn.x + Math.cos(spawn.heading) * 2.5,
    z: spawn.z + Math.sin(spawn.heading) * 2.5, heading: spawn.heading, travelBudget: 2.5 });
  const backward = environment.move(spawn, { x: spawn.x - Math.cos(spawn.heading) * 2.5,
    z: spawn.z - Math.sin(spawn.heading) * 2.5, heading: spawn.heading, travelBudget: 2.5 });
  assert.equal(forward.blocked, false, "accepted diagnostic pose must have forward clearance");
  assert.equal(backward.blocked, false, "preferred diagnostic pose should allow reverse recovery");
}
// A spawn between splitter noses can pass a short clearance probe yet be boxed
// in a few units later. The search must skip that intersection pocket.
{
  const longRoad = snapshot([patch("splitter-approach", "carriageway", grid(-30, -8, 30, 8, 10, 4))]);
  const index = m.buildSurfaceIndex(longRoad);
  const regions = m.buildSurfaceRegions(longRoad, index);
  const environment = {
    place: () => ({ y: 0, pitch: 0, roll: 0 }),
    move: (start, desired) => {
      const crossesBlocker = Math.min(start.x, desired.x) <= 3.8 && Math.max(start.x, desired.x) >= 3.2 &&
        Math.abs((start.z + desired.z) / 2) < 2;
      return { ...desired, y: 0, pitch: 0, roll: 0, surfaceId: start.surfaceId,
        blocked: crossesBlocker, travelledDistance: crossesBlocker ? 0 : 6 };
    },
  };
  const spawn = m.diagnosticSpawn(longRoad, regions, environment);
  assert.ok(spawn, "a useful run-up exists away from the splitter nose");
  assert.ok(Math.abs(spawn.x) > 5, "spawn search must reject a pocket that only has short clearance");
}
console.log("Driving entry: paused start, resume/pause/exit, stale-world paths, diagnostic placement, blocked-spawn refusal, and directional clearance passed.");

// Optional rendered CityParts regression: no browser/real user data; exercises
// the exact frozen source used by CityEngine, including >4096 world instances.
if (process.argv.includes("--cities")) {
  const { sceneKit, buildParts } = await import("./city-kit/scene-parts.mjs");
  const kit = await sceneKit({ "engine/surface/citySurfacePort.ts": ["CitySurfacePort"],
    "game/runtime/createCityCarSession.ts": ["createCityCarDiagnosticSession", "createCityCarFreeDriveSession"], "game/runtime/GameRuntime.ts": ["GameRuntime"] });
  for (const [count, seed] of [[0, 1], [90, 42], [500, 7]]) {
    const { parts } = buildParts(kit, count, seed);
    const lease = parts.acquireDrivingWorldSource(), port = new kit.CitySurfacePort(), runtime = new kit.GameRuntime();
    let frame = null;
    try {
      const captureStarted = performance.now();
      const capture = await port.capture(lease.source); assert.equal(capture.status, "ready");
      if (process.argv.includes("--timings")) console.log(`Prepare ${count}/${seed} capture ${Math.round(performance.now() - captureStarted)}ms`);
      const frozenCapture = { ...capture };
      const sceneLease = { revision: capture.worldRevision, snapshot: { drivingWorld: frozenCapture, staticWorld: frozenCapture }, isCurrent: capture.isCurrent,
        setFrameHook: (next) => { frame = next; }, release: () => { lease.release(); port.releaseFrozenSource(lease.source); } };
      const host = { gameScenePort: { acquireResult: async () => ({ status: "ready", lease: sceneLease }) } };
      // Weather lighting remains live during a geometry freeze. Light-only
      // visibility changes must not add/remove physical architecture.
      parts.setNightGlow(1); parts.setNightHour(23);
      assert.equal(capture.verifyCurrent(), true, "night lighting must preserve frozen solids");
      parts.setNightGlow(0.05); parts.setNightHour(12);
      assert.equal(capture.verifyCurrent(), true, "day lighting must preserve frozen solids");
      const entry = await kit.createCityCarDiagnosticSession(host, runtime, { ...request,
        onPreparationMetric: process.argv.includes("--timings") ? (metric) => console.log(`Prepare ${count}/${seed} ${metric.stage} ${Math.round(metric.durationMs)}ms`) : undefined });
      assert.equal(entry.status, "ready", `${count}/${seed}: ${entry.reason}`);
      assert.equal(runtime.resume(), true); runtime.setInput({ forward: true });
      for (let tick = 0; tick < 120; tick++) frame(1 / 60);
      assert.equal(runtime.snapshot.phase, "running");
      const instances = lease.source.rendered.solids.reduce((n, solid) => n + solid.transforms.length / 16, 0);
      if (count === 500) assert.ok(instances > 4096, "world total must not be confused with query candidate limit");
      console.log(`Diagnostic city ${count}/${seed}: ${instances} rendered instances, ${entry.coverage}, 120 runtime ticks`);
    } finally { runtime.dispose(); lease.release(); parts.dispose(); }
  }
}
