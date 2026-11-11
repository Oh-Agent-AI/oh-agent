#!/usr/bin/env node
// 游戏飞行守卫（§12 运动/输入）：
// 1) 固定物理步 + 相同输入，30/60/120 Hz 渲染分帧 → 终态一致（帧率不影响轨迹）；
// 2) 模拟状态无 NaN（含极端输入防护）；
// 3) sweepFlight 扫掠命中（楼体/地形/硬边界；大步跨越也检出，不只测当前点）；
// 4) FlightInput 按键映射、输入框忽略、失焦清空（DOM shim）；
// 5) 校准回放（CITY_GAME_FLIGHT_CALIBRATION_SPEC §9）：SPEC 点名的六个场景在
//    当前物理上留基线曲线并断言不变量；R1 候选档位（转弯减速等）在此对照。
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const load = (file, extraGlobals = {}) => {
  const code = buildSync({ entryPoints: [new URL(`../apps/agent-city/ui/src/${file}`, import.meta.url).pathname],
    bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, console, Date, Math, Map, Set, Number, String, Array, Object, JSON, performance: { now: () => 0 }, ...extraGlobals });
  return mod.exports;
};

const sim = load("game/FlightSimulation.ts");
const { FlightWorld } = load("game/FlightWorld.ts");
const { sweepFlight } = load("game/FlightCollision.ts");

const params = sim.flightParamsFor(600);
const INPUT = { throttleUp: true, throttleDown: false, turnLeft: true, turnRight: false, pitchUp: true, pitchDown: false };
const FIXED = 1 / 60;

// ── 1) 帧率无关：同一输入时长，按不同渲染帧切分固定步，终态一致 ──
function runAt(renderHz) {
  const frameDt = 1 / renderHz;
  let state = sim.initialSimState({ x: 0, y: 50, z: 0, heading: 0 }, params);
  let acc = 0;
  const frames = Math.round(10 / frameDt); // 10 秒模拟；帧数取整避免浮点累计漂移污染对比
  for (let frame = 0; frame < frames; frame += 1) {
    acc += frameDt;
    let guard = 0;
    while (acc >= FIXED - 1e-12 && guard < 5) {
      state = sim.stepFlight(state, INPUT, FIXED, params);
      acc -= FIXED;
      guard += 1;
    }
    if (guard >= 5) acc = 0; // 帧内步数上限（与 GameSession 相同的丢帧策略）
  }
  return state;
}
const at30 = runAt(30);
const at60 = runAt(60);
const at120 = runAt(120);
for (const state of [at30, at120]) {
  for (const key of ["x", "y", "z", "heading", "speed", "turnRate", "verticalSpeed", "bank", "simTime"]) {
    assert.ok(Math.abs(state[key] - at60[key]) < 1e-9, `帧率影响轨迹：${key} ${state[key]} vs ${at60[key]}`);
    assert.ok(Number.isFinite(state[key]), `${key} 非有限值`);
  }
}
assert.ok(at60.simTime > 9.8 && at60.simTime <= 10 + FIXED, "模拟时钟按固定步推进");
assert.ok(at60.speed <= params.maxSpeed + 1e-9 && at60.speed >= params.minSpeed - 1e-9, "速度在 [min,max] 内");
assert.ok(Math.abs(at60.bank) <= params.bankMax + 1e-9, "倾斜不超上限");

