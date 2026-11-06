import type { CameraPose, GameSceneAcquisition, GameSceneLease, GameScenePort, GameSelection } from "./GameScenePort";

export type CapturedStaticScene<Snapshot> = Readonly<{
  revision: string;
  snapshot: Snapshot;
  isCurrent(): boolean;
  verifyCurrent?(): boolean;
  release(): void;
}>;
export type HostCaptureResult<Snapshot> =
  | Readonly<{ status: "ready"; capture: CapturedStaticScene<Snapshot> }>
  | Readonly<{ status: "cancelled" | "unavailable"; reason?: string }>;
export type HostAvailability = true | false | Readonly<{ status: "busy" | "unavailable"; reason: string }>;
export type HostReturnState = unknown;
export type HostGameScenePortOptions<Snapshot, VisualObject> = Readonly<{
  epoch(): number;
  isAlive(): boolean;
  canAcquire(selection: GameSelection): HostAvailability;
  capture(selection: GameSelection, signal: AbortSignal): Promise<HostCaptureResult<Snapshot>>;
  captureReturnState(): HostReturnState;
  takeOwnership(token: symbol): boolean;
  restoreReturnState(token: symbol, state: HostReturnState): void;
  setFrameHook(token: symbol, hook: ((dt: number) => void) | null): void;
  attach(token: symbol, objects: readonly VisualObject[]): void;
  detach(token: symbol, objects: readonly VisualObject[]): void;
  setCamera(token: symbol, pose: CameraPose): void;
  setAmbientCarsVisible(token: symbol, visible: boolean): void;
  onReleased?(token: symbol): void;
}>;

type Active<Snapshot, VisualObject> = {
  token: symbol; epoch: number; selection: GameSelection; runId: number;
  returned: HostReturnState; capture: CapturedStaticScene<Snapshot> | null;
  released: boolean; tookOwnership: boolean; attached: Set<VisualObject>;
};

/** A synchronous exclusive reservation around an asynchronous static-world capture. */
export class HostGameScenePort<Snapshot, VisualObject> implements GameScenePort<Snapshot, VisualObject> {
  private active: Active<Snapshot, VisualObject> | null = null;
  constructor(private readonly host: HostGameScenePortOptions<Snapshot, VisualObject>) {}

  async acquire(selection: GameSelection, runId: number, signal: AbortSignal): Promise<GameSceneLease<Snapshot, VisualObject>> {
    const result = await this.acquireResult(selection, runId, signal);
    if (result.status === "ready") return result.lease;
    throw new Error(result.reason);
  }

