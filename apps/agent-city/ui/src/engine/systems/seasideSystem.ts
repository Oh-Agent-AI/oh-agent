/**
 * 滨海系统：步道、沙滩设施/人物/沙排、沙滩色带、码头、救生塔。
 * 纯搬移自 CityParts（CITY_ENGINE_SPLIT_SPEC §4-6）：函数体逐字不变，`this.` -> `host.`。
 */

import { m, METER_MODEL_SCALE, REAL } from "../worldScale";
import * as THREE from "three";
import { hashSeed } from "../../cityModel";
import type { CityLayout, Vec2 } from "../cityLayout";
import { SegmentIndex, polygonDistance } from "../cityPlan";
import { validRuns } from "../citySeaside";
import { mergeGeometries } from "../render/shared";
import type { NightLights } from "../render/types";
import { clipConvexToTerrain, terrainFit } from "../surface/terrainClip";
import { ROAD_SURFACE_LIFT } from "../surface/groundRoadCompiler";

/** 本系统读写的 CityParts 成员（精确清单；CityParts 以 `this as unknown as SeasideHost` 传入）。 */
export interface SeasideHost {
  readonly layout: CityLayout;
  readonly group: THREE.Group;
  readonly disposables: Array<{ dispose: () => void }>;
  readonly matrix: THREE.Matrix4;
  readonly quaternion: THREE.Quaternion;
  readonly euler: THREE.Euler;
  readonly scaleVector: THREE.Vector3;
  readonly positionVector: THREE.Vector3;
  readonly color: THREE.Color;
  nightLights: NightLights | null;
  lifeguardGlowMaterial: THREE.MeshBasicMaterial | null;
  compose(x: number, y: number, z: number, rotationY: number, sx: number, sy: number, sz: number): void;
}

/** 滨海步道（VICE B3）：沿 promenade 折线的浅色铺装缎带——人行道语义，不进
 *  roadEdges/carPaths（机动车不会开上步道）。单 BufferGeometry，静态缓存段。 */
/** S3「滨海景观带随用地走」：环岛滨海路在建成区（会话楼 160 内）旁的岸段，向海一侧 9 处铺同一套步道
 *  （粉色铺装 + 白色矮墙 + 路灯）。曾只有海滨那一段 85° 弧有景观带，住宅区一直排到海边、景观带却停了（真机截图）。 */
export function urbanPromenadeSegments(host: SeasideHost): Vec2[][] {
  const slots = host.layout.districts.flatMap((district) => [...district.slots.values()]);
  if (!slots.length) return [];
  const near = new SegmentIndex(slots.map((slot) => [slot, slot]));
  const terrain = host.layout.terrain;
  const byWidth = new Map<number, Vec2[][]>();
  for (const edge of host.layout.roadEdges) (byWidth.get(edge.width) ?? byWidth.set(edge.width, []).get(edge.width)!).push(edge.points);
  const roadIndex = [...byWidth].map(([width, runs]) => ({ clearance: width / 2 + 4.2 + 0.8, index: new SegmentIndex(runs) }));
  const clearOfRoads = (q: Vec2) => roadIndex.every(({ clearance, index }) => !index.closerThan(q, clearance));
  const out: Vec2[][] = [];
  for (const run of host.layout.coastRoads ?? []) {
    let current: Vec2[] = [];
    for (let i = 0; i < run.length; i += 1) {
      const a = run[Math.max(0, i - 1)]; const b = run[Math.min(run.length - 1, i + 1)];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      let nx = -(b.z - a.z) / len; let nz = (b.x - a.x) / len;
      const p = run[i];
      // 朝海一侧按到海岸线的距离判：沙滩与内陆平原同高（1.2），比地形高度时近似抛硬币——步道被铺到了陆侧（截图验收）。
      if (Math.abs(polygonDistance({ x: p.x + nx * 12, z: p.z + nz * 12 }, host.layout.coast)) > Math.abs(polygonDistance({ x: p.x - nx * 12, z: p.z - nz * 12 }, host.layout.coast))) { nx = -nx; nz = -nz; }
      // 离路中线 13：路半宽 6 + 步道半宽 4.2 + 2.8 间隙。曾是 9——比两者半宽之和 10.2 还小，步道压在马路上（真机截图）。
      // 弯道处偏移点仍可能落进本路或别的路：按各路实际半宽逐点检查，压路处断开步道。
      const q = { x: p.x + nx * 13, z: p.z + nz * 13 };
      if (near.closerThan(p, 160) && terrain.height(q.x, q.z) > 0.4 && clearOfRoads(q)) current.push(q);
      else { if (current.length >= 3) out.push(current); current = []; }
    }
    if (current.length >= 3) out.push(current);
  }
  // 逐 3 单位加密并再查一次：点距 ~20，横穿两点之间的支路/接入路会漏检（截图验收：斜向接入路压过步道）。
  const dense: Vec2[][] = [];
  for (const segment of out) {
    let piece: Vec2[] = [];
    for (let i = 0; i < segment.length; i += 1) {
      const a = segment[i]; const b = segment[i + 1];
      const steps = b ? Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 3)) : 1;
      for (let k = 0; k < steps; k += 1) {
        const t = b ? k / steps : 0;
        const q = b ? { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t } : a;
        if (clearOfRoads(q)) piece.push(q);
        else { if (piece.length >= 4) dense.push(piece); piece = []; }
      }
    }
    if (piece.length >= 4) dense.push(piece);
  }
  return dense;
}

