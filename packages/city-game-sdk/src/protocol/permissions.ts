/**
 * Two vocabularies already exist in the City stack and they must not be merged:
 *
 * - `drive | walk | fly` are *layout anchor capabilities* (where an activity may
 *   start). They live in `@agent-vitals/city-sdk` and are not permissions.
 * - the strings below are *host permissions* for code games. A manifest grants
 *   them; every host API re-checks the grant at call time, because TypeScript
 *   types are erased and a compiled bundle can call anything.
 *
 * A required world capability must also be granted, otherwise the manifest is
 * self-contradictory and is rejected at validation time.
 */
export const WORLD_CAPABILITIES_V1 = ["world.read", "roads.read", "terrain.sample"] as const;
export type WorldCapabilityV1 = (typeof WORLD_CAPABILITIES_V1)[number];

export const GAME_PERMISSIONS_V1 = [
  ...WORLD_CAPABILITIES_V1,
  "entities.write.owned",
  "input.read",
  "ui.hud",
  "audio.play.assets",
] as const;
export type GamePermissionV1 = (typeof GAME_PERMISSIONS_V1)[number];

export function isWorldCapability(value: unknown): value is WorldCapabilityV1 {
  return typeof value === "string" && (WORLD_CAPABILITIES_V1 as readonly string[]).includes(value);
}

export function isGamePermission(value: unknown): value is GamePermissionV1 {
  return typeof value === "string" && (GAME_PERMISSIONS_V1 as readonly string[]).includes(value);
}
