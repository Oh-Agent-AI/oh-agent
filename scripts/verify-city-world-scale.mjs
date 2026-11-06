#!/usr/bin/env node
// 世界比例尺守卫（1 单位 = 2 米，engine/worldScale.ts）：在 Node 里构建每个地标/机场/豪宅岛模型，量主体包围盒
// （去掉灯塔光束这类发光锥），换算成米，对照 worldScale.SIZE_POLICY：
//   real × range[0] ≤ 实测 ≤ real × range[1]
// real 是真实世界参考尺寸；range 偏离 1 的部分是「为了视觉效果」登记过的放大/压低（用户 2026-10-15：有些物体为了视觉效果可以调整大小）。
// 偏离必须写在表里、带理由；新模型没有条目直接失败——不让「顺手写的魔数」再把一个东西做成两倍大。
//   node scripts/verify-city-world-scale.mjs [--report]
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { installCanvasShim } from "./city-kit/scene-hash.mjs";

installCanvasShim();
const { THREE, LANDMARK_BUILDERS, buildAirport, createMaterialFactory, SIZE_POLICY, toMeters, m, REAL, VISUAL_BOOST, CAR_DIMENSIONS, CarVisuals, FlightVisuals, flightParamsFor, parkedCar, parkedPlane, parkedMechaSquad, roadWidthFor } = await loadCity({
  "pkg:three": ["* as THREE"],
  "engine/render/landmarkMaterials.ts": ["createMaterialFactory"],
  "engine/render/landmarkBuilders.ts": ["LANDMARK_BUILDERS"],
  "engine/cityAirport.ts": ["buildAirport"],
  "engine/roadStandard.ts": ["roadWidthFor"],
  "engine/worldScale.ts": ["SIZE_POLICY", "toMeters", "m", "REAL", "VISUAL_BOOST"],
  "game/carDimensions.ts": ["CAR_DIMENSIONS"],
  "game/CarVisuals.ts": ["CarVisuals"],
  "game/FlightVisuals.ts": ["FlightVisuals"],
  "game/FlightSimulation.ts": ["flightParamsFor"],
  "engine/render/playableVehicles.ts": ["parkedCar", "parkedPlane", "parkedMechaSquad"],
});
const report = process.argv.includes("--report");

function buildLandmark(kind) {
  const landmark = { id: `landmark:${kind}`, kind, x: 0, z: 0, yaw: 0, radius: 30, reach: 30, ...(kind === "suspension-bridge" ? { to: { x: 300, z: 0 } } : {}) };
  const group = new THREE.Group();
  const material = createMaterialFactory();
  const mesh = (geometry, mat, parent, x, y, z, ry = 0) => { const m = new THREE.Mesh(geometry, mat); m.position.set(x, y, z); m.rotation.y = ry; parent.add(m); return m; };
  const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion(); const scaleVector = new THREE.Vector3(); const positionVector = new THREE.Vector3(); const euler = new THREE.Euler();
  const host = {
    disposables: [], landmarkSpinners: [], landmarkWindows: [], layout: { terrain: { height: () => 0 } }, group: new THREE.Group(),
    nightLights: { heads: new THREE.MeshBasicMaterial(), pools: new THREE.MeshBasicMaterial(), strips: new THREE.MeshBasicMaterial(), neon: new THREE.MeshBasicMaterial() },
    compose: (x, y, z, rotationY, sx, sy, sz) => { euler.set(0, rotationY, 0); quaternion.setFromEuler(euler); positionVector.set(x, y, z); scaleVector.set(sx, sy, sz); matrix.compose(positionVector, quaternion, scaleVector); },
    matrix, color: new THREE.Color(), spillWhite: new THREE.Color(), positionVector, quaternion, scaleVector,
  };
  LANDMARK_BUILDERS[kind]({ group, landmark, mesh, material, white: material("#f3f1ea"), steel: material("#c9cfd3"), red: material("#c8473a"), cap: 70, neon: false, host });
  return group;
}

/** 只量高度：占地受规划半径约束（已有 envelope 守卫），高度才是「看起来大一号」的来源。水面以下（码头桩）不计。 */
function heightMeters(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse((o) => { if (o.isMesh && !(o.material?.blending === THREE.AdditiveBlending)) box.expandByObject(o); });
  return toMeters(box.max.y - Math.max(0, box.min.y));
}

const measured = {};
for (const kind of Object.keys(LANDMARK_BUILDERS)) measured[kind] = heightMeters(buildLandmark(kind));
measured.airport = heightMeters(buildAirport({ shore: { x: 0, z: 0 }, centre: { x: 0, z: 140 }, outward: { x: 0, z: 1 }, yaw: 0 }, [], new THREE.MeshBasicMaterial()));

