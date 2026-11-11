/** Optional coastal road composition. World planning owns the capability gate;
 * coastal algorithms stay isolated behind this adapter. */
import { buildCoastalRingRoads, type CoastalRingRoadWorld, type CoastalRingRoadParams } from "./coastalRingRoad";
import { buildSeasideBoulevard, type SeasideBoulevardWorld, type SeasideBoulevardParams } from "./seasideBoulevard";
import type { Vec2 } from "../cityLayout";
import type { SeasideBand } from "../citySeaside";

export type CoastalRoadSystemInput =
  | { enabled: false }
  | { enabled: true;
      seaside: { world: SeasideBoulevardWorld; params: SeasideBoulevardParams };
      ring: { world: CoastalRingRoadWorld; params: CoastalRingRoadParams } };
export type CoastalRoadSystemResult = {
  seaside: SeasideBand | null;
  coastalRoadRuns: Vec2[][];
  trimmedTrunkEnds: Vec2[];
  coastRoadRuns: Vec2[][];
  coastalRunCount: number;
};

export function buildCoastalRoadSystem(input: CoastalRoadSystemInput): CoastalRoadSystemResult {
  if (!input.enabled) return { seaside: null, coastalRoadRuns: [], trimmedTrunkEnds: [], coastRoadRuns: [], coastalRunCount: 0 };
  const seasideResult = buildSeasideBoulevard(input.seaside.world, input.seaside.params);
  const ringResult = buildCoastalRingRoads(input.ring.world, { ...input.ring.params, seaside: seasideResult.seaside });
  return { ...seasideResult, ...ringResult };
}
