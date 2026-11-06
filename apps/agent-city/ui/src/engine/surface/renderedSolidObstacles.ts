/** Per-instance conservative world boxes derived from exact rendered building solids.
 * Rendered building geometry is instanced boxes in this city, so the per-instance
 * transformed AABB equals the exact visual footprint; non-box meshes (spires, sails)
 * keep their conservative AABB — never smaller than what is drawn.
 * CPU-only; no three.js import. Fail-closed: over budget or degenerate transforms
 * refuse the batch rather than silently dropping buildings. */
import type { RenderedSolid } from "./renderedSolidTypes";
import type { StructureObstacle } from "./compileSurface";
import type { SolidInput } from "../../game/driving/CollisionIndex";

export const RENDERED_OBSTACLE_LIMITS = Object.freeze({ obstacles: 60_000, solids: 20_000 });

export type RenderedObstacleResult =
  | Readonly<{ status: "ready"; obstacles: readonly StructureObstacle[]; solidInputs: readonly SolidInput[]; instances: number; skippedDegenerate: number }>
  | Readonly<{ status: "unavailable"; reason: "rendered-solids-budget" | "invalid-rendered-solid" }>;

type P3 = Readonly<{ x: number; y: number; z: number }>;

/** Column-major 4×4 application. */
function apply(m: readonly number[] | Float64Array, offset: number, x: number, y: number, z: number): { x: number; y: number; z: number } {
  const o = offset;
  return {
    x: m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12],
    y: m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13],
    z: m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14],
  };
}

export function renderedSolidsToObstacles(solids: readonly RenderedSolid[], limits: Readonly<{ obstacles: number; solids: number }> = RENDERED_OBSTACLE_LIMITS): RenderedObstacleResult {
  if (solids.length > limits.solids) return { status: "unavailable", reason: "rendered-solids-budget" };
  const out: StructureObstacle[] = [];
  const solidInputs: SolidInput[] = [];
  let instances = 0;
  let skippedDegenerate = 0;
  for (const solid of solids) {
    const { positions, indices, transforms } = solid;
    if (!(positions instanceof Float32Array) || !(indices instanceof Uint32Array) || !(transforms instanceof Float64Array)
      || (transforms.length & 15) !== 0 || positions.length % 3 || indices.length % 3) return { status: "unavailable", reason: "invalid-rendered-solid" };
    if (!transforms.every(Number.isFinite) || !positions.every(Number.isFinite)
      || !indices.every((i) => i < positions.length / 3)) return { status: "unavailable", reason: "invalid-rendered-solid" };
    for (let offset = 0; offset < transforms.length; offset += 16) {
      if (transforms[offset + 3] !== 0 || transforms[offset + 7] !== 0 || transforms[offset + 11] !== 0 || transforms[offset + 15] !== 1)
        return { status: "unavailable", reason: "invalid-rendered-solid" };
    }
    // captureRenderedSolids retains empty draw ranges and zero-instance meshes
    // for freshness checks. They draw no triangles and therefore add no solid.
    if (transforms.length === 0 || indices.length === 0) continue;
    // Local AABB over referenced vertices only — unused buffer tails must not
    // inflate the conservative bound.
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i + 2 < indices.length; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        const v = indices[i + k] * 3;
        const x = positions[v], y = positions[v + 1], z = positions[v + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return { status: "unavailable", reason: "invalid-rendered-solid" };
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
    if (!Number.isFinite(minX)) return { status: "unavailable", reason: "invalid-rendered-solid" };
    const count = transforms.length / 16;
    for (let instance = 0; instance < count; instance += 1) {
      if (out.length >= limits.obstacles) return { status: "unavailable", reason: "rendered-solids-budget" };
      const corners: P3[] = [];
      let finite = true;
      for (let cy = 0; cy <= 1; cy += 1) for (let cz = 0; cz <= 1; cz += 1) for (let cx = 0; cx <= 1; cx += 1) {
        const p = apply(transforms, instance * 16, cx ? maxX : minX, cy ? maxY : minY, cz ? maxZ : minZ);
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) { finite = false; break; }
        corners.push(p);
      }
      if (!finite) return { status: "unavailable", reason: "invalid-rendered-solid" };
      let cMinY = corners[0].y, cMaxY = corners[0].y;
      for (const corner of corners) { if (corner.y < cMinY) cMinY = corner.y; if (corner.y > cMaxY) cMaxY = corner.y; }
      if (cMaxY - cMinY <= 1e-9) { skippedDegenerate += 1; continue; }
      // Preserve the captured transform's exact center/half-axis representation
      // for collision validation. Reconstructing this thin rotated box from
      // world corners loses enough precision at city-scale coordinates to make
      // otherwise planar faces appear non-planar to the geometry validator.
      const offset = instance * 16;
      const localCenterX = (minX + maxX) / 2, localCenterY = (minY + maxY) / 2, localCenterZ = (minZ + maxZ) / 2;
      const center = apply(transforms, offset, localCenterX, localCenterY, localCenterZ);
      const sx = (maxX - minX) / 2, sy = (maxY - minY) / 2, sz = (maxZ - minZ) / 2;
      const halfAxes = Object.freeze([
        Object.freeze({ x: transforms[offset] * sx, y: transforms[offset + 1] * sx, z: transforms[offset + 2] * sx }),
        Object.freeze({ x: transforms[offset + 4] * sy, y: transforms[offset + 5] * sy, z: transforms[offset + 6] * sy }),
        Object.freeze({ x: transforms[offset + 8] * sz, y: transforms[offset + 9] * sz, z: transforms[offset + 10] * sz }),
      ]) as unknown as readonly [P3, P3, P3];
      solidInputs.push(Object.freeze({ id: `${solid.id}#${instance}`, role: `rendered-${solid.role}`, kind: "box",
        center: Object.freeze(center), halfAxes }));
      // StructureObstacle's role is an opaque reporting label for the collision
      // index; rendered roles are namespaced to stay distinguishable in reports.
      out.push({ id: `${solid.id}#${instance}`, role: `rendered-${solid.role}` as StructureObstacle["role"], shape: "box", corners } as StructureObstacle);
      instances += 1;
    }
  }
  return Object.freeze({ status: "ready", obstacles: Object.freeze(out), solidInputs: Object.freeze(solidInputs), instances, skippedDegenerate });
}
