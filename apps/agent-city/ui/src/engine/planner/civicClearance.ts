/** Full road capsule against the civic solids; the surrounding plaza remains open public space. */
import { DetMath as Math } from "../detMath";
import type { RoadEdge, Vec2 } from "../cityLayout";
import { civicGroundFootprint } from "../models/publicSiteGeometry";
import { crosses } from "./footprint";
import { corridorViolation, VALIDATION_CONFIG, type CorridorViolation } from "./validation";
import type { ConnectorWorld, ConnectionFailure } from "./connect";

// Waterfront generation already uses center clearance >10, width12 and a
// 12-unit mountain-foot setback: full-width clearance >4 is the corresponding
// envelope contract, not the 12-unit building setback. Ordinary roads retain it.
export const WATERFRONT_CORRIDOR_CONFIG = { version: 1, minLandClearance: 4, hillSetback: 12, maxHeight: 6, maxSlope: 0.9 };

/** 同一地面全路幅合同：civic 使用实体并集，其余未声明模型维持圆形预留。 */
export function groundJunctionCorridorFailure(world: ConnectorWorld, a: Vec2, b: Vec2, width: number, parent?: RoadEdge): ConnectionFailure | null {
  return groundJunctionCorridorViolation(world, a, b, width, parent)?.kind ?? null;
}

/** Same acceptance predicate as the compatibility failure enum, with the
 * actual cause/sample retained for generation and repair attribution. */
export function groundJunctionCorridorViolation(world: ConnectorWorld, a: Vec2, b: Vec2, width: number, parent?: RoadEdge): CorridorViolation | null {
  const sites = world.reservations() as Array<Vec2 & { radius: number; kind?: string; yaw?: number }>;
  for (const site of sites) if (site.kind === "civic" && !civicRoadClear({ ...site, yaw: site.yaw ?? NaN }, a, b, width, 3)) return { kind: "site-clearance", cause: "site-envelope" };
  const approach = !!parent && !parent.bridge && (parent.structure === "ground-approach" || [...world.network.edges.values()].some((edge) => edge.bridge && [edge.from, edge.to].some((node) => node === parent.from || node === parent.to)));
  const waterfront = !approach && parent?.purpose === "waterfront";
  return corridorViolation(world, a, b, { requireBuildable: !approach && !waterfront,
    maxSlope: approach ? VALIDATION_CONFIG.roadApproachMaxSlope : 0.9,
    ...(waterfront ? { waterfront: WATERFRONT_CORRIDOR_CONFIG } : {}),
    sites: sites.filter((site) => site.kind !== "civic"), siteMargin: 3, roadWidth: width });
}

export function civicRoadClear(site: Vec2 & { radius: number; yaw: number }, a: Vec2, b: Vec2, width: number, margin: number): boolean {
  if (![site.x, site.z, site.radius, site.yaw, a.x, a.z, b.x, b.z, width, margin].every(Number.isFinite) || site.radius <= 0 || width < 0 || margin < 0) return false;
  const local = (p: Vec2) => ({ x: (p.x - site.x) * Math.cos(site.yaw) - (p.z - site.z) * Math.sin(site.yaw), z: (p.x - site.x) * Math.sin(site.yaw) + (p.z - site.z) * Math.cos(site.yaw) });
  const u = local(a), v = local(b);
  const distance = (p: Vec2, q: Vec2, r: Vec2) => { const dx = r.x - q.x, dz = r.z - q.z; const t = Math.max(0, Math.min(1, ((p.x - q.x) * dx + (p.z - q.z) * dz) / (dx * dx + dz * dz || 1))); return Math.hypot(p.x - q.x - t * dx, p.z - q.z - t * dz); };
  for (const part of civicGroundFootprint(site.radius).parts) {
    if (part.shape !== "rect") return false;
    const left = part.center.x - part.width / 2, right = part.center.x + part.width / 2;
    const top = part.center.z - part.depth / 2, bottom = part.center.z + part.depth / 2;
    const inside = (p: Vec2) => p.x >= left && p.x <= right && p.z >= top && p.z <= bottom;
    if (inside(u) || inside(v)) return false;
    const corners = [{ x: left, z: top }, { x: right, z: top }, { x: right, z: bottom }, { x: left, z: bottom }];
    for (let k = 0; k < corners.length; k += 1) {
      const c = corners[k], d = corners[(k + 1) % corners.length];
      if (crosses(u, v, c, d) || Math.min(distance(u, c, d), distance(v, c, d), distance(c, u, v), distance(d, u, v)) < width / 2 + margin) return false;
    }
  }
  return true;
}
