/**
 * 配套 / 公共用地 / 花园 / 旗帜系统：自 cityParts.ts 原样搬出（纯搬迁，见 docs/CITY_ENGINE_SPLIT_SPEC.md）。
 * 函数体与原方法逐字一致，仅 `this.` → `host.`；host 是 CityParts 本身，下面的接口只列出这里实际用到的成员。
 */
import * as THREE from "three";
import { hashSeed, type CityModel } from "../../cityModel";
import type { CityLayout } from "../cityLayout";
import { paletteFor } from "../cityTextures";
import { civicFlagLocalX, civicGroundFootprint, stationCanopyLocalZ, stationEntranceLocal, stationHallLocal } from "../models/publicSiteGeometry";
import { BOX, CYLINDER, selfLitMaterial } from "../render/shared";
import type { NightLights } from "../render/types";
import type { FacadeUniforms } from "../render/facadeMaterial";
import { civicGlassMaterial } from "../render/civicGlassMaterial";
import { gardenFlagPosition, GARDEN_RENDER_GEOMETRY, CIVIC_RENDER_GEOMETRY } from "../models/layoutPlacementGeometry";

export interface CivicSystemHost {
  model: CityModel;
  layout: CityLayout;
  group: THREE.Group;
  water: THREE.Mesh;
  disposables: Array<{ dispose: () => void }>;
  nightLights: NightLights | null;
  flagTime: { value: number } | null;
  facadeUniforms?: FacadeUniforms[];
  civicPieces: Array<{ civic: number; mesh: 0 | 1 | 2; index: number; x: number; y: number; z: number; sx: number; sy: number; sz: number; yaw: number; baseY: number }>;
  civicMeshes: THREE.InstancedMesh[];
  civicProgress: number[];
  civicTarget: number[];
  matrix: THREE.Matrix4;
  quaternion: THREE.Quaternion;
  euler: THREE.Euler;
  scaleVector: THREE.Vector3;
  positionVector: THREE.Vector3;
  color: THREE.Color;
  compose(x: number, y: number, z: number, rotationY: number, sx: number, sy: number, sz: number): void;
  makeInstanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh;
  writeCivic(civicIndex: number): void;
}

