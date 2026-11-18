import type {
  CityAnchorV1,
  CityAnchorLinkV1,
  CityLayoutSnapshotV3,
} from "../../../../../../packages/agent-vitals-city-sdk/src/types";
import type {
  RouteV1,
  TerrainSampleV1,
  Vec3V1,
  WorldAnchorV1,
  WorldBoundsV1,
  WorldObjectV1,
} from "../../../../../../packages/city-game-sdk/src/api/types";
import type { WorldSourceV1 } from "../../../../../../packages/city-game-sdk/src/host/types";

/**
 * Projects a published City layout snapshot into the SDK's WorldSource.
 *
 * Two rules matter more than the projection itself:
 *
 * 1. **v3 or nothing.** v2 snapshots carry anchors but not their geometry, so a
 *    route could only be fabricated from anchor ids. The PRD forbids inventing
 *    a path when no trusted topology exists — creation fails instead.
 * 2. **Terrain is injected.** The snapshot deliberately does not serialize
 *    terrain. A caller that has no sampler gets `null` from sampleTerrain (a
 *    diagnosable `game_world_object_missing`), never height 0 as if measured.
 *
 * Routes are maximal chains over capability-scoped anchor links. This is a P0
 * projection of the trusted anchor graph, not the City's rendered road splines:
 * a future NavigationAPI can replace it without changing the game-facing API.
 */

export type CityLayoutWorldSourceOptionsV1 = Readonly<{
  snapshot: CityLayoutSnapshotV3;
  /** Which traversal capability defines a route. Tower-defense enemies walk. */
  capability?: "walk" | "drive";
  /** Live terrain sampler supplied by the City host; omitted in snapshot-only
   * headless runs, where sampleTerrain honestly reports unavailability. */
  terrain?: (x: number, z: number) => TerrainSampleV1 | null;
}>;

export function createCityLayoutWorldSourceV1(options: CityLayoutWorldSourceOptionsV1): WorldSourceV1 {
  const { snapshot } = options;
  if (snapshot.schemaVersion !== 3) {
    throw new Error(
      `Code games require a v3 City layout snapshot (got schemaVersion ${String(
        (snapshot as { schemaVersion?: unknown }).schemaVersion,
      )}); v2 has no anchor geometry.`,
    );
  }
  const capability = options.capability ?? "walk";
  const geometry = new Map(snapshot.geometry.map((entry) => [entry.geometryRef, entry.positionMeters]));
  const anchors = snapshot.layout.anchors.filter((anchor) => geometry.has(anchor.geometryRef));
  const positionOf = (anchor: CityAnchorV1): Readonly<{ x: number; y: number; z: number }> => {
    const position = geometry.get(anchor.geometryRef);
    if (!position) throw new Error(`Anchor ${anchor.id} has no geometry; the snapshot is inconsistent.`);
    return position;
  };

  const routes = buildRoutes(anchors, snapshot.layout.links ?? [], capability, positionOf);
  const worldAnchors: readonly WorldAnchorV1[] = Object.freeze(
    anchors.map((anchor) =>
      Object.freeze({
        id: anchor.id,
        kind: anchor.kind,
        position: toVec3(positionOf(anchor)),
      }),
    ),
  );

  return Object.freeze({
    city: () =>
      Object.freeze({
        cityId: snapshot.cityId,
        seed: snapshot.seed,
        worldRevision: snapshot.worldRevision,
        layoutId: snapshot.layout.id,
      }),
    listRoutes: () => routes,
    getRoute: (routeId: string) => routes.find((route) => route.id === routeId) ?? null,
    sampleTerrain: (x: number, z: number) => (options.terrain ? options.terrain(x, z) : null),
    listAnchors: () => worldAnchors,
    queryObjects: (bounds: WorldBoundsV1) =>
      Object.freeze(
        worldAnchors
          .filter((anchor) => anchor.kind === "object" || anchor.kind === "zone")
          .filter((anchor) => pointInside(anchor.position, bounds))
          .map((anchor) =>
            Object.freeze({
              id: anchor.id,
              kind: anchor.kind,
              position: anchor.position,
              bounds: Object.freeze({ min: anchor.position, max: anchor.position }),
            }),
          ),
      ),
  });
}

function buildRoutes(
  anchors: readonly CityAnchorV1[],
  links: readonly CityAnchorLinkV1[],
  capability: "walk" | "drive",
  positionOf: (anchor: CityAnchorV1) => Readonly<{ x: number; y: number; z: number }>,
): readonly RouteV1[] {
  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const adjacency = new Map<string, string[]>();
  for (const link of links) {
    if (!link.capabilities.includes(capability)) continue;
    if (!byId.has(link.fromAnchorId) || !byId.has(link.toAnchorId)) continue;
    append(adjacency, link.fromAnchorId, link.toAnchorId);
    append(adjacency, link.toAnchorId, link.fromAnchorId);
  }

  const routes: RouteV1[] = [];
  const visited = new Set<string>();
  const pushRoute = (chain: readonly string[]): void => {
    if (chain.length < 2) return;
    const head = byId.get(chain[0]);
    routes.push(
      Object.freeze({
        id: `route-${head?.id ?? chain[0]}`,
        points: Object.freeze(
          chain.map((id) => {
            const anchor = byId.get(id);
            if (!anchor) throw new Error(`Link references unknown anchor ${id}.`);
            return toVec3(positionOf(anchor));
          }),
        ),
      }),
    );
  };

  // Prefer a spawn anchor as the chain head so a route reads in travel order
  // and its id is stable (route-<spawn>), then fall back to lexicographic order.
  const headRank = (id: string): number => (byId.get(id)?.kind === "spawn" ? 0 : 1);
  const starts = [...adjacency.keys()]
    .filter((id) => (adjacency.get(id)?.length ?? 0) === 1)
    .sort((left, right) => headRank(left) - headRank(right) || left.localeCompare(right));

  for (const start of starts) {
    if (visited.has(start)) continue;
    pushRoute(walkChain(start, adjacency, visited));
  }

  // Cycles have no degree-1 endpoint; expose one deterministic chain per
  // remaining component so a closed loop is still playable.
  for (const id of [...adjacency.keys()].sort((left, right) => left.localeCompare(right))) {
    if (visited.has(id)) continue;
    pushRoute(walkChain(id, adjacency, visited));
  }

  return Object.freeze(routes);
}

function walkChain(start: string, adjacency: ReadonlyMap<string, string[]>, visited: Set<string>): string[] {
  const chain: string[] = [];
  let current: string | undefined = start;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    const next: string | undefined = (adjacency.get(current) ?? [])
      .filter((candidate) => !visited.has(candidate))
      .sort((left, right) => left.localeCompare(right))[0];
    current = next;
  }
  return chain;
}

function append(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function toVec3(position: Readonly<{ x: number; y: number; z: number }>): Vec3V1 {
  return Object.freeze([position.x, position.y, position.z]) as Vec3V1;
}

function pointInside(point: Vec3V1, bounds: WorldBoundsV1): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if ((point[axis] as number) < (bounds.min[axis] as number)) return false;
    if ((point[axis] as number) > (bounds.max[axis] as number)) return false;
  }
  return true;
}
