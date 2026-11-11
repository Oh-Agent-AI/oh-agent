import type { CityAnchorGeometryV1, CityLayoutSnapshotV1, CityLayoutV1 } from "@agent-vitals/city-sdk";
import type { CityLayout, RoadEdge, RoadNode } from "../cityLayout";
import { hashSeed } from "../../cityModel";
import { toMeters } from "../worldScale";

const MAX_SDK_ANCHORS = 20_000;

export type CityLayoutSdkViewV1 = Readonly<{
  layout: CityLayoutV1;
  geometry: ReadonlyMap<string, CityAnchorGeometryV1>;
  roadSegments: readonly Readonly<{ id: string; fromAnchorId: string; toAnchorId: string; checkpointAnchorId: string; lengthMeters: number }>[];
  preferredStartMeters: Readonly<{ x: number; z: number }>;
  seed: number;
  worldRevision: string;
}>;

function isDriveableGroundEdge(edge: RoadEdge): boolean {
  return edge.bridge !== true && (edge.structure === undefined || edge.structure === "ground-road" || edge.structure === "ground-approach") && edge.points.length >= 2;
}

function sdkSafeId(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return value;
  const readable = value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 96) || "id";
  const firstHash = Math.floor(hashSeed(value) * 0x1_0000_0000).toString(16).padStart(8, "0");
  const secondHash = Math.floor(hashSeed(`${value}\u0000city-sdk-id-v1`) * 0x1_0000_0000).toString(16).padStart(8, "0");
  const hash = `${firstHash}${secondHash}`;
  return `x-${readable}:${hash}`;
}

function pointAtFraction(points: readonly Readonly<{ x: number; z: number }>[], fraction: number): Readonly<{ x: number; z: number }> | null {
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index].x - points[index - 1].x;
    const dz = points[index].z - points[index - 1].z;
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length)) return null;
    lengths.push(length); total += length;
  }
  if (total <= 0) return null;
  let remaining = total * fraction;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (remaining <= length || index === lengths.length - 1) {
      const ratio = length === 0 ? 0 : Math.max(0, Math.min(1, remaining / length));
      return { x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
        z: points[index].z + (points[index + 1].z - points[index].z) * ratio };
    }
    remaining -= length;
  }
  return null;
}

function headingAtFraction(points: readonly Readonly<{ x: number; z: number }>[], fraction: number): number | null {
  const segmentLengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.z - points[index].z));
  const total = segmentLengths.reduce((sum, length) => sum + length, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  let remaining = total * fraction;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const length = segmentLengths[index];
    if (length > 0 && (remaining <= length || index === segmentLengths.length - 1)) {
      const dx = points[index + 1].x - points[index].x, dz = points[index + 1].z - points[index].z;
      return Math.atan2(dx, dz);
    }
    remaining -= length;
  }
  return null;
}

/** Projects only road facts that the current City layout marks as ground-drivable.
 * Geometry remains in this trusted adapter; SDK content refers to stable anchor IDs.
 */
