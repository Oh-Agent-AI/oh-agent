#!/usr/bin/env node
// Synthetic driving spike: fixed clock, gear transitions, swept collision, layer/support gates.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(new URL("../apps/agent-city/ui/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const load = (file) => {
  const code = buildSync({ entryPoints: [new URL(`../apps/agent-city/ui/src/game/${file}.ts`, import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "cjs" }).outputFiles[0].text;
  const mod = { exports: {} }; vm.runInNewContext(code, { module: mod, exports: mod.exports, console }); return mod.exports;
};
const { DrivingWorld } = load("DrivingWorld");
const { initialDrivingState, stepDriving, DRIVING_DT, EMPTY_DRIVING_INPUT, DRIVING_PARAMS } = load("DrivingSimulation");
const pad = { id: "pad", layer: "ground", minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000, base: 0, slopeX: 0, slopeZ: 0, connections: [] };
const world = new DrivingWorld([pad], []);
const input = (extra) => ({ ...EMPTY_DRIVING_INPUT, ...extra });
function run(hz) {
  let state = initialDrivingState(); let accumulator = 0; let steps = 0;
  for (let frame = 0; frame < hz * 6; frame++) {
    accumulator += 1 / hz;
    while (accumulator >= DRIVING_DT - 1e-12) {
      state = stepDriving(state, input({ forward: true, right: steps > 120 }), world);
      accumulator -= DRIVING_DT; steps++;
    }
  }
  return state;
}
const baseline = run(60);
for (const hz of [30, 120]) {
  const candidate = run(hz);
  for (const key of ["x", "z", "heading", "speed", "distance", "steering"]) assert.ok(Math.abs(candidate[key] - baseline[key]) < 1e-9, `${hz}Hz changed ${key}`);
}
let state = initialDrivingState();
for (let i = 0; i < 180; i++) state = stepDriving(state, input({ forward: true }), world);
assert.equal(state.speed, DRIVING_PARAMS.maxForward);
let reversed = false; let hitZero = false;
for (let i = 0; i < 220; i++) {
  state = stepDriving(state, input({ backward: true }), world);
  if (Math.abs(state.speed) < DRIVING_PARAMS.zeroSpeed) hitZero = true;
  if (state.speed < 0) reversed = true;
  assert.ok(state.speed >= -DRIVING_PARAMS.maxReverse);
}
assert.ok(hitZero && reversed, "brake through rest before reversing");
const stopped = stepDriving(initialDrivingState(), input({ forward: true, backward: true, left: true, right: true }), world);
assert.equal(stopped.speed, 0); assert.equal(stopped.steering, 0);
const obstacle = { id: "thin-wall", minX: 5, maxX: 5.01, minZ: -10, maxZ: 10, layer: "ground" };
const solid = new DrivingWorld([pad], [obstacle]);
assert.equal(solid.move(initialDrivingState(), { x: 20, z: 0, heading: 0 }).reason, "obstacle", "cannot tunnel through thin obstacles");
assert.equal(solid.move(initialDrivingState(3.4), { x: 3.5, z: 0, heading: 0 }).blocked, false);
assert.equal(solid.move(initialDrivingState(3.5), { x: 3.7, z: 0, heading: 0 }).blocked, true, "full body hits before center reaches wall");
assert.equal(solid.move(initialDrivingState(3.5), { x: 3, z: 0, heading: 0 }).blocked, false, "can reverse away");
const elevated = { ...pad, id: "bridge", layer: "upper", base: 5 };
const layers = new DrivingWorld([pad, elevated], [{ ...obstacle, layer: "upper" }]);
assert.equal(layers.move(initialDrivingState(), { x: 10, z: 0, heading: 0 }).blocked, false, "ground ignores upper-layer obstruction");
assert.equal(layers.sampleSupport(0, 0, "pad", 0).id, "pad");
assert.equal(layers.sampleSupport(0, 0, "missing", 0), null);
const slope = new DrivingWorld([{ ...pad, slopeX: 0.1 }], []);
const inclined = slope.move(initialDrivingState(), { x: 2, z: 0, heading: 0 });
assert.equal(inclined.blocked, false); assert.ok(Math.abs(inclined.y - 0.2) < 1e-9);
assert.ok(Math.abs(inclined.pitch - Math.atan(0.1)) < 1e-9);
const narrow = new DrivingWorld([{ ...pad, minZ: -0.6, maxZ: 0.6 }], []);
assert.equal(narrow.move(initialDrivingState(), { x: 0.1, z: 0, heading: 0 }).reason, "no-support");
const split = new DrivingWorld([{ ...pad, maxX: 4, connections: ["other"] }, { ...pad, id: "other", minX: 6, connections: ["pad"] }], []);
assert.equal(split.move(initialDrivingState(), { x: 12, z: 0, heading: 0 }).reason, "no-support", "cannot jump an unsupported gap");
assert.equal(world.move(initialDrivingState(), { x: NaN, z: 0, heading: 0 }).reason, "invalid-motion");
// Snapshot is isolated from source mutations.
pad.maxX = -1; obstacle.minX = -100;
assert.equal(world.move(initialDrivingState(), { x: 2, z: 0, heading: 0 }).blocked, false);
assert.equal(solid.move(initialDrivingState(), { x: 20, z: 0, heading: 0 }).reason, "obstacle");
let endurance = initialDrivingState();
for (let i = 0; i < 18000; i++) {
  endurance = stepDriving(endurance, input({ forward: i % 900 < 650, backward: i % 900 >= 650, right: i % 1200 < 600, left: i % 1200 >= 600 }), world);
  for (const key of ["x", "y", "z", "heading", "speed", "distance", "pitch", "roll"]) assert.ok(Number.isFinite(endurance[key]), `endurance ${key}`);
}
console.log("Driving spike verified: frame parity, controls/gears, swept obstacle/body, ramp, layer isolation, unsupported width/gap, immutable snapshots.");
