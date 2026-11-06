#!/usr/bin/env node
// VTOL 飞行车（vtolDriving，docs 待补）：地面段复用汽车物理，推进器叠加垂直通道；
//   空中段独立运动学 + 严格 3D 扫掠。断言：
//   1) 起飞：静止按住推进器 → 助推消耗、累计抬升、超离地余量转空中体制；
//   2) 悬停地板：无支撑（水面语义）不坠落、钳在海面、保持空中；
//   3) 天花板：最高实体+40（下限 120）裁剪爬升；
//   4) 上方实体裁剪：桥面板下方的垂直离地被 trim（车身顶到板底即止）；
//   5) 空中撞墙：严格策略、滑移后停于墙面（岛缘可越实体在空中也是阻挡）；
//   6) 落地：下降到有效支撑 → gameplay 足迹校验通过 → 接地回地面体制、助推恢复；
//   7) 内核界兼容：空中满速（=地面极速 13）时每步水平/3D 位移落在 DrivingKernel 守卫界内；
//   8) 审计不变式：stepDriving 忽略 thruster 字段——默认（无 VTOL）路径逐位不变。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { makeFixtures } from "./city-kit/surface-region-fixtures.mjs";
const k = await loadCity({
  "game/driving/CollisionIndex.ts": ["buildCollisionIndex"],
  "game/driving/ContinuousDrivingEnvironment.ts": ["ContinuousDrivingEnvironment"],
  "game/driving/VtolDrivingEnvironment.ts": ["VtolDrivingEnvironment"],
  "game/driving/vtolDriving.ts": ["VTOL_PARAMS", "VTOL_PHYSICS_VERSION", "initialVtolState", "stepVtolDriving"],
  "game/driving/surfaceFootprint.ts": ["GAMEPLAY_FOOTPRINT_PARAMS"],
  "game/driving/vehicleFootprint.ts": ["GAMEPLAY_DRIVING_FOOTPRINT", "GAMEPLAY_COLLISION_INSET"],
  "game/carDimensions.ts": ["CAR_DIMENSIONS"],
  "game/DrivingSimulation.ts": ["stepDriving", "initialDrivingState", "DRIVING_DT", "DRIVING_PARAMS"],
  "game/driving/DrivingKernel.ts": ["DrivingKernel"],
  "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
});
const { grid, patch, regionsOf } = makeFixtures(k);

// 路 [-30,30]×[-6,6]；x>30 无面片（水面语义）。高墙 x∈[24,25]（y 0..9，空中也挡）。
// 低板 x∈[-6,6], z∈[-2,2], y∈[3,3.5]（模拟桥面板底面，压制垂直离地）。
const road = patch("road", "carriageway", grid(-30, -6, 30, 6, 60, 12));
const remoteRoad = patch("road:remote", "carriageway", grid(70, -6, 90, 6, 20, 12));
// 人行道面片（0.4 高，x 35..45）：足迹不可落地（blocked），但面片网格有高度——
// 悬停地板必须取面片高度，而不是海平面（否则车沉进地里）。
const sidewalk = patch("sidewalk:1", "sidewalk", grid(35, -4, 45, 4, 20, 8, () => 0.4));
const { regions } = regionsOf([road, remoteRoad, sidewalk], undefined);
assert.equal(regions.status, "ready");
const regionId = regions.classify(-20, 0, "ground").regionId;

const wall = { id: "wall", role: "pier", kind: "prism",
  ring: [{ x: 24, z: -6 }, { x: 25, z: -6 }, { x: 25, z: 6 }, { x: 24, z: 6 }], yMin: -0.5, yMax: 40 };
const slab = { id: "slab", role: "bridge-deck", kind: "prism",
  ring: [{ x: -6, z: -2 }, { x: 6, z: -2 }, { x: 6, z: 2 }, { x: -6, z: 2 }], yMin: 3, yMax: 3.5 };
const index = k.buildCollisionIndex([wall, slab]);
const d = k.CAR_DIMENSIONS;
const dims = { halfLength: d.length / 2 - k.GAMEPLAY_COLLISION_INSET, halfWidth: d.width / 2 - k.GAMEPLAY_COLLISION_INSET, halfHeight: d.height / 2 };
const binding = { surfaceRevision: regions.revision, worldRevision: "vtol-fixture", solidRevision: "vtol-fixture",
  solids: index.solids(), dimensions: dims, centerHeight: dims.halfHeight, isCurrent: () => true };
