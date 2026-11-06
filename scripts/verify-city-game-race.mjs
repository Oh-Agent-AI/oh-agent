#!/usr/bin/env node
// 穿环任务守卫（§12 路线/穿环/计时）：
// 1) 20 固定种子 × 0/1/90/500 会话：路线要么有效（12 环、净空、间距、走廊、限时公式），
//    要么明确 null；同输入完全一致；variant 变化产出不同路线；
// 2) 穿环判定：正向圆内计、高速跨步计、反向不计、擦边不计、越序不计、
//    同一步多环按 t 排序连计、重置瞬移不计；
// 3) 计时：倒计时不偷跑、终态只结算一次、罚时 3s 与 1s 保护窗、
//    最后一环临界时刻（截止及之前算成功）、超时判定按 耗时+罚时；
// 4) 可飞性（v3 回归）：每组相邻三环转弯可行（偏转 ≤135°、下一环在巡航转弯圆外）、法线朝来向，
//    并用与会话守卫同款的追踪驾驶员按真实物理把每条路线飞完——v2 曾让环法线取平滑曲线切线，
//    seed 42 / 40 会话（city-opt 布局）的环 8 法线与来向夹角 148°，飞机绕环打转到超时。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { buildCityModel, layoutCity, FlightWorld, flightParamsFor, stepFlight, initialSimState, generateRaceCourse, COURSE_VERSION,
  RaceMission, ringCrossing, COUNTDOWN_MS, COLLISION_PENALTY_MS } = await loadCity({
  "cityModel.ts": ["buildCityModel"], "engine/cityLayout.ts": ["layoutCity"], "game/FlightWorld.ts": ["FlightWorld"],
  "game/FlightSimulation.ts": ["flightParamsFor", "stepFlight", "initialSimState"], "game/RaceCourse.ts": ["generateRaceCourse", "COURSE_VERSION"],
  "game/RaceMission.ts": ["RaceMission", "ringCrossing", "COUNTDOWN_MS", "COLLISION_PENALTY_MS"],
});

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 1);
const tokens = (total) => ({ uncached_input_tokens: total, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total });
function modelOf(count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const first = now - DAY * 29 + index * 3_600_000;
    rows.push({ session_ref: `s:${index}`, harness: index % 2 ? "harness:zcode" : "harness:claude", first_event_at: new Date(first).toISOString(), last_event_at: new Date(first + 7_200_000).toISOString(),
      event_count: 10, model_ids: [], tokens: tokens(50_000 + (index % 37) * 900_000), peak_tokens: 0, cost_minor: null,
      cost_status: { state: "unavailable", reason: "test", has_unresolved: false } });
  }
  return buildCityModel({ rows, findings: [], windowStartMs: now - DAY * 30, windowEndMs: now, windowLabel: "30d",
    totalSessions: count, truncated: false, generatedAt: now });
}

// 独立于生成器的可飞性判定（不调用 RaceCourse 的实现，免得同一处错误互相印证）。
function assertTurnFeasible(course, params, label) {
  const R = params.cruiseSpeed / params.turnRate;
  const rings = course.rings;
  for (let index = 0; index < rings.length; index += 1) {
    const ring = rings[index];
    const prev = rings[index - 1];
    const next = rings[index + 1];
    if (prev) {
      const dot = (ring.x - prev.x) * ring.nx + (ring.y - prev.y) * ring.ny + (ring.z - prev.z) * ring.nz;
      assert.ok(dot > 0, `${label} 环 ${index} 法线背对来向（只能飞过头再掉头回穿）`);
    }
    if (next) {
      const dot = (next.x - ring.x) * ring.nx + (next.y - ring.y) * ring.ny + (next.z - ring.z) * ring.nz;
      assert.ok(dot > 0, `${label} 环 ${index} 法线背对去向`);
    }
    if (!prev || !next) continue;
    const inX = ring.x - prev.x, inZ = ring.z - prev.z, outX = next.x - ring.x, outZ = next.z - ring.z;
    const outLength = Math.hypot(outX, outZ);
    const turn = Math.acos(Math.max(-1, Math.min(1, (inX * outX + inZ * outZ) / (Math.hypot(inX, inZ) * outLength))));
    assert.ok(turn <= (135 * Math.PI) / 180 + 1e-9, `${label} 环 ${index - 1}→${index}→${index + 1} 偏转 ${(turn * 180 / Math.PI).toFixed(0)}° 超过 135°`);
    const need = 2 * R * Math.sin(Math.min(turn, Math.PI / 2)) + ring.radius;
    assert.ok(outLength >= need - 1e-6, `${label} 环 ${index}→${index + 1} 距离 ${outLength.toFixed(0)} < 转弯所需 ${need.toFixed(0)}`);
  }
}
// 追踪驾驶员（与 verify-city-game-session / uatPilot 同一套键位逻辑），真实 stepFlight + RaceMission，无碰撞。
function flyCourse(course, params) {
  const first = course.rings[0];
  const back = Math.max(params.maxSpeed * 1.6, 30); // GameSession.spawnFor 的挑战出生点
  let state = initialSimState({ x: first.x - first.nx * back, y: first.y, z: first.z - first.nz * back, heading: Math.atan2(first.nz, first.nx) }, params);
  const mission = new RaceMission(course, params);
  mission.tickCountdown(COUNTDOWN_MS);
  for (let frame = 0; frame < 30_000 && mission.snapshot().status === "racing"; frame += 1) {
    const target = course.rings[mission.snapshot().targetIndex];
    const angle = Math.atan2(target.z - state.z, target.x - state.x) - state.heading;
    const error = Math.atan2(Math.sin(angle), Math.cos(angle));
    const correction = error - state.turnRate * 0.13;
    const height = target.y - state.y - state.verticalSpeed * 0.18;
    const input = { turnRight: correction > 0.015, turnLeft: correction < -0.015, pitchUp: height > 0.15, pitchDown: height < -0.15,
      throttleUp: false, throttleDown: Math.abs(error) > 0.4 };
    const next = stepFlight(state, input, 1 / 60, params);
    mission.step(state, next, 1000 / 60);
    state = next;
  }
  return mission.snapshot();
}

