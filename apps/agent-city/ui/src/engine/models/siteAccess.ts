/** Data-only local access geometry. Model identities never choose a planner branch. */
import { DetMath as Math } from "../detMath";
import type { Vec2 } from "../cityLayout";

export type ScaledLocalPoint = {
  x: { radiusScale: number; offset: number };
  z: { radiusScale: number; offset: number };
};

export type PlanarAccessDeclaration = {
  schemaVersion: 1;
  type: "ground-frontage";
  entrance: { id: string; outward: Vec2; local?: ScaledLocalPoint };
};

export type ResolvedPlanarAccess = { entranceId: string; outward: Vec2; localDoor?: Vec2 };

export function scaledLocalPoint(point: ScaledLocalPoint, radius: number): Vec2 {
  return { x: point.x.radiusScale * radius + point.x.offset, z: point.z.radiusScale * radius + point.z.offset };
}

/** Missing or malformed capabilities fail closed, never default to a model name. */
export function resolvePlanarAccess(declaration: PlanarAccessDeclaration | undefined, radius: number):
  { ok: true; access: ResolvedPlanarAccess } | { ok: false; reason: string } {
  if (!declaration || declaration.schemaVersion !== 1 || declaration.type !== "ground-frontage") return { ok: false, reason: "ground-frontage access capability unsupported" };
  const entrance = declaration.entrance;
  if (!Number.isFinite(radius) || radius <= 0 || !entrance || typeof entrance.id !== "string" || !entrance.id.trim()
    || !entrance.outward || ![entrance.outward.x, entrance.outward.z].every(Number.isFinite)
    || !Number.isFinite(Math.hypot(entrance.outward.x, entrance.outward.z))
    || Math.hypot(entrance.outward.x, entrance.outward.z) <= 1e-9) return { ok: false, reason: "invalid planar entrance declaration" };
  let localDoor: Vec2 | undefined;
  if (entrance.local) {
    const { x, z } = entrance.local;
    if (!x || !z || ![x.radiusScale, x.offset, z.radiusScale, z.offset].every(Number.isFinite)) return { ok: false, reason: "invalid local entrance geometry" };
    localDoor = scaledLocalPoint(entrance.local, radius);
    if (![localDoor.x, localDoor.z].every(Number.isFinite)) return { ok: false, reason: "invalid resolved entrance geometry" };
    if (Math.hypot(localDoor.x, localDoor.z) > radius) return { ok: false, reason: "invalid entrance outside declared plot envelope" };
  }
  return { ok: true, access: { entranceId: entrance.id, outward: { ...entrance.outward }, ...(localDoor ? { localDoor } : {}) } };
}

/** Local +z rotates to (sin(yaw), cos(yaw)); this matches model transforms. */
export function planarAccessAtYaw(access: ResolvedPlanarAccess, centre: Vec2, yaw: number): { outward: Vec2; door?: Vec2 } {
  const c = Math.cos(yaw), s = Math.sin(yaw), length = Math.hypot(access.outward.x, access.outward.z);
  const point = access.localDoor;
  return { outward: { x: (access.outward.x * c + access.outward.z * s) / length,
    z: (-access.outward.x * s + access.outward.z * c) / length },
    ...(point ? { door: { x: centre.x + point.x * c + point.z * s, z: centre.z - point.x * s + point.z * c } } : {}) };
}

export function planarAccessPose(access: ResolvedPlanarAccess, centre: Vec2, toRoad: Vec2, gateRadius?: number): { yaw: number; door?: Vec2; gate?: Vec2 } {
  const { outward } = access;
  const yaw = Math.atan2(toRoad.x * outward.z - toRoad.z * outward.x, toRoad.x * outward.x + toRoad.z * outward.z);
  const point = access.localDoor;
  const { door } = planarAccessAtYaw(access, centre, yaw);
  let gate: Vec2 | undefined;
  if (gateRadius !== undefined && Number.isFinite(gateRadius) && gateRadius > Math.hypot(point?.x ?? 0, point?.z ?? 0)) {
    const length = Math.hypot(outward.x, outward.z), normal = { x: outward.x / length, z: outward.z / length };
    const dot = (point?.x ?? 0) * normal.x + (point?.z ?? 0) * normal.z;
    const lateral = { x: (point?.x ?? 0) - dot * normal.x, z: (point?.z ?? 0) - dot * normal.z };
    const forward = Math.sqrt(gateRadius * gateRadius - lateral.x * lateral.x - lateral.z * lateral.z);
    const at = { x: centre.x + lateral.x * Math.cos(yaw) + lateral.z * Math.sin(yaw) + toRoad.x * forward,
      z: centre.z - lateral.x * Math.sin(yaw) + lateral.z * Math.cos(yaw) + toRoad.z * forward };
    if ([at.x, at.z].every(Number.isFinite)) gate = at;
  }
  return { yaw, ...(door ? { door } : {}), ...(gate ? { gate } : {}) };
}
