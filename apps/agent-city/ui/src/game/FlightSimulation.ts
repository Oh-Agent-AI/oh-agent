/**
 * FlightSimulation（§6.1/§6.2）：城市 XZ 平面（Y 向上）的固定步长纯运动更新。
 * 状态 = position + heading + speed + verticalSpeed + bank（倾斜仅视觉）；不做失速/升力仿真。
 * 参数由城市包围盒对角线 D 推导（版本化配置 flightParamsV1），禁止直接搬上游球面速度。
 * 本模块不依赖 three/DOM：同输入同输出，30/60/120 Hz 渲染帧率不影响轨迹（守卫脚本验证）。
 */
import type { FlightInputState } from "./types";
import { DetMath as Math } from "../engine/detMath";

/** 版本化首轮参数（§6.1）：以布局对角线 D 为尺度；试飞校准前不得静默改值。 */
export const PHYSICS_VERSION = 1;

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
  // 油门：W 加速 / S 减速；松开趋向巡航。
  const targetSpeed = input.throttleUp ? params.maxSpeed : input.throttleDown ? params.minSpeed : params.cruiseSpeed;
  const rate = targetSpeed < state.speed ? params.brake : params.accel;
  const speed = approach(state.speed, targetSpeed, rate, dt);

  // 转向：A 左 / D 右，指数平滑；机翼倾斜随当前转向比例（纯视觉）。
  // 符号：前向 = (cos h, 0, sin h)，追尾相机看向 +X 时屏幕右 = +Z，所以 heading 增大 = 向右转。
  // 曾写成 left - right，A 键反而把飞机带向屏幕右侧（试飞时才发现，数值回放只断言 |turnRate| 抓不到）。
  const turnInput = (input.turnRight ? 1 : 0) - (input.turnLeft ? 1 : 0);
  const turnTarget = turnInput * params.turnRate;
  const turnRate = smooth(state.turnRate, turnTarget, params.turnSmoothing, dt);
  const heading = state.heading + turnRate * dt;
  const bank = smooth(state.bank, (turnRate / params.turnRate) * params.bankMax, 6, dt);

  // 升降：↑ 爬升 / ↓ 下降（City 新增），松开衰减到 0。
  const climbInput = (input.pitchUp ? 1 : 0) - (input.pitchDown ? 1 : 0);
  const climbTarget = climbInput > 0 ? params.climbRate : climbInput < 0 ? -params.sinkRate : 0;
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