// ── 1b) 校准回放（CALIBRATION_SPEC §9 运动行）：确定性输入场景 + 基线曲线输出 ──
// 场景驱动固定 1/60 步；inputOf(state, step) 返回该步输入，录制速度/转向率曲线。
const EMPTY = { throttleUp: false, throttleDown: false, turnLeft: false, turnRight: false, pitchUp: false, pitchDown: false };
const W = { ...EMPTY, throttleUp: true };
const S = { ...EMPTY, throttleDown: true };
const A = { ...EMPTY, turnLeft: true };
function replay(name, inputOf, seconds) {
  let state = sim.initialSimState({ x: 0, y: 400, z: 0, heading: 0 }, params);
  const steps = Math.round(seconds / FIXED);
  const curve = [];
  for (let step = 0; step < steps; step += 1) {
    state = sim.stepFlight(state, inputOf(state, step), FIXED, params);
    if (step % Math.round(0.5 / FIXED) === 0 || step === steps - 1) curve.push({ t: +(step * FIXED).toFixed(2), speed: +state.speed.toFixed(2), turnRate: +state.turnRate.toFixed(3) });
  }
  for (const field of ["speed", "turnRate", "verticalSpeed", "bank"]) {
    assert.ok(Number.isFinite(state[field]), `${name}: ${field} 有限`);
  }
  assert.ok(state.speed >= params.minSpeed - 1e-9 && state.speed <= params.maxSpeed + 1e-9, `${name}: 速度边界`);
  return { name, curve, end: state };
}
// 转向符号（回归）：前向 = (cos h, 0, sin h)，追尾相机看向 +X 时屏幕右 = +Z。
// 曾经 A 键把飞机带向屏幕右侧，而上面所有场景只断言 |turnRate|，对符号不敏感。
{
  const D = { ...EMPTY, turnRight: true };
  const fly = (input) => { let s = sim.initialSimState({ x: 0, y: 400, z: 0, heading: 0 }, params); for (let i = 0; i < 60; i += 1) s = sim.stepFlight(s, input, FIXED, params); return s; };
  const left = fly(A), right = fly(D);
  assert.ok(left.z < 0 && left.heading < 0, "A 左转：飞机偏向 -Z（屏幕左），heading 减小");
  assert.ok(right.z > 0 && right.heading > 0, "D 右转：飞机偏向 +Z（屏幕右），heading 增大");
  assert.ok(left.bank < 0 && right.bank > 0, "bank 与转向同号（FlightVisuals 依赖：bank>0 = 右翼下沉 = 向右转的内侧）");
}
// 场景 1：稳定巡航 + 满舵 3 秒（R1 转弯减速候选的主对照；当前物理速度应保持巡航）。
const fullRudder = replay("cruise-full-rudder-3s", () => A, 3.0);
assert.ok(Math.abs(fullRudder.end.speed - params.cruiseSpeed) < 0.01, "场景1 基线：现物理转向不损失速度（候选档位将改变此断言）");
// 场景 2：满舵 1 秒后松舵——转向率应单调衰减到 0（指数平滑）。
const rudderDecay = replay("rudder-release-decay", (_state, step) => (step * FIXED < 1 ? A : EMPTY), 3.0);
const decayTurns = rudderDecay.curve.filter((point) => point.t >= 1).map((point) => Math.abs(point.turnRate));
assert.ok(decayTurns.every((value, index) => index === 0 || value <= decayTurns[index - 1] + 1e-6), "场景2 松舵后转向率单调衰减");
assert.ok(Math.abs(rudderDecay.end.turnRate) < 0.01, "场景2 转向率归零");
// 场景 3：W 冲到极速后纯松油门——速度回落巡航但不得跌破 min。
const releaseThrottle = replay("release-throttle", (_state, step) => (step * FIXED < 2 ? W : EMPTY), 4.0);
assert.ok(releaseThrottle.curve[3].speed > params.cruiseSpeed * 1.2, "场景3 两秒内显著超过巡航");
assert.ok(Math.abs(releaseThrottle.end.speed - params.cruiseSpeed) < params.cruiseSpeed * 0.05, "场景3 松手回到巡航附近");
// 场景 4：W 冲到极速后 S 刹车到底——逼近 min 且不越界。
const brake = replay("brake-to-min", (_state, step) => (step * FIXED < 2 ? W : S), 4.0);
assert.ok(brake.end.speed <= params.minSpeed + params.cruiseSpeed * 0.05, "场景4 刹车逼近 min");
assert.ok(brake.end.speed >= params.minSpeed - 1e-9, "场景4 刹车不穿 min");
// 场景 5/6：组合输入 W+转弯 / S+转弯——边界内且有限。
const wPlusTurn = replay("w-plus-turn", () => ({ ...W, turnLeft: true }), 3.0);
assert.ok(wPlusTurn.end.speed <= params.maxSpeed + 1e-9, "场景5 W+转弯不越 max");
const sPlusTurn = replay("s-plus-turn", () => ({ ...S, turnLeft: true }), 3.0);
assert.ok(sPlusTurn.end.speed >= params.minSpeed - 1e-9, "场景6 S+转弯不穿 min");
// 组合顺序确定性：W+转弯 与 先W后转弯 的终速一致（固定步顺序无关性）。
{
  const both = replay("w-and-turn-together", () => ({ ...W, turnLeft: true }), 2.0);
  let staged = sim.initialSimState({ x: 0, y: 400, z: 0, heading: 0 }, params);
  for (let step = 0; step < Math.round(1 / FIXED); step += 1) staged = sim.stepFlight(staged, W, FIXED, params);
  for (let step = 0; step < Math.round(1 / FIXED); step += 1) staged = sim.stepFlight(staged, { ...W, turnLeft: true }, FIXED, params);
  assert.ok(Math.abs(both.end.speed - staged.speed) < 0.01, "组合输入顺序确定性");
}
// 基线曲线输出（一行一场景，供候选档位 diff；格式 calibration-replay/<物理版本>）。
console.log(`calibration-replay/p${sim.PHYSICS_VERSION}: ` + [fullRudder, rudderDecay, releaseThrottle, brake, wPlusTurn, sPlusTurn]
  .map((scenario) => `${scenario.name}=${scenario.curve.map((point) => point.speed).join("/")}`).join(" | "));

