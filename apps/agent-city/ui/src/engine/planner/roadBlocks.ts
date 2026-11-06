/** Road-derived, fixed-size frontage parcels. No candidate edge becomes a road here. */
import { EXPRESSWAY_DECK_WIDTH } from "../roadStandard";
import { LOT } from "../worldScale";
import { DetMath as Math } from "../detMath";
import { spendPlanningWork, spendPlanningUnit } from "./operationBudget";
import type { CityBlock, Parcel, RoadEdge, Vec2, Zone } from "../cityLayout";
import type { RoadFace, RoadFaceResult } from "./roadFaces";

export const ROAD_BLOCK_POLICY = { width: LOT.width, depth: LOT.depth, endMargin: 7, centreInset: 12,
  boundaryCentreClearance: 3.6 + 5, roadMargin: 0.5, siteMargin: 9, highwayHalfWidth: EXPRESSWAY_DECK_WIDTH / 2, highwayMargin: 1 } as const;
export type RoadSurfaceExclusion =
  | { kind: "road-corridor" | "highway-corridor"; id: string; points: Vec2[]; width: number }
  | { kind: "site-circle"; id: string; x: number; z: number; radius: number };
export type RoadDerivedBlock = CityBlock & { sourceFaceId: string; holes: Vec2[][]; networkVersion: number;
  surfaceCoverage: "road-width-inset" | "requires-envelope-clipping"; surfaceExclusions: RoadSurfaceExclusion[] };
/** A sampled parcel/shoulder connection, not a model-door or vehicle driveway proof. */
export type ParcelFrontageProof = { parcelId: string; blockId: string; sourceFaceId: string; networkVersion: number;
  scope: "parcel-frontage"; terrainCoverage: "one-unit-sampling"; hostEdgeId: string; hostSegmentIndex: number;
  frontagePoint: Vec2; shoulderPoint: Vec2; roadPoint: Vec2; primaryNodePath: string[]; primaryEdgePath: string[] };
export type RoadBlockInput = { faces: RoadFaceResult; roads: readonly RoadEdge[]; primaryAnchorNodeId: string | null; networkVersion: number;
  districtFor: (point: Vec2) => string; zoneFor: (point: Vec2) => Zone; buildable: (x: number, z: number) => boolean;
  sites: readonly (Vec2 & { radius: number; id?: string })[]; highways: readonly (readonly Vec2[])[];
  /** Existing beach/park/fixed reservation projection. Checked on rectangle and access samples. */
  reserved?: (point: Vec2) => boolean; maxCandidates: number; cancelled?: () => boolean;
  /** False by default: current CityBlock presentation does not consume holes. */
  presentationSupportsHoles?: boolean };
export type RoadBlockReport = { status: "complete" | "unsupported" | "budget-exhausted" | "cancelled";
  faces: number; supportedFaces: number; candidateDenominator: number; evaluated: number; accepted: number; published: number;
  geometryChecks: number; rejected: Record<string, number>; unsupported: { faceId: string; reason: string }[];
  emptyFaces: EmptyRoadFace[]; surfacePending: { faceId: string; reason: string }[]; reasons: string[] };
export type EmptyRoadFace = { faceId: string; reason: "road-width-consumes-face"; capacity: 0;
  evidence: { scope: "bounded-road-halfplane-contradiction"; boundary: Vec2[];
    planes: { edgeId: string; boundaryIndex: number; nx: number; nz: number; minimum: number; roadWidth: number }[];
    weights: number[]; boundedMaximum: number; weightedMinimum: number; contradictionMargin: number } };
export type RoadBlockResult = { blocks: RoadDerivedBlock[]; access: ParcelFrontageProof[]; report: RoadBlockReport };
type Host = { edge: RoadEdge; index: number; a: Vec2; b: Vec2 };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const cross = (a: Vec2, b: Vec2, p: Vec2) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
const distance = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b.x - a.x, dz = b.z - a.z, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
};
const contains = (ring: Vec2[], p: Vec2) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (distance(p, a, b) <= 1e-9) return true;
    if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
};
const convex = (ring: Vec2[]) => ring.length >= 3 && ring.some((a, i) => cross(a, ring[(i + 1) % ring.length], ring[(i + 2) % ring.length]) > 1e-9)
  && ring.every((a, i) => cross(a, ring[(i + 1) % ring.length], ring[(i + 2) % ring.length]) >= -1e-9);
