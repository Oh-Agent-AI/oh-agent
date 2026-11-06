/**
 * 占地谓词的唯一实现（CITY_PLANNER_V2_SPEC §5.2，步 1）。
 *
 * 「占地圈 16 点采样」曾抄了 8 份（cityPlan×4、constraints、siting×2、repairs），阈值与河道口径各异
 * （<0.5 / <0.8 / >-0.8；含不含 inRiver；河岸带 14/60）——measure 说合格、修复说不合格（或反之）的
 * 「两套口径」就是在谓词层复活的（spec D3）。本模块只依赖 Geography 形状与线段距离，measure / 落位 /
 * 修复三方共用；口径差异必须经 opts 显式表达，禁止调用方再写自己的采样循环。
 *
 * 迁移纪律（spec §5.2）：每次替换调用点，plan/场景基线哈希必须不变；口径确实不同的用 opts 保留，
 * 不得「顺手统一」——统一口径是行为变更，需单独一步、单独审。
 */
import { DetMath as Math } from "../detMath";
import { segmentDistance } from "../roadGeometry";
import type { Vec2 } from "../cityLayout";
import { roadSegmentsCrossInterior } from "./relations";

/** 现有各口径的水位常量：siteInWater 系 <0.5；占地「干地」≥0.8；海上岛「深水」≤-0.8。 */
export const WATER_LEVEL = 0.5;
export const DRY_LEVEL = 0.8;
export const DEEP_LEVEL = -0.8;

/** 地理判定注入：调用方传各自的 height/inRiver 闭包（cityPlan 的闭包含 hasRiver 短路，保持原语义）。 */
export type FootprintGeo = {
  height: (x: number, z: number) => number;
  inRiver: (x: number, z: number) => boolean;
  /** 河岸带：点到河中线 < riverWidth+bank。无河的调用方不传（opts.riverBank 不出现即不检查）。 */
  riverBank?: (x: number, z: number, bank: number) => boolean;
};

export type WetOpts = {
  /** 水位（缺省 WATER_LEVEL）。 */
  level?: number;
  /** 计入河道。 */
  river?: boolean;
  /** 计入河岸带宽度（需要 geo.riverBank）。 */
  riverBank?: number;
};

/** 占地圈 16 点采样（奇数点外圈 r、偶数点内圈 0.6r），返回「落水」点数。 */
export function wetCount(geo: FootprintGeo, c: Vec2, radius: number, opts: WetOpts = {}): number {
  const level = opts.level ?? WATER_LEVEL;
  let n = 0;
  for (let k = 0; k < 16; k += 1) {
    const t = (k / 16) * Math.PI * 2; const r = k % 2 ? radius : radius * 0.6;
    const x = c.x + Math.cos(t) * r; const z = c.z + Math.sin(t) * r;
    if (geo.height(x, z) < level || (opts.river && geo.inRiver(x, z)) || (opts.riverBank !== undefined && geo.riverBank !== undefined && geo.riverBank(x, z, opts.riverBank))) n += 1;
  }
  return n;
}

/** 占地「全干」判定（水位 DRY_LEVEL、含河道；早退）。 */
export function isDry(geo: FootprintGeo, c: Vec2, radius: number): boolean {
  for (let k = 0; k < 16; k += 1) {
    const t = (k / 16) * Math.PI * 2; const r = k % 2 ? radius : radius * 0.6;
    const x = c.x + Math.cos(t) * r; const z = c.z + Math.sin(t) * r;
    if (geo.height(x, z) < DRY_LEVEL || geo.inRiver(x, z)) return false;
  }
  return true;
}

/** 海上小岛的「全深水」判定（整圈 ≤DEEP_LEVEL、不在河道、不贴河岸 60 带；早退）。 */
export function isDeepWater(geo: FootprintGeo, c: Vec2, radius: number): boolean {
  for (let k = 0; k < 16; k += 1) {
    const t = (k / 16) * Math.PI * 2; const r = k % 2 ? radius : radius * 0.6;
    const x = c.x + Math.cos(t) * r; const z = c.z + Math.sin(t) * r;
    if (geo.height(x, z) > DEEP_LEVEL || geo.inRiver(x, z) || (geo.riverBank !== undefined && geo.riverBank(x, z, 60))) return false;
  }
  return true;
}

/** 点到一组折线（主干 / 环线 / 路段）的最近距离——曾五份全量扫描（siting/repairs 的 nearestRoad、
 *  distanceToTrunks、distanceToRing、地块终筛），此处一份。 */
