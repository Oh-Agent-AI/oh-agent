import type { BoundaryLoop } from "./types";

export type BoundaryExtraction = Readonly<{
  status: "complete" | "unresolved";
  reason: "none" | "empty" | "invalid-mesh" | "degenerate" | "non-manifold" | "intersection" | "budget";
  loops: readonly BoundaryLoop[];
}>;
export type BoundaryBudget = Readonly<{ maxTriangles: number; maxBoundaryEdges: number; maxIntersectionTests: number }>;
export const DEFAULT_BOUNDARY_BUDGET: BoundaryBudget = Object.freeze({ maxTriangles: 100000, maxBoundaryEdges: 4000, maxIntersectionTests: 200000 });

/** Exact Float32 XYZ welds within ONE patch. Never welds nearby vertices, merges
 * separate patches, fills holes or infers road portals. All returned edges remain
 * closed until a separate union/portal compiler establishes their semantics. */
export function extractMeshBoundaries(positions: Float32Array, indices: Uint32Array,
  budget: BoundaryBudget = DEFAULT_BOUNDARY_BUDGET): BoundaryExtraction {
  const unresolved = (reason: BoundaryExtraction["reason"]): BoundaryExtraction => Object.freeze({ status: "unresolved", reason, loops: Object.freeze([]) });
  if (![budget.maxTriangles, budget.maxBoundaryEdges, budget.maxIntersectionTests].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("invalid-boundary-budget");
  if (positions.length % 3 || indices.length % 3) return unresolved("invalid-mesh");
  if (!indices.length) return unresolved("empty");
  if (positions.length / 3 > budget.maxTriangles * 3 || indices.length / 3 > budget.maxTriangles) return unresolved("budget");
  const keys = new Map<string, number>(); const remap: number[] = []; const points: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = [positions[i], positions[i + 1], positions[i + 2]];
    if (![x, y, z].every(Number.isFinite)) return unresolved("invalid-mesh");
    const key = `${x}:${y}:${z}`;
    let id = keys.get(key);
    if (id === undefined) { id = points.length; keys.set(key, id); points.push({ x, y, z }); }
    remap.push(id);
  }
  const edges = new Map<string, { a: number; b: number; count: number }>();
  const faces = new Set<string>();
  for (let i = 0; i < indices.length; i += 3) {
    if (indices[i] >= remap.length || indices[i + 1] >= remap.length || indices[i + 2] >= remap.length) return unresolved("invalid-mesh");
    const ids = [remap[indices[i]], remap[indices[i + 1]], remap[indices[i + 2]]];
    const [a, b, c] = ids.map((id) => points[id]);
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    if (!Number.isFinite(ny) || ny <= 0) return unresolved("degenerate");
    const face = [...ids].sort((x, y) => x - y).join(":");
    if (faces.has(face)) return unresolved("non-manifold"); faces.add(face);
    for (let k = 0; k < 3; k++) {
      const a = ids[k]; const b = ids[(k + 1) % 3]; const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const edge = edges.get(key);
      if (!edge) edges.set(key, { a, b, count: 1 });
      else { if (edge.count !== 1 || edge.a !== b || edge.b !== a) return unresolved("non-manifold"); edge.count++; }
    }
  }
  const boundary = [...edges.values()].filter((edge) => edge.count === 1);
  if (!boundary.length) return unresolved("non-manifold");
  if (boundary.length > budget.maxBoundaryEdges) return unresolved("budget");
  const outgoing = new Map<number, number>(); const incoming = new Set<number>();
  for (const edge of boundary) {
    if (outgoing.has(edge.a) || incoming.has(edge.b)) return unresolved("non-manifold");
    outgoing.set(edge.a, edge.b); incoming.add(edge.b);
  }
  for (const id of outgoing.keys()) if (!incoming.has(id)) return unresolved("non-manifold");
  const remaining = new Set(outgoing.keys()); const rings: number[][] = [];
  while (remaining.size) {
    const start = remaining.values().next().value!; let current = start; const ring: number[] = [];
    do {
      if (!remaining.delete(current)) return unresolved("non-manifold");
      ring.push(current); current = outgoing.get(current)!;
    } while (current !== start);
    if (ring.length < 3) return unresolved("degenerate"); rings.push(ring);
  }
  const segments = rings.flatMap((ring, loop) => ring.map((a, k) => ({ a, b: ring[(k + 1) % ring.length], loop, k, length: ring.length })));
  const cross = (a: typeof points[number], b: typeof points[number], c: typeof points[number]) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const on = (a: typeof points[number], b: typeof points[number], c: typeof points[number]) => cross(a, b, c) === 0 && c.x >= Math.min(a.x, b.x) && c.x <= Math.max(a.x, b.x) && c.z >= Math.min(a.z, b.z) && c.z <= Math.max(a.z, b.z);
  // Sweep the longest projected axis. Counting every pair before even checking
  // its bounds exhausted the budget on long, perfectly manifold coastal strips.
  // Retain the same candidate budget: every active-axis pair spends one test,
  // including adjacent edges and pairs later rejected on the other axis.
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for(const s of segments){const p=points[s.a];minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);}
  const axis: "x"|"z"=maxX-minX>=maxZ-minZ?"x":"z";
  const ordered=segments.map(s=>({...s,min:Math.min(points[s.a][axis],points[s.b][axis]),max:Math.max(points[s.a][axis],points[s.b][axis])}))
    .sort((s,t)=>s.min-t.min||s.max-t.max||s.loop-t.loop||s.k-t.k);
  let tests = 0;
  for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
    if(ordered[j].min>ordered[i].max)break;
    if (++tests > budget.maxIntersectionTests) return unresolved("budget");
    const s = ordered[i]; const t = ordered[j];
    if (s.loop === t.loop && (Math.abs(s.k - t.k) === 1 || Math.abs(s.k - t.k) === s.length - 1)) continue;
    const a = points[s.a]; const b = points[s.b]; const c = points[t.a]; const d = points[t.b];
    if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) || Math.max(a.z, b.z) < Math.min(c.z, d.z) || Math.max(c.z, d.z) < Math.min(a.z, b.z)) continue;
    const abC = cross(a, b, c); const abD = cross(a, b, d); const cdA = cross(c, d, a); const cdB = cross(c, d, b);
    if ((abC * abD < 0 && cdA * cdB < 0) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) return unresolved("intersection");
  }
  // Upward triangles have clockwise XZ outer boundaries; hole boundaries reverse.
  const loops = rings.map((ring) => {
    const vertices = ring.map((id) => Object.freeze({ x: points[id].x, z: points[id].z }));
    const origin = vertices[0];
    const area2 = vertices.reduce((sum, p, i) => { const q = vertices[(i + 1) % vertices.length]; return sum + (p.x - origin.x) * (q.z - origin.z) - (q.x - origin.x) * (p.z - origin.z); }, 0);
    return Object.freeze({ hole: area2 > 0, vertices: Object.freeze(vertices), segments: Object.freeze(vertices.map(() => "closed" as const)) });
  });
  if (loops.some((loop) => !loop.hole) === false) return unresolved("non-manifold");
  return Object.freeze({ status: "complete", reason: "none", loops: Object.freeze(loops) });
}
