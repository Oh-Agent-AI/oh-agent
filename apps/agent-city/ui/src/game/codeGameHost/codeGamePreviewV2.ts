import type { Object3D } from "three";
import type { CodeGameManifestV2 } from "../../../../../../packages/city-game-sdk/src/protocol/manifestV2";
import { createGameAccessV1, type HostGrantV1 } from "../../../../../../packages/city-game-sdk/src/protocol/access";
import { createSnapshotWorldAPIV2 } from "../../../../../../packages/city-game-sdk/src/host/snapshotWorld";
import { defineGameV2, type DialogueAPIV1, type StoryEventAPIV1 } from "../../../../../../packages/city-game-sdk/src/api/v2";
import type { CodeGameTelemetryV2 } from "./codeGameSessionV2";
import { CodeGameRunV2 } from "./codeGameSessionV2";
import { InstalledGameRegistryV1, InteractionRouter, type GameLaunchRequestV1 } from "../../../../../../packages/agent-vitals-city-game-runtime/src/interaction";
import { createCitySnapshotV4 } from "./citySnapshot";
import { createThreeCodeGameRender } from "./threeRenderPort";
import { publish } from "../../host";
import type { CityEngine } from "../../engine/CityEngine";
import type { CityActivityCoordinator } from "../activity/CityActivityCoordinator";
import { cancelCityStory, listCityStory, readCityTime, scheduleCityStory, startCityGameRun, stopCityGameRun } from "./cityRuntimeCalls";

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
  assetBytes?: Readonly<Record<string, Uint8Array>>;
  nowMs?: () => number;
  dialogue?: DialogueAPIV1;
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
  // PR05 渲染端导出（PR08 补齐）：真实 City 的独立 Preview 在快照物化后上报一份
  // 给宿主缓存（code_preview_window 的 plugin_message 窄面 city.snapshot.export；
  // 宿主做三重身份绑定后有界落盘）。身份取自注入的 boot source——绝不在这里自报
  // cityRevision，宿主按 preview 请求源与权威 revision 复核。合成 fixture 与
  // 主 City 窗口（无独立 previewId）不上报：主窗口的 plugin_message 面没有该
  // 类型，宿主无法做 preview 配对。
  exportCitySnapshotOnce(snapshot);
  const world = createSnapshotWorldAPIV2(snapshot, {
    terrain: (x, z) => ({
      height: layout.terrain.height(x, z),
      normal: [0, 1, 0],
      walkable: layout.terrain.buildable(x, z),
    }),
  });
  const hostRun = await startCityGameRun({
    cityId: snapshot.header.cityId,
    gameId: input.manifest.gameId,
    ...(input.buildId ? { buildId: input.buildId } : {}),
  });
  const playerScope = hostRun?.playerScope ?? { playerId: `preview-${snapshot.header.cityId}`, kind: "local-profile" as const };
  const launchId = hostRun?.runId ?? (input.buildId ? `launch-${input.buildId}` : crypto.randomUUID());
  const story: StoryEventAPIV1 | undefined = hostRun ? {
    resolveLocalTime: async ({ localDate, localTime }) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !/^\d{2}:\d{2}$/.test(localTime)) throw new Error("game_argument_invalid");
      const atUtcMs = Date.parse(`${localDate}T${localTime}:00.000Z`);
      if (!Number.isFinite(atUtcMs) || new Date(atUtcMs).toISOString().slice(0, 16) !== `${localDate}T${localTime}`) throw new Error("game_argument_invalid");
      const clock = await readCityTime(snapshot.header.cityId);
      if (!clock) throw new Error("city_time_unavailable");
      return { atUtcMs, clockRevision: clock.clockRevision };
    },
    schedule: (rule, options) => scheduleCityStory(hostRun.runId, rule, options),
    cancel: (ruleId, options) => cancelCityStory(hostRun.runId, ruleId, options),
    list: () => listCityStory(hostRun.runId),
  } : undefined;
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
  try {
    await router.launch(request, createGameAccessV1(input.manifest, snapshot.header.capabilities, grant), grant);
    if (!launched) throw new Error("Code Game launch did not produce a run.");
    return launched;
  } catch (error) {
    if (hostRun) await stopCityGameRun(hostRun.runId).catch(() => undefined);
    throw error;
  }

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
        ...(story ? { story } : {}),
        ...(input.dialogue ? { dialogue: input.dialogue } : {}),
        scenePort: input.engine.gameScenePort,
        coordinator: input.coordinator,
        createRender: (lease) => createThreeCodeGameRender(lease, {
          assets: input.manifest.assets,
          assetBaseUrl: input.assetBaseUrl ?? new URL(".", location.href).href,
          ...(input.assetBytes ? { assetBytes: input.assetBytes } : {}),
        }),
        nowMs: input.nowMs ?? (() => performance.now()),
        onStop: (event) => {
          if (hostRun) void stopCityGameRun(hostRun.runId).catch(() => undefined);
          input.onStop(event);
        },
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

/// PR05/PR08：真实 City 的独立 Preview 上报一次物化快照。仅当宿主注入了
/// `__AV_CODE_PREVIEW_ID__`（隔离 preview 窗口）且 boot source 非 synthetic 时
/// 才发；重复 start 会在新快照物化时重新上报（宿主按 (cityId, revision) 覆盖
/// 同身份缓存，天然幂等）。上报失败静默——宿主侧缓存缺席是显式的
/// `creator_city_snapshot_not_cached`，绝不回退合成世界。
function exportCitySnapshotOnce(snapshot: ReturnType<typeof createCitySnapshotV4>): void {
  const boot = window.__AV_CODE_PREVIEW_BOOT__ as
    | { previewId?: unknown; source?: { synthetic?: unknown } | undefined }
    | undefined;
  if (!window.__AV_CODE_PREVIEW_ID__ || !boot || boot.source?.synthetic === true) return;
  void publish("city.snapshot.export", { snapshotJson: JSON.stringify(snapshot) }).catch(() => {});
}
