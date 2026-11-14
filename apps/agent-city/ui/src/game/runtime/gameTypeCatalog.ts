/**
 * App-side catalog for the new game-runtime SDK. Descriptors are data-only;
 * the actual Miami adapters are registered here once they are wrapped. No
 * runtime implementation is registered yet, so this module must not be used to
 * start a game.
 */
import { createGameRuntimeRegistry, MIAMI_ACTIVITY_CATALOG_V1, ORNITHOPTER_GAME_TYPE_V1, type GameRuntimeRegistryV1 } from "@agent-vitals/city-game-runtime";

export const CITY_GAME_TYPE_CATALOG = Object.freeze([...MIAMI_ACTIVITY_CATALOG_V1, ORNITHOPTER_GAME_TYPE_V1]);

/** New registry per app session; adapters will be registered by the activity
 * layer as they are wrapped. Keeping it empty is deliberate: unknown game
 * types fail closed instead of silently falling back to driving/flight. */
export function createCityGameRuntimeRegistry(): GameRuntimeRegistryV1 {
  return createGameRuntimeRegistry();
}
