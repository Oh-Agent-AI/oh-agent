/**
 * Travel modes, City capabilities and Game permissions are different axes.
 * V1 used the same strings for its small world capability/permission subset;
 * V2 keeps those strings only in the explicit compatibility adapter.
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

export const WORLD_CAPABILITIES_V2 = [
  "world.snapshot",
  "roads.graph",
  "terrain.heightfield",
  "environment.parameters",
  "sites.indexed",
  "objects.indexed",
  "volumes.indexed",
  "navigation.surface",
  "navigation.volume",
  "appearance.profiles",
  "time.simulation",
  "residents.registry",
  "places.registry",
] as const;
export type WorldCapabilityV2 = (typeof WORLD_CAPABILITIES_V2)[number];

export const GAME_PERMISSIONS_V2 = [
  "world.read",
  "roads.read",
  "terrain.sample",
  "environment.read",
  "sites.read",
  "objects.read",
  "volumes.read",
  "navigation.query",
  "appearance.read",
  "time.read",
  "residents.read",
  "places.read",
  "entities.write.owned",
  "input.read",
  "ui.hud",
  "audio.play.assets",
  "ui.dialogue",
  "storage.game",
  "story.schedule",
  "actors.interact",
] as const;
export type GamePermissionV2 = (typeof GAME_PERMISSIONS_V2)[number];

export const V1_CAPABILITY_MAP_V2 = Object.freeze({
  "world.read": "world.snapshot",
  "roads.read": "roads.graph",
  "terrain.sample": "terrain.heightfield",
} as const satisfies Readonly<Record<WorldCapabilityV1, WorldCapabilityV2>>);

export const PERMISSION_CAPABILITY_MAP_V2 = Object.freeze({
  "world.read": "world.snapshot",
  "roads.read": "roads.graph",
  "terrain.sample": "terrain.heightfield",
  "environment.read": "environment.parameters",
  "sites.read": "sites.indexed",
  "objects.read": "objects.indexed",
  "volumes.read": "volumes.indexed",
  "appearance.read": "appearance.profiles",
  "time.read": "time.simulation",
  "residents.read": "residents.registry",
  "places.read": "places.registry",
} as const satisfies Readonly<Partial<Record<GamePermissionV2, WorldCapabilityV2>>>);

export function capabilityForPermissionV2(
  permission: GamePermissionV2,
): WorldCapabilityV2 | "navigation" | null {
  if (permission === "navigation.query") return "navigation";
  return (PERMISSION_CAPABILITY_MAP_V2 as Readonly<Partial<Record<GamePermissionV2, WorldCapabilityV2>>>)[
    permission
  ] ?? null;
}

export function permissionForCapabilityV2(capability: WorldCapabilityV2): GamePermissionV2 {
  if (capability === "navigation.surface" || capability === "navigation.volume") return "navigation.query";
  for (const [permission, mapped] of Object.entries(PERMISSION_CAPABILITY_MAP_V2)) {
    if (mapped === capability) return permission as GamePermissionV2;
  }
  throw new Error(`No Game permission is mapped to City capability "${capability}".`);
}

export function isWorldCapability(value: unknown): value is WorldCapabilityV1 {
  return typeof value === "string" && (WORLD_CAPABILITIES_V1 as readonly string[]).includes(value);
}

export function isGamePermission(value: unknown): value is GamePermissionV1 {
  return typeof value === "string" && (GAME_PERMISSIONS_V1 as readonly string[]).includes(value);
}

export function isWorldCapabilityV2(value: unknown): value is WorldCapabilityV2 {
  return typeof value === "string" && (WORLD_CAPABILITIES_V2 as readonly string[]).includes(value);
}

export function isGamePermissionV2(value: unknown): value is GamePermissionV2 {
  return typeof value === "string" && (GAME_PERMISSIONS_V2 as readonly string[]).includes(value);
}
