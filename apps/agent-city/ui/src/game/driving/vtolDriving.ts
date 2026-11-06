/** VTOL 推进器扩展（Tesla Roadster 式短暂飞行，2026-10-15 演示的冷气推进器设定）。
 * 地面段完全复用 DRIVING_PARAMS 物理（stepDriving 原样调用），推进器只叠加垂直通道；
 * 空中段是独立的简化运动学（无轮胎/无支撑），由 VtolDrivingEnvironment 负责严格 3D 扫掠、
 * 悬停地板与天花板。助推剂（boost）对应「冷气推进剂有限」的物理事实：空中消耗、接地恢复。
 * 纯函数、无 THREE/DOM；与 DRIVING_DT 同步长，确定性同汽车物理。
 * 速度界刻意对齐地面极速（airMaxForward = maxForward）：内核每步守卫
 * （unexpected-position-jump / surface-distance-jump）无需任何改动即同时约束两种体制。
 */
import { DRIVING_DT, DRIVING_PARAMS, initialDrivingState, stepDriving,
  type DrivingEnvironment, type DrivingInputState, type DrivingMotion, type DrivingMoveResult, type DrivingState } from "../DrivingSimulation";

export const VTOL_PHYSICS_VERSION = 2;
export const VTOL_PARAMS = Object.freeze({
  liftAccel: 6,           // u/s² 喷升
  liftMax: 8,             // u/s 垂直速度上限（≤ maxForward：共享内核每步界）
  gravity: 5,             // u/s² 松推进器下坠
  liftoffMargin: 0.25,    // 累计高出支撑面此值即转空中体制
  landingSinkMax: 5,      // 接地允许的最大下沉速度（环境在落点缓冲）
  boostCapacity: 4,       // 满助推可连续喷 4 s
  boostDrain: 1,          // 推进时每秒消耗的容量比例
  boostRegen: 0.5,        // 接地低速时每秒恢复的容量比例
  boostRegenMaxSpeed: 2,  // 低于此速度才恢复
  minBoostToLift: 0.15,   // 低于此余量不可再起升（防抖动）
  airMaxForward: DRIVING_PARAMS.maxForward, // 与地面极速一致
  airAccel: 3.5, airReverseMax: 3, airDrag: 0.8,
  airMaxSteering: 0.30, airSteeringResponse: 3, airSteeringReturn: 1.6,
  zeroSpeed: DRIVING_PARAMS.zeroSpeed,
});

/** 推进器输入是加法式扩展：地面路径（stepDriving/审计）只读四个布尔位，多余字段被忽略。 */
export type VtolInputState = DrivingInputState & Readonly<{ thruster?: boolean }>;
/** 空中期望运动：比地面多一个目标高度 y。 */
export type VtolAirMotion = DrivingMotion & Readonly<{ y: number }>;

export type VtolLiftResult = Readonly<{ y: number; trimmed: boolean }>;
export type VtolAirResult = DrivingMoveResult & Readonly<{ landed: boolean; floor: boolean }>;

/** VTOL 世界 = 地面 DrivingEnvironment + 垂直/空中专用查询（由 VtolDrivingEnvironment 实现）。 */
export type VtolWorld = DrivingEnvironment & {
  /** 垂直离地：目标 y 经上方实体/天花板裁剪后的实际可达高度。 */
  lift(previous: DrivingState, targetY: number): VtolLiftResult;
  /** 空中移动：严格 3D 扫掠 + 悬停地板 + 天花板；落点支撑有效时 landed。 */
  moveAir(previous: DrivingState, desired: VtolAirMotion): VtolAirResult;
  /** 支撑面高度探测（落地/地板判定；无支撑如水面/屋顶上方返回 null）。 */
  supportHeight(x: number, z: number, regionId: string): number | null;
};

export type VtolDrivingState = DrivingState & Readonly<{ airborne: boolean; verticalSpeed: number; boost: number }>;

export function initialVtolState(x: number, z: number, heading: number, regionId: string): VtolDrivingState {
  return { ...initialDrivingState(x, z, heading, regionId), airborne: false, verticalSpeed: 0, boost: 1 };
}

