/**
 * 生命感系统：车 / 船（含游艇与尾迹）/ 云。
 * 纯搬移自 CityParts（this → host），行为与场景图保持逐字节一致。
 */

import { m, REAL } from "../worldScale";
import * as THREE from "three";
import { hashSeed } from "../../cityModel";
import type { CityLayout, Vec2 } from "../cityLayout";
import { baseSpeedOf, mergeGeometries, samplePolyline } from "../render/shared";
import type { Car, CarPath } from "../render/types";
import { createRenderCanvas } from "../renderCanvas";

/** ambientSystem 用到的 CityParts 成员（调用方以 `this as unknown as AmbientHost` 传入）。 */
export interface AmbientHost {
  readonly layout: CityLayout;
  readonly group: THREE.Group;
  readonly disposables: Array<{ dispose: () => void }>;
  readonly matrix: THREE.Matrix4;
  readonly color: THREE.Color;
  readonly cars: Car[];
  readonly carMesh: THREE.InstancedMesh;
  carKeep: number;
  yachtMesh: THREE.InstancedMesh | null;
  yachtIndices: number[];
  compose(x: number, y: number, z: number, rotationY: number, sx: number, sy: number, sz: number): void;
}

function polyCumulative(points: Vec2[]): { cumulative: number[]; total: number } {
  const cumulative = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
    cumulative.push(total);
  }
  return { cumulative, total };
}

export function buildCars(host: AmbientHost): { mesh: THREE.InstancedMesh; cars: Car[] } {
  const paths: CarPath[] = [];
  for (const district of host.layout.districts) {
    for (const path of district.carPaths) {
      const { cumulative, total } = polyCumulative(path);
      paths.push({ points: path, cumulative, total, y: 0.08, terrain: district.terrain });
    }
  }
  const cars: Car[] = [];
  paths.forEach((path, pathIndex) => {
    const count = 3;
    for (let index = 0; index < count; index += 1) {
      const seed = hashSeed(`car:${pathIndex}:${index}`);
      cars.push({ path, distance: (index / count) * path.total + seed * 5, speed: m(REAL.carSpeed.min + seed * (REAL.carSpeed.max - REAL.carSpeed.min)) });
    }
  });
  const carColors = ["#f8f5ec", "#c96f4a", "#4d7ca8", "#3f8f7a", "#d8a13c", "#8d5a5a"];
  // 轿车 4.5 × 1.5 × 1.8 m（REAL.car，经 worldScale 换算）；车道中线偏路中心 1.2 单位（= 2.4 m）。
  const geometry = new THREE.BoxGeometry(m(REAL.car.length), m(REAL.car.height), m(REAL.car.width)).translate(0, m(REAL.car.height) / 2, 0);
  const material = new THREE.MeshLambertMaterial({ color: "#ffffff" });
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(cars.length, 1));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  cars.forEach((car, index) => {
    const tint = carColors[Math.floor(hashSeed(`carc:${index}`) * carColors.length)];
    mesh.setColorAt(index, host.color.set(tint));
  });
  mesh.count = cars.length;
  mesh.frustumCulled = false;
  host.group.add(mesh);
  host.disposables.push(geometry, material);
  return { mesh, cars };
}

