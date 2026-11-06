/** Formal spawn derivation and admission. Diagnostic/UAT entry remains separate. */
import { RELEASED_DRIVING_GRAPH_VERSION, type ReleasedDrivingGraph, type ReleasedUnitBoundaryEvidence } from "./audit/ReleasedDrivingGraph";
import type { ReadyCitySurfaceCapture } from "../../engine/surface/citySurfacePort";
import { buildSurfaceIndex } from "../../engine/surface/SurfaceIndex";
import { buildSurfaceRegions } from "../../engine/surface/surfaceRegions";
import { compileCitySolidInputs } from "../../engine/surface/compileCitySolidInputs";
import type { CollisionDimensions } from "./CollisionIndex";
import { CITY_SOLID_COMPILER_VERSION } from "./staticSolidContracts";
import { SurfaceDrivingEnvironment } from "./SurfaceDrivingWorld";

export const DRIVING_SPAWN_SCHEMA_VERSION = 1;
export const SPAWN_BORDER_MARGIN = 2;
export const SPAWN_TANGENT_LIMIT_RAD = Math.PI / 4;
export const SPAWN_BOUNDARY_POLICY_VERSION = 1;
const CENTERLINE_TOLERANCE = 0.25;

export type DrivingSpawnSpecV1 = Readonly<{
  schemaVersion: 1;
  worldRevision: string;
  vehicleConfigHash: string;
  spawns: ReadonlyArray<Readonly<{
    id: string;
    sourceUnitId: string;
    x: number; z: number; heading: number;
    layerId: string;
    regionId?: string;
    requireTangentAlign?: boolean;
  }>>;
}>;

export type SpawnValidationWorld = Readonly<{
  capture: Pick<ReadyCitySurfaceCapture, "readWorld" | "isLeaseCurrent"> & { worldRevision: string };
  graph: ReleasedDrivingGraph;
  /** Graph lease freshness must be checked along with the static-world lease. */
  isGraphCurrent: () => boolean;
}>;

export type SpawnRejection =
  | "schema-version" | "world-revision-mismatch" | "vehicle-config-mismatch" | "stale-world" | "stale-graph"
  | "graph-world-mismatch" | "graph-boundary-unavailable" | "no-open-graph" | "empty-spec" | "invalid-spec"
  | "duplicate-spawn-id" | "surface-index" | "surface-regions" | "scene-solids-over-budget"
  | "spawn-unknown-region" | "spawn-region-mismatch" | "spawn-not-drivable" | "spawn-unsafe-body"
  | "spawn-off-open-graph" | "spawn-unknown-layer" | "spawn-near-border" | "spawn-tangent-misaligned"
  | "spawn-geometry-unavailable";

export type SpawnValidation = Readonly<{ ok: true; spec: DrivingSpawnSpecV1; credentials: readonly VerifiedSpawnCredential[] }>
  | Readonly<{ ok: false; reason: SpawnRejection; detail?: string; spawnId?: string }>;

export type SpawnPointValidation = Readonly<{ id: string }>
  & ({ ok: true; x: number; z: number; heading: number; layerId: string; regionId: string; credential?: VerifiedSpawnCredential }
    | { ok: false; reason: SpawnRejection });

const credentialSeal = Symbol("verified-spawn-credential");
const wholeSpecValidationSeal = Symbol("whole-spec-validation");
const issuedCredentials = new WeakSet<object>();
export type VerifiedSpawnCredential = Readonly<{
  spawnId: string; sourceUnitId: string; x: number; z: number; heading: number; layerId: string; regionId: string;
  worldRevision: string; graphBoundaryHash: string; vehicleConfigHash: string;
  collider: Readonly<{ dimensions: CollisionDimensions; centerHeight: number }>;
  isFresh(): boolean;
  readonly [credentialSeal]: true;
}>;
export function isVerifiedSpawnCredential(value: unknown): value is VerifiedSpawnCredential {
  return typeof value === "object" && value !== null && issuedCredentials.has(value as object);
}
function issueCredential(input: Omit<VerifiedSpawnCredential, typeof credentialSeal>): VerifiedSpawnCredential {
  const credential = Object.freeze({ ...input, [credentialSeal]: true as const });
  issuedCredentials.add(credential);
  return credential;
}

/** Stable midpoint candidate from passed directed-edge evidence. The halfWidth is
 * retained for diagnostics only; it never substitutes for a boundary-distance test. */
