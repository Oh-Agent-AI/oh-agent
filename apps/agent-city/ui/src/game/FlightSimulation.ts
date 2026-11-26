/**
 * FlightSimulation（§6.1/§6.2）：城市 XZ 平面（Y 向上）的固定步长纯运动更新。
 * 状态 = position + heading + speed + verticalSpeed + bank（倾斜仅视觉）；不做失速/升力仿真。
 * 参数由城市包围盒对角线 D 推导（版本化配置 flightParamsV1），禁止直接搬上游球面速度。
 * 2026-11-15 泛化：VehicleProfileV1（质量/推力/翼面积/maxSpeed/扑动参数/包围盒/相机）
 * 驱动 `vehicleFlightParams`，fixed-wing 与 flapping 走不同气动分支；无 profile 时
 * 保持既有 flightParamsFor(diagonal) 行为逐位不变。
 * 本模块不依赖 three/DOM：同输入同输出，30/60/120 Hz 渲染帧率不影响轨迹（守卫脚本验证）。
 */
import type { VehicleFlightModelV1, VehicleProfileV1 } from "@oh-agent/city-sdk";
import { VEHICLE_PERFORMANCE_DERIVATION_V1 } from "@oh-agent/city-sdk";
import type { FlightInputState } from "./types";
import { DetMath as Math } from "../engine/detMath";
import { METERS_PER_UNIT } from "../engine/worldScale";

/** 版本化首轮参数（§6.1）：以布局对角线 D 为尺度；试飞校准前不得静默改值。 */
export const PHYSICS_VERSION = 1;

/** VehicleProfileV1 驱动路线/成绩的独立物理代际（= 2）：与 legacy PHYSICS_VERSION(1)
 * 分开，让 profile 课程身份不会和 legacy 课程身份碰撞（courseId 含 physicsVersion，
 * 另有 `:vehicle=<id>` 后缀区分不同 preset）。 */
export const VEHICLE_PHYSICS_VERSION = 2;

export type FlightParams = {
  /** 巡航速度（单位/秒）≈ D/35。 */
  cruiseSpeed: number;
  minSpeed: number;
  maxSpeed: number;
  /** 加速度（单位/秒²）：巡航→最大约 1.5 秒。 */
  accel: number;
  brake: number;
  /** 最大转向（rad/s）与指数平滑率（1/s）。 */
  turnRate: number;
  turnSmoothing: number;
  /** 最大升降速度（单位/秒）与平滑率。 */
  climbRate: number;
  sinkRate: number;
  climbSmoothing: number;
  /** 机翼倾斜上限（rad，视觉）。 */
  bankMax: number;
  /** 飞机包围球半径（碰撞用）。 */
  planeRadius: number;
  /** ── 以下为 VehicleProfileV1 驱动字段（legacy 路径缺省 = 既有行为）── */
  /** 气动分支：缺省视为 legacy 固定翼参数族。 */
  flightModel?: VehicleFlightModelV1;
  /** 扑动频率（Hz）/幅度（rad）：仅 flapping > 0；来自 preset physics。 */
  flapFrequency?: number;
  flapAmplitude?: number;
  /** 追尾距离/高度（世界单位）与基础 FOV（度）：来自 preset camera；缺省沿用 planeRadius 倍数公式。 */
  followDistance?: number;
  heightOffset?: number;
  fovDeg?: number;
};

export function flightParamsFor(diagonal: number): FlightParams {
  const cruise = Math.max(6, diagonal / 35);
  return {
    cruiseSpeed: cruise,
    minSpeed: cruise * 0.4,
    maxSpeed: cruise * 1.8,
    accel: (cruise * 1.8 - cruise) / 1.5,
    brake: cruise * 1.4,
    turnRate: 0.9,
    turnSmoothing: 8,
    climbRate: cruise * 0.55,
    sinkRate: cruise * 0.45,
    climbSmoothing: 6,
    bankMax: 25 * Math.PI / 180,
    planeRadius: Math.max(2.2, Math.min(5, diagonal * 0.004)),
  };
}

