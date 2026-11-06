import type { CompiledCitySurface, SurfaceKind } from "./types";

export type SurfaceQueryHit = Readonly<{
  patchId: string;
  triangleIndex: number;
  kind: SurfaceKind;
  sourceId: string;
  layerId: string;
  point: Readonly<{ x: number; y: number; z: number }>;
  normal: Readonly<{ x: number; y: number; z: number }>;
}>;
export type SurfacePointQuery = Readonly<{
  x: number;
  z: number;
  /** A query must name a layer; projection overlap never picks a layer implicitly. */
  layerId: string;
  /** Defaults to road/deck surfaces and excludes sidewalks, islands and decor. */
  kinds?: readonly SurfaceKind[];
}>;
export type SurfaceQueryResult =
  | Readonly<{ status: "hit"; revision: string; hit: SurfaceQueryHit }>
  | Readonly<{ status: "miss"; revision: string }>
  | Readonly<{ status: "ambiguous"; revision: string; candidates: readonly SurfaceQueryHit[] }>
  | Readonly<{ status: "budget" | "invalid-input"; revision: string }>;
export type SurfaceIndexBudget = Readonly<{
  cellSize: number;
  maxTriangles: number;
  maxBuckets: number;
  maxEntries: number;
  /** Cells a triangle actually overlaps (exact 2D SAT), not its AABB area. */
  maxCellsPerTriangle: number;
  /** Bounded AABB scan per triangle; caps build CPU for one oversized triangle. */
  maxScanCellsPerTriangle: number;
  maxCandidatesPerQuery: number;
}>;
export const DEFAULT_SURFACE_INDEX_BUDGET: SurfaceIndexBudget = Object.freeze({
  cellSize: 8,
  maxTriangles: 1_000_000,
  maxBuckets: 1_000_000,
  maxEntries: 4_000_000,
  maxCellsPerTriangle: 256,
  maxScanCellsPerTriangle: 65_536,
  maxCandidatesPerQuery: 512,
});

type TriangleRef = Readonly<{ patch: number; triangle: number }>;
type CapturedPatch = Readonly<{
  id: string; kind: SurfaceKind; sourceId: string; layerId: string;
  vertices: Float32Array; indices: Uint32Array;
}>;
export type SurfaceTriangleRef = Readonly<{ patchId: string; triangleIndex: number }>;
export type SurfacePatchInfo = Readonly<{ id: string; kind: SurfaceKind; sourceId: string; layerId: string; triangleCount: number }>;
/** Captured float coordinates of one triangle, in index order (upward XZ winding). */
export type SurfaceTriangle = Readonly<{ ax: number; ay: number; az: number; bx: number; by: number; bz: number; cx: number; cy: number; cz: number }>;
export type SurfaceBoxQuery = Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number; layerId: string; kinds?: readonly SurfaceKind[]; maxResults: number }>;
export type SurfaceBoxResult = Readonly<{ status: "ok"; triangles: readonly SurfaceTriangleRef[] }> | Readonly<{ status: "budget" | "invalid-input" }>;
export type SurfaceIndexBuild =
  | Readonly<{ status: "ready"; revision: string; triangleCount: number; bucketCount: number; entryCount: number;
      query: (request: SurfacePointQuery) => SurfaceQueryResult;
      /** Broad-phase triangle refs whose cells touch the box; callers do their own exact test. */
      trianglesInBox: (request: SurfaceBoxQuery) => SurfaceBoxResult;
      triangle: (ref: SurfaceTriangleRef) => SurfaceTriangle | null;
      patches: readonly SurfacePatchInfo[] }>
  | Readonly<{ status: "unresolved"; reason: "invalid-input" | "triangle-budget" | "entry-budget" | "bucket-budget" | "triangle-span-budget" }>;

const bucketKey = (x: number, z: number): string => `${x}:${z}`;
const DEFAULT_QUERY_KINDS: readonly SurfaceKind[] = Object.freeze(["carriageway", "junction", "bridge-deck", "ramp", "expressway-deck"]);
const ALL_KINDS: readonly SurfaceKind[] = Object.freeze(["carriageway", "junction", "bridge-deck", "ramp", "expressway-deck", "sidewalk", "island", "decor"]);
/** Closed 2D separating-axis test of a triangle against an axis-aligned cell.
 * Touching counts as overlap, so a point on a cell border always finds its triangle. */
