/**
 * 自然系统：树位 / 树几何 / 生态带植被。
 * 纯搬移自 CityParts（this → host），行为与场景图保持逐字节一致。
 */

import * as THREE from "three";
import { hashSeed } from "../../cityModel";
import type { CityLayout, Vec2 } from "../cityLayout";
import type { LoadedFlora } from "../cityFlora";
import { SegmentIndex } from "../cityPlan";
import { bandSegmentsAt, promenadeSegments } from "../citySeaside";
import { roadPaintPlan } from "../cityRoadPaint";
import { renderRoadEdges } from "../cityRoadJunctions";
import { activeTheme } from "../cityTheme";
import { EXPRESSWAY_DECK_WIDTH, mergeGeometries } from "../render/shared";

/** natureSystem 用到的 CityParts 成员（调用方以 `this as unknown as NatureHost` 传入）。 */
export interface NatureHost {
  readonly layout: CityLayout;
  readonly group: THREE.Group;
  readonly disposables: Array<{ dispose: () => void }>;
  readonly matrix: THREE.Matrix4;
  readonly color: THREE.Color;
  readonly treeMesh: THREE.InstancedMesh;
  floraMeshes: THREE.InstancedMesh[];
  urbanPromenadeSegments(): Vec2[][];
  compose(x: number, y: number, z: number, rotationY: number, sx: number, sy: number, sz: number): void;
}

/** 树位：规划层的 parkTrees（此前算出来却从没渲染，district.trees 恒为空）+
 *  棕榈主题下沿街行道树（避开桥、水面和路口）。 */