export function buildPromenade(host: SeasideHost, segments: Vec2[][]): void {
  if (!segments.length) return;
  const half = 4.2;
  const positions: number[] = [];
  for (const polyline of segments)
  for (let i = 1; i < polyline.length; i += 1) {
    const a = polyline[i - 1]; const b = polyline[i];
    const dx = b.x - a.x; const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len * half; const nz = dx / len * half;
    const ay = host.layout.terrain.height(a.x, a.z) + 0.07;
    const by = host.layout.terrain.height(b.x, b.z) + 0.07;
    // 逆时针（从上往下看）绕序 → 法线朝上；曾生成朝下法线被背面剔除（俯视消失）。
    positions.push(a.x + nx, ay, a.z + nz, b.x - nx, by, b.z - nz, a.x - nx, ay, a.z - nz,
                   a.x + nx, ay, a.z + nz, b.x + nx, by, b.z + nz, b.x - nx, by, b.z - nz);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  // 粉色铺装（迈阿密步道的辨识色）：曾用 #d4c8a8，和干沙几乎同色，真机上步道看不出来。
  const material = new THREE.MeshLambertMaterial({ color: "#e7b3a3" });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "city-promenade";
  mesh.receiveShadow = true;
  host.group.add(mesh);
  host.disposables.push(geometry, material);
  // 朝海一侧的白色矮墙（隔开沙滩与步道）+ 朝陆一侧每 ~16 单位一盏路灯。
  const unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const furniture = new THREE.MeshLambertMaterial({ color: "#ffffff" });
  type Piece = { x: number; y: number; z: number; yaw: number; w: number; h: number; d: number; color: string; glow?: boolean };
  const pieces: Piece[] = [];
  for (const polyline of segments) {
    let sinceLamp = 8;
    for (let i = 1; i < polyline.length; i += 1) {
      const a = polyline[i - 1]; const b = polyline[i];
      const dx = b.x - a.x; const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      // 左法线 (-dz, dx)；朝海一侧 = 地形更低的一侧。
      let nx = -dz / len; let nz = dx / len;
      const mx = (a.x + b.x) / 2; const mz = (a.z + b.z) / 2;
      if (host.layout.terrain.height(mx + nx * 8, mz + nz * 8) > host.layout.terrain.height(mx - nx * 8, mz - nz * 8)) { nx = -nx; nz = -nz; }
      const yaw = -Math.atan2(dz, dx);
      const wx = mx + nx * (half + 0.2); const wz = mz + nz * (half + 0.2);
      pieces.push({ x: wx, y: host.layout.terrain.height(wx, wz), z: wz, yaw, w: len + 0.3, h: 0.55, d: 0.35, color: "#f7f3ea" });
      for (let d = 0; d < len; d += 1) {
        sinceLamp += 1;
        if (sinceLamp < 16) continue;
        sinceLamp = 0;
        const t = d / len;
        const lx = a.x + dx * t - nx * (half - 0.4); const lz = a.z + dz * t - nz * (half - 0.4);
        const ly = host.layout.terrain.height(lx, lz);
        pieces.push({ x: lx, y: ly, z: lz, yaw, w: 0.14, h: 3.6, d: 0.14, color: "#3c4650" });
        pieces.push({ x: lx, y: ly + 3.6, z: lz, yaw, w: 0.5, h: 0.22, d: 0.5, color: "#fff1c9", glow: true });
      }
    }
  }
  if (pieces.length) {
    const props = new THREE.InstancedMesh(unit, furniture, pieces.length);
    pieces.forEach((piece, i) => {
      host.positionVector.set(piece.x, piece.y, piece.z);
      host.euler.set(0, piece.yaw, 0); host.quaternion.setFromEuler(host.euler);
      host.scaleVector.set(piece.w, piece.h, piece.d);
      host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector);
      props.setMatrixAt(i, host.matrix); props.setColorAt(i, host.color.set(piece.color));
    });
    props.castShadow = true;
    props.instanceMatrix.needsUpdate = true;
    if (props.instanceColor) props.instanceColor.needsUpdate = true;
    props.name = "city-promenade-props";
    host.group.add(props);
    // 夜里亮灯：灯头另起一批，用路灯灯头同一份自发光材质（setNightGlow 已按夜色驱动、白天熄灭）。
    // 曾与灯杆同一 Lambert 批次，夜里步道一片漆黑（剩余项清单「步道路灯夜里不亮」）。
    const heads = pieces.filter((piece) => piece.glow);
    if (heads.length && host.nightLights) {
      const glowMesh = new THREE.InstancedMesh(unit, host.nightLights.heads, heads.length);
      heads.forEach((piece, i) => {
        host.positionVector.set(piece.x, piece.y + 0.01, piece.z);
        host.euler.set(0, piece.yaw, 0); host.quaternion.setFromEuler(host.euler);
        host.scaleVector.set(piece.w * 1.05, piece.h * 1.1, piece.d * 1.05);
        host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector);
        glowMesh.setMatrixAt(i, host.matrix);
      });
      glowMesh.instanceMatrix.needsUpdate = true;
      glowMesh.name = "city-promenade-props";
      host.group.add(glowMesh);
    }
  }
  host.disposables.push(unit, furniture);
}