export function createCityLayoutSdkView(input: Readonly<{
  layoutId: string;
  worldRevision: string;
  roadNodes: readonly RoadNode[];
  roadEdges: readonly RoadEdge[];
  preferredStart?: Readonly<{ x: number; z: number }>;
  seed?: number;
  groundHeight?: (x: number, z: number) => number;
}>): CityLayoutSdkViewV1 {
  if (!input.layoutId || !input.worldRevision) throw new Error("city-sdk-layout-identity-required");
  const edges = input.roadEdges.filter(isDriveableGroundEdge).slice().sort((a, b) => a.id.localeCompare(b.id));
  const nodeById = new Map(input.roadNodes.map(node => [node.id, node]));
  if (nodeById.size !== input.roadNodes.length) throw new Error("city-sdk-duplicate-road-node-id");
  const connectedNodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (!edge.id || edgeIds.has(edge.id) || !Number.isFinite(edge.width) || edge.width <= 0) throw new Error("city-sdk-invalid-road-edge");
    edgeIds.add(edge.id);
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) throw new Error("city-sdk-road-node-missing");
    connectedNodeIds.add(edge.from); connectedNodeIds.add(edge.to);
  }
  const anchors: CityLayoutV1["anchors"] = [];
  const geometry = new Map<string, CityAnchorGeometryV1>();
  const roadSegments: Array<{ id: string; fromAnchorId: string; toAnchorId: string; checkpointAnchorId: string; lengthMeters: number }> = [];
  const orderedNodes = input.roadNodes.filter(node => connectedNodeIds.has(node.id)).slice().sort((a, b) => a.id.localeCompare(b.id));
  for (const node of orderedNodes) {
    if (!node.id || !Number.isFinite(node.x) || !Number.isFinite(node.z)) throw new Error("city-sdk-invalid-road-node");
    const safeNodeId = sdkSafeId(node.id);
    const id = `road-spawn:${safeNodeId}`;
    const geometryRef = `city-road-node:${safeNodeId}`;
    anchors.push({ id, kind: "spawn", capabilities: ["drive"], geometryRef });
    const y = input.groundHeight?.(node.x, node.z) ?? 0;
    if (!Number.isFinite(y)) throw new Error("city-sdk-invalid-road-node-height");
    geometry.set(geometryRef, { positionMeters: { x: toMeters(node.x), y: toMeters(y), z: toMeters(node.z) } });
  }
  for (const edge of edges) {
    const midpoint = pointAtFraction(edge.points, 0.5);
    const facingRadians = headingAtFraction(edge.points, 0.5);
    if (!midpoint || facingRadians === null) continue;
    const safeEdgeId = sdkSafeId(edge.id);
    const id = `road-checkpoint:${safeEdgeId}`;
    const geometryRef = `city-road-edge:${safeEdgeId}:midpoint`;
    anchors.push({ id, kind: "zone", capabilities: ["drive"], geometryRef });
    const y = input.groundHeight?.(midpoint.x, midpoint.z) ?? 0;
    if (!Number.isFinite(y)) throw new Error("city-sdk-invalid-road-edge-height");
    geometry.set(geometryRef, { positionMeters: { x: toMeters(midpoint.x), y: toMeters(y), z: toMeters(midpoint.z) },
      activationRadiusMeters: Math.max(4, toMeters(edge.width * 0.55)), facingRadians });
    const lengthWorld = edge.points.slice(1).reduce((total, point, index) => total + Math.hypot(point.x - edge.points[index].x, point.z - edge.points[index].z), 0);
    if (lengthWorld > 0 && Number.isFinite(lengthWorld)) roadSegments.push({ id: safeEdgeId, fromAnchorId: `road-spawn:${sdkSafeId(edge.from)}`,
      toAnchorId: `road-spawn:${sdkSafeId(edge.to)}`, checkpointAnchorId: id, lengthMeters: toMeters(lengthWorld) });
  }
  if (anchors.length > MAX_SDK_ANCHORS) throw new Error("city-sdk-anchor-budget-exceeded");
  return Object.freeze({
    layout: Object.freeze({ schemaVersion: 1, id: input.layoutId, coordinateSystem: "city-local-m-v1", anchors: Object.freeze(anchors),
      links: Object.freeze(roadSegments.flatMap(segment => [
        { id: `road-link:${segment.id}:from`, fromAnchorId: segment.fromAnchorId, toAnchorId: segment.checkpointAnchorId, capabilities: ["drive"] as const },
        { id: `road-link:${segment.id}:to`, fromAnchorId: segment.checkpointAnchorId, toAnchorId: segment.toAnchorId, capabilities: ["drive"] as const },
      ])) }) as unknown as CityLayoutV1,
    geometry,
    roadSegments: Object.freeze(roadSegments),
    preferredStartMeters: Object.freeze({ x: toMeters(input.preferredStart?.x ?? 0), z: toMeters(input.preferredStart?.z ?? 0) }),
    seed: input.seed ?? 0,
    worldRevision: input.worldRevision,
  });
}

/**
 * Bounded, immutable anchor catalog for a Creator project. It starts at the
 * nearest trusted road spawn and includes only road checkpoints reachable from
 * that spawn; geometry stays in the City adapter and is never serialized.
 */
