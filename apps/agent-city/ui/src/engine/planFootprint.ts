/**
 * 自由级设施（致敬地标、市政用地）的真实占地、朝向与入口（docs/CITY_MAP_EDITOR_ROADMAP_SPEC.md P1-3 的自由落位部分）。
 *
 * 生成器把它们存成「中心 + radius」——radius 是**名义预留圆**（modelEnvelope 叫它 nominal-plot-reservation / legacy-radius），
 * 不是建筑的形状。编辑器曾直接拿这个圆做落位：路必须离中心 ≥ 0.75r、重叠也按圆算，于是车站这种矩形建筑永远贴不上路；
 * 接入路又从圆的外接方形外起笔（r·√2 外），离建筑真实边缘还有大半个半径——用户截图：车站孤零零立在草地上，路接不上。
 *
 * 这里按模型的真实地面实体给占地（局部坐标，+z 为正面——与 models/physical 的 EntranceSpec 同一约定）：
 *   - 在生成器的地面登记表里的（villa-complex）：resolveGroundModel 的声明；
 *   - 模型带物理声明的（凯旋门、帆形歌剧院陆侧变体、摩天轮）：声明的 footprint；
 *   - 渲染层导出了几何的：市政厅 civicGroundFootprint、车站站台 + 站房、体育场看台外廓；
 *   - 声明式模型但物理声明待补的（电视塔、宝塔、灯塔）：从它的 3D 件表俯视投影（planProjection）——派生口径，声明一到就让位；
 *   - 其余（双子塔、扭转塔、观景塔、港口、公园…，手写造型、没有件表）：保留预留圆，如实标 `exact: false`——
 *     那是生成器的**留地**，不是建筑的形状。
 *
 * 两层投影（用户：「建筑空间从上往下投影到地面，叠加基座」——对，但要按高度分层）：
 *   - parts（地面占地）：落地的实体——基座、墩、腿、售票亭。地形可建、正门、贴路的前沿按它；
 *   - overhead（俯视投影）：parts ∪ 上层悬挑（拱券、帆壳）∪ 运动件扫过的范围（摩天轮转盘竖在 x-y 平面，
 *     俯视是一条 ≈57 × 5 的窄条，不是圆）。路与楼、楼与楼的碰撞都按它——与生成器
 *     planner/modelEnvelope 的 conservativeProjection 同一口径：没有高度契约就不放路从悬挑下穿过
 *     （凯旋门两墩之间按设计是路面，但「净空够不够」要模型层给高度声明，编辑器不替它下结论）。
 * 纯函数；局部 → 世界的变换与 planner/modelEnvelope 的 worldPoint 同一个公式（yaw 绕 y，+z 正面 → 世界 (sin yaw, cos yaw)）。
 */
import { hashSeed } from "../cityModel";
import type { Vec2 } from "./cityLayout";
import { resolveGroundModel } from "./models/groundRegistry";
import type { LocalFootprint, LocalRegion } from "./models/physical";
import { civicGroundFootprint, stationHallLocal } from "./models/publicSiteGeometry";
import type { MotionEnvelope, PhysicalDeclaration } from "./models/physical";
import { archModel } from "./models/landmarks/arch";
import { sailOperaModel } from "./models/landmarks/sailOpera";
import { ferrisWheelModel } from "./models/landmarks/ferrisWheel";
import { tvTowerModel } from "./models/landmarks/tvTower";
import { pagodaModel } from "./models/landmarks/pagoda";
import { lighthouseModel } from "./models/landmarks/lighthouse";
import type { BuildingModel } from "./models/model";
import { projectParts } from "./planProjection";

export type Polygon = readonly Vec2[];
/** 设施前沿到路肩的退距（同 MODEL_ENVELOPE_CONFIG.defaultRoadSetback）。 */
export const ROAD_SETBACK = 3;

