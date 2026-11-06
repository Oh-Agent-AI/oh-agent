/** Final replay over the complete, unchanged support boundary. This producer never
 * closes failed units or invents a green subset. The continuous kernel enforces
 * this boundary through full-body support + swept motion checks (mounting off).
 * Physical fences for selectively closing roads are deliberately unsupported. */
import type { PassabilityWorld } from "./RoadPassabilityAudit";
import type { AuditKey, AuditManifest } from "./contracts";
import type { ReleasedUnitBoundaryEvidence } from "./ReleasedDrivingGraph";
import type { RegionBoundarySegment } from "../../../engine/surface/surfaceRegions";
import { CITY_SOLID_COMPILER_VERSION } from "../staticSolidContracts";
import { DEFAULT_FOOTPRINT_PARAMS } from "../surfaceFootprint";
import { DRIVING_FOOTPRINT } from "../vehicleFootprint";

export const FINAL_SURFACE_BOUNDARY_VERSION = 1;
export type FinalSurfaceBoundary = Readonly<{ hash: string; worldRevision: string; segments: readonly RegionBoundarySegment[] }>;
const owners = new WeakMap<FinalSurfaceBoundary, PassabilityWorld>();
function fingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) { hash ^= BigInt(text.charCodeAt(i)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return hash.toString(16).padStart(16, "0");
}
export function buildFinalSurfaceBoundary(world: PassabilityWorld): FinalSurfaceBoundary | null {
  if (!world.isCurrent() || world.coverage !== "complete") return null;
  const segments: RegionBoundarySegment[] = [];
  for (const region of [...world.regions.regions].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    for (const segment of world.regions.boundaryOf(region.id)) {
      if (segments.length >= 100_000 || !segment.layerId ||
        ![segment.ax,segment.az,segment.bx,segment.bz,segment.ya,segment.yb].every(Number.isFinite) ||
        Math.hypot(segment.bx-segment.ax,segment.bz-segment.az) <= 0) return null;
      segments.push(Object.freeze({ ...segment }));
    }
  }
  if (!segments.length) return null;
  segments.sort((a,b) => { const x=JSON.stringify(a),y=JSON.stringify(b); return x<y?-1:x>y?1:0; });
  const hash = `surface-boundary-v1:${fingerprint(JSON.stringify([world.worldRevision,world.surfaceRevision,
    world.regions.report.rulesVersion,world.regions.params,DRIVING_FOOTPRINT,DEFAULT_FOOTPRINT_PARAMS,"mounting-disabled",segments]))}`;
  const boundary = Object.freeze({ hash, worldRevision: world.worldRevision, segments: Object.freeze(segments) });
  owners.set(boundary,world);
  return boundary;
}
/** The capability cannot be forged by copying serialized fields or by reusing it in another world. */
export function matchesFinalSurfaceBoundary(boundary: FinalSurfaceBoundary, world: PassabilityWorld, key: AuditKey): boolean {
  return owners.get(boundary) === world && boundary.worldRevision === world.worldRevision &&
    key.baseSnapshotHash === world.worldRevision && key.releaseBoundaryHash === boundary.hash && world.isCurrent();
}
export function finalBoundaryEvidence(boundary: FinalSurfaceBoundary, world: PassabilityWorld, manifest: AuditManifest): readonly ReleasedUnitBoundaryEvidence[] | null {
  if (!matchesFinalSurfaceBoundary(boundary,world,manifest.key)) return null;
  const evidence: ReleasedUnitBoundaryEvidence[] = [];
  let count = 0;
  for (const unit of manifest.units) {
    if (manifest.exclusions.some((x) => x.unitId === unit.id)) continue;
    const cases = manifest.cases.filter((item) => item.units.includes(unit.id));
    if (cases.length !== 1) return null;
    const start = cases[0].start;
    const support = world.regions.supportAt(start.x,start.z,start.surfaceId,start.y);
    if (support.status !== "drivable") return null;
    const segments = boundary.segments.filter((s) => s.regionId === support.regionId && s.layerId === support.layerId)
      .map(({ax,az,bx,bz}) => Object.freeze({ax,az,bx,bz}));
    count += segments.length;
    if (!segments.length || count > 100_000) return null;
    evidence.push(Object.freeze({ version:1, unitId:unit.id, layerId:support.layerId, finalBoundaryHash:boundary.hash,
      releasePolicyVersion:manifest.key.releasePolicyVersion, collisionCompilerVersion:CITY_SOLID_COMPILER_VERSION,
      collisionQueryVersion:manifest.key.queryVersion, finalReplayPassed:true, fenceEnforced:true, segments:Object.freeze(segments) }));
  }
  return Object.freeze(evidence);
}
