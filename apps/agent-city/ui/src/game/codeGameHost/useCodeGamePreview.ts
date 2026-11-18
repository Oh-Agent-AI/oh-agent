import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Object3D } from "three";
import type { GameTelemetryV1 } from "../../../../../../packages/city-game-sdk/src/host/types";
import { isGameDefinitionV1 } from "../../../../../../packages/city-game-sdk/src/api/defineGame";
import type { CodeGameManifest } from "../../../../../../packages/city-game-sdk/src/protocol/manifestV2";
import { validateCodeGameManifest } from "../../../../../../packages/city-game-sdk/src/protocol/manifestV2";
import { publish } from "../../host";
import type { CityEngine } from "../../engine/CityEngine";
import type { CityActivityCoordinator } from "../activity/CityActivityCoordinator";
import { createCityEngineWorldSourceV1 } from "./cityEngineWorldSource";
import { CodeGameRunV1 } from "./codeGameSession";
import { CodeGameRunV2, type CodeGameTelemetryV2 } from "./codeGameSessionV2";
import { startCodeGamePreviewV2 } from "./codeGamePreviewV2";
import { createThreeCodeGameRender } from "./threeRenderPort";

/**
 * Dev preview entry: fetch a trusted build, import it from a Blob URL, and run
 * it against the *live* City layout through the production session. This is the
 * same path a Studio/MCP preview will use; only the bundle source differs.
 *
 * Trust level: P0 only. The bundle executes in the City WebView with full host
 * privileges. It is never used for downloaded community code — that path must
 * wait for the P2 sandbox, exactly as the PRD's two trust levels require.
 */

export type CodeGamePreviewStatus = "idle" | "starting" | "running" | "finished" | "error";

export type CodeGamePreviewState = Readonly<{
  status: CodeGamePreviewStatus;
  runId: string | null;
  reason: string | null;
  error: string | null;
  telemetry: GameTelemetryV1 | CodeGameTelemetryV2 | null;
}>;

export type CodeGamePreviewStartV1 = Readonly<{
  bundleText: string;
  manifest: unknown;
  seed?: number;
  /** Content buildId for MCP status correlation; optional in dev URLs. */
  buildId?: string;
  cityId?: string;
  cityRevision?: number;
  /** Absolute directory the manifest's asset paths resolve against. */
  assetBaseUrl?: string;
  nowMs?: () => number;
}>;

const IDLE: CodeGamePreviewState = Object.freeze({
  status: "idle",
  runId: null,
  reason: null,
  error: null,
  telemetry: null,
});

export type CodeGamePreviewV1 = Readonly<{
  state: CodeGamePreviewState;
  start(input: CodeGamePreviewStartV1): Promise<void>;
  stop(): void;
  status(): CodeGamePreviewStatus;
  telemetry(): GameTelemetryV1 | CodeGameTelemetryV2 | null;
  ready(): boolean;
}>;