export function createCreatorLayoutSnapshot(view: CityLayoutSdkViewV1, maxAnchors = 64): CityLayoutSnapshotV1 {
  if (!Number.isInteger(maxAnchors) || maxAnchors < 2 || maxAnchors > 256) throw new Error("city-sdk-creator-anchor-budget-invalid");
  const byId = new Map(view.layout.anchors.map(anchor => [anchor.id, anchor]));
  const spawns = view.layout.anchors.filter(anchor => anchor.kind === "spawn" && anchor.capabilities.includes("drive"))
    .map(anchor => {
      const point = view.geometry.get(anchor.geometryRef)?.positionMeters;
      return point ? { anchor, distance: Math.hypot(point.x - view.preferredStartMeters.x, point.z - view.preferredStartMeters.z) } : null;
    }).filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => left.distance - right.distance || left.anchor.id.localeCompare(right.anchor.id));
  const first = spawns[0]?.anchor;
  if (!first) throw new Error("city-sdk-creator-spawn-unavailable");
  const adjacency = new Map<string, typeof view.roadSegments[number][]>();
  for (const segment of [...view.roadSegments].sort((a, b) => a.id.localeCompare(b.id))) {
    adjacency.set(segment.fromAnchorId, [...(adjacency.get(segment.fromAnchorId) ?? []), segment]);
    adjacency.set(segment.toAnchorId, [...(adjacency.get(segment.toAnchorId) ?? []), segment]);
  }
  const selected = new Set<string>([first.id]);
  const visited = new Set<string>([first.id]);
  const queue = [first.id];
  while (queue.length > 0 && selected.size < maxAnchors) {
    const nodeId = queue.shift()!;
    for (const segment of adjacency.get(nodeId) ?? []) {
      if (selected.size >= maxAnchors) break;
      if (byId.has(segment.checkpointAnchorId)) selected.add(segment.checkpointAnchorId);
      const other = segment.fromAnchorId === nodeId ? segment.toAnchorId : segment.fromAnchorId;
      if (!visited.has(other) && byId.has(other) && selected.size < maxAnchors) {
        visited.add(other); queue.push(other); selected.add(other);
      }
    }
  }
  const anchors = view.layout.anchors.filter(anchor => selected.has(anchor.id));
  const links = (view.layout.links ?? []).filter(link => selected.has(link.fromAnchorId) && selected.has(link.toAnchorId));
  return Object.freeze({ schemaVersion: 1, worldRevision: view.worldRevision, seed: view.seed,
    layout: Object.freeze({ ...view.layout, anchors: Object.freeze(anchors) as unknown as CityLayoutV1["anchors"], links: Object.freeze(links) }) }) as unknown as CityLayoutSnapshotV1;
}

export type CityCheckpointRaceCourseV1 = Readonly<{
  startAnchorId: string;
  checkpointAnchorIds: readonly string[];
  startPositionMeters: Readonly<{ x: number; z: number }>;
  totalLengthMeters: number;
}>;

