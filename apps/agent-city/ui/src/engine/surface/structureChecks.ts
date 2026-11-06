/** Independent local geometry diagnostics for structural slopes and cross-layer headroom.
 * A complete report is NOT a road release: portals, piers/body collision and continuous
 * footprint validation are separate gates. No mesh sampling or visible-scene raycasts. */
import { buildSurfaceIndex, type SurfaceTriangle } from "./SurfaceIndex";
import type { CitySurfaceCompilation } from "./compileSurface";

type P2 = Readonly<{ x: number; z: number }>;
type P3 = P2 & Readonly<{ y: number }>;
type HeightPlane = Readonly<{ x: number; z: number; c: number }>;
export const STRUCTURE_CHECKS_VERSION = 1;
export type StructureCheckOptions = Readonly<{
  requiredClearance: number;
  maxSlopeRadians: number;
  maxPairs?: number;
  maxCandidates?: number;
}>;
export type StructureWitness = Readonly<{ x: number; z: number; roadY: number; undersideY: number }>;
export type StructureClearance = Readonly<{ obstacleId: string; patchId: string; layerId: string; gap: number; witness: StructureWitness }>;
export type StructureCheckReport = Readonly<{
  checksVersion: number;
  snapshotRevision: string;
  status: "complete" | "unresolved";
  reason: "none" | "invalid-input" | "index" | "budget";
  options: Readonly<{ requiredClearance: number; maxSlopeRadians: number }>;
  pairsTested: number;
  clearances: readonly StructureClearance[];
  lowClearances: readonly StructureClearance[];
  slopes: readonly Readonly<{ patchId: string; radians: number; exceedsLimit: boolean }>[];
}>;
const at = (plane: HeightPlane, p: P2) => plane.x * p.x + plane.z * p.z + plane.c;
function planeOf(a: P3, b: P3, c: P3): HeightPlane | null {
  const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
  const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
  const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(ny) < 1e-12) return null;
  return { x: -nx / ny, z: -nz / ny, c: a.y + nx / ny * a.x + nz / ny * a.z };
}
function clip(poly: readonly P2[], distance: (p: P2) => number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]; const da = distance(a), db = distance(b);
    const insideA = da >= 0, insideB = db >= 0;
    if (insideA) out.push(a);
    if (insideA !== insideB) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}
const cross = (a: P2, b: P2, c: P2) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
function intersectTriangle(poly: readonly P2[], a: P2, b: P2, c: P2): P2[] {
  const sign = Math.sign(cross(a, b, c));
  if (!sign) return [];
  let result = [...poly];
  for (const [p, q] of [[a, b], [b, c], [c, a]]) result = clip(result, (v) => sign * cross(p, q, v));
  return result;
}
const trianglePoints = (t: SurfaceTriangle): readonly [P3, P3, P3] => [
  { x: t.ax, y: t.ay, z: t.az }, { x: t.bx, y: t.by, z: t.bz }, { x: t.cx, y: t.cy, z: t.cz },
];
// boxCorners order: x(-,+), y(0,1), z(-,+). Face orientation is derived from its centre.
const FACES = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
function validBox(points: readonly P3[]): boolean {
  if (points.length !== 8 || points.some((p) => ![p.x, p.y, p.z].every(Number.isFinite))) return false;
  const sub = (a: P3, b: P3) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const axes = [sub(points[4], points[0]), sub(points[2], points[0]), sub(points[1], points[0])];
  const lengths = axes.map((a) => Math.hypot(a.x, a.y, a.z));
  if (lengths.some((n) => n < 1e-9)) return false;
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    const a = axes[i], b = axes[j];
    if (Math.abs(a.x * b.x + a.y * b.y + a.z * b.z) > lengths[i] * lengths[j] * 1e-8) return false;
  }
  const tolerance = Math.max(...lengths, 1) * 1e-8;
  return points.every((p, i) => {
    const expected = { ...points[0] };
    for (let k = 0; k < 3; k++) if (i & (1 << (2 - k))) {
      expected.x += axes[k].x; expected.y += axes[k].y; expected.z += axes[k].z;
    }
    return Math.hypot(p.x - expected.x, p.y - expected.y, p.z - expected.z) <= tolerance;
  });
}