export function deriveSpawnCandidates(
  graph: ReleasedDrivingGraph,
  layerOf: (unitId: string) => string,
): ReadonlyArray<Readonly<{ id: string; sourceUnitId: string; x: number; z: number; heading: number; layerId: string }>> {
  const out: Array<{ id: string; sourceUnitId: string; x: number; z: number; heading: number; layerId: string }> = [];
  const geometryByUnit = new Map(graph.geometry.map((entry) => [entry.unitId, entry]));
  for (const unit of graph.units) {
    if (unit.status !== "passed" || unit.kind !== "directed-edge") continue;
    const geometry = geometryByUnit.get(unit.unitId);
    if (!geometry || geometry.waypoints.length < 2 || !usableBoundaryEvidence(geometry.boundaryEvidence, graph, unit.unitId)) continue;
    const points = geometry.waypoints;
    let total = 0; const cumulative = [0];
    for (let index = 1; index < points.length; index += 1) {
      total += Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
      cumulative.push(total);
    }
    if (!(total > 0)) continue;
    const target = total / 2; let index = 1;
    while (index < cumulative.length - 1 && cumulative[index] < target) index += 1;
    const span = cumulative[index] - cumulative[index - 1] || 1;
    const t = (target - cumulative[index - 1]) / span;
    const a = points[index - 1], b = points[index];
    out.push({ id: `spawn:${unit.unitId}`, sourceUnitId: unit.unitId,
      x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
      heading: Math.atan2(b.z - a.z, b.x - a.x), layerId: layerOf(unit.unitId) });
  }
  return Object.freeze(out.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function usableBoundaryEvidence(evidence: ReleasedUnitBoundaryEvidence | undefined, graph: ReleasedDrivingGraph, unitId: string): evidence is ReleasedUnitBoundaryEvidence {
  return !!evidence && evidence.version === SPAWN_BOUNDARY_POLICY_VERSION && evidence.unitId === unitId &&
    evidence.finalBoundaryHash === graph.releaseBoundaryHash && evidence.releasePolicyVersion === graph.key.releasePolicyVersion &&
    evidence.collisionCompilerVersion === CITY_SOLID_COMPILER_VERSION && evidence.collisionQueryVersion === graph.key.queryVersion &&
    evidence.finalReplayPassed === true && evidence.fenceEnforced === true && evidence.segments.length > 0 &&
    evidence.segments.every((segment) => [segment.ax, segment.az, segment.bx, segment.bz].every(Number.isFinite) &&
      Math.hypot(segment.bx - segment.ax, segment.bz - segment.az) > 0);
}

function pointSegmentDistance(x: number, z: number, a: Readonly<{ x: number; z: number }>, b: Readonly<{ x: number; z: number }>): Readonly<{ distance: number; heading: number }> {
  const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
  if (!(length2 > 0)) return { distance: Infinity, heading: NaN };
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / length2));
  return { distance: Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)), heading: Math.atan2(dz, dx) };
}
function angleDistance(a: number, b: number): number { return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))); }
function distanceToBoundary(x: number, z: number, segments: ReleasedUnitBoundaryEvidence["segments"]): number {
  let best = Infinity;
  for (const segment of segments) {
    const dx = segment.bx - segment.ax, dz = segment.bz - segment.az, length2 = dx * dx + dz * dz;
    if (!(length2 > 0)) return NaN;
    const t = Math.max(0, Math.min(1, ((x - segment.ax) * dx + (z - segment.az) * dz) / length2));
    best = Math.min(best, Math.hypot(x - (segment.ax + dx * t), z - (segment.az + dz * t)));
  }
  return best;
}

/** Full-table verification. A valid result contains per-point, non-persisted proof
 * objects; any invalid member rejects the whole table with its spawn ID. */
