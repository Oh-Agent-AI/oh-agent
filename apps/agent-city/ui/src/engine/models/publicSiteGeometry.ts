/** Shared local entry geometry for public-site models and planner contracts. */
import { scaledLocalPoint, type PlanarAccessDeclaration } from "./siteAccess";
export type SiteLocalPoint = { x: number; z: number };

/** Actual station hall dimensions, shared with the instanced renderer. */
export const STATION_HALL_GEOMETRY = { centreZRadiusScale: -0.62, widthRadiusScale: 1.3, depth: 7, height: 11 } as const;
export function stationHallLocal(radius: number): { centre: SiteLocalPoint; width: number; depth: number; height: number } {
  return { centre: { x: 0, z: radius * STATION_HALL_GEOMETRY.centreZRadiusScale },
    width: radius * STATION_HALL_GEOMETRY.widthRadiusScale, depth: STATION_HALL_GEOMETRY.depth, height: STATION_HALL_GEOMETRY.height };
}

/** Model and planner consume the same parameterized entrance, including resize. */
export const STATION_PLANAR_ACCESS: PlanarAccessDeclaration = {
  schemaVersion: 1, type: "ground-frontage", entrance: { id: "main", outward: { x: 0, z: 1 },
    local: { x: { radiusScale: 0, offset: 0 }, z: { radiusScale: STATION_HALL_GEOMETRY.centreZRadiusScale,
      offset: STATION_HALL_GEOMETRY.depth / 2 + 0.05 } } },
};

/** Hall is behind the plot origin, but its entrance is on the hall's +z exterior face. */
export function stationEntranceLocal(radius: number): SiteLocalPoint {
  return scaledLocalPoint(STATION_PLANAR_ACCESS.entrance.local!, radius);
}

export function stationCanopyLocalZ(radius: number): number {
  const hall = stationHallLocal(radius);
  return hall.centre.z + hall.depth / 2 + 1.1;
}

/** All civic growth stages: conservative union of the actual ground solids, not the plaza reservation. */
export function civicGroundFootprint(radius: number): import("./physical").LocalFootprint {
  const rect = (x: number, z: number, width: number, depth: number): import("./physical").LocalRegion => ({ shape: "rect", center: { x, z }, width, depth });
  return { parts: [
    rect(0, 0, Math.max(radius * 1.2, radius + 6), Math.max(radius * 0.9, radius * 0.6 + 6)),
    rect(0, -radius * 0.05, radius * 1.64, radius * 0.46),
    rect(0, radius * 0.25, radius * 1.64 + 5, 5),
    rect(0, radius * 0.46 + 1.35, radius * 0.5, 3.7),
    rect(0, radius * 0.62 + 3.85, radius * 0.7, 8.9),
    rect(1.125, radius * 0.78, radius + 2.55, 0.3),
  ] };
}

/** Keep every data-dependent flag pole/cloth inside the declared ground envelope. */
export function civicFlagLocalX(radius: number, index: number, count: number): number {
  return (index - (count - 1) / 2) * Math.min(5.5, radius / Math.max(1, count - 1));
}
