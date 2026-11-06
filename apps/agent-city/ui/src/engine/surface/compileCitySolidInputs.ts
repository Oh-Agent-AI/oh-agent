/** One deterministic compiler for the city's static collision facts.
 *
 * Structural descriptors, approved scene proxies and rendered-solid envelopes are
 * combined here so admission, diagnostics and other vehicle queries use the same
 * identities and source coverage. The world-build cap is independent of the
 * CollisionIndex's 4096-candidate per-query cap.
 */
import { renderedSolidsToObstacles, RENDERED_OBSTACLE_LIMITS } from "./renderedSolidObstacles";
import type { StructureObstacle } from "./compileSurface";
import { boxSolidFromCorners, buildVersionedCollisionIndex, type CollisionIndex, type SolidInput } from "../../game/driving/CollisionIndex";
import { CITY_SOLID_COMPILER_VERSION, CITY_SOLID_QUERY_CANDIDATE_BUDGET } from "../../game/driving/staticSolidContracts";

export { CITY_SOLID_COMPILER_VERSION, CITY_SOLID_QUERY_CANDIDATE_BUDGET } from "../../game/driving/staticSolidContracts";
export const CITY_SOLID_BUILD_BUDGET = 60_000;
export type CitySolidInputSnapshot = Readonly<{ revision: string; obstacles: readonly StructureObstacle[];
  sceneSolids: readonly SolidInput[]; renderedSolids: CityDrivingSnapshotRenderedSolids; }>;
type CityDrivingSnapshotRenderedSolids = readonly import("./renderedSolidTypes").RenderedSolid[];

export type CitySolidCompilation = Readonly<{
  status: "ready";
  compilerVersion: number;
  solids: readonly SolidInput[];
  /** Geometry-validated index from the exact returned solids. */
  collisionIndex: CollisionIndex;
  coverage: "structures-only" | "structures-and-scene-proxies" | "structures-and-buildings" | "structures-and-buildings-and-scene-proxies";
  counts: Readonly<{ structures: number; sceneProxies: number; renderedSolids: number; renderedInstances: number; total: number;
    buildBudget: number; queryCandidateBudget: number }>;
}> | Readonly<{ status: "unavailable"; reason: string }>;

function descriptor(obstacle: StructureObstacle): SolidInput {
  // mountableHeight 必须透传：桥面唇边/岛缘的可越语义在 SolidInput→索引→env 全链依赖它，
  // 任何一环丢弃都会让真实会话里桥头台阶变成撞不破的墙（合成测试直连索引测不到这条路）。
  return obstacle.shape === "box"
    ? { ...boxSolidFromCorners(obstacle.id, obstacle.role, obstacle.corners), ...(obstacle.mountableHeight === undefined ? {} : { mountableHeight: obstacle.mountableHeight }) }
    : { id: obstacle.id, role: obstacle.role, kind: "prism", ring: obstacle.ring, yMin: obstacle.yMin, yMax: obstacle.yMax, ...(obstacle.mountableHeight === undefined ? {} : { mountableHeight: obstacle.mountableHeight }) };
}
function freezeInput(solid: SolidInput): SolidInput {
  return solid.kind === "box"
    ? Object.freeze({ ...solid, center: Object.freeze({ ...solid.center }),
      halfAxes: Object.freeze(solid.halfAxes.map((axis) => Object.freeze({ ...axis }))) as unknown as typeof solid.halfAxes })
    : Object.freeze({ ...solid, ring: Object.freeze(solid.ring.map((point) => Object.freeze({ ...point }))) });
}

export function compileCitySolidInputs(
  world: CitySolidInputSnapshot,
  buildBudget = CITY_SOLID_BUILD_BUDGET,
  indexRevision = world.revision,
): CitySolidCompilation {
  if (!Number.isSafeInteger(buildBudget) || buildBudget < 1 || buildBudget > CITY_SOLID_BUILD_BUDGET) return { status: "unavailable", reason: "invalid-solid-build-budget" };
  if (world.obstacles.length + world.sceneSolids.length > buildBudget) return { status: "unavailable", reason: "scene-solids-over-budget" };
  const rendered = renderedSolidsToObstacles(world.renderedSolids, {
    obstacles: Math.max(0, buildBudget - world.obstacles.length - world.sceneSolids.length),
    solids: RENDERED_OBSTACLE_LIMITS.solids,
  });
  if (rendered.status !== "ready") return { status: "unavailable", reason: rendered.reason };
  const total = world.obstacles.length + world.sceneSolids.length + rendered.obstacles.length;
  if (total > buildBudget) return { status: "unavailable", reason: "scene-solids-over-budget" };

  const combined: SolidInput[] = [];
  for (const obstacle of world.obstacles) combined.push(descriptor(obstacle));
  combined.push(...world.sceneSolids);
  combined.push(...rendered.solidInputs);
  combined.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const ids = new Set<string>();
  for (const solid of combined) {
    if (!solid.id || ids.has(solid.id)) return { status: "unavailable", reason: "duplicate-static-solid-id" };
    ids.add(solid.id);
  }
  const frozenSolids = Object.freeze(combined.map(freezeInput));
  if (!indexRevision) return { status: "unavailable", reason: "invalid-static-world-revision" };
  const collision = buildVersionedCollisionIndex(indexRevision, frozenSolids);
  if (collision.status !== "ready") return { status: "unavailable", reason: `invalid-static-solid-geometry:${collision.reason}` };

  const hasProxies = world.sceneSolids.length > 0;
  const hasBuildings = rendered.obstacles.length > 0;
  const coverage = hasBuildings
    ? (hasProxies ? "structures-and-buildings-and-scene-proxies" : "structures-and-buildings")
    : (hasProxies ? "structures-and-scene-proxies" : "structures-only");
  return Object.freeze({ status: "ready", compilerVersion: CITY_SOLID_COMPILER_VERSION,
    solids: frozenSolids, collisionIndex: collision.index, coverage,
    counts: Object.freeze({ structures: world.obstacles.length, sceneProxies: world.sceneSolids.length,
      renderedSolids: world.renderedSolids.length, renderedInstances: rendered.instances, total,
      buildBudget, queryCandidateBudget: CITY_SOLID_QUERY_CANDIDATE_BUDGET }) });
}
