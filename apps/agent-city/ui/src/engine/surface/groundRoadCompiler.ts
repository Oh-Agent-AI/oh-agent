/** CPU-only ordinary-road geometry compiler. Geometry order and attributes
 * preserve the previous renderer contract; this does not certify drivability. */
import { roadWidthFor, roadClassSpec } from "../roadStandard";
import type { CityLayout, RoadEdge, Vec2 } from "../cityLayout";
import { roadPaintPlan } from "../cityRoadPaint";
import { cornerArc, junctionIndex, renderRoadEdges, roadJunctionPlan, STRAIGHT_GAP, taperOutline, type JunctionArm, type RoadJunction } from "../cityRoadJunctions";
import { clipConvexToTerrain, conformMesh, convexHullOf, earClip, edgeCrossings, terrainFit, triangulateConvex, type ClipPoint } from "./terrainClip";

/** Same transfer function as the project's Three.js linear-sRGB working space.
 * Fixed local #rrggbb palette only; no CSS parser or global color-management state. */
class LinearColor {
  r = 1; g = 1; b = 1;
  set(hex: string): this {
    const n = Number.parseInt(hex.slice(1), 16);
    const linear = (c: number) => c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
    this.r = linear(((n >> 16) & 255) / 255);
    this.g = linear(((n >> 8) & 255) / 255);
    this.b = linear((n & 255) / 255); return this;
  }
  clone(): LinearColor { const c = new LinearColor(); c.r = this.r; c.g = this.g; c.b = this.b; return c; }
}

export type GroundRoadPiece = Readonly<{
  id: string; kind: "carriageway" | "junction" | "sidewalk";
  source: Readonly<{ kind: "road"; id: string; edgeIds: readonly string[]; fromNode: string; toNode: string }>
    | Readonly<{ kind: "junction"; id: string }>;
  layer: number; firstIndex: number; indexCount: number; firstVertex: number; vertexCount: number;
  /** Exact max |surface − (rendered terrain + lift)| over the piece; > ROAD_SURFACE_LIFT/2 is a defect. */
  terrainDeviation: number;
}>;

/** 路面抬升（防 z-fighting 的同时低于路缘盒基面 0.02 + 盒高）；层间再靠 polygonOffset 分开。 */
export const ROAD_SURFACE_LIFT = 0.04;
/** 填充圆弧每段 ≤ 20°（路缘实体仍按 12°）：填充是平贴地面的色块，弦高差肉眼不可辨，顶点省四成。 */
const FILL_ARC_STEP = Math.PI / 9;


/** 宽度 → 层（0 = 人行道，1 = 路口填充，2–4 = 支路 / 次干 / 主干）。 */
export function roadLayerOf(width: number): 2 | 3 | 4 {
  return width <= roadWidthFor("local") ? 2 : width <= roadWidthFor("collector") ? 3 : 4;
}
/** 人行道带宽（每侧）。视觉风格线（claude/city-visual-style-analysis）把路面与人行道
 *  垫底统一到 cityRoadJunctions.SIDEWALK_BAND = 1.8（曾 1.2，真实 ≥2），此处同步。 */
const SIDEWALK = roadClassSpec("local").sidewalk;
const SIDEWALK_COLOR = "#d4cfc2";
/** aRoadRun.w：0 = 路段带（画标线），1 = 沥青填充，2 = 人行道。 */
const PIECE_RIBBON = 0; const PIECE_FILL = 1; const PIECE_SIDEWALK = 2;
/** 宽度 → 标线方案：0 支路（虚中线）、1 次干（黄虚中线 + 白边线）、2 主干（双黄实线 + 白车道虚线 + 白边线）。 */
export function roadMarkingKindOf(width: number): 0 | 1 | 2 {
  return width < roadWidthFor("collector") ? 0 : width < roadWidthFor("arterial") ? 1 : 2;
}
const asphaltOf = (kind: RoadEdge["kind"]) => (kind === "arterial" ? "#505b60" : "#646c6b");

/** run 一端的标线参数（距该端的弧长）。center/left/right = 中线、+v 侧边线、−v 侧边线从该端退多远开始画；
 *  stop / zebra = 停止线 / 斑马线中心距该端（−1 = 不画）。 */
