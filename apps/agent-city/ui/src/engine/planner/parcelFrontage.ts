/** Frozen-proof consistency, not a second route planner or a terrain/model certificate. */
import { DetMath as Math } from "../detMath";
import type { Parcel, RoadEdge, Vec2 } from "../cityLayout";
import type { ParcelFrontageProof } from "./roadBlocks";

export type ParcelFrontageValidation = { ok: boolean; reason?: string; scope: "topology-and-current-frontage-geometry" };
/** Floating-point identity allowance only; not a geometric snapping/search radius. */
const TOLERANCE = 1e-6;
const finite = (p: Vec2 | undefined) => !!p && Number.isFinite(p.x) && Number.isFinite(p.z);
const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z) <= TOLERANCE;

export function validateParcelFrontage(proof: ParcelFrontageProof | undefined, parcel: Parcel,
  block: { id: string; sourceFaceId?: string }, roads: ReadonlyMap<string, RoadEdge>, currentVersion: number | undefined,
  anchor: string | null | undefined): ParcelFrontageValidation {
  const scope = "topology-and-current-frontage-geometry" as const, fail = (reason: string) => ({ ok: false, reason, scope });
  if (!proof) return fail("frontage-proof-missing");
  if (proof.scope !== "parcel-frontage" || proof.terrainCoverage !== "one-unit-sampling") return fail("frontage-proof-scope-unsupported");
  if (proof.parcelId !== parcel.id || proof.blockId !== block.id || parcel.blockId !== block.id
    || !block.sourceFaceId || proof.sourceFaceId !== block.sourceFaceId) return fail("frontage-owner-or-face-mismatch");
  if (!Number.isSafeInteger(currentVersion) || !Number.isSafeInteger(proof.networkVersion) || currentVersion! < 0 || proof.networkVersion !== currentVersion) return fail("frontage-version-stale-or-invalid");
  if (!finite(parcel) || ![parcel.yaw, parcel.width, parcel.depth].every(Number.isFinite) || parcel.width <= 0 || parcel.depth <= 0
    || !finite(proof.roadPoint) || !finite(proof.shoulderPoint) || !finite(proof.frontagePoint)) return fail("frontage-geometry-nonfinite-or-invalid");
  const host = roads.get(proof.hostEdgeId);
  if (!host || host.bridge || host.structure === "deck" || !Number.isFinite(host.width) || host.width <= 0
    || !Number.isInteger(proof.hostSegmentIndex) || proof.hostSegmentIndex < 0 || proof.hostSegmentIndex >= host.points.length - 1) return fail("frontage-host-invalid");
  const path = proof.primaryNodePath;
  if (!anchor || !Array.isArray(path) || !Array.isArray(proof.primaryEdgePath) || path[0] !== host.from || path[path.length - 1] !== anchor
    || path.length !== proof.primaryEdgePath.length + 1 || !proof.primaryEdgePath.every((id, i) => {
      const edge = roads.get(id);
      return !!edge && ((edge.from === path[i] && edge.to === path[i + 1]) || (edge.to === path[i] && edge.from === path[i + 1]));
    })) return fail("frontage-primary-path-invalid");
  const a = host.points[proof.hostSegmentIndex], b = host.points[proof.hostSegmentIndex + 1];
  if (!finite(a) || !finite(b)) return fail("frontage-host-geometry-invalid");
  const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length <= TOLERANCE) return fail("frontage-host-segment-degenerate");
  const t = ((proof.roadPoint.x - a.x) * dx + (proof.roadPoint.z - a.z) * dz) / (length * length);
  const closest = { x: a.x + dx * Math.max(0, Math.min(1, t)), z: a.z + dz * Math.max(0, Math.min(1, t)) };
  if (!near(closest, proof.roadPoint)) return fail("frontage-road-point-off-host");
  const gap = Math.hypot(parcel.x - proof.roadPoint.x, parcel.z - proof.roadPoint.z);
  if (!Number.isFinite(gap) || gap <= TOLERANCE) return fail("frontage-owner-on-road-point");
  const inward = { x: (parcel.x - proof.roadPoint.x) / gap, z: (parcel.z - proof.roadPoint.z) / gap };
  if (Math.abs((inward.x * dx + inward.z * dz) / length) > TOLERANCE) return fail("frontage-not-normal-to-host");
  const shoulder = { x: proof.roadPoint.x + inward.x * host.width / 2, z: proof.roadPoint.z + inward.z * host.width / 2 };
  if (!near(shoulder, proof.shoulderPoint)) return fail("frontage-shoulder-width-or-direction-mismatch");
  // The road-facing side is inferred from geometry, not a universal local +z door convention.
  const c = Math.cos(parcel.yaw), s = Math.sin(parcel.yaw), localX = inward.x * c - inward.z * s, localZ = inward.x * s + inward.z * c;
  const half = Math.min(Math.abs(localX) > 1e-12 ? parcel.width / 2 / Math.abs(localX) : Infinity,
    Math.abs(localZ) > 1e-12 ? parcel.depth / 2 / Math.abs(localZ) : Infinity);
  const front = { x: parcel.x - inward.x * half, z: parcel.z - inward.z * half };
  if (!near(front, proof.frontagePoint)) return fail("frontage-point-not-current-parcel-front");
  if (gap - half < host.width / 2 + 0.5 - TOLERANCE) return fail("frontage-order-or-road-clearance-invalid");
  return { ok: true, scope };
}
