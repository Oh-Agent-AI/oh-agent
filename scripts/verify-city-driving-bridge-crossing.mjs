#!/usr/bin/env node
// 桥梁可通行（bridge crossing）：桥面板实体顶面沿桥纵坡倾斜且落地端向路上方悬挑，
//   其全局 maxY 必然高出桥头路面支撑——若无 mountableHeight 注解（且全链透传），
//   车会被永远挡在桥头（用户实测「无法上桥/无法过桥」的根因）。
//   本脚本在确定性演示城（280 会话、layoutCity seed 74031）里走真实管线
//   （compileCitySurface → compileCitySolidInputs → env(gameplay)）断言：
//   1) 梁桥双端：从真实引道出发，全物理跨桥并驶出对岸至少整车长；
//   2) 悬索桥接地端：从真实引道驶向封闭端，在护栏前安全停住，不声称已通桥；
//   3) 桥下净空保持：桥面板可越只放宽「顶面唇边」，桥底/侧面仍阻挡；
//   4) mountableHeight 真路径透传：编译输出的岛缘 prism 与桥面 slab 都带注解。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const k = await loadCity({
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/surface/compileSurface.ts": ["compileCitySurface"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "engine/surface/compileCitySolidInputs.ts": ["compileCitySolidInputs"],
  "game/driving/ContinuousDrivingEnvironment.ts": ["ContinuousDrivingEnvironment"],
  "game/driving/surfaceFootprint.ts": ["GAMEPLAY_FOOTPRINT_PARAMS"],
  "game/driving/CollisionIndex.ts": ["carBody"],
  "game/driving/cameraCollisionQuery.ts": ["createCameraCollisionQuery", "CAMERA_COLLISION_QUERY_VERSION"],
  "game/driving/vehicleFootprint.ts": ["GAMEPLAY_DRIVING_FOOTPRINT", "GAMEPLAY_COLLISION_INSET"],
  "game/carDimensions.ts": ["CAR_DIMENSIONS"],
  "game/DrivingSimulation.ts": ["stepDriving", "initialDrivingState", "DRIVING_PARAMS"],
  "game/driving/DrivingKernel.ts": ["DrivingKernel"],
  "game/VehicleChaseCamera.ts": ["VehicleChaseCamera"],
  "engine/cityRoadJunctions.ts": ["renderRoadEdges"],
});
const { buildCityModel } = await loadCity({ "cityModel.ts": ["buildCityModel"] });

// ── 确定性演示会话（与 ?demo=1 相同的 mulberry32 种子与条数）──
let seed = 0x63697479;
const random = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const windowEndMs = Date.parse("2026-10-03T00:00:00Z");
const sessions = [];
for (let i = 0; i < 280; i += 1) {
  const daysAgo = Math.floor(random() * 300); const dayStart = windowEndMs - (daysAgo + 1) * 86400000;
  const start = dayStart + Math.floor(random() * 10 + 1) * 3600000;
  const input = 3000 + Math.floor(random() * 90000); const output = 800 + Math.floor(random() * 12000);
  sessions.push({ session_ref: `demo-session-${i}`, harness: random() < 0.5 ? "codex" : "claude_code",
    first_event_at: new Date(start).toISOString(), last_event_at: new Date(start + 3600000).toISOString(),
    event_count: 1, peak_tokens: input + output, model_ids: [],
    tokens: { uncached_input_tokens: input, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: output, total: input + output },
    cost_minor: null, cost_status: { state: "unavailable", reason: "x", has_unresolved: true } });
}
const model = buildCityModel({ harnessNames: { codex: "Codex", claude_code: "Claude Code" }, rows: sessions, findings: [],
  windowStartMs: 0, windowEndMs: 1, windowLabel: "demo", totalSessions: 280, truncated: false, generatedAt: 0 });
const layout = k.layoutCity(model, null, 74031);
const compiled = k.compileCitySurface(layout, {});
const obstacles = compiled.obstacles ?? compiled.surface.obstacles ?? [];

// ── 真实固态编译管线（descriptor 透传在此路径上生效）──
const solid = k.compileCitySolidInputs({ revision: "bridge-crossing", worldRevision: "bridge-crossing", obstacles, sceneSolids: [], renderedSolids: [] });
assert.equal(solid.status, "ready", `solid compile: ${solid.status}`);
const solids = solid.collisionIndex.solids();

