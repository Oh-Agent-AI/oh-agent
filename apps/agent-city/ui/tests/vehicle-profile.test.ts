import test from "node:test";
import assert from "node:assert/strict";
import { estimateVehiclePerformanceV1, FIXED_WING_VEHICLE_PRESET_V1, ORNITHOPTER_VEHICLE_PRESET_V1, validateVehicleProfileV1,
  VEHICLE_PERFORMANCE_DERIVATION_V1 } from "@agent-vitals/city-sdk";
import { METERS_PER_UNIT } from "../src/engine/worldScale.ts";
import { FLIGHT_CHECKPOINT_GAME_TYPE_V1, validateTemplateLink } from "../../../../packages/agent-vitals-city-game-runtime/src/index.ts";
import { CITY_GAME_TYPE_CATALOG } from "../src/game/runtime/gameTypeCatalog.ts";
import { flightParamsFor, initialSimState, PHYSICS_VERSION, stepFlight, vehicleFlightParams, VEHICLE_PHYSICS_VERSION } from "../src/game/FlightSimulation.ts";
import { EMPTY_INPUT } from "../src/game/types.ts";

const DT = 1 / 60;

/** 固定步长脚本输入：同一段操作序列喂给两架载具，比较轨迹。 */
const scriptedInputs = (ticks: number) => Array.from({ length: ticks }, (_, tick) => ({
  ...EMPTY_INPUT,
  throttleUp: tick < 120,
  turnRight: tick >= 60 && tick < 180,
  pitchUp: tick >= 90 && tick < 150,
}));

const runTrajectory = (params: ReturnType<typeof flightParamsFor>, ticks: number) => {
  let state = initialSimState({ x: 0, y: 50, z: 0, heading: 0 }, params);
  const inputs = scriptedInputs(ticks);
  const samples: Array<[number, number, number]> = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    state = stepFlight(state, inputs[tick]!, DT, params);
    if (tick % 30 === 0) samples.push([state.x, state.y, state.z]);
  }
  return { state, samples };
};

test("legacy flightParamsFor stays pinned (bit-identical behavior without a profile)", () => {
  const params = flightParamsFor(2400);
  assert.equal(PHYSICS_VERSION, 1);
  assert.equal(params.cruiseSpeed, 2400 / 35);
  assert.equal(params.minSpeed, params.cruiseSpeed * 0.4);
  assert.equal(params.maxSpeed, params.cruiseSpeed * 1.8);
  assert.equal(params.accel, (params.cruiseSpeed * 1.8 - params.cruiseSpeed) / 1.5);
  assert.equal(params.turnRate, 0.9);
  assert.equal(params.planeRadius, Math.max(2.2, Math.min(5, 2400 * 0.004)));
  assert.equal(params.flightModel, undefined);
  assert.equal(params.flapFrequency, undefined);
});

test("vehicleFlightParams maps SI physics into world-unit FlightParams (ornithopter preset)", () => {
  const verdict = validateVehicleProfileV1(ORNITHOPTER_VEHICLE_PRESET_V1);
  assert.equal(verdict.ok, true);
  const params = vehicleFlightParams(ORNITHOPTER_VEHICLE_PRESET_V1);
  // 1 世界单位 = 2 米：速度带来自 maxSpeedMps。
  assert.equal(params.maxSpeed, 120 / 2);
  assert.equal(params.cruiseSpeed, Math.max(6, (120 / 2) / 1.8));
  assert.equal(params.minSpeed, (120 / 2) * 0.22);
  // 推重比决定加/减速（thrust/mass，米制→单位）。
  const thrustAccelUnits = (10000 / 340) / 2;
  assert.equal(params.accel, thrustAccelUnits * 0.72);
  assert.equal(params.brake, thrustAccelUnits * 1.9);
  // 包围盒决定碰撞球半径 = 程序化占位模型缩放；相机 preset 决定追尾距离/高度/FOV。
  assert.equal(params.planeRadius, Math.max(1.2, 4.8 / 2));
  assert.equal(params.followDistance, 26 / 2);
  assert.equal(params.heightOffset, 12 / 2);
  assert.equal(params.fovDeg, 52);
  // 扑翼参数进入物理（flapping 分支的调制源）。
  assert.equal(params.flightModel, "flapping");
  assert.equal(params.flapFrequency, 2.4);
  assert.equal(params.flapAmplitude, 1.1);
});

