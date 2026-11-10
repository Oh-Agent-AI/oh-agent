import type { CameraPose, GameSceneAcquisition, GameSceneLease, GameScenePort, GameSelection } from "../../game/runtime/GameScenePort";
import { HostGameScenePort, type CapturedStaticScene, type HostAvailability, type HostCaptureResult } from "../../game/runtime/HostGameScenePort";

/** Browser-owned callbacks for a visitor's isolated, in-memory game scene. */
export type VisitorGameSceneCallbacks<Snapshot, VisualObject> = Readonly<{
  epoch(): number;
  isAlive(): boolean;
  canAcquire?(selection: GameSelection): HostAvailability;
  capture(selection: GameSelection, signal: AbortSignal): Promise<HostCaptureResult<Snapshot>>;
  captureReturnState(): unknown;
  restoreReturnState(token: symbol, state: unknown): void;
  setFrameHook(token: symbol, hook: ((dt: number) => void) | null): void;
  attach(token: symbol, objects: readonly VisualObject[]): void;
  detach(token: symbol, objects: readonly VisualObject[]): void;
  setCamera(token: symbol, pose: CameraPose): void;
  setAmbientCarsVisible(token: symbol, visible: boolean): void;
  onReleased?(token: symbol): void;
}>;

/**
 * A local-only GameScenePort for a remote visitor's browser instance.
 * It owns no persistence, transport, or desktop CityEngine reference; the
 * provided callbacks operate only on the visitor's in-memory renderer.
 */
export class VisitorGameScenePort<Snapshot, VisualObject> implements GameScenePort<Snapshot, VisualObject> {
  private readonly lifecycle: HostGameScenePort<Snapshot, VisualObject>;

  constructor(visitor: VisitorGameSceneCallbacks<Snapshot, VisualObject>) {
    this.lifecycle = new HostGameScenePort({
      epoch: visitor.epoch,
      isAlive: visitor.isAlive,
      canAcquire: visitor.canAcquire ?? (() => true),
      capture: (selection, signal) => captureForVisitor(visitor.capture(selection, signal), signal),
      captureReturnState: visitor.captureReturnState,
      takeOwnership: () => true,
      restoreReturnState: visitor.restoreReturnState,
      setFrameHook: visitor.setFrameHook,
      attach: visitor.attach,
      detach: visitor.detach,
      setCamera: visitor.setCamera,
      setAmbientCarsVisible: visitor.setAmbientCarsVisible,
      onReleased: visitor.onReleased,
    });
  }

  acquire(selection: GameSelection, runId: number, signal: AbortSignal): Promise<GameSceneLease<Snapshot, VisualObject>> {
    return this.lifecycle.acquire(selection, runId, signal);
  }

  acquireResult(selection: GameSelection, runId: number, signal: AbortSignal): Promise<GameSceneAcquisition<Snapshot, VisualObject>> {
    return this.lifecycle.acquireResult(selection, runId, signal);
  }

  /** Invalidates any lease when the visitor renderer is being disposed. */
  invalidate(): void { this.lifecycle.invalidate(); }
}

// Keep the capture type referenced here as part of this adapter's contract.
export type VisitorGameSceneCapture<Snapshot> = CapturedStaticScene<Snapshot>;

/** Return promptly on visitor cancellation and dispose a capture that resolves later. */
function captureForVisitor<Snapshot>(capturePromise: Promise<HostCaptureResult<Snapshot>>, signal: AbortSignal): Promise<HostCaptureResult<Snapshot>> {
  if (signal.aborted) {
    void capturePromise.then(releaseCapture, () => {});
    return Promise.resolve({ status: "cancelled", reason: "cancelled" });
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: HostCaptureResult<Snapshot>) => {
      if (settled) {
        releaseCapture(result);
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => finish({ status: "cancelled", reason: "cancelled" });
    signal.addEventListener("abort", abort, { once: true });
    void capturePromise.then(finish, () => finish({ status: "unavailable", reason: "capture-failed" }));
  });
}

function releaseCapture<Snapshot>(result: HostCaptureResult<Snapshot>): void {
  if (result.status === "ready") {
    try { result.capture.release(); } catch { /* stale visitor captures are best-effort cleanup */ }
  }
}
