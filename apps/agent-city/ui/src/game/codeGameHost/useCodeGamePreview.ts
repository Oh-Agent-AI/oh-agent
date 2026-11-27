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
import type { DialogueAPIV1 } from "../../../../../../packages/city-game-sdk/src/api/v2";

export type CodeGameDialogueStateV1 = Parameters<DialogueAPIV1["open"]>[0];
import { createThreeCodeGameRender } from "./threeRenderPort";
import { closeCityCodePreview, readCityCodePreviewBytes, takeCityCodePreview } from "./cityRuntimeCalls";
import type { PlaytestCaptureControlV1, PlaytestEndControlV1, PlaytestInputControlV1 } from "./cityRuntimeCalls";

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
  assetBytes?: Readonly<Record<string, Uint8Array>>;
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
  startNextPreview(): Promise<boolean>;
  stop(): void;
  status(): CodeGamePreviewStatus;
  telemetry(): GameTelemetryV1 | CodeGameTelemetryV2 | null;
  ready(): boolean;
  dialogue: CodeGameDialogueStateV1 | null;
  chooseDialogue(choiceId: string): void;
  closeDialogue(): void;
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
  const activeBuildIdRef = useRef<string | null>(null);
  const [dialogue, setDialogue] = useState<CodeGameDialogueStateV1 | null>(null);
  const dialogueRef = useRef(dialogue);
  dialogueRef.current = dialogue;
  const dialoguePending = useRef<{
    resolve: (result: { choiceId: string }) => void;
    reject: (reason: Error) => void;
  } | null>(null);

  const closeDialogue = useCallback((reason = "game_dialogue_closed"): void => {
    dialoguePending.current?.reject(new Error(reason));
    dialoguePending.current = null;
    setDialogue(null);
  }, []);
  const openDialogue = useCallback((input: CodeGameDialogueStateV1): Promise<{ choiceId: string }> => {
    if (dialoguePending.current) return Promise.reject(new Error("game_dialogue_busy"));
    return new Promise((resolve, reject) => {
      dialoguePending.current = { resolve, reject };
      setDialogue(input);
    });
  }, []);
  const chooseDialogue = useCallback((choiceId: string): void => {
    const choice = dialogueRef.current?.choices.find((item) => item.id === choiceId);
    if (!choice || choice.enabled === false || !dialoguePending.current) return;
    dialoguePending.current.resolve({ choiceId });
    dialoguePending.current = null;
    setDialogue(null);
  }, []);

  const start = useCallback(
    async (input: CodeGamePreviewStartV1): Promise<void> => {
      closeDialogue("game_run_cancelled");
      activeBuildIdRef.current = null;
      if (runRef.current) {
        await runRef.current.stop("stopped");
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
              ...(window.__AV_CODE_PREVIEW_ID__ ? { previewId: window.__AV_CODE_PREVIEW_ID__ } : {}),
              ...(input.buildId ? { buildId: input.buildId } : {}),
              ...(telemetry?.runId ? { runId: telemetry.runId } : {}),
              ...(reason ? { reason } : {}),
              ...(telemetry?.outcome ? { outcome: telemetry.outcome } : {}),
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
            dialogue: { open: openDialogue, close: () => closeDialogue() },
            onStop: ({ reason, telemetry }) => {
              if (generationRef.current !== generation) return;
              closeDialogue("game_run_cancelled");
              runRef.current = null;
              activeBuildIdRef.current = null;
              publishState("finished", reason, telemetry);
              setState({ status: "finished", runId: telemetry.runId, reason, error: null, telemetry });
            },
          });
          if (generationRef.current !== generation) {
            await run.stop("superseded");
            return;
          }
          runRef.current = run.isDisposed ? null : run;
          activeBuildIdRef.current = run.isDisposed ? null : input.buildId ?? null;
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
              ...(input.assetBytes ? { assetBytes: input.assetBytes } : {}),
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
        activeBuildIdRef.current = input.buildId ?? null;
        publishState("running", null, run.telemetry());
        setState({ status: "running", runId: run.host.runId, reason: null, error: null, telemetry: run.telemetry() });
      } catch (error) {
        closeDialogue("game_run_cancelled");
        activeBuildIdRef.current = null;
        const message = error instanceof Error ? error.message : String(error);
        void publish("code-game.state", {
          state: {
            status: "error",
            gameId: input.manifest && typeof input.manifest === "object" ? (input.manifest as { gameId?: unknown }).gameId : undefined,
            reason: message.slice(0, 120),
            ...(window.__AV_CODE_PREVIEW_ID__ ? { previewId: window.__AV_CODE_PREVIEW_ID__ } : {}),
            ...(input.buildId ? { buildId: input.buildId } : {}),
          },
        }).catch(() => {});
        setState({ status: "error", runId: null, reason: null, error: message, telemetry: null });
        throw error;
      }
    },
    [closeDialogue, coordinator, engineRef, openDialogue],
  );

  const ready = useCallback((): boolean => {
    const engine = engineRef.current;
    return !!(engine?.currentLayout && engine.getCitySdkLayoutView());
  }, [engineRef]);

  // ── PR08 自动化试玩（有界输入 / 截图）────────────────────────────
  // 宿主经 city.code.preview.next 的 control 信封下发（已做动作白名单与预算），
  // 这里防御性复核形状后应用到**本窗口自己的** game host（setInput 是宿主侧
  // 推送，游戏经 ctx.input.actions() 轮询读取）；结果经 plugin_message 窄面
  // playtest.input.result 回执，宿主记入会话步骤。V1 dev 运行没有输入面：
  // 如实回 game_run_not_found，绝不静默丢弃。

  const publishInputResult = useCallback((sessionId: string | null, seq: number | null, ok: boolean, errorCode?: string): void => {
    void publish("playtest.input.result", {
      result: { sessionId, seq, ok, ...(errorCode ? { errorCode } : {}) },
    }).catch(() => {});
  }, []);

  const applyPlaytestInput = useCallback((control: PlaytestInputControlV1): void => {
    const sessionId = typeof control.sessionId === "string" && control.sessionId.length <= 128 ? control.sessionId : null;
    const seq = typeof control.seq === "number" && Number.isInteger(control.seq) && control.seq > 0 ? control.seq : null;
    const actions = control.actions;
    const validActions = !!actions && typeof actions === "object" && !Array.isArray(actions)
      && Object.entries(actions).every(([key, value]) => key.length >= 1 && key.length <= 64
        && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))))
      && Object.keys(actions).length <= 32;
    if (!sessionId || !seq || !validActions) {
      publishInputResult(sessionId, seq, false, "playtest_input_invalid");
      return;
    }
    const run = runRef.current;
    if (!(run instanceof CodeGameRunV2) || run.isDisposed) {
      publishInputResult(sessionId, seq, false, "game_run_not_found");
      return;
    }
    try {
      run.setInput(actions);
      publishInputResult(sessionId, seq, true);
    } catch {
      publishInputResult(sessionId, seq, false, "game_argument_invalid");
    }
  }, [publishInputResult]);

  const capturePlaytestScreenshot = useCallback(async (control: PlaytestCaptureControlV1): Promise<void> => {
    const captureId = typeof control.captureId === "string" && control.captureId.length <= 128 ? control.captureId : null;
    if (!captureId) return;
    const engine = engineRef.current;
    const frame = engine?.captureFrame(330_000);
    if (!frame || !frame.ok) {
      void publish("playtest.screenshot", {
        screenshot: { captureId, errorCode: frame && !frame.ok ? frame.code : "creator_capture_unavailable" },
      }).catch(() => {});
      return;
    }
    void publish("playtest.screenshot", {
      screenshot: { captureId, dataUrl: frame.dataUrl, width: frame.width, height: frame.height, downscaled: frame.downscaled },
    }).catch(() => {});
  }, [engineRef]);

  const releasePlaytestInput = useCallback((_control: PlaytestEndControlV1): void => {
    // 会话结束：释放仍按下的动作（setInput 空表），避免悬停键位污染下一次试玩。
    const run = runRef.current;
    if (run instanceof CodeGameRunV2 && !run.isDisposed) {
      try { run.setInput({}); } catch { /* run is being torn down */ }
    }
  }, []);

  const startNextPreview = useCallback(async (): Promise<boolean> => {
    const pending = await takeCityCodePreview();
    if (!pending) return false;
    if ("control" in pending) {
      const previewMatches = !window.__AV_CODE_PREVIEW_ID__ || window.__AV_CODE_PREVIEW_ID__ === pending.previewId;
      // PR08 自动化试玩控制信封（宿主已做白名单/预算校验，这里只做防御性复核
      // 并应用到本窗口自己的 game host——主 City 窗口收不到这些信封）。
      if (pending.control === "playtest.input") { if (previewMatches) applyPlaytestInput(pending); return true; }
      if (pending.control === "playtest.capture") { if (previewMatches) await capturePlaytestScreenshot(pending); return true; }
      if (pending.control === "playtest.end") { if (previewMatches) releasePlaytestInput(pending); return true; }
      if (previewMatches && activeBuildIdRef.current === pending.buildId && stateRef.current.runId === pending.runId) stop();
      return true;
    }
    try {
      for (let attempt = 0; attempt < 240 && !ready(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready()) throw new Error("City layout did not become ready for the code game preview");
      const bundleBytes = await readCityCodePreviewBytes(pending.snapshotId, "game.js");
      const manifestAssets = (pending.manifest as { assets?: unknown }).assets;
      if (!Array.isArray(manifestAssets)) throw new Error("game_package_integrity_failed");
      const assetBytes: Record<string, Uint8Array> = {};
      for (const asset of manifestAssets) {
        const id = (asset as { id?: unknown }).id;
        if (typeof id !== "string") throw new Error("game_package_integrity_failed");
        assetBytes[id] = await readCityCodePreviewBytes(pending.snapshotId, `asset:${id}`);
      }
      await start({
        bundleText: new TextDecoder("utf-8", { fatal: true }).decode(bundleBytes),
        manifest: pending.manifest,
        buildId: pending.buildId,
        seed: pending.seed,
        cityId: pending.source.cityId,
        ...(pending.source.cityRevision !== undefined ? { cityRevision: pending.source.cityRevision } : {}),
        assetBytes,
      });
      return true;
    } finally {
      await closeCityCodePreview(pending.snapshotId).catch(() => undefined);
    }
  }, [applyPlaytestInput, capturePlaytestScreenshot, ready, releasePlaytestInput, start]);

  const stop = useCallback((): void => {
    const run = runRef.current;
    if (!run) return;
    closeDialogue("game_run_cancelled");
    void run.stop("stopped");
    activeBuildIdRef.current = null;
    runRef.current = null;
  }, [closeDialogue]);

  const status = useCallback((): CodeGamePreviewStatus => stateRef.current.status, []);
  const telemetry = useCallback((): GameTelemetryV1 | CodeGameTelemetryV2 | null => runRef.current?.telemetry() ?? stateRef.current.telemetry, []);

  useEffect(
    () => () => {
      closeDialogue("game_run_cancelled");
      void runRef.current?.stop("stopped");
      generationRef.current += 1;
      runRef.current = null;
    },
    [closeDialogue],
  );

  return Object.freeze({ state, start, startNextPreview, stop, status, telemetry, ready, dialogue, chooseDialogue, closeDialogue: () => closeDialogue() });
}
