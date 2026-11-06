/** Renderer-independent car adapter. The runtime owns input and the frame clock.
 * A binding must contain one frozen environment/kernel identity; changing worlds
 * requires a new adapter, never replacing an environment underneath a live car.
 */
import { DrivingKernel, validDrivingState } from "../driving/DrivingKernel";
import type { DrivingInputState, DrivingState } from "../DrivingSimulation";
import type { VehicleAdapter } from "./GameScenePort";
import type { CameraClearanceQuery } from "../VehicleChaseCamera";

/** VTOL 会话在 DrivingState 之上追加的三字段（默认会话不存在，呈现层按可选消费）。 */
export type CarVtolFields = Readonly<{ airborne: boolean; verticalSpeed: number; boost: number }>;
export type CarPresentationState = Readonly<DrivingState & Partial<CarVtolFields>>;

export type CarWorldBinding = Readonly<{
  revision: string;
  kernel: DrivingKernel;
  isCurrent(): boolean;
  /** Uses the same frozen support/collision facts as the kernel. */
  validateSpawn(state: Readonly<DrivingState>): boolean;
}>;
export type CarPresentation = Readonly<{
  revision: string;
  state: CarPresentationState;
  blocked: boolean;
  reason: string | null;
  contactIds: readonly string[];
  queryStatus: "resolved" | "unresolved" | undefined;
  frameSeconds: number;
  /** Frozen query over the same compiled solids used by car movement. */
  cameraSweep: CameraClearanceQuery;
}>;
export class CarAdapter implements VehicleAdapter<DrivingInputState> {
  private state: Readonly<DrivingState>;
  private previous: Readonly<DrivingState>;
  private prepared = false;
  private disposed = false;
  private blocked = false;
  private reason: string | null = null;
  private contactIds: readonly string[] = Object.freeze([]);
  private queryStatus: "resolved" | "unresolved" | undefined;
  readonly revision: string;
  constructor(private readonly binding: CarWorldBinding, private readonly spawn: Readonly<DrivingState>,
    private readonly render: (frame: CarPresentation) => void, private readonly cameraSweep: CameraClearanceQuery) {
    this.binding = Object.freeze({ ...binding });
    this.revision = binding.revision;
    this.spawn = Object.freeze({ ...spawn });
    this.state = this.previous = this.spawn;
  }
  isCurrent(): boolean { return !this.disposed && this.binding.isCurrent(); }
  get snapshot(): Readonly<DrivingState> { return Object.freeze({ ...this.state }); }
  async prepare(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("prepare-aborted");
    this.assertCurrent();
    if (!this.revision || !validDrivingState(this.spawn) || this.spawn.speed !== 0 ||
      !this.binding.validateSpawn(this.spawn)) throw new Error("unsafe-car-spawn");
    this.assertCurrent();
    if (signal.aborted) throw new Error("prepare-aborted");
    this.prepared = true;
  }
  fixedStep(input: Readonly<DrivingInputState>): void {
    this.assertReady();
    const result = this.binding.kernel.step(this.state, input);
    // A query may synchronously invalidate the captured world. Never commit or
    // display that step, even when its numerical result looks valid.
    this.assertCurrent();
    this.previous = this.state; this.state = result.state;
    this.blocked = result.motion.blocked || result.motion.contact === true; this.reason = result.motion.reason;
    this.contactIds = Object.freeze([...new Set(result.motion.contacts?.map((contact) => contact.obstacleId) ?? [])].slice(0, 32));
    this.queryStatus = result.motion.queryStatus;
  }
  present(alpha: number, frameSeconds = 0): void {
    this.assertReady();
    // A future verified portal transition must not synthesize a pose between
    // different support handles. Present the accepted endpoint until that
    // transition provides an explicitly validated presentation trajectory.
    const t = this.previous.surfaceId !== this.state.surfaceId ? 1 :
      Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
    const state: Record<string, unknown> = { ...this.state };
    // VTOL 数值字段（verticalSpeed/boost）仅在两端都存在时插值；默认会话跳过。
    const previousVtol = this.previous as CarPresentationState;
    for (const key of ["x", "y", "z", "heading", "pitch", "roll", "steering", "distance", "verticalSpeed", "boost"] as const) {
      const prev = previousVtol[key], next = state[key];
      if (typeof prev === "number" && typeof next === "number") state[key] = prev + (next - prev) * t;
    }
    const delta = this.state.heading - this.previous.heading;
    state.heading = this.previous.heading + Math.atan2(Math.sin(delta), Math.cos(delta)) * t;
    this.render(Object.freeze({ revision: this.revision, state: Object.freeze(state) as CarPresentationState, blocked: this.blocked, reason: this.reason, frameSeconds,
      contactIds: this.contactIds, queryStatus: this.queryStatus, cameraSweep: this.cameraSweep }));
  }
  reset(): void {
    this.assertReady();
    if (!this.binding.validateSpawn(this.spawn)) throw new Error("unsafe-car-spawn");
    this.assertCurrent();
    this.state = this.previous = this.spawn; this.blocked = false; this.reason = null; this.contactIds = Object.freeze([]); this.queryStatus = "resolved";
  }
  /** Drop interpolation history when paused, avoiding a visible backward snap. */
  settle(): void { this.previous = this.state; }
  dispose(): void { this.disposed = true; this.prepared = false; }
  private assertCurrent(): void { if (!this.isCurrent()) throw new Error("stale-car-world"); }
  private assertReady(): void {
    this.assertCurrent();
    if (!this.prepared) throw new Error("car-not-prepared");
  }
}
