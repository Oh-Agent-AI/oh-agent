/** Monotonic elapsed time excluding intervals while the page is hidden. */
export class ActiveTimeClock {
  private paused = false;
  private pauseStarted = 0;
  private pausedDuration = 0;
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) { this.now = now; }

  setPaused(paused: boolean) {
    if (this.paused === paused) return;
    const now = this.now();
    if (paused) this.pauseStarted = now;
    else this.pausedDuration += now - this.pauseStarted;
    this.paused = paused;
  }

  time() {
    const now = this.now();
    return now - this.pausedDuration - (this.paused ? now - this.pauseStarted : 0);
  }
}
