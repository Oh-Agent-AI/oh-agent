/** Shared version identities for deterministic static-solid compilation. Keep this a leaf. */
// v6: ramp-deck top-edge mounting envelope includes the pitched swept car body.
export const CITY_SOLID_COMPILER_VERSION = 6;
export const CITY_SOLID_QUERY_CANDIDATE_BUDGET = 4096;
/** Mountable-solid traversal is a caller policy, never an implicit property of geometry. */
export const MOUNTABLE_POLICY_VERSION = 1;
export type MountablePolicy = "disabled" | "gameplay";
export const isValidMountableHeight = (value: unknown): boolean => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);

function maxAbsSin(min: number, max: number): number {
  if (min > max) [min, max] = [max, min];
  if (max - min >= Math.PI) return 1;
  const endpoint = Math.max(Math.abs(Math.sin(min)), Math.abs(Math.sin(max)));
  return Math.ceil((min - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2 <= max ? 1 : endpoint;
}

function maxAbsCos(min: number, max: number): number {
  if (min > max) [min, max] = [max, min];
  if (max - min >= Math.PI) return 1;
  const endpoint = Math.max(Math.abs(Math.cos(min)), Math.abs(Math.cos(max)));
  return Math.ceil(min / Math.PI) * Math.PI <= max ? 1 : endpoint;
}

/** Conservative vertical half-extent of an Euler-rotated vehicle over an angle interval. */
export function conservativeVehicleVerticalRadius(
  halfLength: number, halfWidth: number, halfHeight: number,
  pitchFrom: number, pitchTo: number, rollFrom: number, rollTo: number,
): number {
  return halfLength * maxAbsSin(pitchFrom, pitchTo) +
    halfHeight * maxAbsCos(pitchFrom, pitchTo) * maxAbsCos(rollFrom, rollTo) +
    halfWidth * maxAbsCos(pitchFrom, pitchTo) * maxAbsSin(rollFrom, rollTo);
}