function triangleTouchesCell(ax: number, az: number, bx: number, bz: number, cx: number, cz: number,
  minX: number, minZ: number, maxX: number, maxZ: number): boolean {
  const corners = [minX, minZ, maxX, minZ, maxX, maxZ, minX, maxZ];
  const edges = [ax, az, bx, bz, bx, bz, cx, cz, cx, cz, ax, az];
  for (let e = 0; e < 12; e += 4) {
    const nx = edges[e + 3] - edges[e + 1]; const nz = edges[e] - edges[e + 2];
    const t0 = nx * ax + nz * az; const t1 = nx * bx + nz * bz; const t2 = nx * cx + nz * cz;
    const triMin = Math.min(t0, t1, t2); const triMax = Math.max(t0, t1, t2);
    let boxMin = Infinity; let boxMax = -Infinity;
    for (let k = 0; k < 8; k += 2) { const v = nx * corners[k] + nz * corners[k + 1]; boxMin = Math.min(boxMin, v); boxMax = Math.max(boxMax, v); }
    // Relative slack: float rounding must never drop a covering triangle.
    const slack = 1e-9 * (Math.abs(triMin) + Math.abs(triMax) + 1);
    if (boxMax < triMin - slack || boxMin > triMax + slack) return false;
  }
  return true;
}

/** Builds a bounded XZ broad phase over an owned copy of the current geometry.
 * It answers point candidates only: footprint coverage, portals, collisions and
 * road eligibility remain separate checks. */
