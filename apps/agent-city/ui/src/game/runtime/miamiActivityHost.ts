/**
 * App-side bridge for the Miami legacy activity adapters. The host callbacks are
 * deliberately injected: CityApp still owns admission/leases/camera/HUD and this
 * module only gives the runtime SDK a stable registry seam. A later slice wires
 * these entries to useCityGame/useCityDrivingPlay/mecha/cinema without changing
 * their behavior.
 */
import {
  createMiamiLegacyRegistry,
  type GameRuntimeRegistryV1,
  type MiamiActivityIdV1,
  type MiamiLegacyActivityHandleV1,
  type MiamiLegacyActivityHostV1,
  type GameRuntimeResultV1,
} from "../../../../../../packages/agent-vitals-city-game-runtime/src/index";

export type MiamiActivityEntriesV1 = Readonly<Record<MiamiActivityIdV1,
  () => Promise<GameRuntimeResultV1<MiamiLegacyActivityHandleV1>>>>;

export function createMiamiActivityHost(entries: MiamiActivityEntriesV1): MiamiLegacyActivityHostV1 {
  return Object.freeze({ enter: (activity: MiamiActivityIdV1) => entries[activity]() });
}

export function createMiamiGameRuntimeRegistry(entries: MiamiActivityEntriesV1): GameRuntimeRegistryV1 {
  return createMiamiLegacyRegistry(createMiamiActivityHost(entries));
}
