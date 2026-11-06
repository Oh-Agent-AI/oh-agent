#!/usr/bin/env node
// 驾驶参数校准对比台（measurement tool，不是 pass/fail 守卫）：
// 为调参决策录制并对比驾驶动力学指标。平坦合成世界（无碰撞、无坡度），1/60 固定步。
// 场景：
//   1. 0→极速：静止起持续 W 到 ≥95% maxForward——用时/距离 + 0.5s 间隔速度曲线；
//   2. 巡航→0 刹车：先加速到 0.75·maxForward（驾驶参数无巡航档，取 75% 作对比基准），
//      再持续 S 到 ≤zeroSpeed——刹车距离；
//   3. 低速稳态转弯半径：10% maxForward 下持续 A，稳态后取 2s 窗口（半径 = 弧长/航向扫角）；
//   4. 高速稳态转弯半径：90% maxForward 同上；
//   5. W+A 组合：静止起双持 5s，录轨迹 (x,z) 每 0.5s——加速中转弯行为。
// 多档对比（每档独立加载模块实例，互不污染）：
//   acceleration ∈ {5.5(现行), 4.0, 3.0}；steering-return scale ∈ {1.0(对称/现行), 1.33, 1.5}。
// 断言仅为基本健全性：状态有限（无 NaN）、速度 ∈ [-maxReverse, maxForward]、
// 高速半径 > 低速半径（速度敏感转向）、30/60/120Hz 渲染分帧终态一致。
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { buildSync } = require("esbuild");

