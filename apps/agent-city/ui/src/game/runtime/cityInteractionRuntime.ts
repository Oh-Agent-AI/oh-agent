import type { CityTargetRefV1, PlayerScopeV1 } from "@oh-agent/city-sdk/contracts";
import { validateCodeGameManifestV2, type CodeGameManifestV2 } from "../../../../../../packages/city-game-sdk/src/protocol/manifestV2";
import { createGameAccessV1, type HostGrantV1 } from "../../../../../../packages/city-game-sdk/src/protocol/access";
import { InstalledGameRegistryV1, InteractionRouter, type GameLaunchRequestV1 } from "../../../../../../packages/agent-vitals-city-game-runtime/src/interaction";
import type { CodeGamePresentationV2 } from "../../../../../../packages/city-game-sdk/src/protocol/manifestV2";
import { createCitySnapshotV4 } from "../codeGameHost/citySnapshot";
import type { CityEngine } from "../../engine/CityEngine";

export type LegacyActivityLaunchV1 = Readonly<{
  typeId: string;
  presentation: CodeGamePresentationV2;
  launchId?: string;
  target?: CityTargetRefV1;
}>;

const PLAYER_SCOPE: PlayerScopeV1 = { playerId: "local-city-player", kind: "local-profile" };
const PREVIEW_ENTRY = "default";

export class CityInteractionRuntime {
  private readonly installations = new InstalledGameRegistryV1();

  constructor() {
    for (const typeId of [
      "miami.flight-v1", "miami.driving-v1", "miami.mecha-v1", "miami.cinema-v1",
      "creator.flight-ornithopter-prototype-v1", "creator.flight-checkpoint-v1", "code.preview",
    ]) {
      this.installations.register({
        installationId: `legacy-${typeId}`,
        gameId: typeId,
        gameVersion: "1.0.0",
        kind: "legacy-runtime",
        contentDigest: `sha256:legacy-${typeId}`,
        trustLevel: "legacy",
        status: "installed",
        entries: [{ id: PREVIEW_ENTRY, presentations: ["exclusive", "overlay"] }],
      });
    }
  }

  async launch(engine: CityEngine, input: LegacyActivityLaunchV1): Promise<void> {
    const view = engine.getCitySdkLayoutView();
    const layout = engine.currentLayout;
    if (!view || !layout) throw new Error("City layout is not ready.");
    const snapshot = createCitySnapshotV4({
      cityId: `city:${layout.seed}`,
      cityRevision: layout.derivedNetworkVersion ?? 0,
      layout,
      view,
    });
    const launchId = input.launchId ?? crypto.randomUUID();
    const grant: HostGrantV1<PlayerScopeV1> = {
      installationId: `legacy-${input.typeId}`,
      runId: launchId,
      playerScope: PLAYER_SCOPE,
      grantedPermissions: ["world.read"],
      status: "active",
    };
    const manifest = legacyManifest(input.typeId);
    const request: GameLaunchRequestV1 = {
      launchId,
      cityId: snapshot.header.cityId,
      cityRevision: snapshot.header.cityRevision,
      worldRevision: snapshot.header.revisions.worldRevision,
      snapshotDigest: snapshot.header.snapshotDigest,
      interactionRevision: snapshot.header.revisions.interactionRevision,
      target: input.target ?? { kind: "world-object", id: "object:legacy-launch" },
      gameId: input.typeId,
      entry: PREVIEW_ENTRY,
      presentation: input.presentation,
      playerScope: PLAYER_SCOPE,
    };
    const router = new InteractionRouter(this.installations, {
      declarative: { launch: async () => result() },
      "legacy-runtime": { launch: async () => result() },
      code: { launch: async () => result() },
      revisions: () => ({
        worldRevision: snapshot.header.revisions.worldRevision,
        interactionRevision: snapshot.header.revisions.interactionRevision,
      }),
    });
    await router.launch(request, createGameAccessV1(manifest, snapshot.header.capabilities, grant), grant);
    return undefined;
  }
}

function result() {
  return {
    launchId: "result",
    runId: "result",
    installationId: "result",
    gameId: "result",
    entry: PREVIEW_ENTRY,
    presentation: "exclusive" as const,
  };
}

function legacyManifest(typeId: string): CodeGameManifestV2 {
  const parsed = validateCodeGameManifestV2({
    schemaVersion: 2,
    kind: "code-game",
    gameId: typeId,
    displayName: typeId,
    version: "1.0.0",
    entry: "src/index.ts",
    sdk: { name: "@oh-agent/city-game-sdk", apiMajor: 2 },
    citySdk: { name: "@oh-agent/city-sdk", schemaMajor: 2 },
    world: { requiredCapabilities: ["world.snapshot"], binding: "capability-based" },
    render: { compatibleProfiles: [] },
    presentation: { supported: ["exclusive", "overlay"], default: "exclusive" },
    permissions: ["world.read"],
    entries: [{ id: PREVIEW_ENTRY, export: "default", presentation: ["exclusive", "overlay"] }],
    limits: { maxEntities: 1, maxProjectiles: 0 },
    assets: [],
  });
  if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message ?? "Invalid legacy manifest.");
  return parsed.value;
}