// 透传锁：岛缘 prism 与桥面 slab 必须带着 mountableHeight 到达索引层。
const islandMountable = solids.filter((s) => s.role === "island" && s.mountableHeight !== undefined);
assert.ok(islandMountable.length > 0, "island prisms must carry mountableHeight through compileCitySolidInputs (descriptor passthrough)");
const decks = solids.filter((s) => s.role === "bridge-deck");
assert.ok(decks.length > 0 && decks.every((s) => s.mountableHeight !== undefined), "every bridge-deck slab must be mountable-annotated");
for (const s of decks) assert.ok(s.mountableHeight >= 0.3 && s.mountableHeight <= 0.9, `deck budget in [0.3,0.9]: ${s.id} ${s.mountableHeight}`);

// ── fixture 锚点：两座桥的坐标（防 planner 漂移静默改掉本测试的城市）──
const landings = compiled.landings ?? [];
const find = (idPrefix, end) => {
  const hit = landings.find((l) => l.structureId.startsWith(idPrefix) && l.end === end);
  assert.ok(hit, `landing ${idPrefix}/${end} missing — planner drift?`);
  return hit;
};
const beamFrom = find("bridge:-120.36:-735.63/-161.72:-732.43", "from");
const beamTo = find("bridge:-120.36:-735.63/-161.72:-732.43", "to");
const redFrom = find("bridge:-682.66:-197.6/", "from");
const redTo = find("bridge:-682.66:-197.6/", "to");
assert.equal(beamFrom.status, "aligned"); assert.equal(beamTo.status, "aligned");
assert.equal(redFrom.status, "aligned"); assert.equal(redTo.status, "no-ground");

// 断头端：没有接地道路端点，且远端有护栏实体（诚实封闭）。
const edges = k.renderRoadEdges(layout.roadEdges).filter((e) => !e.bridge && e.structure !== "deck");
const landsAt = (x, z) => edges.some((e) => e.points.some((p) => Math.abs(p.x - x) < 0.05 && Math.abs(p.z - z) < 0.05));
assert.ok(landsAt(-120.36, -735.63) && landsAt(-161.72, -732.43) && landsAt(-682.66, -197.6), "crossable bridgeheads land on ground roads");
assert.ok(!landsAt(-732.79, -236.41), "red bridge far end must have no ground road (dead end)");
const deadEndRailing = solids.filter((s) => s.role === "bridge-railing" && Math.abs((s.minX + s.maxX) / 2 + 732.79) < 4 && Math.abs((s.minZ + s.maxZ) / 2 + 236.41) < 4);
assert.ok(deadEndRailing.length > 0, "dead-end barrier must exist at the unlanded end");

// ── 从实际地面引道驶上桥，沿桥轴跨过并驶入对岸道路 ──
const regions = k.buildSurfaceRegions(compiled.surface, k.buildSurfaceIndex(compiled.surface));
assert.equal(regions.status, "ready");
const car = k.CAR_DIMENSIONS;
const dims = { halfLength: Math.max(0.1, car.length / 2 - k.GAMEPLAY_COLLISION_INSET), halfWidth: Math.max(0.1, car.width / 2 - k.GAMEPLAY_COLLISION_INSET), halfHeight: car.height / 2 };
const env = new k.ContinuousDrivingEnvironment(regions, {
  surfaceRevision: regions.revision, worldRevision: "bridge-crossing", solidRevision: "bridge-crossing",
  solids, dimensions: dims, centerHeight: dims.halfHeight, isCurrent: () => true,
}, k.GAMEPLAY_DRIVING_FOOTPRINT, k.GAMEPLAY_FOOTPRINT_PARAMS, {}, { boundarySlide: true, mountablePolicy: "gameplay" });

