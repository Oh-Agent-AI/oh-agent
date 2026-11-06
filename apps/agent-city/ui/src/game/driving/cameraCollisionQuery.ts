/** Camera collision adapter over the same frozen solid OBB index used by driving.
 * The near-plane rectangle is enclosed by a sphere, then that sphere by a cube;
 * sweeping the cube is conservative for every lens orientation along the segment.
 * Mountable policy: the chase camera's arm sweep ORIGINATES at the vehicle, which
 * sits on mountable surfaces (bridge deck slabs, curb islands). A strict query
 * reports that start cube as an overlap (blocked@0 → "cannot confirm clearance"
 * pause); gameplay callers must pass the same mountable policy their world uses.
 * Flight and audit callers keep the strict default.
 */
import type { CameraClearanceQuery, CameraClearanceResult } from "../VehicleChaseCamera";
import type { CollisionIndex } from "./CollisionIndex";
import type { MountablePolicy } from "./staticSolidContracts";

export const CAMERA_COLLISION_QUERY_VERSION = 2;
export const CAMERA_COLLISION_QUERY_BUDGET = 4096;

/** Conjunction of camera-clearance sources (multi-source worlds, e.g. flight:
 *  shared city index + local obstacles + world bounds/terrain). One policy in
 *  one place: any unresolved source is fail-closed; blocked sources narrow to
 *  the smallest certified prefix; otherwise clear. */
export function combineCameraClearance(results: readonly CameraClearanceResult[]): CameraClearanceResult {
  if (results.some((result) => result.status === "unresolved")) return Object.freeze({ status: "unresolved" });
  const fractions = results.filter((result): result is { status: "blocked"; safeFraction: number } => result.status === "blocked").map((result) => result.safeFraction);
  return fractions.length ? Object.freeze({ status: "blocked", safeFraction: Math.min(...fractions) }) : Object.freeze({ status: "clear" });
}

export function createCameraCollisionQuery(index: CollisionIndex, mountablePolicy: MountablePolicy = "disabled"): CameraClearanceQuery {
  if (mountablePolicy !== "disabled" && mountablePolicy !== "gameplay") throw new Error("invalid-camera-mountable-policy");
  return (from, to, radius): CameraClearanceResult => {
    if (![from.x, from.y, from.z, to.x, to.y, to.z, radius].every(Number.isFinite) || radius < 0) {
      return Object.freeze({ status: "unresolved" });
    }
    // CollisionIndex.sweep has an immutable candidate/test budget from its
    // build. Reject an index configured above the camera query contract rather
    // than silently running an unbounded camera query against it.
    if (index.limits.maxCandidates > CAMERA_COLLISION_QUERY_BUDGET || index.limits.maxTests > 1_000_000) {
      return Object.freeze({ status: "unresolved" });
    }
    const start = { ...from, heading: 0, pitch: 0, roll: 0 };
    const end = { ...to, heading: 0, pitch: 0, roll: 0 };
    const dimensions = { halfLength: radius, halfWidth: radius, halfHeight: radius };
    const checkedStart = index.overlap(start, dimensions, mountablePolicy);
    if (checkedStart.status === "unresolved") return Object.freeze({ status: "unresolved" });
    if (checkedStart.status === "contact") return Object.freeze({ status: "blocked", safeFraction: 0 });
    const checked = index.sweep(start, end, dimensions, mountablePolicy);
    if (checked.status === "clear") return Object.freeze({ status: "clear" });
    if (checked.status === "unresolved") return Object.freeze({ status: "unresolved" });
    if (!Number.isFinite(checked.lastSafeFraction) || checked.lastSafeFraction < 0 || checked.lastSafeFraction > 1 || !checked.contact) {
      return Object.freeze({ status: "unresolved" });
    }
    // The physics sweep's sampled-prefix field can remain zero when it advances
    // directly to TOI. Refine a certified prefix with a bounded number of fresh
    // sweeps; only a `clear` result advances the lower bound. Never interpolate
    // from TOI as if its whole prefix had already been verified by this policy.
    if (!Number.isFinite(checked.contact.toi) || checked.contact.toi <= 0 || checked.contact.toi > 1) {
      return Object.freeze({ status: "blocked", safeFraction: 0 });
    }
    let low = 0; let high = checked.contact.toi;
    for (let attempt = 0; attempt < 8 && high - low > 1e-4; attempt += 1) {
      const fraction = (low + high) / 2;
      const probe = index.sweep(start, {
        x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction,
        z: from.z + (to.z - from.z) * fraction, heading: 0, pitch: 0, roll: 0,
      }, dimensions, mountablePolicy);
      if (probe.status === "clear") low = fraction;
      else if (probe.status === "contact") high = fraction;
      else if (low > 0) return Object.freeze({ status: "blocked", safeFraction: low });
      else return Object.freeze({ status: "unresolved" });
    }
    return Object.freeze({ status: "blocked", safeFraction: low });
  };
}
