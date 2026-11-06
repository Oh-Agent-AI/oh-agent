#!/usr/bin/env node
// CPU-only lifecycle acceptance: one host hook, frozen binding, no second rAF.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(new URL("../apps/agent-city/ui/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const load = (file) => {
  const code = buildSync({ entryPoints: [new URL(`../apps/agent-city/ui/src/game/${file}.ts`, import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "cjs" }).outputFiles[0].text;
  const mod = { exports: {} }; vm.runInNewContext(code, { module: mod, exports: mod.exports, console, AbortController }); return mod.exports;
};
const { GameRuntime } = load("runtime/GameRuntime");
const { CarAdapter } = load("runtime/CarAdapter");
const { DrivingKernel } = load("driving/DrivingKernel");
const { DrivingWorld } = load("DrivingWorld");
const { initialDrivingState, DRIVING_DT } = load("DrivingSimulation");
const empty = { forward: false, backward: false, left: false, right: false };
const pad = { id: "pad", layer: "ground", minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000, base: 0, slopeX: .1, slopeZ: .04, connections: [] };
function fixture() {
  const host = { current: true, hook: null, releases: 0, frames: [], moves: 0, invalidateInMove: false };
  const world = new DrivingWorld([pad], []);
  const kernel = new DrivingKernel({ move: (before, desired) => {
    host.moves++;
    const result = world.move(before, desired);
    if (host.invalidateInMove) host.current = false;
    return result;
  } }, { baseSnapshotHash: "surface-fixture", vehicleConfigHash: "car", kernelBuildId: "kernel", physicsVersion: 1, collisionVersion: 1, queryVersion: 1 });
  const spawn = { ...initialDrivingState(), pitch: Math.atan(.1), roll: Math.atan(.04) };
  const adapter = new CarAdapter({ revision: "world-1", kernel, isCurrent: () => host.current,
    validateSpawn: (pose) => world.move(pose, pose).blocked === false }, spawn, (frame) => host.frames.push(frame));
  const lease = { revision: "world-1", isCurrent: () => host.current,
    setFrameHook: (hook) => { host.hook = hook; }, release: () => { host.releases++; host.hook = null; } };
  return { host, adapter, lease, runtime: new GameRuntime() };
}
async function run(hz) {
  const f = fixture();
  assert.equal(await f.runtime.enter(f.lease, f.adapter), true);
  assert.equal(f.runtime.snapshot.phase, "paused");
  assert.equal(f.runtime.resume(), true);
  for (let i = 0; i < hz * 4; i++) {
    f.runtime.setInput({ ...empty, forward: true, right: i >= hz * 2 });
    f.host.hook(1 / hz);
  }
  assert.equal(f.host.moves, 240);
  const final = f.adapter.snapshot;
  f.runtime.exit(); assert.equal(f.host.releases, 1); assert.equal(f.host.hook, null);
  f.runtime.exit(); assert.equal(f.host.releases, 1);
  return final;
}
const baseline = await run(60);
for (const hz of [30, 120]) {
  const result = await run(hz);
  for (const key of ["x", "y", "z", "heading", "pitch", "roll", "speed", "distance"]) {
    assert.ok(Math.abs(result[key] - baseline[key]) < 1e-10, `${hz} Hz changed ${key}`);
  }
}
{
  const f = fixture(); await f.runtime.enter(f.lease, f.adapter); f.runtime.resume();
  f.runtime.setInput({ ...empty, forward: true }); f.host.hook(DRIVING_DT);
  const before = f.adapter.snapshot;
  // 2026-10-18 产品决定（赛车惯例，Ammo stepSimulation 同款）：长帧按 maxSteps 补跑后
  // 丢弃余量，不再暂停打断——车在这 0.5s 缺口里前进 5 步（maxSteps·dt），会话保持 running。
  f.host.hook(.5); assert.equal(f.runtime.snapshot.phase, "running");
  assert.ok(f.adapter.snapshot.x > before.x, "bounded catch-up advances the car");
  assert.ok(f.adapter.snapshot.x - before.x <= 5 * DRIVING_DT * f.adapter.snapshot.speed + 1e-9, "catch-up bounded by maxSteps");
  f.host.hook(DRIVING_DT);
  const oldHook = f.host.hook;
  f.host.current = false; oldHook(DRIVING_DT);
  assert.equal(f.runtime.snapshot.phase, "error"); assert.equal(f.runtime.snapshot.reason, "stale-game-world");
  assert.equal(f.host.releases, 1); assert.equal(f.host.hook, null);
  const replacement = fixture(); assert.equal(await f.runtime.enter(replacement.lease, replacement.adapter), true);
  oldHook(DRIVING_DT); assert.equal(replacement.host.moves, 0, "old callback cannot advance replacement");
  f.runtime.dispose(); assert.equal(replacement.host.releases, 1);
}
{
  const f = fixture(); await f.runtime.enter(f.lease, f.adapter); f.runtime.resume();
  const state = f.adapter.snapshot; const frames = f.host.frames.length;
  f.host.invalidateInMove = true; f.runtime.setInput({ ...empty, forward: true }); f.host.hook(DRIVING_DT);
  assert.equal(f.runtime.snapshot.phase, "error"); assert.equal(f.adapter.snapshot.x, state.x);
  assert.equal(f.host.frames.length, frames, "invalidated step is never presented");
}
{
  const f = fixture(); const original = f.adapter.prepare.bind(f.adapter); let unblock;
  f.adapter.prepare = async (signal) => { await new Promise((resolve) => { unblock = resolve; }); await original(signal); };
  const entering = f.runtime.enter(f.lease, f.adapter);
  f.runtime.exit(); assert.equal(f.host.releases, 1);
  const next = fixture(); await f.runtime.enter(next.lease, next.adapter);
  unblock(); assert.equal(await entering, false); assert.equal(f.host.releases, 1);
  assert.equal(f.runtime.snapshot.phase, "paused"); assert.ok(next.host.hook);
  f.runtime.dispose(); assert.equal(next.host.releases, 1);
}
{
  const f = fixture(); await f.runtime.enter(f.lease, f.adapter); f.runtime.resume();
  f.runtime.setInput({ ...empty, forward: true }); f.host.hook(DRIVING_DT);
  assert.equal(f.runtime.reset(), true); assert.equal(f.adapter.snapshot.x, 0);
  f.host.hook(DRIVING_DT); assert.equal(f.adapter.snapshot.speed, 0, "reset clears stale held keys");
  f.runtime.dispose(); assert.equal(f.runtime.snapshot.phase, "disposed");
  const next = fixture(); assert.equal(await f.runtime.enter(next.lease, next.adapter), false); assert.equal(next.host.releases, 1);
}
console.log("Car runtime: 30/60/120 Hz parity, long-frame time-drop (racing convention), stale-before/after-step, cancel/reenter, reset and idempotent cleanup passed");
{
  const runtime = new GameRuntime();
  for (let cycle = 0; cycle < 20; cycle++) {
    const f = fixture(); await runtime.enter(f.lease, f.adapter); runtime.resume();
    f.host.hook(DRIVING_DT); runtime.exit();
    assert.equal(f.host.releases, 1); assert.equal(f.host.hook, null);
  }
  runtime.dispose();
}
{
  // Kernel may normalize its returned heading at the branch cut. Presentation
  // follows the short arc and never mixes coordinates from different handles.
  let resultSurface = "pad";
  const spawn = { ...initialDrivingState(), heading: Math.PI - .01 };
  let frame;
  const kernel = new DrivingKernel({ move: (before, desired) => ({ ...desired, x: before.x, z: before.z,
    heading: -Math.PI + .01, y: 0, pitch: 0, roll: 0, surfaceId: resultSurface, blocked: false }) },
    { baseSnapshotHash: "fixture", vehicleConfigHash: "car", kernelBuildId: "kernel", physicsVersion: 1, collisionVersion: 1, queryVersion: 1 });
  const adapter = new CarAdapter({ revision: "fixture", kernel, isCurrent: () => true, validateSpawn: () => true }, spawn, (next) => { frame = next; });
  await adapter.prepare(new AbortController().signal); adapter.fixedStep(empty); adapter.present(.5);
  assert.ok(Math.abs(frame.state.heading - Math.PI) < 1e-12, "heading interpolation takes shortest arc");
  adapter.reset(); resultSurface = "upper"; adapter.fixedStep(empty); adapter.present(0);
  assert.equal(frame.state.surfaceId, "upper");
  assert.ok(Math.abs(Math.sin(frame.state.heading) - Math.sin(-Math.PI + .01)) < 1e-12, "different support handles snap to verified endpoint");
  adapter.dispose();
}