const surfaceIndex = k.buildSurfaceIndex({ revision: regions.revision, patches: [road, remoteRoad, sidewalk] });
const floorAt = (x, z) => {
  const q = surfaceIndex.query({ x, z, layerId: "ground", kinds: ["carriageway", "junction", "bridge-deck", "ramp", "expressway-deck", "sidewalk", "island", "decor"] });
  if (q.status === "hit") return q.hit.point.y;
  if (q.status === "ambiguous") return Math.max(...q.candidates.map((c) => c.point.y));
  return 0;
};
const env = new k.VtolDrivingEnvironment(regions, binding, k.GAMEPLAY_DRIVING_FOOTPRINT, k.GAMEPLAY_FOOTPRINT_PARAMS, {},
  { boundarySlide: true, mountablePolicy: "gameplay" }, { floorAt });
const remoteRegionId = regions.classify(80, 0, "ground").regionId;

const thrust = { forward: false, backward: false, left: false, right: false, thruster: true };
const idle = { forward: false, backward: false, left: false, right: false };
const fwd = { forward: true, backward: false, left: false, right: false };

// ── 1) 起飞 ──
let state = k.initialVtolState(-20, 0, 0, regionId);
assert.ok(env.place ? true : true);
let tookOffAt = -1;
for (let tick = 0; tick < 240; tick += 1) {
  state = k.stepVtolDriving(state, thrust, env);
  assert.ok(state.boost <= 1 && state.boost >= 0, "boost within [0,1]");
  if (state.airborne) { tookOffAt = tick; break; }
  if (state.y < -0.01) assert.fail(`climb must not sink before liftoff (y=${state.y.toFixed(3)})`);
}
assert.ok(tookOffAt >= 0, "must take off while thrusting");
assert.ok(state.y > k.VTOL_PARAMS.liftoffMargin, `airborne above liftoff margin (y=${state.y.toFixed(3)})`);
assert.ok(state.boost < 1, "boost drains while thrusting");
const boostAfterTakeoff = state.boost;

// ── 7) 内核界兼容：空中满速每步水平位移 ≤ 地面极速每步（DrivingKernel planar 界）──
{
  let air = { ...state, x: -20, z: 0, y: 6, speed: 0, airborne: true, verticalSpeed: 0, boost: 1, surfaceId: regionId };
  let maxSpeed = 0;
  for (let tick = 0; tick < 300; tick += 1) { // 带推进维持高度，测水平极速与每步界
    const before = { x: air.x, z: air.z };
    air = k.stepVtolDriving(air, { ...fwd, thruster: true }, env);
    const planar = Math.hypot(air.x - before.x, air.z - before.z);
    assert.ok(planar <= k.DRIVING_PARAMS.maxForward * k.DRIVING_DT + 1e-6, `air planar step within kernel guard (${planar.toFixed(4)})`);
    maxSpeed = Math.max(maxSpeed, air.speed);
  }
  assert.ok(maxSpeed > k.VTOL_PARAMS.airMaxForward * 0.9, `air speed approaches cap (${maxSpeed.toFixed(2)})`);
  const sinkFrom = air.y;
  // 弹道过冲：捕获点可能仍在上升段——跑足时长（含重砸弹跳衰减与最终落地）再比较。
  for (let tick = 0; tick < 600; tick += 1) air = k.stepVtolDriving(air, { ...fwd, thruster: false }, env);
  assert.ok(air.y < sinkFrom, `gravity sinks without thrust (${air.y.toFixed(2)} < ${sinkFrom.toFixed(2)})`);
}

// ── 5) 空中撞墙（严格：高墙在 x=24，朝 +x 飞）──
{
  let air = { ...k.initialVtolState(10, 0, 0, regionId), y: 5, airborne: true, verticalSpeed: 0, boost: 1 };
  for (let tick = 0; tick < 900; tick += 1) {
    air = k.stepVtolDriving(air, { ...fwd, thruster: tick < 60 }, env);
    if (air.x > 23.4) assert.fail(`wall must stop the flying car in air (x=${air.x.toFixed(2)})`);
    if (tick > 120 && Math.abs(air.speed) < 0.5) break;
  }
  assert.ok(air.x < 23.5, `car stops before the wall face (x=${air.x.toFixed(2)})`);
  assert.ok(Math.abs(air.speed) < 1, `speed near zero against wall (${air.speed.toFixed(2)})`);
}