/** Finds a short, connected, ground-road course near the layout's preferred start. */
export function selectCheckpointRaceCourse(view: CityLayoutSdkViewV1, checkpointCount = 3): CityCheckpointRaceCourseV1 | null {
  if (!Number.isInteger(checkpointCount) || checkpointCount < 2 || checkpointCount > 8) return null;
  const anchors = new Map(view.layout.anchors.map(anchor => [anchor.id, anchor]));
  const adjacency = new Map<string, typeof view.roadSegments[number][]>();
  for (const segment of view.roadSegments) {
    if (!anchors.has(segment.fromAnchorId) || !anchors.has(segment.toAnchorId) || !anchors.has(segment.checkpointAnchorId)) continue;
    adjacency.set(segment.fromAnchorId, [...(adjacency.get(segment.fromAnchorId) ?? []), segment]);
    adjacency.set(segment.toAnchorId, [...(adjacency.get(segment.toAnchorId) ?? []), segment]);
  }
  const starts = [...adjacency.keys()].map(id => {
    const anchor = anchors.get(id)!;
    const point = view.geometry.get(anchor.geometryRef)?.positionMeters;
    return point ? { id, point, distance: Math.hypot(point.x - view.preferredStartMeters.x, point.z - view.preferredStartMeters.z) } : null;
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null).sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, 64);
  type CourseCandidate = { startAnchorId: string; checkpointAnchorIds: string[]; startPositionMeters: { x: number; z: number }; totalLengthMeters: number; score: number };
  const best: { current: CourseCandidate | null } = { current: null };
  for (const start of starts) {
    const walk = (nodeId: string, visited: Set<string>, path: typeof view.roadSegments[number][], total: number): void => {
      if (path.length === checkpointCount) {
        if (total < 60 || total > 480) return;
        const score = start.distance + Math.abs(total - 210) * 0.2;
        if (!best.current || score < best.current.score || (score === best.current.score && start.id < best.current.startAnchorId)) best.current = {
          startAnchorId: start.id, checkpointAnchorIds: path.map(segment => segment.checkpointAnchorId),
          startPositionMeters: { x: start.point.x, z: start.point.z }, totalLengthMeters: total, score,
        };
        return;
      }
      for (const segment of (adjacency.get(nodeId) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))) {
        const next = segment.fromAnchorId === nodeId ? segment.toAnchorId : segment.fromAnchorId;
        if (visited.has(next)) continue;
        visited.add(next); path.push(segment);
        walk(next, visited, path, total + segment.lengthMeters);
        path.pop(); visited.delete(next);
      }
    };
    walk(start.id, new Set([start.id]), [], 0);
  }
  return best.current ? Object.freeze({ startAnchorId: best.current.startAnchorId, checkpointAnchorIds: Object.freeze(best.current.checkpointAnchorIds),
    startPositionMeters: Object.freeze(best.current.startPositionMeters), totalLengthMeters: best.current.totalLengthMeters }) : null;
}

/** Produces a reproducible identity from the road facts visible to driving games.
 * This is a freshness revision, not a package digest or a security signature.
 */
export function createSdkViewForCityLayout(layout: CityLayout): CityLayoutSdkViewV1 {
  const roadNodes = layout.roadNodes.slice().sort((a, b) => a.id.localeCompare(b.id));
  const roadEdges = layout.roadEdges.slice().sort((a, b) => a.id.localeCompare(b.id));
  const roadFacts = {
    nodes: roadNodes.map(node => [node.id, node.x, node.z]),
    edges: roadEdges.map(edge => [edge.id, edge.from, edge.to, edge.width, edge.bridge ?? false, edge.structure ?? "ground-road", edge.points.map(point => [point.x, point.z])]),
    nodeGroundMeters: roadNodes.map(node => [node.id, toMeters(layout.terrain.height(node.x, node.z))]),
    edgeGroundMeters: roadEdges.map(edge => {
      const midpoint = pointAtFraction(edge.points, 0.5);
      return midpoint ? [edge.id, toMeters(layout.terrain.height(midpoint.x, midpoint.z))] : [edge.id, null];
    }),
  };
  const serializedRoadFacts = JSON.stringify(roadFacts);
  // This is a deterministic freshness identity, not a security digest. Four
  // independently seeded 32-bit lanes reduce accidental collisions as the
  // local Creator layout catalog grows without adding async Web Crypto here.
  const fingerprint = [0, 1, 2, 3].map(lane =>
    Math.floor(hashSeed(`${lane}:${serializedRoadFacts}`) * 0x1_0000_0000).toString(16).padStart(8, "0"),
  ).join("");
  const worldRevision = `city-road-v2:${layout.seed}:${fingerprint}`;
  return createCityLayoutSdkView({
    layoutId: `city-layout-v1:${layout.seed}:${layout.derivedNetworkVersion ?? 0}:${fingerprint}`,
    worldRevision,
    roadNodes,
    roadEdges,
    preferredStart: layout.core,
    seed: layout.seed,
    groundHeight: (x, z) => layout.terrain.height(x, z),
  });
}
