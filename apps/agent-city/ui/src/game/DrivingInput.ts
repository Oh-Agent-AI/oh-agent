import { EMPTY_DRIVING_INPUT, type DrivingInputState } from "./DrivingSimulation";

/** Canvas-scoped keyboard adapter; never consumes typing or keeps keys after focus loss. */
export class DrivingInput {
  private state = { ...EMPTY_DRIVING_INPUT };
  private attached = false;
  constructor(private readonly canvas: HTMLCanvasElement, private readonly actions: {
    isRunning: () => boolean; pause: () => void; togglePause: () => void; reset: () => void;
  }) {}
  snapshot(): DrivingInputState { return { ...this.state }; }
  clear(): void { this.state = { ...EMPTY_DRIVING_INPUT }; }
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener("keydown", this.down);
    window.addEventListener("keyup", this.up);
    window.addEventListener("blur", this.interrupt);
    document.addEventListener("visibilitychange", this.visibility);
    this.canvas.addEventListener("blur", this.interrupt);
  }
  detach(): void {
    if (!this.attached) return;
    this.attached = false; this.clear();
    window.removeEventListener("keydown", this.down);
    window.removeEventListener("keyup", this.up);
    window.removeEventListener("blur", this.interrupt);
    document.removeEventListener("visibilitychange", this.visibility);
    this.canvas.removeEventListener("blur", this.interrupt);
  }
  private readonly map: Record<string, keyof DrivingInputState> = { KeyW: "forward", KeyS: "backward", KeyA: "left", KeyD: "right" };
  private readonly down = (event: KeyboardEvent) => {
    if (event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey || document.activeElement !== this.canvas) return;
    const key = this.map[event.code];
    if (!key && event.code !== "Escape" && event.code !== "KeyR") return;
    event.preventDefault();
    if (event.code === "Escape") { this.clear(); this.actions.togglePause(); }
    else if (event.code === "KeyR") { this.clear(); this.actions.reset(); }
    else if (this.actions.isRunning()) this.state[key] = true;
  };
  private readonly up = (event: KeyboardEvent) => { const key = this.map[event.code]; if (key) this.state[key] = false; };
  private readonly interrupt = () => { this.clear(); this.actions.pause(); };
  private readonly visibility = () => { if (document.visibilityState === "hidden") this.interrupt(); };
}