export function buildBoats(host: AmbientHost): { mesh: THREE.InstancedMesh; boats: Array<{ path: CarPath; distance: number; speed: number; phase: number; wakeTimer: number }>; wakeMesh: THREE.InstancedMesh; wakes: Array<{ x: number; z: number; birth: number; driftX: number; driftZ: number }> } {
  // 船沿海岸外扩航道巡航（折线推进，与车辆同一套采样）。
  const boats: ReturnType<typeof buildBoats>["boats"] = [];
  host.layout.boatLoops?.forEach((loop, laneIndex) => {
    const { cumulative, total } = polyCumulative(loop);
    const count = 3 + (laneIndex % 2);
    for (let index = 0; index < count; index += 1) {
      boats.push({
        path: { points: loop, cumulative, total, y: -0.3, terrain: null },
        distance: (index / count) * total + hashSeed(`bd:${laneIndex}:${index}`) * 40,
        speed: (laneIndex % 2 === 0 ? 1 : -1) * (2.6 + hashSeed(`bs:${laneIndex}:${index}`) * 1.6),
        phase: hashSeed(`bp:${laneIndex}:${index}`) * Math.PI * 2,
        wakeTimer: hashSeed(`bt:${laneIndex}:${index}`) * 0.3,
      });
    }
  });
  // 船体按 11.5 长 × 4 宽的样船建模，长/宽/高三轴各自换算到 REAL.boat / REAL.yacht 的真实尺寸——
  // 曾按船长等比放大：28 m 游艇高 16 m、宽 9.7 m（真船宽 6.5、水线以上 ~9），像一栋漂着的楼。
  const hull = new THREE.BoxGeometry(11.5, 2, 4).translate(0, 1, 0);
  const cabin = new THREE.BoxGeometry(4.3, 1.8, 2.9).translate(1.4, 2.9, 0);
  const geometry = mergeGeometries([hull, cabin]).scale(m(REAL.boat.length) / 11.5, m(REAL.boat.height) / 3.8, m(REAL.boat.beam) / 4);
  const material = new THREE.MeshLambertMaterial({ color: "#f2efe6" });
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(boats.length, 1));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  boats.forEach((boat, index) => {
    mesh.setColorAt(index, host.color.set(index % 3 === 0 ? "#c96f4a" : index % 3 === 1 ? "#5d7f9a" : "#e8e2d5"));
  });
  mesh.count = boats.length;
  mesh.frustumCulled = false;
  host.group.add(mesh);
  host.disposables.push(geometry, material, hull, cabin);
  // 飞桥游艇（VICE S3）：2 艘白色豪华游艇——船体+飞桥层+桅杆。比斯坎湾意象。
  // 单独批次（几何更复杂），复用现有航道与尾迹系统。
  {
    const yachtCount = 2;
    const flybridge = new THREE.BoxGeometry(3.4, 1.4, 2.2).translate(-1.8, 4.2, 0);
    const radarArch = new THREE.BoxGeometry(0.3, 2.2, 2.4).translate(-3.6, 5.4, 0);
    const bowSpray = new THREE.ConeGeometry(0.5, 2.5, 4).rotateZ(-Math.PI / 2).translate(6.5, 0.8, 0);
    // 飞桥游艇 28 m（REAL.yacht，Vice 式比斯坎湾游艇）。
    // 样船总高 6.5（雷达拱顶）、宽 4（飞桥 2.4 内收）。
    const yachtGeometry = mergeGeometries([hull.clone(), cabin.clone(), flybridge, radarArch, bowSpray])
      .scale(m(REAL.yacht.length) / 11.5, m(REAL.yacht.height) / 6.5, m(REAL.yacht.beam) / 4);
    const yachtMaterial = new THREE.MeshLambertMaterial({ color: "#f8f6f0" });
    const yachtMesh = new THREE.InstancedMesh(yachtGeometry, yachtMaterial, yachtCount);
    yachtMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    yachtMesh.frustumCulled = false;
    yachtMesh.name = "city-yachts";
    // 挑 2 艘船的位置替换为游艇（索引 0 和 lane 1 的 0 号）。
    host.yachtIndices = boats.length > 0 ? [0, Math.min(boats.length - 1, 3)] : [];
    host.yachtMesh = yachtMesh;
    host.yachtMesh.count = host.yachtIndices.length;
    for (let y = 0; y < host.yachtIndices.length; y += 1) {
      yachtMesh.setColorAt(y, host.color.set(y === 0 ? "#f8f6f0" : "#e8e4d8"));
    }
    host.group.add(yachtMesh);
    host.disposables.push(yachtGeometry, yachtMaterial, flybridge, radarArch, bowSpray);
  }
  // 尾迹泡沫（tinyskies WakeTrail 手法）：船尾定期吐软圆斑，漂移放大后消散。
  // 径向渐变贴图让圆斑边缘衰减——纯色圆片读作沙盘贴纸，不像浪花。
  const foamCanvas = createRenderCanvas();
  foamCanvas.width = foamCanvas.height = 64;
  const foamCtx = foamCanvas.getContext("2d");
  if (foamCtx) {
    const gradient = foamCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,0.95)");
    gradient.addColorStop(0.45, "rgba(255,255,255,0.4)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    foamCtx.fillStyle = gradient;
    foamCtx.fillRect(0, 0, 64, 64);
  }
  const foamTexture = new THREE.CanvasTexture(foamCanvas);
  const foamMaterial = new THREE.MeshBasicMaterial({ color: "#eef6f7", map: foamTexture, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
  const wakeGeometry = new THREE.CircleGeometry(1, 10).rotateX(-Math.PI / 2);
  const wakeMesh = new THREE.InstancedMesh(wakeGeometry, foamMaterial, 128);
  wakeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  wakeMesh.frustumCulled = false;
  wakeMesh.renderOrder = 1;
  const wakes: Array<{ x: number; z: number; birth: number; driftX: number; driftZ: number }> = [];
  for (let index = 0; index < 128; index += 1) {
    wakes.push({ x: 0, z: 0, birth: -1, driftX: 0, driftZ: 0 });
    host.compose(0, -60, 0, 0, 0.0001, 0.0001, 0.0001);
    wakeMesh.setMatrixAt(index, host.matrix);
  }
  host.group.add(wakeMesh);
  host.disposables.push(foamTexture, foamMaterial, wakeGeometry);
  return { mesh, boats, wakeMesh, wakes };
}

export function buildClouds(host: AmbientHost): { mesh: THREE.InstancedMesh; clouds: Array<{ x: number; z: number; y: number; speed: number; scale: number }> } {
  const clouds: Array<{ x: number; z: number; y: number; speed: number; scale: number }> = [];
  const bounds = host.layout.boundsRadius + 40;
  for (let index = 0; index < 3; index += 1) {
    const seed = hashSeed(`cloud:${index}`);
    clouds.push({
      x: (seed - 0.5) * bounds * 2,
      z: (hashSeed(`cz:${index}`) - 0.5) * bounds * 2,
      y: 220 + seed * 44,
      speed: 0.65 + seed * 0.7,
      scale: 0.5 + seed * 0.4,
    });
  }
  const geometry = new THREE.SphereGeometry(1, 8, 6);
  const material = new THREE.MeshLambertMaterial({ color: "#ffffff", transparent: true, opacity: 0.88, fog: false });
  const mesh = new THREE.InstancedMesh(geometry, material, clouds.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  clouds.forEach((cloud, index) => {
    const blob = 9.5 * cloud.scale;
    host.compose(cloud.x, cloud.y, cloud.z, 0, blob * 1.6, blob * 0.34, blob * 0.8);
    mesh.setMatrixAt(index, host.matrix);
  });
  mesh.count = clouds.length;
  mesh.frustumCulled = false;
  host.group.add(mesh);
  host.disposables.push(geometry, material);
  return { mesh, clouds };
}

/** 低画质只开一半车：多出来的车缩成 0（藏起），速度从「原速」取回。
 *  曾直接把 speed 写成 0 且不留原速：掉到 Q0 一次，那一半车整场会话都冻在原地（升档也不恢复），
 *  冻结时的矩阵还取决于掉档那一刻——同一座城两次导出的车位置不同。 */
export function applyCarDensity(host: AmbientHost): void {
  const visibleCars = Math.floor(host.cars.length * host.carKeep);
  host.cars.forEach((car, index) => {
    const speed = baseSpeedOf(car);
    car.speed = index < visibleCars ? speed : 0;
    placeCar(host, car, index, index < visibleCars);
  });
  host.carMesh.instanceMatrix.needsUpdate = true;
}

export function placeCar(host: AmbientHost, car: Car, index: number, visible: boolean): void {
  if (!visible) {
    host.compose(0, -40, 0, 0, 0, 0, 0);
  } else {
    const sample = samplePolyline(car.path, car.distance);
    const y = car.path.terrain ? car.path.terrain.height(sample.x, sample.z) + car.path.y : car.path.y;
    host.compose(sample.x - sample.dz * 1.2, y + 0.04, sample.z + sample.dx * 1.2, Math.atan2(-sample.dz, sample.dx), 1, 1, 1);
  }
  host.carMesh.setMatrixAt(index, host.matrix);
}