/**
 * VehicleProfileV1 → FlightParams（单一物理参数化点）。
 * 质量与推力决定加/减速（推重比 × 推进效率，米制 → 世界单位），maxSpeed 决定速度带，
 * 翼载荷通过 profile 校验保证物理可行后由 climb/sink/转向显式给出；包围盒半尺寸决定
 * 碰撞球半径（= 程序化占位模型的缩放），相机 preset 决定追尾距离/高度/FOV。
 * flapping 附加扑动参数；fixed-wing/vtol 不携带扑动键（profile 校验的 exact-keys）。
 */
export function vehicleFlightParams(profile: VehicleProfileV1): FlightParams {
  const physics = profile.physics;
  const unit = (meters: number): number => meters / METERS_PER_UNIT;
  const maxSpeed = unit(physics.maxSpeedMps);
  const thrustAccel = unit(physics.thrustN / physics.massKg);
  const flapping = profile.flightModel === "flapping";
  return {
    // 巡航分频单源于 SDK 的 VEHICLE_PERFORMANCE_DERIVATION_V1（=1.8）：Creator
    // 预览的 estimatedPerformance 与本引擎共用同一推导，禁止两侧各自调参。
    cruiseSpeed: Math.max(6, maxSpeed / VEHICLE_PERFORMANCE_DERIVATION_V1.cruiseSpeedDivisor),
    minSpeed: maxSpeed * 0.22,
    maxSpeed,
    accel: thrustAccel * 0.72,
    brake: thrustAccel * 1.9,
    turnRate: physics.turnRateRps,
    turnSmoothing: 8,
    climbRate: unit(physics.climbRateMps),
    sinkRate: unit(physics.sinkRateMps),
    climbSmoothing: 6,
    bankMax: 25 * Math.PI / 180,
    planeRadius: Math.max(1.2, unit(Math.max(profile.bounds.halfLengthM, profile.bounds.halfWidthM, profile.bounds.halfHeightM))),
    flightModel: profile.flightModel,
    flapFrequency: flapping ? physics.flapFrequencyHz : 0,
    flapAmplitude: flapping ? physics.flapAmplitudeRad : 0,
    followDistance: unit(profile.camera.followDistanceM),
    heightOffset: unit(profile.camera.heightOffsetM),
    fovDeg: profile.camera.fovDeg,
  };
}

export type FlightSimState = {
  x: number;
  y: number;
  z: number;
  /** 航向（rad）：前向 = (cos heading, 0, sin heading)。 */
  heading: number;
  speed: number;
  /** 当前平滑后的转向速率（rad/s）：持久状态，供 HUD 与倾斜共用。 */
  turnRate: number;
  verticalSpeed: number;
  /** 视觉机翼倾斜（rad，左倾为正）。 */
  bank: number;
  /** 模拟时钟（秒）：物理与任务共用（§6.2）。 */
  simTime: number;
};

export function initialSimState(spawn: { x: number; y: number; z: number; heading: number }, params: FlightParams): FlightSimState {
  return { x: spawn.x, y: spawn.y, z: spawn.z, heading: spawn.heading, speed: params.cruiseSpeed, turnRate: 0, verticalSpeed: 0, bank: 0, simTime: 0 };
}

const approach = (current: number, target: number, ratePerSecond: number, dt: number) => {
  const delta = target - current;
  const step = ratePerSecond * dt;
  return current + Math.max(-step, Math.min(step, delta));
};

const smooth = (current: number, target: number, smoothing: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-smoothing * dt));

