#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { FixedStepClock, RuntimeDiagnostics, GameRuntime, CityEnvironment, weatherAt } = await loadCity({
  "game/runtime/FixedStepClock.ts": ["FixedStepClock"], "game/runtime/RuntimeDiagnostics.ts": ["RuntimeDiagnostics"],
  "game/runtime/GameRuntime.ts": ["GameRuntime"], "engine/environment/CityEnvironment.ts": ["CityEnvironment"],
  "engine/environment/WeatherState.ts": ["weatherAt"],
});
for (const [dt, expected] of [[NaN, "invalid-delta"], [-1, "invalid-delta"], [0.26, "frame-gap"], [0.1, "catch-up-budget"]]) {
  const clock = new FixedStepClock(), frame = clock.advance(dt, false, () => {});
  assert.equal(frame.cause, expected); assert.equal(frame.pauseRequired, true);
}
const paused = new FixedStepClock().advance(0.5, true, () => assert.fail("paused clock advanced"));
assert.equal(paused.pauseRequired, false); assert.equal(paused.cause, null);

// More frames than capacity and the time horizon cannot grow the record store.
{
  const diagnostics = new RuntimeDiagnostics(4, 100);
  for (let n = 0; n < 20; n++) diagnostics.record({ atMs: n, frameMs: n, tickCpuMs: n / 2,
    presentCpuMs: n / 4, steps: n % 6, limitCause: n === 19 ? "catch-up-budget" : null });
  const snapshot = diagnostics.snapshot(20);
  assert.equal(snapshot.samples, 4); assert.equal(snapshot.frameMs.p50, 17); assert.equal(snapshot.frameMs.p99, 19);
  assert.equal(snapshot.limits["catch-up-budget"], 1); assert.equal(diagnostics.snapshot(200).samples, 0);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.limits));
  diagnostics.record({ atMs: 201, frameMs: NaN, tickCpuMs: 0, presentCpuMs: 0, steps: 0, limitCause: null });
  assert.equal(diagnostics.snapshot(202).samples, 0);
}

// Instrument the actual runtime, not a duplicate simulation loop. Timing data
// contains no vehicle input/position/world identifiers.
{
  let time = 0, hook, steps = 0;
  const runtime = new GameRuntime({ now: () => time });
  const adapter = { revision: "w", isCurrent: () => true, prepare() {}, fixedStep() { time += 2; steps++; },
    present() { time += 1; }, reset() {}, settle() {}, dispose() {} };
  const lease = { revision: "w", isCurrent: () => true, setFrameHook: (frame) => { hook = frame; }, release() {} };
  runtime.beginPreparation(); runtime.recordPreparation({ stage: "static-solids", durationMs: 17 });
  runtime.recordPreparation({ stage: "arbitrary-world-id", durationMs: 30 });
  runtime.enterSync(lease, adapter);
  assert.equal(runtime.diagnostics.preparationMs["static-solids"], 17, "accepted entry retains its preparation costs");
  assert.equal(Object.keys(runtime.diagnostics.preparationMs).length, 1, "metric stage names are bounded and contain no world identifiers");
  assert.ok(Object.isFrozen(runtime.diagnostics.preparationMs));
  runtime.resume(); hook(1 / 30);
  assert.equal(steps, 2); assert.equal(runtime.diagnostics.tickCpuMs.p50, 4); assert.equal(runtime.diagnostics.presentCpuMs.p50, 1);
  hook(0.1); assert.equal(runtime.snapshot.phase, "running"); assert.equal(steps, 7, "overloaded frames stay bounded at five steps");
  assert.equal(runtime.diagnostics.limits["catch-up-budget"], 1);
  hook(.5); assert.equal(runtime.snapshot.phase, "running"); assert.equal(steps, 12);
  assert.equal(runtime.diagnostics.limits["frame-gap"], 1, "clamped frames retain their original limit diagnosis");
  hook(NaN); assert.equal(runtime.snapshot.reason, "long-frame");
  assert.equal(runtime.diagnostics.limits["invalid-delta"], 1);
  runtime.exit(); runtime.enterSync(lease, adapter);
  assert.equal(Object.keys(runtime.diagnostics.preparationMs).length, 0, "a different unmeasured run cannot inherit previous prepare timings");
  runtime.dispose();
}

// Explicit offsets make the same replay reproducible across host time zones.
{
  const time = Date.UTC(2026, 9, 18, 0, 0, 0);
  const east = new CityEnvironment({ utcOffsetMinutes: 480 }).sample(time);
  const west = new CityEnvironment({ utcOffsetMinutes: -420 }).sample(time);
  assert.equal(east.hour, 8); assert.equal(west.hour, 17);
  assert.equal(east.timeZone.policy, "fixed-offset"); assert.equal(east.timeZone.utcOffsetMinutes, 480);
  assert.deepEqual(east.weather, weatherAt(time, 480));
  assert.deepEqual(east, new CityEnvironment({ utcOffsetMinutes: 480 }).sample(time));
  assert.equal(new CityEnvironment({ utcOffsetMinutes: 480 }).sample(time, 18).weather.kind, "clear");
  assert.equal(new CityEnvironment().sample(time).timeZone.policy, "host-local");
  assert.ok(Object.isFrozen(east.timeZone));
  assert.throws(() => new CityEnvironment({ utcOffsetMinutes: 1000 }), /invalid-environment-offset/);
}
console.log("Runtime diagnostics: distinct clock limits, bounded private aggregates, real runtime timings and explicit replay time-zone facts passed.");