const endpoint = (edge, p) => edge.points.findIndex((q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.05);
const segmentClosest = (p, a, b) => {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)));
  const q = { x: a.x + dx * t, z: a.z + dz * t };
  return { q, distance: Math.hypot(p.x - q.x, p.z - q.z) };
};
const groundEdges = layout.roadEdges.filter((edge) => !edge.bridge && edge.structure !== "deck");
const nearestGroundCenterline = (p) => {
  let best = null;
  for (const edge of groundEdges) for (let i = 1; i < edge.points.length; i += 1) {
    const hit = segmentClosest(p, edge.points[i - 1], edge.points[i]);
    if (!best || hit.distance < best.distance) best = { ...hit, edge };
  }
  return best;
};
const feederStart = (name, ax, az, heading) => {
  const a = { x: ax, z: az };
  const deck = layout.roadEdges.find((edge) => edge.bridge && edge.structure === "deck" && edge.points.some((p) => Math.hypot(p.x - ax, p.z - az) < 0.05));
  assert.ok(deck, `${name}: compiled bridge centerline exists`);
  const endpointIndex = endpoint(deck, a);
  assert.notEqual(endpointIndex, -1, `${name}: bridge approach endpoint is explicit in compiled road graph`);
  const node = endpointIndex === 0 ? deck.from : deck.to;
  const feeders = groundEdges.filter((edge) => edge.from === node || edge.to === node);
  assert.ok(feeders.length > 0, `${name}: approach connects to a compiled ground-road graph node`);
  let selected = null;
  for (const edge of feeders) {
    const points = edge.to === node ? edge.points : [...edge.points].reverse();
    const last = points[points.length - 1], before = points[points.length - 2];
    const tx = last.x - before.x, tz = last.z - before.z, length = Math.hypot(tx, tz) || 1;
    const alignment = (tx * Math.cos(heading) + tz * Math.sin(heading)) / length;
    if (!selected || alignment > selected.alignment) selected = { edge, points, alignment };
  }
  assert.ok(selected && selected.alignment > 0.85, `${name}: feeder road points into the bridge (${selected?.alignment})`);
  const edgeLength = selected.edge.points.reduce((sum, p, i) => i ? sum + Math.hypot(p.x - selected.edge.points[i - 1].x, p.z - selected.edge.points[i - 1].z) : 0, 0);
  const maxRemaining = Math.min(10, edgeLength - 0.5);
  assert.ok(maxRemaining >= 3, `${name}: actual feeder contains at least 3m of approach before the bridge`);
  for (let offset = maxRemaining; offset >= 3; offset -= 0.5) {
    let remaining = offset;
    for (let i = selected.points.length - 1; i > 0; i -= 1) {
      const end = selected.points[i], start = selected.points[i - 1], length = Math.hypot(end.x - start.x, end.z - start.z);
      if (remaining <= length) {
        const sample = { x: end.x + (start.x - end.x) * remaining / length, z: end.z + (start.z - end.z) * remaining / length };
        const approachHeading = Math.atan2(end.z - start.z, end.x - start.x);
        const support = regions.classify(sample.x, sample.z, "ground");
        if (support.status === "drivable" && env.place(sample.x, sample.z, approachHeading, support.regionId))
          return { ...sample, edge: selected.edge, deck, approachHeading };
        break;
      }
      remaining -= length;
    }
  }
  assert.fail(`${name}: could not sample feeder approach`);
};
const driveAcross = (name, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, span = Math.hypot(dx, dz), ux = dx / span, uz = dz / span;
  const heading = Math.atan2(uz, ux), start = feederStart(name, ax, az, heading);
  const cls = regions.classify(start.x, start.z, "ground");
  assert.equal(cls.status, "drivable", `${name}: spawn begins on the actual feeder road (${cls.cause})`);
  const road = nearestGroundCenterline(start);
  assert.ok(road && road.distance < 0.05 && road.edge.id === start.edge.id, `${name}: spawn lies on feeder centerline`);
  const placed = env.place(start.x, start.z, start.approachHeading, cls.regionId);
  assert.ok(placed, `${name}: feeder-road vehicle footprint has verified support`);
  let state = { ...k.initialDrivingState(start.x, start.z, start.approachHeading, cls.regionId), ...placed };
  const farRoad = groundEdges.filter((edge) => edge.from === (endpoint(start.deck, { x: bx, z: bz }) === 0 ? start.deck.from : start.deck.to) || edge.to === (endpoint(start.deck, { x: bx, z: bz }) === 0 ? start.deck.from : start.deck.to));
  assert.ok(farRoad.length > 0, `${name}: far bridge endpoint has an actual ground-road continuation`);
  let maxLateral = 0;
  for (let tick = 0; tick < 5000; tick += 1) {
    const progress = (state.x - ax) * ux + (state.z - az) * uz;
    const targetProgress = Math.max(1, progress + 8);
    const targetHeading = Math.atan2(az + uz * targetProgress - state.z, ax + ux * targetProgress - state.x);
    const error = Math.atan2(Math.sin(targetHeading - state.heading), Math.cos(targetHeading - state.heading)) - state.steering * 0.4;
    const forward = { forward: true, backward: false, left: error < -0.015, right: error > 0.015 };
    state = { ...k.stepDriving(state, forward, env) };
    const nextProgress = (state.x - ax) * ux + (state.z - az) * uz;
    const lateral = Math.abs(-(state.x - ax) * uz + (state.z - az) * ux);
    if (nextProgress >= 0 && nextProgress <= span) {
      maxLateral = Math.max(maxLateral, lateral);
      assert.ok(lateral + dims.halfWidth <= start.deck.width / 2, `${name}: car stays within bridge deck width (${lateral.toFixed(2)}m)`);
    }
    if (nextProgress >= span + car.length) {
      assert.ok(state.speed > 5, `${name}: clears far bank under power (v=${state.speed.toFixed(1)})`);
      const far = regions.classify(state.x, state.z, "ground");
      assert.equal(far.status, "drivable", `${name}: full vehicle length beyond bridge remains on a ground-road surface`);
      assert.ok(env.place(state.x, state.z, state.heading, far.regionId, state.y), `${name}: full vehicle length beyond bridge has supported footprint`);
      const centerline = nearestGroundCenterline(state);
      assert.ok(centerline && centerline.edge.structure !== "deck" && centerline.distance + dims.halfWidth <= centerline.edge.width / 2,
        `${name}: car finishes within the far-bank road corridor`);
      assert.ok(maxLateral < start.deck.width / 2, `${name}: bridge-axis lateral deviation is bounded`);
      return;
    }
    if (state.speed === 0 && tick > 90) assert.fail(`${name}: stalled before clearing the far bank at ${nextProgress.toFixed(1)}/${span.toFixed(1)}m`);
  }
  assert.fail(`${name}: crossing timed out`);
};
driveAcross("beam bridge from", -120.36, -735.63, -161.72, -732.43);
driveAcross("beam bridge to", -161.72, -732.43, -120.36, -735.63);