/** 沙滩设施：遮阳伞（伞杆 + 伞面）与躺椅，成组散布在干沙上——真机反馈「看不到沙滩和海滨设施」。
 *  沿连续合法岸段每 ~9 单位一组，位置/颜色由确定性 hash 抖动；救生塔附近留空。 */
export function buildBeachFurniture(host: SeasideHost): void {
  const seaside = host.layout.seaside;
  if (!seaside || seaside.degraded) return;
  const wet = host.layout.coastalConfig?.wetSandWidth ?? 7;
  const dry = host.layout.coastalConfig?.drySandWidth ?? 14;
  type Spot = { x: number; z: number; yaw: number; seed: number };
  const spots: Spot[] = [];
  // 沙排场：沿每段连续海岸累计弧长，每 ~110 单位一块（段首留 30），场地长轴沿岸、居干沙中线。
  const courts: Spot[] = [];
  for (const run of validRuns(seaside)) {
    let walked = 0; let next = 30;
    for (let i = 1; i < run.length; i += 1) {
      const a = run[i - 1]; const b = run[i];
      const length = Math.hypot(b.waterline.x - a.waterline.x, b.waterline.z - a.waterline.z);
      while (next <= walked + length) {
        const t = (next - walked) / length;
        const inx = a.inward.x + (b.inward.x - a.inward.x) * t; const inz = a.inward.z + (b.inward.z - a.inward.z) * t;
        const norm = Math.hypot(inx, inz) || 1;
        const depth = (wet + dry) / 2 + 0.5;
        const x = a.waterline.x + (b.waterline.x - a.waterline.x) * t + (inx / norm) * depth;
        const z = a.waterline.z + (b.waterline.z - a.waterline.z) * t + (inz / norm) * depth;
        if (host.layout.terrain.height(x, z) > 0.2) courts.push({ x, z, yaw: Math.atan2(inx, inz), seed: hashSeed(`court:${courts.length}`) });
        next += 110;
      }
      walked += length;
    }
  }
  for (const run of validRuns(seaside)) for (let i = 1; i < run.length; i += 1) {
    const a = run[i - 1]; const b = run[i];
    const length = Math.hypot(b.waterline.x - a.waterline.x, b.waterline.z - a.waterline.z);
    for (let d = 4; d < length; d += 9) {
      const t = d / length;
      const seed = hashSeed(`beach:${Math.round(a.waterline.x)}:${Math.round(a.waterline.z)}:${d}`);
      if (seed < 0.18) continue; // 留一些空沙滩
      const inx = a.inward.x + (b.inward.x - a.inward.x) * t; const inz = a.inward.z + (b.inward.z - a.inward.z) * t;
      const norm = Math.hypot(inx, inz) || 1;
      const depth = wet + 1.5 + seed * (dry - wet - 2.5);
      const x = a.waterline.x + (b.waterline.x - a.waterline.x) * t + (inx / norm) * depth;
      const z = a.waterline.z + (b.waterline.z - a.waterline.z) * t + (inz / norm) * depth;
      if (host.layout.terrain.height(x, z) < 0.2) continue;
      if (courts.some((court) => Math.hypot(court.x - x, court.z - z) < 12)) continue; // 给沙排场让位
      spots.push({ x, z, yaw: Math.atan2(inx, inz), seed });
    }
  }
  buildBeachLife(host, courts, spots, wet);
  if (!spots.length) return;
  const colors = ["#ff5fa8", "#00c2d1", "#ffb03a", "#ffffff", "#7a5cff", "#ff6b4a"];
  // 伞、躺椅、人、沙排场、救生塔、码头小艇都按真实米建模，经 worldScale 换算（1 单位 = 2 m）。
  const poleGeometry = new THREE.CylinderGeometry(m(0.04), m(0.04), m(REAL.umbrella.height), 5).translate(0, m(REAL.umbrella.height) / 2, 0);
  const canopyGeometry = new THREE.ConeGeometry(m(REAL.umbrella.diameter / 2), m(0.5), 8).translate(0, m(REAL.umbrella.height) + m(0.1), 0);
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const poleMaterial = new THREE.MeshLambertMaterial({ color: "#f2ede2" });
  const canopyMaterial = new THREE.MeshLambertMaterial({ color: "#ffffff" });
  const loungerMaterial = new THREE.MeshLambertMaterial({ color: "#ffffff" });
  const poles = new THREE.InstancedMesh(poleGeometry, poleMaterial, spots.length);
  const canopies = new THREE.InstancedMesh(canopyGeometry, canopyMaterial, spots.length);
  const loungers = new THREE.InstancedMesh(box, loungerMaterial, spots.length * 2);
  canopies.castShadow = true;
  let lounger = 0;
  spots.forEach((spot, i) => {
    const y = host.layout.terrain.height(spot.x, spot.z);
    host.compose(spot.x, y, spot.z, spot.yaw + spot.seed * 0.6, 1, 1, 1);
    poles.setMatrixAt(i, host.matrix);
    canopies.setMatrixAt(i, host.matrix);
    canopies.setColorAt(i, host.color.set(colors[Math.floor(spot.seed * 997) % colors.length]));
    // 两张躺椅并排、朝海（局部 z = 内向，椅子摆在伞的朝海一侧）。
    const sx = Math.sin(spot.yaw); const sz = Math.cos(spot.yaw);
    for (const side of [-m(0.5), m(0.5)]) {
      const lx = spot.x - sx * m(1.6) + sz * side; const lz = spot.z - sz * m(1.6) - sx * side;
      host.compose(lx, y + 0.02, lz, spot.yaw, m(REAL.lounger.width), m(REAL.lounger.height), m(REAL.lounger.length));
      loungers.setMatrixAt(lounger, host.matrix);
      loungers.setColorAt(lounger, host.color.set(spot.seed > 0.6 ? "#fff4ec" : "#4fd1d9"));
      lounger += 1;
    }
  });
  loungers.count = lounger;
  for (const mesh of [poles, canopies, loungers]) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = "city-beach-furniture";
    mesh.receiveShadow = true;
  }
  host.group.add(poles, canopies, loungers);
  host.disposables.push(poleGeometry, canopyGeometry, box, poleMaterial, canopyMaterial, loungerMaterial);
}