export function treeSpots(host: NatureHost): Array<{ x: number; z: number; y: number; seed: number }> {
  const theme = activeTheme();
  const spots: Array<{ x: number; z: number; y: number; seed: number }> = [];
  for (const district of host.layout.districts) spots.push(...district.trees);
  spots.push(...(host.layout.parkTrees ?? []));
  // 海滨步道棕榈列（VICE B3）：沿步道折线 ~9 单位间距、两侧交错，走同一份
  // treeSpots——进 treeMesh（棕榈几何）与 applyFlora（真实生态带管线）双路径。
  {
    const seaside = host.layout.seaside;
    const promenades = [...(seaside && !seaside.degraded ? promenadeSegments(seaside) : []), ...host.urbanPromenadeSegments()]; // S3：城区岸段步道也有棕榈列
    if (promenades.length) {
      const terrain = host.layout.terrain;
      let row = 0;
      // 逐合法连续段种植（段间已被净空校验切断，不跨缺口搭桥）。
      for (const segment of promenades) {
        for (let i = 1; i < segment.length; i += 1) {
          const a = segment[i - 1]; const b = segment[i];
          const next = segment[Math.min(segment.length - 1, i + 1)];
          const prev = segment[Math.max(0, i - 2)];
          const segLen = Math.hypot(b.x - a.x, b.z - a.z);
          const steps = Math.max(1, Math.floor(segLen / 7));
          for (let s = 1; s <= steps; s += 1) {
            const t = s / (steps + 1);
            const x = a.x + (b.x - a.x) * t; const z = a.z + (b.z - a.z) * t;
            const tangent = { x: (next.x - prev.x), z: (next.z - prev.z) };
            const tl = Math.hypot(tangent.x, tangent.z) || 1;
            const side = row % 2 === 0 ? 2.8 : -2.8;
            const px = x + (-tangent.z / tl) * side; const pz = z + (tangent.x / tl) * side;
            row += 1;
            const y = terrain.height(px, pz);
            if (y < 0.5 || y > 6) continue;
            spots.push({ x: px, z: pz, y, seed: hashSeed(`palmtree:${px.toFixed(1)}:${pz.toFixed(1)}`) });
          }
        }
      }
    }
  }
  // 棕榈公园（干沙与步道之间，South Beach 的 Lummus Park 式）：三排错落的棕榈林，行距 ~6、株距 9–13 抖动，
  // 不成整齐的树阵；只种在合法海滨段上（bandSegmentsAt 在无效采样处断开）。
  {
    const seaside = host.layout.seaside; const config = host.layout.coastalConfig;
    if (seaside && !seaside.degraded && config && config.promenadeOffset - config.drySandWidth >= 14) {
      const terrain = host.layout.terrain;
      const from = config.drySandWidth + 4; const to = config.promenadeOffset - 4;
      const rows = Math.max(1, Math.floor((to - from) / 6) + 1);
      for (let row = 0; row < rows; row += 1) {
        const d = from + ((to - from) * row) / Math.max(1, rows - 1);
        for (const segment of bandSegmentsAt(seaside, d)) {
          let carry = (row * 4.3) % 9;
          for (let i = 1; i < segment.length; i += 1) {
            const a = segment[i - 1]; const b = segment[i];
            const length = Math.hypot(b.x - a.x, b.z - a.z);
            let t = carry;
            while (t < length) {
              const x = a.x + ((b.x - a.x) * t) / length; const z = a.z + ((b.z - a.z) * t) / length;
              const seed = hashSeed(`palmpark:${x.toFixed(1)}:${z.toFixed(1)}`);
              const y = terrain.height(x, z);
              if (y >= 0.5 && y <= 6 && seed > 0.18) spots.push({ x, z, y, seed });
              t += 9 + seed * 4;
            }
            carry = t - length;
          }
        }
      }
    }
  }
  if (theme.streetTreeSpacing > 0) {
    const terrain = host.layout.terrain;
    const roads = new SegmentIndex(host.layout.roadEdges.map((edge) => edge.points));
    const highways = new SegmentIndex(host.layout.highways ?? []);
    // G2 热带绿化：沿合并后的整条路（roadPaintPlan run）按弧长种行道树，间距跨路段累计；路幅分档做净空。
    // 曾逐条路段种且跳过 <20 的段（多数路已被切成 ~15 的短段），净空又统一按最宽路（7.2）算——
    // 5 宽支路旁的树（离中线 4.9）全被拒，城市里几乎看不到行道树（多视角评估「像沙漠」）。
    const byWidth = new Map<number, Vec2[][]>();
    // 净空与行道树都按渲染路网（窄短桩按接续宽路画）：否则树会种在加宽后的路面上。
    const roadEdges = renderRoadEdges(host.layout.roadEdges);
    for (const edge of roadEdges) if (!edge.bridge) (byWidth.get(edge.width) ?? byWidth.set(edge.width, []).get(edge.width)!).push(edge.points);
    const widthIndex = [...byWidth].map(([width, runs]) => ({ clearance: width / 2 + 1.2, index: new SegmentIndex(runs) }));
    const clearOfRoads = (p: Vec2) => widthIndex.every(({ clearance, index }) => !index.closerThan(p, clearance));
    const slots = host.layout.districts.flatMap((district) => [...district.slots.values()]);
    const buildings = new SegmentIndex(slots.map((slot) => [slot, slot]));
    const buildingClearance = slots.reduce((radius, slot) => Math.max(radius, Math.hypot(slot.width, slot.depth) / 2 + 1.2), 0);
    for (const run of roadPaintPlan(roadEdges).runs) {
      const spacing = theme.streetTreeSpacing * (run.kind === "arterial" ? 0.8 : 1);
      let walked = 0; let next = 9; let index = 0;
      for (let i = 1; i < run.points.length; i += 1) {
        const a = run.points[i - 1]; const b = run.points[i];
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length < 1e-3) continue;
        const dx = (b.x - a.x) / length; const dz = (b.z - a.z) / length;
        while (next <= walked + length) {
          const along = next - walked; next += spacing;
          const side = index % 2 === 0 ? 1 : -1; index += 1;
          const offset = run.width / 2 + 2.4;
          const x = a.x + dx * along - dz * offset * side;
          const z = a.z + dz * along + dx * offset * side;
          const y = terrain.height(x, z);
          if (y < 1.2) continue;
          const point = { x, z };
          if (!clearOfRoads(point) || highways.closerThan(point, EXPRESSWAY_DECK_WIDTH / 2 + 2)) continue;
          if (buildings.closerThan(point, buildingClearance)) continue;
          spots.push({ x, z, y, seed: hashSeed(`street:${Math.round(x)}:${Math.round(z)}`) });
        }
        walked += length;
      }
    }
  }
  return spots;
}

/** 圆冠树：树干 + 二十面体树冠。 */
export function roundTreeGeometry(host: NatureHost): THREE.BufferGeometry {
  const theme = activeTheme();
  const trunk = new THREE.CylinderGeometry(0.14, 0.2, 0.9, 5).translate(0, 0.45, 0);
  const crown = new THREE.IcosahedronGeometry(0.78, 0).translate(0, 1.35, 0);
  return tintedMerge(host, [[trunk, theme.trunk], [crown, theme.foliage]]);
}