// ── DrivingKernel 包装的满速过桥：UAT 页面经内核每步守卫（unexpected-surface-distance-jump）。
//   桥头接缝支撑跳变 ~0.25 + 满速水平步长 0.217 → 3D 位移 0.33；旧的平地上限 0.217 会误杀
//   满速过桥（用户实测 93.5 km/h 场景被作废）。内核从真实引道满速跨桥必须无异常完成。
{
  const kernel = new k.DrivingKernel(env, { baseSnapshotHash: "bridge-crossing", vehicleConfigHash: "verify", kernelBuildId: "verify", physicsVersion: 0, collisionVersion: 0, queryVersion: 0 });
  const start = feederStart("kernel full-speed", -120.36, -735.63, Math.atan2(-732.43 + 735.63, -161.72 + 120.36));
  const cls = regions.classify(start.x, start.z, "ground");
  assert.equal(cls.status, "drivable", "kernel trial begins on the feeder road");
  const placed = env.place(start.x, start.z, start.approachHeading, cls.regionId);
  assert.ok(placed, "kernel trial spawn");
  const ax = -120.36, az = -735.63, bx = -161.72, bz = -732.43;
  const span = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / span, uz = (bz - az) / span;
  let state = { ...k.initialDrivingState(start.x, start.z, start.approachHeading, cls.regionId), ...placed };
  let maxSpeed = 0;
  for (let tick = 0; tick < 5000; tick += 1) {
    const progress = (state.x - ax) * ux + (state.z - az) * uz;
    const targetProgress = Math.max(1, progress + 8);
    const targetHeading = Math.atan2(az + uz * targetProgress - state.z, ax + ux * targetProgress - state.x);
    const error = Math.atan2(Math.sin(targetHeading - state.heading), Math.cos(targetHeading - state.heading)) - state.steering * 0.4;
    const step = kernel.step(state, { forward: true, backward: false, left: error < -0.015, right: error > 0.015 });
    state = { ...step.state };
    maxSpeed = Math.max(maxSpeed, state.speed);
    if ((state.x - ax) * ux + (state.z - az) * uz >= span + car.length) {
      assert.ok(maxSpeed > k.DRIVING_PARAMS.maxForward * 0.9, `kernel crossing actually reaches full speed (${maxSpeed.toFixed(1)})`);
      assert.ok(state.speed > 5, `kernel crossing exits under power (${state.speed.toFixed(1)})`);
      break;
    }
    if (state.speed === 0 && tick > 90) assert.fail(`kernel crossing stalled at ${progress.toFixed(1)}/${span.toFixed(1)}`);
  }
}

