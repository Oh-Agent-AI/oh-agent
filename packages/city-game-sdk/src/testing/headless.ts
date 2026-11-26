import type { GameDefinitionV1 } from "../api/defineGame";
import type {
  CitySnapshotV1,
  RouteV1,
  TerrainSampleV1,
  WorldAnchorV1,
  WorldBoundsV1,
  WorldObjectV1,
} from "../api/types";
import { CodeGameHostV1, createCodeGameHostV1 } from "../host/codeGameHost";
import type { GameTelemetryV1, WorldSourceV1 } from "../host/types";
import type { CodeGameAssetV1, CodeGameManifestV1 } from "../protocol/manifest";
import { validateCodeGameManifestV1 } from "../protocol/manifest";
import type { GamePermissionV1, WorldCapabilityV1 } from "../protocol/permissions";
import { GAME_PERMISSIONS_V1, WORLD_CAPABILITIES_V1 } from "../protocol/permissions";
import { CITY_GAME_SDK_API_MAJOR, CITY_GAME_SDK_PACKAGE } from "../protocol/version";

export type GameTestWorldOptionsV1 = Readonly<{
  cityId?: string;
  seed?: number;
  worldRevision?: string;
  layoutId?: string | null;
  routes?: readonly RouteV1[];
  anchors?: readonly WorldAnchorV1[];
  objects?: readonly WorldObjectV1[];
  terrain?: (x: number, z: number) => TerrainSampleV1 | null;
}>;

export type TestManifestOverridesV1 = Readonly<{
  displayName?: string;
  version?: string;
  entry?: string;
  world?: Readonly<{ requiredCapabilities?: readonly WorldCapabilityV1[]; layoutId?: string }>;
  permissions?: readonly GamePermissionV1[];
  limits?: Readonly<{ maxEntities?: number; maxProjectiles?: number }>;
  assets?: readonly CodeGameAssetV1[];
}>;

export type GameTestRunV1 = Readonly<{
  host: CodeGameHostV1;
  runId: string;
  /** One authoritative tick per call, same as the City frame hook. */
  step(times?: number): void;
  /** Alias used by the spec's headless example (§9.3). */
  advanceTicks(ticks: number): void;
  telemetry(): GameTelemetryV1;
  dispose(): void;
  assertNoLeakedEntities(): void;
}>;

export type GameTestWorldV1 = Readonly<{
  source: WorldSourceV1;
  launch(
    definition: GameDefinitionV1,
    options?: Readonly<{
      seed?: number;
      runId?: string;
      fixedDtSeconds?: number;
      /** Already-shaped manifest. When omitted a permissive test manifest is
       * derived from the definition id and `manifestOverrides`. */
      manifest?: unknown;
      manifestOverrides?: TestManifestOverridesV1;
    }>,
  ): Promise<GameTestRunV1>;
}>;

const DEFAULT_ROUTE: RouteV1 = Object.freeze({
  id: "test-road",
  points: Object.freeze([
    Object.freeze([0, 0, 0] as const),
    Object.freeze([10, 0, 0] as const),
    Object.freeze([20, 0, 0] as const),
  ]),
});

/** A permissive manifest for unit tests: every permission, a small budget and
 * one declared prefab. It still goes through the real validator, so a test
 * cannot pass against a manifest shape production would reject. */
