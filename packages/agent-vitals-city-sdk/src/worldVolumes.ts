import type { StableIdV1, Vec3V1, VolumeGeometryV1, WorldVolumeDtoV1 } from "./contracts";

interface Interval { minimum: number; maximum: number }
const subtract = (left: Vec3V1, right: Vec3V1): Vec3V1 => [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
const dot = (left: Vec3V1, right: Vec3V1): number => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
const at = (from: Vec3V1, delta: Vec3V1, time: number): Vec3V1 => [from[0] + delta[0] * time, from[1] + delta[1] * time, from[2] + delta[2] * time];

function clip(interval: Interval, origin: number, delta: number, minimum: number, maximum: number): boolean {
  if (Math.abs(delta) <= 1e-12) return origin >= minimum && origin <= maximum;
  let first = (minimum - origin) / delta, second = (maximum - origin) / delta;
  if (first > second) [first, second] = [second, first];
  interval.minimum = Math.max(interval.minimum, first);
  interval.maximum = Math.min(interval.maximum, second);
  return interval.minimum <= interval.maximum;
}

function ringContains(point: Vec3V1, geometry: Extract<VolumeGeometryV1, { kind: "ring" }>): boolean {
  const relative = subtract(point, geometry.center);
  const axial = Math.abs(dot(relative, geometry.normal));
  const alongNormal = geometry.normal.map(value => value * dot(relative, geometry.normal)) as unknown as Vec3V1;
  const radialVector = subtract(relative, alongNormal);
  const radial = Math.hypot(...radialVector);
  return axial <= geometry.thicknessMeters / 2 + 1e-9
    && radial >= geometry.innerRadiusMeters - 1e-9 && radial <= geometry.outerRadiusMeters + 1e-9;
}

export function segmentIntersectsVolumeGeometry(from: Vec3V1, to: Vec3V1, geometry: VolumeGeometryV1): boolean {
  const delta = subtract(to, from);
  const interval = { minimum: 0, maximum: 1 };
  if (geometry.kind === "box") {
    return clip(interval, from[0], delta[0], geometry.bounds.min[0], geometry.bounds.max[0])
      && clip(interval, from[1], delta[1], geometry.bounds.min[1], geometry.bounds.max[1])
      && clip(interval, from[2], delta[2], geometry.bounds.min[2], geometry.bounds.max[2]);
  }
  if (geometry.kind === "sphere") {
    const relative = subtract(from, geometry.center);
    const a = dot(delta, delta);
    const c = dot(relative, relative) - geometry.radiusMeters * geometry.radiusMeters;
    if (c <= 0) return true;
    if (a <= 1e-24) return false;
    const b = 2 * dot(relative, delta);
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return false;
    const root = Math.sqrt(discriminant);
    const first = (-b - root) / (2 * a), second = (-b + root) / (2 * a);
    return second >= 0 && first <= 1;
  }
  if (geometry.kind === "ring") {
    if (ringContains(from, geometry) || ringContains(to, geometry)) return true;
    const denominator = dot(delta, geometry.normal);
    if (Math.abs(denominator) <= 1e-12) return false;
    const time = dot(subtract(geometry.center, from), geometry.normal) / denominator;
    return time >= 0 && time <= 1 && ringContains(at(from, delta, time), geometry);
  }
  if (!clip(interval, from[1], delta[1], geometry.minY, geometry.maxY)) return false;
  const winding = geometry.polygonXZ.reduce((sum, point, index) => {
    const next = geometry.polygonXZ[(index + 1) % geometry.polygonXZ.length]!;
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) >= 0 ? 1 : -1;
  for (let index = 0; index < geometry.polygonXZ.length; index += 1) {
    const start = geometry.polygonXZ[index]!, end = geometry.polygonXZ[(index + 1) % geometry.polygonXZ.length]!;
    const normalX = (end[1] - start[1]) * winding, normalZ = (start[0] - end[0]) * winding;
    const bound = normalX * start[0] + normalZ * start[1];
    if (!clip(interval, normalX * from[0] + normalZ * from[2], normalX * delta[0] + normalZ * delta[2], Number.NEGATIVE_INFINITY, bound)) return false;
  }
  return interval.minimum <= interval.maximum;
}

export function segmentCrossesWorldVolume(from: Vec3V1, to: Vec3V1, volume: WorldVolumeDtoV1): boolean {
  return segmentIntersectsVolumeGeometry(from, to, volume.geometry);
}

export function segmentPassesRingGate(from: Vec3V1, to: Vec3V1, volume: WorldVolumeDtoV1): boolean {
  if (volume.geometry.kind !== "ring") return false;
  const geometry = volume.geometry;
  const delta = subtract(to, from);
  const denominator = dot(delta, geometry.normal);
  if (Math.abs(denominator) <= 1e-12) return false;
  const time = dot(subtract(geometry.center, from), geometry.normal) / denominator;
  if (time < 0 || time > 1) return false;
  const crossing = at(from, delta, time);
  return Math.hypot(...subtract(crossing, geometry.center)) <= geometry.innerRadiusMeters + 1e-9;
}

export function sweepSegmentThroughVolumes(from: Vec3V1, to: Vec3V1, volumes: readonly WorldVolumeDtoV1[]): readonly StableIdV1[] {
  return Object.freeze(volumes.filter(volume => segmentCrossesWorldVolume(from, to, volume)).map(volume => volume.id).sort());
}
