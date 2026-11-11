/**
 * 城区地标的场地：玻璃幕墙裙楼 + 雨棚大门 + 前院（广场、步道、停车场、绿化）。
 *
 * 用户（2026-10-15）：裙楼是一块没有窗没有门的白盒子，「需要像建筑一样，加上玻璃幕墙、大门等；既然地标独立占了一个地块，
 * 这个地块还可以加上停车场和植被」。地标占整块街区（生成器与编辑器都预留了），所以场地铺满 `landmarkSite` 算出的街区范围。
 * 全部在「朝路为 +z」的正则系里搭，整体放进一个按 site.turn 旋转的子组。尺寸一律走 worldScale（人 1.75 m、车 4.5 × 1.8 m、
 * 层高 3.2 m、车位 2.5 × 5 m），不写世界单位魔数。
 *
 * 只做静态几何：车与树用 InstancedMesh，车位线并成一个网格；夜里玻璃亮窗走 landmarkWindows（与塔身同一套日/夜贴图切换）。
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { hashSeed } from "../../../cityModel";
import { createRenderCanvas } from "../../renderCanvas";
import { LANDMARK_EDGE_MARGIN, PODIUM_FLOORS, type LandmarkSite } from "../../models/districtLandmarkFootprint";
import { m, REAL } from "../../worldScale";

/** 幕墙每块玻璃的宽（世界单位）：约 2.8 m 的标准幕墙分格。 */
const PANE_WIDTH = m(2.8);
const STALL = { width: m(2.8), length: m(5.4) };
const AISLE = m(6);
const PATH_WIDTH = m(6);
const PLINTH = 0.3;
/** 地面分层（世界单位）：草坪 → 铺装/沥青 → 车位线 → 车。每层抬高一档，不共面，不 z-fight，车不会被石板压住。 */
const LAWN_TOP = 0.04;
const PAVING = 0.05;
const PAVING_TOP = LAWN_TOP + PAVING;
const LINE_TOP = PAVING_TOP + 0.012;
/** 广场宽：车位与它之间留 PLAZA_GAP，停车场不进广场范围。 */
const PLAZA_WIDTH = m(22);
const PLAZA_GAP = m(2);

export type SiteHost = { disposables: Array<{ dispose: () => void }>; landmarkWindows: Array<{ material: THREE.MeshLambertMaterial; day: THREE.Texture; lit: THREE.Texture; dayEmissive: THREE.Color }> };

/** 可开走的那辆车停的车位（场地子组的局部坐标，车头朝 +z、朝街）。没有停车场时为 null。 */
export type HeroStall = { x: number; z: number; y: number };