export type FootprintSpec = {
  /** 地面占地：局部坐标的凸多边形并集（圆已离散成 16 边形）。 */
  parts: readonly Polygon[];
  /** 俯视投影：parts ∪ 悬挑 ∪ 运动包络投影（无声明时 = parts）。碰撞按它。 */
  overhead: readonly Polygon[];
  /** 是否是模型的真实形状（false = 名义预留圆）。 */
  exact: boolean;
  /** 形状从哪来：物理声明 / 地面登记表 / 渲染层导出 / 件表俯视投影（派生）/ 名义圆。 */
  source: FootprintSource;
  /** 俯视投影的局部包围盒。 */
  min: Vec2; max: Vec2;
};

const circle = (cx: number, cz: number, r: number, n = 16): Polygon => Array.from({ length: n }, (_, i) => ({ x: cx + Math.cos((i / n) * Math.PI * 2) * r, z: cz + Math.sin((i / n) * Math.PI * 2) * r }));
const rect = (cx: number, cz: number, w: number, d: number): Polygon => [{ x: cx - w / 2, z: cz - d / 2 }, { x: cx + w / 2, z: cz - d / 2 }, { x: cx + w / 2, z: cz + d / 2 }, { x: cx - w / 2, z: cz + d / 2 }];
const fromRegion = (region: LocalRegion): Polygon =>
  region.shape === "circle" ? circle(region.center.x, region.center.z, region.radius)
    : region.shape === "rect" ? rect(region.center.x, region.center.z, region.width, region.depth) : region.vertices;
const fromFootprint = (footprint: LocalFootprint): Polygon[] => footprint.parts.map(fromRegion);

export type FootprintSource = "declared" | "registry" | "renderer" | "projected" | "nominal";

function spec(parts: Polygon[], source: FootprintSource, above: Polygon[] = []): FootprintSpec {
  const overhead = [...parts, ...above];
  const xs = overhead.flat().map((p) => p.x); const zs = overhead.flat().map((p) => p.z);
  return { parts, overhead, exact: source !== "nominal", source, min: { x: Math.min(...xs), z: Math.min(...zs) }, max: { x: Math.max(...xs), z: Math.max(...zs) } };
}

/** 运动包络（绕轴扫掠圆柱）的俯视投影：绕 y 转是圆；绕 x/z 转是竖着的圆盘，俯视是 2·外半径 × 2·半厚 的矩形。 */
function motionProjection(m: MotionEnvelope): Polygon {
  const [cx, , cz] = m.center;
  if (m.axis === "y") return circle(cx, cz, m.outerRadius);
  return m.axis === "z" ? rect(cx, cz, 2 * m.outerRadius, 2 * m.halfDepth) : rect(cx, cz, 2 * m.halfDepth, 2 * m.outerRadius);
}

/** 已声明物理占地的模型（registry 的 BUILDING_MODELS 里带 physical 的那些；直接引叶子模块，不经 registry——它拉 three）。 */
const DECLARED: Record<string, PhysicalDeclaration | undefined> = Object.fromEntries(
  [archModel, sailOperaModel, ferrisWheelModel].map((model) => [model.id, model.physical]));

/** 声明式模型里物理声明还没补的：从件表俯视投影（registry 的 PHYSICAL_PENDING——补了声明就会走 DECLARED）。 */
const PROJECTABLE: Record<string, BuildingModel> = Object.fromEntries([tvTowerModel, pagodaModel, lighthouseModel].map((model) => [model.id, model]));

// corridorViolation asks for a site's footprint once per candidate road segment.
// For projected models that used to rebuild every mesh sample and convex hull on
// every call. Geometry is a pure function of model id, hashed instance seed and
// radius, so retain a small LRU of projection results.
const PROJECTED_FOOTPRINT_CACHE_LIMIT = 64;
const projectedFootprints = new Map<string, FootprintSpec | null>();

