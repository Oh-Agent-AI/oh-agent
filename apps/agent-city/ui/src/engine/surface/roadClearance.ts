/** Distance from a point to the nearest ordinary ground carriageway (negative inside it). CPU-only.
 * Scenery placers use it to keep solids off real roads; it is the same render-edge set and junction
 * plan the road compiler draws (bridges and decks excluded — they have their own clearance rules).
 * 只量边的矩形带不够：锐角路口的转角扇面能伸出节点 30 多（90/1 真机：街景立面落在这样一块扇面上，
 * 离最近的边带还有 6.5），所以转角扇面与渐变段轮廓也算路面。 */
import type { RoadEdge, Vec2 } from "../cityLayout";
import { cornerArc, renderRoadEdges, roadJunctionPlan, taperOutline } from "../cityRoadJunctions";

type Seg = { a: Vec2; b: Vec2; half: number; minX: number; maxX: number; minZ: number; maxZ: number };
type Poly = { points: Vec2[]; minX: number; maxX: number; minZ: number; maxZ: number };
type Ground = { edges: RoadEdge[]; polygons: Vec2[][]; segs: Seg[]; polys: Poly[]; cells: Map<string, { segs: number[]; polys: number[] }>; cell: number };
const cache = new WeakMap<object, Ground>();
const CELL = 40;

function addCell(cells: Ground["cells"], key: string, kind: "segs" | "polys", index: number) {
  let bucket = cells.get(key);
  if (!bucket) { bucket = { segs: [], polys: [] }; cells.set(key, bucket); }
  bucket[kind].push(index);
}

function groundOf(roadEdges: readonly RoadEdge[]): Ground {
  let ground = cache.get(roadEdges);
  if (ground) return ground;
  const rendered = renderRoadEdges(roadEdges as RoadEdge[]);
  const polygons: Vec2[][] = [];
  for (const junction of roadJunctionPlan(rendered)) {
    const node = { x: junction.x, z: junction.z };
    for (const corner of junction.corners) polygons.push([node, ...cornerArc(corner, 0)]);
    if (junction.taper) polygons.push(taperOutline(junction, 0));
  }
  const edges = rendered.filter((e) => !e.bridge && e.structure !== "deck");
  const segs: Seg[] = [];
  const polys: Poly[] = [];
  const cells = new Map<string, { segs: number[]; polys: number[] }>();
  for (const edge of edges) {
    const half = edge.width / 2;
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1], b = edge.points[i];
      const minX = Math.min(a.x, b.x) - half, maxX = Math.max(a.x, b.x) + half;
      const minZ = Math.min(a.z, b.z) - half, maxZ = Math.max(a.z, b.z) + half;
      const index = segs.length;
      segs.push({ a, b, half, minX, maxX, minZ, maxZ });
      for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx += 1)
        for (let gz = Math.floor(minZ / CELL); gz <= Math.floor(maxZ / CELL); gz += 1) addCell(cells, `${gx}:${gz}`, "segs", index);
    }
  }
  for (const points of polygons) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const index = polys.length;
    polys.push({ points, minX, maxX, minZ, maxZ });
    for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx += 1)
      for (let gz = Math.floor(minZ / CELL); gz <= Math.floor(maxZ / CELL); gz += 1) addCell(cells, `${gx}:${gz}`, "polys", index);
  }
  ground = { edges, polygons, segs, polys, cells, cell: CELL };
  cache.set(roadEdges, ground);
  return ground;
}

function segmentDistance(x: number, z: number, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dz = b.z - a.z, ll = dx * dx + dz * dz;
  const t = ll === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / ll));
  return Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
}

function polygonClearance(points: Vec2[], x: number, z: number): number {
  let inside = false, edgeDistance = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[j], b = points[i];
    if ((a.z > z) !== (b.z > z) && x < a.x + ((z - a.z) * (b.x - a.x)) / (b.z - a.z)) inside = !inside;
    edgeDistance = Math.min(edgeDistance, segmentDistance(x, z, a, b));
  }
  return inside ? -edgeDistance : edgeDistance;
}

/** Optional `closerThan`: occupancy only tests `< 0.5` and can stop at the first hit.
 * Callers that need the true minimum (railings, landmark siting) omit it. */
export function groundRoadClearance(roadEdges: readonly RoadEdge[] | undefined, x: number, z: number, closerThan = Infinity): number {
  if (!Array.isArray(roadEdges)) return Infinity;
  const ground = groundOf(roadEdges);
  const cx = Math.floor(x / ground.cell), cz = Math.floor(z / ground.cell);
  let best = Infinity;
  const seenSeg = new Set<number>(), seenPoly = new Set<number>();
  const considerSeg = (seg: Seg) => {
    const pad = Number.isFinite(best) ? Math.min(Math.abs(best), closerThan) : closerThan;
    if (Number.isFinite(pad) && (seg.maxX < x - pad || seg.minX > x + pad || seg.maxZ < z - pad || seg.minZ > z + pad)) return;
    best = Math.min(best, segmentDistance(x, z, seg.a, seg.b) - seg.half);
  };
  const considerPoly = (poly: Poly) => {
    const pad = Number.isFinite(best) ? Math.min(Math.abs(best), closerThan) : closerThan;
    if (Number.isFinite(pad) && (poly.maxX < x - pad || poly.minX > x + pad || poly.maxZ < z - pad || poly.minZ > z + pad)) return;
    best = Math.min(best, polygonClearance(poly.points, x, z));
  };
  for (let reach = 0; reach <= 48; reach += 1) {
    for (let gx = cx - reach; gx <= cx + reach; gx += 1) for (let gz = cz - reach; gz <= cz + reach; gz += 1) {
      if (reach > 0 && gx !== cx - reach && gx !== cx + reach && gz !== cz - reach && gz !== cz + reach) continue;
      const bucket = ground.cells.get(`${gx}:${gz}`);
      if (!bucket) continue;
      for (const index of bucket.segs) { if (seenSeg.has(index)) continue; seenSeg.add(index); considerSeg(ground.segs[index]); }
      for (const index of bucket.polys) { if (seenPoly.has(index)) continue; seenPoly.add(index); considerPoly(ground.polys[index]); }
      if (Number.isFinite(closerThan) && best < closerThan) return best;
    }
    // Anything outside this ring is at least `reach * cell` away in chebyshev distance.
    if (Number.isFinite(best) && Math.abs(best) <= reach * ground.cell) return best;
    if (Number.isFinite(closerThan) && (reach + 1) * ground.cell >= closerThan + 36) return best;
  }
  return best;
}
