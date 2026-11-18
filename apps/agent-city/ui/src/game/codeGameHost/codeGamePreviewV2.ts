import type { Object3D } from "three";
import type { CodeGameManifestV2 } from "../../../../../../packages/city-game-sdk/src/protocol/manifestV2";
import { createGameAccessV1, type HostGrantV1 } from "../../../../../../packages/city-game-sdk/src/protocol/access";
import { createSnapshotWorldAPIV2 } from "../../../../../../packages/city-game-sdk/src/host/snapshotWorld";
import { defineGameV2 } from "../../../../../../packages/city-game-sdk/src/api/v2";
import type { CodeGameTelemetryV2 } from "./codeGameSessionV2";
import { CodeGameRunV2 } from "./codeGameSessionV2";
import { InstalledGameRegistryV1, InteractionRouter, type GameLaunchRequestV1 } from "../../../../../../packages/agent-vitals-city-game-runtime/src/interaction";
import { createCitySnapshotV4 } from "./citySnapshot";
import { createThreeCodeGameRender } from "./threeRenderPort";
import type { CityEngine } from "../../engine/CityEngine";
import type { CityActivityCoordinator } from "../activity/CityActivityCoordinator";

export type CodeGamePreviewStartV2 = Readonly<{
  definition: unknown;
  manifest: CodeGameManifestV2;
  engine: CityEngine;
  coordinator: CityActivityCoordinator;
  seed?: number;
  buildId?: string;
  cityId?: string;
  cityRevision?: number;
  assetBaseUrl?: string;
  nowMs?: () => number;
  onStop: (event: Readonly<{ reason: string; telemetry: CodeGameTelemetryV2 }>) => void;
}>;

export async function startCodeGamePreviewV2(input: CodeGamePreviewStartV2): Promise<CodeGameRunV2<Object3D>> {
  const definition = defineGameV2(input.definition as Parameters<typeof defineGameV2>[0]);
  const view = input.engine.getCitySdkLayoutView();
  const layout = input.engine.currentLayout;
  if (!view || !layout) throw new Error("City layout is not ready.");
  const snapshot = createCitySnapshotV4({
    cityId: input.cityId ?? "city:live-preview",
    cityRevision: input.cityRevision ?? layout.derivedNetworkVersion ?? 0,
    layout,
    view,
  });
  const world = createSnapshotWorldAPIV2(snapshot, {
    terrain: (x, z) => ({
      height: layout.terrain.height(x, z),
      normal: [0, 1, 0],
      walkable: layout.terrain.buildable(x, z),
    }),
  });
  const launchId = input.buildId ? `launch-${input.buildId}` : crypto.randomUUID();
  const playerScope = { playerId: `preview-${snapshot.header.cityId}`, kind: "local-profile" } as const;
  const grant: HostGrantV1<typeof playerScope> = {
    installationId: input.buildId ?? `preview-${launchId}`,
    runId: launchId,
    playerScope,
    grantedPermissions: input.manifest.permissions,
    status: "active",
  };
  const registry = new InstalledGameRegistryV1();
  registry.register({
    installationId: grant.installationId,
    gameId: input.manifest.gameId,
    gameVersion: input.manifest.version,
    kind: "code",
    ...(input.buildId ? { buildId: input.buildId } : {}),
    contentDigest: input.buildId ?? `sha256:${"0".repeat(64)}`,
    trustLevel: "local-trusted",
    status: "installed",
    entries: input.manifest.entries.map((entry) => ({ id: entry.id, presentations: entry.presentation })),
  });
  let launched: CodeGameRunV2<Object3D> | null = null;
  const router = new InteractionRouter(registry, {
    declarative: { launch: start },
    "legacy-runtime": { launch: start },
    code: { launch: start },
    revisions: () => ({
      worldRevision: snapshot.header.revisions.worldRevision,
      interactionRevision: snapshot.header.revisions.interactionRevision,
    }),
  });
  const request: GameLaunchRequestV1 = {
    launchId,
    cityId: snapshot.header.cityId,
    cityRevision: snapshot.header.cityRevision,
    worldRevision: snapshot.header.revisions.worldRevision,
    snapshotDigest: snapshot.header.snapshotDigest,
    interactionRevision: snapshot.header.revisions.interactionRevision,
    target: { kind: "world-object", id: "object:preview" },
    gameId: input.manifest.gameId,
    entry: "default",
    presentation: input.manifest.presentation.default,
    playerScope,
  };
  await router.launch(request, createGameAccessV1(input.manifest, snapshot.header.capabilities, grant), grant);
  if (!launched) throw new Error("Code Game launch did not produce a run.");
  return launched;

  function start(request: GameLaunchRequestV1) {
    return (async () => {
      launched = await CodeGameRunV2.start({
        launchId: request.launchId,
        definition,
        manifest: input.manifest,
        world,
        seed: input.seed ?? snapshot.header.seed,
        access: createGameAccessV1(input.manifest, snapshot.header.capabilities, grant),
        grant,
        playerScope,
        scenePort: input.engine.gameScenePort,
        coordinator: input.coordinator,
        createRender: (lease) => createThreeCodeGameRender(lease, {
          assets: input.manifest.assets,
          assetBaseUrl: input.assetBaseUrl ?? new URL(".", location.href).href,
        }),
        nowMs: input.nowMs ?? (() => performance.now()),
        onStop: input.onStop,
      });
      return {
        launchId: request.launchId,
        runId: launched.host.runId,
        installationId: grant.installationId,
        gameId: request.gameId,
        entry: request.entry,
        presentation: request.presentation,
      };
    })();
  }
}