// ── 2) NaN 防护：非有限状态不外泄 ──
{
  const broken = { ...at60, heading: NaN };
  const next = sim.stepFlight(broken, INPUT, FIXED, params);
  assert.ok([next.x, next.heading, next.speed].every(Number.isFinite), "NaN 状态必须被替换为安全值");
}

// ── 3) 碰撞扫掠 ──
const model0 = { generatedAt: 0, windowStartMs: 0, windowEndMs: 1, windowLabel: "t", districts: [], buildings: [], stats: { renderedSessions: 0, aggregatedSessions: 0, totalSessions: 0, tokensTotal: 0, activeCount: 0, truncated: false }, rows: new Map() };
const flatLayout = {
  scaleTier: 1, biome: "temperate", core: { x: 0, z: 0 }, islandRadius: 300, seed: 1,
  districts: [], blocks: [], roadNodes: [], roadEdges: [], terrain: { height: () => 0, slope: () => 0, buildable: () => true, coastRadius: () => 300, center: { x: 0, z: 0 }, radius: 300, hasRiver: false },
  extent: 300, coast: [], river: [], publicSites: [], parkTrees: [], urbanBounds: { left: -200, right: 200, north: -200, south: 200 },
  bridges: [], boatLanes: [], boundsRadius: 250, decorMountains: [], districtAnchors: [], highways: [], massing: [], civics: [], landmarks: [],
  seaside: null, coastalConfigKey: "none", coastalConfig: null, contextBuildings: [], gardens: [], boatLoops: [], seaMountains: [],
};
{
  // 空世界（无楼）：水平直线畅通；贴地与越界被检出。
  const world = new FlightWorld({ layout: flatLayout, model: model0, cursorMs: null });
  assert.equal(sweepFlight(world, { x: 0, y: 60, z: 0 }, { x: 40, y: 60, z: 0 }, 2), null, "畅通直线不误报");
  const ground = sweepFlight(world, { x: 0, y: 10, z: 0 }, { x: 0, y: 0.5, z: 0 }, 2);
  assert.ok(ground && (ground.kind === "terrain" || ground.kind === "bounds"), "下坠贴地检出（地形或垂直边界）");
  const outside = sweepFlight(world, { x: 0, y: 60, z: 0 }, { x: world.bounds.hardRadius * 1.5, y: 60, z: 0 }, 2);
  assert.ok(outside && outside.kind === "bounds", "硬边界检出");
}
{
  // 单楼扫掠：慢步与跨楼大步（瞬移尺度）都必须命中——不只测当前点。
  const layout = { ...flatLayout, districts: [{ id: "d", label: "d", center: { x: 0, z: 0 }, radius: 50, terrain: flatLayout.terrain,
    slots: new Map([["b1", { id: "b1", x: 100, z: 0, blockId: "blk", yaw: 0, zone: "residential", width: 8, depth: 8 }]]),
    grounds: new Map([["b1", 0]]), roads: [], carPaths: [], river: null, riverHalfWidth: 0, trees: [], plaza: { x: 0, z: 0, y: 0 }, anomaly: null, sessionCount: 1, landValue: new Map() }],
    landmarks: [], bridges: [] };
  const model = { ...model0, buildings: [{ id: "b1", districtId: "d", archetype: "tower", facade: 0, seed: 0.5, tokensTotal: 1e6, height: 30, footprint: 5, startedAt: 0, endedAt: null, active: false, builtFraction: 1, busyness: 0, aggregated: false, extraCount: 0 }] };
  const world = new FlightWorld({ layout, model, cursorMs: null });
  assert.equal(world.boxes.length, 1);
  const slow = sweepFlight(world, { x: 96, y: 15, z: 0 }, { x: 97, y: 15, z: 0 }, 1.5);
  assert.ok(slow && slow.kind === "box", "慢步进楼检出");
  const jump = sweepFlight(world, { x: 60, y: 15, z: 0 }, { x: 140, y: 15, z: 0 }, 1.5);
  assert.ok(jump && jump.kind === "box", "大步跨楼检出（扫掠）");
  assert.equal(sweepFlight(world, { x: 90, y: 45, z: 0 }, { x: 110, y: 45, z: 0 }, 1.5), null, "楼顶上方通过不误报");
}