/** 沙排场 + 沙滩人物。人物是静态的、真实比例（身高 ~1.75，躺椅长 1.9，与之同尺度），
 *  比楼小得多：曾经的街区行人是刻意超比例的人偶，且沿车行路网走（真机：「在公路上走」）。
 *  人形 = 双腿 + 躯干（衣色）+ 双臂 + 头（肤色），两个 InstancedMesh 共用矩阵。 */
export function buildBeachLife(host: SeasideHost, courts: Array<{ x: number; z: number; yaw: number; seed: number }>, spots: Array<{ x: number; z: number; yaw: number; seed: number }>, wet: number): void {
  const dummy = new THREE.Object3D();
  const box = (w: number, h: number, d: number, x: number, y: number, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
  const clothesParts = [box(0.15, 0.82, 0.18, -0.1, 0), box(0.15, 0.82, 0.18, 0.1, 0), box(0.4, 0.58, 0.22, 0, 0.82)];
  const skinParts = [box(0.1, 0.56, 0.11, -0.26, 0.86), box(0.1, 0.56, 0.11, 0.26, 0.86), new THREE.SphereGeometry(0.13, 8, 6).translate(0, 1.6, 0)];
  // 人形按 1 单位 = 1 米建（身高 ~1.75）：整体乘 METER_MODEL_SCALE 换算到当前比例尺。
  const clothesGeometry = mergeGeometries(clothesParts).scale(METER_MODEL_SCALE, METER_MODEL_SCALE, METER_MODEL_SCALE);
  const skinGeometry = mergeGeometries(skinParts).scale(METER_MODEL_SCALE, METER_MODEL_SCALE, METER_MODEL_SCALE);
  [...clothesParts, ...skinParts].forEach((g) => g.dispose());
  type Pose = { x: number; z: number; yaw: number; lying?: boolean; seed: number };
  const people: Pose[] = [];
  const local = (spot: { x: number; z: number; yaw: number }, across: number, along: number) => {
    // 局部 z = 内向（朝陆），局部 x = 沿岸。
    const sx = Math.sin(spot.yaw); const sz = Math.cos(spot.yaw);
    return { x: spot.x + sx * across + sz * along, z: spot.z + sz * across - sx * along };
  };
  // 每块沙排场 4 名球员，两边各二，面向球网。
  for (const court of courts) for (let k = 0; k < 4; k += 1) {
    const side = k < 2 ? -1 : 1; const lane = k % 2 === 0 ? -m(2) : m(2);
    const p = local(court, lane, side * m(3 + hashSeed(`player:${court.x}:${k}`) * 3));
    people.push({ ...p, yaw: court.yaw + (side < 0 ? Math.PI / 2 : -Math.PI / 2), seed: hashSeed(`pl:${court.x}:${k}`) });
  }
  // 伞下：约三分之一的伞旁有人躺在躺椅上，另有少数站着。
  for (const spot of spots) {
    if (spot.seed > 0.66) people.push({ ...local(spot, -m(1.6), m(0.5)), yaw: spot.yaw, lying: true, seed: spot.seed });
    else if (spot.seed < 0.3) people.push({ ...local(spot, m(0.6), -m(1.4)), yaw: spot.yaw + spot.seed * 6, seed: spot.seed });
  }
  // 水边散步的人：湿沙上，零星分布。
  for (const spot of spots) if (spot.seed > 0.4 && spot.seed < 0.52) {
    const p = local(spot, -(spot.seed * 0 + (wet * 0.5 + 2)), 0);
    people.push({ ...p, yaw: spot.yaw + Math.PI / 2, seed: spot.seed });
  }
  if (people.length) {
    const clothesMaterial = new THREE.MeshLambertMaterial({ color: "#ffffff" });
    const skinMaterial = new THREE.MeshLambertMaterial({ color: "#ffffff" });
    const clothes = new THREE.InstancedMesh(clothesGeometry, clothesMaterial, people.length);
    const skin = new THREE.InstancedMesh(skinGeometry, skinMaterial, people.length);
    const outfits = ["#ff5fa8", "#00a6b8", "#ffb03a", "#f4f1ea", "#3b4a8c", "#e2483d", "#2f8f5b"];
    const tones = ["#f1c9a5", "#d9a77c", "#b07a52", "#7a4e33"];
    people.forEach((person, i) => {
      const y = host.layout.terrain.height(person.x, person.z);
      dummy.position.set(person.x, y + (person.lying ? m(REAL.lounger.height) : 0), person.z);
      // 躺着 = 绕局部 x 轴放倒 90°，头朝内陆（躺椅靠背一侧）。
      dummy.rotation.set(person.lying ? -Math.PI / 2 : 0, person.yaw + (person.lying ? Math.PI : 0), 0, "YXZ");
      dummy.scale.setScalar(0.92 + person.seed * 0.16);
      dummy.updateMatrix();
      clothes.setMatrixAt(i, dummy.matrix); skin.setMatrixAt(i, dummy.matrix);
      clothes.setColorAt(i, host.color.set(outfits[Math.floor(person.seed * 7919) % outfits.length]));
      skin.setColorAt(i, host.color.set(tones[Math.floor(person.seed * 104729) % tones.length]));
    });
    for (const mesh of [clothes, skin]) {
      mesh.castShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.name = "city-beach-people";
    }
    host.group.add(clothes, skin);
    host.disposables.push(clothesMaterial, skinMaterial);
  }
  host.disposables.push(clothesGeometry, skinGeometry);
  // 沙排场：白色边线 + 两根网柱 + 球网（场地 14×7，长轴沿岸）。
  if (courts.length) {
    const unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const courtMaterial = new THREE.MeshLambertMaterial({ color: "#ffffff" });
    const parts = new THREE.InstancedMesh(unit, courtMaterial, courts.length * 8);
    let n = 0;
    const put = (spot: { x: number; z: number; yaw: number }, across: number, along: number, w: number, h: number, d: number, y: number, color: string) => {
      const p = local(spot, across, along);
      dummy.position.set(p.x, host.layout.terrain.height(p.x, p.z) + y, p.z);
      dummy.rotation.set(0, spot.yaw, 0); dummy.scale.set(w, h, d); dummy.updateMatrix();
      parts.setMatrixAt(n, dummy.matrix); parts.setColorAt(n, host.color.set(color)); n += 1;
    };
    for (const court of courts) {
      // 场地 16 × 8 m（长轴沿岸），网柱在边线外 0.5，网高 2.43（REAL.volleyballCourt）。
      const L = m(REAL.volleyballCourt.length); const W = m(REAL.volleyballCourt.width); const net = m(REAL.volleyballCourt.netHeight);
      put(court, -W / 2, 0, L, 0.02, m(0.1), 0.005, "#f6f2e6"); put(court, W / 2, 0, L, 0.02, m(0.1), 0.005, "#f6f2e6");
      put(court, 0, -L / 2, m(0.1), 0.02, W, 0.005, "#f6f2e6"); put(court, 0, L / 2, m(0.1), 0.02, W, 0.005, "#f6f2e6");
      put(court, -W / 2 - m(0.5), 0, m(0.12), net, m(0.12), 0, "#e9e4d6"); put(court, W / 2 + m(0.5), 0, m(0.12), net, m(0.12), 0, "#e9e4d6");
      put(court, 0, 0, m(0.03), m(1), W + m(1), net - m(1), "#6f7b84");   // 球网（纯黑像一块板，灰调读作网）
      put(court, 0, 0, m(0.05), m(0.08), W + m(1), net - m(0.04), "#f6f2e6");  // 网顶白带
    }
    parts.count = n;
    parts.castShadow = true;
    parts.instanceMatrix.needsUpdate = true;
    if (parts.instanceColor) parts.instanceColor.needsUpdate = true;
    parts.name = "city-volleyball-courts";
    host.group.add(parts);
    host.disposables.push(unit, courtMaterial);
  }
}

/** 沙滩网格：沿整条海岸线（地形的岸线就是这条 96 点折线）铺贴地色带——浪花 / 湿沙 / 干沙，
 *  每条色带是独立的平面四边形，边缘锐利。海滨段铺全宽（干沙 + 路缘），其余海岸铺窄的自然沙滩；
 *  山坡/悬崖、港口与河口处不铺。曾只有海滨那 85° 一段有沙滩，且画在低分辨率贴图里（真机：糊、少）。
 *  向海一侧延伸到水下 6 单位，水线由水面与地形自然相交给出。 */
export function buildBeachRibbon(host: SeasideHost): void {
  const coast = host.layout.coast;
  if (!coast || coast.length < 3) return;
  const terrain = host.layout.terrain;
  const config = host.layout.coastalConfig;
  const wet = config?.wetSandWidth ?? 7;
  const fullDepth = (config?.drySandWidth ?? 20) + 3;
  const naturalDepth = 10;
  const seaside = host.layout.seaside && !host.layout.seaside.degraded ? host.layout.seaside : null;
  const seasidePoints = seaside ? seaside.samples.filter((s) => s.valid).map((s) => s.waterline) : [];
  const harbors = host.layout.publicSites.filter((site) => site.kind === "harbor");
  const river = host.layout.river ?? [];
  const nearRiver = (x: number, z: number) => river.some((p) => Math.hypot(p.x - x, p.z - z) < 34);
  const n = coast.length;
  // 每个岸点：内向法线 + 沙滩进深（0 = 不铺）。
  const vertex = coast.map((p, i) => {
    const prev = coast[(i - 1 + n) % n]; const next = coast[(i + 1) % n];
    let nx = -(next.z - prev.z); let nz = next.x - prev.x;
    const len = Math.hypot(nx, nz) || 1; nx /= len; nz /= len;
    if (terrain.height(p.x + nx * 8, p.z + nz * 8) < terrain.height(p.x - nx * 8, p.z - nz * 8)) { nx = -nx; nz = -nz; }
    let depth = seasidePoints.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.5) ? fullDepth : naturalDepth;
    if (terrain.height(p.x + nx * depth, p.z + nz * depth) > 5) depth = 0;         // 山坡/悬崖
    if (harbors.some((h) => Math.hypot(h.x - p.x, h.z - p.z) < h.radius + 26)) depth = 0;
    if (nearRiver(p.x, p.z)) depth = 0;
    return { p, nx, nz, depth };
  });
  const positions: number[] = []; const colors: number[] = [];
  // Sand is a terrain overlay, below the road layer. Sampling procedural
  // heights + 0.05 put it ABOVE asphalt (+0.04), and broad triangles cut
  // through the rendered terrain near bridgeheads. Share its triangulation.
  const fit = terrainFit(host.layout, ROAD_SURFACE_LIFT / 4);
  const bands: Array<[number, number, THREE.Color]> = [];
  // 水线外侧曾铺一条 7 宽的不透明近白「浪花」带（#eef5f2，−6…+1）：均匀、不动、不透明，读作水边一圈白水泥
  // （用户截图「湿沙外接近水的区域为什么是白色」）。浪花交给水面着色器的岸线涟漪（动态、不规则、随深度淡出）；
  // 这里只留一窄条比湿沙更深的冲刷带（刚退浪、被水浸透的沙），把湿沙收到水线里。
  const swash = new THREE.Color("#b39b70"); const wetSand = new THREE.Color("#cdb487"); const drySand = new THREE.Color("#f3e5c2");
  const point = (x: number, z: number, nx: number, nz: number, d: number) => {
    const px = x + nx * d; const pz = z + nz * d;
    return { x: px, z: pz };
  };
  for (let i = 0; i < n; i += 1) {
    const a = vertex[i]; const b = vertex[(i + 1) % n];
    if (!a.depth || !b.depth) continue;
    const length = Math.hypot(b.p.x - a.p.x, b.p.z - a.p.z);
    const steps = Math.max(1, Math.ceil(length / 5)); // 细分贴地，避免长边中段被地形顶穿
    for (let k = 0; k < steps; k += 1) {
      const t0 = k / steps; const t1 = (k + 1) / steps;
      const at = (t: number) => {
        const nx = a.nx + (b.nx - a.nx) * t; const nz = a.nz + (b.nz - a.nz) * t; const l = Math.hypot(nx, nz) || 1;
        return { x: a.p.x + (b.p.x - a.p.x) * t, z: a.p.z + (b.p.z - a.p.z) * t, nx: nx / l, nz: nz / l, depth: a.depth + (b.depth - a.depth) * t };
      };
      const s0 = at(t0); const s1 = at(t1);
      bands.length = 0;
      bands.push([-2, 1.5, swash], [1.5, Math.min(wet, s0.depth - 1), wetSand], [Math.min(wet, s0.depth - 1), s0.depth, drySand]);
      for (const [from, to, color] of bands) {
        const to1 = color === drySand ? s1.depth : to;
        const q = [point(s0.x, s0.z, s0.nx, s0.nz, from), point(s1.x, s1.z, s1.nx, s1.nz, from),
                   point(s1.x, s1.z, s1.nx, s1.nz, to1), point(s0.x, s0.z, s0.nx, s0.nz, to)];
        for (const triangle of [[q[0],q[2],q[1]],[q[0],q[3],q[2]]]) {
          for (const piece of clipConvexToTerrain(fit.grid, triangle)) {
            for (let j=1;j+1<piece.length;j++) {
              const a=piece[0],b=piece[j],c=piece[j+1];
              if (Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x))<1e-10) continue;
              for (const p of [piece[0],piece[j],piece[j+1]]) {
                positions.push(p.x,fit.heightAt(p.x,p.z),p.z);
                colors.push(color.r,color.g,color.b);
              }
            }
          }
        }
      }
    }
  }
  if (!positions.length) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
  geometry.computeVertexNormals();
  // 法线朝向依赖岸线绕向：双面渲染，省掉判绕向。
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "city-beach";
  mesh.receiveShadow = true;
  host.group.add(mesh);
  host.disposables.push(geometry, material);
}