export type RunEnd = { center: number; left: number; right: number; stop: number; zebra: number };
const OPEN_END: RunEnd = { center: 0, left: 0, right: 0, stop: -1, zebra: -1 };
/** 斑马线沿路长 2.5（中心 ±1.25）。 */
export const ZEBRA_HALF = 1.25;

/** 路口口门距离：本臂整幅要走多远才离开其它臂的路面（与次路停止线同一公式，|sin| < 0.2 的近平行臂不构成口门）。 */
function mouthOf(junction: RoadJunction, arm: JunctionArm): number {
  let mouth = 0;
  for (const other of junction.arms) {
    if (other === arm) continue;
    const sin = Math.abs(arm.dir.x * other.dir.z - arm.dir.z * other.dir.x);
    const cos = Math.abs(arm.dir.x * other.dir.x + arm.dir.z * other.dir.z);
    if (sin >= 0.2) mouth = Math.max(mouth, (other.half + arm.half * cos) / sin);
  }
  return mouth;
}

/** run 在某端的标线参数。atStart：该端是 run 的起点（+v 侧 = 臂的逆时针侧）还是终点（+v 侧 = 顺时针侧）。
 *  非路口端（度 2 续接 / 尽端）不退让。桥面 / 滨水臂沿用旧贴图的 6 / 6.5。 */
export function runEndMarkings(index: ReturnType<typeof junctionIndex>, junctionNodes: ReadonlySet<string>, edge: RoadEdge, node: string, atStart: boolean): RunEnd {
  if (!junctionNodes.has(node)) return OPEN_END;
  const junction = index.byNode.get(node);
  const arm = index.armOf(edge, node);
  if (!junction || !arm || arm.legacy) return { center: 6, left: 6, right: 6, stop: -1, zebra: arm && arm.length >= 14 ? 6.5 : -1 };
  const mouth = mouthOf(junction, arm);
  // 一侧有圆角：边线退到切点（路缘圆弧从这里开始）；没有圆角但不是直行侧：退到口门；直行侧：贯通。
  const side = (trim: number | null, gap: number) => trim ?? (gap < STRAIGHT_GAP ? mouth : 0);
  const ccw = side(arm.ccwTrim, arm.ccwGap); const cw = side(arm.cwTrim, arm.cwGap);
  const stop = arm.stopAt ?? -1;
  // 斑马线：次路在停止线之后，其余在口门外；臂太短（< 14，或斑马线越过 45% 臂长）不画——同旧贴图的「< 14 不画」。
  let zebra = stop > 0 ? stop + 0.25 + 0.4 + ZEBRA_HALF : mouth + 0.5 + ZEBRA_HALF;
  if (arm.length < 14 || zebra + ZEBRA_HALF > 0.45 * arm.length) zebra = -1;
  // 中线：主路直穿（0，斑马线带内由 shader 让开）；其余退到斑马线 / 停止线 / 口门之后。
  const center = arm.role === "major" ? 0 : zebra > 0 ? zebra + ZEBRA_HALF + 0.5 : stop > 0 ? stop + 0.6 : mouth + 0.5;
  return atStart ? { center, left: ccw, right: cw, stop, zebra } : { center, left: cw, right: ccw, stop, zebra };
}

export type RoadGeometryLayer = { positions: number[]; normals: number[]; colors: number[]; uv: number[]; run: number[]; ends: number[]; edges: number[]; zebra: number[]; index: number[]; count: number };
type Builder = RoadGeometryLayer;
const newBuilder = (): Builder => ({ positions: [], normals: [], colors: [], uv: [], run: [], ends: [], edges: [], zebra: [], index: [], count: 0 });
/** 三角形一律朝上（俯视逆时针）：带子与扇面的点序各有方向，靠约定很容易整片绕反、被背面剔除
 *  （第一版就是整张路面网格不可见）。按法向 y 分量现场定序；退化三角形丢弃。 */
function pushUpTriangle(b: Builder, i: number, j: number, k: number): void {
  const P = b.positions;
  const ax = P[j * 3] - P[i * 3]; const az = P[j * 3 + 2] - P[i * 3 + 2];
  const bx = P[k * 3] - P[i * 3]; const bz = P[k * 3 + 2] - P[i * 3 + 2];
  const ny = az * bx - ax * bz;
  if (Math.abs(ny) < 1e-9) return;
  if (ny > 0) b.index.push(i, j, k); else b.index.push(i, k, j);
}