export async function validateSpawnSpec(
  world: SpawnValidationWorld,
  spec: DrivingSpawnSpecV1,
  dimensions: CollisionDimensions,
  centerHeight: number,
): Promise<SpawnValidation> {
  const fail = (reason: SpawnRejection, detail?: string, spawnId?: string): SpawnValidation => ({ ok: false, reason, detail, spawnId });
  const current = () => world.capture.isLeaseCurrent() && world.isGraphCurrent();
  if (spec.schemaVersion !== DRIVING_SPAWN_SCHEMA_VERSION) return fail("schema-version");
  if (spec.worldRevision !== world.capture.worldRevision) return fail("world-revision-mismatch");
  if (!world.capture.isLeaseCurrent()) return fail("stale-world");
  if (!world.isGraphCurrent()) return fail("stale-graph");
  if (world.graph.graphVersion !== RELEASED_DRIVING_GRAPH_VERSION) return fail("graph-boundary-unavailable");
  if (world.graph.key.baseSnapshotHash !== world.capture.worldRevision) return fail("graph-world-mismatch");
  if (spec.vehicleConfigHash !== world.graph.key.vehicleConfigHash) return fail("vehicle-config-mismatch");
  if (!world.graph.releaseBoundaryHash || world.graph.key.releaseBoundaryHash !== world.graph.releaseBoundaryHash) return fail("graph-boundary-unavailable");
  const open = new Set(world.graph.units.filter((u) => u.status === "passed" && u.kind === "directed-edge").map((u) => u.unitId));
  if (!open.size) return fail("no-open-graph");
  if (!Array.isArray(spec.spawns) || spec.spawns.length === 0) return fail("empty-spec");
  if (!spec.vehicleConfigHash || !Number.isFinite(centerHeight) || centerHeight < 0 ||
    ![dimensions.halfLength, dimensions.halfWidth, dimensions.halfHeight].every((n) => Number.isFinite(n) && n > 0)) return fail("invalid-spec");
  const ids = new Set<string>();
  for (const spawn of spec.spawns) {
    if (!spawn || typeof spawn.id !== "string" || !spawn.id.trim() || !spawn.sourceUnitId || !spawn.layerId ||
      ![spawn.x, spawn.z, spawn.heading].every(Number.isFinite)) return fail("invalid-spec", undefined, spawn?.id);
    if (ids.has(spawn.id)) return fail("duplicate-spawn-id", undefined, spawn.id);
    ids.add(spawn.id);
  }
  const snapshot = world.capture.readWorld();
  if (!snapshot || snapshot.revision !== world.capture.worldRevision || !current()) return fail("stale-world");
  const surfaceIndex = buildSurfaceIndex(snapshot.surface);
  if (surfaceIndex.status !== "ready") return fail("surface-index", surfaceIndex.reason);
  const regions = buildSurfaceRegions(snapshot.surface, surfaceIndex);
  if (regions.status !== "ready") return fail("surface-regions", regions.reason);
  const compiled = compileCitySolidInputs(snapshot);
  if (compiled.status !== "ready") return fail("scene-solids-over-budget", compiled.reason);
  const collisionIndex = compiled.collisionIndex;
  if (collisionIndex.revision !== world.capture.worldRevision) return fail("graph-world-mismatch");
  const environment = new SurfaceDrivingEnvironment(regions, undefined, undefined, {
    coverage: "structures-only", surfaceRevision: snapshot.surface.revision, worldRevision: world.capture.worldRevision,
    index: collisionIndex, dimensions, centerHeight, isCurrent: world.capture.isLeaseCurrent,
  });
  const validatedCollider = Object.freeze({ dimensions: Object.freeze({ ...dimensions }), centerHeight });
  const geometry = new Map(world.graph.geometry.map((entry) => [entry.unitId, entry]));
  const credentials: VerifiedSpawnCredential[] = [];
  for (const spawn of spec.spawns) {
    const result = validateSpawnPoint(environment, spawn, { snapshot, regions, geometry, open, graph: world.graph,
      capture: world.capture, isGraphCurrent: world.isGraphCurrent, dimensions: validatedCollider.dimensions, centerHeight,
      collider: validatedCollider, vehicleConfigHash: spec.vehicleConfigHash, [wholeSpecValidationSeal]: true });
    if (!result.ok) return fail(result.reason, undefined, spawn.id);
    if (!result.credential) return fail("spawn-geometry-unavailable", undefined, spawn.id);
    credentials.push(result.credential);
  }
  if (!world.capture.isLeaseCurrent() || !world.capture.readWorld()) return fail("stale-world");
  if (!world.isGraphCurrent()) return fail("stale-graph");
  return Object.freeze({ ok: true, spec, credentials: Object.freeze(credentials) });
}

type PointContext = Readonly<{
  readonly [wholeSpecValidationSeal]: true;
  snapshot: NonNullable<ReturnType<ReadyCitySurfaceCapture["readWorld"]>>;
  regions: Extract<ReturnType<typeof buildSurfaceRegions>, { status: "ready" }>;
  geometry: ReadonlyMap<string, ReleasedDrivingGraph["geometry"][number]>;
  open: ReadonlySet<string>; graph: ReleasedDrivingGraph;
  capture: SpawnValidationWorld["capture"]; isGraphCurrent: () => boolean;
  dimensions: CollisionDimensions; centerHeight: number;
  collider: VerifiedSpawnCredential["collider"]; vehicleConfigHash: string;
}>;