// ── 6) 落地：从 y=2 无推进器下降 → 接地 ──
{
  let air = { ...k.initialVtolState(-20, 0, 0, regionId), y: 2, airborne: true, verticalSpeed: 0, boost: 0.5 };
  let landed = false;
  for (let tick = 0; tick < 240; tick += 1) {
    air = k.stepVtolDriving(air, idle, env);
    if (air.airborne === false) { landed = true; break; }
  }
  assert.ok(landed, "must land on valid road support");
  assert.ok(Math.abs(air.y) < 0.05, `landed at support height (y=${air.y.toFixed(3)})`);
  assert.equal(air.surfaceId, regionId);
  // 落地静止恢复助推
  const boost0 = air.boost;
  for (let tick = 0; tick < 120; tick += 1) air = k.stepVtolDriving(air, idle, env);
  assert.ok(air.boost > boost0, "boost regenerates when grounded and slow");
  assert.equal(air.airborne, false);
  // 行驶中也回充（四成速率）——助推耗尽后开车跑一段必须能再飞（用户实测反馈）
  {
    let drive = { ...air, boost: 0 };
    for (let tick = 0; tick < 240; tick += 1) drive = k.stepVtolDriving(drive, fwd, env);
    assert.ok(Math.abs(drive.speed) > k.VTOL_PARAMS.boostRegenMaxSpeed, `test drives above regen-speed threshold (${drive.speed.toFixed(1)})`);
    assert.ok(drive.boost > k.VTOL_PARAMS.minBoostToLift, `driving regenerates boost past lift threshold (${drive.boost.toFixed(3)})`);
    // 助推过阈值后按 Space 必须能再起升
    let ticks = 0;
    while (!drive.airborne && ticks < 240) { drive = k.stepVtolDriving(drive, thrust, env); ticks += 1; }
    assert.ok(drive.airborne, `can take off again after driving regen (${ticks} ticks)`);
  }
}

// ── 6b) 空中可落到出生道路以外的独立连通路段，surfaceId 随落地点更新 ──
{
  let air = { ...k.initialVtolState(80, 0, 0, regionId), y: 0.1, airborne: true, verticalSpeed: -1, boost: 0.5 };
  let landed = false;
  for (let tick = 0; tick < 30; tick += 1) {
    air = k.stepVtolDriving(air, idle, env);
    if (!air.airborne) { landed = true; break; }
  }
  assert.ok(landed, "must land on a disconnected drivable region");
  assert.equal(air.surfaceId, remoteRegionId, "landing switches the vehicle to the supporting road region");
}

// ── 2) 悬停地板：无支撑区域不坠落 ──
{
  // 面片网格之外（真水面语义，x=60 无任何面片）→ 钳在海面 0.2
  let air = { ...k.initialVtolState(60, 0, 0, regionId), y: 2, airborne: true, verticalSpeed: 0, boost: 1 };
  for (let tick = 0; tick < 240; tick += 1) air = k.stepVtolDriving(air, idle, env);
  assert.ok(air.airborne, "no landing over water");
  assert.ok(Math.abs(air.y - 0.2) < 0.05, `hovers at water level (y=${air.y.toFixed(3)})`);
  assert.ok(air.verticalSpeed >= -1e-9, "hover floor stops the sink");
  // 人行道（0.4 高，足迹不可落地）→ 悬停在其表面高度，不沉进地里
  let over = { ...k.initialVtolState(40, 0, 0, regionId), y: 2, airborne: true, verticalSpeed: 0, boost: 1 };
  for (let tick = 0; tick < 240; tick += 1) over = k.stepVtolDriving(over, idle, env);
  assert.ok(over.airborne, "sidewalk is not landable");
  assert.ok(Math.abs(over.y - 0.4) < 0.05, `hovers at sidewalk surface, not below ground (y=${over.y.toFixed(3)})`);
  // 自然地形高度来自 frozen CityLayout sampler，不能回退到海平面。
  const hillEnv = new k.VtolDrivingEnvironment(regions, binding, k.GAMEPLAY_DRIVING_FOOTPRINT, k.GAMEPLAY_FOOTPRINT_PARAMS, {},
    { boundarySlide: true, mountablePolicy: "gameplay" }, { floorAt: (x) => x > 50 ? 3.5 : floorAt(x, 0) });
  let hill = { ...k.initialVtolState(60, 0, 0, regionId), y: 5, airborne: true, verticalSpeed: 0, boost: 1 };
  for (let tick = 0; tick < 240; tick += 1) hill = k.stepVtolDriving(hill, idle, hillEnv);
  assert.ok(Math.abs(hill.y - 3.5) < 0.05, `hovers at natural terrain height (y=${hill.y.toFixed(3)})`);
}

