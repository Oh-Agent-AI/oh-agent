/** Bridge for the existing flight activity. GameSession retains race/audio rules;
 * GameRuntime exclusively owns its fixed clock, host frame and resource lifetime. */
import type { FlightInputState } from "../types";
import type { VehicleAdapter } from "./GameScenePort";
export type FlightActivityBinding = Readonly<{
  isCurrent(): boolean;
  prepare(): void;
  fixedStep(input: Readonly<FlightInputState>, dt: number): boolean | void;
  present(alpha: number, frameSeconds: number): void;
  reset(): void;
  settle(): void;
  dispose(): void;
}>;
export class FlightAdapter implements VehicleAdapter<FlightInputState> {
  private prepared = false;
  private disposed = false;
  constructor(readonly revision: string, private readonly activity: FlightActivityBinding) {}
  isCurrent(): boolean { return !this.disposed && this.activity.isCurrent(); }
  prepare(signal: AbortSignal): void {
    if (signal.aborted || !this.isCurrent()) throw new Error("stale-flight-world");
    this.activity.prepare(); this.prepared = true;
  }
  fixedStep(input: Readonly<FlightInputState>, dt: number): boolean | void { this.assertReady(); return this.activity.fixedStep(input, dt); }
  present(alpha: number, seconds: number): void { this.assertReady(); this.activity.present(alpha, seconds); }
  reset(): void { this.assertReady(); this.activity.reset(); }
  settle(): void { this.activity.settle(); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.prepared = false; this.activity.dispose(); }
  private assertReady(): void { if (!this.prepared || !this.isCurrent()) throw new Error("stale-flight-world"); }
}