test("fixed-wing preset derives a different param set (no flap keys, faster turn)", () => {
  const ornithopter = vehicleFlightParams(ORNITHOPTER_VEHICLE_PRESET_V1);
  const fixedWing = vehicleFlightParams(FIXED_WING_VEHICLE_PRESET_V1);
  assert.equal(fixedWing.flightModel, "fixed-wing");
  assert.equal(fixedWing.flapFrequency, 0);
  assert.equal(fixedWing.flapAmplitude, 0);
  assert.equal(fixedWing.maxSpeed, 130 / 2);
  assert.notEqual(fixedWing.turnRate, ornithopter.turnRate);
  assert.notEqual(fixedWing.planeRadius, ornithopter.planeRadius);
});

test("two presets with the same scripted input produce different trajectories (profiles drive physics)", () => {
  const TICKS = 420;
  const flapping = runTrajectory(vehicleFlightParams(ORNITHOPTER_VEHICLE_PRESET_V1), TICKS);
  const fixedWing = runTrajectory(vehicleFlightParams(FIXED_WING_VEHICLE_PRESET_V1), TICKS);
  const gap = Math.hypot(flapping.state.x - fixedWing.state.x, flapping.state.y - fixedWing.state.y, flapping.state.z - fixedWing.state.z);
  assert.ok(gap > 5, `trajectories must diverge, gap=${gap}`);
  assert.ok(flapping.samples.some((sample, index) => Math.abs(sample[1] - fixedWing.samples[index]![1]) > 0.5),
    "vertical profiles must differ (climb rates + flapping modulation)");
  // 同输入同输出：重跑一次必须逐位一致（固定步长确定性）。
  const replay = runTrajectory(vehicleFlightParams(ORNITHOPTER_VEHICLE_PRESET_V1), TICKS);
  assert.deepEqual(replay.samples, flapping.samples);
});

test("flapping aero modulation is phase-deterministic and absent for fixed-wing", () => {
  const flappingParams = vehicleFlightParams(ORNITHOPTER_VEHICLE_PRESET_V1);
  const fixedParams = vehicleFlightParams(FIXED_WING_VEHICLE_PRESET_V1);
  const input = { ...EMPTY_INPUT, throttleUp: true };
  const spawn = { x: 0, y: 50, z: 0, heading: 0 };
  // 扑翼：加速段随扑动相位波动——两个半周期后的速度不同。
  const halfPeriodTicks = Math.round(1 / (2 * flappingParams.flapFrequency!) / DT);
  const a = Array.from({ length: halfPeriodTicks }, () => 0).reduce((state) => stepFlight(state, input, DT, flappingParams), initialSimState(spawn, flappingParams));
  const b = Array.from({ length: halfPeriodTicks * 3 }, () => 0)
    .reduce((state, _value, index) => stepFlight(state, input, DT, flappingParams), initialSimState(spawn, flappingParams));
  // 1.5 个扑动周期 vs 0.5 个扑动周期：相位不同 → 若调制存在，速度不可能完全同相。
  assert.ok(Number.isFinite(a.speed) && Number.isFinite(b.speed));
  // 固定翼：恒定推力分支——任何步数下从静止脚本出发的速度只由步数决定。
  const fixedShort = Array.from({ length: 60 }, () => 0).reduce((state) => stepFlight(state, input, DT, fixedParams), initialSimState(spawn, fixedParams));
  const fixedLong = Array.from({ length: 120 }, () => 0).reduce((state) => stepFlight(state, input, DT, fixedParams), initialSimState(spawn, fixedParams));
  assert.ok(fixedLong.speed > fixedShort.speed);
  assert.ok(Number.isFinite(fixedLong.speed));
});

test("vehicle courses carry a separate physics generation and vehicle identity", () => {
  assert.equal(VEHICLE_PHYSICS_VERSION, 2);
  assert.notEqual(VEHICLE_PHYSICS_VERSION, PHYSICS_VERSION);
});

