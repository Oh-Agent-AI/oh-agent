/** ReleasedDrivingGraph（D2 最小切片）：把一次 AuditReleaseDecision 固化为带身份的只读开放图。
 *
 * 不做判定：只消费 evaluateAuditRelease 的结论。ready=false 时拒绝发布；green 子集只收录
 * status==="passed" 的单元。发布后图与 key 绑定，isCurrent 由宿主租约提供；key 或世界失效后
 * 整图作废，不残留半张图。不修改 manifest、不复跑审计、不提供 UI——界面消费仍属 E。
 */
import { sameAuditKey } from "./AuditIdentity";
import type { AuditKey, AuditManifest, AuditUnitKind } from "./contracts";
import type { AuditReleaseDecision } from "./AuditReleasePolicy";
import { CITY_SOLID_COMPILER_VERSION } from "../staticSolidContracts";

export const RELEASED_DRIVING_GRAPH_VERSION = 2;
export type ReleasedUnitStatus = "passed" | "blocked" | "pending" | "excluded" | "closed";
export type ReleasedUnitBoundaryEvidence = Readonly<{
  version: 1;
  unitId: string;
  layerId: string;
  finalBoundaryHash: string;
  releasePolicyVersion: number;
  collisionCompilerVersion: number;
  collisionQueryVersion: number;
  finalReplayPassed: boolean;
  fenceEnforced: boolean;
  segments: readonly Readonly<{ ax: number; az: number; bx: number; bz: number }>[];
}>;
export type ReleasedDrivingUnit = Readonly<{
  unitId: string; kind: AuditUnitKind; status: ReleasedUnitStatus; reason: string;
}>;
/** Verified corridor centerline for a passed unit: the audited path polyline (XZ)
 * plus the direction of travel at its start. Geometry comes from the manifest's
 * cases — the same evidence the release policy verified — never re-derived. */
export type ReleasedUnitGeometry = Readonly<{
  unitId: string;
  waypoints: readonly Readonly<{ x: number; z: number }>[];
  startHeading: number;
  /** Surface region IDs recorded by the audited corridor (`DrivingState.surfaceId`).
   * They are not patch IDs; consumers resolve regions and patches in the frozen world. */
  surfaceRegionIds: readonly string[];
  /** Final same-policy fence boundary evidence. Missing evidence means unavailable;
   * halfWidth from an entry gate is not a substitute. */
  boundaryEvidence?: ReleasedUnitBoundaryEvidence;
  /** Deprecated diagnostic field. Never use this as route or spawn clearance proof. */
  halfWidth: number;
}>;
export type ReleasedDrivingGraph = Readonly<{
  graphVersion: number; key: AuditKey; releaseBoundaryHash: string;
  units: readonly ReleasedDrivingUnit[]; counts: Readonly<Record<"passed" | "blocked" | "pending" | "excluded" | "closed", number>>;
  /** Centerline geometry for passed units that have exactly one audited case. */
  geometry: readonly ReleasedUnitGeometry[];
}>;
export type GraphLease = Readonly<{
  /** Cheap per-step freshness, mirroring the frozen-source fast check. */
  isCurrent(): boolean;
  /** Full identity of the world the audit ran on. */
  currentKey(): AuditKey;
}>;
export type PublishedDrivingGraph = Readonly<{
  graph: ReleasedDrivingGraph;
  /** True until the lease reports stale; a stale handle must not be used for driving admission. */
  isCurrent(): boolean;
}>;