export function polylineDistance(runs: Vec2[][], p: Vec2): number {
  let d = Infinity;
  for (const run of runs) for (let k = 1; k < run.length; k += 1) d = Math.min(d, segmentDistance(p, run[k - 1], run[k]));
  return d;
}

/** Closest actual segment, including its tangent; never substitute the endpoint chord. */
export function closestPolylineSegment(points: Vec2[], p: Vec2): { d: number; q: Vec2; a: Vec2; b: Vec2; index: number } | null {
  let best: { d: number; q: Vec2; a: Vec2; b: Vec2; index: number } | null = null;
  for (let k = 1; k < points.length; k += 1) {
    const a = points[k - 1], b = points[k], dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    const q = { x: a.x + dx * t, z: a.z + dz * t }, d = Math.hypot(q.x - p.x, q.z - p.z);
    if (!best || d < best.d) best = { d, q, a, b, index: k - 1 };
  }
  return best;
}

/** 同上，但连最近点一起返回（临街修复要沿「路→用地」方向拉，需要垂足坐标）。 */
export function polylineClosest(runs: Vec2[][], p: Vec2): { d: number; q: Vec2 } | null {
  let best: { d: number; q: Vec2 } | null = null;
  for (const run of runs) {
    const near = closestPolylineSegment(run, p);
    if (near && (!best || near.d < best.d)) best = { d: near.d, q: near.q };
  }
  return best;
}

// ── 2c：从 buildPlan 迁出的三个纯几何谓词 + 安全线检查（原 RepairContext 闭包成员，D5 收尾）──

/** 桥头避让：用地不能贴着过河桥两端（桥头必须留出接路空间）。 */
export function nearBridgeEnd(bridges: Array<{ from: Vec2; to: Vec2 }>, x: number, z: number, radius: number): boolean {
  return bridges.some((b) => Math.hypot(b.from.x - x, b.from.z - z) < radius + 14 || Math.hypot(b.to.x - x, b.to.z - z) < radius + 14);
}

/** 线段 ab 与 cd 是否真相交（不含共端点）。 */
export function crosses(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  return roadSegmentsCrossInterior(a, b, c, d);
}

// ── 网络优先批次 6a-2：实际占地几何原语（设计 §2 P2「圆形稀疏占地采样 → 实际 footprint 终筛」）──
// 旧口径全部以「中心 + 半径」采样：长条/旋转模型的角点可以越过采样圈压路、悬空（设计 §8.1 走廊
// 矩阵「旋转长条角点」）。这里提供定向矩形与凸多边形的精确距离原语 + 「16 采样点初筛 → 一次精确
// 复核」的组合闸门。全部纯函数；多边形输入须为凸且逆时针（orientedRectPolygon 构造保证，
// isConvexCounterClockwise 供守卫/调用方自检）。首批只有凸包形状——模型多组成部分时用若干凸
// 多边形分别终筛（设计 §5），不建通用几何框架。

/** 定向矩形（中心 + yaw + 宽深；width 沿局部 x、depth 沿局部 z）。 */
export type OrientedRect = Vec2 & { yaw: number; width: number; depth: number };

/** 定向矩形的四个角点（逆时针；绕 yaw 旋转后的 ±width/2、±depth/2）。 */
export function orientedRectPolygon(rect: OrientedRect): Vec2[] {
  const c = Math.cos(rect.yaw); const s = Math.sin(rect.yaw);
  const hw = rect.width / 2; const hd = rect.depth / 2;
  const corner = (lx: number, lz: number): Vec2 => ({ x: rect.x + c * lx - s * lz, z: rect.z + s * lx + c * lz });
  return [corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)];
}

/** 多边形是否凸且逆时针（叉积同号；面积 0 视为非法）。 */
export function isConvexCounterClockwise(polygon: Vec2[]): boolean {
  if (polygon.length < 3) return false;
  let area = 0; let sign = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]; const b = polygon[(i + 1) % polygon.length]; const c = polygon[(i + 2) % polygon.length];
    area += a.x * b.z - b.x * a.z;
    const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    if (Math.abs(cross) > 1e-12) { const s = cross > 0 ? 1 : -1; if (sign && s !== sign) return false; sign = s; }
  }
  return area / 2 > 0;
}