/** 单个固定步长（dt 秒，调用方保证固定；渲染层插值不进本函数）。 */
export function stepFlight(state: FlightSimState, input: FlightInputState, dt: number, params: FlightParams): FlightSimState {
  // 扑翼气动分支（仅 flapping）：推力随扑动相位确定性调制。频率×幅度来自
  // VehicleProfileV1 preset，相位由固定步长的 simTime 决定——无随机性、逐 tick 可复算；
  // fixed-wing/vtol 走恒定推力分支（与 legacy 行为一致）。
  const flapThrustFactor = params.flightModel === "flapping"
    ? 1 + (params.flapAmplitude ?? 0) * 0.6 * Math.sin(state.simTime * (params.flapFrequency ?? 0) * 6.283185307179586)
    : 1;
  // 油门：W 加速 / S 减速；松开趋向巡航。扑翼调制只作用于推力（加速）路径；
  // 减速是阻力主导，不随扑动相位波动。
  const targetSpeed = input.throttleUp ? params.maxSpeed : input.throttleDown ? params.minSpeed : params.cruiseSpeed;
  const rate = targetSpeed < state.speed ? params.brake : params.accel * flapThrustFactor;
  const speed = approach(state.speed, targetSpeed, rate, dt);

  // 转向：A 左 / D 右，指数平滑；机翼倾斜随当前转向比例（纯视觉）。
  // 符号：前向 = (cos h, 0, sin h)，追尾相机看向 +X 时屏幕右 = +Z，所以 heading 增大 = 向右转。
  // 曾写成 left - right，A 键反而把飞机带向屏幕右侧（试飞时才发现，数值回放只断言 |turnRate| 抓不到）。
  const turnInput = (input.turnRight ? 1 : 0) - (input.turnLeft ? 1 : 0);
  const turnTarget = turnInput * params.turnRate;
  const turnRate = smooth(state.turnRate, turnTarget, params.turnSmoothing, dt);
  const heading = state.heading + turnRate * dt;
  const bank = smooth(state.bank, (turnRate / params.turnRate) * params.bankMax, 6, dt);

  // 升降：↑ 爬升 / ↓ 下降（City 新增），松开衰减到 0。扑翼的爬升效率随扑动相位
  // 同步起伏（上挥损失升力、下扑收获升力），同样由 preset 参数驱动。
  const climbInput = (input.pitchUp ? 1 : 0) - (input.pitchDown ? 1 : 0);
  const climbEfficiency = params.flightModel === "flapping" ? 0.55 + 0.45 * flapThrustFactor : 1;
  const climbTarget = climbInput > 0 ? params.climbRate * climbEfficiency : climbInput < 0 ? -params.sinkRate : 0;
  const verticalSpeed = smooth(state.verticalSpeed, climbTarget, params.climbSmoothing, dt);

  const next: FlightSimState = {
    x: state.x + Math.cos(heading) * speed * dt,
    y: state.y + verticalSpeed * dt,
    z: state.z + Math.sin(heading) * speed * dt,
    heading,
    speed,
    turnRate,
    verticalSpeed,
    bank,
    simTime: state.simTime + dt,
  };
  // NaN 防护：模拟状态永不携带非有限值——污染输入的每个字段都被重置（守卫：无 NaN 越界）。
  if (![next.x, next.y, next.z, next.heading, next.speed, next.turnRate, next.verticalSpeed, next.bank, next.simTime].every(Number.isFinite)) {
    const safe = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
    return {
      x: safe(state.x, 0), y: safe(state.y, 50), z: safe(state.z, 0),
      heading: safe(state.heading, 0), speed: safe(state.speed, params.cruiseSpeed),
      turnRate: 0, verticalSpeed: 0, bank: 0, simTime: safe(state.simTime, 0),
    };
  }
  return next;
}

/** 渲染插值（§6.2）：按渲染帧在两个物理状态间插值；相机平滑用同一系数族。 */
export function lerpSim(from: FlightSimState, to: FlightSimState, alpha: number): FlightSimState {
  const t = Math.max(0, Math.min(1, alpha));
  let headingDelta = to.heading - from.heading;
  if (headingDelta > Math.PI) headingDelta -= Math.PI * 2;
  if (headingDelta < -Math.PI) headingDelta += Math.PI * 2;
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t,
    heading: from.heading + headingDelta * t,
    speed: from.speed + (to.speed - from.speed) * t,
    turnRate: from.turnRate + (to.turnRate - from.turnRate) * t,
    verticalSpeed: from.verticalSpeed + (to.verticalSpeed - from.verticalSpeed) * t,
    bank: from.bank + (to.bank - from.bank) * t,
    simTime: from.simTime + (to.simTime - from.simTime) * t,
  };
}
