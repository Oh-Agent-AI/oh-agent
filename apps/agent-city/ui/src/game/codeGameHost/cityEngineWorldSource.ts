import type {
  RouteV1,
  TerrainSampleV1,
  Vec3V1,
  WorldAnchorV1,
  WorldBoundsV1,
  WorldObjectV1,
} from "../../../../../../packages/city-game-sdk/src/api/types";
import type { WorldSourceV1 } from "../../../../../../packages/city-game-sdk/src/host/types";
import type { CityBlock, RoadEdge, RoadNode, TerrainField } from "../../engine/cityLayout";

/**
 * Live-City counterpart of `createCityLayoutWorldSourceV1`: it projects the
 * *current* generated layout (road edges, terrain field, blocks) instead of a
 * published snapshot. P0 preview must use this, otherwise a game would run
 * against a stale snapshot while the player looks at a different City.
 *
 * Only arterial road edges become routes: they are the accepted main network,
 * not decorative local streets, and the PRD forbids inventing a path from
 * generator data that was never accepted.
 */

export type CityEngineWorldLayoutV1 = Readonly<{
  seed: number;
  terrain: Pick<TerrainField, "height" | "buildable">;
  roadEdges: readonly RoadEdge[];
  roadNodes?: readonly RoadNode[];
  blocks?: readonly Pick<CityBlock, "id" | "x" | "z" | "width" | "depth">[];
}>;

export type CityEngineWorldSourceOptionsV1 = Readonly<{
  cityId: string;
  cityRevision: number;
  worldRevision: string;
  layoutId: string;
  layout: CityEngineWorldLayoutV1;
}>;

const MAX_ROUTES = 16;
const MAX_POINTS_PER_ROUTE = 256;
const MAX_ANCHORS = 256;
const MAX_BLOCKS = 128;

export function createCityEngineWorldSourceV1(options: CityEngineWorldSourceOptionsV1): WorldSourceV1 {
  const { layout } = options;
  const heightAt = (x: number, z: number): number => layout.terrain.height(x, z);

  const routes: readonly RouteV1[] = Object.freeze(
    [...layout.roadEdges]
      .filter((edge) => edge.kind === "arterial" && edge.points.length >= 2)
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, MAX_ROUTES)
      .map((edge) =>
        Object.freeze({
          id: `road-${edge.id}`,
          points: Object.freeze(
            edge.points
              .slice(0, MAX_POINTS_PER_ROUTE)
              .map((point) => toVec3(point.x, heightAt(point.x, point.z), point.z)),
          ),
        }),
      ),
  );

  const anchors: readonly WorldAnchorV1[] = Object.freeze(
    (layout.roadNodes ?? []).slice(0, MAX_ANCHORS).map((node) =>
      Object.freeze({
        id: node.id,
        kind: "route" as const,
        position: toVec3(node.x, heightAt(node.x, node.z), node.z),
      }),
    ),
  );

  const blocks = layout.blocks ?? [];

  return Object.freeze({
    city: () =>
      Object.freeze({
        cityId: options.cityId,
        seed: layout.seed,
        worldRevision: options.worldRevision,
        layoutId: options.layoutId,
      }),
    listRoutes: () => routes,
    getRoute: (routeId: string) => routes.find((route) => route.id === routeId) ?? null,
    sampleTerrain: (x: number, z: number): TerrainSampleV1 | null => {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
      const epsilon = 0.5;
      const dx = (heightAt(x + epsilon, z) - heightAt(x - epsilon, z)) / (2 * epsilon);
      const dz = (heightAt(x, z + epsilon) - heightAt(x, z - epsilon)) / (2 * epsilon);
      const length = Math.hypot(dx, 1, dz);
      return Object.freeze({
        height: heightAt(x, z),
        normal: Object.freeze([-dx / length, 1 / length, -dz / length]) as unknown as Vec3V1,
        walkable: layout.terrain.buildable(x, z),
      });
    },
    listAnchors: () => anchors,
    queryObjects: (bounds: WorldBoundsV1): readonly WorldObjectV1[] =>
      Object.freeze(
        blocks
          .slice(0, MAX_BLOCKS)
          .map((block) => {
            const y = heightAt(block.x, block.z);
            return Object.freeze({
              id: block.id,
              kind: "block" as const,
              position: toVec3(block.x, y, block.z),
              bounds: Object.freeze({
                min: toVec3(block.x - block.width / 2, y - 1, block.z - block.depth / 2),
                max: toVec3(block.x + block.width / 2, y + 8, block.z + block.depth / 2),
              }),
            });
          })
          .filter((object) => intersects(object.bounds, bounds)),
      ),
  });
}

function toVec3(x: number, y: number, z: number): Vec3V1 {
  return Object.freeze([x, y, z]) as Vec3V1;
}

function intersects(object: WorldBoundsV1, query: WorldBoundsV1): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if ((object.max[axis] as number) < (query.min[axis] as number)) return false;
    if ((object.min[axis] as number) > (query.max[axis] as number)) return false;
  }
  return true;
}
