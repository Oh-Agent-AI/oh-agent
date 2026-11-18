import type { GameDefinitionV2 } from "../../../../../../packages/city-game-sdk/src/api/v2";
import type { PlayerScopeV1 } from "../../../../../../packages/agent-vitals-city-sdk/src/contracts";
import { CodeGameHostV2 } from "../../../../../../packages/city-game-sdk/src/host/codeGameHostV2";
import type { CodeGameHostOptionsV2, CodeGameHostStatusV2 } from "../../../../../../packages/city-game-sdk/src/host/codeGameHostV2";
import type { GameTelemetryV1 } from "../../../../../../packages/city-game-sdk/src/host/types";
import { GameSdkError, asGameSdkError } from "../../../../../../packages/city-game-sdk/src/protocol/errors";
import { FixedStepClock } from "../runtime/FixedStepClock";
import type { CodeGameActivityCoordinatorV1, CodeGameActivityLeaseV1, CodeGameRenderFactoryV1, CodeGameSceneLeaseV1, CodeGameScenePortV1 } from "./codeGameSession";

export type CodeGameTelemetryV2 = Omit<GameTelemetryV1, "status"> & { status: CodeGameHostStatusV2 };

export type CodeGameRunOptionsV2<Visual> = Readonly<{
  launchId: string;
  definition: GameDefinitionV2;
  manifest: CodeGameHostOptionsV2["manifest"];
  world: CodeGameHostOptionsV2["world"];
  seed: number;
  access: CodeGameHostOptionsV2["access"];
  grant: CodeGameHostOptionsV2["grant"];
  playerScope?: PlayerScopeV1;
  scenePort: CodeGameScenePortV1<Visual>;
  coordinator: CodeGameActivityCoordinatorV1;
  createRender: CodeGameRenderFactoryV1<Visual>;
  fixedDtSeconds?: number;
  nowMs?: () => number;
  onStop?: (event: Readonly<{ reason: string; telemetry: CodeGameTelemetryV2 }>) => void;
}>;

export class CodeGameRunV2<Visual> {
  private static readonly active = new Map<string, Promise<CodeGameRunV2<never>>>();

  private disposed = false;
  private stopNotified = false;
  private stopPromise: Promise<void> | null = null;

  private constructor(
    readonly host: CodeGameHostV2,
    private readonly launchId: string,
    private readonly lease: CodeGameSceneLeaseV1<Visual>,
    private readonly activity: CodeGameActivityLeaseV1,
    private readonly render: { port: unknown; dispose(): void },
    private readonly clock: FixedStepClock,
    private readonly onStop: CodeGameRunOptionsV2<Visual>["onStop"],
  ) {}

  get isDisposed(): boolean { return this.disposed; }

  telemetry(): CodeGameTelemetryV2 {
    return this.host.telemetry();
  }

  pause(): void { if (!this.disposed) this.host.pause(); }
  resume(): void { if (!this.disposed) this.host.resume(); }

  stop(reason = "stopped"): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal(reason);
    return this.stopPromise;
  }

  private async stopInternal(reason: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try { this.lease.setFrameHook(null); } catch { /* stale lease is already released */ }
    try { await this.host.dispose(); } catch { /* cleanup continues */ }
    try { this.render.dispose(); } catch { /* cleanup continues */ }
    try { this.lease.release(); } catch { /* cleanup continues */ }
    try { this.activity.release(); } catch { /* cleanup continues */ }
    CodeGameRunV2.active.delete(this.launchId);
    if (!this.stopNotified) {
      this.stopNotified = true;
      try { this.onStop?.({ reason, telemetry: this.host.telemetry() }); } catch { /* observers cannot retain resources */ }
    }
  }

  private onFrame(frameSeconds: number): void {
    if (this.disposed) return;
    if (!this.lease.isCurrent()) {
      void this.stop("world_changed");
      return;
    }
    try {
      const frame = this.clock.advance(frameSeconds, false, () => this.host.step());
      if (frame.pauseRequired) {
        if (frame.cause === "catch-up-budget") return;
        void this.stop("frame_gap");
        return;
      }
      if (this.host.status !== "running" && this.host.status !== "ready") void this.stop("game_finished");
    } catch {
      void this.stop("error");
    }
  }

  static async start<Visual>(options: CodeGameRunOptionsV2<Visual>): Promise<CodeGameRunV2<Visual>> {
    const existing = CodeGameRunV2.active.get(options.launchId);
    if (existing) return existing as Promise<CodeGameRunV2<Visual>>;
    const pending = CodeGameRunV2.startInternal(options);
    CodeGameRunV2.active.set(options.launchId, pending as Promise<CodeGameRunV2<never>>);
    try {
      return await pending;
    } catch (error) {
      CodeGameRunV2.active.delete(options.launchId);
      throw error;
    }
  }

  private static async startInternal<Visual>(options: CodeGameRunOptionsV2<Visual>): Promise<CodeGameRunV2<Visual>> {
    const admission = options.coordinator.tryAcquire("code-game");
    if (!admission.ok) throw new GameSdkError("game_activity_busy", `City activity "${admission.active.activityId}" is already running.`, "prepare");
    const activity = admission.lease;
    const controller = new AbortController();
    let lease: CodeGameSceneLeaseV1<Visual> | null = null;
    let render: { port: unknown; dispose(): void } | null = null;
    let host: CodeGameHostV2 | null = null;
    try {
      const acquisition = await options.scenePort.acquireResult(
        { vehicle: "game", activity: "code" },
        activity.runId,
        controller.signal,
      );
      if (acquisition.status !== "ready") {
        throw new GameSdkError(acquisition.status === "busy" ? "game_activity_busy" : "game_runtime_fault", acquisition.reason, "prepare");
      }
      lease = acquisition.lease;
      render = await options.createRender(lease);
      host = new CodeGameHostV2({
        manifest: options.manifest,
        world: options.world,
        seed: options.seed,
        runId: options.launchId,
        access: options.access,
        grant: options.grant,
        ...(options.playerScope ? { playerScope: options.playerScope } : {}),
        render: render.port as CodeGameHostOptionsV2["render"],
        ...(options.fixedDtSeconds !== undefined ? { fixedDtSeconds: options.fixedDtSeconds } : {}),
        ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      });
      await host.prepare(options.definition);
      if (!activity.activate()) throw new GameSdkError("game_activity_busy", "The activity lease was lost before the run started.", "prepare");
    } catch (error) {
      if (host) await host.dispose().catch(() => undefined);
      try { render?.dispose(); } catch { /* preserve original error */ }
      try { lease?.release(); } catch { /* preserve original error */ }
      try { activity.release(); } catch { /* preserve original error */ }
      throw asGameSdkError(error, "game_runtime_fault", "prepare");
    }
    if (!lease || !render || !host) throw new GameSdkError("game_runtime_fault", "Code game acquisition did not produce a scene lease.", "prepare");
    const run = new CodeGameRunV2(
      host,
      options.launchId,
      lease,
      activity,
      render,
      new FixedStepClock(options.fixedDtSeconds ?? 1 / 60, 10, 1),
      options.onStop,
    );
    try {
      lease.setFrameHook((frameSeconds) => run.onFrame(frameSeconds));
      void host.start().then(() => {
        if (host.status !== "running" && host.status !== "paused") void run.stop("game_finished");
      }).catch(() => run.stop("error"));
    } catch (error) {
      await run.stop("error");
      throw asGameSdkError(error, "game_runtime_fault", "prepare");
    }
    return run;
  }
}
