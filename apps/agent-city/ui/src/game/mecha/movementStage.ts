/** Time-based movement stage. Coordinates are scene units; this class does not alter rules state. */
export type MovementPoint = { x: number; y: number; z: number };
export type MovementResult = { position: MovementPoint; arrived: boolean; remainingSeconds: number };

function distance(a: MovementPoint, b: MovementPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function finite(point: MovementPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

/**
 * A single already-approved path. Caller must validate terrain and collisions separately.
 * The initial waypoint must match the displayed actor position; it is never teleported to a route.
 */
export class MovementStage {
  private readonly points: MovementPoint[];
  private readonly speed: number;
  private position: MovementPoint;
  private segment = 1;
  private paused = false;

  constructor(current: MovementPoint, waypoints: readonly MovementPoint[], speed: number, tolerance = 1e-4) {
    if (!finite(current) || !Number.isFinite(speed) || speed <= 0 || !Number.isFinite(tolerance) || tolerance < 0 || !waypoints.length || waypoints.some((p) => !finite(p))) {
      throw new Error("invalid movement stage");
    }
    if (distance(current, waypoints[0]!) > tolerance) throw new Error("movement route starts away from actor");
    this.points = waypoints.map((p) => ({ ...p }));
    this.position = { ...current };
    this.speed = speed;
  }
  setPaused(paused: boolean): void { this.paused = paused; }
  get arrived(): boolean { return this.segment >= this.points.length; }
  /** Unused time lets the next stage start in the same frame without losing time. */
  advance(dt: number): MovementResult {
    if (!Number.isFinite(dt) || dt < 0) throw new Error("invalid movement time");
    if (this.paused) return { position: { ...this.position }, arrived: this.arrived, remainingSeconds: 0 };
    let remaining = dt;
    while (!this.arrived) {
      const next = this.points[this.segment]!;
      const length = distance(this.position, next);
      if (length <= 1e-10) { this.position = { ...next }; this.segment++; continue; }
      const travel = Math.min(length, remaining * this.speed);
      const t = travel / length;
      this.position = { x: this.position.x + (next.x - this.position.x) * t, y: this.position.y + (next.y - this.position.y) * t, z: this.position.z + (next.z - this.position.z) * t };
      remaining = Math.max(0, remaining - travel / this.speed);
      if (travel < length) break;
      this.position = { ...next }; this.segment++;
    }
    return { position: { ...this.position }, arrived: this.arrived, remainingSeconds: this.arrived ? remaining : 0 };
  }
}

/** Emits a single action-start signal only after the route is complete. */
export class MovementThenAction {
  private phase: "moving" | "acting" | "done" = "moving";
  private elapsed = 0;
  private paused = false;
  private readonly movement: MovementStage;
  private readonly actionDuration: number;
  constructor(movement: MovementStage, actionDuration: number) {
    if (!Number.isFinite(actionDuration) || actionDuration < 0) throw new Error("invalid action duration");
    this.movement = movement; this.actionDuration = actionDuration;
  }
  setPaused(paused: boolean): void { this.paused = paused; this.movement.setPaused(paused); }
  advance(dt: number): { phase: "moving" | "acting" | "done"; position: MovementPoint; actionStarted: boolean; actionElapsed: number } {
    if (!Number.isFinite(dt) || dt < 0) throw new Error("invalid choreography time");
    const step = this.movement.advance(this.phase === "moving" ? dt : 0);
    let actionStarted = false;
    if (!this.paused && this.phase === "moving" && step.arrived) {
      this.phase = "acting"; actionStarted = true; this.elapsed += step.remainingSeconds;
    } else if (!this.paused && this.phase === "acting") this.elapsed += dt;
    if (this.phase === "acting" && this.elapsed >= this.actionDuration) { this.elapsed = this.actionDuration; this.phase = "done"; }
    return { phase: this.phase, position: step.position, actionStarted, actionElapsed: this.elapsed };
  }
}