// ── 3b) FlightCamera 环绕/缩放（几何）+ FlightCameraControls（输入）──
// 不操作时必须与旧追尾相机逐点一致——这是「加环绕不改变默认手感」的守卫。
{
  const THREE = createRequire(new URL("../apps/agent-city/ui/package.json", import.meta.url))("three");
  const { FlightCamera, ZOOM_MIN, ZOOM_MAX } = load("game/FlightCamera.ts");
  // Use real world camera queries; endpoint-only point mocks cannot satisfy the
  // swept near-plane contract introduced by the shared camera foundation.
  const cameraWorld = (staticSolids = []) => new FlightWorld({ layout: flatLayout, model: model0, cursorMs: null, staticSolids });
  const wallSolid = (axis) => ({ id: `camera-wall:${axis}`, role: "wall", kind: "box",
    center: { x: axis === "x" ? -503.75 : 0, y: 100, z: axis === "z" ? -503.75 : 0 },
    halfAxes: [{ x: axis === "x" ? 496.25 : 1000, y: 0, z: 0 }, { x: 0, y: 100, z: 0 },
      { x: 0, y: 0, z: axis === "z" ? 496.25 : 1000 }] });
  const open = cameraWorld(); // Camera geometry fixtures stay within this real world's vertical bounds.
  const rig = () => ({ cam: new THREE.PerspectiveCamera(52, 1.5, 1.5, 8000) });
  const settle = (c, s, w = open, frames = 400) => { for (let i = 0; i < frames; i += 1) c.update(1 / 60, s, params, w); };
  const at = (cam, s) => cam.position.clone().sub(new THREE.Vector3(s.x, s.y, s.z));
  const s0 = sim.initialSimState({ x: 100, y: 40, z: 50, heading: 0.4 }, params);

  // 默认位：机后 back、机上 up（与改造前同一公式的解析值）。
  {
    const { cam } = rig(); const c = new FlightCamera(cam, true); c.reset(s0, params); settle(c, s0);
    const speedRatio = (s0.speed - params.minSpeed) / (params.maxSpeed - params.minSpeed);
    const back = params.planeRadius * 5.2 * (1 + 0.35 * Math.max(0, Math.min(1, speedRatio)));
    const rel = at(cam, s0);
    const dx = Math.abs(rel.x + Math.cos(s0.heading) * back);
    const dz = Math.abs(rel.z + Math.sin(s0.heading) * back);
    const dy = Math.abs(rel.y - params.planeRadius * 2.4);
    assert.ok(dx < 1e-3 && dz < 1e-3, `默认机位在机后 back 处 (dx=${dx}, dz=${dz}, expected back=${back}, rel.x=${rel.x}, rel.z=${rel.z}, planeRadius=${params.planeRadius})`);
    assert.ok(dy < 1e-3, `默认机位在机上 up 处 (dy=${dy})`);
  }
  // 环绕：半径守恒；向右拖(+yaw)后相机绕到飞机左侧（航向 0 时 -Z）。
  {
    const { cam } = rig(); const c = new FlightCamera(cam, true); const s = sim.initialSimState({ x: 0, y: 40, z: 0, heading: 0 }, params);
    c.reset(s, params); settle(c, s); const r0 = at(cam, s).length();
    c.orbitBy(Math.PI / 2, 0); settle(c, s);
    const side = at(cam, s);
    assert.ok(Math.abs(side.length() - r0) < 1e-3, "环绕半径守恒");
    assert.ok(Math.abs(side.x) < 1e-3 && side.z < 0, "+yaw：相机在飞机正左侧(-Z)");
  }
  // 缩放：与倍率成正比，夹在上下限；非法输入被拒绝；侧面最近时翼尖仍在近裁剪面之外。
  {
    const { cam } = rig(); const c = new FlightCamera(cam, true); const s = sim.initialSimState({ x: 0, y: 40, z: 0, heading: 0 }, params);
    c.reset(s, params); settle(c, s); const d = at(cam, s).length();
    c.zoomBy(0.5); settle(c, s); assert.ok(Math.abs(at(cam, s).length() / d - 0.5) < 1e-3 || Math.abs(at(cam, s).length() / d - ZOOM_MIN) < 1e-3, "zoom 0.5 → 距离减半(或夹到下限)");
    c.zoomBy(1e-9); settle(c, s); assert.ok(Math.abs(at(cam, s).length() / d - ZOOM_MIN) < 1e-3, "下限夹取");
    assert.ok(at(cam, s).length() - 2.1 * params.planeRadius > cam.near, "最近机位下翼尖不进近裁剪面");
    c.zoomBy(1e9); settle(c, s); assert.ok(Math.abs(at(cam, s).length() / d - ZOOM_MAX) < 1e-3, "上限夹取");
    // orbit.zoom 是缓动后的值，NaN 要等下一帧才传染——所以要跑帧后检查相机位置本身是否仍有限。
    c.zoomBy(NaN); c.zoomBy(-3); c.zoomBy(0); settle(c, s, open, 10);
    assert.ok(cam.position.toArray().every(Number.isFinite) && cam.matrixWorld.toArray().every(Number.isFinite), "非法缩放因子(NaN/负/0)不污染相机");
    const afterBad = c.orbit.zoom; c.zoomBy(Infinity); settle(c, s, open, 10);
    assert.ok(Number.isFinite(c.orbit.zoom) && c.orbit.zoom >= afterBad - 1e-9, "Infinity 被拒绝而不是当作无限拉远");
  }
  // 俯仰不翻转：拖到极限相机不越过正上方/正下方。
  {
    const { cam } = rig(); const c = new FlightCamera(cam, true); const s = sim.initialSimState({ x: 0, y: 40, z: 0, heading: 0 }, params);
    c.reset(s, params); c.orbitBy(0, 99); settle(c, s);
    const hi = at(cam, s); const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
    assert.ok(Math.atan2(hi.y, Math.hypot(hi.x, hi.z)) < Math.PI / 2 - 0.05 && Math.abs(dir.y) < 0.9999, "俯仰上限不到正顶");
    c.orbitBy(0, -99); settle(c, s);
    const lo = at(cam, s); const loDeg = Math.atan2(lo.y, Math.hypot(lo.x, lo.z)) * 180 / Math.PI;
    assert.ok(Math.abs(loDeg - (90 - 1.42 * 180 / Math.PI)) < 0.1, `俯仰下限与引擎 OrbitControls 一致(maxPolarAngle=1.42 → ${loDeg.toFixed(1)}°)`);
  }
  // 遮挡收缩在环绕后仍生效（相机侧后方有墙时被拉近，而不是穿墙）。
  {
    const wall = cameraWorld([wallSolid("z")]);
    const s = sim.initialSimState({ x: 0, y: 40, z: 0, heading: 0 }, params);
    const a = rig().cam, b = rig().cam; const ca = new FlightCamera(a, true), cb = new FlightCamera(b, true);
    ca.reset(s, params); cb.reset(s, params); ca.orbitBy(Math.PI / 2, 0); cb.orbitBy(Math.PI / 2, 0);
    settle(ca, s, wall); settle(cb, s, open);
    assert.ok(Math.abs(a.position.z) < Math.abs(b.position.z) - 1, "环绕到有墙一侧时相机被拉近");
    // 墙在飞机正后方(-X 轴向)时，相机在默认追尾位被拉近；环绕到飞机前方(远离墙)后不该再被拉近——
    // 遮挡采样必须沿「当前」相机方向，而不是写死在机后。
    const behind = cameraWorld([wallSolid("x")]);
    const f1 = rig().cam, f2 = rig().cam; const cf1 = new FlightCamera(f1, true), cf2 = new FlightCamera(f2, true);
    cf1.reset(s, params); cf2.reset(s, params); cf2.orbitBy(Math.PI, 0);
    settle(cf1, s, behind); settle(cf2, s, behind);
    assert.ok(at(f1, s).length() < at(f2, s).length() - 5, "墙在机后：追尾位被拉近，绕到机头前方后不再被拉近");
  }
  // yaw 连续绕多圈穿过 ±π 接缝：逐帧位移有界(无瞬移)，松手后 resetOrbit 回到追尾位。
  {
    const { cam } = rig(); const c = new FlightCamera(cam, true); const s = sim.initialSimState({ x: 0, y: 40, z: 0, heading: 0 }, params);
    c.reset(s, params); let maxJump = 0; const prev = cam.position.clone();
    for (let k = 0; k < 16; k += 1) { c.orbitBy(Math.PI / 4, 0); for (let i = 0; i < 40; i += 1) { c.update(1 / 60, s, params, open); maxJump = Math.max(maxJump, cam.position.distanceTo(prev)); prev.copy(cam.position); } }
    assert.ok(maxJump < params.planeRadius, `绕圈逐帧位移有界(${maxJump.toFixed(2)})`);
    c.resetOrbit(); settle(c, s); assert.ok(Math.abs(c.orbit.yaw) < 1e-3 && Math.abs(c.orbit.pitch) < 1e-3 && Math.abs(c.orbit.zoom - 1) < 1e-3, "resetOrbit 回到追尾位");
  }

  // ── FlightCameraControls：指针/滚轮/双击 → FlightCamera（DOM shim）──
  {
    const { FlightCameraControls } = load("game/FlightCameraControls.ts");
    const listeners = new Map(); const captured = new Set();
    const canvas = { style: { cursor: "", touchAction: "" }, clientHeight: 600,
      addEventListener: (t, fn) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
      removeEventListener: (t, fn) => listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn)),
      setPointerCapture: (id) => captured.add(id), releasePointerCapture: (id) => captured.delete(id) };
    const emit = (t, e) => (listeners.get(t) ?? []).forEach((fn) => fn(e));
    const calls = [];
    const fake = { orbitBy: (a, b) => calls.push(["orbit", a, b]), zoomBy: (f) => calls.push(["zoom", f]), setDragging: (d) => calls.push(["drag", d]), resetOrbit: () => calls.push(["reset"]) };
    let active = true;
    const ctl = new FlightCameraControls({ canvas, camera: () => fake, isActive: () => active });
    ctl.attach(); ctl.attach(); // 幂等
    assert.equal(listeners.get("pointerdown").length, 1, "attach 幂等：只注册一份监听");
    assert.equal(canvas.style.touchAction, "none", "触屏手势不被浏览器滚动抢走");
    const ptr = (over = {}) => ({ button: 0, isPrimary: true, pointerId: 1, clientX: 100, clientY: 100, ...over });
    emit("pointerdown", ptr());
    emit("pointermove", ptr({ clientX: 160, clientY: 130 }));
    const orbit = calls.find((c) => c[0] === "orbit");
    const perPx = (2 * Math.PI) / 600;
    assert.ok(orbit && Math.abs(orbit[1] - 60 * perPx) < 1e-9 && Math.abs(orbit[2] - 30 * perPx) < 1e-9, "整屏高度拖动 = 一圈，dx→yaw、dy→pitch");
    emit("pointermove", ptr({ pointerId: 2, clientX: 400, clientY: 400 })); // 第二根手指不参与
    assert.equal(calls.filter((c) => c[0] === "orbit").length, 1, "非拖动指针的移动被忽略");
    emit("pointerup", ptr());
    assert.deepEqual(calls.filter((c) => c[0] === "drag").map((c) => c[1]), [true, false], "按下/松开切换 dragging");
    assert.equal(captured.size, 0, "松手释放指针捕获");
    // 右键/非主指针不拖动。
    const n = calls.length; emit("pointerdown", ptr({ button: 2 })); emit("pointerdown", ptr({ isPrimary: false })); assert.equal(calls.length, n, "右键与非主指针不触发拖动");
    // 滚轮：与引擎 OrbitControls 同一曲线（0.95^(|Δ|/100)；向下滚 = 拉远，向上 = 拉近）。
    // 期望值直接取 three 的 OrbitControls._getZoomScale 公式，不是从实现里抄来的。
    const orbitScale = (deltaY, ctrl = false, mode = 0) => { let d = deltaY * (mode === 1 ? 16 : mode === 2 ? 100 : 1); if (ctrl) d *= 10; const k = Math.pow(0.95, Math.abs(d * 0.01)); return d < 0 ? k : d > 0 ? 1 / k : 1; };
    let prevented = 0; const wheel = (over) => emit("wheel", { deltaY: 100, deltaMode: 0, ctrlKey: false, preventDefault: () => { prevented += 1; }, ...over });
    const lastZoom = () => calls.filter((c) => c[0] === "zoom").at(-1)[1];
    for (const [label, over] of [["鼠标一格 +100", { deltaY: 100 }], ["鼠标一格 -100", { deltaY: -100 }], ["触控板小步 +4", { deltaY: 4 }], ["line 模式 3", { deltaY: 3, deltaMode: 1 }], ["page 模式 -1", { deltaY: -1, deltaMode: 2 }], ["捏合 -5", { deltaY: -5, ctrlKey: true }], ["捏合 +30", { deltaY: 30, ctrlKey: true }]]) {
      wheel(over);
      assert.ok(Math.abs(lastZoom() - orbitScale(over.deltaY, over.ctrlKey ?? false, over.deltaMode ?? 0)) < 1e-9, `滚轮曲线与 OrbitControls 一致：${label}`);
    }
    wheel({ deltaY: 1e9 }); assert.ok(Number.isFinite(lastZoom()), "畸形巨大滚轮值不产生 Infinity");
    assert.equal(prevented, 8, "激活时滚轮阻止默认滚动");
    // 双击复位。
    emit("dblclick", {}); assert.equal(calls.at(-1)[0], "reset", "双击复位");
    // 暂停/结果面板（isActive=false）期间一切忽略，且不吞滚轮。
    active = false; const m = calls.length; prevented = 0;
    emit("pointerdown", ptr()); wheel({}); emit("dblclick", {});
    assert.equal(calls.length, m, "不活跃时指针/滚轮/双击全部忽略"); assert.equal(prevented, 0, "不活跃时不吞滚轮默认行为");
    // 拖动中途变为不活跃（按 Esc 暂停）：结束拖动并释放捕获，恢复后不会突然甩镜头。
    active = true; emit("pointerdown", ptr()); active = false; emit("pointermove", ptr({ clientX: 300 }));
    assert.equal(captured.size, 0, "拖动中途暂停 → 释放捕获"); assert.equal(calls.at(-1)[0], "drag", "…并结束拖动状态");
    // detach 成对释放。
    ctl.detach(); ctl.detach();
    for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture", "wheel", "dblclick"]) assert.equal(listeners.get(t)?.length ?? 0, 0, `detach 后 ${t} 监听为空`);
    assert.equal(canvas.style.touchAction, "", "detach 还原 touch-action");
  }
}