/** 件表投影（默认 sizing：塔高取上限——XZ 外廓与高度无关或随高度只增不减，取上限是保守方向）。 */
function fromProjection(model: BuildingModel, id: string, radius: number): FootprintSpec | null {
  const seed = hashSeed(id);
  const key = `${model.id}\u0000${seed}\u0000${radius}`;
  if (Number.isFinite(radius) && projectedFootprints.has(key)) {
    const cached = projectedFootprints.get(key)!;
    projectedFootprints.delete(key);
    projectedFootprints.set(key, cached);
    return cached;
  }
  try {
    const projected = projectParts(model.geometry({ seed, radius }));
    const result = projected ? spec(projected.ground, "projected", projected.overhead.slice(projected.ground.length)) : null;
    if (Number.isFinite(radius)) {
      projectedFootprints.set(key, result);
      if (projectedFootprints.size > PROJECTED_FOOTPRINT_CACHE_LIMIT)
        projectedFootprints.delete(projectedFootprints.keys().next().value!);
    }
    return result;
  } catch {
    if (Number.isFinite(radius)) {
      projectedFootprints.set(key, null);
      if (projectedFootprints.size > PROJECTED_FOOTPRINT_CACHE_LIMIT)
        projectedFootprints.delete(projectedFootprints.keys().next().value!);
    }
    return null;
  }
}

/** 声明 → 两层投影。运动包络是多个输入变体的联合（摩天轮按 cap 有两种半径），全取——保守方向。 */
function fromDeclaration(declaration: PhysicalDeclaration): FootprintSpec {
  return spec(fromFootprint(declaration.footprint), "declared", [
    ...(declaration.overhang ? fromFootprint(declaration.overhang) : []),
    ...(declaration.motion ?? []).map(motionProjection),
  ]);
}

/**
 * 设施的局部占地。kind：地标种类（landmarkKind）或市政用地种类（publicKind）；id 给需要种子的模型（庄园）。
 * 只认得出名义圆时返回圆（exact=false）。island：立在海上小岛的变体（歌剧院带 shore）——声明只覆盖陆侧，岛本来就是圆，照旧按圆。
 */
export function siteFootprint(kind: string, id: string, radius: number, island = false): FootprintSpec {
  const declared = island ? undefined : DECLARED[kind];
  if (declared) return fromDeclaration(declared);
  const ground = resolveGroundModel(kind, { seed: hashSeed(id), radius });
  if (ground.status === "partial") return spec(fromFootprint(ground.declaration.footprint), "registry");
  if (kind === "civic") return spec(fromFootprint(civicGroundFootprint(radius)), "renderer");
  if (kind === "station") {
    // 与 civicSystem 渲染同源：站台 r·1.5 × r·1.1（含雨棚、轨道、列车），站房在站台后沿外侧。
    const hall = stationHallLocal(radius);
    return spec([rect(0, 0, radius * 1.5, radius * 1.1), rect(hall.centre.x, hall.centre.z, hall.width, hall.depth)], "renderer");
  }
  if (kind === "stadium") {
    // 看台：椭圆 27 × 19.5 上 18 段 10.5 × 5.5 的看台块（渲染写死，不随 radius 缩放）；外廓按看台外沿取矩形。
    return spec([rect(0, 0, 2 * (27 + 5.5), 2 * (19.5 + 5.5))], "renderer");
  }
  const projectable = island ? undefined : PROJECTABLE[kind];
  const projected = projectable && fromProjection(projectable, id, radius);
  if (projected) return projected;
  return spec([circle(0, 0, radius)], "nominal");
}

/** 局部 → 世界（同 modelEnvelope.worldPoint）。 */
export const toWorld = (p: Vec2, origin: Vec2, yaw: number): Vec2 => ({
  x: origin.x + p.x * Math.cos(yaw) + p.z * Math.sin(yaw),
  z: origin.z - p.x * Math.sin(yaw) + p.z * Math.cos(yaw),
});