/** 点是否在（凸、逆时针）多边形内或边界上。 */
export function convexContains(polygon: Vec2[], p: Vec2): boolean {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]; const b = polygon[i];
    if ((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x) < -1e-9) return false;
  }
  return true;
}

/** 点到凸多边形的距离：在内部/边界上为 0，否则为到各边的最近距离。 */
export function pointToPolygonDistance(polygon: Vec2[], p: Vec2): number {
  if (convexContains(polygon, p)) return 0;
  let d = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) d = Math.min(d, segmentDistance(p, polygon[j], polygon[i]));
  return d;
}

/** 两线段的最短距离（相交/共端点为 0）。 */
export function segmentToSegmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (crosses(a, b, c, d)) return 0;
  return Math.min(segmentDistance(a, c, d), segmentDistance(b, c, d), segmentDistance(c, a, b), segmentDistance(d, a, b));
}

/** 线段到凸多边形的距离：相交或端点落入多边形为 0，否则为到各边线段距离的最小值。 */
export function segmentToPolygonDistance(a: Vec2, b: Vec2, polygon: Vec2[]): number {
  if (convexContains(polygon, a) || convexContains(polygon, b)) return 0;
  let d = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) d = Math.min(d, segmentToSegmentDistance(a, b, polygon[j], polygon[i]));
  return d;
}

/**
 * 占地多边形与「道路中心线 ab 按半宽 halfWidth 扫掠出的路面带」的净空：
 * = 多边形到中心线段的距离 − halfWidth；负值 = 侵入带内的深度（压路）。
 * 这是有误差界的连续几何检查（设计 §4.5），不是采样点近似。
 */
export function sweptBandClearance(polygon: Vec2[], a: Vec2, b: Vec2, halfWidth: number): number {
  return segmentToPolygonDistance(a, b, polygon) - halfWidth;
}

/** 与 wetCount 同圈型的 16 采样点（奇数点外圈 r、偶数点内圈 0.6r）——初筛与现有口径共用的采样几何。 */
export function ringSamples16(center: Vec2, radius: number): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k < 16; k += 1) {
    const t = (k / 16) * Math.PI * 2; const r = k % 2 ? radius : radius * 0.6;
    out.push({ x: center.x + Math.cos(t) * r, z: center.z + Math.sin(t) * r });
  }
  return out;
}

/**
 * 「16 采样点初筛 → 一次精确复核」组合闸门：占地（凸多边形，如 orientedRectPolygon 的产物）
 * 是否与任一路段的扫掠带保持 ≥ margin 净空。
 *   初筛：采样圈（boundingRadius）上任一点进入带内（含 margin）即整体拒绝——保守淘汰，
 *         可能误拒（boundingRadius 高估实际轮廓时），绝不误放；
 *   复核：初筛通过后对每段做一次精确 sweptBandClearance——旋转长条角点越过采样圈的盲区
 *         （旧圆形口径）由此补上；初筛通过 + 复核拒绝的样本见 verify-city-footprint-geoms。
 * 纯函数、无随机：同输入同输出（守卫双跑证明）。
 */
export function footprintClearsRoadBand(polygon: Vec2[], center: Vec2, boundingRadius: number, runs: Vec2[][], halfWidth: number, margin = 0): boolean {
  for (const p of ringSamples16(center, boundingRadius)) {
    for (const run of runs) for (let k = 1; k < run.length; k += 1) {
      if (segmentDistance(p, run[k - 1], run[k]) < halfWidth + margin) return false;
    }
  }
  for (const run of runs) for (let k = 1; k < run.length; k += 1) {
    if (sweptBandClearance(polygon, run[k - 1], run[k], halfWidth) < margin) return false;
  }
  return true;
}

/** 两点连线能否通过（可建、坡度可走、不穿预留地）。reservations = publicSites + landmarks。 */
export function safeRoadLink(geo: { buildable: (x: number, z: number) => boolean; terrain: { slope: (x: number, z: number) => number } }, reservations: Array<{ x: number; z: number; radius: number }>, a: Vec2, b: Vec2): boolean {
  const distance = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(distance / 4));
  for (let i = 0; i <= steps; i += 1) {
    const p = { x: a.x + (b.x - a.x) * i / steps, z: a.z + (b.z - a.z) * i / steps };
    if (!geo.buildable(p.x, p.z) || geo.terrain.slope(p.x, p.z) > 0.9) return false;
    if (reservations.some((site) => Math.hypot(p.x - site.x, p.z - site.z) < site.radius + 5)) return false;
  }
  return true;
}
