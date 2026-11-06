/**
 * 从模型的 3D 件表（BuildingModel.geometry → Part[]）**俯视投影**出占地——给还没有物理声明的声明式模型
 * （电视塔、宝塔、灯塔：registry 的 PHYSICAL_PENDING）用。用户截图：电视塔的底是一个巨大的圆，那是生成器的
 * 名义留地（radius），而模型的裙房只有直径 17。
 *
 * 做法：每个件按编译器（render/buildingCompiler.ts）的唯一变换顺序把采样点送到模型局部坐标——
 *   preShift → bake(rotateX→Y→Z) → anchor(base 抬半高) → shift → 网格 rot（xyz 欧拉）→ at → 父组（rot、at）；
 * 再丢掉 y，取 XZ 凸包。底面贴地（最低点 y ≤ GROUND_Y）的件进地面占地，所有件进俯视投影。
 * 圆周采样按外切多边形取点（半径 / cos(π/n)），凸包只会比真实轮廓略大，不会小——保守方向。
 *
 * 这是**派生**口径，不是经过 verify-city-physical 审过的声明：声明一到（模型层补 physical），siteFootprint 就改用声明。
 * 纯函数，无 three 依赖。
 */
import type { BakedRotation, Part, Vec3 } from "./models/model";
import type { Polygon } from "./planFootprint";

/** 件的最低点不高于这个高度就算落地（裙房、基座、塔身；腿从 y=3 起的斜撑不算，它们在裙房投影里）。 */
const GROUND_Y = 0.6;
/** 圆周采样点数。 */
const RING = 16;

type P3 = [number, number, number];

const rotX = ([x, y, z]: P3, a: number): P3 => [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
const rotY = ([x, y, z]: P3, a: number): P3 => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
const rotZ = ([x, y, z]: P3, a: number): P3 => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];
const add = ([x, y, z]: P3, [dx, dy, dz]: Vec3): P3 => [x + dx, y + dy, z + dz];
const bake = (p: P3, b?: BakedRotation): P3 => { let q = p; if (b?.x) q = rotX(q, b.x); if (b?.y) q = rotY(q, b.y); if (b?.z) q = rotZ(q, b.z); return q; };
/** three 的 Euler 'XYZ'：v' = Rx · Ry · Rz · v（先绕 z）。 */
const euler = (p: P3, r?: Vec3): P3 => (r ? rotX(rotY(rotZ(p, r[2]), r[1]), r[0]) : p);

/** 外切采样的圆周（y 处、半径 r，在 x-z 平面）。 */
function ring(r: number, y: number, from = 0, sweep = Math.PI * 2): P3[] {
  const n = sweep < Math.PI * 2 ? Math.max(4, Math.ceil((RING * sweep) / (Math.PI * 2))) : RING;
  const k = r / Math.cos(Math.PI / RING);
  return Array.from({ length: n + (sweep < Math.PI * 2 ? 1 : 0) }, (_, i) => { const t = from + (sweep * i) / n; return [Math.sin(t) * k, y, Math.cos(t) * k] as P3; });
}
const boxCorners = ([w, h, d]: Vec3): P3[] => [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => [sx * w / 2, sy * h / 2, sz * d / 2] as P3)));

/** 件几何的局部采样点（几何自身坐标，未经任何变换；与 three 的几何构造同形）。 */
function samples(part: Exclude<Part, { kind: "group" }>): P3[] {
  switch (part.kind) {
    case "box": case "panel": return boxCorners(part.size);
    case "cylinder": {
      const h = part.size[1]; const r = part.size[0] / 2; const arc = part.arc;
      return [...ring(r, -h / 2, arc?.[0], arc?.[1]), ...ring(part.radiusTop ?? r, h / 2, arc?.[0], arc?.[1])];
    }
    case "cone": return [...ring(part.size[0] / 2, -part.size[1] / 2), [0, part.size[1] / 2, 0]];
    case "sphere": {
      const [rx, ry, rz] = part.stretch ? [part.size[0] * part.stretch[0], part.size[0] * part.stretch[1], part.size[0] * part.stretch[2]] : part.size;
      // 整球的包围采样（phi/theta 切片只会更小，按整球取——保守）。
      return [-1, -0.5, 0, 0.5, 1].flatMap((v) => ring(Math.sqrt(1 - v * v) || 0.001, v).map(([x, , z]) => [x * rx, v * ry, z * rz] as P3));
    }
    case "torus": {
      // three 的 TorusGeometry 在 x-y 平面（轴 z）：大圆外沿 R+tube，厚度 ±tube。
      const outer = part.radius + part.tube; const sweep = part.arc ?? Math.PI * 2;
      const n = Math.max(4, Math.ceil((RING * sweep) / (Math.PI * 2))); const k = outer / Math.cos(Math.PI / RING);
      return Array.from({ length: n + 1 }, (_, i) => (sweep * i) / n).flatMap((t) => [-part.tube, part.tube].map((z) => [Math.cos(t) * k, Math.sin(t) * k, z] as P3));
    }
    case "tube": return part.points.flatMap((p) => boxCorners([2 * part.radius, 2 * part.radius, 2 * part.radius]).map((c) => add(c, p)));
    case "bulbs": return part.pieces.map((p) => [...p] as P3);
    case "instanced": return part.pieces.flatMap((piece) => boxCorners(piece.size).map((c) => add(euler(c, piece.rot), piece.at)));
  }
}