// The suspension bridge is intentionally a dead end. Drive from its real feeder
// toward the far barrier and require a stopped, still-supported car before it.
const deadEndA = { x: -682.66, z: -197.6 }, deadEndB = { x: -732.79, z: -236.41 };
{
  const span = Math.hypot(deadEndB.x - deadEndA.x, deadEndB.z - deadEndA.z);
  const ux = (deadEndB.x - deadEndA.x) / span, uz = (deadEndB.z - deadEndA.z) / span;
  const heading = Math.atan2(uz, ux), start = feederStart("suspension bridge", deadEndA.x, deadEndA.z, heading);
  const cls = regions.classify(start.x, start.z, "ground");
  assert.equal(cls.status, "drivable", "suspension trial begins on the real feeder road");
  const placed = env.place(start.x, start.z, start.approachHeading, cls.regionId);
  assert.ok(placed, "suspension feeder spawn is supported");
  let state = { ...k.initialDrivingState(start.x, start.z, start.approachHeading, cls.regionId), ...placed };
  let lastMove = null;
  const move = env.move.bind(env);
  env.move = (previous, desired) => { lastMove = move(previous, desired); return lastMove; };
  let stoppedAtBarrier = false;
  let lastProgress = NaN, lastLateral = NaN;
  for (let tick = 0; tick < 5000; tick += 1) {
    const progress = (state.x - deadEndA.x) * ux + (state.z - deadEndA.z) * uz;
    const targetProgress = Math.max(1, progress + 8);
    const targetHeading = Math.atan2(deadEndA.z + uz * targetProgress - state.z, deadEndA.x + ux * targetProgress - state.x);
    const error = Math.atan2(Math.sin(targetHeading - state.heading), Math.cos(targetHeading - state.heading)) - state.steering * 0.4;
    const forward = { forward: true, backward: false, left: error < -0.015, right: error > 0.015 };
    state = { ...k.stepDriving(state, forward, env) };
    const nextProgress = (state.x - deadEndA.x) * ux + (state.z - deadEndA.z) * uz;
    const lateral = Math.abs(-(state.x - deadEndA.x) * uz + (state.z - deadEndA.z) * ux);
    lastProgress = nextProgress; lastLateral = lateral;
    assert.ok(nextProgress < span, `suspension dead end never crosses its unlanded endpoint (${nextProgress.toFixed(2)}/${span.toFixed(2)}m)`);
    if (state.speed <= k.DRIVING_PARAMS.zeroSpeed && state.braking && lastMove?.reason === "contact" && nextProgress > span - 12) {
      const here = regions.classify(state.x, state.z, "ground");
      assert.equal(here.status, "drivable", "barrier stop remains supported on the bridge surface");
      assert.ok(env.place(state.x, state.z, state.heading, here.regionId, state.y), "stopped vehicle footprint remains supported");
      assert.ok(lateral + dims.halfWidth <= start.deck.width / 2, "stopped vehicle remains within suspension deck bounds");
      stoppedAtBarrier = true; break;
    }
  }
  assert.ok(stoppedAtBarrier, `vehicle safely stops against the dead-end railing (progress=${lastProgress.toFixed(2)}/${span.toFixed(2)}, speed=${state.speed.toFixed(2)}, braking=${state.braking}, lateral=${lastLateral.toFixed(2)}, reason=${lastMove?.reason ?? "none"})`);
}

// 桥下净空：桥面板的可越只放宽顶面唇边——桥底之下仍须阻挡。
// 梁桥跨中板顶约 y≈1.0：车身底 y=0.30（水面之上、板底之下）向前扫掠应接触。
const mid = { x: (-120.36 + -161.72) / 2, z: (-735.63 + -732.43) / 2 };
const underBottom = 0.30;
const deckTopAt = Math.max(...solids.filter((s) => s.role === "bridge-deck" && s.maxX > mid.x - 4 && s.minX < mid.x + 4 && s.maxZ > mid.z - 4 && s.minZ < mid.z + 4).map((s) => s.maxY));
assert.ok(deckTopAt > underBottom + 0.6, `under-deck probe must sit well below the slab top (top=${deckTopAt.toFixed(2)})`);
// 静态索引 hit（纯 SAT+网格，无坐标规模拒绝）：桥下车身必须仍被板底挡住。
const underBody = k.carBody({ x: mid.x, z: mid.z, heading: 0, pitch: 0, roll: 0 }, { y: underBottom, pitch: 0, roll: 0 }, dims.halfLength, dims.halfWidth);
const under = solid.collisionIndex.hit(underBody);
assert.equal(under.status, "hit", `a body under the deck must still be stopped by the slab (${under.status})`);

