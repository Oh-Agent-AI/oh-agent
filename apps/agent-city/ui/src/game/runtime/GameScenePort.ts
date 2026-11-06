/** Host-internal capability contracts, NOT plugin IPC. One CityEngine owns one port. */
export type GameSelection =
  | Readonly<{ vehicle: "plane"; activity: "practice" | "race" }>
  | Readonly<{ vehicle: "car"; activity: "free" }>;
export type CameraPose = Readonly<{
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  up: readonly [number, number, number];
  fov: number;
}>;
export interface RuntimeSceneLease {
  readonly revision: string;
  isCurrent(): boolean;
  setFrameHook(callback: ((dt: number) => void) | null): void;
  release(): void;
}
export interface GameSceneLease<Snapshot, VisualObject> extends RuntimeSceneLease {
  readonly token: symbol;
  readonly hostEpoch: number;
  readonly selection: GameSelection;
  readonly runId: number;
  readonly snapshot: Snapshot;
  attach(objects: readonly VisualObject[]): void;
  detach(objects: readonly VisualObject[]): void;
  setCamera(pose: CameraPose): void;
  setAmbientCarsVisible(visible: boolean): void;
  /** Token-checked and idempotent; restores ReturnState and releases the static pin. */
  release(): void;
}
export interface GameScenePort<Snapshot, VisualObject> {
  acquire(selection: GameSelection, runId: number, signal: AbortSignal): Promise<GameSceneLease<Snapshot, VisualObject>>;
  acquireResult(selection: GameSelection, runId: number, signal: AbortSignal): Promise<GameSceneAcquisition<Snapshot, VisualObject>>;
}
export type GameSceneAcquisition<Snapshot, VisualObject> =
  | Readonly<{ status: "ready"; lease: GameSceneLease<Snapshot, VisualObject> }>
  | Readonly<{ status: "busy" | "cancelled" | "unavailable"; reason: string }>;
export interface VehicleAdapter<Input = unknown> {
  readonly revision: string;
  isCurrent(): boolean;
  prepare(signal: AbortSignal): void | Promise<void>;
  /** false ends this frame's catch-up at an activity boundary (e.g. countdown). */
  fixedStep(input: Readonly<Input>, dt: number): void | boolean;
  present(alpha: number, frameSeconds: number): void;
  settle(): void;
  reset(): void;
  dispose(): void;
}