export function buildDistrictLandmarkSite(site: LandmarkSite, districtId: string, accent: string, neon: boolean, host: SiteHost): { group: THREE.Group; podiumTop: number; heroStall: HeroStall | null } {
  const group = new THREE.Group();
  group.name = "district-landmark-site";
  group.rotation.y = site.turn;
  const own = <T extends { dispose: () => void }>(item: T): T => { host.disposables.push(item); return item; };
  const lambert = (color: string, emissive = 0) => own(new THREE.MeshLambertMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(emissive) }));
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material, shadow = true): THREE.Mesh => {
    const mesh = new THREE.Mesh(own(new THREE.BoxGeometry(w, h, d)), material);
    mesh.position.set(x, y + h / 2, z); mesh.castShadow = shadow; mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  // 相近字符串的 hashSeed 彼此很近（车位 k 与 k+1 的随机数几乎相同：曾 codex 只停 5 辆、颜色几乎全红）：
  // 先把 key 哈希成整数，再过一遍整数混合（murmur 终结器）取 [0,1)。
  const seedBase = Math.floor(hashSeed(`district-site:${districtId}`) * 2 ** 31);
  const rnd = (key: string) => {
    let x = (Math.floor(hashSeed(`${districtId}:${key}`) * 2 ** 31) ^ seedBase) | 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b); x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35); x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };
  const { rect, podium } = site;
  const cu = podium.cu, front = podium.cv + podium.d / 2;

  // ── 草坪：整块街区范围的底（其余都铺在它上面）──
  box(rect.u1 - rect.u0, LAWN_TOP, rect.v1 - rect.v0, (rect.u0 + rect.u1) / 2, 0, (rect.v0 + rect.v1) / 2, lambert("#6f9f58"), false);

  // ── 裙楼：3 层玻璃幕墙（深色玻璃 + 白色竖梃与层间带），夜里一格一格亮窗 ──
  const day = createRenderCanvas(); day.width = 64; day.height = 64;
  const dctx = day.getContext("2d");
  if (dctx) {
    dctx.fillStyle = "#3d6579"; dctx.fillRect(0, 0, 64, 64);
    dctx.fillStyle = "rgba(255,255,255,0.18)"; dctx.fillRect(4, 4, 56, 20);          // 玻璃上沿的天光反射
    dctx.fillStyle = "#dfe6e9"; dctx.fillRect(0, 0, 3, 64); dctx.fillRect(0, 60, 64, 4); // 竖梃 + 层间带
  }
  const lit = createRenderCanvas(); lit.width = 64; lit.height = 256;
  const lctx = lit.getContext("2d");
  if (lctx) {
    lctx.fillStyle = "#000000"; lctx.fillRect(0, 0, 64, 256);
    for (let floor = 0; floor < 4; floor += 1) for (let cell = 0; cell < 4; cell += 1) {
      const on = hashSeed(`district-site-window:${districtId}:${floor}:${cell}`);
      if (on < 0.2) continue;
      lctx.fillStyle = on > 0.8 ? "#bfe9ff" : "#ffd89a";
      lctx.fillRect(cell * 16 + 4, floor * 64 + 4, 12, 52);
    }
  }
  const dayTexture = own(new THREE.CanvasTexture(day as HTMLCanvasElement));
  const litTexture = own(new THREE.CanvasTexture(lit as HTMLCanvasElement));
  for (const texture of [dayTexture, litTexture]) { texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; }
  litTexture.repeat.set(0.25, 0.25); // 夜窗图一块 = 4 层 × 4 格；uv 里「一层、一格」= 日窗图一整块
  const glass = own(new THREE.MeshLambertMaterial({ color: "#ffffff", map: dayTexture, emissive: new THREE.Color("#2a2a2a"), emissiveMap: dayTexture }));
  host.landmarkWindows.push({ material: glass, day: dayTexture, lit: litTexture, dayEmissive: new THREE.Color("#2a2a2a") });
  const podiumH = PODIUM_FLOORS * m(REAL.floorHeight);
  const wall = new THREE.BoxGeometry(podium.w, podiumH, podium.d);
  const uv = wall.getAttribute("uv") as THREE.BufferAttribute;
  const cols = Math.max(2, Math.round(podium.w / PANE_WIDTH));
  for (let k = 0; k < uv.count; k += 1) uv.setXY(k, uv.getX(k) * cols, uv.getY(k) * PODIUM_FLOORS);
  const wallMesh = new THREE.Mesh(own(wall), glass);
  wallMesh.position.set(cu, PLINTH + podiumH / 2, podium.cv); wallMesh.castShadow = true; wallMesh.receiveShadow = true;
  group.add(wallMesh);
  const stone = lambert("#d8d2c4");
  const white = lambert("#f4f1ea", 0.15);
  box(podium.w + 0.5, PLINTH, podium.d + 0.5, cu, 0, podium.cv, stone);                               // 基座
  box(podium.w + 0.9, 0.4, podium.d + 0.9, cu, PLINTH + podiumH, podium.cv, white);                    // 屋顶挑檐
  const podiumTop = PLINTH + podiumH + 0.4;

  // ── 大门：玻璃门 + 门框 + 雨棚（两根柱）+ 台阶 ──
  const doorW = m(4), doorH = m(3.4);
  box(doorW + 0.5, doorH + 0.4, 0.12, cu, PLINTH, front + 0.04, lambert("#2d343b"));                  // 门框
  box(doorW, doorH, 0.14, cu, PLINTH, front + 0.1, lambert("#ffd89a", neon ? 1.2 : 0.55), false);     // 门扇：暖光（白天也读得出是入口）
  const canopyW = m(12), canopyD = m(6);
  // Canopy and steps stand in the yard: only when the site has room for them (never past the site front).
  if (front + canopyD <= rect.v1 + 1e-9) {
    box(canopyW, 0.3, canopyD, cu, PLINTH + m(5.6), front + canopyD / 2, white);                         // 雨棚
    for (const side of [-1, 1]) box(0.3, m(5.6), 0.3, cu + side * (canopyW / 2 - 0.4), PLINTH, front + canopyD - 0.4, white);
    box(canopyW * 0.7, 0.16, m(2.4), cu, 0, front + m(2.4) / 2 + 0.2, stone);                           // 台阶
  }

  // ── 广场与步道：门前铺石材，一条步道通到街区前沿 ──
  const yardEnd = rect.v1;
  const plazaD = Math.min(m(16), Math.max(0, yardEnd - front));
  if (plazaD > 1) box(PLAZA_WIDTH, PAVING, plazaD, cu, LAWN_TOP, front + plazaD / 2, stone, false);
  const pathStart = front + plazaD;
  // 步道比广场略低一丁点：两块同色石材在交界处不共面。
  if (yardEnd - pathStart > 0.5) box(PATH_WIDTH, PAVING - 0.01, yardEnd - pathStart, cu, LAWN_TOP, (pathStart + yardEnd) / 2, stone, false);

  // ── 停车场：步道两侧各一块，沥青 + 白色车位线 + 停着的车（占用率约 60%）──
  const lotV0 = front + 0.6, lotV1 = yardEnd - m(5); // 前沿留一条绿化带给行道树
  const lotD = lotV1 - lotV0;
  const asphalt = lambert("#3b4148");
  const lineGeometries: THREE.BufferGeometry[] = [];
  const cars: Array<{ x: number; z: number; color: string }> = [];
  let heroStall: HeroStall | null = null;
  const carColors = ["#e8e8e8", "#c9ced2", "#2c3036", "#b3413a", "#355c8c", "#d8c79a"];
  const inner = PLAZA_WIDTH / 2 + PLAZA_GAP; // 车位整体在广场（含雨棚、台阶）两侧之外，不压铺装
  const lotSides: Array<[number, number]> = [[rect.u0, cu - inner], [cu + inner, rect.u1]];
  // 车位排数：够深放两排（中间一条车道）就放两排，只够一排就放靠步道前侧的一排，再浅就不放。
  const rows = lotD >= STALL.length * 2 + AISLE ? 2 : lotD >= STALL.length + 0.4 ? 1 : 0;
  if (rows > 0) lotSides.forEach(([u0, u1], side) => {
    const width = u1 - u0;
    if (width < STALL.width * 2) return;
    const depth = rows === 2 ? STALL.length * 2 + AISLE : STALL.length + 0.4;
    box(width, PAVING, depth, (u0 + u1) / 2, LAWN_TOP, lotV0 + depth / 2, asphalt, false);
    const stalls = Math.floor(width / STALL.width);
    const x0 = (u0 + u1) / 2 - (stalls * STALL.width) / 2;
    const rowCenters = rows === 2 ? [lotV0 + STALL.length / 2 + 0.2, lotV0 + depth - STALL.length / 2 - 0.2] : [lotV0 + 0.2 + STALL.length / 2];
    rowCenters.forEach((z, rowIndex) => {
      for (let k = 0; k <= stalls; k += 1) {
        const line = new THREE.BoxGeometry(0.07, 0.012, STALL.length - 0.2);
        line.translate(x0 + k * STALL.width, LINE_TOP - 0.006, z);
        lineGeometries.push(line);
      }
      for (let k = 0; k < stalls; k += 1) {
        // 可开走的车（2026-10-22，用户：「每个城区地标楼下面的停车场可以放汽车模型，点击以后进入开车模式」）：
        // 停在左侧停车场靠街那一排、离步道最近的车位——从大门一眼就能看见；这个车位不再停装饰车。
        if (!heroStall && side === 0 && rowIndex === rowCenters.length - 1 && k === stalls - 1) { heroStall = { x: x0 + (k + 0.5) * STALL.width, z, y: LINE_TOP }; continue; }
        if (rnd(`car:${side}:${rowIndex}:${k}`) > 0.5) continue;
        cars.push({ x: x0 + (k + 0.5) * STALL.width, z: z + (rnd(`park:${side}:${rowIndex}:${k}`) - 0.5) * 0.3, color: carColors[Math.floor(rnd(`color:${side}:${rowIndex}:${k}`) * carColors.length) % carColors.length] });
      }
    });
  });
  if (lineGeometries.length) {
    const lines = new THREE.Mesh(own(mergeGeometries(lineGeometries)!), lambert("#f2f2ee"));
    lineGeometries.forEach((g) => g.dispose());
    lines.receiveShadow = true;
    group.add(lines);
  }
  if (cars.length) {
    // 车：车身 + 驾驶舱合并成一个几何（4.5 × 1.8 × 1.5 m，沿 z 摆放，车头朝 +z），按车色逐实例上色。
    const body = new THREE.BoxGeometry(m(REAL.car.width), m(REAL.car.height * 0.5), m(REAL.car.length)).translate(0, m(REAL.car.height * 0.5) / 2 + LINE_TOP, 0);
    const cabin = new THREE.BoxGeometry(m(REAL.car.width * 0.9), m(REAL.car.height * 0.45), m(REAL.car.length * 0.5)).translate(0, m(REAL.car.height * 0.5) + m(REAL.car.height * 0.45) / 2 + LINE_TOP, -m(REAL.car.length * 0.05));
    const carGeometry = own(mergeGeometries([body, cabin])!);
    body.dispose(); cabin.dispose();
    const carMesh = new THREE.InstancedMesh(carGeometry, lambert("#ffffff"), cars.length);
    const matrix = new THREE.Matrix4(), color = new THREE.Color();
    cars.forEach((car, index) => { matrix.makeTranslation(car.x, 0, car.z); carMesh.setMatrixAt(index, matrix); carMesh.setColorAt(index, color.set(car.color)); });
    carMesh.castShadow = true; carMesh.receiveShadow = true; carMesh.name = "district-landmark-cars";
    group.add(carMesh);
    host.disposables.push(carMesh);
  }

  // ── 绿化：前沿行道树（棕榈与阔叶交替）、步道两侧矮绿篱、裙楼两侧与背后的树 ──
  const trees: Array<{ x: number; z: number; palm: boolean; height: number }> = [];
  // Trees only inside the site and outside the podium (a thin or fallback site has no yard for them).
  const insidePodium = (x: number, z: number) => Math.abs(x - cu) < podium.w / 2 + 1 && Math.abs(z - podium.cv) < podium.d / 2 + 1;
  const plant = (x: number, z: number, key: string) => {
    if (x < rect.u0 || x > rect.u1 || z < rect.v0 || z > rect.v1 || insidePodium(x, z)) return;
    const palm = rnd(`kind:${key}`) < 0.5;
    const range = palm ? REAL.palm : REAL.broadleafTree;
    trees.push({ x, z, palm, height: m(range.min + rnd(`h:${key}`) * (range.max - range.min)) });
  };
  const treeZ = yardEnd - m(2);
  for (let x = rect.u0 + m(4), k = 0; x < rect.u1 - m(2); x += m(10), k += 1) if (Math.abs(x - cu) > PATH_WIDTH) plant(x, treeZ, `front:${k}`);
  for (const [i, side] of [-1, 1].entries()) {
    const edge = side < 0 ? rect.u0 + m(3) : rect.u1 - m(3);
    for (let z = rect.v0 + m(4), k = 0; z < Math.min(rect.v1, podium.cv + podium.d / 2); z += m(10), k += 1) plant(edge, z, `side:${i}:${k}`);
    box(m(1.6), m(1.4), Math.max(0.5, yardEnd - pathStart - m(4)), cu + side * (PATH_WIDTH / 2 + m(1)), 0, (pathStart + yardEnd) / 2, lambert("#2f6b3f"), false); // 步道两侧绿篱
  }
  if (trees.length) {
    const trunkGeometry = own(new THREE.CylinderGeometry(0.1, 0.16, 1, 6).translate(0, 0.5, 0));
    const crownGeometry = own(new THREE.SphereGeometry(1, 8, 6));
    const trunks = new THREE.InstancedMesh(trunkGeometry, lambert("#8a6a4a"), trees.length);
    const crowns = new THREE.InstancedMesh(crownGeometry, lambert("#ffffff"), trees.length);
    const matrix = new THREE.Matrix4(), color = new THREE.Color(), position = new THREE.Vector3(), scale = new THREE.Vector3(), quaternion = new THREE.Quaternion();
    trees.forEach((tree, index) => {
      matrix.compose(position.set(tree.x, 0, tree.z), quaternion, scale.set(1, tree.palm ? tree.height : tree.height * 0.45, 1)); trunks.setMatrixAt(index, matrix);
      // 棕榈：扁平的大冠在树顶；阔叶：球冠在树干上方。
      const crownR = tree.palm ? tree.height * 0.32 : tree.height * 0.3;
      matrix.compose(position.set(tree.x, tree.palm ? tree.height : tree.height * 0.62, tree.z), quaternion, scale.set(crownR, tree.palm ? crownR * 0.28 : crownR, crownR));
      crowns.setMatrixAt(index, matrix); crowns.setColorAt(index, color.set(tree.palm ? "#3fa86b" : "#4f9a4a"));
    });
    trunks.castShadow = crowns.castShadow = true;
    group.add(trunks, crowns);
    host.disposables.push(trunks, crowns);
  }
  void accent;
  return { group, podiumTop, heroStall };
}