const area = (ring: Vec2[]) => Math.abs(ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p.x * q.z - q.x * p.z; }, 0)) / 2;
const rectangleOverlap = (a: Vec2[], b: Vec2[]) => {
  for (const ring of [a, b]) for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length], nx = -(q.z - p.z), nz = q.x - p.x;
    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (const v of a) { const projection = v.x * nx + v.z * nz; aMin = Math.min(aMin, projection); aMax = Math.max(aMax, projection); }
    for (const v of b) { const projection = v.x * nx + v.z * nz; bMin = Math.min(bMin, projection); bMax = Math.max(bMax, projection); }
    if (aMax <= bMin + 1e-9 || bMax <= aMin + 1e-9) return false;
  }
  return true;
};
const RECTANGLE_INDEX_CELL = 32;
type RectangleBounds = { minX: number; maxX: number; minZ: number; maxZ: number };
const rectangleBounds = (corners: readonly Vec2[]): RectangleBounds => ({
  minX: Math.min(...corners.map(p => p.x)), maxX: Math.max(...corners.map(p => p.x)),
  minZ: Math.min(...corners.map(p => p.z)), maxZ: Math.max(...corners.map(p => p.z)),
});
const rectangleCells = (bounds: RectangleBounds) => {
  const minX = Math.floor(bounds.minX / RECTANGLE_INDEX_CELL), maxX = Math.floor(bounds.maxX / RECTANGLE_INDEX_CELL);
  const minZ = Math.floor(bounds.minZ / RECTANGLE_INDEX_CELL), maxZ = Math.floor(bounds.maxZ / RECTANGLE_INDEX_CELL);
  const keys: string[] = [];
  for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) keys.push(`${x}:${z}`);
  return keys;
};
const segmentGap = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) => {
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  return Math.min(distance(a, c, d), distance(b, c, d), distance(c, a, b), distance(d, a, b));
};
const bounds = (ring: Vec2[]) => ({ left: Math.min(...ring.map(p => p.x)), right: Math.max(...ring.map(p => p.x)), north: Math.min(...ring.map(p => p.z)), south: Math.max(...ring.map(p => p.z)) });

/** Convex ring intersection of displaced true road halfplanes; negative offsets expand holes. */
function inset(ring: Vec2[], offsets: number[]): Vec2[] {
  let result = ring.map(p => ({ ...p }));
  // Outward expansion: exact feasible shifted-line intersections, no arbitrary bounding box.
  if (offsets.some(x => x < 0)) {
    const lines = ring.map((a, i) => { const b = ring[(i + 1) % ring.length], nx = -(b.z - a.z), nz = b.x - a.x;
      return { nx, nz, limit: nx * a.x + nz * a.z + offsets[i] * Math.hypot(nx, nz) }; });
    const vertices: Vec2[] = [];
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j], determinant = a.nx * b.nz - a.nz * b.nx;
      if (determinant === 0) continue;
      const p = { x: (a.limit * b.nz - a.nz * b.limit) / determinant, z: (a.nx * b.limit - a.limit * b.nx) / determinant };
      if ([p.x, p.z].every(Number.isFinite) && lines.every(l => l.nx * p.x + l.nz * p.z >= l.limit - 1e-7)
        && !vertices.some(q => Math.hypot(q.x - p.x, q.z - p.z) < 1e-9)) vertices.push(p);
    }
    if (vertices.length < 3) return [];
    const centre = { x: vertices.reduce((sum, p) => sum + p.x, 0) / vertices.length, z: vertices.reduce((sum, p) => sum + p.z, 0) / vertices.length };
    return vertices.sort((a, b) => Math.atan2(a.z - centre.z, a.x - centre.x) - Math.atan2(b.z - centre.z, b.x - centre.x));
  }
  for (let side = 0; side < ring.length && result.length; side++) {
    const a = ring[side], b = ring[(side + 1) % ring.length], limit = offsets[side] * Math.hypot(b.x - a.x, b.z - a.z), next: Vec2[] = [];
    for (let i = 0; i < result.length; i++) {
      const p = result[i], q = result[(i + 1) % result.length], dp = cross(a, b, p) - limit, dq = cross(a, b, q) - limit;
      if (dp >= 0) next.push(p);
      if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); next.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t }); }
    }
    result = next;
  }
  return result;
}