const failures = [];
for (const [kind, h] of Object.entries(measured)) {
  const policy = SIZE_POLICY[kind];
  if (!policy) { failures.push(`${kind}: 没有 SIZE_POLICY 条目（实测高 ${h.toFixed(1)} m）`); continue; }
  const [lo, hi] = policy.range.map((k) => policy.real * k);
  if (report) console.log(`${kind.padEnd(18)} 实测 ${h.toFixed(1).padStart(6)} m  参考 ${String(policy.real).padStart(4)} m  ×${(h / policy.real).toFixed(2)}（允许 ×${policy.range[0]}–${policy.range[1]}）`);
  if (h < lo || h > hi) failures.push(`${kind}: 实测高 ${h.toFixed(1)} m 超出 [${lo.toFixed(1)}, ${hi.toFixed(1)}]（参考 ${policy.real} m × ${policy.range.join("–")}：${policy.why}）`);
}
// ── 交通工具（规范 V4）：每种交通工具要么按 REAL 真实尺寸，要么在 VISUAL_BOOST 里登记了倍数与理由；量模型包围盒，必须落在登记值上。──
const sizeOf = (root) => { root.updateMatrixWorld(true); const box = new THREE.Box3(); root.traverse((o) => { if (o.isMesh && o.visible && !(o.material?.blending === THREE.AdditiveBlending)) box.expandByObject(o); }); return box.getSize(new THREE.Vector3()); };
const near = (a, b, tol, what) => { if (Math.abs(a - b) > tol * Math.abs(b)) failures.push(`${what}: 实测 ${a.toFixed(3)}，登记 ${b.toFixed(3)}（±${tol * 100}%）`); };
// 玩家车：CAR_DIMENSIONS 必须等于 REAL.car × 登记倍数（缺登记或有人改了车而没改登记，这里就红）。
for (const axis of ["length", "width", "height"]) near(CAR_DIMENSIONS[axis], m(REAL.car[axis]) * VISUAL_BOOST.playerCar[axis], 1e-9, `玩家车 ${axis}`);
const car = sizeOf(new CarVisuals().root); // 车头朝 +x：x = 长、z = 宽；造型高度低于碰撞包络（座舱敞开），只要求不高出
near(car.x, CAR_DIMENSIONS.length, 0.03, "玩家车造型长"); near(car.z, CAR_DIMENSIONS.width, 0.03, "玩家车造型宽");
if (car.y > CAR_DIMENSIONS.height) failures.push(`玩家车造型高 ${car.y.toFixed(2)} 高出登记 ${CAR_DIMENSIONS.height}`);
// 飞机：翼展（z）= 4.2 r，按两端 clamp 量，倍数在登记区间内。
for (const diagonal of [100, 5000]) {
  const params = flightParamsFor(diagonal); const plane = new FlightVisuals(params); plane.group.traverse((n) => { if (n.isLight) n.visible = false; });
  const span = sizeOf(plane.group).z; const boost = span / m(VISUAL_BOOST.plane.realWingspan);
  near(span, 4.2 * params.planeRadius, 0.01, `飞机翼展（r=${params.planeRadius}）`);
  if (boost < VISUAL_BOOST.plane.range[0] - 0.01 || boost > VISUAL_BOOST.plane.range[1] + 0.01) failures.push(`飞机翼展 ×${boost.toFixed(2)} 超出登记 ${VISUAL_BOOST.plane.range.join("–")}`);
  if (report) console.log(`plane r=${params.planeRadius}  翼展 ${toMeters(span).toFixed(1)} m  ×${boost.toFixed(2)}（登记 ×${VISUAL_BOOST.plane.range.join("–")}）`);
}
// 停着的车 / 飞机：按登记的缩放摆放。
near(sizeOf(parkedCar("d", "#ffffff", [])).z, car.x * VISUAL_BOOST.parkedCar, 0.01, "停车场的车长（车头朝 +z、朝街）");
near(sizeOf(parkedPlane(5000, [])).z, 4.2 * flightParamsFor(5000).planeRadius * VISUAL_BOOST.parkedPlane, 0.01, "机坪飞机翼展");
const squad = parkedMechaSquad([]);
if (squad.children.length !== 3) failures.push(`机坪机甲应是三台，实际 ${squad.children.length}`);
for (const mech of squad.children) near(mech.scale.x, VISUAL_BOOST.parkedMecha, 1e-9, `机坪机甲 ${mech.name} 缩放`);
// ── 车辆 ↔ 路桥约束（规范 V3 表里已定值的两行）：支路 5 单位（= 10 m）放得下两车道；背景车道中线在路面内。──
const LOCAL_ROAD = roadWidthFor("local"), LATERAL_MARGIN = 0.2, AMBIENT_LANE_OFFSET = 1.2; // ambientSystem：车道中线偏路中心 1.2
if (!(LOCAL_ROAD >= 2 * (CAR_DIMENSIONS.width + 2 * LATERAL_MARGIN))) failures.push(`支路 ${LOCAL_ROAD} 放不下两条玩家车道（需 ${2 * (CAR_DIMENSIONS.width + 2 * LATERAL_MARGIN)}）`);
if (!(AMBIENT_LANE_OFFSET + m(REAL.car.width) / 2 <= LOCAL_ROAD / 2)) failures.push(`背景车道中线 ${AMBIENT_LANE_OFFSET} + 半车宽超出支路半宽 ${LOCAL_ROAD / 2}`);
if (report) console.log(`玩家车 ${CAR_DIMENSIONS.length}×${CAR_DIMENSIONS.width}×${CAR_DIMENSIONS.height}（×${Object.values(VISUAL_BOOST.playerCar).map((k) => k.toFixed(2)).join("/")}）· 造型 ${[car.x, car.z, car.y].map((v) => v.toFixed(2)).join("×")}`);

assert.deepEqual(failures, [], failures.join("\n"));
console.log(`world scale: ${Object.keys(measured).length} 个模型高度都在「真实参考 × 允许放大」之内；玩家车 / 飞机 / 停着的车与飞机的尺寸与 VISUAL_BOOST 登记一致，车辆—支路约束成立`);
