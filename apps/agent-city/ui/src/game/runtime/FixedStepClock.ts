/** Shared interactive clock. Offline audit deliberately uses ticks directly. */
export type ClockPauseCause = "invalid-delta" | "frame-gap" | "catch-up-budget";
export type ClockFrame = Readonly<{ steps: number; alpha: number; pauseRequired: boolean; cause: ClockPauseCause | null }>;
export class FixedStepClock {
  private accumulator = 0;
  constructor(readonly dt = 1 / 60, readonly maxSteps = 5, readonly pauseAfter = 0.25) {
    if (!Number.isFinite(dt) || dt <= 0 || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || !Number.isFinite(pauseAfter) || pauseAfter <= 0) throw new Error("invalid-fixed-clock");
  }
  clear(): void { this.accumulator = 0; }
  advance(frameSeconds: number, paused: boolean, step: () => void | boolean): ClockFrame {
    if (paused || !Number.isFinite(frameSeconds) || frameSeconds < 0 || frameSeconds > this.pauseAfter) {
      const cause = paused ? null : !Number.isFinite(frameSeconds) || frameSeconds < 0 ? "invalid-delta" : "frame-gap";
      this.clear(); return { steps: 0, alpha: 1, pauseRequired: !paused, cause };
    }
    this.accumulator += frameSeconds;
    let steps = 0;
    while (this.accumulator + 1e-12 >= this.dt && steps < this.maxSteps) {
      const proceed = step(); this.accumulator = Math.max(0, this.accumulator - this.dt); steps++;
      if (proceed === false) { this.clear(); return { steps, alpha: 1, pauseRequired: false, cause: null }; }
    }
    if (steps === this.maxSteps && this.accumulator + 1e-12 >= this.dt) {
      this.clear(); return { steps, alpha: 1, pauseRequired: true, cause: "catch-up-budget" };
    }
    return { steps, alpha: this.accumulator / this.dt, pauseRequired: false, cause: null };
  }
}
