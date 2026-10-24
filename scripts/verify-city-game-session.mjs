#!/usr/bin/env node
// 会话生命周期守卫（审查 P1-1 回归）：
// 1) 首次准备失败（城市未就绪）后「重试」必须完整重建 world/params/sim——
//    不得进入无模拟对象的空局面（telemetry 为 null 的 practice 是失败信号）；
// 2) restart 必须重建终态 mission（重赛进度不冻结）；
// 3) 挑战进入 → 倒计时经帧钩子推进 → racing；退出归还相机并回调 onExited。
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const THREE = createRequire(new URL("../apps/agent-city/ui/package.json", import.meta.url))("three");
const load = (file, extraGlobals = {}) => {
  const code = buildSync({ entryPoints: [new URL(`../apps/agent-city/ui/src/${file}`, import.meta.url).pathname],
    // 游戏 BGM 是 Vite 的 `?url` 导入（GameAudio.ts → leonida-nights.m4a）：这里不播放，按空模块处理。
    // 曾无此项——游戏声音提交（6f2437ec）后本守卫在构建阶段就失败，main 上同样红。
    bundle: true, write: false, format: "cjs", platform: "node", loader: { ".m4a": "empty" } }).outputFiles[0].text;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, console, AbortController, Date, Math, Map, Set, Number, String, Array, Object, JSON,
    performance: { now: () => Date.now() }, ...extraGlobals });
  return mod.exports;
};
const noopEmitter = { addEventListener: () => {}, removeEventListener: () => {} };
// 可派发事件的 window 桩（GameSession 经 FlightInput 挂 window keydown/keyup）。
const windowListeners = new Map();
const windowShim = {
  addEventListener: (type, fn) => { const list = windowListeners.get(type) ?? []; list.push(fn); windowListeners.set(type, list); },
  removeEventListener: (type, fn) => { windowListeners.set(type, (windowListeners.get(type) ?? []).filter((item) => item !== fn)); },
  matchMedia: undefined, parent: null,
};
// FlightVisuals 的涂装贴图走 canvas 2D；Node 里没有画布，用吞掉所有绘制调用的代理顶替（只验证会话逻辑，不验证像素）。
const ctx2dShim = new Proxy({}, { get: (_t, key) => (key === "createLinearGradient" ? () => ({ addColorStop: () => {} }) : () => {}), set: () => true });
const canvasShim = () => ({ width: 1, height: 1, getContext: () => ctx2dShim });
const documentShim = { visibilityState: "visible", activeElement: null, addEventListener: () => {}, removeEventListener: () => {}, createElement: canvasShim };
const pressKey = (code) => {
  for (const fn of windowListeners.get("keydown") ?? []) fn({ code, target: windowShim, isComposing: false, repeat: false, preventDefault: () => {} });
};
const releaseKey = (code) => {
  for (const fn of windowListeners.get("keyup") ?? []) fn({ code, target: windowShim });
};
const { buildCityModel } = load("cityModel.ts", { window: windowShim, document: documentShim });
const { layoutCity } = load("engine/cityLayout.ts");
const { GameSession } = load("game/GameSession.ts", { window: windowShim, document: documentShim, HTMLElement: class {}, self: windowShim });

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 1);
const tokens = (total) => ({ uncached_input_tokens: total, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total });
const rows = Array.from({ length: 40 }, (_, index) => {
  const first = now - DAY * 29 + index * 3_600_000;
  return { session_ref: `s:${index}`, harness: index % 2 ? "harness:zcode" : "harness:claude", first_event_at: new Date(first).toISOString(), last_event_at: new Date(first + 7_200_000).toISOString(),
    event_count: 10, model_ids: [], tokens: tokens(50_000 + (index % 37) * 900_000), peak_tokens: 0, cost_minor: null,
    cost_status: { state: "unavailable", reason: "test", has_unresolved: false } };
});
const model = buildCityModel({ rows, findings: [], windowStartMs: now - DAY * 30, windowEndMs: now, windowLabel: "30d",
  totalSessions: rows.length, truncated: false, generatedAt: now });
const layout = layoutCity(model, null, 42, null, "auto");