export function useCodeGamePreview(options: Readonly<{
  engineRef: RefObject<CityEngine | null>;
  coordinator: CityActivityCoordinator;
}>): CodeGamePreviewV1 {
  const { engineRef, coordinator } = options;
  const [state, setState] = useState<CodeGamePreviewState>(IDLE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const runRef = useRef<CodeGameRunV1<Object3D> | CodeGameRunV2<Object3D> | null>(null);
  const generationRef = useRef(0);

  const start = useCallback(
    async (input: CodeGamePreviewStartV1): Promise<void> => {
      if (runRef.current) {
        void runRef.current.stop("stopped");
        runRef.current = null;
      }
      const generation = ++generationRef.current;
      setState({ status: "starting", runId: null, reason: null, error: null, telemetry: null });
      try {
        const parsed = validateCodeGameManifest(input.manifest);
        if (!parsed.ok) {
          const first = parsed.diagnostics[0];
          throw new Error(first ? `${first.code}: ${first.message}` : "Invalid game manifest.");
        }
        const manifest: CodeGameManifest = parsed.value;
        const engine = engineRef.current;
        if (!engine) throw new Error("City engine is not ready.");
        const view = engine.getCitySdkLayoutView();
        const layout = engine.currentLayout;
        if (!view || !layout) throw new Error("City layout is not ready.");

        const publishState = (
          status: "starting" | "running" | "finished" | "error",
          reason: string | null,
          telemetry: GameTelemetryV1 | CodeGameTelemetryV2 | null,
        ): void => {
          // `publish` is a no-op outside the desktop host (browser dev), so this
          // never becomes a hard dependency of the preview path.
          void publish("code-game.state", {
            state: {
              status,
              gameId: manifest.gameId,
              ...(input.buildId ? { buildId: input.buildId } : {}),
              ...(telemetry?.runId ? { runId: telemetry.runId } : {}),
              ...(reason ? { reason } : {}),
              ...(telemetry ? { tick: telemetry.tick, entities: telemetry.entities } : {}),
            },
          }).catch(() => {});
        };

        const blobUrl = URL.createObjectURL(new Blob([input.bundleText], { type: "text/javascript" }));
        let module: { default?: unknown };
        try {
          module = (await import(/* @vite-ignore */ blobUrl)) as { default?: unknown };
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
        if (!isGameDefinitionV1(module.default)) {
          throw new Error("Bundle must export default defineGame({...}).");
        }

        if (manifest.schemaVersion === 2) {
          const run = await startCodeGamePreviewV2({
            definition: module.default,
            manifest,
            engine,
            coordinator,
            seed: input.seed,
            buildId: input.buildId,
            cityId: input.cityId,
            cityRevision: input.cityRevision,
            assetBaseUrl: input.assetBaseUrl,
            nowMs: input.nowMs,
            onStop: ({ reason, telemetry }) => {
              if (generationRef.current !== generation) return;
              runRef.current = null;
              publishState("finished", reason, telemetry);
              setState({ status: "finished", runId: telemetry.runId, reason, error: null, telemetry });
            },
          });
          if (generationRef.current !== generation) {
            await run.stop("superseded");
            return;
          }
          runRef.current = run.isDisposed ? null : run;
          publishState("running", null, run.telemetry());
          setState({ status: "running", runId: run.host.runId, reason: null, error: null, telemetry: run.telemetry() });
          return;
        }

        const world = createCityEngineWorldSourceV1({
          cityId: input.cityId ?? "city:dev",
          cityRevision: input.cityRevision ?? 0,
          worldRevision: view.worldRevision,
          layoutId: view.layout.id,
          layout,
        });
        const run = await CodeGameRunV1.start({
          definition: module.default,
          manifest,
          world,
          seed: input.seed ?? view.seed,
          scenePort: engine.gameScenePort,
          coordinator,
          createRender: (lease) =>
            createThreeCodeGameRender(lease, {
              assets: manifest.assets,
              assetBaseUrl: input.assetBaseUrl ?? new URL(".", location.href).href,
            }),
          nowMs: input.nowMs ?? (() => performance.now()),
          onStop: ({ reason, telemetry }) => {
            if (generationRef.current !== generation) return;
            runRef.current = null;
            publishState("finished", reason, telemetry);
            setState({ status: "finished", runId: telemetry.runId, reason, error: null, telemetry });
          },
        });
        runRef.current = run;
        publishState("running", null, run.telemetry());
        setState({ status: "running", runId: run.host.runId, reason: null, error: null, telemetry: run.telemetry() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void publish("code-game.state", {
          state: { status: "error", gameId: input.manifest && typeof input.manifest === "object" ? (input.manifest as { gameId?: unknown }).gameId : undefined, reason: message.slice(0, 120) },
        }).catch(() => {});
        setState({ status: "error", runId: null, reason: null, error: message, telemetry: null });
        throw error;
      }
    },
    [coordinator, engineRef],
  );

  const stop = useCallback((): void => {
    const run = runRef.current;
    if (!run) return;
    void run.stop("stopped");
    runRef.current = null;
  }, []);

  const status = useCallback((): CodeGamePreviewStatus => stateRef.current.status, []);
  const telemetry = useCallback((): GameTelemetryV1 | CodeGameTelemetryV2 | null => runRef.current?.telemetry() ?? stateRef.current.telemetry, []);
  const ready = useCallback((): boolean => {
    const engine = engineRef.current;
    return !!(engine?.currentLayout && engine.getCitySdkLayoutView());
  }, [engineRef]);

  useEffect(
    () => () => {
      void runRef.current?.stop("stopped");
      generationRef.current += 1;
      runRef.current = null;
    },
    [],
  );

  return Object.freeze({ state, start, stop, status, telemetry, ready });
}