// ── 1) 路线生成：20 种子 × 会话规模 ──
const SEEDS = [1, 3, 7, 11, 19, 23, 42, 55, 61, 77, 89, 97, 101, 127, 191, 233, 397, 521, 743, 997];
let generated = 0;
let fallbacks = 0;
let nulls = 0;
const sampleCache = new Map();
for (const sessionCount of [0, 1, 90, 500]) {
  for (const seed of SEEDS) {
    const model = modelOf(sessionCount);
    const layout = layoutCity(model, null, seed, null, "auto");
    const world = new FlightWorld({ layout, model, cursorMs: null });
    const params = flightParamsFor(Math.hypot(layout.urbanBounds.right - layout.urbanBounds.left, layout.urbanBounds.south - layout.urbanBounds.north));
    const course = generateRaceCourse({ world, params, citySeed: seed, physicsVersion: 1, variant: 0 });
    if (!course) { nulls += 1; continue; }
    if (course.kind === "fallback") fallbacks += 1; else generated += 1;
    assert.equal(course.rings.length, 12, `${seed}/${sessionCount} 环数`);
    assert.ok(Math.abs(course.timeLimitMs - course.referenceMs * 1.6) <= 2, `${seed}/${sessionCount} 限时公式`);
    for (let index = 0; index < course.rings.length; index += 1) {
      const ring = course.rings[index];
      const next = course.rings[(index + 1) % course.rings.length];
      for (const value of [ring.x, ring.y, ring.z, ring.nx, ring.ny, ring.nz]) assert.ok(Number.isFinite(value), `${seed}/${sessionCount} 环字段有限`);
      const norm = Math.hypot(ring.nx, ring.ny, ring.nz);
      assert.ok(Math.abs(norm - 1) < 1e-6, `${seed}/${sessionCount} 法线单位化`);
      assert.ok(world.isPointClear(ring.x, ring.y, ring.z, ring.radius), `${seed}/${sessionCount} 环 ${index} 净空`);
      const spacing = Math.hypot(next.x - ring.x, next.y - ring.y, next.z - ring.z);
      assert.ok(spacing >= params.maxSpeed * 1.2 - 1e-6, `${seed}/${sessionCount} 环 ${index} 间距（反应时间）`);
    }
    assertTurnFeasible(course, params, `${seed}/${sessionCount}`);
    const flown = flyCourse(course, params);
    assert.equal(flown.progress, 12, `${seed}/${sessionCount} ${course.kind} 路线追踪飞行未完成：${JSON.stringify(flown)}`);
    if (sessionCount === 90 && seed === SEEDS[0]) sampleCache.set("baseline", { world, params, digest: JSON.stringify(course.rings.map((r) => [r.x, r.y, r.z])) , courseId: course.courseId });
  }
}
assert.ok(generated + fallbacks > 0, "至少一条有效路线");
// 同输入确定性 + variant 区分。
{
  const model = modelOf(90);
  const layout = layoutCity(model, null, SEEDS[0], null, "auto");
  const world = new FlightWorld({ layout, model, cursorMs: null });
  const params = flightParamsFor(400);
  const a = generateRaceCourse({ world, params, citySeed: SEEDS[0], physicsVersion: 1, variant: 0 });
  const b = generateRaceCourse({ world, params, citySeed: SEEDS[0], physicsVersion: 1, variant: 0 });
  assert.ok(a && b);
  assert.equal(a.courseId, b.courseId, "同输入同路线 id");
  assert.equal(JSON.stringify(a.rings), JSON.stringify(b.rings), "同输入同环几何");
  let differs = 0;
  for (const variant of [1, 2, 3, 4]) {
    const c = generateRaceCourse({ world, params, citySeed: SEEDS[0], physicsVersion: 1, variant });
    if (c && c.courseId !== a.courseId) differs += 1;
  }
  assert.ok(differs >= 3, "variant 变化应产生不同路线");
}