export function worldParts(footprint: FootprintSpec, origin: Vec2, yaw: number): Polygon[] {
  return footprint.parts.map((part) => part.map((p) => toWorld(p, origin, yaw)));
}
/** 俯视投影 → 世界（碰撞用）。 */
export function worldOverhead(footprint: FootprintSpec, origin: Vec2, yaw: number): Polygon[] {
  return footprint.overhead.map((part) => part.map((p) => toWorld(p, origin, yaw)));
}

/** Bounded deterministic terrain samples over the actual declared ground shape. */
export function worldFootprintSamples(footprint: FootprintSpec, origin: Vec2, yaw: number, spacing = 4): Vec2[] {
  if (!Number.isFinite(spacing) || spacing <= 0) return [];
  const samples: Vec2[] = [];
  for (const polygon of worldParts(footprint, origin, yaw)) {
    const xs = polygon.map((point) => point.x), zs = polygon.map((point) => point.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const nx = Math.max(1, Math.ceil((maxX - minX) / spacing)), nz = Math.max(1, Math.ceil((maxZ - minZ) / spacing));
    // Fail closed rather than allowing malformed model data to create unbounded work.
    if ((nx + 1) * (nz + 1) + samples.length > 4096) return [];
    for (let ix = 0; ix <= nx; ix += 1) for (let iz = 0; iz <= nz; iz += 1) {
      const point = { x: minX + (maxX - minX) * ix / nx, z: minZ + (maxZ - minZ) * iz / nz };
      if (pointInPolygon(point, polygon)) samples.push(point);
    }
  }
  return samples;
}

/** Exact distance from model polygons to linework, measured against road centerlines. */
export function footprintRunsDistance(footprint: FootprintSpec, origin: Vec2, yaw: number, runs: readonly (readonly Vec2[])[]): number {
  let best = Infinity;
  for (const polygon of worldParts(footprint, origin, yaw)) for (const run of runs) {
    if (run.length === 1) {
      const point = run[0];
      if (pointInPolygon(point, polygon)) return 0;
      for (let i = 0; i < polygon.length; i += 1) best = Math.min(best, pointSegment(point, polygon[i], polygon[(i + 1) % polygon.length]));
    } else for (let i = 1; i < run.length; i += 1) best = Math.min(best, segmentPolygonDistance(run[i - 1], run[i], polygon));
  }
  return best;
}

/** Ground-road clearance uses exterior setback except inside a declared
 * through-passage. Two opposed vehicle entrances define that lane; the full
 * road capsule must still clear every solid pier. This is XY evidence only. */
export function siteRoadClear(owner: { id?: string; kind: string; x: number; z: number; yaw: number; radius: number; shore?: Vec2 },
  a: Vec2, b: Vec2, width: number, margin = 3): boolean {
  if (![owner.x, owner.z, owner.yaw, owner.radius, a.x, a.z, b.x, b.z, width, margin].every(Number.isFinite)
    || owner.radius < 0 || width < 0 || margin < 0) return false;
  const id = owner.id ?? `reservation:${owner.kind}`;
  const footprint = siteFootprint(owner.kind, id, owner.radius, !!owner.shore);
  const distance = footprintRunsDistance(footprint, owner, owner.yaw, [[a, b]]);
  if (distance >= width / 2 + margin) return true;
  if (!width || distance <= width / 2 + 1e-9 || owner.shore) return false;
  const declaration = DECLARED[owner.kind] ?? (() => {
    const ground = resolveGroundModel(owner.kind, { seed: hashSeed(id), radius: owner.radius });
    return ground.status === "partial" ? ground.declaration : undefined;
  })();
  const entrances = declaration?.entrances.filter(entrance => entrance.required && entrance.mode === "vehicle") ?? [];
  const local = (p: Vec2) => ({ x: (p.x - owner.x) * Math.cos(owner.yaw) - (p.z - owner.z) * Math.sin(owner.yaw),
    z: (p.x - owner.x) * Math.sin(owner.yaw) + (p.z - owner.z) * Math.cos(owner.yaw) });
  const u = local(a), v = local(b), length = Math.hypot(v.x - u.x, v.z - u.z);
  if (!length) return false;
  for (let i = 0; i < entrances.length; i += 1) for (let j = i + 1; j < entrances.length; j += 1) {
    const start = entrances[i], end = entrances[j];
    const span = Math.hypot(end.local.x - start.local.x, end.local.z - start.local.z);
    if (!span) continue;
    const axis = { x: (end.local.x - start.local.x) / span, z: (end.local.z - start.local.z) / span };
    const dot = (p: Vec2, q: Vec2) => p.x * q.x + p.z * q.z;
    if (dot(start.outward, axis) > -0.999 || dot(end.outward, axis) < 0.999) continue;
    const travel = { x: (v.x - u.x) / length, z: (v.z - u.z) / length };
    if (Math.abs(dot(travel, axis)) < Math.cos(Math.PI / 12)) continue;
    const along = (p: Vec2) => (p.x - start.local.x) * axis.x + (p.z - start.local.z) * axis.z;
    const side = (p: Vec2) => -(p.x - start.local.x) * axis.z + (p.z - start.local.z) * axis.x;
    const p = along(u), delta = along(v) - p, collar = width / 2 + margin;
    const cuts = [(-collar - p) / delta, (span + collar - p) / delta].sort((x, y) => x - y);
    const lo = Math.max(0, cuts[0]), hi = Math.min(1, cuts[1]);
    if (lo > hi) continue;
    const spare = Math.min(start.width, end.width) / 2 - width / 2;
    const offset = (t: number) => Math.abs(side(u) + (side(v) - side(u)) * t);
    if (spare > 0 && Math.max(offset(lo), offset(hi)) < spare - 1e-9) return true;
  }
  return false;
}

/** Distance from an exact model polygon to the legacy circular reservation. */
export function footprintCircleDistance(footprint: FootprintSpec, origin: Vec2, yaw: number, circleCentre: Vec2, circleRadius: number): number {
  let best = Infinity;
  for (const polygon of worldParts(footprint, origin, yaw)) {
    if (pointInPolygon(circleCentre, polygon)) return -circleRadius;
    for (let i = 0; i < polygon.length; i += 1) best = Math.min(best, pointSegment(circleCentre, polygon[i], polygon[(i + 1) % polygon.length]));
  }
  return best - circleRadius;
}

function polygonDistance(a: Polygon, b: Polygon): number {
  if (polygonsOverlap(a, b)) {
    let penetration = Infinity;
    for (const polygon of [a, b]) for (let i = 0; i < polygon.length; i += 1) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length], nx = -(q.z - p.z), nz = q.x - p.x;
      const length = Math.hypot(nx, nz); if (!length) continue;
      const left = a.map(point => (point.x * nx + point.z * nz) / length);
      const right = b.map(point => (point.x * nx + point.z * nz) / length);
      penetration = Math.min(penetration, Math.max(...left) - Math.min(...right), Math.max(...right) - Math.min(...left));
    }
    return -penetration;
  }
  if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return 0;
  let best = Infinity;
  for (let i = 0; i < a.length; i += 1) best = Math.min(best, segmentPolygonDistance(a[i], a[(i + 1) % a.length], b));
  return best;
}