export function stepVtolDriving(previous: VtolDrivingState, input: VtolInputState, world: VtolWorld): VtolDrivingState {
  const p = VTOL_PARAMS;
  // 出生源可能不带 VTOL 字段（诊断出生只构造 DrivingState）：入口一次性治愈，
  // undefined 参与算术会变成 NaN 并永久污染（用户实测 HUD「Boost NaN」的根因）。
  previous = {
    ...previous,
    airborne: previous.airborne === true,
    verticalSpeed: Number.isFinite(previous.verticalSpeed) ? previous.verticalSpeed : 0,
    boost: Number.isFinite(previous.boost) ? previous.boost : 1,
  };
  if (!previous.airborne) {
    // ── 地面段：水平完全复用现有物理；推进器只管垂直通道与助推剂 ──
    const grounded = stepDriving(previous, input, world);
    let boost = previous.boost;
    // 助推接地即回充：低速全速回、行驶中四成回。冷气瓶由车轮发电补气——
    // 「必须停稳才能再飞」只添困惑不添玩法（2026-10-18 用户实测 Space 失效反馈）。
    const regenRate = Math.abs(grounded.speed) < p.boostRegenMaxSpeed ? p.boostRegen : p.boostRegen * 0.4;
    boost = Math.min(1, boost + (regenRate * DRIVING_DT) / p.boostCapacity);
    const thrusting = input.thruster === true && boost > p.minBoostToLift;
    let verticalSpeed = previous.verticalSpeed;
    if (thrusting) {
      verticalSpeed = Math.min(p.liftMax, verticalSpeed + p.liftAccel * DRIVING_DT);
      boost = Math.max(0, boost - (p.boostDrain * DRIVING_DT) / p.boostCapacity);
    } else verticalSpeed = Math.max(0, verticalSpeed - p.liftAccel * DRIVING_DT);
    if (verticalSpeed > 0) {
      // 从累计高度继续抬升（水平段会重新锚定支撑高，忽略之），被上方实体/天花板裁剪。
      const targetY = previous.y + verticalSpeed * DRIVING_DT;
      const lifted = world.lift(grounded, targetY);
      const support = world.supportHeight(grounded.x, grounded.z, grounded.surfaceId);
      const airborne = support !== null && lifted.y - support > p.liftoffMargin;
      // y 必须持续累计（直到 airborne 或停止推进）：否则被水平段的支撑锚定拉回，永远攒不够离地余量。
      return { ...grounded, y: lifted.y, verticalSpeed, boost, airborne };
    }
    return { ...grounded, verticalSpeed: 0, boost, airborne: false };
  }

  // ── 空中段：简化动力学（无轮胎/支撑；转向按速率比例，姿态仅影响视觉） ──
  let speed = previous.speed;
  const targetSpeed = input.forward ? p.airMaxForward : input.backward ? -p.airReverseMax : 0;
  const accel = targetSpeed !== 0 && Math.abs(targetSpeed) > Math.abs(speed) ? p.airAccel : p.airDrag;
  if (speed < targetSpeed) speed = Math.min(targetSpeed, speed + accel * DRIVING_DT);
  else speed = Math.max(targetSpeed, speed - p.airDrag * DRIVING_DT);
  if (!input.forward && !input.backward && Math.abs(speed) < p.zeroSpeed) speed = 0;

  let steering = previous.steering;
  const steerTarget = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  const returning = Math.abs(steerTarget) < Math.abs(steering);
  const response = p.airSteeringResponse * (returning ? p.airSteeringReturn : 1);
  steering += (steerTarget - steering) * (1 - Math.exp(-response * DRIVING_DT));
  const heading = previous.heading + steering * p.airMaxSteering * DRIVING_DT * (speed < 0 ? -1 : 1);

  let verticalSpeed = previous.verticalSpeed;
  let boost = previous.boost;
  const thrusting = input.thruster === true && boost > 0;
  if (thrusting) {
    verticalSpeed = Math.min(p.liftMax, verticalSpeed + p.liftAccel * DRIVING_DT);
    boost = Math.max(0, boost - (p.boostDrain * DRIVING_DT) / p.boostCapacity);
  } else verticalSpeed = Math.max(-p.liftMax, verticalSpeed - p.gravity * DRIVING_DT);

  const desired: VtolAirMotion = {
    x: previous.x + Math.cos(heading) * speed * DRIVING_DT,
    z: previous.z + Math.sin(heading) * speed * DRIVING_DT,
    heading,
    y: previous.y + verticalSpeed * DRIVING_DT,
    travelBudget: Math.abs(speed) * DRIVING_DT,
  };
  const moved = world.moveAir(previous, desired);
  const outSpeed = moved.blocked ? speed * (moved.speedFraction ?? 0) : speed;
  // 接地语义按下沉速度分档（landingSinkMax 是真实执行的门槛，不是装饰）：
  // · 软接地（|vs| ≤ 门槛）：正常落地回地面体制；
  // · 重砸（|vs| > 门槛）：不接地——以 35% 撞击速度弹起（悬架压缩回弹的街机近似），
  //   连续弹跳逐次衰减直到低于门槛才真正落地。
  // 触物/悬停地板时负下沉速度钳 0：靠碰撞停在屋顶上时重力不得积累 −8 的
  // 隐形下沉速度（否则从屋顶边缘飞出的瞬间暴坠）。
  // 触物/悬停地板时负下沉速度钳 0：只认「法线朝上」的支撑性接触（屋顶/板顶从下方托住）。
  // 侧向接触（贴墙下滑）不是支撑——重力照常生效，车沿墙面下滑；否则会把车粘在墙上。
  const supporting = moved.contacts?.some((contact) => contact.normal.y > 0.5) === true;
  const hardLanding = moved.landed && verticalSpeed < -p.landingSinkMax;
  let vertical = verticalSpeed;
  if (moved.landed && !hardLanding) vertical = 0;
  else if (hardLanding) vertical = -verticalSpeed * 0.35;
  else if (moved.floor || moved.blocked || (moved.contact === true && supporting)) vertical = Math.max(0, vertical);
  return {
    ...previous, x: moved.x, z: moved.z, y: moved.y, heading: moved.heading,
    pitch: moved.pitch, roll: moved.roll, surfaceId: moved.surfaceId,
    speed: moved.landed && !hardLanding ? Math.max(0, outSpeed) : outSpeed, steering,
    distance: previous.distance + (moved.travelledDistance ?? 0),
    braking: moved.blocked || moved.contact === true || (moved.landed && !hardLanding),
    reversing: !moved.blocked && outSpeed < 0,
    verticalSpeed: vertical, boost, airborne: !(moved.landed && !hardLanding),
  };
}