// ── 1b) 钉住会话守卫的布局（seed 42、40 会话，与 verify-city-game-session 同一份数据）──
// city-opt 布局上 v2 生成了 150° 发卡弯 + 背向法线的环 8；生成器换布局后这里仍须可飞。
{
  const rows = Array.from({ length: 40 }, (_, index) => {
    const first = now - DAY * 29 + index * 3_600_000;
    return { session_ref: `s:${index}`, harness: index % 2 ? "harness:zcode" : "harness:claude", first_event_at: new Date(first).toISOString(), last_event_at: new Date(first + 7_200_000).toISOString(),
      event_count: 10, model_ids: [], tokens: tokens(50_000 + (index % 37) * 900_000), peak_tokens: 0, cost_minor: null,
      cost_status: { state: "unavailable", reason: "test", has_unresolved: false } };
  });
  const model = buildCityModel({ rows, findings: [], windowStartMs: now - DAY * 30, windowEndMs: now, windowLabel: "30d",
    totalSessions: rows.length, truncated: false, generatedAt: now });
  const layout = layoutCity(model, null, 42, null, "auto");
  const world = new FlightWorld({ layout, model, cursorMs: null });
  const params = flightParamsFor(Math.hypot(layout.urbanBounds.right - layout.urbanBounds.left, layout.urbanBounds.south - layout.urbanBounds.north));
  for (const variant of [0, 1, 2]) {
    const course = generateRaceCourse({ world, params, citySeed: 42, physicsVersion: 1, variant });
    assert.ok(course, `seed42/40 v${variant} 应有路线`);
    assertTurnFeasible(course, params, `seed42/40 v${variant}`);
    const flown = flyCourse(course, params);
    assert.equal(flown.progress, 12, `seed42/40 v${variant} 追踪飞行未完成：${JSON.stringify(flown)}`);
    assert.equal(flown.result?.finished, true, `seed42/40 v${variant} 限时内完成`);
  }
}

// ── 2) 穿环判定（合成环）──
const RING = { x: 0, y: 100, z: 0, nx: 1, ny: 0, nz: 0, radius: 10 };
const courseOf = (rings) => ({ kind: "generated", rings, timeLimitMs: 60_000, referenceMs: 37_500, ringRadius: 10, courseId: "test", variant: 0 });
const params10 = flightParamsFor(350);
{
  assert.ok(ringCrossing(RING, { x: -5, y: 100, z: 0 }, { x: 5, y: 100, z: 0 }, 1.5), "正向圆内穿越计");
  assert.ok(ringCrossing(RING, { x: -80, y: 100, z: 0 }, { x: 80, y: 100, z: 0 }, 1.5), "高速跨步（扫掠）计");
  assert.equal(ringCrossing(RING, { x: 5, y: 100, z: 0 }, { x: -5, y: 100, z: 0 }, 1.5), null, "反向进入不计");
  assert.equal(ringCrossing(RING, { x: -5, y: 109, z: 0 }, { x: 5, y: 109, z: 0 }, 1.5), null, "擦过外圈不计");
  assert.equal(ringCrossing(RING, { x: -1, y: 100, z: 0 }, { x: -0.5, y: 100, z: 0 }, 1.5), null, "没跨过环面不计");
}
{
  // 越序 + 同一步多环 + 瞬移。
  const ringA = { ...RING };
  const ringB = { x: 40, y: 100, z: 0, nx: 1, ny: 0, nz: 0, radius: 10 };
  const mission = new RaceMission(courseOf([ringA, ringB]), params10);
  for (let tick = 0; tick < 200 && mission.snapshot().status === "countdown"; tick += 1) mission.tickCountdown(16.67);
  assert.equal(mission.snapshot().status, "racing", "倒计时结束进入比赛");
  // 先跨 ringB（越序）：不计。
  let events = mission.step({ x: 30, y: 100, z: 0 }, { x: 50, y: 100, z: 0 }, 16.67);
  assert.equal(mission.snapshot().progress, 0, "越序不计");
  // 同一步跨 A(t≈0.05) 与 B(t≈0.55)：按 t 排序连计两环。
  events = mission.step({ x: -10, y: 100, z: 0 }, { x: 60, y: 100, z: 0 }, 16.67);
  assert.equal(mission.snapshot().progress, 2, "同一步多环连计");
  assert.equal(events.filter((event) => event.type === "ring-passed").length, 2);
  assert.equal(mission.snapshot().status, "finished", "终点环到达即完成");
  assert.ok(events.some((event) => event.type === "finished"));
  // 终态后不再结算/推进。
  assert.equal(mission.step({ x: 60, y: 100, z: 0 }, { x: 70, y: 100, z: 0 }, 16.67).length, 0, "终态只结算一次");
}
{
  // 重置瞬移不参与穿环检测。
  const mission = new RaceMission(courseOf([{ ...RING }]), params10);
  mission.tickCountdown(COUNTDOWN_MS);
  mission.step({ x: -5, y: 100, z: 0 }, { x: 5, y: 100, z: 0 }, 16.67, true);
  assert.equal(mission.snapshot().progress, 0, "瞬移步不判穿环");
}