// ── 3) 天花板：爬升钳在 max(最高实体+40, 120) ──
{
  let air = { ...k.initialVtolState(-20, 0, 0, regionId), y: 100, airborne: true, verticalSpeed: 0, boost: 1 };
  for (let tick = 0; tick < 600; tick += 1) air = k.stepVtolDriving(air, thrust, env);
  assert.ok(air.y <= 120 + 1e-6, `ceiling clamps the climb (y=${air.y.toFixed(2)})`);
}

// ── 4) 上方实体裁剪：板（y 3..3.5）下方垂直离地被 trim ──
{
  const ground = { ...k.initialVtolState(0, 0, 0, regionId) };
  const lifted = env.lift(ground, 5);
  assert.ok(lifted.trimmed, "lift under the slab is trimmed");
  // 车顶（y+centerHeight+halfHeight ≈ y+1.15）到板底 3：约 y≈1.8 处接触
  assert.ok(lifted.y < 1.95, `trimmed below the slab underside (y=${lifted.y.toFixed(2)})`);
  assert.ok(lifted.y > 1.0, `still lifts partway (y=${lifted.y.toFixed(2)})`);
  // 屋顶悬停：靠碰撞停在板顶（3.5）时，重力不得积累隐形下沉速度——
  // 从边缘飞出的瞬间不允许暴坠（物理审查 #1）。
  let roof = { ...k.initialVtolState(0, 0, 0, regionId), y: 5, airborne: true, verticalSpeed: 0, boost: 1 };
  for (let tick = 0; tick < 240; tick += 1) roof = k.stepVtolDriving(roof, idle, env);
  assert.ok(roof.y > 3.4, `rests on the slab top via collision (y=${roof.y.toFixed(2)})`);
  assert.ok(roof.verticalSpeed >= -0.01, `contact clamps sink accumulation (vs=${roof.verticalSpeed.toFixed(2)})`);
  assert.equal(roof.airborne, true, "slab top is not landable (no support region)");
}

// ── 4b) 重砸着陆弹起：高于 landingSinkMax 的下沉不接地，按 35% 回弹并逐次衰减，
//        最终低于门槛才真正落地（物理审查 #2）──
{
  let drop = { ...k.initialVtolState(-20, 0, 0, regionId), y: 7, airborne: true, verticalSpeed: 0, boost: 1 };
  let bounces = 0;
  let landedTick = -1;
  let sawRebound = false;
  for (let tick = 0; tick < 900; tick += 1) {
    const before = drop.airborne;
    drop = k.stepVtolDriving(drop, idle, env);
    if (before && !drop.airborne) { landedTick = tick; break; }
    if (drop.y < 0.5 && drop.verticalSpeed > 0.05 && tick > 30) { sawRebound = true; bounces += 1; }
  }
  assert.ok(sawRebound, "hard slam bounces (positive rebound observed)");
  assert.ok(bounces >= 1, `bounce counted near ground (${bounces})`);
  assert.ok(landedTick >= 0, `eventually settles onto the road (tick ${landedTick})`);
  assert.ok(Number.isFinite(drop.y) && Math.abs(drop.y) < 0.05, `settled at support (y=${drop.y.toFixed(3)})`);
}

// ── 8) 审计不变式：stepDriving 忽略 thruster，默认路径逐位不变 ──
{
  const plain = new k.ContinuousDrivingEnvironment(regions, binding, k.GAMEPLAY_DRIVING_FOOTPRINT, k.GAMEPLAY_FOOTPRINT_PARAMS, {},
    { boundarySlide: true, mountablePolicy: "gameplay" });
  const from = { ...k.initialVtolState(-20, 0, 0, regionId) };
  const a = k.stepDriving(from, { ...fwd, thruster: true }, plain);
  const b = k.stepDriving(from, fwd, plain);
  assert.deepEqual(a, b, "thruster field must not change stepDriving behavior");
}