/** 港口码头（G3「水上活动」）：港口用地朝开阔水面的方向伸出 4 条白色栈桥，两侧泊着游艇/小艇。
 *  曾只有一块灰色港区地坪，水上几乎没有生活（多视角评估）。方向取港口周边最深的一侧，栈桥从岸线起步。 */
export function buildMarina(host: SeasideHost): void {
  const harbor = host.layout.publicSites.find((site) => site.kind === "harbor");
  if (!harbor) return;
  const terrain = host.layout.terrain;
  let best = { angle: 0, depth: Infinity };
  for (let k = 0; k < 24; k += 1) {
    const angle = (k / 24) * Math.PI * 2;
    const h = terrain.height(harbor.x + Math.cos(angle) * (harbor.radius + 24), harbor.z + Math.sin(angle) * (harbor.radius + 24));
    if (h < best.depth) best = { angle, depth: h };
  }
  if (best.depth > -0.5) return;
  const ux = Math.cos(best.angle); const uz = Math.sin(best.angle);
  let shore = harbor.radius * 0.5;
  while (shore < harbor.radius + 40 && terrain.height(harbor.x + ux * shore, harbor.z + uz * shore) > 0) shore += 1;
  const yaw = -Math.atan2(uz, ux);
  const vx = -uz; const vz = ux;
  const unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const deck = new THREE.MeshLambertMaterial({ color: "#f3efe6" });
  const hulls = new THREE.MeshLambertMaterial({ color: "#ffffff" });
  const piers = new THREE.InstancedMesh(unit, deck, 8);
  const boats = new THREE.InstancedMesh(unit, hulls, 40);
  const cabinMaterial = new THREE.MeshLambertMaterial({ color: "#f7f5ef" });
  const cabins = new THREE.InstancedMesh(unit, cabinMaterial, 40);
  let p = 0; let b = 0;
  for (let i = 0; i < 4; i += 1) {
    const lateral = (i - 1.5) * 12;
    const length = 30 + (i % 2) * 6;
    const sx = harbor.x + ux * (shore - 3) + vx * lateral; const sz = harbor.z + uz * (shore - 3) + vz * lateral;
    const cx = sx + ux * length / 2; const cz = sz + uz * length / 2;
    host.compose(cx, 0.35, cz, yaw, length, 0.35, m(REAL.pier.width));
    piers.setMatrixAt(p++, host.matrix);
    // 栈桥两侧每隔 6 泊一条船（长 7–9），颜色按种子在白/海军蓝/珊瑚之间。
    // 截图验收：每 6 一条时船挤成一整块、把栈桥都盖住了——改为每 8 一个泊位、约四成空位，船体收窄并加白色舱室。
    // 码头小艇 7–12 m、船宽 2.8 m（REAL.marinaBoat），泊位间距 ~6（= 12 m）。
    for (let along = 5; along < length - 3 && b < 40; along += 6) for (const side of [-1, 1]) {
      const seed = hashSeed(`marina:${i}:${along}:${side}`);
      if (seed < 0.45 || b >= 40) continue;
      const bx = sx + ux * along + vx * side * (m(REAL.pier.width) / 2 + m(REAL.marinaBoat.beam) / 2 + m(0.6)); const bz = sz + uz * along + vz * side * (m(REAL.pier.width) / 2 + m(REAL.marinaBoat.beam) / 2 + m(0.6));
      const len = m(REAL.marinaBoat.min + seed * (REAL.marinaBoat.max - REAL.marinaBoat.min));
      host.compose(bx, -0.15, bz, yaw + Math.PI / 2, m(REAL.marinaBoat.beam), m(1.4), len);
      boats.setMatrixAt(b, host.matrix);
      boats.setColorAt(b, host.color.set(seed > 0.85 ? "#1f3b5c" : seed > 0.7 ? "#e8775f" : "#ffffff"));
      host.compose(bx - ux * len * 0.08, -0.15 + m(1.4), bz - uz * len * 0.08, yaw + Math.PI / 2, m(2), m(1), len * 0.4);
      cabins.setMatrixAt(b, host.matrix);
      b += 1;
    }
  }
  piers.count = p; boats.count = b; cabins.count = b;
  for (const mesh of [piers, boats, cabins]) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = "city-marina";
  }
  host.group.add(piers, boats, cabins);
  host.disposables.push(unit, deck, hulls, cabinMaterial);
}