// ── 3) 计时与罚时 ──
{
  const mission = new RaceMission(courseOf([{ ...RING }]), params10);
  // 倒计时期间 elapsed 不偷跑。
  for (let tick = 0; tick < 200; tick += 1) mission.tickCountdown(16.67);
  assert.equal(mission.snapshot().status, "racing");
  assert.equal(mission.snapshot().elapsedMs, 0, "倒计时不推进任务时钟");
  // 罚时 3s；1s 保护窗内重复碰撞只罚一次。
  mission.onCollision();
  assert.equal(mission.snapshot().penaltyMs, COLLISION_PENALTY_MS);
  mission.onCollision();
  assert.equal(mission.snapshot().penaltyMs, COLLISION_PENALTY_MS, "保护窗内不重复扣罚");
  for (let step = 0; step < 61; step += 1) mission.step({ x: -1000, y: 100, z: 0 }, { x: -1000 + 5, y: 100, z: 0 }, 16.67);
  mission.onCollision();
  assert.equal(mission.snapshot().penaltyMs, COLLISION_PENALTY_MS * 2, "保护窗过后再罚");
}
{
  // 最后一环临界：交点时刻+罚时 == 截止 → 成功；略晚 → 失败。
  const limitCourse = courseOf([{ ...RING }]);
  limitCourse.timeLimitMs = 10_000;
  const finishAt = (elapsedBefore, offsetUnits) => {
    const mission = new RaceMission(limitCourse, params10);
    mission.tickCountdown(COUNTDOWN_MS);
    // 直接改内部状态的替代：用 step 推进 elapsed（远离环直线飞）。
    let elapsed = 0;
    while (elapsed + 16.67 < elapsedBefore) { mission.step({ x: -2000 - elapsed / 100, y: 100, z: 0 }, { x: -2000 - (elapsed + 16.67) / 100, y: 100, z: 0 }, 16.67); elapsed += 16.67; }
    const events = mission.step({ x: -5 + offsetUnits, y: 100, z: 0 }, { x: 5 + offsetUnits, y: 100, z: 0 }, 16.67);
    return { status: mission.snapshot().status, finished: events.some((event) => event.type === "finished") };
  };
  // elapsedBefore=5000、dt=16.67、交点约 t=0.5 → 交点时刻 ≈ 5008ms ≤ 10000：成功。
  assert.equal(finishAt(5000, 0).status, "finished", "截止前完成");
  // 把 elapsed 推到 9990：交点 ≈ 9998 ≤ 10000 仍成功（截止时刻及之前）。
  assert.equal(finishAt(9990, 0).status, "finished", "截止时刻及之前完成算成功");
  // elapsed 推到 10000+：超时失败（穿环与超时同一步，交点晚于截止）。
  assert.equal(finishAt(10010, 0).status, "failed", "交点晚于截止判失败");
  // 纯超时：不穿环，直飞到时限 → failed 一次。
  const mission = new RaceMission(limitCourse, params10);
  mission.tickCountdown(COUNTDOWN_MS);
  let failed = 0;
  for (let step = 0; step < 700; step += 1) {
    const events = mission.step({ x: -3000 - step, y: 100, z: 0 }, { x: -3001 - step, y: 100, z: 0 }, 16.67);
    if (events.some((event) => event.type === "failed")) failed += 1;
  }
  assert.equal(failed, 1, "超时只结算一次");
}

console.log(`verify-city-game-race: ok (course stats: generated=${generated}, fallback=${fallbacks}, unavailable=${nulls})`);