/** 路面几何（纯数据，不建 THREE 对象）：按层返回各自的顶点 / 属性，供 buildRoadSurface 与守卫共用。 */
export function compileGroundRoadSurface(layout: Pick<CityLayout, "roadEdges" | "extent" | "terrain">) {
  const roadEdges = renderRoadEdges(layout.roadEdges); // 窄短桩按接续宽路画（cityRoadJunctions.renderRoadEdges）
  const { runs, junctions } = roadPaintPlan(roadEdges);
  const plan = roadJunctionPlan(roadEdges);
  const index = junctionIndex(plan);
  const layers = [newBuilder(), newBuilder(), newBuilder(), newBuilder(), newBuilder()];
  const pieces: GroundRoadPiece[] = [];
  const recordPiece = (b: Builder, layer: number, id: string, kind: GroundRoadPiece["kind"], source: GroundRoadPiece["source"], emit: () => number | void) => {
    const firstIndex = b.index.length; const firstVertex = b.count;
    const deviation = emit();
    if (b.index.length > firstIndex) pieces.push(Object.freeze({ id, kind, source: Object.freeze(source), layer,
      firstIndex, indexCount: b.index.length - firstIndex, firstVertex, vertexCount: b.count - firstVertex,
      terrainDeviation: typeof deviation === "number" ? deviation : 0 }));
  };
  const color = new LinearColor();
  // 精确贴地判定见 terrainClip.terrainFit：旧版只查中点，带子最低处比「地形 + 抬升」低 0.29（埋进地形），
  // 与路口扇面叠置高差 0.30，驾驶区域判 height-conflict 关闭路口。
  const fit = terrainFit(layout, ROAD_SURFACE_LIFT);
  const { heightAt, triangleDeviation } = fit;
  /** 路面与渲染地形的允许偏差（抬升量的一半：最坏也不钻到地下，两片叠置路面高差 ≤ 0.04）。 */
  const PLANAR_TOLERANCE = ROAD_SURFACE_LIFT / 2;
  /** 法线取地形真值梯度（中心差分 1）：同一位置的重叠顶点法线一致，层间不因光照差闪烁。 */
  const normalAt = (x: number, z: number) => {
    const gx = (layout.terrain.height(x + 1, z) - layout.terrain.height(x - 1, z)) / 2;
    const gz = (layout.terrain.height(x, z + 1) - layout.terrain.height(x, z - 1)) / 2;
    const length = Math.hypot(gx, 1, gz);
    return [-gx / length, 1 / length, -gz / length];
  };
  const vertex = (b: Builder, x: number, z: number, attrs: { u: number; v: number; run: number[]; ends: number[]; edges: number[]; zebra: number[]; color: LinearColor }) => {
    b.positions.push(x, heightAt(x, z), z); b.normals.push(...normalAt(x, z));
    b.colors.push(attrs.color.r, attrs.color.g, attrs.color.b);
    b.uv.push(attrs.u, attrs.v); b.run.push(...attrs.run); b.ends.push(...attrs.ends); b.edges.push(...attrs.edges); b.zebra.push(...attrs.zebra);
    return b.count++;
  };

  const grid = fit.grid;
  type Attrs = { u: number; v: number; run: number[]; ends: number[]; edges: number[]; zebra: number[]; color: LinearColor };
  /** Conforming emission for one piece: vertices shared by exact XZ across all its polygons. */
  const conformingEmitter = (b: Builder, existing: readonly (ClipPoint & { index: number })[]) => {
    // Keyed by GPU (Float32) quantisation: two canonical points 1e-9 apart are one vertex, else
    // they become a zero-area triangle after upload (seed 1 tier 2). Existing row/rim vertices first.
    const keyOf = (p: ClipPoint) => `${Math.fround(p.x)},${Math.fround(p.z)}`;
    const memo = new Map<string, number>(existing.map((p) => [keyOf(p), p.index]));
    const index = (p: ClipPoint & { index?: number }, attrsAt: (p: ClipPoint) => Attrs) => {
      if (p.index !== undefined) return p.index;
      const key = keyOf(p); let i = memo.get(key);
      if (i === undefined) { i = vertex(b, p.x, p.z, attrsAt(p)); memo.set(key, i); }
      return i;
    };
    const centroidOf = (piece: readonly ClipPoint[]) => () => ({ x: piece.reduce((n, p) => n + p.x, 0) / piece.length, z: piece.reduce((n, p) => n + p.z, 0) / piece.length });
    const emit = (triangles: [ClipPoint, ClipPoint, ClipPoint][], attrsAt: (p: ClipPoint) => Attrs) => {
      for (const [x, y, z] of triangles) pushUpTriangle(b, index(x, attrsAt), index(y, attrsAt), index(z, attrsAt));
    };
    return {
      /** Already-conformed triangles over canonical points. */
      triangles: (triangles: [ClipPoint, ClipPoint, ClipPoint][], attrsAt: (p: ClipPoint) => Attrs) => emit(triangles, attrsAt),
      /** Fails the tolerance: split along the terrain triangulation (deviation 0). */
      clip: (corners: readonly ClipPoint[], attrsAt: (p: ClipPoint) => Attrs) => {
        for (const piece of clipConvexToTerrain(grid, corners)) emit(triangulateConvex(piece, centroidOf(piece)), attrsAt);
      },
      /** Passes, but a neighbour was clipped: carry the neighbour's crossings on the shared edges. */
      refine: (corners: readonly ClipPoint[], sharedEdges: readonly boolean[], attrsAt: (p: ClipPoint) => Attrs) => {
        const ring: ClipPoint[] = [];
        corners.forEach((c, k) => { ring.push(c); if (sharedEdges[k]) ring.push(...edgeCrossings(grid, c, corners[(k + 1) % corners.length])); });
        emit(triangulateConvex(ring, centroidOf(corners)), attrsAt);
      },
    };
  };

  /** 带子：每个路点一行（折点用两侧方向的角平分线 + 斜接系数，上限 2，锐折不炸尖）、相邻两行一个条带。
   *  条带两三角贴地（精确偏差 ≤ PLANAR_TOLERANCE）就照旧两三角——平地字节不变；否则按地形三角网裁成凸片。
   *  旧实现只查中点：带子最低处比「地形 + 抬升」低 0.29（埋进地形），与路口扇面叠置高差 0.30；
   *  而沿线二分插行又在折点内侧斜接伸出的那一段里把四边形翻面（5 宽 50°–90° 折点的 non-manifold）。
   *  闭合环线（首尾同点）的接缝也是折点：首尾各斜接一次并共用同一行，旧实现两端垂直截断、在角上交叠。 */
  const ribbon = (points: Vec2[], lengths: number[], width: number, b: Builder, attrsBase: { run: number[]; ends: number[]; edges: number[]; zebra: number[]; color: LinearColor }) => {
    const half = width / 2;
    const last = points.length - 1;
    const closed = last >= 3 && points[0].x === points[last].x && points[0].z === points[last].z;
    const dirOf = (i: number) => {
      const a = points[i]; const c = points[i + 1]; const len = Math.hypot(c.x - a.x, c.z - a.z) || 1;
      return { x: (c.x - a.x) / len, z: (c.z - a.z) / len };
    };
    const miterAt = (d: { x: number; z: number }, e: { x: number; z: number }) => {
      const mx = -(d.z + e.z); const mz = d.x + e.x; const ml = Math.hypot(mx, mz);
      if (ml <= 1e-6) return null;
      const nx = mx / ml; const nz = mz / ml;
      return { nx, nz, miter: Math.min(2, 1 / Math.max(0.5, nx * -d.z + nz * d.x)) };
    };
    const samples: Array<{ x: number; z: number; u: number; nx: number; nz: number; miter: number }> = [];
    for (let i = 0; i < last; i += 1) {
      const d = dirOf(i); const a = points[i]; const c = points[i + 1];
      const segment = lengths[i + 1] - lengths[i];
      for (const t of i === 0 ? [0, 1] : [1]) {
        let nx = -d.z; let nz = d.x; let miter = 1;
        const j = t === 0 ? i : i + 1; // the point this row sits on
        const bend = t === 1 && i + 1 < last ? miterAt(d, dirOf(i + 1)) : closed && (t === 0 || i + 1 === last) ? miterAt(dirOf(last - 1), dirOf(0)) : null;
        if (bend) {
          ({ nx, nz, miter } = bend);
          // The mitred inner corner reaches half·miter·|n·d| along the road; past a neighbouring
          // row that folds the strip (seed 7: a 1.4 stub after a 64° bend). Narrow only then.
          const before = j > 0 ? lengths[j] - lengths[j - 1] : lengths[last] - lengths[last - 1];
          const after = j < last ? lengths[j + 1] - lengths[j] : lengths[1] - lengths[0];
          const along = Math.abs(nx * d.x + nz * d.z);
          const limit = 0.9 * Math.min(before, after);
          if (half * miter * along > limit) miter = Math.max(1e-3, limit / (half * along));
        }
        samples.push({ x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t, u: lengths[i] + segment * t, nx, nz, miter });
      }
    }
    // Closed seam: the closing row is the opening row, bit for bit, so the mesh welds into a ring.
    if (closed) samples[samples.length - 1] = { ...samples[0], u: lengths[last] };
    type RowPoint = ClipPoint & { index: number; u: number; v: number };
    const rows: RowPoint[][] = samples.map((sample) => [0, 1].map((j) => {
      const v = -half + width * j;
      const x = sample.x + sample.nx * v * sample.miter; const z = sample.z + sample.nz * v * sample.miter;
      return { x, z, u: sample.u, v, index: vertex(b, x, z, { ...attrsBase, u: sample.u, v }) };
    }));
    // Each strip L0,R0,R1,L1 is two triangles. A convex strip keeps the original diagonal R0–L1
    // (byte parity); a strip made concave by a narrowed miter splits through its reflex corner.
    type Tri = [RowPoint, RowPoint, RowPoint];
    const strips: { tris: [Tri, Tri]; pass: [boolean, boolean] }[] = [];
    let deviation = 0;
    for (let r = 1; r < rows.length; r += 1) {
      const [a, c] = rows[r - 1]; const [d, e] = rows[r];
      const quad = [a, c, e, d];
      const turn = quad.map((q, k) => { const p0 = quad[(k + 3) % 4]; const p2 = quad[(k + 1) % 4]; return (q.x - p0.x) * (p2.z - q.z) - (q.z - p0.z) * (p2.x - q.x); });
      const convex = turn.every((t) => t >= 0) || turn.every((t) => t <= 0);
      const majority = Math.sign(turn.reduce((n, t) => n + Math.sign(t), 0));
      const reflexAtAorE = !convex && (Math.sign(turn[0]) !== majority || Math.sign(turn[2]) !== majority);
      const tris: [Tri, Tri] = reflexAtAorE ? [[a, c, e], [a, e, d]] : [[a, d, c], [c, d, e]];
      const pass = tris.map(([p, q, w]) => {
        const dev = triangleDeviation(p.x, p.z, q.x, q.z, w.x, w.z);
        if (dev <= PLANAR_TOLERANCE) deviation = Math.max(deviation, dev);
        return dev <= PLANAR_TOLERANCE;
      }) as [boolean, boolean];
      strips.push({ tris, pass });
    }
    const emitter = conformingEmitter(b, rows.flat());
    const rowOf = new Map<RowPoint, number>(); rows.forEach((row, r) => row.forEach((p) => rowOf.set(p, r)));
    /** Is the triangle holding row edge `row` (as a full edge) in strip s clipped? */
    const clippedAtRow = (s: number, row: number) => {
      const strip = strips[s]; if (!strip) return false;
      return strip.tris.some((tri, t) => !strip.pass[t] && tri.filter((p) => rowOf.get(p) === row).length === 2);
    };
    for (let s = 0; s < strips.length; s += 1) {
      const { tris, pass } = strips[s];
      const [a, c] = rows[s]; const [d, e] = rows[s + 1];
      // Strip attributes: invert the bilinear strip map for (along, across) of interior points.
      const attrsAt = (p: ClipPoint): Attrs => {
        let u = 0.5; let w = 0.5;
        for (let k = 0; k < 8; k += 1) {
          const lx = a.x + (d.x - a.x) * u; const lz = a.z + (d.z - a.z) * u; const rx = c.x + (e.x - c.x) * u; const rz = c.z + (e.z - c.z) * u;
          const fx = lx + (rx - lx) * w - p.x; const fz = lz + (rz - lz) * w - p.z;
          const sx = (d.x - a.x) * (1 - w) + (e.x - c.x) * w; const sz = (d.z - a.z) * (1 - w) + (e.z - c.z) * w;
          const wx = rx - lx; const wz = rz - lz; const det = sx * wz - sz * wx;
          if (Math.abs(det) < 1e-12) break;
          u -= (fx * wz - fz * wx) / det; w -= (sx * fz - sz * fx) / det;
        }
        u = Math.min(1, Math.max(0, u)); w = Math.min(1, Math.max(0, w));
        return { ...attrsBase, u: a.u + (d.u - a.u) * u, v: -half + width * w };
      };
      tris.forEach((tri, t) => {
        // Which edges are shared with a clipped neighbour (row above/below, or this strip's diagonal)?
        const shared = tri.map((p, k) => {
          const q = tri[(k + 1) % 3]; const rp = rowOf.get(p)!; const rq = rowOf.get(q)!;
          if (rp === rq) return rp === s ? clippedAtRow(s - 1, s) : clippedAtRow(s + 1, s + 1);
          const isDiagonal = tris[1 - t].includes(p) && tris[1 - t].includes(q);
          return isDiagonal && !pass[1 - t];
        });
        if (!pass[t]) emitter.clip(tri, attrsAt);
        else if (shared.some(Boolean)) emitter.refine(tri, shared, attrsAt);
        else pushUpTriangle(b, tri[0].index, tri[1].index, tri[2].index);
      });
    }
    return deviation;
  };

  // ── 路段带 ──
  for (const run of runs) {
    const points = run.points;
    if (points.length < 2) continue;
    const lengths = [0];
    for (let i = 1; i < points.length; i += 1) lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
    const total = lengths[lengths.length - 1];
    if (total < 1e-3) continue;
    const start = runEndMarkings(index, junctions, run.startEdge, run.from, true);
    const end = runEndMarkings(index, junctions, run.endEdge, run.to, false);
    const half = run.width / 2;
    const attrsBase = {
      run: [half, roadMarkingKindOf(run.width), total, PIECE_RIBBON],
      ends: [start.center, end.center, start.stop, end.stop],
      edges: [start.left, start.right, end.left, end.right],
      zebra: [start.zebra, end.zebra],
      color: color.set(asphaltOf(run.kind)).clone(),
    };
    const layer = roadLayerOf(run.width);
    const source = { kind: "road" as const, id: JSON.stringify([...run.edgeIds].sort()), edgeIds: Object.freeze([...run.edgeIds]), fromNode: run.from, toNode: run.to };
    recordPiece(layers[layer], layer, `road:${source.id}`, "carriageway", source,
      () => ribbon(points, lengths, run.width, layers[layer], attrsBase));
    // 人行道带：同一条中线、宽 + 2.4，压在最底层；不画标线。
    recordPiece(layers[0], 0, `sidewalk:${source.id}`, "sidewalk", source,
      () => ribbon(points, lengths, run.width + 2 * SIDEWALK, layers[0], { ...attrsBase, run: [half + SIDEWALK, 0, total, PIECE_SIDEWALK], color: color.set(SIDEWALK_COLOR).clone() }));
  }

  // ── 路口填充：扇形三角化 + 径向细分（长扇面贴地不穿地形） ──
  const fill = color.clone();
  const emitFan = (center: Vec2, ring: Vec2[], closed: boolean, hex: string, sidewalk = false) => {
    const b = layers[sidewalk ? 0 : 1];
    const attrs = { u: 0, v: 0, run: [0, 0, 0, sidewalk ? PIECE_SIDEWALK : PIECE_FILL], ends: [0, 0, -1, -1], edges: [0, 0, 0, 0], zebra: [-1, -1], color: fill.set(hex).clone() };
    const segments = closed ? ring.length : ring.length - 1;
    if (segments < 1) return;
    // 平地上一圈只要「圆心 + 环」一层（顶点共享）。扇区贴地（精确偏差 ≤ PLANAR_TOLERANCE）照旧一个三角形；
    // 否则按地形三角网裁成凸片，相邻扇区共享的径向边带上同样的交点（无 T 形接点）。
    // 旧版三个中点测试漏判，坡地扇面与路段带叠置高差到 0.3。
    const middle = vertex(b, center.x, center.z, attrs);
    // Rim positions keep the original `center + (p − center)·1` arithmetic (byte parity with flat baselines).
    const rimXZ = ring.map((p) => ({ x: center.x + (p.x - center.x) * 1, z: center.z + (p.z - center.z) * 1 }));
    const row = rimXZ.map((p) => vertex(b, p.x, p.z, attrs));
    const hub = { x: center.x, z: center.z, index: middle };
    const rim = rimXZ.map((p, k) => ({ x: p.x, z: p.z, index: row[k] }));
    // A fan is only valid when the polygon is star-shaped from its hub (every sector turns the
    // same way). Corner sidewalk arcs offset by 1.2 are not always: their sectors overlapped and
    // the piece was non-manifold (seed 7 tier 3, and twice in display layouts). Those polygons are
    // ear-clipped instead; star-shaped fans keep their exact original triangles.
    const turn = Array.from({ length: segments }, (_, k) => {
      const p = rimXZ[k]; const q = rimXZ[(k + 1) % ring.length];
      return (p.x - center.x) * (q.z - center.z) - (p.z - center.z) * (q.x - center.x);
    });
    if (!(turn.every((t) => t > 1e-9) || turn.every((t) => t < -1e-9))) {
      const polygon = closed ? rim : [hub, ...rim];
      // A closed ring that is not even simple (the 1.2-offset taper outline crosses into a bow-tie)
      // means its convex hull — the trapezoid the outline was meant to bound.
      const ears = earClip(polygon) ?? (closed ? earClip(convexHullOf(rim)) : null);
      if (ears) {
        const conformed = conformMesh(fit, PLANAR_TOLERANCE, ears);
        conformingEmitter(b, [hub, ...rim]).triangles(conformed.triangles, () => attrs);
        return conformed.maxDeviation;
      }
    }
    const pass: boolean[] = []; let deviation = 0;
    for (let k = 0; k < segments; k += 1) {
      const p = rimXZ[k]; const q = rimXZ[(k + 1) % ring.length];
      const dev = triangleDeviation(center.x, center.z, p.x, p.z, q.x, q.z);
      pass.push(dev <= PLANAR_TOLERANCE);
      if (dev <= PLANAR_TOLERANCE) deviation = Math.max(deviation, dev);
    }
    const emitter = conformingEmitter(b, [hub, ...rim]);
    const constant = () => attrs;
    for (let k = 0; k < segments; k += 1) {
      const n = (k + 1) % ring.length;
      // Radial edge k is shared with sector k−1, edge n with sector k+1 (cyclic only when closed).
      const before = k > 0 ? pass[k - 1] : closed ? pass[segments - 1] : true;
      const after = k + 1 < segments ? pass[k + 1] : closed ? pass[0] : true;
      if (pass[k] && before && after) { pushUpTriangle(b, middle, row[k], row[n]); continue; }
      // Corners hub → rim k → rim n: edge 0 is radial k, edge 2 is radial n.
      if (!pass[k]) emitter.clip([hub, rim[k], rim[n]], constant);
      else emitter.refine([hub, rim[k], rim[n]], [!before, false, !after], constant);
    }
    return deviation;
  };
  const circle = (c: Vec2, radius: number) => Array.from({ length: 16 }, (_, k) => ({ x: c.x + Math.cos((k / 16) * Math.PI * 2) * radius, z: c.z + Math.sin((k / 16) * Math.PI * 2) * radius }));
  for (const junction of plan) {
    let pieceNumber = 0;
    const fan = (center: Vec2, ring: Vec2[], closed: boolean, hex: string, sidewalk = false) => {
      const layer = sidewalk ? 0 : 1;
      recordPiece(layers[layer], layer, `junction:${JSON.stringify(junction.id)}:${pieceNumber++}`, sidewalk ? "sidewalk" : "junction",
        { kind: "junction", id: junction.id }, () => emitFan(center, ring, closed, hex, sidewalk));
    };
    const node = { x: junction.x, z: junction.z };
    for (const corner of junction.corners) {
      fan(node, cornerArc(corner, 0, FILL_ARC_STEP), false, asphaltOf(corner.kind));
      // 转角人行道：半径 r − 1.2 的同心弧（同地面贴图），圆角铺装压在它上面，只剩弧外 1.2 的一圈。
      fan(node, cornerArc(corner, SIDEWALK, FILL_ARC_STEP), false, SIDEWALK_COLOR, true);
    }
    if (junctions.has(junction.id)) {
      // 路口中心圆盘（≥3 路）：最宽臂的颜色与半径——覆盖背离侧的楔形缺口。
      const widest = junction.arms.find((arm) => arm.edge.width === junction.maxWidth && !arm.edge.bridge) ?? junction.arms[0];
      fan(node, circle(node, junction.maxWidth / 2), true, asphaltOf(widest.edge.kind));
    } else if (junction.arms.length === 2 && !junction.touchesDeck && junction.arms[0].edge.width !== junction.arms[1].edge.width) {
      // 度 2 换宽：窄路宽的圆盘补折角缝（同旧贴图 seams：取窄的，取宽的会鼓包）。
      // 颜色取窄路：换宽 = 换等级，颜色在节点处一刀切换；用宽路色会在窄路两侧露出一圈深色（真机 8→5 渐变）。
      const narrow = junction.arms[0].edge.width < junction.arms[1].edge.width ? junction.arms[0] : junction.arms[1];
      fan(node, circle(node, narrow.half), true, asphaltOf(narrow.edge.kind));
      fan(node, circle(node, narrow.half + SIDEWALK), true, SIDEWALK_COLOR, true);
    }
    if (junction.taper) {
      const { narrow } = junction.taper;
      const outline = taperOutline(junction, 0);
      const mid = { x: outline.reduce((sum, p) => sum + p.x, 0) / 4, z: outline.reduce((sum, p) => sum + p.z, 0) / 4 };
      fan(mid, outline, true, asphaltOf(narrow.edge.kind));
      fan(mid, taperOutline(junction, SIDEWALK), true, SIDEWALK_COLOR, true);
    }
  }
  return Object.freeze({ input: Object.freeze({ roadEdges: layout.roadEdges, terrain: layout.terrain, extent: layout.extent }), layers, pieces: Object.freeze(pieces),
    readiness: "geometry-only" as const,
    // Same-layer union and curb/closed semantics live in surfaceRegions; still missing here:
    unresolved: Object.freeze(["validated-portals", "channelized-islands", "bridge-and-expressway-decks", "cul-de-sac-surfaces"]) });
}