/** Positive sums of road inset constraints contradict every point in the original bounded face. */
function emptyCertificate(face: RoadFace, hosts: Host[]): EmptyRoadFace | null {
  const planes = face.boundary.map((a, i) => { const b = face.boundary[(i + 1) % face.boundary.length], nx = -(b.z - a.z), nz = b.x - a.x;
    return { edgeId: hosts[i].edge.id, boundaryIndex: i, nx, nz,
      minimum: nx * a.x + nz * a.z + (hosts[i].edge.width / 2 + ROAD_BLOCK_POLICY.roadMargin) * Math.hypot(nx, nz), roadWidth: hosts[i].edge.width }; });
  const certify = (indices: number[], values: number[]): EmptyRoadFace | null => {
    if (!values.every(Number.isFinite) || values.some(w => w < 0) || !values.some(w => w > 0)) return null;
    const scale = Math.max(...values), weights = planes.map(() => 0);
    indices.forEach((index, i) => { weights[index] = values[i] / scale; });
    let nx = 0, nz = 0, weightedMinimum = 0;
    planes.forEach((p, i) => { nx += p.nx * weights[i]; nz += p.nz * weights[i]; weightedMinimum += p.minimum * weights[i]; });
    const boundedMaximum = Math.max(...face.boundary.map(p => p.x * nx + p.z * nz)), contradictionMargin = weightedMinimum - boundedMaximum;
    if (![boundedMaximum, weightedMinimum, contradictionMargin].every(Number.isFinite) || contradictionMargin <= 1e-9) return null;
    return { faceId: face.id, reason: "road-width-consumes-face", capacity: 0, evidence: {
      scope: "bounded-road-halfplane-contradiction", boundary: face.boundary.map(p => ({ ...p })), planes, weights, boundedMaximum, weightedMinimum, contradictionMargin } };
  };
  for (let i = 0; i < planes.length; i++) { const found = certify([i], [1]); if (found) return found; }
  for (let i = 0; i < planes.length; i++) for (let j = i + 1; j < planes.length; j++) {
    const a = planes[i], b = planes[j], found = certify([i, j], [Math.hypot(b.nx, b.nz), Math.hypot(a.nx, a.nz)]); if (found) return found;
    for (let k = j + 1; k < planes.length; k++) {
      const c = planes[k], values = [b.nx * c.nz - b.nz * c.nx, c.nx * a.nz - c.nz * a.nx, a.nx * b.nz - a.nz * b.nx];
      const sign = values.every(v => v <= 0) ? -1 : 1, found = certify([i, j, k], values.map(v => v * sign)); if (found) return found;
    }
  }
  return null;
}

