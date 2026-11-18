import type { GameDefinitionV1 } from "../../../../../../packages/city-game-sdk/src/api/defineGame";
import { CodeGameHostV1 } from "../../../../../../packages/city-game-sdk/src/host/codeGameHost";
import type {
  GameTelemetryV1,
  RenderPortV1,
  WorldSourceV1,
} from "../../../../../../packages/city-game-sdk/src/host/types";
import type { CodeGameManifestV1 } from "../../../../../../packages/city-game-sdk/src/protocol/manifest";
import { GameSdkError, asGameSdkError } from "../../../../../../packages/city-game-sdk/src/protocol/errors";
import { FixedStepClock } from "../runtime/FixedStepClock";

/**
 * One code-game run inside the City. This is the only place that binds three
 * independent ownership systems together:
 *
 *   CityActivityCoordinator  — activity-level mutual exclusion
 *   HostGameScenePort lease  — static scene + camera + frame hook
 *   CodeGameHostV1           — the game's lifecycle and entity ownership
 *
 * Order matters on both ends. Acquisition is activity → scene → host; release
 * is host (destroys entities through the render port) → renderer (detaches the
 * group) → scene lease (restores camera) → activity lease. Any failure during
 * acquisition unwinds exactly what was already taken.
 *
 * The City owns the clock: the scene's frame hook feeds City frame seconds into
 * a `FixedStepClock`, which calls `host.step()` zero or more times. The session
 * never uses `requestAnimationFrame` and never lets a frame go unbounded — a
 * `pauseRequired` verdict stops the run instead of running a catch-up storm.
 */

export type CodeGameCameraPoseV1 = Readonly<{
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  up: readonly [number, number, number];
  fov: number;
}>;

export type CodeGameSceneLeaseV1<Visual> = Readonly<{
  token: symbol;
  isCurrent(): boolean;
  setFrameHook(hook: ((frameSeconds: number) => void) | null): void;
  attach(objects: readonly Visual[]): void;
  detach(objects: readonly Visual[]): void;
  /** Optional so headless fakes stay small; the City lease implements it. */
  setCamera?(pose: CodeGameCameraPoseV1): void;
  release(): void;
}>;

export type CodeGameSceneAcquisitionV1<Visual> =
  | Readonly<{ status: "ready"; lease: CodeGameSceneLeaseV1<Visual> }>
  | Readonly<{ status: "busy" | "cancelled" | "unavailable"; reason: string }>;

export type CodeGameScenePortV1<Visual> = Readonly<{
  acquireResult(
    selection: Readonly<{ vehicle: "game"; activity: "code" }>,
    runId: number,
    signal: AbortSignal,
  ): Promise<CodeGameSceneAcquisitionV1<Visual>>;
}>;

export type CodeGameActivityLeaseV1 = Readonly<{
  runId: number;
  activate(): boolean;
  release(): void;
}>;

export type CodeGameActivityCoordinatorV1 = Readonly<{
  tryAcquire(
    activityId: "code-game",
  ):
    | Readonly<{ ok: true; lease: CodeGameActivityLeaseV1 }>
    | Readonly<{ ok: false; active: Readonly<{ activityId: string; phase: string; runId: number }> }>;
}>;

export type CodeGameRenderV1<Visual> = Readonly<{
  port: RenderPortV1;
  dispose(): void;
}>;

export type CodeGameRenderFactoryV1<Visual> = (
  lease: CodeGameSceneLeaseV1<Visual>,
) => CodeGameRenderV1<Visual> | Promise<CodeGameRenderV1<Visual>>;

export type CodeGameRunOptionsV1<Visual> = Readonly<{
  definition: GameDefinitionV1;
  manifest: CodeGameManifestV1;
  world: WorldSourceV1;
  seed: number;
  scenePort: CodeGameScenePortV1<Visual>;
  coordinator: CodeGameActivityCoordinatorV1;
  createRender: CodeGameRenderFactoryV1<Visual>;
  fixedDtSeconds?: number;
  nowMs?: () => number;
  signal?: AbortSignal;
  /** Called once after cleanup; used by the preview hook to surface the final
   * state without polling a disposed host. */
  onStop?: (event: Readonly<{ reason: CodeGameStopReasonV1; telemetry: GameTelemetryV1 }>) => void;
}>;

export type CodeGameStopReasonV1 =
  | "stopped"
  | "game_finished"
  | "world_changed"
  | "frame_gap"
  | "error";

export class CodeGameRunV1<Visual> {
  readonly host: CodeGameHostV1;

  private readonly lease: CodeGameSceneLeaseV1<Visual>;
  private readonly activity: CodeGameActivityLeaseV1;
  private readonly render: CodeGameRenderV1<Visual>;
  private readonly clock: FixedStepClock;
  private readonly onStop: CodeGameRunOptionsV1<Visual>["onStop"];
  private reasonValue: CodeGameStopReasonV1 | null = null;
  private lastErrorValue: GameSdkError | null = null;
  private disposed = false;

  private constructor(
    host: CodeGameHostV1,
    lease: CodeGameSceneLeaseV1<Visual>,
    activity: CodeGameActivityLeaseV1,
    render: CodeGameRenderV1<Visual>,
    clock: FixedStepClock,
    onStop: CodeGameRunOptionsV1<Visual>["onStop"],
  ) {
    this.host = host;
    this.lease = lease;
    this.activity = activity;
    this.render = render;
    this.clock = clock;
    this.onStop = onStop;
  }