/** Legacy geometry API for existing guards/callers. */
export function roadSurfaceGeometry(layout: Pick<CityLayout, "roadEdges" | "extent" | "terrain">) {
  return compileGroundRoadSurface(layout).layers;
}
export type CompiledGroundRoadSurface = ReturnType<typeof compileGroundRoadSurface>;

/** Quantized patch view exactly matching GPU Float32 positions. Boundaries and
 * portals are deliberately not invented; callers must resolve them before driving. */
export function groundPieceTriangles(compiled: CompiledGroundRoadSurface, piece: GroundRoadPiece) {
  if (!compiled.pieces.includes(piece)) throw new Error("foreign-ground-piece");
  const layer = compiled.layers[piece.layer];
  const positions = new Float32Array(layer.positions.slice(piece.firstVertex * 3, (piece.firstVertex + piece.vertexCount) * 3));
  const indices = new Uint32Array(layer.index.slice(piece.firstIndex, piece.firstIndex + piece.indexCount).map((i) => i - piece.firstVertex));
  return { positions, indices };
}

/** Input identity check for explicit reuse. Not a content hash or cache: callers
 * must never mutate source arrays/terrain in place after compiling a snapshot. */
export function assertGroundRoadSurfaceMatches(compiled: CompiledGroundRoadSurface, layout: Pick<CityLayout, "roadEdges" | "extent" | "terrain">): void {
  if (compiled.input.roadEdges !== layout.roadEdges || compiled.input.terrain !== layout.terrain || compiled.input.extent !== layout.extent) {
    throw new Error("ground-surface-layout-mismatch");
  }
}
