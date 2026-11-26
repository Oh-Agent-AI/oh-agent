/** Compare the validated simulation spawn, not an asynchronously rendered pose. */
export function spawnDistanceFailure(actual: Readonly<{ x: number; z: number }> | null, expected: Readonly<{ x: number; z: number }>, limit = 40): "unavailable" | "too-far" | null {
  if (!actual || !Number.isFinite(actual.x) || !Number.isFinite(actual.z)) return "unavailable";
  if (!Number.isFinite(expected.x) || !Number.isFinite(expected.z) || !Number.isFinite(limit) || limit < 0) return "unavailable";
  return Math.hypot(actual.x - expected.x, actual.z - expected.z) > limit ? "too-far" : null;
}