  get stopReason(): CodeGameStopReasonV1 | null {
    return this.reasonValue;
  }

  get lastError(): GameSdkError | null {
    return this.lastErrorValue;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  telemetry(): GameTelemetryV1 {
    return this.host.telemetry();
  }

  pause(): void {
    if (!this.disposed) this.host.pause();
  }

  resume(): void {
    if (!this.disposed) this.host.resume();
  }

  stop(reason: CodeGameStopReasonV1 = "stopped"): void {
    if (this.disposed) return;
    this.reasonValue = reason;
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.lease.setFrameHook(null);
    } catch {
      // A stale token means the City already revoked the lease; releasing it
      // below is still the correct no-op path.
    }
    try {
      this.host.dispose();
    } catch (error) {
      this.lastErrorValue = asGameSdkError(error);
    }
    try {
      this.render.dispose();
    } catch (error) {
      this.lastErrorValue = asGameSdkError(error);
    }
    try {
      this.lease.release();
    } catch (error) {
      this.lastErrorValue = asGameSdkError(error);
    }
    try {
      this.activity.release();
    } catch (error) {
      this.lastErrorValue = asGameSdkError(error);
    }
    if (this.onStop) {
      try {
        this.onStop({
          reason: this.reasonValue ?? "stopped",
          telemetry: this.host.telemetry(),
        });
      } catch {
        /* observer failure must not keep resources alive */
      }
    }
  }

  private onFrame(frameSeconds: number): void {
    if (this.disposed) return;
    if (!this.lease.isCurrent()) {
      this.stop("world_changed");
      return;
    }
    try {
      const frame = this.clock.advance(frameSeconds, false, () => this.host.step());
      if (frame.pauseRequired) {
        if (frame.cause === "catch-up-budget") {
          // A slow frame (software WebGL, GC) dropped simulation time rather
          // than killing the run. `advance` already cleared the accumulator,
          // so the next frame starts clean instead of spiralling.
          return;
        }
        this.stop("frame_gap");
        return;
      }
      if (this.host.status !== "running" && this.host.status !== "ready") {
        this.stop("game_finished");
      }
    } catch (error) {
      this.lastErrorValue = asGameSdkError(error);
      this.stop("error");
    }
  }

  static async start<Visual>(options: CodeGameRunOptionsV1<Visual>): Promise<CodeGameRunV1<Visual>> {
    const admission = options.coordinator.tryAcquire("code-game");
    if (!admission.ok) {
      throw new GameSdkError(
        "game_activity_busy",
        `City activity "${admission.active.activityId}" is already running.`,
        "prepare",
      );
    }
    const activity = admission.lease;
    const signal = options.signal ?? new AbortController().signal;

    let lease: CodeGameSceneLeaseV1<Visual> | null = null;
    let render: CodeGameRenderV1<Visual> | null = null;
    let host: CodeGameHostV1 | null = null;
    try {
      const acquisition = await options.scenePort.acquireResult(
        { vehicle: "game", activity: "code" },
        activity.runId,
        signal,
      );
      if (acquisition.status !== "ready") {
        throw new GameSdkError(
          acquisition.status === "busy" ? "game_activity_busy" : "game_runtime_fault",
          `Scene acquisition failed: ${acquisition.reason}`,
          "prepare",
        );
      }
      lease = acquisition.lease;
      render = await options.createRender(lease);
      host = new CodeGameHostV1({
        manifest: options.manifest,
        world: options.world,
        seed: options.seed,
        render: render.port,
        ...(options.fixedDtSeconds !== undefined ? { fixedDtSeconds: options.fixedDtSeconds } : {}),
        ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      });
      await host.prepare(options.definition);
      host.start();
      if (!activity.activate()) {
        throw new GameSdkError("game_activity_busy", "The activity lease was lost before the run started.", "prepare");
      }
    } catch (error) {
      try {
        host?.dispose();
      } catch {
        /* closure failure must not mask the original error */
      }
      try {
        render?.dispose();
      } catch {
        /* closure failure must not mask the original error */
      }
      try {
        lease?.release();
      } catch {
        /* same */
      }
      try {
        activity.release();
      } catch {
        /* same */
      }
      throw asGameSdkError(error, "game_runtime_fault", "prepare");
    }

    if (!lease || !render || !host) {
      throw new GameSdkError("game_runtime_fault", "Code game acquisition did not produce a scene lease.", "prepare");
    }
    const run = new CodeGameRunV1(
      host,
      lease,
      activity,
      render,
      // 10 steps per frame caps catch-up work at ~166 ms of simulation; a
      // frame over 1 s (hidden tab, debugger pause) stops the run instead of
      // replaying an unbounded backlog.
      new FixedStepClock(options.fixedDtSeconds ?? 1 / 60, 10, 1),
      options.onStop,
    );
    try {
      lease.setFrameHook((frameSeconds) => run.onFrame(frameSeconds));
    } catch (error) {
      run.dispose();
      throw asGameSdkError(error, "game_runtime_fault", "prepare");
    }
    return run;
  }
}