export function generateRoadBlocks(input: RoadBlockInput): RoadBlockResult {
  const report: RoadBlockReport = { status: "complete", faces: input.faces.faces.length, supportedFaces: 0, candidateDenominator: 0,
    evaluated: 0, accepted: 0, published: 0, geometryChecks: 0, rejected: {}, unsupported: [], emptyFaces: [], surfacePending: [], reasons: [] };
  const empty = (status: RoadBlockReport["status"], reason: string): RoadBlockResult => { report.status = status; report.reasons.push(reason); return { blocks: [], access: [], report }; };
  if (!Number.isSafeInteger(input.networkVersion) || input.networkVersion < 0 || !Number.isSafeInteger(input.maxCandidates) || input.maxCandidates < 0) return empty("unsupported", "invalid-version-or-budget");
  if (input.faces.issues.length) return empty("unsupported", "road-faces-have-unresolved-topology");
  if (input.cancelled?.()) return empty("cancelled", "cancelled-before-generation");
  const roads = [...input.roads].sort((a, b) => compare(a.id, b.id)), hosts: Host[] = [];
  if (new Set(roads.map(edge => edge.id)).size !== roads.length) return empty("unsupported", "duplicate-road-identity");
  for (const edge of roads) {
    if (!edge.id || !edge.from || !edge.to || edge.points.length < 2 || !Number.isFinite(edge.width) || edge.width <= 0 || edge.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.z))) return empty("unsupported", "invalid-road-envelope");
    if (!edge.bridge && edge.structure !== "deck") for (let i = 1; i < edge.points.length; i++) hosts.push({ edge, index: i - 1, a: edge.points[i - 1], b: edge.points[i] });
  }
  if (input.sites.some(site => ![site.x, site.z, site.radius].every(Number.isFinite) || site.radius < 0)) return empty("unsupported", "invalid-site-envelope");
  if (input.highways.some(run => run.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.z)))) return empty("unsupported", "invalid-highway-envelope");
  const adjacent = new Map<string, { to: string; edge: string }[]>();
  for (const edge of roads) { for (const [from, to] of [[edge.from, edge.to], [edge.to, edge.from]]) { const out = adjacent.get(from) ?? []; out.push({ to, edge: edge.id }); adjacent.set(from, out); } }
  for (const out of adjacent.values()) out.sort((a, b) => compare(a.edge, b.edge) || compare(a.to, b.to));
  const parent = new Map<string, { node: string; edge: string }>(), root = input.primaryAnchorNodeId;
  if (!root || !adjacent.has(root)) return empty("unsupported", "primary-anchor-missing");
  const reached = new Set([root]), queue = [root];
  for (let i = 0; i < queue.length; i++) for (const next of adjacent.get(queue[i]) ?? []) if (!reached.has(next.to)) { reached.add(next.to); parent.set(next.to, { node: queue[i], edge: next.edge }); queue.push(next.to); }
  const hostFor = (a: Vec2, b: Vec2) => hosts.filter(h => distance(a, h.a, h.b) <= 1e-7 && distance(b, h.a, h.b) <= 1e-7)
    .sort((h, k) => k.edge.width - h.edge.width || compare(h.edge.id, k.edge.id) || h.index - k.index)[0];
  const prepared: { face: RoadFace; polygon: Vec2[]; holes: Vec2[][]; outerConvex: boolean; sides: { a: Vec2; b: Vec2; count: number }[] }[] = [];
  for (const face of [...input.faces.faces].sort((a, b) => compare(a.id, b.id))) {
    if (input.cancelled?.()) return empty("cancelled", "cancelled-during-face-preparation");
    const rejectFace = (reason: string) => report.unsupported.push({ faceId: face.id, reason });
    if (face.holes.length && input.presentationSupportsHoles !== true) { rejectFace("hole-presentation-unsupported"); continue; }
    const outerConvex = convex(face.boundary);
    const outerHosts = face.boundary.map((a, i) => hostFor(a, face.boundary[(i + 1) % face.boundary.length]));
    const holeRings = face.holes.map(hole => [...hole].reverse()), holeHosts = holeRings.map(hole => hole.map((a, i) => hostFor(a, hole[(i + 1) % hole.length])));
    if (outerHosts.some(h => !h) || holeHosts.some(list => list.some(h => !h))) { rejectFace("boundary-not-backed-by-accepted-road"); continue; }
    const polygon = outerConvex ? inset(face.boundary, outerHosts.map(h => h!.edge.width / 2 + ROAD_BLOCK_POLICY.roadMargin)) : face.boundary.map(p => ({ ...p }));
    const holes = holeRings.map((ring, i) => convex(ring) ? inset(ring, holeHosts[i].map(h => -h!.edge.width / 2 - ROAD_BLOCK_POLICY.roadMargin)) : ring.map(p => ({ ...p })));
    if (polygon.length < 3 || area(polygon) <= 0) {
      const certificate = outerConvex ? emptyCertificate(face, outerHosts as Host[]) : null;
      if (certificate) report.emptyFaces.push(certificate); else rejectFace("empty-inset-without-contradiction-evidence");
      continue;
    }
    if (holes.some(hole => hole.length < 3)) { rejectFace("invalid-expanded-hole"); continue; }
    if (holes.some(hole => hole.some(p => !contains(polygon, p)) || hole.some((a, i) => polygon.some((b, j) => segmentGap(a, hole[(i + 1) % hole.length], b, polygon[(j + 1) % polygon.length]) <= 1e-9))) || holes.some((hole, i) => holes.slice(i + 1).some(other => hole.some(p => contains(other, p)) || other.some(p => contains(hole, p))
      || hole.some((a, j) => other.some((b, k) => segmentGap(a, hole[(j + 1) % hole.length], b, other[(k + 1) % other.length]) === 0))))) {
      rejectFace("expanded-hole-overlaps-boundary-or-hole"); continue;
    }
    // Merge collinear split nodes for row density; do not treat a T split as an extra frontage row.
    const simple = face.boundary.filter((p, i, ring) => Math.abs(cross(ring[(i + ring.length - 1) % ring.length], p, ring[(i + 1) % ring.length])) > 1e-9);
    const lengths = simple.map((a, i) => Math.hypot(simple[(i + 1) % simple.length].x - a.x, simple[(i + 1) % simple.length].z - a.z));
    let front = 0; for (let i = 1; i < lengths.length; i++) if (lengths[i] > lengths[front]) front = i;
    const sideIds = outerConvex && simple.length === 4 ? [front, (front + 2) % 4] : [front];
    const sides: { a: Vec2; b: Vec2; count: number }[] = [];
    for (const i of sideIds) {
      const a = simple[i], b = simple[(i + 1) % simple.length], count = Math.max(0, Math.floor((lengths[i] - 2 * ROAD_BLOCK_POLICY.endMargin) / ROAD_BLOCK_POLICY.width));
      // Each slot later resolves its actual split host without increasing row density.
      sides.push({ a, b, count }); report.candidateDenominator += count;
    }
    prepared.push({ face, polygon, holes, outerConvex, sides }); report.supportedFaces += 1;
  }
  const blocks: RoadDerivedBlock[] = [], access: ParcelFrontageProof[] = [], acceptedRectangles: Vec2[][] = [];
  const acceptedBounds: RectangleBounds[] = [], rectangleGrid = new Map<string, number[]>(), visitedRectangles: number[] = [];
  let overlapQuery = 0;
  const overlapsAcceptedRectangle = (corners: Vec2[]): boolean => {
    const bounds = rectangleBounds(corners), query = ++overlapQuery;
    for (const cell of rectangleCells(bounds)) for (const index of rectangleGrid.get(cell) ?? []) {
      if (visitedRectangles[index] === query) continue;
      visitedRectangles[index] = query;
      const other = acceptedBounds[index];
      if (bounds.maxX < other.minX - 1e-9 || other.maxX < bounds.minX - 1e-9
        || bounds.maxZ < other.minZ - 1e-9 || other.maxZ < bounds.minZ - 1e-9) continue;
      if (rectangleOverlap(corners, acceptedRectangles[index])) return true;
    }
    return false;
  };
  const indexAcceptedRectangle = (corners: Vec2[]) => {
    const index = acceptedRectangles.length, bounds = rectangleBounds(corners);
    acceptedRectangles.push(corners); acceptedBounds.push(bounds);
    for (const cell of rectangleCells(bounds)) {
      const entries = rectangleGrid.get(cell);
      if (entries) entries.push(index); else rectangleGrid.set(cell, [index]);
    }
  };
  const reject = (reason: string) => { report.rejected[reason] = (report.rejected[reason] ?? 0) + 1; };
  const checkedBuildable = (p: Vec2) => { spendPlanningUnit("parcel:terrain-query", "terrainSample"); report.geometryChecks += 1; return input.buildable(p.x, p.z) && !input.reserved?.(p); };
  const sampleLine = (a: Vec2, b: Vec2) => { const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z))); for (let i = 0; i <= count; i++) if (!checkedBuildable({ x: a.x + (b.x - a.x) * i / count, z: a.z + (b.z - a.z) * i / count })) return false; return true; };
  const parcelRadius = Math.hypot(ROAD_BLOCK_POLICY.width, ROAD_BLOCK_POLICY.depth) / 2;
  for (const item of prepared) {
    const box = bounds(item.polygon), centre = { x: (box.left + box.right) / 2, z: (box.north + box.south) / 2 }, id = `road-block:${item.face.id}`;
    const zone = input.zoneFor(centre), districtId = input.districtFor(centre), parcels: Parcel[] = [];
    for (let side = 0; side < item.sides.length; side++) {
      const row = item.sides[side], length = Math.hypot(row.b.x - row.a.x, row.b.z - row.a.z), tangent = { x: (row.b.x - row.a.x) / length, z: (row.b.z - row.a.z) / length }, normal = { x: -tangent.z, z: tangent.x };
      for (let index = 0; index < row.count; index++) {
        if (input.cancelled?.()) return empty("cancelled", "cancelled-during-generation");
        if (report.evaluated >= input.maxCandidates) return empty("budget-exhausted", "candidate-budget-exhausted");
        spendPlanningWork("parcel:candidate", { candidate: 1 });
        report.evaluated += 1;
        const along = ROAD_BLOCK_POLICY.endMargin + (length - 2 * ROAD_BLOCK_POLICY.endMargin) * (index + 0.5) / row.count;
        const roadPoint = { x: row.a.x + tangent.x * along, z: row.a.z + tangent.z * along };
        const host = hosts.filter(h => distance(roadPoint, h.a, h.b) <= 1e-7 && Math.abs(cross(row.a, row.b, h.a)) < 1e-7 && Math.abs(cross(row.a, row.b, h.b)) < 1e-7)
          .sort((a, b) => b.edge.width - a.edge.width || compare(a.edge.id, b.edge.id) || a.index - b.index)[0];
        if (!host || !reached.has(host.edge.from)) { reject("frontage-not-on-primary-network"); continue; }
        const insetDistance = Math.max(ROAD_BLOCK_POLICY.centreInset, host.edge.width / 2 + ROAD_BLOCK_POLICY.roadMargin + parcelRadius);
        const p = { x: roadPoint.x + normal.x * insetDistance, z: roadPoint.z + normal.z * insetDistance };
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([w, d]) => ({ x: p.x + tangent.x * w * ROAD_BLOCK_POLICY.width / 2 + normal.x * d * ROAD_BLOCK_POLICY.depth / 2,
          z: p.z + tangent.z * w * ROAD_BLOCK_POLICY.width / 2 + normal.z * d * ROAD_BLOCK_POLICY.depth / 2 }));
        if (!contains(item.polygon, p) || item.face.boundary.some((a, i) => distance(p, a, item.face.boundary[(i + 1) % item.face.boundary.length]) < ROAD_BLOCK_POLICY.boundaryCentreClearance - 1e-9)
          || corners.some(c => !contains(item.polygon, c))
          || corners.some((a, i) => item.polygon.some((b, j) => segmentGap(a, corners[(i + 1) % corners.length], b, item.polygon[(j + 1) % item.polygon.length]) <= 1e-9))) { reject("rectangle-outside-inset-face"); continue; }
        if (item.holes.some(hole => contains(hole, p) || hole.some((a, i) => distance(p, a, hole[(i + 1) % hole.length]) < parcelRadius))) { reject("rectangle-overlaps-hole"); continue; }
        if (input.sites.some(site => Math.hypot(p.x - site.x, p.z - site.z) < site.radius + ROAD_BLOCK_POLICY.siteMargin)) { reject("site-reservation-clearance"); continue; }
        if (roads.some(edge => edge.points.slice(1).some((b, i) => { report.geometryChecks += 1; return distance(p, edge.points[i], b) < parcelRadius + edge.width / 2 + ROAD_BLOCK_POLICY.roadMargin; }))) { reject("actual-road-envelope-clearance"); continue; }
        if (input.highways.some(run => run.slice(1).some((b, i) => distance(p, run[i], b) < ROAD_BLOCK_POLICY.highwayHalfWidth + parcelRadius + ROAD_BLOCK_POLICY.highwayMargin))) { reject("highway-clearance"); continue; }
        // Finite resolution is explicit in the proof; it is not full model/terrain certification.
        let terrainOK = true;
        for (let w = 0; w <= 8 && terrainOK; w++) for (let d = 0; d <= 8; d++) if (!checkedBuildable({ x: p.x + tangent.x * (-3.6 + 7.2 * w / 8) + normal.x * (-4 + d), z: p.z + tangent.z * (-3.6 + 7.2 * w / 8) + normal.z * (-4 + d) })) { terrainOK = false; break; }
        if (!terrainOK || corners.some((c, i) => !sampleLine(c, corners[(i + 1) % corners.length]))) { reject("rectangle-terrain-or-reserve"); continue; }
        const frontagePoint = { x: p.x - normal.x * ROAD_BLOCK_POLICY.depth / 2, z: p.z - normal.z * ROAD_BLOCK_POLICY.depth / 2 }, shoulderPoint = { x: roadPoint.x + normal.x * host.edge.width / 2, z: roadPoint.z + normal.z * host.edge.width / 2 };
        if (!contains(item.face.boundary, frontagePoint) || !contains(item.face.boundary, shoulderPoint)
          || item.face.boundary.some((a, i) => segmentGap(frontagePoint, shoulderPoint, a, item.face.boundary[(i + 1) % item.face.boundary.length]) === 0)
          || !sampleLine(frontagePoint, shoulderPoint) || input.sites.some(site => distance(site, frontagePoint, shoulderPoint) < site.radius)
          || hosts.some(h => h.edge.id !== host.edge.id && segmentGap(frontagePoint, shoulderPoint, h.a, h.b) < h.edge.width / 2)
          || input.highways.some(run => run.slice(1).some((b, i) => segmentGap(frontagePoint, shoulderPoint, run[i], b) < ROAD_BLOCK_POLICY.highwayHalfWidth + ROAD_BLOCK_POLICY.highwayMargin))) { reject("frontage-corridor-blocked"); continue; }
        if (overlapsAcceptedRectangle(corners)) { reject("parcel-overlap"); continue; }
        const parcelId = `${id}/${side}:${index}`;
        spendPlanningWork("parcel:derived-row", { derivedRow: 1 });
        parcels.push({ ...p, id: parcelId, blockId: id, yaw: -Math.atan2(tangent.z, tangent.x), zone, width: ROAD_BLOCK_POLICY.width, depth: ROAD_BLOCK_POLICY.depth });
        indexAcceptedRectangle(corners);
        const primaryNodePath = [host.edge.from], primaryEdgePath: string[] = []; let node = host.edge.from;
        while (node !== root) { const next = parent.get(node)!; primaryEdgePath.push(next.edge); primaryNodePath.push(next.node); node = next.node; }
        access.push({ parcelId, blockId: id, sourceFaceId: item.face.id, networkVersion: input.networkVersion, scope: "parcel-frontage", terrainCoverage: "one-unit-sampling",
          hostEdgeId: host.edge.id, hostSegmentIndex: host.index, frontagePoint, shoulderPoint, roadPoint, primaryNodePath, primaryEdgePath }); report.accepted += 1;
      }
    }
    if (input.cancelled?.()) return empty("cancelled", "cancelled-before-surface-exclusions");
    const nearBox = (points: readonly Vec2[], radius: number) => points.some((p, i) => { const q = points[i ? i - 1 : 0];
      return Math.max(p.x, q.x) + radius >= box.left && Math.min(p.x, q.x) - radius <= box.right
        && Math.max(p.z, q.z) + radius >= box.north && Math.min(p.z, q.z) - radius <= box.south; });
    const surfaceExclusions: RoadSurfaceExclusion[] = [];
    for (const edge of roads) if (nearBox(edge.points, edge.width / 2 + ROAD_BLOCK_POLICY.roadMargin)) surfaceExclusions.push({ kind: "road-corridor", id: edge.id, points: edge.points.map(p => ({ ...p })), width: edge.width + 2 * ROAD_BLOCK_POLICY.roadMargin });
    input.sites.forEach((site, i) => { if (site.x + site.radius >= box.left && site.x - site.radius <= box.right && site.z + site.radius >= box.north && site.z - site.radius <= box.south)
      surfaceExclusions.push({ kind: "site-circle", id: site.id ?? `site:${i}`, x: site.x, z: site.z, radius: site.radius }); });
    input.highways.forEach((run, i) => { if (nearBox(run, ROAD_BLOCK_POLICY.highwayHalfWidth + ROAD_BLOCK_POLICY.highwayMargin)) surfaceExclusions.push({ kind: "highway-corridor", id: `highway:${i}`, points: run.map(p => ({ ...p })), width: 2 * (ROAD_BLOCK_POLICY.highwayHalfWidth + ROAD_BLOCK_POLICY.highwayMargin) }); });
    const surfaceCoverage = !item.outerConvex || surfaceExclusions.length ? "requires-envelope-clipping" : "road-width-inset";
    if (surfaceCoverage === "requires-envelope-clipping") report.surfacePending.push({ faceId: item.face.id, reason: "surface-consumer-must-subtract-declared-envelopes" });
    blocks.push({ ...centre, id, districtId, width: box.right - box.left, depth: box.south - box.north, zone, polygon: item.polygon.map(p => ({ ...p })),
      holes: item.holes.map(hole => hole.map(p => ({ ...p })).reverse()), sourceFaceId: item.face.id, networkVersion: input.networkVersion, surfaceCoverage, surfaceExclusions, parcels });
  }
  if (input.cancelled?.()) return empty("cancelled", "cancelled-before-publish");
  report.published = report.accepted;
  if (report.unsupported.length) report.status = "unsupported";
  return { blocks, access, report };
}
