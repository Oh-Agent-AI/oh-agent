import type { CityInstanceV1, DiagnosticV1, GameTypeDescriptorV1, MiniGamePackV1 } from "../../agent-vitals-city-sdk/src/index";
import type { GameActivityPortV1, GameAudioPortV1, GameClockPortV1, GameInputPortV1, GameScenePortV1 } from "./ports";
import type { GameRuntimeErrorCodeV1 } from "./errors";

export type GameRuntimeStatusV1 = "ready" | "running" | "success" | "failure" | "error";

/** Runtime telemetry is presentation/evidence only; content rules consume the
 * declarative events emitted by the runtime adapter. */
export type GameRuntimeTelemetryV1 = Readonly<{
  status: GameRuntimeStatusV1;
  tick: number;
  counters: Readonly<Record<string, number>>;
  metrics: Readonly<Record<string, number>>;
  reason: string | null;
}>;

export type GameRuntimeFailureV1 = Readonly<{
  code: GameRuntimeErrorCodeV1 | string;
  message: string;
  diagnostics?: readonly DiagnosticV1[];
}>;

export type GameRuntimeResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; failure: GameRuntimeFailureV1 };

export type GameRuntimeContextV1 = Readonly<{
  /** Frozen instance selected by the host; runtime must not read another City. */
  city: CityInstanceV1;
  pack: MiniGamePackV1;
  mount: Readonly<Record<string, unknown>>;
  seed: number;
  worldRevision: string;
  scene: GameScenePortV1;
  input: GameInputPortV1;
  audio: GameAudioPortV1;
  clock: GameClockPortV1;
  activity: GameActivityPortV1;
}>;

export type GameRuntimeExecutionV1 = "fixed-step" | "host-driven";

export type GameRuntimeHandleV1 = Readonly<{
  telemetry: () => GameRuntimeTelemetryV1;
  /** Present only for fixed-step runtimes; host-driven activities keep their
   * existing frame hook and must not be double-stepped by the SDK. */
  fixedStep?: () => void;
  dispose: () => void;
}>;

/** A trusted app-side implementation. Content can never supply code here. */
export type GameRuntimeV1 = Readonly<{
  readonly type: string;
  readonly contractVersion: number;
  /** `host-driven` adapters delegate lifecycle to an existing activity; the SDK
   * never drives their simulation clock. */
  readonly execution: GameRuntimeExecutionV1;
  prepare: (context: GameRuntimeContextV1) => Promise<GameRuntimeResultV1<GameRuntimeHandleV1>>;
}>;

export type RegisteredGameRuntimeV1 = Readonly<{
  descriptor: GameTypeDescriptorV1;
  runtime: GameRuntimeV1;
}>;