const returnView = { position: [10, 10, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 42,
  controls: { minDistance: 3, maxDistance: 900, enablePan: true, zoomToCursor: true, orbitLockedId: null } };
function fakeEngine() {
  let frameHook = null;
  const engine = {
    currentLayout: null, currentModel: null, replayCursor: null, owner: "orbit", attached: new Set(), releaseCount: 0,
    setLabelsVisible: () => {},
    renderCamera: new THREE.PerspectiveCamera(50, 1.6, 0.1, 2000),
    domCanvas: {},
    gameScenePort: { acquireResult: async (_selection, runId, signal) => {
      if (signal.aborted) throw new Error("cancelled");
      const capturedModel = engine.currentModel;
      const current = () => engine.currentModel === capturedModel;
      const staticWorld = { status: "ready", revision: `test-world:${runId}`, worldRevision: `test-world:${runId}`,
        isCurrent: current, isLeaseCurrent: current, verifyCurrent: current,
        readWorld: () => { if (engine.throwOnReadWorld) throw new Error("snapshot-read-failed"); return current() ? ({ revision: `test-world:${runId}`, worldRevision: `test-world:${runId}`, layout, obstacles: [], sceneSolids: [], renderedSolids: [], surface: {} }) : null; } };
      const snapshot = Object.freeze({ staticWorld });
      const lease = { token: Symbol(), hostEpoch: 1, selection: _selection, runId, revision: staticWorld.worldRevision, snapshot,
        isCurrent: current, attach: (objects) => objects.forEach((object) => engine.attached.add(object)),
        detach: (objects) => objects.forEach((object) => engine.attached.delete(object)),
        setCamera: (pose) => { engine.pose = pose; }, setAmbientCarsVisible: () => {},
        setFrameHook: (hook) => { frameHook = hook; }, release: () => { engine.releaseCount++; frameHook = null; engine.owner = "orbit"; engine.restored = returnView; } };
      return { status: "ready", lease };
    }, acquire: async (...args) => {
      const result = await engine.gameScenePort.acquireResult(...args);
      if (result.status !== "ready") throw new Error(result.reason);
      return result.lease;
    } },
    get frame() { return (dt) => frameHook?.(dt); },
  };
  return engine;
}

// If static preparation throws after acquiring the host scene, the token and
// partial run resources are still returned before the error panel is shown.
{
  const engine = fakeEngine(); engine.currentLayout = layout; engine.currentModel = model; engine.throwOnReadWorld = true;
  const session = new GameSession(engine, { onState() {}, onExited() {} });
  const result = await session.enter({ mode: "practice" }, { cityReady: true, cinemaActive: false, filmActive: false, busy: false });
  assert.ok(!result.ok && result.reason !== "not-ready", "throwing snapshot read fails preparation");
  assert.equal(engine.releaseCount, 1, "preparation exception releases acquired scene lease");
  assert.equal(engine.owner, "orbit", "preparation exception restores host state");
  assert.equal(session.snapshot().telemetry, null);
  session.dispose();
}

// ── 1) 准备失败 → 重试完整重建（不再进入空局面）──
{
  const engine = fakeEngine();
  const exited = [];
  const session = new GameSession(engine, { onState: () => {}, onExited: () => exited.push(true) });
  // 调用方报告 cityReady=true 但引擎布局尚未到位（分页/竞态）：控制器已进入 preparing，
  // ensureRunObjects 失败 → 错误面板。旧实现此时 world/params 为 null，重试会空跑。
  const host = { cityReady: true, cinemaActive: false, filmActive: false, busy: false };
  const failed = await session.enter({ mode: "practice" }, host);
  assert.ok(!failed.ok && failed.reason === "not-ready");
  assert.equal(session.controller.snapshot.phase, "preparing");
  assert.ok(session.controller.snapshot.error, "失败进入错误面板");
  assert.ok(!session.snapshot().telemetry, "失败时不该有模拟读数");
  // 引擎数据到位后重试：必须长出完整模拟对象。
  engine.currentLayout = layout; engine.currentModel = model;
  await session.retryPrepare();
  const snapshot = session.snapshot();
  assert.equal(snapshot.controller.phase, "practice", "重试后进入练习");
  assert.ok(snapshot.telemetry, "重试后必须有模拟读数（telemetry 非空 = sim 存在）");
  assert.ok(session.controller.simulating);
  // 练习 restart 仍可用。
  session.pause("user");
  session.restart();
  assert.equal(session.snapshot().controller.phase, "practice");
  assert.ok(session.snapshot().telemetry);
  session.exit();
  assert.equal(exited.length, 1);
  assert.equal(engine.owner, "orbit", "退出归还相机");
  assert.ok(engine.restored, "退出恢复返回视角");
}

// ── 2) 挑战：倒计时经帧钩子推进到 racing；终态 restart 重建 mission ──
{
  const engine = fakeEngine();
  engine.currentLayout = layout; engine.currentModel = model;
  const session = new GameSession(engine, { onState: () => {}, onExited: () => {} });
  const host = { cityReady: true, cinemaActive: false, filmActive: false, busy: false };
  const entered = await session.enter({ mode: "race" }, host);
  assert.ok(entered.ok, `挑战可进入（${entered.ok ? "" : entered.reason}）`);
  assert.equal(session.snapshot().controller.phase, "countdown");
  assert.ok(session.snapshot().mission, "挑战带任务实例");
  const missionFirst = session.snapshot().mission;
  const courseFirst = session.snapshot().courseId;
  // 帧钩子推进倒计时（3s × 60fps）。
  for (let frame = 0; frame < 200; frame += 1) engine.frame(1 / 60);
  assert.equal(session.snapshot().controller.phase, "racing", "倒计时结束进入比赛");
  // 终态后的 restart：mission 必须是新实例（旧实例已终态，进度会冻结）。
  session.controller.raceFinished();
  assert.equal(session.snapshot().controller.phase, "result");
  session.restart();
  const after = session.snapshot();
  assert.equal(after.controller.phase, "countdown", "重赛回到倒计时");
  assert.ok(after.mission && after.mission !== missionFirst, "restart 重建任务实例");
  assert.equal(after.mission.progress, 0);
  assert.equal(after.courseId, courseFirst, "重试复用原路线（courseId 不变）");
  session.exit();
}

// ── 2b) 结果页「换一条路线」：必须回到倒计时（审查 P1 回归——曾卡死在 result）且
//        variant 恰好 +1（courseId 变化；不双递增到 +2 的可比对）。──
{
  const engine = fakeEngine();
  engine.currentLayout = layout; engine.currentModel = model;
  const session = new GameSession(engine, { onState: () => {}, onExited: () => {} });
  assert.ok((await session.enter({ mode: "race" }, { cityReady: true, cinemaActive: false, filmActive: false, busy: false })).ok);
  for (let frame = 0; frame < 200; frame += 1) engine.frame(1 / 60);
  session.controller.raceFinished();
  assert.equal(session.snapshot().controller.phase, "result");
  const before = session.snapshot().courseId;
  await session.newCourse();
  const afterNew = session.snapshot();
  assert.equal(afterNew.controller.phase, "countdown", "换路线后立即进入新倒计时（不再卡 result）");
  assert.ok(afterNew.mission && afterNew.mission.progress === 0, "新路线带全新任务");
  assert.notEqual(afterNew.courseId, before, "路线身份摘要变化（variant 生效）");
  // 精确校验 variant 单次递增：连续再换一次，与「重试」路径对照——重试不得改 courseId。
  const second = afterNew.courseId;
  session.controller.raceFinished();
  session.restart();
  assert.equal(session.snapshot().courseId, second, "结果页重试不换路线");
  session.exit();
}

// ── 3) 退出后再进入：输入适配器重新挂载（exit 清空 input 引用）──
{
  const engine = fakeEngine();
  engine.currentLayout = layout; engine.currentModel = model;
  const session = new GameSession(engine, { onState: () => {}, onExited: () => {} });
  const host = { cityReady: true, cinemaActive: false, filmActive: false, busy: false };
  assert.ok((await session.enter({ mode: "practice" }, host)).ok);
  const lastSafePose = engine.pose;
  session.world.queryCameraSweep = () => ({ status: "unresolved" });
  engine.frame(1 / 60);
  assert.equal(session.controller.snapshot.phase, "practice", "an unresolved visual-camera query does not stop vehicle simulation");
  assert.deepEqual(engine.pose.position, lastSafePose.position, "unresolved camera query holds the last certified camera position");
  session.exit();
  assert.ok((await session.enter({ mode: "practice" }, host)).ok, "退出后可再次进入");
  assert.ok(session.snapshot().telemetry);
  session.exit();
}

// ── 4) 输入→模拟→遥测 端到端：画布聚焦才生效（审查 P1-2 的会话级回归）──
{
  const engine = fakeEngine();
  engine.currentLayout = layout; engine.currentModel = model;
  const session = new GameSession(engine, { onState: () => {}, onExited: () => {} });
  assert.ok((await session.enter({ mode: "practice" }, { cityReady: true, cinemaActive: false, filmActive: false, busy: false })).ok);
  const cruise = session.snapshot().telemetry.speed;
  // 未聚焦（焦点在宿主控件）：按住 W 推进 2s，速度不得上升。
  documentShim.activeElement = null;
  pressKey("KeyW");
  for (let frame = 0; frame < 120; frame += 1) engine.frame(1 / 60);
  assert.ok(Math.abs(session.snapshot().telemetry.speed - cruise) < 0.5, "未聚焦时 W 不加速");
  releaseKey("KeyW");
  // 画布聚焦：W 推进 2s，速度必须显著上升；松开后回落巡航。
  documentShim.activeElement = engine.domCanvas;
  pressKey("KeyW");
  for (let frame = 0; frame < 120; frame += 1) engine.frame(1 / 60);
  const accelerated = session.snapshot().telemetry.speed;
  assert.ok(accelerated > cruise * 1.2, `聚焦时 W 加速（${cruise} → ${accelerated}）`);
  releaseKey("KeyW");
  for (let frame = 0; frame < 120; frame += 1) engine.frame(1 / 60);
  assert.ok(Math.abs(session.snapshot().telemetry.speed - cruise) < 1.5, "松开后回到巡航");
  // keyup 在未聚焦时也清除（不粘键）：按住→切走焦点→松开→回焦，不应继续加速。
  documentShim.activeElement = engine.domCanvas;
  pressKey("KeyW");
  documentShim.activeElement = null;
  releaseKey("KeyW");
  documentShim.activeElement = engine.domCanvas;
  for (let frame = 0; frame < 60; frame += 1) engine.frame(1 / 60);
  assert.ok(Math.abs(session.snapshot().telemetry.speed - cruise) < 1.5, "未聚焦 keyup 仍清除（无粘键）");
  session.exit();
}

// ── 5) variant 计数（审查 P2-1 回归）：生成失败重试 +1/次；错误面板「换路线」恰好 +1/次 ──
{
  const engine = fakeEngine();
  engine.currentLayout = layout; engine.currentModel = model;
  // 注入「总是失败」的路线工厂：真实布局不会生成失败，无法覆盖 no-course 分支。
  const session = new GameSession(engine, { onState: () => {}, onExited: () => {} }, () => null);
  const host = { cityReady: true, cinemaActive: false, filmActive: false, busy: false };
  const refused = await session.enter({ mode: "race" }, host);
  assert.ok(!refused.ok && refused.reason === "no-course", "注入工厂令生成失败");
  assert.ok(session.controller.snapshot.error, "进入错误面板");
  const v0 = session.snapshot().variant;
  // 错误面板「重试准备」：no-course 失败 → variant +1（仍失败）。
  await session.retryPrepare();
  assert.equal(session.snapshot().variant, v0 + 1, "生成失败的重试换 variant");
  assert.equal(session.world.staticContentRevision, `test-world:${session.controller.snapshot.runId}`,
    "retry rebuilds the frozen flight world when the newly acquired host revision changes");
  // 错误面板「换一条路线」：恰好 +1（曾与重试推断叠加成 +2）。
  await session.newCourse();
  assert.equal(session.snapshot().variant, v0 + 2, "换路线只递增一次");
  await session.newCourse();
  assert.equal(session.snapshot().variant, v0 + 3, "再次换路线仍只 +1");
  session.exit();
}

// Real input/physics/mission success path; never assign progress or teleport the plane.
{
  const engine = fakeEngine();
  engine.currentLayout = layout; engine.currentModel = model;
  const records = [];
  const session = new GameSession(engine, { onState: () => {}, onExited: () => {},
    onRecord: (...record) => records.push(record) });
  assert.ok((await session.enter({ mode: "race" }, { cityReady: true, cinemaActive: false, filmActive: false, busy: false })).ok);
  documentShim.activeElement = engine.domCanvas;
  const held = new Set();
  const setKeys = (next) => {
    for (const code of held) if (!next.has(code)) { releaseKey(code); held.delete(code); }
    for (const code of next) if (!held.has(code)) { pressKey(code); held.add(code); }
  };
  for (let frame = 0; frame < 18000 && session.controller.snapshot.phase !== "result"; frame += 1) {
    const keys = new Set();
    const state = session.sim;
    const target = session.course.rings[session.mission.snapshot().targetIndex];
    if (session.controller.snapshot.phase === "racing") {
      const error = Math.atan2(Math.sin(Math.atan2(target.z - state.z, target.x - state.x) - state.heading),
        Math.cos(Math.atan2(target.z - state.z, target.x - state.x) - state.heading));
      const correction = error - state.turnRate * 0.13;
      if (correction > 0.015) keys.add("KeyD"); // 与 uatPilot.ts 同向：航向增大 = 屏幕右 = D
      else if (correction < -0.015) keys.add("KeyA");
      const heightError = target.y - state.y - state.verticalSpeed * 0.18;
      if (heightError > 0.15) keys.add("ArrowUp");
      else if (heightError < -0.15) keys.add("ArrowDown");
      if (Math.abs(error) > 0.4) keys.add("KeyS");
    }
    setKeys(keys);
    engine.frame(1 / 60);
  }
  setKeys(new Set());
  const result = session.snapshot();
  assert.equal(result.mission.progress, 12, JSON.stringify(result.mission));
  assert.equal(result.mission.result?.finished, true, "keyboard/physics flight finishes all rings");
  assert.equal(records.length, 1, "successful mission emits exactly one persistent record");
  assert.equal(records[0][0], result.courseId);
  session.exit();
}

// UAT adapter uses the same DOM listeners and releases keys/timer on stop.
{
  let tick = null;
  const pilotWindow = { ...windowShim,
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval: () => { tick = null; },
    dispatchEvent: (event) => {
      for (const fn of windowListeners.get(event.type) ?? []) fn(event);
    },
  };
  const { startUatPilot } = load("game/uatPilot.ts", { window: pilotWindow, document: documentShim,
    HTMLCanvasElement: class {}, KeyboardEvent: class {
      constructor(type, options) { this.type = type; Object.assign(this, options); this.target = windowShim; }
      preventDefault() {}
    } });
  const engine = fakeEngine();
  engine.currentLayout = layout; engine.currentModel = model;
  const session = new GameSession(engine, { onState: () => {}, onExited: () => {} });
  assert.ok((await session.enter({ mode: "race" }, { cityReady: true, cinemaActive: false, filmActive: false, busy: false })).ok);
  documentShim.activeElement = engine.domCanvas;
  const stop = startUatPilot(session, engine);
  for (let frame = 0; frame < 18000 && session.controller.snapshot.phase !== "result"; frame += 1) {
    tick?.(); engine.frame(1 / 60);
  }
  assert.equal(session.snapshot().mission.result?.finished, true, "UAT driver flies the actual physics route");
  tick?.();
  assert.equal(tick, null, "result clears timer");
  stop(); stop(); // idempotent cleanup
  assert.deepEqual(JSON.parse(JSON.stringify(session.input.snapshot())), {
    throttleUp: false, throttleDown: false, turnLeft: false, turnRight: false, pitchUp: false, pitchDown: false,
  });
  session.exit();
}

// Shared-clock migration: full flight session is frame-rate independent, and
// overload uses the same bounded time-drop policy as the car runtime.
{
  const results = [];
  for (const hz of [30, 60, 120]) {
    const engine = fakeEngine(); engine.currentLayout = layout; engine.currentModel = model;
    const session = new GameSession(engine, { onState() {}, onExited() {} });
    assert.equal((await session.enter({ mode: "practice" }, { cityReady: true, cinemaActive: false, filmActive: false, busy: false })).ok, true);
    documentShim.activeElement = engine.domCanvas; pressKey("KeyW"); pressKey("KeyD");
    for (let frame = 0; frame < hz * 2; frame++) {
      if (frame === hz) releaseKey("KeyD");
      engine.frame(1 / hz);
    }
    results.push({ ...session.sim });
    const beforeOverload = session.sim.simTime;
    engine.frame(0.2);
    assert.equal(session.controller.snapshot.paused, null, "shared overload policy keeps the activity running");
    assert.ok(Math.abs(session.sim.simTime - beforeOverload - 5 / 60) < 1e-9, "overload advances at most five fixed ticks");
    engine.frame(NaN);
    assert.equal(session.controller.snapshot.paused?.reason, "lag", "invalid frame deltas still visibly pause");
    session.exit();
  }
  for (const result of results.slice(1)) for (const field of ["x", "y", "z", "heading", "speed", "verticalSpeed", "bank", "simTime"])
    assert.ok(Math.abs(result[field] - results[0][field]) < 1e-9, `shared clock changed flight ${field}`);
}
// A compact deterministic race crosses one real physics-driven ring at 30/60/120 Hz.
// It exercises countdown, the five-tick overload cap, timeout, and exactly-once
// settlement without running the long generated-course acceptance routes below.
{
  const courseFactory = ({ world, params, variant, citySeed, physicsVersion }) => {
    const base = world.findSafeSpawn(params.planeRadius + 1.5, params.planeRadius * 5.2, params.planeRadius * 2.4);
    if (!base) return null;
    const nx = Math.cos(base.heading), nz = Math.sin(base.heading);
    const back = Math.max(params.maxSpeed * 1.6, 30);
    return { kind: "generated", rings: [{ x: base.x + nx * (back + 8), y: base.y, z: base.z + nz * (back + 8), nx, ny: 0, nz, radius: 30 }],
      timeLimitMs: 20_000, referenceMs: 2_000, ringRadius: 30, courseId: `small-race:${citySeed}:${physicsVersion}:${variant}`, variant };
  };
  for (const hz of [30, 60, 120]) {
    const engine = fakeEngine(); engine.currentLayout = layout; engine.currentModel = model;
    const records = [];
    const session = new GameSession(engine, { onState() {}, onExited() {}, onRecord: (...record) => records.push(record) }, courseFactory);
    assert.equal((await session.enter({ mode: "race" }, { cityReady: true, cinemaActive: false, filmActive: false, busy: false })).ok, true);
    // Fractional render deltas (especially 120 Hz) do not land on an exact
    // fixed-tick boundary, so give the countdown one small bounded margin.
    for (let frame = 0; frame < hz * 3 + 10; frame++) engine.frame(1 / hz);
    assert.equal(session.controller.snapshot.phase, "racing", `${hz} Hz countdown settles at its deadline`);
    const elapsedBeforeDrop = session.snapshot().mission.elapsedMs;
    engine.frame(0.2);
    assert.equal(session.controller.snapshot.phase, "racing", "bounded long frame does not timeout or pause the race");
    assert.ok(Math.abs(session.snapshot().mission.elapsedMs - elapsedBeforeDrop - 5 * 1000 / 60) < 1e-9, "long frame advances exactly five fixed ticks");
    for (let frame = 0; frame < hz * 4 && session.controller.snapshot.phase !== "result"; frame++) engine.frame(1 / hz);
    assert.equal(session.snapshot().mission.result?.finished, true, `${hz} Hz actual flight crosses the deterministic ring`);
    const settled = session.snapshot().mission.result;
    for (let frame = 0; frame < hz; frame++) engine.frame(1 / hz);
    assert.deepEqual(session.snapshot().mission.result, settled, "result remains settled after additional frames");
    assert.equal(records.length, 1, "race records exactly once");
    session.exit();
  }
  // A genuinely unreachable ring times out through the same mission/runtime path.
  const timeoutCourse = ({ world, params, variant, citySeed, physicsVersion }) => {
    const base = world.findSafeSpawn(params.planeRadius + 1.5, params.planeRadius * 5.2, params.planeRadius * 2.4);
    if (!base) return null;
    return { kind: "generated", rings: [{ x: base.x + 1_000_000, y: base.y, z: base.z, nx: 1, ny: 0, nz: 0, radius: 30 }],
      timeLimitMs: 500, referenceMs: 500, ringRadius: 30, courseId: `timeout-race:${citySeed}:${physicsVersion}:${variant}`, variant };
  };
  const engine = fakeEngine(); engine.currentLayout = layout; engine.currentModel = model;
  const records = [], session = new GameSession(engine, { onState() {}, onExited() {}, onRecord: (...record) => records.push(record) }, timeoutCourse);
  assert.equal((await session.enter({ mode: "race" }, { cityReady: true, cinemaActive: false, filmActive: false, busy: false })).ok, true);
  for (let frame = 0; frame < 300 && session.controller.snapshot.phase !== "result"; frame++) engine.frame(1 / 60);
  assert.equal(session.snapshot().mission.result?.finished, false, "unreachable course times out");
  assert.equal(records.length, 0, "timeout does not persist a success record");
  session.exit();
}
// A stale world releases ownership and can prepare a new flight activity.
{
  const engine = fakeEngine(); engine.currentLayout = layout; engine.currentModel = model;
  const session = new GameSession(engine, { onState() {}, onExited() {} });
  assert.equal((await session.enter({ mode: "practice" }, { cityReady: true, cinemaActive: false, filmActive: false, busy: false })).ok, true);
  engine.currentModel = { ...model }; engine.frame(1 / 60);
  assert.equal(session.controller.snapshot.error?.message, "stale-game-world");
  assert.equal(engine.owner, "orbit"); assert.equal(session.snapshot().telemetry, null);
  await session.retryPrepare();
  assert.equal(session.controller.snapshot.error, null); assert.ok(session.snapshot().telemetry);
  session.exit();
}
// 点机场飞机：出生在跑道正上方的练习巡航高度，追尾相机当场写上，而不是贴着 1.4 的跑道面。
{
  const engine = fakeEngine(); engine.currentLayout = layout; engine.currentModel = model;
  engine.renderCamera.position.set(500, 120, 500);
  engine.renderCamera.lookAt(0, 0, 0);
  const session = new GameSession(engine, { onState() {}, onExited() {} });
  const origin = { x: layout.islandRadius + 120, y: 1.4, z: layout.islandRadius + 40, heading: 0.6 };
  assert.equal((await session.enter({ mode: "practice" }, { cityReady: true, cinemaActive: false, filmActive: false, busy: false }, origin)).ok, true);
  const sim = session.sim;
  const params = session.params;
  const cruise = session.world.flightAltitude(params.planeRadius + 1.5);
  assert.equal(sim.x, origin.x, "runway takeoff keeps the runway x");
  assert.equal(sim.z, origin.z, "runway takeoff keeps the runway z");
  assert.equal(sim.heading, origin.heading, "runway takeoff keeps the runway heading");
  assert.ok(sim.y + 1e-6 >= cruise, `runway takeoff uses flight altitude (got ${sim.y}, cruise ${cruise})`);
  assert.ok(sim.y > origin.y + params.planeRadius * 12, "runway takeoff is not the just-off-the-deck lift");
  const speedRatio = (params.cruiseSpeed - params.minSpeed) / (params.maxSpeed - params.minSpeed);
  const back = params.planeRadius * 5.2 * (1 + 0.35 * speedRatio);
  const camX = sim.x - Math.cos(sim.heading) * back;
  const camY = sim.y + params.planeRadius * 2.4;
  const camZ = sim.z - Math.sin(sim.heading) * back;
  assert.ok(engine.pose, "entry writes a chase camera");
  const [px, py, pz] = engine.pose.position;
  assert.ok(Math.hypot(px - camX, py - camY, pz - camZ) < 1.5, `chase camera follows the aircraft (got ${px.toFixed(1)},${py.toFixed(1)},${pz.toFixed(1)})`);
  assert.ok(Math.hypot(px - 500, py - 120, pz - 500) > 50, "camera left the pre-click orbit pose");
  session.exit();
}
console.log("verify-city-game-session: ok");