/** Separation between physical model shapes, falling back to the nominal circles only when undeclared. */
export function siteFootprintSeparation(a: { id: string; kind: string; x: number; z: number; yaw: number; radius: number; shore?: Vec2 },
  b: { id: string; kind: string; x: number; z: number; yaw: number; radius: number; shore?: Vec2 }): number {
  if (![a.x, a.z, a.radius, b.x, b.z, b.radius].every(Number.isFinite) || a.radius < 0 || b.radius < 0) return -Infinity;
  const projection = (owner: typeof a) => {
    const footprint = siteFootprint(owner.kind, owner.id ?? `reservation:${owner.kind}`, owner.radius, !!owner.shore);
    return { ...footprint, parts: footprint.overhead };
  };
  const left = projection(a), right = projection(b);
  if ((left.exact && !Number.isFinite(a.yaw)) || (right.exact && !Number.isFinite(b.yaw))) return -Infinity;
  if (!left.exact && !right.exact) return Math.hypot(a.x - b.x, a.z - b.z) - a.radius - b.radius;
  if (left.exact && !right.exact) return footprintCircleDistance(left, a, a.yaw, b, b.radius);
  if (!left.exact && right.exact) return footprintCircleDistance(right, b, b.yaw, a, a.radius);
  return Math.min(...worldParts(left, a, a.yaw).flatMap(x => worldParts(right, b, b.yaw).map(y => polygonDistance(x, y))));
}