// ── 桥面相机净空：追尾相机的臂扫掠从车身出发。车停在注解过的桥面板上时：
//   严格策略 + 支撑面起点（修复前）→ 起始包络与板体重叠 → blocked@0 →「无法确认净空」暂停；
//   gameplay 策略 + sweepLift 抬到车身中心（修复后）→ 必须给出明确 clear。
{
  assert.equal(k.CAMERA_COLLISION_QUERY_VERSION, 2, "camera query v2 carries the mountable policy");
  const bh = Math.atan2(-732.43 - -735.63, -161.72 - -120.36);
  const cls = regions.classify(mid.x, mid.z, "ground");
  assert.equal(cls.status, "drivable", "mid-deck camera probe point is drivable");
  const placedMid = env.place(mid.x, mid.z, bh, cls.regionId);
  assert.ok(placedMid, "mid-deck camera probe placement");
  const anchor = { x: mid.x - Math.cos(bh) * 8, y: placedMid.y + 4.4, z: mid.z - Math.sin(bh) * 8 };
  const strictGround = k.createCameraCollisionQuery(solid.collisionIndex)({ x: mid.x, y: placedMid.y, z: mid.z }, anchor, 0.25);
  assert.equal(strictGround.status, "blocked", `pre-fix mode (strict policy, support-level origin) must reproduce the deck overlap (${strictGround.status})`);
  const lifted = k.createCameraCollisionQuery(solid.collisionIndex, "gameplay")({ x: mid.x, y: placedMid.y + car.height / 2, z: mid.z }, anchor, 0.25);
  assert.equal(lifted.status, "clear", `session camera (gameplay policy, body-centre origin) must certify clearance on deck (${lifted.status})`);
}

// ── 相机降级行为：扫掠查询瞬态失败（街边杆件在两帧之间进入包络 → blocked@0；
//   查询未决）不得再以 unresolved 杀掉会话——应返回 held 保持上一认证位，下帧自愈。
//   另锁：正常 blocked(有效 fraction) 仍是 shrunk；持续 clear 恢复 clear。
{
  const { createRequire } = await import("node:module");
  const uiRequire = createRequire(new URL("../apps/agent-city/ui/package.json", import.meta.url));
  const { PerspectiveCamera } = uiRequire("three");
  const cam = new PerspectiveCamera(48, 1.78, 0.1, 400);
  const core = new k.VehicleChaseCamera(cam, { positionDamping: 15, dragPositionDamping: 20, lookDamping: 20, baseBack: 7.2, baseHeight: 4.4, speedBackBoost: 0.19, lookAhead: 2.5, fovBase: 48, fovSpeedSpan: 6, groundMargin: 0.5, fovDamping: 3 }, false, { zoom: { min: 0.5, max: 3 } });
  const target = { x: 0, y: 0, z: 0, heading: 0, speed: 13, speedRatio: 1 };
  let mode = "clear";
  const sweep = (from, to) => mode === "clear" ? { status: "clear" }
    : mode === "blocked-zero" ? { status: "blocked", safeFraction: 0 }
    : mode === "unresolved" ? { status: "unresolved" }
    : Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) < 8 ? { status: "clear" } : { status: "blocked", safeFraction: 0.4 };
  const queries = { cameraSweep: sweep, terrain: () => 0 };
  assert.equal(core.update(1 / 60, target, queries), "clear", "clean world starts clear");
  mode = "blocked-partial";
  assert.equal(core.update(1 / 60, target, queries), "shrunk", "ordinary block shrinks (not fatal)");
  mode = "blocked-zero";
  assert.equal(core.update(1 / 60, target, queries), "held", "transient blocked@0 degrades to held, never unresolved");
  mode = "unresolved";
  assert.equal(core.update(1 / 60, target, queries), "held", "transient query failure degrades to held, never unresolved");
  mode = "clear";
  const recovered = core.update(1 / 60, target, queries);
  assert.ok(recovered === "clear" || recovered === "shrunk", `camera recovers after the transient passes (${recovered})`);
  core.dispose();
}
console.log(`Bridge crossing: beam both ends reached the far road under power, suspension dead end stopped on support at its railing (${deadEndRailing.length} barrier solids), under-deck body blocked by slab (top ${deckTopAt.toFixed(2)}), on-deck camera clearance certified (strict/support-level repro blocked, lifted/gameplay clear), mountable passthrough locked (${islandMountable.length} island + ${decks.length} deck solids).`);