/** 棕榈：略弯的细高树干 + 一圈下垂的羽叶（每片叶 = 前倾的扁长方体）。 */
export function palmGeometry(host: NatureHost): THREE.BufferGeometry {
  const theme = activeTheme();
  const height = 4.6;
  const trunk = new THREE.CylinderGeometry(0.1, 0.19, height, 6).translate(0, height / 2, 0);
  // 树干顶端微微偏向一侧，避免整齐得像电线杆。
  const position = trunk.getAttribute("position") as THREE.BufferAttribute;
  for (let index = 0; index < position.count; index += 1) {
    const t = position.getY(index) / height;
    position.setX(index, position.getX(index) + t * t * 0.55);
  }
  trunk.computeVertexNormals();
  const parts: Array<[THREE.BufferGeometry, string]> = [[trunk, theme.trunk]];
  const fronds = 8;
  for (let index = 0; index < fronds; index += 1) {
    const frond = new THREE.BoxGeometry(2.3, 0.05, 0.42).translate(1.15, 0, 0);
    frond.rotateZ(-0.42 - (index % 2) * 0.22); // 叶尖下垂
    frond.rotateY((index / fronds) * Math.PI * 2);
    frond.translate(0.55, height - 0.05, 0);
    parts.push([frond, index % 3 === 0 ? "#27a868" : theme.foliage]);
  }
  return tintedMerge(host, parts);
}

export function tintedMerge(host: NatureHost, parts: Array<[THREE.BufferGeometry, string]>): THREE.BufferGeometry {
  let total = 0;
  for (const [geometry] of parts) total += geometry.getAttribute("position").count;
  const colors = new Float32Array(total * 3);
  let offset = 0;
  const color = new THREE.Color();
  for (const [geometry, hex] of parts) {
    color.set(hex);
    for (let index = 0; index < geometry.getAttribute("position").count; index += 1) {
      colors[offset++] = color.r;
      colors[offset++] = color.g;
      colors[offset++] = color.b;
    }
  }
  const merged = mergeGeometries(parts.map(([geometry]) => geometry));
  merged.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  for (const [geometry] of parts) geometry.dispose();
  return merged;
}

/** 用生态带模型替换程序化树：树位不变（同一份 treeSpots），按确定性 hash 分给各树种。 */
export function applyFlora(host: NatureHost, flora: LoadedFlora): void {
  if (!flora.length || host.floraMeshes.length) return;
  const spots = treeSpots(host);
  const total = flora.reduce((sum, item) => sum + item.species.weight, 0);
  const buckets: Array<typeof spots> = flora.map(() => []);
  for (const spot of spots) {
    let pick = hashSeed(`flora:${spot.x.toFixed(1)}:${spot.z.toFixed(1)}`) * total;
    let index = 0;
    while (index < flora.length - 1 && pick >= flora[index].species.weight) { pick -= flora[index].species.weight; index += 1; }
    buckets[index].push(spot);
  }
  flora.forEach(({ species, geometry }, index) => {
    const list = buckets[index];
    if (!list.length) return;
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const tint = species.tint ? new THREE.Color(species.tint) : null;
    list.forEach((spot, i) => {
      const size = species.height * (0.8 + spot.seed * 0.45);
      host.compose(spot.x, spot.y - 0.1, spot.z, spot.seed * Math.PI * 2, size, size, size);
      mesh.setMatrixAt(i, host.matrix);
      // 染色树种（樱花/枫）：实例色乘在顶点色上，树干也会被染——用浅色乘数只轻推色相。
      mesh.setColorAt(i, tint ? host.color.copy(tint).lerp(new THREE.Color("#ffffff"), 0.25 + spot.seed * 0.2) : host.color.set("#ffffff").multiplyScalar(0.88 + spot.seed * 0.2));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = `city-flora-${index}`;
    host.group.add(mesh);
    host.floraMeshes.push(mesh);
    host.disposables.push(material); // 几何由 cityFlora 缓存共享，不随 parts 销毁
  });
  if (host.floraMeshes.length) host.treeMesh.visible = false;
}

export function buildTrees(host: NatureHost): THREE.InstancedMesh {
  const spots = treeSpots(host);
  const palm = activeTheme().vegetation === "palm";
  const treeGeometry = palm ? palmGeometry(host) : roundTreeGeometry(host);
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.InstancedMesh(treeGeometry, material, Math.max(spots.length, 1));
  mesh.castShadow = true;
  spots.forEach((spot, index) => {
    const scale = palm ? 1.25 + spot.seed * 0.7 : 0.8 + spot.seed * 0.9;
    host.compose(spot.x, spot.y - 0.1, spot.z, spot.seed * Math.PI * 2, scale, scale, scale);
    mesh.setMatrixAt(index, host.matrix);
  });
  mesh.count = spots.length;
  host.group.add(mesh);
  host.disposables.push(treeGeometry, material);
  return mesh;
}