/** 救生塔（VICE S1）：架高值守小屋 + 平台 + 檐顶 + 楼梯——架高结构是
 *  Lifeguard Tower 的第一特征（不是灯塔的窄圆柱）。条纹为辅助色。夜间
 *  自发光由独立 MeshBasic 材质驱动（不依赖路灯照亮），随 setNightGlow 亮起。
 *  合法沙带内最多 3 座，确定性 seed。 */
export function buildLifeguardTowers(host: SeasideHost): void {
  const seaside = host.layout.seaside;
  if (!seaside || seaside.degraded) return;
  const valid = seaside.samples.filter((s) => s.valid);
  if (valid.length < 5) return;
  // 约每 4 个合法采样（~150 单位海岸）一座，最多 8 座；曾最多 3 座，长海岸上几乎看不见。
  const count = Math.min(8, Math.max(2, Math.floor(valid.length / 4)));
  const structureMaterial = new THREE.MeshLambertMaterial({ color: "#ffffff" });
  const stripeMaterial = new THREE.MeshLambertMaterial({ color: "#f4efe4" });
  const glowMaterial = new THREE.MeshBasicMaterial({ color: "#ffca7a", toneMapped: false });
  host.lifeguardGlowMaterial = glowMaterial;
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  // 每塔 4 根立柱 + 平台/小屋 + 檐顶/通风塔，共 8 个实例。
  const structureMesh = new THREE.InstancedMesh(box, structureMaterial, count * 8);
  const stripeMesh = new THREE.InstancedMesh(box, stripeMaterial, count * 4);
  stripeMesh.castShadow = true;
  const glowMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 6, 5), glowMaterial, count);
  structureMesh.castShadow = true;
  const palettes = [
    { wall: "#ff5fa8", accent: "#fff4ec" },
    { wall: "#00c2d1", accent: "#fff4ec" },
    { wall: "#ff8a3c", accent: "#fff4ec" },
  ];
  let cursor = 0;
  for (let t = 0; t < count; t += 1) {
    // 在沙带内均匀散布（避开酒店位），偏移到湿沙外缘附近。
    const sample = valid[Math.floor(((t + 0.3) / count) * (valid.length - 1))];
    const seed = hashSeed(`lifeguard:${t}`);
    const ground = host.layout.terrain.height(sample.dryOuter.x, sample.dryOuter.z);
    // compose 的约定：局部 z 轴 = (sin yaw, cos yaw)。要让进深轴沿岸线法向（立面朝海），yaw = atan2(inward.x, inward.z)。
    // 曾写 atan2(inward.x, -inward.z)：只有 inward.z = 0 处才对，其它岸段楼体相对岸线斜转，沿「朝海」偏移的
    // 遮阳带/壁柱/霓虹招牌从楼的侧面戳出来（真机截图：白色横杆伸出墙外）。
    const yaw = Math.atan2(sample.inward.x, sample.inward.z);
    const pal = palettes[t % palettes.length];
    const legH = m(REAL.lifeguardTower.legHeight + seed * 0.6);
    const hutW = m(REAL.lifeguardTower.hutWidth + seed * 0.6);
    const hutH = m(REAL.lifeguardTower.hutHeight + seed * 0.4);
    const k = METER_MODEL_SCALE; // 立柱/平台/檐/踏步的其余尺寸也按米建模：统一乘这个系数
    const x = sample.dryOuter.x; const z = sample.dryOuter.z;
    // 四根立柱（架高是第一特征）。
    for (let leg = 0; leg < 4; leg += 1) {
      const lx = x + (leg % 2 === 0 ? -1 : 1) * (hutW / 2 - 0.25 * k);
      const lz = z + (leg < 2 ? -1 : 1) * (1.1 * k);
      host.compose(lx, ground, lz, yaw, 0.28 * k, legH, 0.28 * k);
      structureMesh.setMatrixAt(cursor + leg, host.matrix);
      structureMesh.setColorAt(cursor + leg, host.color.set("#8a7a68"));
    }
    cursor += 4;
    // 平台。
    host.compose(x, ground + legH, z, yaw, hutW + 0.6 * k, 0.22 * k, m(REAL.lifeguardTower.hutDepth));
    structureMesh.setMatrixAt(cursor, host.matrix);
    structureMesh.setColorAt(cursor, host.color.set(pal.wall));
    // 值守小屋（条纹墙身）。
    host.compose(x, ground + legH + 0.22 * k, z, yaw, hutW, hutH, 2.2 * k);
    structureMesh.setMatrixAt(cursor + 1, host.matrix);
    structureMesh.setColorAt(cursor + 1, host.color.set(pal.wall));
    cursor += 2;
    // 檐顶（出挑薄板 + 中央通风塔）。
    host.compose(x, ground + legH + 0.22 * k + hutH, z, yaw, hutW + 1.0 * k, 0.18 * k, 3.0 * k);
    structureMesh.setMatrixAt(cursor, host.matrix);
    structureMesh.setColorAt(cursor, host.color.set(pal.accent));
    host.compose(x, ground + legH + 0.22 * k + hutH + 0.18 * k, z, yaw, 0.8 * k, 0.7 * k, 0.8 * k);
    structureMesh.setMatrixAt(cursor + 1, host.matrix);
    structureMesh.setColorAt(cursor + 1, host.color.set(pal.accent));
    cursor += 2;
    // 楼梯（斜向薄板从地面到平台，简化为两级踏步面板）。
    const outward = { x: -sample.inward.x, z: -sample.inward.z };
    for (let step = 0; step < 3; step += 1) {
      const sy = ground + (legH * (step + 1)) / 4;
      const sx = x + outward.x * (1.4 + step * 0.7) * k;
      const sz = z + outward.z * (1.4 + step * 0.7) * k;
      host.compose(sx, sy, sz, yaw, 1.2 * k, 0.12 * k, 0.45 * k);
      stripeMesh.setMatrixAt(t * 4 + step, host.matrix);
    }
    // 条纹：小屋顶部一圈色环。
    host.compose(x, ground + legH + 0.22 * k + hutH * 0.65, z, yaw, hutW + 0.05 * k, 0.3 * k, 2.25 * k);
    stripeMesh.setMatrixAt(t * 4 + 3, host.matrix); // 曾写 t*3+2：覆盖第三级踏步，且相邻塔的槽位互相踩
    // 夜间指示灯（小屋顶部小光球）。
    host.compose(x, ground + legH + (0.22 + 0.18 + 0.7) * k + hutH, z, 0, k, k, k);
    glowMesh.setMatrixAt(t, host.matrix);
  }
  structureMesh.count = cursor;
  stripeMesh.count = count * 4;
  structureMesh.name = "city-lifeguard-towers";
  if (structureMesh.instanceColor) structureMesh.instanceColor.needsUpdate = true;
  glowMesh.visible = false; // 白天不亮，setNightGlow 驱动
  host.group.add(structureMesh, stripeMesh, glowMesh);
  host.disposables.push(box, structureMaterial, stripeMaterial, glowMaterial);
}