/** 包围盒在世界里的朝向矩形（叠加层、拾取、障碍物用）。 */
export function worldBox(footprint: FootprintSpec, origin: Vec2, yaw: number): { x: number; z: number; yaw: number; width: number; depth: number } {
  const c = toWorld({ x: (footprint.min.x + footprint.max.x) / 2, z: (footprint.min.z + footprint.max.z) / 2 }, origin, yaw);
  return { x: c.x, z: c.z, yaw, width: footprint.max.x - footprint.min.x, depth: footprint.max.z - footprint.min.z };
}

/** 正面入口：**地面占地**局部包围盒 +z 面的中点（门开在落地的实体上，不在悬挑或转盘下），朝外方向 = 局部 +z。 */
export function frontEntrance(footprint: FootprintSpec, origin: Vec2, yaw: number): { at: Vec2; outward: Vec2 } {
  const xs = footprint.parts.flat().map((p) => p.x); const maxZ = Math.max(...footprint.parts.flat().map((p) => p.z));
  return { at: toWorld({ x: (Math.min(...xs) + Math.max(...xs)) / 2, z: maxZ }, origin, yaw), outward: { x: Math.sin(yaw), z: Math.cos(yaw) } };
}

/** 让局部 +z（正面）指向方向 d 的 yaw。 */
export const yawFacing = (d: Vec2): number => Math.atan2(d.x, d.z);

// ── 凸多边形几何 ──

const cross = (a: Vec2, b: Vec2, p: Vec2) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
export function pointInPolygon(p: Vec2, poly: Polygon): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const c = cross(poly[i], poly[(i + 1) % poly.length], p);
    if (Math.abs(c) < 1e-9) continue;
    const s = c > 0 ? 1 : -1;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}
function pointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x; const dz = b.z - a.z; const l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}
function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(a, b, c); const d2 = cross(a, b, d); const d3 = cross(c, d, a); const d4 = cross(c, d, b);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
/** 线段到凸多边形的距离（相交或在内为 0）。 */
export function segmentPolygonDistance(a: Vec2, b: Vec2, poly: Polygon): number {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const c = poly[i]; const d = poly[(i + 1) % poly.length];
    if (segmentsCross(a, b, c, d)) return 0;
    best = Math.min(best, pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b));
  }
  return best;
}
/** 两个凸多边形是否相交（分离轴，贴边不算）。 */
export function polygonsOverlap(a: Polygon, b: Polygon): boolean {
  for (const poly of [a, b]) for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i]; const q = poly[(i + 1) % poly.length];
    const nx = -(q.z - p.z); const nz = q.x - p.x;
    const project = (shape: Polygon) => shape.map((v) => v.x * nx + v.z * nz);
    const pa = project(a); const pb = project(b);
    if (Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6) return false;
  }
  return true;
}
export const rectPolygon = (r: { x: number; z: number; yaw: number; width: number; depth: number }): Polygon => rect(0, 0, r.width, r.depth).map((p) => toWorld(p, r, r.yaw));
