/** Playback rate is a presentation-only setting; it never changes rule time. */
export type ReplaySpeed = 0.5 | 1 | 2;

export function performanceDelta(dt: number, paused: boolean, reducedMotion: boolean, speed: ReplaySpeed): number {
  if (paused) return 0;
  if (reducedMotion) return Number.POSITIVE_INFINITY;
  return Math.max(0, Number.isFinite(dt) ? dt : 0) * speed;
}

/** Tracks the visible duration of a no-event round across pause/rate changes. */
export class ReplayHoldClock {
  private remainingMs: number;
  private startedAt: number | null = null;
  private speed: ReplaySpeed = 1;

  constructor(durationMs = 2000) { this.remainingMs = Math.max(0, durationMs); }

  start(now: number, speed: ReplaySpeed): number {
    this.stop(now);
    this.startedAt = now;
    this.speed = speed;
    return this.remainingMs / speed;
  }

  stop(now: number): number {
    if (this.startedAt !== null) {
      this.remainingMs = Math.max(0, this.remainingMs - Math.max(0, now - this.startedAt) * this.speed);
      this.startedAt = null;
    }
    return this.remainingMs;
  }
}