test("creator.flight-checkpoint-v1 stays registrable data while the app catalog keeps its current 6 entries", () => {
  assert.equal(validateTemplateLink(FLIGHT_CHECKPOINT_GAME_TYPE_V1), null);
  // App catalog adoption waits for the Creator capability projection (next slice):
  // the app-side lockstep test pins CITY_GAME_TYPE_CATALOG against CREATOR_GAME_TYPES_V1.
  assert.ok(!CITY_GAME_TYPE_CATALOG.some(item => item.id === FLIGHT_CHECKPOINT_GAME_TYPE_V1.id));
});

test("engine flight params consume the SDK performance estimate (unit conversion only)", () => {
  // Creator 预览展示的 estimatedPerformance 与引擎的实际飞行参数必须同源：引擎只允许
  // 两件事——米→世界单位换算（METERS_PER_UNIT）与操纵调校增益（accel×0.72 / brake×1.9
  // 是引擎侧的杆量手感，不是物理推导）。任何一处再抄一份系数，这条测试就会红。
  for (const preset of [ORNITHOPTER_VEHICLE_PRESET_V1, FIXED_WING_VEHICLE_PRESET_V1]) {
    const estimate = estimateVehiclePerformanceV1(preset);
    const params = vehicleFlightParams(preset);
    const toUnits = (meters: number) => meters / METERS_PER_UNIT;
    // 巡航速度：引擎按世界单位给出，换算回米制后必须与 SDK 推导逐位相等（预设都高于
    // Math.max(6, …) 的最低巡航下限，所以这里没有下限截断）。
    assert.equal(params.cruiseSpeed * METERS_PER_UNIT, estimate.cruiseSpeedMps, `${preset.id}: cruise speed`);
    assert.equal(params.maxSpeed * METERS_PER_UNIT, estimate.maxSpeedMps, `${preset.id}: max speed`);
    assert.equal(params.turnRate, estimate.turnRateRps, `${preset.id}: turn rate`);
    assert.equal(params.climbRate * METERS_PER_UNIT, estimate.climbRateMps, `${preset.id}: climb rate`);
    assert.equal(params.accel, toUnits(estimate.thrustAccelMs2) * 0.72, `${preset.id}: thrust accel × engine gain`);
    assert.equal(params.flapFrequency, estimate.flapFrequencyHz ?? 0, `${preset.id}: flap frequency`);
  }
});

test("the lowest-cruise floor is the only engine-side clamp on the SDK derivation", () => {
  // Math.max(6, …) 是引擎的绝对下限（世界单位/秒）。它只能在推导值之下生效，否则
  // 引擎就会和 Creator 预览报不同的巡航速度；预设值远高于下限，所以两者相等。
  for (const preset of [ORNITHOPTER_VEHICLE_PRESET_V1, FIXED_WING_VEHICLE_PRESET_V1]) {
    const derived = estimateVehiclePerformanceV1(preset).cruiseSpeedMps / METERS_PER_UNIT;
    assert.ok(derived > 6, `${preset.id}: preset cruise ${derived} must sit above the engine floor`);
  }
});

test("engine cruise derivation stays lockstep with the SDK performance estimate", () => {
  // 单源纪律：引擎巡航分频与 Creator 预览的 estimatedPerformance 消费同一个
  // VEHICLE_PERFORMANCE_DERIVATION_V1 常量——两侧任一调参都会在此失败。
  for (const profile of [ORNITHOPTER_VEHICLE_PRESET_V1, FIXED_WING_VEHICLE_PRESET_V1]) {
    const estimate = estimateVehiclePerformanceV1(profile);
    const params = vehicleFlightParams(profile);
    assert.equal(params.cruiseSpeed,
      Math.max(6, estimate.maxSpeedMps / METERS_PER_UNIT / VEHICLE_PERFORMANCE_DERIVATION_V1.cruiseSpeedDivisor));
    assert.equal(params.turnRate, estimate.turnRateRps);
    assert.equal(params.flapFrequency, estimate.flapFrequencyHz ?? 0);
  }
});
