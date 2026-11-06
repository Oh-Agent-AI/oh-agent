/** Exact conforming split of road polygons against the rendered terrain triangulation.
 * Pure CPU: no THREE, host or layout runtime.
 *
 * 渲染地形是 extent/TERRAIN_SEGMENTS 网格上的分段线性面（每格对角线连 (ix, iz+1)–(ix+1, iz)，即 gx+gz=整数）。
 * 路面若要处处贴地，三角形就必须落在单个地形三角形里——按容差逐级加密在陡坡上会把顶点堆到 25 万
 * 仍贴不住（2026-10 实测），所以不贴地的路面四边形/扇区直接按地形三角形裁成凸片：偏差为 0，
 * 顶点数与跨过的地形三角形数成正比。
 *
 * 不产生裂缝的关键是**规范点**：凸片的顶点只可能是多边形角点、多边形边与地形线的交点、多边形内的
 * 地形顶点。交点由 `edgeCrossings` 统一计算（端点按字典序规范化，正反两向结果逐位相同），
 * Sutherland–Hodgman 的原始输出再吸附到这些规范点上，相邻片/相邻条带共享边的顶点因此逐位一致，
 * 不会出现 T 形接点。 */

import type { CityLayout } from "../cityLayout";
import { TERRAIN_SEGMENTS, terrainSurfaceHeight } from "./terrainSampling";

export type TerrainGrid = Readonly<{ cellSize: number; half: number }>;
export type ClipPoint = { readonly x: number; readonly z: number };

const lexLess = (a: ClipPoint, b: ClipPoint) => a.x < b.x || (a.x === b.x && a.z < b.z);