/** Also exported for focused diagnostic checks; only validateSpawnSpec issues credentials. */
export function validateSpawnPoint(
  environment: SurfaceDrivingEnvironment,
  spawn: DrivingSpawnSpecV1["spawns"][number],
  context?: PointContext,
): SpawnPointValidation {
  const reject = (reason: SpawnRejection): SpawnPointValidation => ({ id: spawn.id, ok: false, reason });
  if (context && !context.snapshot.surface.patches.some((patch) => patch.layerId === spawn.layerId)) return reject("spawn-unknown-layer");
  const regionId = environment.regionAt(spawn.x, spawn.z, spawn.layerId);
  if (!regionId) return reject("spawn-not-drivable");
  if (spawn.regionId && spawn.regionId !== regionId) return reject("spawn-region-mismatch");
  if (!environment.place(spawn.x, spawn.z, spawn.heading, regionId)) return reject("spawn-unsafe-body");
  if (!context) return { id: spawn.id, ok: true, x: spawn.x, z: spawn.z, heading: spawn.heading, layerId: spawn.layerId, regionId };
  if (!context.open.has(spawn.sourceUnitId)) return reject("spawn-off-open-graph");
  const path = context.geometry.get(spawn.sourceUnitId);
  if (!path || path.waypoints.length < 2 || path.surfaceRegionIds.length === 0) return reject("spawn-geometry-unavailable");
  const boundaryProof = path.boundaryEvidence;
  if (!usableBoundaryEvidence(boundaryProof, context.graph, spawn.sourceUnitId) ||
    boundaryProof.layerId !== spawn.layerId || boundaryProof.finalBoundaryHash !== context.graph.releaseBoundaryHash ||
    boundaryProof.releasePolicyVersion !== context.graph.key.releasePolicyVersion) return reject("spawn-geometry-unavailable");
  const region = context.regions.regionById(regionId);
  if (!region || !region.layerIds.includes(spawn.layerId)) return reject("spawn-unknown-layer");
  const currentPatchIds = new Set(context.snapshot.surface.patches.map((patch) => patch.id));
  const pathRegions = path.surfaceRegionIds.map((id) => context.regions.regionById(id));
  if (pathRegions.some((entry) => !entry || entry.patchIds.some((id) => !currentPatchIds.has(id))) ||
    !path.surfaceRegionIds.includes(regionId) || !region.patchIds.length ||
    !region.patchIds.some((id) => context.snapshot.surface.patches.some((patch) => patch.id === id && patch.layerId === spawn.layerId))) {
    return reject("spawn-unknown-layer");
  }
  let closest = { distance: Infinity, heading: NaN };
  for (let i = 1; i < path.waypoints.length; i += 1) {
    const candidate = pointSegmentDistance(spawn.x, spawn.z, path.waypoints[i - 1], path.waypoints[i]);
    if (candidate.distance < closest.distance) closest = candidate;
  }
  if (!Number.isFinite(closest.distance)) return reject("spawn-geometry-unavailable");
  if (closest.distance > CENTERLINE_TOLERANCE) return reject("spawn-off-open-graph");
  if (spawn.requireTangentAlign !== false && angleDistance(spawn.heading, closest.heading) > SPAWN_TANGENT_LIMIT_RAD) return reject("spawn-tangent-misaligned");
  const clearance = distanceToBoundary(spawn.x, spawn.z, boundaryProof.segments);
  if (!Number.isFinite(clearance)) return reject("spawn-geometry-unavailable");
  if (clearance < SPAWN_BORDER_MARGIN) return reject("spawn-near-border");
  if (!context.capture.isLeaseCurrent() || !context.isGraphCurrent()) return reject("stale-world");
  const credential = context[wholeSpecValidationSeal] ? issueCredential({ spawnId: spawn.id, sourceUnitId: spawn.sourceUnitId, x: spawn.x, z: spawn.z,
    heading: spawn.heading, layerId: spawn.layerId, regionId, worldRevision: context.capture.worldRevision,
    graphBoundaryHash: context.graph.releaseBoundaryHash, vehicleConfigHash: context.vehicleConfigHash,
    collider: Object.freeze({ dimensions: Object.freeze({ ...context.collider.dimensions }), centerHeight: context.collider.centerHeight }),
    isFresh: () => context.capture.isLeaseCurrent() && context.isGraphCurrent() &&
      context.capture.worldRevision === context.graph.key.baseSnapshotHash &&
      context.vehicleConfigHash === context.graph.key.vehicleConfigHash }) : undefined;
  return { id: spawn.id, ok: true, x: spawn.x, z: spawn.z, heading: spawn.heading, layerId: spawn.layerId, regionId, credential };
}