export function buildPublicSites(host: CivicSystemHost): void {
  type Piece = { x: number; y: number; z: number; sx: number; sy: number; sz: number; yaw: number; color: string };
  const boxes: Piece[] = [];
  const cylinders: Piece[] = [];
  const glows: Piece[] = []; // 夜间霓虹/边缘光：与 nightLights.neon 共用亮度，实例色定色相
  for (const site of host.layout.publicSites) {
    if (site.kind === "park") continue;
    const r = site.radius;
    const base = Math.max(0, host.layout.terrain.height(site.x, site.z));
    const cos = Math.cos(site.yaw);
    const sin = Math.sin(site.yaw);
    // 局部 (lx, lz) → 世界；与吊车/地块同一套 yaw 约定。
    const place = (lx: number, lz: number) => ({ x: site.x + lx * cos + lz * sin, z: site.z - lx * sin + lz * cos });
    const box = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, color: string, extraYaw = 0) => {
      const p = place(lx, lz);
      boxes.push({ x: p.x, y: base + ly, z: p.z, sx, sy, sz, yaw: site.yaw + extraYaw, color });
    };
    const cyl = (lx: number, ly: number, lz: number, radius: number, height: number, color: string) => {
      const p = place(lx, lz);
      cylinders.push({ x: p.x, y: base + ly, z: p.z, sx: radius, sy: height, sz: radius, yaw: 0, color });
    };
    const glow = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, color: string, extraYaw = 0) => {
      const p = place(lx, lz);
      glows.push({ x: p.x, y: base + ly, z: p.z, sx, sy, sz, yaw: site.yaw + extraYaw, color });
    };
    if (site.kind === "civic") {
      const baseFootprint = civicGroundFootprint(r).parts[0];
      if (baseFootprint.shape !== "rect") throw new Error("civic base must be rectangular");
      box(baseFootprint.center.x, 0, baseFootprint.center.z, baseFootprint.width, 1.6, baseFootprint.depth, "#e4dcc8");
      box(0, 1.6, 0, r * 0.9, 9, r * 0.55, "#efe7d6");
      for (let column = -3; column <= 3; column += 1) cyl(column * r * 0.12, 1.6, r * 0.34, 0.75, 9, "#f6f0e2");
      box(0, 10.6, 0, r * 0.98, 1.1, r * 0.62, "#cdbf9f");
      cyl(0, 11.7, 0, r * 0.27, 4.2, "#d6c9a8");
      cyl(0, 15.9, 0, r * 0.2, 3.4, "#5fa7a3");
      cyl(0, 19.3, 0, 0.4, 6, "#c9b98f");
      // 细化：门廊三角山花、正门台阶、两翼窗带、穹顶鼓座窗与顶部灯笼亭、广场前旗杆。
      box(0, 10.6, r * 0.36, r * 0.86, 0.5, 3.2, "#e9e1cd");
      for (let k = 0; k < 6; k += 1) box(0, 11.1 + k * 0.45, r * 0.36, r * 0.86 * (1 - k / 6), 0.45, 3.2, "#f2ebda");
      for (let k = 0; k < 4; k += 1) box(0, k * 0.4, r * 0.46 + k * 0.9, r * 0.5, 0.4, 1, "#ddd3bd");
      for (const sx of [-1, 1]) for (let k = 0; k < 3; k += 1) box(sx * r * 0.3, 3 + k * 2.6, r * 0.28, r * 0.24, 1.2, 0.2, "#5c6e78");
      for (let k = 0; k < 10; k += 1) { const t = (k / 10) * Math.PI * 2; box(Math.cos(t) * r * 0.27, 13, Math.sin(t) * r * 0.27, 1, 1.8, 1, "#4a5a63"); }
      cyl(0, 25.3, 0, 1.2, 1.6, "#f2ebda");
      // 市政厅 = 全城的功能性标志（用户：随城市规模升级 + 提供全城信息）。
      // 升级阶段按岛屿档位（每档约 400 会话）：1–2 镇政厅（基础）→ 3–4 加两翼与正面时钟 → 5–7 加高鼓座与钟楼 → 8–10 议会大厦（灯笼亭穹顶 + 两侧塔楼 + 长阶）。
      const tier = host.layout.scaleTier ?? 1;
      const stage = tier >= 8 ? 4 : tier >= 5 ? 3 : tier >= 3 ? 2 : 1;
      if (stage >= 2) {
        for (const sx of [-1, 1]) {
          box(sx * r * 0.62, 1.6, -r * 0.05, r * 0.36, 7, r * 0.42, "#ece4d2");
          box(sx * r * 0.62, 8.6, -r * 0.05, r * 0.4, 0.7, r * 0.46, "#cdbf9f");
          for (let k = 0; k < 2; k += 1) box(sx * r * 0.62, 3 + k * 2.6, r * 0.16 + 0.1, r * 0.28, 1.2, 0.2, "#5c6e78");
        }
        cyl(0, 12.6, r * 0.33, 1.4, 0.3, "#f6f0e2"); box(0, 12.7, r * 0.33 + 0.2, 0.15, 1.1, 0.1, "#2a3036");
      }
      if (stage >= 3) {
        cyl(0, 15.9, 0, r * 0.24, 2.6, "#e9e1cd");
        for (let k = 0; k < 12; k += 1) { const t = (k / 12) * Math.PI * 2; box(Math.cos(t) * r * 0.24, 16.2, Math.sin(t) * r * 0.24, 0.8, 1.6, 0.8, "#4a5a63"); }
        box(r * 0.5, 0, -r * 0.3, 5, 26, 5, "#ece4d2"); box(r * 0.5, 26, -r * 0.3, 6, 1, 6, "#cdbf9f");
        cyl(r * 0.5, 22, -r * 0.3 + 2.6, 1.6, 0.3, "#f6f0e2");
      }
      if (stage >= 4) {
        for (const sx of [-1, 1]) { box(sx * r * 0.82, 0, r * 0.25, 5, 22, 5, "#ece4d2"); cyl(sx * r * 0.82, 22, r * 0.25, 2.2, 4, "#5fa7a3"); }
        for (let k = 0; k < 8; k += 1) box(0, k * 0.4, r * 0.62 + k * 1.1, r * 0.7, 0.4, 1.2, "#ddd3bd");
        cyl(0, 27, 0, 2, 3, "#f2ebda"); cyl(0, 30, 0, 0.3, 4, "#c9b98f");
      }
      // 广场前一排城区旗：每个执行环境一面区色旗，旗杆高度 = 6 + 14 × 该城区会话占比（从空中就能读出各城区份额）。
      const total = host.model.districts.reduce((t, d) => t + d.sessionCount, 0) || 1;
      const districts = host.model.districts.filter((d) => d.sessionCount > 0);
      districts.forEach((district, i) => {
        const fx = civicFlagLocalX(r, i, districts.length);
        const pole = 6 + 14 * (district.sessionCount / total);
        cyl(fx, 0, r * 0.78, 0.15, pole, "#d9d9d4");
        box(fx + 1.2, pole - 1.6, r * 0.78, 2.4, 1.4, 0.08, paletteFor(district.id).accent);
      });
      // 异常信标：任一城区有异常时穹顶顶上亮信标（critical 红 / warning 琥珀 / info 青），点击市政厅看是哪个城区。
      const severities = host.model.districts.map((d) => d.anomaly?.severity).filter(Boolean);
      if (severities.length) {
        const color = severities.includes("critical") ? "#ff3b3b" : severities.includes("warning") ? "#ffb02e" : "#46e6ff";
        box(0, 32.5, 0, 1.4, 1.4, 1.4, color); glow(0, 32.5, 0, 1.6, 1.6, 1.6, color);
      }
      // 檐口一圈暖白边缘光 + 门廊柱脚洗墙光 + 穹顶青色腰线。
      for (const sz of [-1, 1]) glow(0, 11.7, sz * r * 0.31, r * 0.98, 0.22, 0.22, "#ffe2a8");
      for (const sx of [-1, 1]) glow(sx * r * 0.49, 11.7, 0, 0.22, 0.22, r * 0.62, "#ffe2a8");
      glow(0, 1.7, r * 0.46, r * 1.2, 0.2, 0.2, "#ffd08a");
      glow(0, 17.4, 0, r * 0.41, 0.25, r * 0.41, "#46e6ff");
      glow(0, 25.6, 0, 0.6, 0.9, 0.6, "#ff5a7a");
    } else if (site.kind === "station") {
      const entrance = stationEntranceLocal(r);
      const hall = stationHallLocal(r);
      box(0, 0, 0, r * 1.5, 0.7, r * 1.1, "#cfc7b3");
      for (const track of [-18, -10, -2, 6]) box(track, 0.7, 0, 0.5, 0.15, r * 1.1, "#6f7773");
      box(0, 7.4, 0, r * 1.4, 0.55, r * 0.9, "#8e9a9c");
      for (const px of [-r * 0.6, 0, r * 0.6]) for (const pz of [-r * 0.38, r * 0.38]) cyl(px, 0.7, pz, 0.55, 6.7, "#a9b0b0");
      box(hall.centre.x, 0, hall.centre.z, hall.width, hall.height, hall.depth, "#d9cdb5");
      cyl(r * 0.5, hall.height, hall.centre.z, 1.6, 10, "#c8bba0");
      cyl(r * 0.5, hall.height + 10, hall.centre.z, 2.1, 1.2, "#f4efe0");
      // 细化：站房拱形大窗与入口雨篷、雨棚屋脊、站台上停靠的列车（车头 + 3 节车厢）。
      for (let k = -2; k <= 2; k += 1) box(k * r * 0.22, 2, entrance.z, r * 0.14, 6.5, 0.15, "#5c7380");
      box(0, 3.8, stationCanopyLocalZ(r), r * 0.5, 0.35, 2.4, "#8e9a9c");
      box(0, 7.95, 0, r * 1.4, 0.8, 1.2, "#7c878a");
      for (let car = 0; car < 4; car += 1) {
        const z = -r * 0.42 + car * 9.5;
        box(-10, 0.85, z, 3, 3.2, 9, car === 0 ? "#e8eef0" : "#d8dde0");
        box(-10, 2.6, z, 3.05, 0.9, 8.6, "#3a5866");
        box(-10, 0.85, z, 3.1, 0.35, 9, car % 2 ? "#ff6fae" : "#38c3c9");
      }
      // 站房钟面发光 + 雨棚两侧边缘光 + 站台边线。
      glow(r * 0.5, hall.height + 10.15, hall.centre.z, 1.7, 0.9, 1.7, "#fff3cf");
      for (const sz of [-1, 1]) glow(0, 7.5, sz * r * 0.45, r * 1.4, 0.22, 0.22, "#58e0ff");
      glow(0, hall.height, hall.centre.z + hall.depth / 2 + 0.1, hall.width, 0.22, 0.22, "#ffd08a");
    } else if (site.kind === "stadium") {
      const segments = 18;
      for (let index = 0; index < segments; index += 1) {
        const t = (index / segments) * Math.PI * 2;
        const lx = Math.cos(t) * 27;
        const lz = Math.sin(t) * 19.5;
        // 椭圆切线方向：看台段首尾相接。
        const tangent = Math.atan2(19.5 * Math.cos(t), -27 * Math.sin(t));
        box(lx, 0, lz, 10.5, index % 4 === 0 ? 11 : 8, 5.5, index % 4 === 0 ? "#c05a4f" : "#dcd8ca", -tangent);
      }
      // 细化（用户「请细化这些建筑模型」）：球场草坪与白线、内圈低看台、看台上方悬挑顶棚、端头记分牌。
      box(0, 0, 0, 34, 0.3, 21, "#4f8a4a");
      box(0, 0.3, 0, 34, 0.04, 0.25, "#f2f2ea"); box(-16.8, 0.3, 0, 0.25, 0.04, 21, "#f2f2ea"); box(16.8, 0.3, 0, 0.25, 0.04, 21, "#f2f2ea");
      box(0, 0.3, -10.4, 34, 0.04, 0.25, "#f2f2ea"); box(0, 0.3, 10.4, 34, 0.04, 0.25, "#f2f2ea");
      for (let index = 0; index < segments; index += 1) {
        const t = ((index + 0.5) / segments) * Math.PI * 2;
        const tangent = Math.atan2(15 * Math.cos(t), -22 * Math.sin(t));
        box(Math.cos(t) * 22, 0, Math.sin(t) * 15, 7.5, 3.6, 3.2, index % 2 ? "#3f6f9a" : "#e0dccd", -tangent); // 内圈低看台
        const tr = Math.atan2(19.5 * Math.cos(t), -27 * Math.sin(t));
        box(Math.cos(t) * 25.5, 12, Math.sin(t) * 18.2, 10.5, 0.4, 7.5, "#f4f2ec", -tr);                       // 悬挑顶棚
      }
      box(0, 12.5, -21.5, 12, 5, 0.8, "#2a3036"); glow(0, 13.2, -21.05, 10.8, 3.6, 0.1, "#7fe3ff");            // 记分牌
      for (const [lx, lz] of [[-30, -22], [30, -22], [-30, 22], [30, 22]]) {
        cyl(lx, 0, lz, 0.55, 24, "#9aa0a0");
        glow(lx, 24, lz, 4, 1.4, 2.4, "#fff3c4"); // 泛光灯塔灯头：夜里发光
      }
      // 看台上沿一圈青/洋红交替的边缘光。
      for (let index = 0; index < segments; index += 1) {
        const t = (index / segments) * Math.PI * 2;
        const tangent = Math.atan2(19.5 * Math.cos(t), -27 * Math.sin(t));
        glow(Math.cos(t) * 27, index % 4 === 0 ? 11.1 : 8.1, Math.sin(t) * 19.5, 10.5, 0.22, 0.22, index % 2 === 0 ? "#38e8ff" : "#ff4fd8", -tangent);
      }
    } else if (site.kind === "tower") {
      // 细化：入口门厅、塔身电梯井竖条、深色玻璃观景舱（竖棂）、上层小观景环。
      cyl(0, 0, 0, 6.5, 3.2, "#c4c7c6");
      box(0, 0, 7.2, 8, 4.2, 5, "#e4e1d8"); box(0, 4.2, 7.2, 9, 0.4, 6, "#7fb4c2");
      cyl(0, 3.2, 0, 2.3, 42, "#cfd3d6");
      box(0, 3.2, 2.2, 0.9, 38.8, 0.5, "#9fb4bd");
      cyl(0, 42, 0, 6.4, 0.9, "#eaf0f2");
      cyl(0, 42.9, 0, 6.1, 2.2, "#2f4552");
      for (let k = 0; k < 12; k += 1) { const t = (k / 12) * Math.PI * 2; box(Math.cos(t) * 6.15, 42.9, Math.sin(t) * 6.15, 0.25, 2.2, 0.25, "#eaf0f2"); }
      cyl(0, 45.1, 0, 6.6, 0.7, "#eaf0f2");
      cyl(0, 52, 0, 3, 1.2, "#eaf0f2");
      cyl(0, 45.8, 0, 4.2, 2.2, "#7fb4c2");
      cyl(0, 48, 0, 0.45, 15, "#d45a4a");
      // 观景台与塔身腰线霓虹 + 天线红色航空灯。
      glow(0, 45.2, 0, 4.4, 0.35, 4.4, "#46e6ff");
      glow(0, 41.6, 0, 6.6, 0.3, 6.6, "#ff4fd8");
      glow(0, 20, 0, 2.5, 0.35, 2.5, "#ffd08a");
      glow(0, 62.6, 0, 1.1, 1.3, 1.1, "#ff3b3b");
    } else if (site.kind === "harbor") {
      box(0, 0, 0, r * 1.5, 0.5, r * 1.2, "#8e9490");
      box(0, 0.5, -r * 0.5, r * 1.1, 6.5, 10, "#bab4a3");
      const containerColors = ["#a9684f", "#4f7f8a", "#c9a24a", "#6a8a62", "#8a5a7a", "#d8d2c0"];
      for (let col = 0; col < 5; col += 1) {
        for (let row = 0; row < 3; row += 1) {
          const stack = 1 + Math.floor(hashSeed(`ctn:${site.id}:${col}:${row}`) * 3);
          for (let level = 0; level < stack; level += 1) {
            box(-r * 0.55 + col * 7, 0.5 + level * 2.7, -r * 0.1 + row * 4.4, 6.2, 2.6, 3.8, containerColors[Math.floor(hashSeed(`ctc:${site.id}:${col}:${row}:${level}`) * containerColors.length)]);
          }
        }
      }
      for (const [lx, lz] of [[-r * 0.65, r * 0.38], [-r * 0.65, r * 0.62], [r * 0.15, r * 0.38], [r * 0.15, r * 0.62]]) cyl(lx, 0.5, lz, 0.6, 17, "#c9532f");
      box(-r * 0.25, 17.5, r * 0.5, r * 1.1, 1.3, 1.5, "#c9532f");
      box(-r * 0.25 + r * 0.55, 17.2, r * 0.5, 14, 1, 1, "#d9d3c2", 0);
      // 码头发光：岸线灯带、龙门吊顶部泛光灯、堆场高杆灯与吊臂红色航空灯。
      glow(0, 0.55, r * 0.6, r * 1.5, 0.25, 0.25, "#ffb366");
      glow(0, 0.55, -r * 0.6, r * 1.5, 0.25, 0.25, "#ffb366");
      for (const [lx, lz] of [[-r * 0.65, r * 0.38], [-r * 0.65, r * 0.62], [r * 0.15, r * 0.38], [r * 0.15, r * 0.62]]) glow(lx, 17.6, lz, 1.4, 0.7, 1.4, "#fff1c4");
      glow(-r * 0.25 + r * 0.55 + 7, 17.2, r * 0.5, 0.9, 0.9, 0.9, "#ff3b3b");
      // 筒仓组（backlog L-8）：堆场另一端 3 座白色筒仓 + 浅灰穹盖 + 顶部连廊，工业港的第二种轮廓（与龙门吊互补）。
      for (let k = 0; k < 3; k += 1) {
        const sx = r * 0.5 + k * 6.4; const sz = -r * 0.42;
        cyl(sx, 0.5, sz, 2.8, 15 + k * 1.5, "#ecebe4");
        cyl(sx, 15.5 + k * 1.5, sz, 2.2, 1.2, "#c9ccc8");
      }
      box(r * 0.5 + 6.4, 17.6, -r * 0.42, 14, 0.8, 1.2, "#b8bbb4");
      for (const lx of [-r * 0.6, 0, r * 0.6]) {
        cyl(lx, 0.5, -r * 0.2, 0.18, 12, "#8a9096");
        glow(lx, 12.5, -r * 0.2, 1.6, 0.5, 1.6, "#fff1c4");
      }
    }
  }
  if (!boxes.length) return;
  const build = (geometry: THREE.BufferGeometry, pieces: Piece[], name: string) => {
    if (!pieces.length) return;
    const material = new THREE.MeshLambertMaterial({ color: "#ffffff" });
    const mesh = new THREE.InstancedMesh(geometry.clone(), material, pieces.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pieces.forEach((piece, index) => {
      host.positionVector.set(piece.x, piece.y, piece.z);
      host.euler.set(0, piece.yaw, 0);
      host.quaternion.setFromEuler(host.euler);
      host.scaleVector.set(piece.sx, piece.sy, piece.sz);
      host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector);
      mesh.setMatrixAt(index, host.matrix);
      mesh.setColorAt(index, host.color.set(piece.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = name;
    host.group.add(mesh);
    host.disposables.push(mesh.geometry, material);
  };
  build(BOX, boxes, "city-public-sites-boxes");
  build(CYLINDER, cylinders, "city-public-sites-cylinders");
  const neon = host.nightLights?.neon;
  if (neon && glows.length) {
    const mesh = new THREE.InstancedMesh(BOX.clone(), neon, glows.length);
    glows.forEach((piece, index) => {
      host.positionVector.set(piece.x, piece.y, piece.z);
      host.euler.set(0, piece.yaw, 0);
      host.quaternion.setFromEuler(host.euler);
      host.scaleVector.set(piece.sx, piece.sy, piece.sz);
      host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector);
      mesh.setMatrixAt(index, host.matrix);
      mesh.setColorAt(index, host.color.set(piece.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.name = "city-public-sites-glow";
    host.group.add(mesh);
    host.disposables.push(mesh.geometry);
  }
}

export function buildFlags(host: CivicSystemHost): void {
  const spots: Array<{ x: number; z: number; y: number; yaw: number; pole: number; cloth: number; color: string }> = [];
  for (const garden of host.layout.gardens ?? []) {
    const flag = gardenFlagPosition(garden);
    spots.push({
      x: flag.x,
      z: flag.z,
      y: garden.y, yaw: garden.yaw, pole: 7.5, cloth: 1,
      color: paletteFor(garden.districtId).accent,
    });
  }
  const tower = host.layout.publicSites.find((site) => site.kind === "tower");
  if (tower) {
    spots.push({ x: tower.x, z: tower.z, y: host.layout.terrain.height(tower.x, tower.z), yaw: tower.yaw, pole: 15, cloth: 1.5, color: "#f2efe6" });
  }
  if (!spots.length) return;
  host.flagTime = { value: 0 };
  const poleGeometry = new THREE.CylinderGeometry(0.12, 0.17, 1, 6).translate(0, 0.5, 0);
  const poleMaterial = new THREE.MeshLambertMaterial({ color: "#8a9096" });
  const poleMesh = host.makeInstanced(poleGeometry, poleMaterial, spots.length);
  // 旗面：左缘挂在杆顶，宽度 5.2×cloth；aPhase 是实例属性（每面旗自己的风相位）。
  const clothWidth = GARDEN_RENDER_GEOMETRY.flagClothWidth;
  const clothGeometry = new THREE.PlaneGeometry(clothWidth, 3.1, 10, 5).translate(clothWidth / 2 + GARDEN_RENDER_GEOMETRY.flagClothOffset, -1.7, 0);
  const phases = new Float32Array(spots.map((_, index) => hashSeed(`flag:${index}`) * Math.PI * 2));
  clothGeometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
  const clothMaterial = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  const flagTime = host.flagTime;
  clothMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = flagTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aPhase;\nuniform float uTime;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        float hoist = smoothstep(0.0, ${clothWidth.toFixed(1)}, position.x);
        transformed.z += (sin(uTime * 2.7 + aPhase + position.x * 1.1) * 0.4 + sin(uTime * 5.2 + aPhase * 1.7 + position.x * 2.4) * 0.13) * hoist;
        transformed.y -= hoist * hoist * 0.2;`);
  };
  clothMaterial.customProgramCacheKey = () => "city-flag-cloth";
  const clothMesh = new THREE.InstancedMesh(clothGeometry, clothMaterial, spots.length);
  clothMesh.name = "city-flags";
  spots.forEach((spot, index) => {
    host.compose(spot.x, spot.y, spot.z, spot.yaw, 0.8, spot.pole, 0.8);
    poleMesh.setMatrixAt(index, host.matrix);
    host.compose(spot.x, spot.y + spot.pole - 0.15, spot.z, spot.yaw, spot.cloth, spot.cloth, 1);
    clothMesh.setMatrixAt(index, host.matrix);
    clothMesh.setColorAt(index, host.color.set(spot.color));
  });
  if (clothMesh.instanceColor) clothMesh.instanceColor.needsUpdate = true;
  host.group.add(poleMesh, clothMesh);
  host.disposables.push(poleGeometry, poleMaterial, clothGeometry, clothMaterial);
}

export function buildGardens(host: CivicSystemHost): void {
  const gardens = host.layout.gardens ?? [];
  if (!gardens.length) return;
  type Piece = { x: number; y: number; z: number; sx: number; sy: number; sz: number; yaw: number; tilt: number; color: string };
  const boxes: Piece[] = [];
  const rocks: Piece[] = [];
  const cones: Piece[] = [];
  const trees: Piece[] = [];
  const waterMaterial = host.water.material as THREE.Material;
  for (const garden of gardens) {
    const r = garden.seed;
    const base = Math.max(0.3, garden.y);
    const cos = Math.cos(garden.yaw);
    const sin = Math.sin(garden.yaw);
    const at = (lx: number, lz: number) => ({ x: garden.x + lx * cos + lz * sin, z: garden.z - lx * sin + lz * cos });
    const W = garden.width - GARDEN_RENDER_GEOMETRY.inset;
    const D = garden.depth - GARDEN_RENDER_GEOMETRY.inset;
    const lawn = at(0, 0);
    boxes.push({ x: lawn.x, y: base, z: lawn.z, sx: W, sy: 0.25, sz: D, yaw: garden.yaw, tilt: 0, color: "#7fae6a" });
    // 湖：偏一侧的椭圆，留出另一侧放亭子。
    const lakeX = -W * 0.08;
    const lakeZ = D * 0.04;
    const rx = W * 0.32;
    const rz = D * 0.3;
    const lakeCenter = at(lakeX, lakeZ);
    const lake = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), waterMaterial);
    lake.position.set(lakeCenter.x, base + 0.3, lakeCenter.z);
    lake.rotation.y = garden.yaw;
    lake.scale.set(rx, 1, rz);
    lake.renderOrder = 1;
    host.group.add(lake);
    host.disposables.push(lake.geometry);
    // 湖石驳岸：一圈大小不一的扁石。
    for (let index = 0; index < 22; index += 1) {
      const t = (index / 22) * Math.PI * 2;
      const jitter = hashSeed(`${garden.id}:bank:${index}`);
      const q = at(lakeX + Math.cos(t) * (rx + 0.6), lakeZ + Math.sin(t) * (rz + 0.6));
      const size = 0.9 + jitter * 0.9;
      rocks.push({ x: q.x, y: base + 0.2, z: q.z, sx: size * 1.3, sy: size * 0.55, sz: size, yaw: jitter * 6.28, tilt: 0, color: jitter > 0.5 ? "#a8a59c" : "#8f8c84" });
    }
    // 假山：湖心偏后的一组叠石，越往上越小、略微错位。
    const hill = at(lakeX + rx * 0.35, lakeZ - rz * 0.25);
    for (let index = 0; index < 7; index += 1) {
      const jitter = hashSeed(`${garden.id}:rock:${index}`);
      const level = index < 3 ? 0 : index < 5 ? 1 : index < 6 ? 2 : 3;
      const size = (3.2 - level * 0.7) * (0.8 + jitter * 0.4);
      const off = (jitter - 0.5) * 2.4;
      rocks.push({ x: hill.x + off, y: base + 0.1 + level * 2.1, z: hill.z + (hashSeed(`${garden.id}:rz:${index}`) - 0.5) * 2.4, sx: size, sy: size * (1.1 + jitter * 0.5), sz: size * 0.85, yaw: jitter * 6.28, tilt: (jitter - 0.5) * 0.4, color: ["#9b978c", "#b3afa4", "#86837b"][index % 3] });
    }
    // 亭：四柱 + 方台 + 攒尖顶（执行环境强调色），在湖的另一侧。
    const pavilion = at(W * 0.34, -D * 0.18);
    const roofColor = new THREE.Color(paletteFor(garden.districtId).accent).lerp(new THREE.Color("#5a3b2c"), 0.35).getStyle();
    boxes.push({ x: pavilion.x, y: base + 0.25, z: pavilion.z, sx: 5.4, sy: 0.5, sz: 5.4, yaw: garden.yaw, tilt: 0, color: "#d8d1c2" });
    for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
      const q = at(W * 0.34 + dx, -D * 0.18 + dz);
      boxes.push({ x: q.x, y: base + 0.75, z: q.z, sx: 0.35, sy: 3.4, sz: 0.35, yaw: garden.yaw, tilt: 0, color: "#8a3b2e" });
    }
    cones.push({ x: pavilion.x, y: base + 4.1, z: pavilion.z, sx: 4.4, sy: 2.6, sz: 4.4, yaw: garden.yaw + Math.PI / 4, tilt: 0, color: roofColor });
    // 环湖树。
    for (let index = 0; index < 14; index += 1) {
      const t = (index / 14) * Math.PI * 2 + r;
      const q = at(Math.cos(t) * W * GARDEN_RENDER_GEOMETRY.treeRingX, Math.sin(t) * D * GARDEN_RENDER_GEOMETRY.treeRingZ);
      const size = GARDEN_RENDER_GEOMETRY.treeMinimumRadius + hashSeed(`${garden.id}:tree:${index}`) * GARDEN_RENDER_GEOMETRY.treeRadiusVariation;
      trees.push({ x: q.x, y: base + 0.2, z: q.z, sx: size, sy: size * 1.2, sz: size, yaw: 0, tilt: 0, color: index % 3 === 0 ? "#5f9a55" : "#6fae63" });
    }
  }
  const build = (geometry: THREE.BufferGeometry, pieces: Piece[], name: string) => {
    if (!pieces.length) return;
    const material = new THREE.MeshLambertMaterial({ color: "#ffffff", flatShading: true });
    const mesh = new THREE.InstancedMesh(geometry, material, pieces.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pieces.forEach((piece, index) => {
      host.positionVector.set(piece.x, piece.y, piece.z);
      host.euler.set(piece.tilt, piece.yaw, 0);
      host.quaternion.setFromEuler(host.euler);
      host.scaleVector.set(piece.sx, piece.sy, piece.sz);
      host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector);
      mesh.setMatrixAt(index, host.matrix);
      mesh.setColorAt(index, host.color.set(piece.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = name;
    host.group.add(mesh);
    host.disposables.push(geometry, material);
  };
  build(BOX.clone(), boxes, "city-garden-boxes");
  build(new THREE.DodecahedronGeometry(0.6, 0).translate(0, 0.45, 0), rocks, "city-garden-rocks");
  build(new THREE.ConeGeometry(0.5, 1, 4).translate(0, 0.5, 0), cones, "city-garden-roofs");
  build(new THREE.IcosahedronGeometry(1, 0).translate(0, 1.4, 0), trees, "city-garden-trees");
}

export function buildCivics(host: CivicSystemHost): void {
  const civics = host.layout.civics ?? [];
  if (!civics.length) return;
  type Piece = (typeof host.civicPieces)[number];
  const boxes: Piece[] = [];
  const cylinders: Piece[] = [];
  const glows: Piece[] = [];
  const colors: [string[], string[], string[]] = [[], [], []];
  const glassMask: number[] = [];
  civics.forEach((civic, civicIndex) => {
    const cos = Math.cos(civic.yaw);
    const sin = Math.sin(civic.yaw);
    const base = Math.max(0.3, civic.y);
    const W = Math.min(civic.width, CIVIC_RENDER_GEOMETRY.maxWidth) * CIVIC_RENDER_GEOMETRY.scale;
    const D = Math.min(civic.depth, CIVIC_RENDER_GEOMETRY.maxDepth) * CIVIC_RENDER_GEOMETRY.scale;
    const at = (lx: number, lz: number) => ({ x: civic.x + lx * cos + lz * sin, z: civic.z - lx * sin + lz * cos });
    const box = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, color: string) => {
      const q = at(lx, lz);
      boxes.push({ civic: civicIndex, mesh: 0, index: boxes.length, x: q.x, y: base + ly, z: q.z, sx, sy, sz, yaw: civic.yaw, baseY: base });
      colors[0].push(color); glassMask.push(0);
    };
    const cyl = (lx: number, ly: number, lz: number, r: number, h: number, color: string) => {
      const q = at(lx, lz);
      cylinders.push({ civic: civicIndex, mesh: 1, index: cylinders.length, x: q.x, y: base + ly, z: q.z, sx: r, sy: h, sz: r, yaw: 0, baseY: base });
      colors[1].push(color);
    };
    // 夜间边缘光：随同一座配套一起生长（同一套 baseY/progress），挂第三个实例网格。
    const glow = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, color: string) => {
      const q = at(lx, lz);
      glows.push({ civic: civicIndex, mesh: 2, index: glows.length, x: q.x, y: base + ly, z: q.z, sx, sy, sz, yaw: civic.yaw, baseY: base });
      colors[2].push(color);
    };
    // 细化（用户：医院等没有窗户和门）：给一块体量的四个立面排窗——每层一条深色窗带，竖向窗棂隔成单窗。
    // (cx, cz) 体量中心，w×d 体量平面，h 高度；faces 选哪几面（"n"=−z、"s"=+z、"w"=−x、"e"=+x）。
    const windows = (cx: number, cz: number, w: number, d: number, h: number, faces: string, glass = "#4f6b78") => {
      for (let y = 2; y + 1.2 <= h - 0.8; y += 3.1) {
        for (const face of faces) {
          const alongX = face === "n" || face === "s";
          const len = (alongX ? w : d) * 0.86;
          const off = face === "n" ? -d / 2 : face === "s" ? d / 2 : face === "w" ? -w / 2 : w / 2;
          const fx = alongX ? cx : cx + off + Math.sign(off) * 0.08; const fz = alongX ? cz + off + Math.sign(off) * 0.08 : cz;
          box(fx, y, fz, alongX ? len : 0.16, 1.25, alongX ? 0.16 : len, glass);
          glassMask[boxes.length-1]=1;
          // 夜间亮窗：窗带外侧一条暖色发光带（夜灯批次，白天隐藏）——曾只有深色玻璃，夜里配套建筑一片黑。
          glow(fx + (alongX ? 0 : Math.sign(off) * 0.06), y + 0.15, fz + (alongX ? Math.sign(off) * 0.06 : 0), alongX ? len * 0.98 : 0.05, 0.95, alongX ? 0.05 : len * 0.98, (Math.floor(y) + face.charCodeAt(0)) % 5 === 0 ? "#3a4a55" : "#7a6244");
          const count = Math.max(2, Math.floor(len / 2.4));
          for (let k = 1; k < count; k += 1) {
            const t = -len / 2 + (k * len) / count;
            box(alongX ? fx + t : fx + Math.sign(off) * 0.02, y, alongX ? fz + Math.sign(off) * 0.02 : fz + t, alongX ? 0.28 : 0.2, 1.25, alongX ? 0.2 : 0.28, "#f2efe6");
          }
        }
      }
    };
    // 正门：门洞（深色）+ 两扇玻璃门 + 雨篷 + 台阶，开在 +z 立面。
    const entrance = (cx: number, faceZ: number, w: number, canopy: string) => {
      box(cx, 0, faceZ + 0.1, w, 3, 0.2, "#2c3a42");
      for (const k of [-1, 1]) { box(cx + k * w * 0.22, 0, faceZ + 0.22, w * 0.38, 2.6, 0.06, "#7fb6c8"); glassMask[boxes.length-1]=1; }
      box(cx, 3.2, faceZ + 1.2, w * 1.3, 0.3, 2.4, canopy);
      box(cx, 0, faceZ + 1.6, w * 1.2, 0.3, 1.6, "#d8d3c6");
    };
    if (civic.kind === "school") {
      // U 形教学楼 + 操场（绿茵 + 红色跑道）+ 旗杆。
      box(-W * 0.38, 0, -D * 0.18, W * 0.2, 9, D * 0.6, "#e9d9b8");
      box(W * 0.38, 0, -D * 0.18, W * 0.2, 9, D * 0.6, "#e9d9b8");
      box(0, 0, -D * 0.42, W * 0.96, 11, D * 0.16, "#f1e4c6");
      windows(0, -D * 0.42, W * 0.96, D * 0.16, 11, "ns");
      windows(-W * 0.38, -D * 0.18, W * 0.2, D * 0.6, 9, "we");
      windows(W * 0.38, -D * 0.18, W * 0.2, D * 0.6, 9, "we");
      entrance(0, -D * 0.42 + D * 0.08, 4, "#b5533c");
      box(0, 11, -D * 0.42, W * 0.96, 0.6, D * 0.18, "#b5533c");
      box(0, 0.05, D * 0.22, W * 0.62, 0.12, D * 0.42, "#b8574a");
      box(0, 0.1, D * 0.22, W * 0.5, 0.14, D * 0.3, "#6fa65a");
      cyl(W * 0.42, 0, D * 0.4, 0.15, 12, "#d8dcdc");
      box(W * 0.42 + 1.1, 10.4, D * 0.4, 2, 1.3, 0.1, "#d84b3a");
      glow(0, 11.6, -D * 0.42, W * 0.96, 0.22, 0.22, "#ffd08a");
      glow(-W * 0.38, 9, -D * 0.18 + D * 0.3, W * 0.2, 0.22, 0.22, "#ffd08a");
      glow(W * 0.38, 9, -D * 0.18 + D * 0.3, W * 0.2, 0.22, 0.22, "#ffd08a");
      glow(0, 0.3, D * 0.22, W * 0.62, 0.14, 0.2, "#46e6ff");
    } else if (civic.kind === "mall") {
      // 大体量低层 + 玻璃中庭 + 屋顶停车场 + 招牌塔。
      box(0, 0, 0, W, 10, D, "#d9d3c7");
      windows(W * 0.12, 0, W * 0.7, D, 10, "nse", "#5f8796");
      for (const k of [-1, 0, 1]) entrance(W * 0.12 + k * W * 0.2, D / 2, 4.5, "#ff6f61");
      box(0, 10, 0, W * 0.98, 0.4, D * 0.98, "#6e7275");
      for (let row = -2; row <= 2; row += 1) box(W * 0.15, 10.45, row * D * 0.16, W * 0.5, 0.06, 0.25, "#e8e3c8");
      box(-W * 0.3, 0, 0, W * 0.24, 13, D * 0.5, "#6f9fb6");
      cyl(-W * 0.3, 13, 0, Math.min(W, D) * 0.12, 2.5, "#9ac4d4");
      box(W * 0.42, 0, -D * 0.42, 3.2, 20, 3.2, "#2f6f8f");
      box(W * 0.42, 15, -D * 0.42 - 1.7, 6, 4, 0.3, "#ff6f61");
      glow(W * 0.42, 15, -D * 0.42 - 1.9, 6, 4, 0.1, "#ff4fd8"); // 招牌发光
      glow(0, 10.5, D * 0.5, W, 0.22, 0.22, "#ff4fd8");
      glow(0, 10.5, -D * 0.5, W, 0.22, 0.22, "#46e6ff");
      glow(-W * 0.3, 13.4, 0, Math.min(W, D) * 0.25, 0.22, Math.min(W, D) * 0.25, "#46e6ff");
    } else {
      // 医院：白色主楼 + 两翼 + 红十字 + 屋顶停机坪。
      box(0, 0, 0, W * 0.34, 22, D * 0.44, "#f4f5f2");
      box(-W * 0.32, 0, D * 0.06, W * 0.3, 12, D * 0.34, "#ecefea");
      box(W * 0.32, 0, D * 0.06, W * 0.3, 12, D * 0.34, "#ecefea");
      cyl(0, 22, 0, Math.min(W, D) * 0.16, 0.4, "#5d6266");
      box(0, 22.42, 0, Math.min(W, D) * 0.16, 0.05, 1.2, "#f2f2ee");
      // 红十字：白底方牌 + 等长十字，两条臂中心重合（曾横臂底边与竖臂底边齐平，读作倒 T「⊥」）。前后两面都挂。
      for (const face of [1, -1]) {
        const fz = face * (D * 0.22 + 0.12);
        box(0, 14.6, fz, 7, 7, 0.2, "#ffffff");
        box(0, 15.4, fz + face * 0.12, 1.8, 5.4, 0.2, "#e0352b");
        box(0, 17.2, fz + face * 0.12, 5.4, 1.8, 0.2, "#e0352b");
        glow(0, 15.4, fz + face * 0.24, 1.6, 5.2, 0.06, "#ff4a3d");
        glow(0, 17.2, fz + face * 0.24, 5.2, 1.6, 0.06, "#ff4a3d");
      }
      windows(0, 0, W * 0.34, D * 0.44, 13.5, "nsew", "#6c8fa0");
      windows(-W * 0.32, D * 0.06, W * 0.3, D * 0.34, 12, "nsw", "#6c8fa0");
      windows(W * 0.32, D * 0.06, W * 0.3, D * 0.34, 12, "nse", "#6c8fa0");
      // 急诊入口：红色雨篷挂在正门外（曾是一块红色实心方块挡在楼前）。
      entrance(0, D * 0.22, 6, "#d84a3d");
      box(W * 0.2, 0, D * 0.22 + 2, 0.3, 3.2, 0.3, "#d8dcdc"); box(W * 0.2, 3.2, D * 0.22 + 2, 1.8, 1.8, 0.2, "#d84a3d");
      glow(0, 22.2, 0, W * 0.34, 0.22, D * 0.44, "#7fe8ff");
    }
  });
  const build = (geometry: THREE.BufferGeometry, pieces: Piece[], palette: string[], name: string) => {
    const cloned=geometry.clone();
    if(pieces===boxes)cloned.setAttribute("aCivicGlass",new THREE.InstancedBufferAttribute(new Float32Array(glassMask),1));
    const mesh = host.makeInstanced(cloned, pieces===boxes ? civicGlassMaterial(host.facadeUniforms?.[1]) : selfLitMaterial(0.18), Math.max(1, pieces.length));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = pieces.length;
    palette.forEach((color, index) => mesh.setColorAt(index, host.color.set(color)));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = name;
    return mesh;
  };
  // A dim/off emissive layer must never become a black opaque cover over
  // red signage or glass. Share live night color, but use additive blending.
  const glowMaterial=new THREE.MeshBasicMaterial({transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,toneMapped:false});
  if(host.nightLights)glowMaterial.color=host.nightLights.neon.color;
  const glowMesh=new THREE.InstancedMesh(BOX.clone(),glowMaterial,Math.max(1,glows.length));
  glowMesh.count=glows.length;
  colors[2].forEach((color,index)=>glowMesh.setColorAt(index,host.color.set(color)));
  if(glowMesh.instanceColor)glowMesh.instanceColor.needsUpdate=true;
  glowMesh.frustumCulled=false;
  glowMesh.name="city-civic-glow";
  // Transparent overlays are not physical occluders in GTAO's override pass.
  glowMesh.onBeforeRender=(_renderer,scene)=>{glowMesh.count=scene.overrideMaterial?0:glows.length;};
  glowMesh.onAfterRender=()=>{glowMesh.count=glows.length;};
  host.group.add(glowMesh);
  host.disposables.push(glowMesh.geometry,glowMaterial);
  host.civicMeshes = [build(BOX, boxes, colors[0], "city-civic-boxes"), build(CYLINDER, cylinders, colors[1], "city-civic-cylinders"), glowMesh];
  host.civicPieces = [...boxes, ...cylinders, ...glows];
  host.civicProgress = civics.map(() => 1);
  host.civicTarget = civics.map(() => 1);
  for (let index = 0; index < civics.length; index += 1) host.writeCivic(index);
}

export function writeCivic(host: CivicSystemHost, civicIndex: number): void {
  const progress = host.civicProgress[civicIndex];
  const ease = progress * progress * (3 - 2 * progress);
  for (const piece of host.civicPieces) {
    if (piece.civic !== civicIndex) continue;
    if (ease <= 0.001) host.compose(piece.x, -40, piece.z, 0, 0, 0, 0);
    else host.compose(piece.x, piece.baseY + (piece.y - piece.baseY) * ease, piece.z, piece.yaw, piece.sx, piece.sy * ease, piece.sz);
    host.civicMeshes[piece.mesh].setMatrixAt(piece.index, host.matrix);
  }
  for (const mesh of host.civicMeshes) mesh.instanceMatrix.needsUpdate = true;
}

export function updateCivics(host: CivicSystemHost, dt: number): void {
  for (let index = 0; index < host.civicTarget.length; index += 1) {
    const current = host.civicProgress[index];
    const target = host.civicTarget[index];
    if (current === target) continue;
    host.civicProgress[index] = target > current ? Math.min(target, current + dt / 1.2) : Math.max(target, current - dt / 0.6);
    host.writeCivic(index);
  }
}