// ── 4) FlightInput：窗口级按键/无画布焦点/输入框忽略/失焦清空（DOM shim）──
{
  class HTMLElement {}
  const listeners = new Map();
  const emitter = (target) => ({
    addEventListener: (type, fn) => { const list = listeners.get(`${target}:${type}`) ?? []; list.push(fn); listeners.set(`${target}:${type}`, list); },
    removeEventListener: (type, fn) => { const list = (listeners.get(`${target}:${type}`) ?? []).filter((item) => item !== fn); listeners.set(`${target}:${type}`, list); },
  });
  const documentShim = { visibilityState: "visible", activeElement: null, addEventListener: emitter("document").addEventListener, removeEventListener: emitter("document").removeEventListener };
  let windowFocused = true;
  const { FlightInput } = load("game/FlightInput.ts", { window: emitter("window"), document: documentShim, HTMLElement });
  const interrupts = [];
  const canvas = Object.assign(new HTMLElement(), { blur() {} });
  const input = new FlightInput({ isGameFocused: () => windowFocused, blurFocusTarget: () => canvas,
    shouldConsumeArrows: () => windowFocused, onInterrupt: (reason) => interrupts.push(reason) });
  input.attach();
  const key = (code, target = null, extra = {}) => (listeners.get("window:keydown") ?? []).forEach((fn) => fn({ code, target, isComposing: false, repeat: false, preventDefault: () => {}, stopImmediatePropagation: () => {}, ...extra }));
  const keyUp = (code) => (listeners.get("window:keyup") ?? []).forEach((fn) => fn({ code, target: null }));
  // 页面窗口聚焦时即便 activeElement 是 body，也应该可以驾驶；不会抢焦点给 canvas。
  key("KeyW"); key("KeyA"); key("ArrowUp");
  const snapshotEqual = (value, expected, label) => {
    for (const field of Object.keys(expected)) assert.equal(value[field], expected[field], `${label}: ${field}`);
  };
  snapshotEqual(input.snapshot(), { throttleUp: true, throttleDown: false, turnLeft: true, turnRight: false, pitchUp: true, pitchDown: false }, "按键映射");
  // 真正聚焦的输入框仍可输入，游戏不会抢焦点或接管按键。
  const textField = Object.assign(Object.create(HTMLElement.prototype), { tagName: "INPUT", type: "text", isContentEditable: false });
  documentShim.activeElement = textField;
  key("KeyS", textField);
  assert.equal(input.snapshot().throttleDown, false, "输入框内的按键不进入游戏");
  documentShim.activeElement = null;
  key("KeyS", null, { isComposing: true });
  assert.equal(input.snapshot().throttleDown, true, "输入法组合期间仍按物理 KeyS 驱动飞机");
  keyUp("KeyS");
  assert.equal(input.snapshot().throttleDown, false, "组合期间的物理按键释放仍会清除飞行输入");
  // 焦点离开窗口后的 keyup 仍要清除（不粘键）。
  windowFocused = false;
  keyUp("KeyW");
  assert.equal(input.snapshot().throttleUp, false, "未聚焦时 keyup 仍清除状态");
  // 失焦：清空按键 + focus-lost 回调。
  windowFocused = true;
  key("KeyW");
  (listeners.get("window:blur") ?? []).forEach((fn) => fn());
  snapshotEqual(input.snapshot(), { throttleUp: false, throttleDown: false, turnLeft: false, turnRight: false, pitchUp: false, pitchDown: false }, "失焦清空按键");
  assert.equal(interrupts.at(-1), "focus-lost");
  // 文档隐藏：host-hidden。
  key("KeyW");
  documentShim.visibilityState = "hidden";
  (listeners.get("document:visibilitychange") ?? []).forEach((fn) => fn());
  assert.equal(input.snapshot().throttleUp, false);
  assert.equal(interrupts.at(-1), "host-hidden");
  // detach 后监听成对释放。
  input.detach();
  assert.equal(listeners.get("window:keydown")?.length ?? 0, 0, "detach 后 keydown 监听为空");
  assert.equal(listeners.get("window:blur")?.length ?? 0, 0, "detach 后 blur 监听为空");
}

console.log("verify-city-game-flight: ok");
