#!/usr/bin/env node
// 可越障碍（mountable curbs，docs/CITY_DRIVING_MOUNTABLE_OBSTACLES.md）：
//   低矮分流岛路缘不产生法向阻挡；支撑面融合取路面/岛顶；上下路缘的台阶/twist 检查按
//   可越预算豁免（预算本身界定爬升上界）；高墙仍完全阻挡；静止停在岛顶合法。
//   合成世界：平路面 + 0.22 高岛面片（kind "island"）+ 同底座岛 prism + 对照高墙。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { makeFixtures } from "./city-kit/surface-region-fixtures.mjs";
const k = await loadCity({
  "game/driving/CollisionIndex.ts": ["buildCollisionIndex", "boxPoly", "carBody"],
  "game/driving/DrivingCollision.ts": ["sweepBody"],
  "game/driving/ContinuousDrivingEnvironment.ts": ["ContinuousDrivingEnvironment"],
  "game/driving/surfaceFootprint.ts": ["footprintSupport", "validateMotion", "mountableQueryOf", "GAMEPLAY_FOOTPRINT_PARAMS"],
  "game/DrivingSimulation.ts": ["stepDriving", "initialDrivingState", "DRIVING_DT", "DRIVING_PHYSICS_VERSION", "DRIVING_PARAMS"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
});
const { grid, patch, regionsOf } = makeFixtures(k);

// 路 [-30,30]×[-6,6]；岛占 [−4,4]×[−1.5,1.5]，顶面 0.22（同真实编译器 terrain+0.22）。
const ISLAND_TOP = 0.22;
const road = patch("road", "carriageway", grid(-30, -6, 30, 6, 60, 12));
const island = patch("island:mouth-0", "island", grid(-4, -1.5, 4, 1.5, 16, 6, () => ISLAND_TOP));
const { regions } = regionsOf([road, island], undefined);
assert.equal(regions.status, "ready", JSON.stringify(regions.status));
const roadRegion = regions.regionOf ? regions.regionOf(road.id) : undefined;
const regionId = (() => {
  const probe = regions.classify(-20, 0, "ground");
  assert.equal(probe.status, "drivable");
  return probe.regionId;
})();
// 岛中心分类为 curb 阻挡（island 孔洞语义）——这是可越融合的前提。
assert.equal(regions.classify(0, 0, "ground").status, "blocked");

const islandPrism = { id: "island:mouth-0", role: "island", kind: "prism",
  ring: [{ x: -4, z: -1.5 }, { x: 4, z: -1.5 }, { x: 4, z: 1.5 }, { x: -4, z: 1.5 }],
  yMin: -0.18, yMax: ISLAND_TOP, mountableHeight: 0.25 };
const wall = { id: "wall", role: "pier", kind: "prism",
  ring: [{ x: 19, z: -6 }, { x: 20, z: -6 }, { x: 20, z: 6 }, { x: 19, z: 6 }],
  yMin: -0.5, yMax: 1.5 };
const index = k.buildCollisionIndex([islandPrism, wall]);
const solids = index.solids();
const mountable = k.mountableQueryOf(solids);
assert.ok(mountable, "island prism must register as mountable");
void roadRegion;

// ── 查询层 ──
assert.equal(mountable.topAt(0, 0, 0), ISLAND_TOP, "island top fused over island centre");
assert.equal(mountable.topAt(-20, 0, 0), null, "no mountable top over open road");
assert.equal(mountable.topAt(0, 0, 0.5), ISLAND_TOP, "already-above floor keeps island visible (drop-off side)");

// ── 碰撞层：hit/sweep 跳过 ──
const dims = { halfLength: 0.7, halfWidth: 0.35, halfHeight: 0.29 };
const bodyAt = (x, y) => k.carBody({ x, z: 0, heading: 0, pitch: 0, roll: 0 }, { y, pitch: 0, roll: 0 }, dims.halfLength, dims.halfWidth);
assert.equal(index.hit(bodyAt(0, 0)).status, "hit", "mountable annotations do not weaken strict/default static clearance");
assert.equal(index.hit(bodyAt(0, 0), "gameplay").status, "clear", "gameplay explicitly enables climbing the island");
assert.equal(index.hit(bodyAt(0, 0.22)).status, "clear", "car parked on island top has clear underbody");
assert.throws(() => k.buildCollisionIndex([{...islandPrism,mountableHeight:-0.01}]), /collision-index-invalid-input/);
assert.throws(() => k.buildCollisionIndex([{...islandPrism,mountableHeight:Number.POSITIVE_INFINITY}]), /collision-index-invalid-input/);
assert.equal(index.hit(bodyAt(19.5, 0 + 0.29)).status, "hit", "wall always blocks");
assert.equal(k.sweepBody(solids, { x: -8, y: 0.29, z: 0, heading: 0, pitch: 0, roll: 0 }, { x: 8, y: 0.29, z: 0, heading: 0, pitch: 0, roll: 0 }, dims).status, "contact",
  "strict/default sweep keeps annotated islands as blockers");
assert.equal(k.sweepBody(solids, { x: -8, y: 0.29, z: 0, heading: 0, pitch: 0, roll: 0 }, { x: 8, y: 0.29, z: 0, heading: 0, pitch: 0, roll: 0 }, dims, {mountablePolicy:"gameplay"}).status, "clear",
  "gameplay explicitly sweeps across the island");
const pitchedCurb = { id:"pitched-curb", role:"island", kind:"prism", ring:[{x:-2.2,z:-1},{x:-1.3,z:-1},{x:-1.3,z:1},{x:-2.2,z:1}], yMin:-0.18,yMax:0.22,mountableHeight:0.25 };
const pitchedIndex = k.buildCollisionIndex([pitchedCurb]);
const pitchedSolids = pitchedIndex.solids();
const pitchedDims = {halfLength:2,halfWidth:0.35,halfHeight:0.29};
const pitchedPose = {x:0,y:0.29,z:0,heading:0,pitch:0.3,roll:0};
const rearBottom = 0.29 - 2*Math.sin(0.3) - 0.29*Math.cos(0.3);
const upperAtCurb = 0.29 - 1.3*Math.sin(0.3) + 0.29*Math.cos(0.3);
assert.ok(rearBottom < pitchedCurb.yMax && upperAtCurb > pitchedCurb.yMin, "pitched car intersects curb in full 3D");
assert.notEqual(k.sweepBody(pitchedSolids,pitchedPose,pitchedPose,pitchedDims,{mountablePolicy:"gameplay"}).status,"clear",
  "conservative whole-vehicle lower bound cannot skip an intersecting pitched curb");
assert.equal(pitchedIndex.sweep(pitchedPose,pitchedPose,pitchedDims,"gameplay").status,"contact",
  "versioned collision sweep uses the same conservative pitched-body bound");
assert.equal(k.sweepBody(solids, { x: 12, y: 0.29, z: 0, heading: 0, pitch: 0, roll: 0 }, { x: 22, y: 0.29, z: 0, heading: 0, pitch: 0, roll: 0 }, dims).status, "contact",
  "sweep into the wall still contacts");

// ── 支撑层：footprintSupport 融合 ──
const fused = k.footprintSupport(regions, { x: 0, z: 0, heading: 0, y: ISLAND_TOP }, regionId, undefined, k.GAMEPLAY_FOOTPRINT_PARAMS, undefined, mountable);
assert.ok(fused.ok, `static support over island must fuse: ${JSON.stringify(fused)}`);
assert.ok(Math.abs(fused.y - ISLAND_TOP) < 1e-6, `fused support height ${fused.y}`);
const denied = k.footprintSupport(regions, { x: 0, z: 0, heading: 0 }, regionId, undefined, k.GAMEPLAY_FOOTPRINT_PARAMS, undefined, undefined);
assert.ok(!denied.ok, "without mountable the island hole stays rejected (audit invariance)");

// ── 运动层：validateMotion 穿越 + 下落 ──
const crossing = k.validateMotion(regions, { x: -8, z: 0, heading: 0, y: 0 }, { x: 8, z: 0, heading: 0 }, regionId, undefined, k.GAMEPLAY_FOOTPRINT_PARAMS, undefined, mountable);
assert.ok(crossing.ok, `road → island → road crossing must pass: ${JSON.stringify(crossing)}`);
const blockedCrossing = k.validateMotion(regions, { x: -8, z: 0, heading: 0, y: 0 }, { x: 8, z: 0, heading: 0 }, regionId, undefined, k.GAMEPLAY_FOOTPRINT_PARAMS, undefined, undefined);
assert.ok(!blockedCrossing.ok, "same crossing without mountable is rejected");
const wallPath = k.validateMotion(regions, { x: 15, z: 0, heading: 0, y: 0 }, { x: 22, z: 0, heading: 0 }, regionId, undefined, k.GAMEPLAY_FOOTPRINT_PARAMS, index, mountable);
assert.ok(!wallPath.ok, "mountable never licenses a wall");

// ── 端到端：内核驾车穿岛、撞墙停止、静止停在岛顶 ──
const env = new k.ContinuousDrivingEnvironment(regions, {
  surfaceRevision: regions.revision, worldRevision: "mountable-fixture", solidRevision: "mountable-fixture",
  solids, dimensions: { ...dims }, centerHeight: 0.29, isCurrent: () => true,
}, undefined, k.GAMEPLAY_FOOTPRINT_PARAMS, {}, {mountablePolicy:"gameplay"});
const parked = env.place(0, 0, 0, regionId, ISLAND_TOP);
assert.ok(parked, "parking on the island top is legal");
assert.ok(Math.abs(parked.y - ISLAND_TOP) < 1e-6);
let state = { ...k.initialDrivingState(-12, 0, 0, regionId), ...env.place(-12, 0, 0, regionId) };
assert.ok(state.y !== undefined && Math.abs(state.y) < 1e-6);
const forward = { forward: true, backward: false, left: false, right: false };
let crossed = false;
for (let tick = 0; tick < 600; tick += 1) {
  const step = k.stepDriving(state, forward, env);
  state = { ...step };
  if (state.x > 8) { crossed = true; break; }
  assert.ok(!state.blocked || state.x < -3.9, `island must not block the car (x=${state.x.toFixed(2)}, reason=${state.reason ?? "none"})`);
}
assert.ok(crossed, "car drives across the island to x>8");
assert.ok(state.distance > 19, `crossing accumulates travel distance (${state.distance.toFixed(1)})`);
// 撞墙：前进到墙，接触滑移使速度归零、停在墙前（接触滑移的 blocked=false + speedFraction=0）。
let wallState = { ...state };
for (let tick = 0; tick < 900; tick += 1) {
  const step = k.stepDriving(wallState, forward, env);
  wallState = { ...step };
  if (wallState.speed === 0 && wallState.x > 15) break;
}
assert.ok(wallState.x < 19.5, `car stops before the wall face (x=${wallState.x.toFixed(2)})`);
assert.equal(wallState.speed, 0);
assert.ok(wallState.braking, "wall contact reads as braking");
// ── 角落蹭界滑动（游玩档 boundarySlide；默认关=审计触线即拒不变）──
// 路面在 x=30 截止（区域边界）。以 ~11° 浅角斜向边界开：开滑动时应沿边界滑行前进，
// 不开时（审计语义）整步拒绝停车。
{
  const slideEnv = new k.ContinuousDrivingEnvironment(regions, {
    surfaceRevision: regions.revision, worldRevision: "mountable-fixture", solidRevision: "mountable-fixture",
    solids, dimensions: { ...dims }, centerHeight: 0.29, isCurrent: () => true,
  }, undefined, k.GAMEPLAY_FOOTPRINT_PARAMS, {}, { boundarySlide: true, mountablePolicy:"gameplay" });
  const strictEnv = new k.ContinuousDrivingEnvironment(regions, {
    surfaceRevision: regions.revision, worldRevision: "mountable-fixture", solidRevision: "mountable-fixture",
    solids, dimensions: { ...dims }, centerHeight: 0.29, isCurrent: () => true,
  });
  const heading = Math.atan2(1, 5); // ~11° 浅角：从 x=28 直指 x=30 的区域边缘
  const pose = { x: 28, y: 0, z: 0, heading, speed: 6, steering: 0, distance: 0, braking: false, reversing: false, pitch: 0, roll: 0, surfaceId: regionId };
  const target = { x: 28 + Math.cos(heading) * 3, z: Math.sin(heading) * 3, heading, travelBudget: 3 };
  assert.ok(target.x > 30, "test geometry must actually reach the boundary");
  const slid = slideEnv.move(pose, target);
  assert.ok(!slid.blocked, `boundary slide keeps the car moving (${slid.reason ?? "ok"})`);
  assert.ok(slid.x < 30 + 0.05, `slide stays inside the region (x=${slid.x.toFixed(2)})`);
  assert.ok(slid.z > 0.2, `slide carries the tangential component along the edge (z=${slid.z.toFixed(2)})`);
  const stopped = strictEnv.move(pose, target);
  assert.ok(stopped.x < 30, `strict env never crosses the boundary (x=${stopped.x.toFixed(2)})`);
  assert.ok(slid.z > stopped.z + 0.2, `slide carries the car along the edge far beyond the strict stop (z ${slid.z.toFixed(2)} vs ${stopped.z.toFixed(2)})`);
}
console.log(`Driving mountable obstacles: island fused support/crossing (physics v${k.DRIVING_PHYSICS_VERSION}, wall at x=${wallState.x.toFixed(2)}), static parking, hit/sweep skips and gameplay boundary slide passed.`);