export function createTestManifest(gameId: string, overrides: TestManifestOverridesV1 = {}): CodeGameManifestV1 {
  const candidate = {
    schemaVersion: 1,
    kind: "code-game",
    gameId,
    displayName: overrides.displayName ?? gameId,
    version: overrides.version ?? "0.1.0",
    entry: overrides.entry ?? "src/index.ts",
    sdk: { name: CITY_GAME_SDK_PACKAGE, apiMajor: CITY_GAME_SDK_API_MAJOR },
    world: {
      requiredCapabilities: overrides.world?.requiredCapabilities ?? [...WORLD_CAPABILITIES_V1],
      ...(overrides.world?.layoutId !== undefined ? { layoutId: overrides.world.layoutId } : {}),
    },
    permissions: overrides.permissions ?? [...GAME_PERMISSIONS_V1],
    limits: {
      maxEntities: overrides.limits?.maxEntities ?? 64,
      maxProjectiles: overrides.limits?.maxProjectiles ?? 32,
    },
    assets: overrides.assets ?? [
      { id: "test-cube", path: "assets/test-cube.glb", type: "model/glb" as const },
    ],
  };
  const parsed = validateCodeGameManifestV1(candidate);
  if (!parsed.ok) {
    throw new Error(
      `Test manifest for "${gameId}" is invalid: ${parsed.diagnostics.map((item) => item.message).join(" ")}`,
    );
  }
  return parsed.value;
}

/**
 * Headless City stand-in. `launch()` prepares and starts the exact production
 * host — there is no second lifecycle implementation here, so a test cannot
 * pass while the City path fails for a different reason.
 */
export function createGameTestWorld(options: GameTestWorldOptionsV1 = {}): GameTestWorldV1 {
  const city: CitySnapshotV1 = Object.freeze({
    cityId: options.cityId ?? "test-city",
    seed: options.seed ?? 42,
    worldRevision: options.worldRevision ?? "world-1",
    layoutId: options.layoutId ?? null,
  });
  const routes = options.routes ?? [DEFAULT_ROUTE];
  const anchors = options.anchors ?? [];
  const objects = options.objects ?? [];
  const terrain =
    options.terrain ??
    ((): TerrainSampleV1 => Object.freeze({ height: 0, normal: Object.freeze([0, 1, 0] as const), walkable: true }));

  const source: WorldSourceV1 = Object.freeze({
    city: () => city,
    listRoutes: () => routes,
    getRoute: (routeId: string) => routes.find((route) => route.id === routeId) ?? null,
    sampleTerrain: (x: number, z: number) => terrain(x, z),
    listAnchors: () => anchors,
    queryObjects: (bounds: WorldBoundsV1) => objects.filter((object) => intersects(object.bounds, bounds)),
  });

  return Object.freeze({
    source,
    async launch(definition, launchOptions = {}) {
      const seed = launchOptions.seed ?? city.seed;
      const host =
        launchOptions.manifest !== undefined
          ? createCodeGameHostV1(launchOptions.manifest, {
              world: source,
              seed,
              ...(launchOptions.runId !== undefined ? { runId: launchOptions.runId } : {}),
              ...(launchOptions.fixedDtSeconds !== undefined
                ? { fixedDtSeconds: launchOptions.fixedDtSeconds }
                : {}),
            })
          : new CodeGameHostV1({
              manifest:
                launchOptions.manifestOverrides !== undefined
                  ? createTestManifest(definition.id, launchOptions.manifestOverrides)
                  : createTestManifest(definition.id),
              world: source,
              seed,
              ...(launchOptions.runId !== undefined ? { runId: launchOptions.runId } : {}),
              ...(launchOptions.fixedDtSeconds !== undefined
                ? { fixedDtSeconds: launchOptions.fixedDtSeconds }
                : {}),
            });
      await host.prepare(definition);
      host.start();
      const run: GameTestRunV1 = Object.freeze({
        host,
        runId: host.runId,
        step(times = 1) {
          for (let index = 0; index < times; index += 1) host.step();
        },
        advanceTicks(ticks: number) {
          for (let index = 0; index < ticks; index += 1) host.step();
        },
        telemetry: () => host.telemetry(),
        dispose: () => host.dispose(),
        assertNoLeakedEntities() {
          if (host.entityCount !== 0) {
            throw new Error(`Run leaked ${host.entityCount} entity/entities after dispose.`);
          }
        },
      });
      return run;
    },
  });
}

function intersects(object: WorldBoundsV1, query: WorldBoundsV1): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if ((object.max[axis] as number) < (query.min[axis] as number)) return false;
    if ((object.min[axis] as number) > (query.max[axis] as number)) return false;
  }
  return true;
}
