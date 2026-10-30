/** Isolated Assault movement/action player. No rule or target state is changed. */
import { MovementStage, MovementThenAction, type MovementPoint } from "./movementStage";
import type { MechaAction } from "../../render/mecha/animation";

export type AssaultTurn = { id: number; points: MovementPoint[]; action?: MechaAction; actionDuration: number; hp: number; target?: string };
export type AssaultFrame = { position: MovementPoint; phase: "idle" | "moving" | "acting" | "done"; started?: AssaultTurn; actionElapsed?: number; completed?: number; pending: number };
const distance = (a: MovementPoint, b: MovementPoint) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);

export class AssaultTurnPlayer {
  private readonly speed: number;
  private position: MovementPoint;
  private readonly waiting: AssaultTurn[] = [];
  private active: { turn: AssaultTurn; stage: MovementThenAction } | null = null;
  private lastId = 0;
  private expectedEnd: MovementPoint;
  private paused = false;
  private lastPhase: AssaultFrame["phase"] = "idle";
  constructor(initial: MovementPoint, speed: number, baseId = 0) {
    if (![initial.x,initial.y,initial.z,speed].every(Number.isFinite) || speed <= 0 || !Number.isInteger(baseId) || baseId < 0) throw new Error("invalid initial movement state");
    this.position = { ...initial }; this.expectedEnd = { ...initial }; this.speed = speed; this.lastId = baseId;
  }
  get pending(): number { return this.waiting.length + (this.active ? 1 : 0); }
  setPaused(paused: boolean): void { this.paused = paused; this.active?.stage.setPaused(paused); }
  enqueue(turn: AssaultTurn): void {
    if (!Number.isInteger(turn.id) || turn.id !== this.lastId + 1 || !Number.isFinite(turn.actionDuration) || turn.actionDuration < 0 || !Number.isFinite(turn.hp) || !turn.points.length || turn.points.some(p => ![p.x,p.y,p.z].every(Number.isFinite))) throw new Error("invalid or missing turn");
    if (distance(this.expectedEnd,turn.points[0]!) > 1e-4) throw new Error("turn route is discontinuous");
    const copy = { ...turn, points: turn.points.map(p=>({ ...p })) };
    this.waiting.push(copy); this.lastId=turn.id; this.expectedEnd={ ...copy.points.at(-1)! };
  }
  advance(dt: number): AssaultFrame {
    if (!Number.isFinite(dt) || dt < 0) throw new Error("invalid frame time");
    if (this.paused) return { position: { ...this.position }, phase: this.lastPhase, pending: this.pending };
    if (!this.active && this.waiting.length) {
      const turn=this.waiting.shift()!;
      this.active={ turn, stage:new MovementThenAction(new MovementStage(this.position,turn.points,this.speed),turn.actionDuration) };
    }
    if (!this.active) { this.lastPhase = "idle"; return { position:{ ...this.position }, phase:"idle", pending:0 }; }
    const current=this.active, result=current.stage.advance(dt); this.position={ ...result.position };
    const started=result.actionStarted ? current.turn : undefined;
    const completed=result.phase === "done" ? current.turn.id : undefined;
    if (completed !== undefined) this.active=null;
    this.lastPhase = result.phase;
    return { position:{ ...this.position }, phase:result.phase, ...(started ? { started, actionElapsed: result.actionElapsed } : {}), ...(completed !== undefined ? { completed } : {}), pending:this.pending };
  }
}

/** A committed cue holds the next turn until that exact cue finishes. */
export function assaultSequenceWaiting(active: boolean, cue: { id: number; reset?: true }, status: { id: number; state: "done" | "fault" } | null): boolean {
  return active && !cue.reset && (status?.id !== cue.id || status.state !== "done");
}