/** Publish never fabricates readiness: it re-checks the decision it was given. */
export function publishDrivingGraph(
  manifest: AuditManifest,
  decision: AuditReleaseDecision,
  boundaryEvidence: readonly ReleasedUnitBoundaryEvidence[] = [],
): { ok: true; graph: ReleasedDrivingGraph } | { ok: false; reason: string } {
  if (manifest.key.releaseBoundaryHash === null) return { ok: false, reason: "final-boundary-replay-required" };
  if (!decision.ready) return { ok: false, reason: decision.reasons[0] ?? "release-not-ready" };
  const units = decision.units.map<ReleasedDrivingUnit>((unit) =>
    ({ unitId: unit.unitId, kind: manifest.units.find((candidate) => candidate.id === unit.unitId)?.kind ?? "directed-edge", status: unit.status, reason: unit.reason }));
  const counts = { passed: 0, blocked: 0, pending: 0, excluded: 0, closed: 0 } as Record<"passed" | "blocked" | "pending" | "excluded" | "closed", number>;
  for (const unit of units) counts[unit.status] += 1;
  const evidenceByUnit = new Map<string, ReleasedUnitBoundaryEvidence>();
  for (const entry of boundaryEvidence) {
    if (evidenceByUnit.has(entry.unitId)) return { ok: false, reason: "duplicate-unit-boundary-evidence" };
    evidenceByUnit.set(entry.unitId, entry);
  }
  const geometries = unitGeometry(manifest, units).map((geometry) => {
    const evidence = evidenceByUnit.get(geometry.unitId);
    if (!evidence || evidence.version !== 1 || evidence.finalBoundaryHash !== manifest.key.releaseBoundaryHash ||
      evidence.releasePolicyVersion !== manifest.key.releasePolicyVersion || evidence.collisionQueryVersion !== manifest.key.queryVersion ||
      evidence.collisionCompilerVersion !== CITY_SOLID_COMPILER_VERSION ||
      !evidence.finalReplayPassed || !evidence.fenceEnforced || !evidence.layerId || evidence.segments.length === 0 ||
      evidence.segments.some((segment) => ![segment.ax, segment.az, segment.bx, segment.bz].every(Number.isFinite) ||
        Math.hypot(segment.bx - segment.ax, segment.bz - segment.az) <= 0)) return geometry;
    return Object.freeze({ ...geometry, boundaryEvidence: Object.freeze({ ...evidence,
      segments: Object.freeze(evidence.segments.map((segment) => Object.freeze({ ...segment }))) }) });
  });
  return { ok: true, graph: Object.freeze({
    graphVersion: RELEASED_DRIVING_GRAPH_VERSION, key: manifest.key, releaseBoundaryHash: manifest.key.releaseBoundaryHash,
    units: Object.freeze(units), counts: Object.freeze(counts),
    geometry: Object.freeze(geometries),
  }) };
}

/** Verified centerlines for passed units, extracted from the audited cases themselves.
 * A unit covered by multiple cases has ambiguous geometry and is skipped — consumers
 * must not treat a missing entry as a drivable centerline. */
function unitGeometry(manifest: AuditManifest, units: readonly ReleasedDrivingUnit[]): readonly ReleasedUnitGeometry[] {
  const byUnit = new Map<string, typeof manifest.cases[number][]>();
  for (const item of manifest.cases) for (const unitId of item.units) {
    const list = byUnit.get(unitId); if (list) list.push(item); else byUnit.set(unitId, [item]);
  }
  const out: ReleasedUnitGeometry[] = [];
  for (const unit of units) {
    if (unit.status !== "passed") continue;
    const cases = byUnit.get(unit.unitId);
    if (!cases || cases.length !== 1) continue;
    const item = cases[0];
    const waypoints = item.corridor.waypoints;
    if (waypoints.length < 2) continue;
    const first = waypoints[0], second = waypoints[1];
    out.push(Object.freeze({
      unitId: unit.unitId,
      waypoints,
      startHeading: Math.atan2(second.z - first.z, second.x - first.x),
      surfaceRegionIds: Object.freeze([...new Set(item.corridor.surfaceSequence)]),
      halfWidth: item.gates[0]?.halfWidth ?? 0,
    }));
  }
  return out;
}

/** Bind a published graph to a live lease; the handle dies with the lease, not with this call. */
export function bindDrivingGraph(graph: ReleasedDrivingGraph, lease: GraphLease): PublishedDrivingGraph {
  return { graph, isCurrent: () => lease.isCurrent() && sameAuditKey(lease.currentKey(), graph.key) };
}