export function buildSurfaceIndex(snapshot: CompiledCitySurface,
  budget: SurfaceIndexBudget = DEFAULT_SURFACE_INDEX_BUDGET): SurfaceIndexBuild {
  const fail = (reason: Extract<SurfaceIndexBuild, { status: "unresolved" }>["reason"]): SurfaceIndexBuild => Object.freeze({ status: "unresolved", reason });
  if (![budget.cellSize, budget.maxTriangles, budget.maxBuckets, budget.maxEntries, budget.maxCellsPerTriangle, budget.maxScanCellsPerTriangle, budget.maxCandidatesPerQuery]
    .every(Number.isSafeInteger) || budget.cellSize <= 0 || budget.maxTriangles <= 0 || budget.maxBuckets <= 0 || budget.maxEntries <= 0 || budget.maxCellsPerTriangle <= 0 || budget.maxScanCellsPerTriangle <= 0 || budget.maxCandidatesPerQuery <= 0 ||
    typeof snapshot.revision !== "string" || !snapshot.revision) return fail("invalid-input");

  const patches: CapturedPatch[] = [];
  const patchIds = new Set<string>();
  let triangleCount = 0;
  for (const patch of snapshot.patches) {
    if (!patch.id || patchIds.has(patch.id) || !patch.layerId || !patch.source?.id || patch.vertices.length % 3 || patch.indices.length % 3) return fail("invalid-input");
    patchIds.add(patch.id);
    triangleCount += patch.indices.length / 3;
    if (!Number.isSafeInteger(triangleCount) || triangleCount > budget.maxTriangles) return fail("triangle-budget");
    patches.push(Object.freeze({ id: patch.id, kind: patch.kind, sourceId: patch.source.id, layerId: patch.layerId,
      vertices: patch.vertices.slice(), indices: patch.indices.slice() }));
  }

  const buckets = new Map<string, TriangleRef[]>();
  let entryCount = 0;
  for (let patchIndex = 0; patchIndex < patches.length; patchIndex++) {
    const patch = patches[patchIndex];
    for (let triangle = 0; triangle < patch.indices.length / 3; triangle++) {
      const ia = patch.indices[triangle * 3]; const ib = patch.indices[triangle * 3 + 1]; const ic = patch.indices[triangle * 3 + 2];
      if (ia * 3 + 2 >= patch.vertices.length || ib * 3 + 2 >= patch.vertices.length || ic * 3 + 2 >= patch.vertices.length) return fail("invalid-input");
      const ax = patch.vertices[ia * 3]; const ay = patch.vertices[ia * 3 + 1]; const az = patch.vertices[ia * 3 + 2];
      const bx = patch.vertices[ib * 3]; const by = patch.vertices[ib * 3 + 1]; const bz = patch.vertices[ib * 3 + 2];
      const cx = patch.vertices[ic * 3]; const cy = patch.vertices[ic * 3 + 1]; const cz = patch.vertices[ic * 3 + 2];
      if (![ax, ay, az, bx, by, bz, cx, cy, cz].every(Number.isFinite)) return fail("invalid-input");
      const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      const normalY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      if (!Number.isFinite(area) || area >= -1e-9 || normalY <= 1e-9) return fail("invalid-input");
      const minX = Math.floor(Math.min(ax, bx, cx) / budget.cellSize); const maxX = Math.floor(Math.max(ax, bx, cx) / budget.cellSize);
      const minZ = Math.floor(Math.min(az, bz, cz) / budget.cellSize); const maxZ = Math.floor(Math.max(az, bz, cz) / budget.cellSize);
      if (![minX, maxX, minZ, maxZ].every(Number.isSafeInteger)) return fail("invalid-input");
      // AABB cell counts made one long diagonal flat road (seed 42 tier 2) exceed
      // the per-triangle budget although it overlaps few cells. Scan is bounded;
      // the budget applies to the cells the triangle really touches.
      const span = (maxX - minX + 1) * (maxZ - minZ + 1);
      if (!Number.isSafeInteger(span) || span > budget.maxScanCellsPerTriangle) return fail("triangle-span-budget");
      const ref = Object.freeze({ patch: patchIndex, triangle });
      let touched = 0;
      for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
        if (span > 1 && !triangleTouchesCell(ax, az, bx, bz, cx, cz, x * budget.cellSize, z * budget.cellSize, (x + 1) * budget.cellSize, (z + 1) * budget.cellSize)) continue;
        if (++touched > budget.maxCellsPerTriangle) return fail("triangle-span-budget");
        const key = bucketKey(x, z);
        let bucket = buckets.get(key);
        if (!bucket) {
          if (buckets.size >= budget.maxBuckets) return fail("bucket-budget");
          bucket = []; buckets.set(key, bucket);
        }
        if (entryCount >= budget.maxEntries) return fail("entry-budget");
        bucket.push(ref); entryCount++;
      }
    }
  }

  const revision = snapshot.revision;
  const query = (request: SurfacePointQuery): SurfaceQueryResult => {
    const { x, z, layerId } = request;
    if (!Number.isFinite(x) || !Number.isFinite(z) || !layerId) return Object.freeze({ status: "invalid-input", revision });
    const kinds = new Set(request.kinds ?? DEFAULT_QUERY_KINDS);
    if (!kinds.size || [...kinds].some((kind) => !ALL_KINDS.includes(kind))) {
      return Object.freeze({ status: "invalid-input", revision });
    }
    const bucket = buckets.get(bucketKey(Math.floor(x / budget.cellSize), Math.floor(z / budget.cellSize))) ?? [];
    if (bucket.length > budget.maxCandidatesPerQuery) return Object.freeze({ status: "budget", revision });
    const hits: SurfaceQueryHit[] = [];
    const seen = new Set<string>();
    for (const ref of bucket) {
      const patch = patches[ref.patch];
      if (patch.layerId !== layerId || !kinds.has(patch.kind)) continue;
      const triangleKey = `${ref.patch}:${ref.triangle}`;
      if (seen.has(triangleKey)) continue;
      seen.add(triangleKey);
      const offset = ref.triangle * 3;
      const ia = patch.indices[offset] * 3; const ib = patch.indices[offset + 1] * 3; const ic = patch.indices[offset + 2] * 3;
      const ax = patch.vertices[ia]; const ay = patch.vertices[ia + 1]; const az = patch.vertices[ia + 2];
      const bx = patch.vertices[ib]; const by = patch.vertices[ib + 1]; const bz = patch.vertices[ib + 2];
      const cx = patch.vertices[ic]; const cy = patch.vertices[ic + 1]; const cz = patch.vertices[ic + 2];
      const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
      const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator;
      const wc = 1 - wa - wb;
      const epsilon = 1e-7;
      if (wa < -epsilon || wb < -epsilon || wc < -epsilon || wa > 1 + epsilon || wb > 1 + epsilon || wc > 1 + epsilon) continue;
      // Geometric normal (b−a)×(c−a); its y equals the build-time upward check. The A3 draft
      // permuted components, so every flat road reported a horizontal (0,0,±1) normal.
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const length = Math.hypot(nx, ny, nz);
      if (!Number.isFinite(length) || length < 1e-9) return Object.freeze({ status: "invalid-input", revision });
      hits.push(Object.freeze({ patchId: patch.id, triangleIndex: ref.triangle, kind: patch.kind, sourceId: patch.sourceId, layerId,
        point: Object.freeze({ x, y: wa * ay + wb * by + wc * cy, z }),
        normal: Object.freeze({ x: nx / length, y: ny / length, z: nz / length }) }));
    }
    if (!hits.length) return Object.freeze({ status: "miss", revision });
    hits.sort((a, b) => a.patchId.localeCompare(b.patchId) || a.triangleIndex - b.triangleIndex);
    const patchIds = new Set(hits.map((hit) => hit.patchId));
    if (patchIds.size > 1) return Object.freeze({ status: "ambiguous", revision, candidates: Object.freeze(hits) });
    const heights = hits.map((hit) => hit.point.y);
    if (Math.max(...heights) - Math.min(...heights) > 0.02) return Object.freeze({ status: "ambiguous", revision, candidates: Object.freeze(hits) });
    return Object.freeze({ status: "hit", revision, hit: hits[0] });
  };

  const patchByIdIndex = new Map(patches.map((patch, i) => [patch.id, i]));
  const trianglesInBox = (request: SurfaceBoxQuery): SurfaceBoxResult => {
    const { minX, minZ, maxX, maxZ, layerId, maxResults } = request;
    if (![minX, minZ, maxX, maxZ].every(Number.isFinite) || minX > maxX || minZ > maxZ || !layerId || !Number.isSafeInteger(maxResults) || maxResults < 1) return Object.freeze({ status: "invalid-input" });
    const kinds = new Set(request.kinds ?? ALL_KINDS);
    if (!kinds.size || [...kinds].some((kind) => !ALL_KINDS.includes(kind))) return Object.freeze({ status: "invalid-input" });
    const x0 = Math.floor(minX / budget.cellSize); const x1 = Math.floor(maxX / budget.cellSize);
    const z0 = Math.floor(minZ / budget.cellSize); const z1 = Math.floor(maxZ / budget.cellSize);
    if (![x0, x1, z0, z1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (z1 - z0 + 1) > budget.maxScanCellsPerTriangle) return Object.freeze({ status: "budget" });
    const seen = new Set<number>(); const out: SurfaceTriangleRef[] = [];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      for (const ref of buckets.get(bucketKey(x, z)) ?? []) {
        const patch = patches[ref.patch];
        if (patch.layerId !== layerId || !kinds.has(patch.kind)) continue;
        const key = ref.patch * 4_294_967_296 + ref.triangle;
        if (seen.has(key)) continue; seen.add(key);
        if (out.length >= maxResults) return Object.freeze({ status: "budget" });
        out.push(Object.freeze({ patchId: patch.id, triangleIndex: ref.triangle }));
      }
    }
    out.sort((a, b) => a.patchId < b.patchId ? -1 : a.patchId > b.patchId ? 1 : a.triangleIndex - b.triangleIndex);
    return Object.freeze({ status: "ok", triangles: Object.freeze(out) });
  };
  const triangle = (ref: SurfaceTriangleRef): SurfaceTriangle | null => {
    const at = patchByIdIndex.get(ref.patchId);
    if (at === undefined || !Number.isSafeInteger(ref.triangleIndex) || ref.triangleIndex < 0) return null;
    const patch = patches[at]; const offset = ref.triangleIndex * 3;
    if (offset + 2 >= patch.indices.length) return null;
    const ia = patch.indices[offset] * 3; const ib = patch.indices[offset + 1] * 3; const ic = patch.indices[offset + 2] * 3;
    const v = patch.vertices;
    return Object.freeze({ ax: v[ia], ay: v[ia + 1], az: v[ia + 2], bx: v[ib], by: v[ib + 1], bz: v[ib + 2], cx: v[ic], cy: v[ic + 1], cz: v[ic + 2] });
  };
  const patchInfo = Object.freeze(patches.map((patch) => Object.freeze({ id: patch.id, kind: patch.kind, sourceId: patch.sourceId, layerId: patch.layerId, triangleCount: patch.indices.length / 3 })));
  return Object.freeze({ status: "ready", revision, triangleCount, bucketCount: buckets.size, entryCount, query, trianglesInBox, triangle, patches: patchInfo });
}