  async acquireResult(selection: GameSelection, runId: number, signal: AbortSignal): Promise<GameSceneAcquisition<Snapshot, VisualObject>> {
    if (signal.aborted) return Object.freeze({ status: "cancelled", reason: "cancelled" });
    try { if (!this.host.isAlive()) return Object.freeze({ status: "unavailable", reason: "host-disposed" }); }
    catch { return Object.freeze({ status: "unavailable", reason: "host-unavailable" }); }
    if (this.active) return Object.freeze({ status: "busy", reason: "scene-already-leased" });
    let availability: HostAvailability;
    try { availability = this.host.canAcquire(selection); }
    catch { return Object.freeze({ status: "unavailable", reason: "host-availability-failed" }); }
    if (availability !== true) return Object.freeze(typeof availability === "object" ? availability : { status: "busy", reason: "host-busy" });
    let returned: HostReturnState, epoch: number;
    try { returned = this.host.captureReturnState(); epoch = this.host.epoch(); }
    catch { return Object.freeze({ status: "unavailable", reason: "host-state-unavailable" }); }
    const token = Symbol(`game-scene-${runId}`);
    const state: Active<Snapshot, VisualObject> = { token, epoch, selection, runId, returned, capture: null, released: false, tookOwnership: false, attached: new Set<VisualObject>() };
    this.active = state; // Reserve before the first await; preparing is exclusive too.
    if (signal.aborted) { this.releaseState(state); return Object.freeze({ status: "cancelled", reason: "cancelled" }); }
    const abort = () => this.releaseState(state);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const captured = await this.host.capture(selection, signal);
      if (captured.status !== "ready") {
        this.releaseState(state);
        return Object.freeze({ status: captured.status, reason: boundedReason(captured.reason ?? captured.status) });
      }
      const capture = captured.capture;
      if (state.released) { capture.release(); return Object.freeze({ status: "cancelled", reason: "cancelled" }); }
      state.capture = capture;
      this.assertCurrent(state, signal);
      if (!capture.isCurrent() || (capture.verifyCurrent && !capture.verifyCurrent())) throw new Error("stale-game-world");
      if (!this.host.takeOwnership(token)) throw new Error("host-ownership-refused");
      state.tookOwnership = true;
      this.assertCurrent(state, signal);
      return Object.freeze({ status: "ready", lease: this.makeLease(state, capture) });
    } catch (error) {
      this.releaseState(state);
      return Object.freeze({ status: signal.aborted ? "cancelled" : "unavailable", reason: boundedReason(error) });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  invalidate(): void { const state = this.active; if (state) this.releaseState(state); }
  private current(state: Active<Snapshot, VisualObject>): boolean {
    return !state.released && this.active === state && this.host.isAlive() && this.host.epoch() === state.epoch &&
      !!state.capture?.isCurrent();
  }
  private assertCurrent(state: Active<Snapshot, VisualObject>, signal: AbortSignal): void {
    if (signal.aborted) throw new Error("cancelled");
    if (this.active !== state || state.released) throw new Error("stale-game-scene");
    if (!this.host.isAlive()) throw new Error("host-disposed");
    if (this.host.epoch() !== state.epoch) throw new Error("stale-game-world");
  }
  private makeLease(state: Active<Snapshot, VisualObject>, capture: CapturedStaticScene<Snapshot>): GameSceneLease<Snapshot, VisualObject> {
    const host = this.host;
    const isCurrent = () => this.current(state);
    const requireCurrent = () => { if (!isCurrent()) throw new Error("stale-game-scene"); };
    return Object.freeze({
      token: state.token, hostEpoch: state.epoch, selection: state.selection, runId: state.runId,
      revision: capture.revision, snapshot: capture.snapshot, isCurrent,
      setFrameHook: (hook: ((dt: number) => void) | null) => {
        if (hook === null) { if (this.active === state && !state.released) host.setFrameHook(state.token, null); return; }
        requireCurrent(); host.setFrameHook(state.token, (dt) => { if (isCurrent()) hook(dt); });
      },
      attach: (objects: readonly VisualObject[]) => {
        requireCurrent();
        objects.forEach((object) => state.attached.add(object));
        try { host.attach(state.token, objects); }
        catch (error) {
          // A host callback may partially attach before throwing. Clean only this
          // lease's objects, and retain their ownership record if cleanup fails
          // so terminal release can retry the detach.
          if (this.active === state && !state.released) {
            try {
              host.detach(state.token, objects);
              objects.forEach((object) => state.attached.delete(object));
            } catch { /* preserve attach failure; release retries */ }
          }
          throw error;
        }
      },
      detach: (objects: readonly VisualObject[]) => {
        // Old leases may only remove objects they attached, and after release they are no-ops.
        if (this.active === state && !state.released) {
          const owned = objects.filter((object) => state.attached.has(object));
          if (owned.length) host.detach(state.token, owned);
          owned.forEach((object) => state.attached.delete(object));
        }
      },
      setCamera: (pose: CameraPose) => { requireCurrent(); validatePose(pose); host.setCamera(state.token, pose); },
      setAmbientCarsVisible: (visible: boolean) => { requireCurrent(); host.setAmbientCarsVisible(state.token, visible); },
      release: () => this.releaseState(state),
    });
  }
  private releaseState(state: Active<Snapshot, VisualObject>): void {
    if (state.released) return;
    state.released = true;
    const ownsSlot = this.active === state;
    if (ownsSlot) this.active = null;
    if (ownsSlot) {
      try { this.host.setFrameHook(state.token, null); } catch { /* continue cleanup */ }
      if (state.attached.size) { try { this.host.detach(state.token, [...state.attached]); } catch { /* continue cleanup */ } state.attached.clear(); }
      try { this.host.onReleased?.(state.token); } catch { /* continue cleanup */ }
      if (state.tookOwnership) { try { this.host.restoreReturnState(state.token, state.returned); } catch { /* continue cleanup */ } }
    }
    try { state.capture?.release(); } catch { /* continue cleanup */ }
  }
}

function boundedReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "capture-failed";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120) || "capture-failed";
}

function validatePose(pose: CameraPose): void {
  if (![...pose.position, ...pose.target, ...pose.up, pose.fov].every(Number.isFinite) || pose.fov <= 0 || pose.fov >= 180) {
    throw new Error("invalid-camera-pose");
  }
  const direction = pose.target.map((value, index) => value - pose.position[index]);
  const upLength = Math.hypot(...pose.up), directionLength = Math.hypot(...direction);
  if (upLength < 1e-8 || directionLength < 1e-8) throw new Error("invalid-camera-pose");
  const cross = [pose.up[1] * direction[2] - pose.up[2] * direction[1],
    pose.up[2] * direction[0] - pose.up[0] * direction[2], pose.up[0] * direction[1] - pose.up[1] * direction[0]];
  if (Math.hypot(...cross) <= upLength * directionLength * 1e-8) throw new Error("invalid-camera-pose");
}