export function checkStructureGeometry(compilation: Pick<CitySurfaceCompilation, "surface" | "obstacles"> & Readonly<{ revision: string }>, options: StructureCheckOptions): StructureCheckReport {
  const maxPairs = options.maxPairs ?? 1_000_000, maxCandidates = options.maxCandidates ?? 8192;
  const clearances = new Map<string, StructureClearance>();
  const slopes: Array<{ patchId: string; radians: number; exceedsLimit: boolean }> = [];
  let pairsTested = 0, queries = 0;
  const result = (reason: StructureCheckReport["reason"]): StructureCheckReport => {
    const values = Object.freeze([...clearances.values()].sort((a, b) => a.obstacleId < b.obstacleId ? -1 : a.obstacleId > b.obstacleId ? 1 : a.patchId < b.patchId ? -1 : a.patchId > b.patchId ? 1 : 0));
    return Object.freeze({ status: reason === "none" ? "complete" : "unresolved", reason, checksVersion: STRUCTURE_CHECKS_VERSION, snapshotRevision: compilation.revision,
      options: Object.freeze({ requiredClearance: options.requiredClearance, maxSlopeRadians: options.maxSlopeRadians }), pairsTested,
      clearances: values, lowClearances: Object.freeze(values.filter((v) => v.gap < options.requiredClearance)),
      slopes: Object.freeze(slopes.map((s) => Object.freeze(s))) });
  };
  if (!compilation.revision || !Number.isFinite(options.requiredClearance) || options.requiredClearance <= 0 || !Number.isFinite(options.maxSlopeRadians) ||
    options.maxSlopeRadians <= 0 || options.maxSlopeRadians >= Math.PI / 2 || !Number.isSafeInteger(maxPairs) || maxPairs < 1 ||
    !Number.isSafeInteger(maxCandidates) || maxCandidates < 1) return result("invalid-input");
  const index = buildSurfaceIndex(compilation.surface);
  if (index.status !== "ready") return result("index");
  const patches = new Map(index.patches.map((p) => [p.id, p]));
  const layers = [...new Set(index.patches.map((p) => p.layerId))].sort();
  for (const p of index.patches) {
    if (!["bridge-deck", "ramp", "expressway-deck"].includes(p.kind)) continue;
    let max = 0;
    for (let triangleIndex = 0; triangleIndex < p.triangleCount; triangleIndex++) {
      const t = index.triangle({ patchId: p.id, triangleIndex });
      if (!t) return result("invalid-input");
      const plane = planeOf(...trianglePoints(t));
      if (!plane) return result("invalid-input");
      max = Math.max(max, Math.atan(Math.hypot(plane.x, plane.z)));
    }
    slopes.push({ patchId: p.id, radians: max, exceedsLimit: max > options.maxSlopeRadians });
  }
  for (const obstacle of compilation.obstacles) {
    if (obstacle.shape !== "box" || !["bridge-deck", "expressway-deck"].includes(obstacle.role)) continue;
    const own = obstacle.surfacePatchId ? patches.get(obstacle.surfacePatchId) : null;
    if (!own || !validBox(obstacle.corners)) return result("invalid-input");
    const corners = obstacle.corners;
    const center = { x: corners.reduce((n, p) => n + p.x, 0) / 8, y: corners.reduce((n, p) => n + p.y, 0) / 8, z: corners.reduce((n, p) => n + p.z, 0) / 8 };
    const lower: Array<{ triangle: readonly [P3, P3, P3]; plane: HeightPlane }> = [], upper: HeightPlane[] = [];
    for (const face of FACES) {
      const [a, b, c, d] = face.map((i) => corners[i]); const plane = planeOf(a, b, c);
      if (!plane) continue; // vertical face has no vertical-ray underside
      const outwardY = at(plane, center) - center.y;
      // The plane through this face: sign of centre's distance determines its outward Y.
      if (outwardY > 0) upper.push(plane);
      else if (outwardY < 0) lower.push({ triangle: [a, b, c], plane }, { triangle: [a, c, d], plane });
    }
    if (!lower.length || !upper.length) return result("invalid-input");
    const minX = Math.min(...corners.map((p) => p.x)), maxX = Math.max(...corners.map((p) => p.x));
    const minZ = Math.min(...corners.map((p) => p.z)), maxZ = Math.max(...corners.map((p) => p.z));
    for (const layerId of layers) {
      if (layerId === own.layerId) continue; // same-layer occlusion/seams are handled by region rules
      if (++queries > maxPairs) return result("budget");
      const found = index.trianglesInBox({ minX, minZ, maxX, maxZ, layerId, maxResults: maxCandidates });
      if (found.status !== "ok") return result(found.status === "budget" ? "budget" : "invalid-input");
      for (const ref of found.triangles) {
        const t = index.triangle(ref); if (!t) return result("invalid-input");
        const points = trianglePoints(t); const road = planeOf(...points); if (!road) return result("invalid-input");
        for (const face of lower) {
          if (++pairsTested > maxPairs) return result("budget");
          const underside = face.plane;
          let overlap = intersectTriangle(points, ...face.triangle);
          // A surface above the solid is not an underpass. Keep only its portion below
          // EVERY upper face; portions inside the slab remain and produce negative gap.
          for (const ceiling of upper) overlap = clip(overlap, (p) => at(ceiling, p) - at(road, p));
          for (const p of overlap) {
            const roadY = at(road, p), undersideY = at(underside, p), gap = undersideY - roadY;
            if (![roadY, undersideY, gap].every(Number.isFinite)) return result("invalid-input");
            const key = JSON.stringify([obstacle.id, ref.patchId]); const previous = clearances.get(key);
            if (!previous || gap < previous.gap) clearances.set(key, Object.freeze({ obstacleId: obstacle.id, patchId: ref.patchId, layerId, gap,
              witness: Object.freeze({ x: p.x, z: p.z, roadY, undersideY }) }));
          }
        }
      }
    }
  }
  return result("none");
}