/** Interior crossings of segment p→q with terrain lines (x, z and diagonal families), ordered from p. */
export function edgeCrossings(grid: TerrainGrid, p: ClipPoint, q: ClipPoint): ClipPoint[] {
  const flip = lexLess(q, p);
  const a = flip ? q : p; const b = flip ? p : q;
  const g = (v: number) => (v + grid.half) / grid.cellSize;
  const ts: number[] = [];
  for (const [u0, u1] of [[g(a.x), g(b.x)], [g(a.z), g(b.z)], [g(a.x) + g(a.z), g(b.x) + g(b.z)]]) {
    if (u0 === u1) continue;
    for (let k = Math.ceil(Math.min(u0, u1)); k <= Math.floor(Math.max(u0, u1)); k += 1) {
      const t = (k - u0) / (u1 - u0);
      if (t > 1e-12 && t < 1 - 1e-12) ts.push(t);
    }
  }
  ts.sort((x, y) => x - y);
  const out: ClipPoint[] = [];
  for (const t of ts) {
    if (out.length && t - (out[out.length - 1] as ClipPoint & { t: number }).t < 1e-12) continue;
    out.push(Object.assign({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, { t }));
  }
  const points = out.map(({ x, z }) => ({ x, z }));
  return flip ? points.reverse() : points;
}

/** Terrain vertices strictly inside a convex polygon (either winding). */
function interiorTerrainVertices(grid: TerrainGrid, polygon: readonly ClipPoint[]): ClipPoint[] {
  const xs = polygon.map((p) => p.x); const zs = polygon.map((p) => p.z);
  const i0 = Math.ceil((Math.min(...xs) + grid.half) / grid.cellSize); const i1 = Math.floor((Math.max(...xs) + grid.half) / grid.cellSize);
  const j0 = Math.ceil((Math.min(...zs) + grid.half) / grid.cellSize); const j1 = Math.floor((Math.max(...zs) + grid.half) / grid.cellSize);
  const sign = Math.sign(signedArea(polygon));
  const out: ClipPoint[] = [];
  for (let i = i0; i <= i1; i += 1) for (let j = j0; j <= j1; j += 1) {
    const p = { x: -grid.half + i * grid.cellSize, z: -grid.half + j * grid.cellSize };
    let inside = true;
    for (let k = 0; k < polygon.length && inside; k += 1) {
      const a = polygon[k]; const b = polygon[(k + 1) % polygon.length];
      inside = sign * ((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x)) > 1e-9;
    }
    if (inside) out.push(p);
  }
  return out;
}
export function signedArea(polygon: readonly ClipPoint[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) { const a = polygon[i]; const b = polygon[(i + 1) % polygon.length]; area += a.x * b.z - b.x * a.z; }
  return area / 2;
}

/** Boundary of a convex polygon with every terrain-line crossing inserted (canonical points). */
export function refinedBoundary<T extends ClipPoint>(grid: TerrainGrid, corners: readonly T[]): (T | ClipPoint)[] {
  const out: (T | ClipPoint)[] = [];
  for (let k = 0; k < corners.length; k += 1) { out.push(corners[k]); out.push(...edgeCrossings(grid, corners[k], corners[(k + 1) % corners.length])); }
  return out;
}

/** Splits a convex polygon into convex pieces each lying inside one terrain triangle.
 * Returned pieces reference the canonical point objects (corners passed in, edge crossings
 * from `edgeCrossings`, interior terrain vertices), so shared vertices compare by identity. */
export function clipConvexToTerrain<T extends ClipPoint>(grid: TerrainGrid, corners: readonly T[]): (T | ClipPoint)[][] {
  const boundary = refinedBoundary(grid, corners);
  const canonical: (T | ClipPoint)[] = [...boundary, ...interiorTerrainVertices(grid, corners)];
  const scale = grid.cellSize * 1e-7;
  const snap = (p: ClipPoint): T | ClipPoint => {
    let best: T | ClipPoint | null = null; let bestD = Infinity;
    for (const c of canonical) { const d = Math.abs(c.x - p.x) + Math.abs(c.z - p.z); if (d < bestD) { bestD = d; best = c; } }
    return best && bestD <= scale ? best : p;
  };
  const xs = corners.map((p) => p.x); const zs = corners.map((p) => p.z);
  const gx0 = Math.floor((Math.min(...xs) + grid.half) / grid.cellSize); const gx1 = Math.floor((Math.max(...xs) + grid.half) / grid.cellSize);
  const gz0 = Math.floor((Math.min(...zs) + grid.half) / grid.cellSize); const gz1 = Math.floor((Math.max(...zs) + grid.half) / grid.cellSize);
  const g = (p: ClipPoint) => ({ gx: (p.x + grid.half) / grid.cellSize, gz: (p.z + grid.half) / grid.cellSize });
  const clip = (poly: ClipPoint[], f: (p: ClipPoint) => number): ClipPoint[] => {
    const out: ClipPoint[] = [];
    for (let k = 0; k < poly.length; k += 1) {
      const a = poly[k]; const b = poly[(k + 1) % poly.length]; const fa = f(a); const fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }); }
    }
    return out;
  };
  const pieces: (T | ClipPoint)[][] = [];
  for (let ix = gx0; ix <= gx1; ix += 1) for (let iz = gz0; iz <= gz1; iz += 1) {
    for (const upper of [false, true]) {
      let poly: ClipPoint[] = [...corners];
      const s = ix + iz + 1;
      const planes: ((p: ClipPoint) => number)[] = upper
        ? [(p) => ix + 1 - g(p).gx, (p) => iz + 1 - g(p).gz, (p) => g(p).gx + g(p).gz - s]
        : [(p) => g(p).gx - ix, (p) => g(p).gz - iz, (p) => s - g(p).gx - g(p).gz];
      for (const plane of planes) { poly = clip(poly, plane); if (poly.length < 3) break; }
      if (poly.length < 3) continue;
      const snapped: (T | ClipPoint)[] = [];
      for (const p of poly) { const c = snap(p); if (snapped[snapped.length - 1] !== c && snapped[0] !== c) snapped.push(c); }
      if (snapped.length >= 3 && Math.abs(signedArea(snapped)) > grid.cellSize * grid.cellSize * 1e-10) pieces.push(snapped);
    }
  }
  return pieces;
}