/** 件的采样点 → 模型局部坐标（编译器的变换顺序，见文件头）。 */
function placed(part: Exclude<Part, { kind: "group" }>, groups: ReadonlyMap<string, Extract<Part, { kind: "group" }>>): P3[] {
  const base = (part.anchor ?? (part.kind === "box" || part.kind === "cylinder" || part.kind === "cone" ? "base" : "center")) === "base";
  const lift = base && "size" in part ? part.size[1] / 2 : 0;
  let points = samples(part).map((p) => {
    let q = part.preShift ? add(p, part.preShift) : p;
    q = bake(q, part.bake);
    if (lift) q = [q[0], q[1] + lift, q[2]];
    if (part.shift) q = add(q, part.shift);
    if (part.kind !== "instanced") q = euler(q, part.rot);
    return add(q, part.at);
  });
  for (let parent = part.parent; parent;) {
    const group = groups.get(parent); if (!group) break;
    points = points.map((p) => add(euler(p, group.rot), group.at));
    parent = group.parent;
  }
  return points;
}

/** XZ 凸包（单调链），逆时针。 */
function hull(points: readonly P3[]): Polygon {
  const pts = [...new Map(points.map(([x, , z]) => [`${x.toFixed(4)},${z.toFixed(4)}`, { x, z }])).values()].sort((a, b) => a.x - b.x || a.z - b.z);
  if (pts.length < 3) return pts;
  const cross = (o: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: { x: number; z: number }[] = []; const upper: { x: number; z: number }[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** 一个点是否落在凸多边形内（含边）。 */
const inside = (p: { x: number; z: number }, poly: Polygon) => poly.every((a, i) => {
  const b = poly[(i + 1) % poly.length];
  return (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x) >= -1e-6;
});
/** 去掉整个落在别的块里的块（塔身、天线都在裙房投影里——留着只是让碰撞多算几十遍）。 */
function prune(polys: Polygon[]): Polygon[] {
  const sorted = [...polys].sort((a, b) => area(b) - area(a));
  const out: Polygon[] = [];
  for (const poly of sorted) if (!out.some((big) => poly.every((p) => inside(p, big)))) out.push(poly);
  return out;
}
const area = (poly: Polygon) => Math.abs(poly.reduce((sum, a, i) => { const b = poly[(i + 1) % poly.length]; return sum + a.x * b.z - b.x * a.z; }, 0)) / 2;

/** 件表 → 两层投影（局部坐标）。没有落地件（整座悬空/漂浮）返回 null，调用方退回名义圆。 */
export function projectParts(parts: readonly Part[]): { ground: Polygon[]; overhead: Polygon[] } | null {
  const groups = new Map(parts.filter((part): part is Extract<Part, { kind: "group" }> => part.kind === "group").map((group) => [group.id, group]));
  const ground: Polygon[] = []; const above: Polygon[] = [];
  for (const part of parts) {
    if (part.kind === "group" || part.role === "beam") continue; // beam：光束/灯柱这类非实体（同 physical 的 exclusions）
    const points = placed(part, groups);
    const poly = hull(points);
    if (poly.length < 3) continue;
    (Math.min(...points.map((p) => p[1])) <= GROUND_Y ? ground : above).push(poly);
  }
  if (!ground.length) return null;
  const groundKept = prune(ground);
  // 俯视投影 = 地面占地开头 + 抬升件里没被地面占地盖住的部分（与 FootprintSpec.overhead「以 parts 开头」的约定一致）。
  const extra = prune([...groundKept, ...above]).filter((poly) => !groundKept.includes(poly));
  return { ground: groundKept, overhead: [...groundKept, ...extra] };
}
