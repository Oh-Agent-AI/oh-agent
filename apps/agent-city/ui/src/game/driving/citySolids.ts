/** City solids for the CollisionIndex: structure descriptors (pure) + the scene's rendered solids
 * (captured by engine/surface/sceneSolids.ts), and the report of solids standing on drivable road.
 * Pure CPU; type-only engine imports. */
import type { StructureObstacle } from "../../engine/surface/compileSurface";
import type { SurfaceRegionsBuild } from "../../engine/surface/surfaceRegions";
import { boxSolidFromCorners, buildCollisionIndex, carBody, type CollisionIndex, type SolidInput } from "./CollisionIndex";

export function structureSolids(obstacles: readonly StructureObstacle[]): SolidInput[] {
  return obstacles.map((o) => o.shape === "box"
    ? boxSolidFromCorners(`structure:${o.id}`, o.role, o.corners)
    : Object.freeze({ id: `structure:${o.id}`, role: o.role, kind: "prism" as const, ring: o.ring, yMin: o.yMin, yMax: o.yMax }));
}
export function cityCollisionIndex(obstacles: readonly StructureObstacle[], scene: readonly SolidInput[] = []): CollisionIndex {
  return buildCollisionIndex([...structureSolids(obstacles), ...scene]);
}

export type SolidOnRoad = Readonly<{ id: string; role: string; x: number; z: number; regionId: string; layerId: string }>;
/** Solids that a car standing on drivable road would touch: a grid probe over every solid's XZ box;
 * each drivable sample places a small upright body on that surface and asks the index. Structure
 * solids the region rules already bound (railings, rails, islands, the decks themselves) are skipped
 * by role; landmark platforms (sea opera islet, airport apron — patch ids `platform:*`) are plazas whose
 * buildings are meant to be driven around, so samples on them are not "road". One witness per solid;
 * this is a report, not a gate. */
export function solidsOnRoad(regions: SurfaceRegionsBuild, collision: CollisionIndex, options: { step?: number; skipRoles?: ReadonlySet<string>; maxSamplesPerSolid?: number } = {}): SolidOnRoad[] {
  if (regions.status !== "ready") return [];
  const step = options.step ?? 1;
  const skip = options.skipRoles ?? new Set(["bridge-railing", "expressway-rail", "island", "bridge-deck", "expressway-deck", "ramp-rail", "ramp-deck"]);
  const layers = [...new Set(regions.regions.flatMap((r) => r.layerIds))].sort();
  const out: SolidOnRoad[] = [];
  for (const solid of collision.solids()) {
    if (skip.has(solid.role)) continue;
    const nx = Math.ceil((solid.maxX - solid.minX) / step), nz = Math.ceil((solid.maxZ - solid.minZ) / step);
    if ((nx + 1) * (nz + 1) > (options.maxSamplesPerSolid ?? 40_000)) continue;
    let found: SolidOnRoad | null = null;
    for (let i = 0; i <= nx && !found; i++) for (let j = 0; j <= nz && !found; j++) {
      const x = Math.min(solid.maxX, solid.minX + i * step), z = Math.min(solid.maxZ, solid.minZ + j * step);
      for (const layerId of layers) {
        const at = regions.classify(x, z, layerId);
        if (at.status !== "drivable" || at.patchId.startsWith("platform:")) continue;
        const hit = collision.hit(carBody({ x, z, heading: 0 }, { y: at.y, pitch: 0, roll: 0 }, 0.05, 0.05));
        if (hit.status === "hit" && hit.solid.id === solid.id) { found = Object.freeze({ id: solid.id, role: solid.role, x, z, regionId: at.regionId, layerId }); break; }
      }
    }
    if (found) out.push(found);
  }
  return out;
}