/** Triangles of one convex piece. Fans from a vertex only when no three consecutive points are
 * collinear (otherwise the skipped edge would leave a T-junction); else from an added centroid. */
export function triangulateConvex<P extends ClipPoint>(piece: readonly P[], centroid: () => P): [P, P, P][] {
  if (piece.length === 3) return [[piece[0], piece[1], piece[2]]];
  const scale = Math.max(...piece.map((p) => Math.abs(p.x) + Math.abs(p.z)), 1);
  const collinear = piece.some((b, k) => {
    const a = piece[(k + piece.length - 1) % piece.length]; const c = piece[(k + 1) % piece.length];
    return Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) <= 1e-12 * scale * scale;
  });
  if (!collinear) return piece.slice(1, -1).map((p, k) => [piece[0], p, piece[k + 2]]);
  const c = centroid();
  return piece.map((p, k) => [c, p, piece[(k + 1) % piece.length]]);
}

/** Exact fit of linear triangles to the rendered terrain + `lift`.
 * 分段线性差的极值只在断点上：边与地形网格线（x、z 两组 + 每格对角线 gx+gz=整数）的交点，
 * 以及三角形内部的地形顶点——全部查一遍是精确最大偏差，不是抽样。 */
export function terrainFit(layout: Pick<CityLayout, "extent" | "terrain">, lift: number) {
  const grid: TerrainGrid = Object.freeze({ cellSize: layout.extent / TERRAIN_SEGMENTS, half: layout.extent / 2 });
  const { cellSize, half: half0 } = grid;
  const heightAt = (x: number, z: number) => terrainSurfaceHeight(layout, x, z) + lift;
  const lineDeviation = (px: number, pz: number, qx: number, qz: number) => {
    const hp = heightAt(px, pz); const hq = heightAt(qx, qz);
    const gx0 = (px + half0) / cellSize; const gz0 = (pz + half0) / cellSize; const gx1 = (qx + half0) / cellSize; const gz1 = (qz + half0) / cellSize;
    let worst = 0;
    const probe = (t: number) => { if (t > 0 && t < 1) worst = Math.max(worst, Math.abs(heightAt(px + (qx - px) * t, pz + (qz - pz) * t) - (hp + (hq - hp) * t))); };
    for (const [g0, g1] of [[gx0, gx1], [gz0, gz1], [gx0 + gz0, gx1 + gz1]]) {
      if (g0 === g1) continue;
      for (let k = Math.ceil(Math.min(g0, g1)); k <= Math.floor(Math.max(g0, g1)); k += 1) probe((k - g0) / (g1 - g0));
    }
    return worst;
  };
  const triangleDeviation = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => {
    let worst = Math.max(lineDeviation(ax, az, bx, bz), lineDeviation(bx, bz, cx, cz), lineDeviation(cx, cz, ax, az));
    const ha = heightAt(ax, az); const hb = heightAt(bx, bz); const hc = heightAt(cx, cz);
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) return worst;
    const i0 = Math.ceil((Math.min(ax, bx, cx) + half0) / cellSize); const i1 = Math.floor((Math.max(ax, bx, cx) + half0) / cellSize);
    const j0 = Math.ceil((Math.min(az, bz, cz) + half0) / cellSize); const j1 = Math.floor((Math.max(az, bz, cz) + half0) / cellSize);
    for (let i = i0; i <= i1; i += 1) for (let j = j0; j <= j1; j += 1) {
      const x = -half0 + i * cellSize; const z = -half0 + j * cellSize;
      const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d; const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d; const wc = 1 - wa - wb;
      if (wa < 0 || wb < 0 || wc < 0) continue;
      worst = Math.max(worst, Math.abs(heightAt(x, z) - (wa * ha + wb * hb + wc * hc)));
    }
    return worst;
  };
  return Object.freeze({ grid, heightAt, lineDeviation, triangleDeviation });
}