const DRIVING_SRC = new URL("../apps/agent-city/ui/src/game/DrivingSimulation.ts", import.meta.url).pathname;
const bundleCode = buildSync({ entryPoints: [DRIVING_SRC], bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;

// stepDriving 直接读取模块级 DRIVING_PARAMS（Object.freeze 冻结，且不是函数入参），
// 档位无法经参数注入。这里在每个 vm 实例里用恒等函数顶替 Object.freeze，
// 使 DRIVING_PARAMS 可覆写（原型链仍继承 Object 的全部静态方法）。
// 未改动任何现有文件——旁路只发生在本脚本的 vm 沙箱内。
function loadDriving(overrides) {
  const mod = { exports: {} };
  const UnfrozenObject = { __proto__: Object, freeze: (o) => o };
  vm.runInNewContext(bundleCode, {
    module: mod, exports: mod.exports, console, Date, Math, Map, Set,
    Number, String, Array, Object: UnfrozenObject, JSON, Error, Symbol,
    performance: { now: () => 0 },
  });
  Object.assign(mod.exports.DRIVING_PARAMS, overrides);
  return mod.exports;
}

// 最简平坦世界：无限大平面。move 原样接受期望运动，y/pitch/roll 恒 0，从不阻挡。
const FLAT_WORLD = {
  move: (_previous, desired) => ({
    x: desired.x, z: desired.z, heading: desired.heading,
    y: 0, pitch: 0, roll: 0, surfaceId: "flat", blocked: false,
  }),
};

// 输入对象必须四字段齐全：stepDriving 用 Number(input.right) 等直接求差，
// 缺字段 → Number(undefined)=NaN 会污染 speed/steering（DrivingKernel 对入参做
// === true 归一化也是为防这一点）。组合输入一律由完整常量展开构造。
const W_IN = { forward: true, backward: false, left: false, right: false };
const S_IN = { forward: false, backward: true, left: false, right: false };
const EMPTY_IN = { forward: false, backward: false, left: false, right: false };
const WA_IN = { ...W_IN, left: true };

// 键盘是数字量：目标速度用 W/松油门 bang-bang 保持（加速 5.5 vs 滑行 1.2，锯齿 < 0.1 u/s）。
const speedHold = (target) => (state) => (state.speed < target ? W_IN : EMPTY_IN);

function makeStep(sim, tierLabel) {
  const p = sim.DRIVING_PARAMS;
  return (state, input) => {
    const next = sim.stepDriving(state, input, FLAT_WORLD);
    for (const field of ["x", "y", "z", "heading", "speed", "steering", "distance", "pitch", "roll"]) {
      assert.ok(Number.isFinite(next[field]), `${tierLabel}: ${field} 必须有限（无 NaN）`);
    }
    assert.ok(next.speed >= -p.maxReverse - 1e-9 && next.speed <= p.maxForward + 1e-9,
      `${tierLabel}: 速度 ${next.speed} 超出 [-maxReverse, maxForward]`);
    return next;
  };
}

// ── 场景 1：0→极速（≥95% maxForward）──
function scenarioAccel(sim, step) {
  const dt = sim.DRIVING_DT;
  const target = sim.DRIVING_PARAMS.maxForward * 0.95;
  const every = Math.round(0.5 / dt);
  const cap = Math.ceil(120 / dt);
  let state = sim.initialDrivingState();
  const curve = [0];
  let steps = 0;
  while (state.speed < target && steps < cap) {
    state = step(state, W_IN);
    steps += 1;
    if (steps % every === 0) curve.push(+state.speed.toFixed(2));
  }
  assert.ok(state.speed >= target, "0→极速应在时限内到达 95% maxForward");
  return { time: steps * dt, distance: state.distance, curve };
}

// ── 场景 2：巡航(0.75·maxForward)→0 刹车距离 ──
function scenarioBrake(sim, step) {
  const p = sim.DRIVING_PARAMS;
  const dt = sim.DRIVING_DT;
  const cruise = p.maxForward * 0.75;
  const cap = Math.ceil(120 / dt);
  let state = sim.initialDrivingState();
  let n = 0;
  while (state.speed < cruise && n < cap) { state = step(state, W_IN); n += 1; }
  const start = state.distance;
  let m = 0;
  while (state.speed > p.zeroSpeed && m < cap) { state = step(state, S_IN); m += 1; }
  assert.ok(state.speed <= p.zeroSpeed, "刹车应在时限内降到 zeroSpeed（不进入倒挡）");
  return { cruise, distance: state.distance - start, time: m * dt };
}

// ── 场景 3/4：稳态转弯半径（弧长/航向扫角；1.5s 稳态沉降 ≥ 12 个转向时间常数）──
function scenarioTurnRadius(sim, step, speedFraction) {
  const dt = sim.DRIVING_DT;
  const target = sim.DRIVING_PARAMS.maxForward * speedFraction;
  const hold = speedHold(target);
  const cap = Math.ceil(120 / dt);
  let state = sim.initialDrivingState();
  let n = 0;
  while (state.speed < target && n < cap) { state = step(state, W_IN); n += 1; }
  for (let i = 0; i < Math.round(1.5 / dt); i += 1) state = step(state, { ...hold(state), left: true });
  let arc = 0;
  let sweep = 0;
  for (let i = 0; i < Math.round(2 / dt); i += 1) {
    const next = step(state, { ...hold(state), left: true });
    arc += Math.hypot(next.x - state.x, next.z - state.z);
    sweep += Math.abs(next.heading - state.heading);
    state = next;
  }
  return arc / sweep;
}

// ── 场景 5：W+A 组合从静止 5s，轨迹 (x,z) 每 0.5s ──
function scenarioCombined(sim, step) {
  const dt = sim.DRIVING_DT;
  const every = Math.round(0.5 / dt);
  let state = sim.initialDrivingState();
  const traj = [[0, 0]];
  for (let i = 0; i < Math.round(5 / dt); i += 1) {
    state = step(state, WA_IN);
    if ((i + 1) % every === 0) traj.push([state.x, state.z]);
  }
  return traj;
}

// 打舵/回正瞬态：巡航下按 A 到 |steering| ≥ 95% 稳态参照，松舵到 ≤ 5% —— 各计时。
// 现物理单一 steeringResponse 同时支配打舵与回正，两者必然近似相等（见 finding）。
function scenarioSteerTiming(sim, step) {
  const p = sim.DRIVING_PARAMS;
  const dt = sim.DRIVING_DT;
  const cruise = p.maxForward * 0.75;
  const ref = p.maxSteering / (1 + cruise * 0.07); // 巡航速度下的稳态转向角参照
  const hold = speedHold(cruise);
  const cap = Math.ceil(120 / dt);
  let state = sim.initialDrivingState();
  let n = 0;
  while (state.speed < cruise && n < cap) { state = step(state, W_IN); n += 1; }
  let pressSteps = 0;
  while (Math.abs(state.steering) < ref * 0.95 && pressSteps < cap) {
    state = step(state, { ...hold(state), left: true });
    pressSteps += 1;
  }
  let returnSteps = 0;
  while (Math.abs(state.steering) > ref * 0.05 && returnSteps < cap) {
    state = step(state, hold(state));
    returnSteps += 1;
  }
  return { settle: pressSteps * dt, return: returnSteps * dt };
}

function runTier(label, sim) {
  const step = makeStep(sim, label);
  const accel = scenarioAccel(sim, step);
  const brake = scenarioBrake(sim, step);
  const turnLow = scenarioTurnRadius(sim, step, 0.1);
  const turnHigh = scenarioTurnRadius(sim, step, 0.9);
  const combined = scenarioCombined(sim, step);
  const steer = scenarioSteerTiming(sim, step);
  assert.ok(turnHigh > turnLow,
    `${label}: 高速半径(${turnHigh.toFixed(2)}r) 必须大于低速(${turnLow.toFixed(2)}r)——速度敏感转向`);
  return { accel, brake, turnLow, turnHigh, combined, steer };
}

// ── 帧率无关性：W+A 5s，按 30/60/120Hz 渲染帧切分固定步（累加器模式，同 GameSession 语义）──
{
  const sim = loadDriving({});
  const dt = sim.DRIVING_DT;
  const input = WA_IN;
  const runAt = (renderHz) => {
    const frameDt = 1 / renderHz;
    let state = sim.initialDrivingState();
    let acc = 0;
    const frames = Math.round(5 / frameDt);
    for (let frame = 0; frame < frames; frame += 1) {
      acc += frameDt;
      let guard = 0;
      while (acc >= dt - 1e-12 && guard < 5) {
        state = sim.stepDriving(state, input, FLAT_WORLD);
        acc -= dt;
        guard += 1;
      }
      if (guard >= 5) acc = 0; // 帧内步数上限（丢帧策略，与飞行守卫一致）
    }
    return state;
  };
  const at30 = runAt(30);
  const at60 = runAt(60);
  const at120 = runAt(120);
  for (const state of [at30, at120]) {
    for (const key of ["x", "z", "heading", "speed", "steering", "distance"]) {
      assert.ok(Math.abs(state[key] - at60[key]) < 1e-9, `帧率影响轨迹：${key} ${state[key]} vs ${at60[key]}`);
      assert.ok(Number.isFinite(state[key]), `帧率终态 ${key} 有限`);
    }
  }
  console.log(`frame-parity: 30/60/120Hz 分帧 → W+A 5s 终态一致（固定步 ${dt}，physics v${sim.DRIVING_PHYSICS_VERSION}）`);
}

// ── 多档运行：acceleration 档 ×3 + steering return 档 ×3 ──
// steeringResponse=8 不动；回正档注入 steeringReturnResponse（v3 起的非对称回正参数，
// 回正速率 = steeringResponse × 该值；打舵速率恒为 steeringResponse）。
const ACCEL_TIERS = [5.5, 4.0, 3.0];
const RETURN_TIERS = [1.0, 1.33, 1.5];
const rows = [];
for (const accel of ACCEL_TIERS) {
  const label = `accel=${accel.toFixed(1)}`;
  rows.push([label, runTier(label, loadDriving({ acceleration: accel }))]);
}
for (const scale of RETURN_TIERS) {
  const label = `steer-return=${scale.toFixed(2)}`;
  rows.push([label, runTier(label, loadDriving({ steeringReturnResponse: scale }))]);
}

// ── 输出：主行按约定格式；曲线/轨迹为缩进续行 ──
for (const [label, m] of rows) {
  console.log(`calibration/driving: ${label}: 0-max=${m.accel.time.toFixed(2)}s/${m.accel.distance.toFixed(1)}u | brake=${m.brake.distance.toFixed(1)}u | turn-low=${m.turnLow.toFixed(1)}r turn-high=${m.turnHigh.toFixed(1)}r`);
  console.log(`  0-max speed@0.5s: ${m.accel.curve.join("/")} | brake@cruise(0.75max)=${m.brake.time.toFixed(2)}s | steer settle=${m.steer.settle.toFixed(2)}s return=${m.steer.return.toFixed(2)}s`);
  console.log(`  w+a-5s (x,z): ${m.combined.map(([x, z]) => `${x.toFixed(1)},${z.toFixed(1)}`).join(" ")}`);
}

// ── findings（调参决策的硬约束）──
console.log("finding: v3 起 steeringReturnResponse 独立表达非对称回正——回正档只改回正速率，打舵 settle 各档应保持一致（与 v2 的全局缩放代理不同）。");
console.log("finding: 稳态转弯半径与回正速率无关；档间差异只出现在松舵后的轨迹收束（return 越大，出弯拉直越快）。");
console.log("finding: DRIVING_PARAMS 为模块级 frozen 且不是 stepDriving 入参；本脚本在 vm 沙箱内旁路 Object.freeze 实现档位覆写，未改动任何现有文件。");

console.log("verify-city-driving-calibration: ok (measurement tool — 档位对比数据见上方 calibration/driving 行)");