// ── 附加：DrivingKernel 全链（用户路径：内核包装世界 + 注入 VTOL 步进）──
//   内核给步进函数的世界必须保留 lift/moveAir/supportHeight（原型链直通），
//   否则第一次按 Space 即「world.lift is not a function」杀掉场景（用户实测回归锁）。
{
  const vtolStep = (previous, input, world) => k.stepVtolDriving(previous, input, world);
  const kernel = new k.DrivingKernel(env, { baseSnapshotHash: "vtol", vehicleConfigHash: "vtol", kernelBuildId: "vtol-verify",
    physicsVersion: 0, collisionVersion: 0, queryVersion: 0 }, vtolStep);
  // 诊断出生（裸 DrivingState）经内核按 Space 起飞——正是真实 UAT 路径
  let s = { ...k.initialDrivingState(-20, 0, 0, regionId) };
  let tookOff = false;
  for (let tick = 0; tick < 240 && !tookOff; tick += 1) {
    const step = kernel.step(s, { ...thrust });
    s = { ...step.state };
    tookOff = s.airborne === true;
  }
  assert.ok(tookOff, "kernel-injected VTOL physics takes off from a bare diagnostic spawn (world.lift reachable)");
  assert.ok(Number.isFinite(s.boost), "kernel path keeps boost finite");
  // Air contact metadata is captured by the same kernel motion ledger as ground contacts.
  const contactWorld = Object.create(env);
  contactWorld.moveAir = (before, desired) => Object.freeze({ ...before, x: desired.x, y: desired.y, z: desired.z,
    heading: desired.heading, blocked: false, reason: "contact", travelledDistance: 0, speedFraction: 1,
    trajectory: Object.freeze([{ ...before }]), contacts: Object.freeze([{ obstacleId: "air-wall", worldRevision: "vtol-fixture",
      time: 0.5, timeUpper: 0.5, normal: Object.freeze({ x: -1, y: 0, z: 0 }), kind: "solid" }]),
    contact: true, landed: false, floor: false, queryStatus: "resolved" });
  const contactKernel = new k.DrivingKernel(contactWorld, { baseSnapshotHash: "vtol", vehicleConfigHash: "vtol", kernelBuildId: "vtol-contact-verify",
    physicsVersion: 0, collisionVersion: 0, queryVersion: 0 }, vtolStep);
  const airborne = { ...k.initialVtolState(0, 0, 0, regionId), y: 5, airborne: true, verticalSpeed: 0, boost: 1 };
  const contactResult = contactKernel.step(airborne, { forward: false, backward: false, left: false, right: false, thruster: false });
  assert.equal(contactResult.motion.contact, true, "kernel reports airborne contact state");
  assert.equal(contactResult.motion.contacts?.[0]?.obstacleId, "air-wall", "kernel preserves airborne contact evidence");
  // 空中巡航 + 下降落地也经内核（moveAir 可达）
  let landed = false;
  for (let tick = 0; tick < 600 && !landed; tick += 1) {
    const step = kernel.step(s, { forward: false, backward: false, left: false, right: false, thruster: false });
    s = { ...step.state };
    landed = s.airborne === false;
  }
  assert.ok(landed, "kernel-injected VTOL physics lands through moveAir (descent from kernel takeoff)");
}

// ── 附加：诊断出生路径——出生状态不带 VTOL 字段（仅 DrivingState）也不得产生 NaN，
//   且能正常起飞（用户实测「Boost NaN」回归锁）──
{
  const bare = k.initialDrivingState(-20, 0, 0, regionId);
  assert.equal(bare.boost, undefined, "fixture precondition: bare spawn has no vtol fields");
  let s = k.stepVtolDriving(bare, thrust, env);
  assert.ok(Number.isFinite(s.boost) && s.boost >= 0.99, `bare-spawn boost heals to finite (${s.boost})`);
  assert.ok(Number.isFinite(s.verticalSpeed) && Number.isFinite(s.y), "bare-spawn vertical fields finite");
  let ticks = 0;
  while (!s.airborne && ticks < 240) { s = k.stepVtolDriving(s, thrust, env); ticks += 1; }
  assert.ok(s.airborne, `bare (diagnostic) spawn can take off (${ticks} ticks)`);
}

console.log(`VTOL driving (physics v${k.VTOL_PHYSICS_VERSION}): takeoff, strict air collision, disconnected-road landing, terrain/water/sidewalk hover floors, landing region handoff, ceiling and slab limits, kernel air-contact evidence, boost regen, and stepDriving invariance passed.`);