/** Conforming version of an arbitrary triangle mesh whose shared vertices are shared objects.
 * Triangles within `tolerance` of the terrain stay as they are; others are clipped along the
 * terrain triangulation; a kept triangle next to a clipped one carries the same crossings on
 * the shared edge (no T-junctions). Returns triangles over original or new points. */
export function conformMesh<V extends ClipPoint>(fit: ReturnType<typeof terrainFit>, tolerance: number, triangles: readonly (readonly [V, V, V])[]) {
  const ids = new Map<ClipPoint, number>(); const id = (p: ClipPoint) => { let i = ids.get(p); if (i === undefined) { i = ids.size; ids.set(p, i); } return i; };
  const edgeKey = (p: ClipPoint, q: ClipPoint) => { const a = id(p); const b = id(q); return a < b ? `${a}:${b}` : `${b}:${a}`; };
  const pass: boolean[] = []; let maxDeviation = 0;
  const clippedEdges = new Set<string>();
  triangles.forEach(([a, b, c], t) => {
    const dev = fit.triangleDeviation(a.x, a.z, b.x, b.z, c.x, c.z);
    pass[t] = dev <= tolerance;
    if (pass[t]) maxDeviation = Math.max(maxDeviation, dev);
    else for (const [p, q] of [[a, b], [b, c], [c, a]]) clippedEdges.add(edgeKey(p, q));
  });
  const out: [ClipPoint, ClipPoint, ClipPoint][] = [];
  const centroidOf = (poly: readonly ClipPoint[]) => () => ({ x: poly.reduce((n, p) => n + p.x, 0) / poly.length, z: poly.reduce((n, p) => n + p.z, 0) / poly.length });
  triangles.forEach((tri, t) => {
    if (!pass[t]) { for (const piece of clipConvexToTerrain(fit.grid, tri)) out.push(...triangulateConvex(piece, centroidOf(piece))); return; }
    const shared = tri.map((p, k) => clippedEdges.has(edgeKey(p, tri[(k + 1) % 3])));
    if (!shared.some(Boolean)) { out.push([tri[0], tri[1], tri[2]]); return; }
    const ring: ClipPoint[] = [];
    tri.forEach((p, k) => { ring.push(p); if (shared[k]) ring.push(...edgeCrossings(fit.grid, p, tri[(k + 1) % 3])); });
    out.push(...triangulateConvex(ring, centroidOf(tri)));
  });
  return { triangles: out, maxDeviation };
}

/** Ear clipping of a simple polygon (either winding). Returns null if the polygon is not simple
 * enough to clip (self-intersecting), so callers can keep their fallback and report it. */
export function earClip<P extends ClipPoint>(polygon: readonly P[]): [P, P, P][] | null {
  const pts = polygon.filter((p, i) => { const q = polygon[(i + 1) % polygon.length]; return p.x !== q.x || p.z !== q.z; });
  if (pts.length < 3) return null;
  const sign = Math.sign(signedArea(pts)) || 1;
  const cross = (a: ClipPoint, b: ClipPoint, c: ClipPoint) => ((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) * sign;
  const inside = (p: ClipPoint, a: ClipPoint, b: ClipPoint, c: ClipPoint) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  const ring = [...pts]; const out: [P, P, P][] = [];
  let guard = ring.length * ring.length;
  while (ring.length > 3 && guard-- > 0) {
    let cut = false;
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[(i + ring.length - 1) % ring.length]; const b = ring[i]; const c = ring[(i + 1) % ring.length];
      if (cross(a, b, c) <= 1e-12) continue;
      if (ring.some((p) => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
      out.push([a, b, c]); ring.splice(i, 1); cut = true; break;
    }
    if (!cut) return null;
  }
  if (ring.length !== 3 || cross(ring[0], ring[1], ring[2]) <= 1e-12) return null;
  out.push([ring[0], ring[1], ring[2]]);
  return out;
}

/** Convex hull (Andrew monotone chain), counter-clockwise, of point objects (kept by identity). */
export function convexHullOf<P extends ClipPoint>(points: readonly P[]): P[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: P[] = []; for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper: P[] = []; for (const p of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
