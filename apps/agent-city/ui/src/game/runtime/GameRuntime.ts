/** Vehicle-independent lifecycle and fixed-step loop on the host's single frame
 * hook. Adapters own vehicle/mission rules; the runtime owns cancellation and
 * cleanup. Offline audit feeds the same motors directly without this clock. */
import { FixedStepClock } from "./FixedStepClock";
import type { VehicleAdapter, RuntimeSceneLease } from "./GameScenePort";
import { RuntimeDiagnostics, type RuntimeDiagnosticSnapshot } from "./RuntimeDiagnostics";
import type { PreparationMetric, PreparationStage } from "./Preparation";

export type GameRuntimeLease = RuntimeSceneLease;
export type RuntimePhase = "idle" | "preparing" | "paused" | "running" | "error" | "disposed";
export type RuntimeSnapshot = Readonly<{ phase: RuntimePhase; runId: number; revision: string | null; reason: string | null }>;
export type RuntimeOptions<Input> = Readonly<{
  dt?: number;
  emptyInput?: () => Input;
  onPause?: (reason: string) => void;
  onError?: (reason: string) => void;
  /** Monotonic local timing only; useful for deterministic diagnostic fixtures. */
  now?: () => number;
}>;
type Session<Input> = { id: number; abort: AbortController; lease: GameRuntimeLease; adapter: VehicleAdapter<Input>; cleaned: boolean };
export class GameRuntime<Input extends object = Record<string, boolean>> {
  private phase: RuntimePhase = "idle";
  private reason: string | null = null;
  private serial = 0;
  private session: Session<Input> | null = null;
  private input: Input;
  private readonly clock: FixedStepClock;
  private readonly timing = new RuntimeDiagnostics();
  private preparationPending = false;
  private preparationMs: Partial<Record<PreparationStage, number>> = {};
  constructor(private readonly options: RuntimeOptions<Input> = {}) {
    this.input = this.emptyInput(); this.clock = new FixedStepClock(options.dt ?? 1 / 60);
  }
  get snapshot(): RuntimeSnapshot {
    return Object.freeze({ phase: this.phase, runId: this.serial, revision: this.session?.lease.revision ?? null, reason: this.reason });
  }
  get diagnostics(): RuntimeDiagnosticSnapshot { return Object.freeze({ ...this.timing.snapshot(this.now()), preparationMs: Object.freeze({ ...this.preparationMs }) }); }
  beginPreparation(): void { this.preparationMs = {}; this.preparationPending = true; }
  /** Present 阶段（追尾相机）上报本帧相机安全级；随下一帧指标一并记录后清空。 */
  noteCameraSafety(safety: "clear" | "shrunk" | "held" | "unresolved"): void {
    if (["clear", "shrunk", "held", "unresolved"].includes(safety)) this.frameCameraSafety = safety;
  }
  private frameCameraSafety: "clear" | "shrunk" | "held" | "unresolved" | undefined;
  recordPreparation(metric: PreparationMetric): void {
    if (!Number.isFinite(metric.durationMs) || metric.durationMs < 0 || !["world-capture", "world-read", "surface-index", "surface-regions", "static-solids", "collision-world", "diagnostic-spawn"].includes(metric.stage)) return;
    if (!this.preparationPending) this.beginPreparation();
    this.preparationMs[metric.stage] = metric.durationMs;
  }
  private now(): number { return this.options.now?.() ?? (typeof performance !== "undefined" ? performance.now() : 0); }
  async enter(lease: GameRuntimeLease, adapter: VehicleAdapter<Input>): Promise<boolean> {
    const session = this.begin(lease, adapter);
    if (!session) return false;
    try { this.assertCurrent(session); await adapter.prepare(session.abort.signal); return this.finishEntry(session); }
    catch (error) { if (this.session === session) this.fail(session, error); return false; }
    finally { if (this.session !== session) this.cleanup(session); }
  }
  /** Preserves synchronous admission for already-prepared local flight resources.
   * Uses the exact same ownership/cancellation path as asynchronous car entry. */
  enterSync(lease: GameRuntimeLease, adapter: VehicleAdapter<Input>): boolean {
    const session = this.begin(lease, adapter);
    if (!session) return false;
    try {
      this.assertCurrent(session);
      const prepared = adapter.prepare(session.abort.signal);
      if (prepared && typeof prepared.then === "function") {
        void prepared.catch(() => {});
        throw new Error("async-adapter-in-sync-entry");
      }
      return this.finishEntry(session);
    }
    catch (error) { if (this.session === session) this.fail(session, error); return false; }
    finally { if (this.session !== session) this.cleanup(session); }
  }
  private begin(lease: GameRuntimeLease, adapter: VehicleAdapter<Input>): Session<Input> | null {
    if (this.phase !== "idle" && this.phase !== "error") {
      try { adapter.dispose(); } finally { lease.release(); }
      return null;
    }
    if (this.session) this.cleanup(this.session);
    const session = { id: ++this.serial, abort: new AbortController(), lease, adapter, cleaned: false };
    this.session = session; this.phase = "preparing"; this.reason = null; this.clearInput(); this.clock.clear();
    this.timing.clear();
    if (!this.preparationPending) this.preparationMs = {};
    this.preparationPending = false;
    return session;
  }
  private finishEntry(session: Session<Input>): boolean {
    if (this.session !== session || session.abort.signal.aborted) return false;
    this.assertCurrent(session);
    this.phase = "paused";
    session.lease.setFrameHook((seconds) => this.frame(session, seconds));
    session.adapter.present(1, 0);
    if (this.session !== session || session.abort.signal.aborted) return false;
    if (!this.current(session)) throw new Error("stale-game-world");
    return true;
  }
  setInput(input: Readonly<Input>): void { this.input = this.phase === "running" ? { ...input } : this.emptyInput(); }
  clearInput(): void { this.input = this.emptyInput(); }
  pause(reason = "user-paused"): void {
    this.clearInput(); this.clock.clear();
    if (this.phase === "running" || this.phase === "paused") {
      const session = this.session;
      this.phase = "paused"; this.reason = reason;
      try {
        session?.adapter.settle();
        if (this.session === session) this.options.onPause?.(reason);
      } catch (error) { if (session && this.session === session) this.fail(session, error); }
    }
  }
  resume(): boolean {
    const session = this.session;
    this.clearInput(); this.clock.clear();
    if (this.phase !== "paused" || !session) return false;
    if (!this.current(session)) { this.fail(session, new Error("stale-game-world")); return false; }
    this.phase = "running"; this.reason = null; return true;
  }
  reset(): boolean {
    const session = this.session;
    this.clearInput(); this.clock.clear();
    if (!session || (this.phase !== "paused" && this.phase !== "running")) return false;
    try {
      if (!this.current(session)) throw new Error("stale-game-world");
      session.adapter.reset();
      if (this.session !== session) return false;
      this.assertCurrent(session); session.adapter.present(1, 0);
      if (this.session !== session) return false;
      this.assertCurrent(session); return true;
    } catch (error) { if (this.session === session) this.fail(session, error); return false; }
  }
  exit(): void {
    const session = this.session;
    this.session = null; this.clearInput(); this.clock.clear();
    if (session) this.cleanup(session);
    if (this.phase !== "disposed") this.phase = "idle";
    this.reason = null;
  }
  dispose(): void { this.exit(); this.phase = "disposed"; }
  private emptyInput(): Input { return this.options.emptyInput?.() ?? {} as Input; }
  private current(session: Session<Input>): boolean {
    return this.session === session && !session.abort.signal.aborted && session.lease.isCurrent() && session.adapter.isCurrent();
  }
  private assertCurrent(session: Session<Input>): void {
    if (session.lease.revision !== session.adapter.revision || !this.current(session)) throw new Error("stale-game-world");
  }
  private frame(session: Session<Input>, seconds: number): void {
    if (this.session !== session || (this.phase !== "running" && this.phase !== "paused")) return;
    try {
      if (!this.current(session)) throw new Error("stale-game-world");
      const beforeTicks = this.now();
      const stepFn = () => {
        if (!this.current(session)) throw new Error("stale-game-world");
        if (this.phase !== "running") return false;
        const proceed = session.adapter.fixedStep(this.input, this.clock.dt);
        return proceed !== false && this.phase === "running";
      };
      let frame = this.clock.advance(seconds, this.phase !== "running", stepFn);
      const limitCause = frame.cause;
      // 帧缺口按赛车项目惯例丢弃墙钟（Ammo stepSimulation(dt, maxSubSteps) 同款）：
      // 先按 maxSteps 吃得下的量补跑，超出部分静默丢弃——游戏慢半拍继续，不弹暂停
      // 打断玩家（2026-10-18 产品决定；原 fail-closed 暂停仅保留给 invalid-delta 脏数据）。
      // 离线审计不经过本运行时（见 FixedStepClock 注释），确定性路径不受影响。
      if (frame.pauseRequired && frame.cause === "frame-gap" && Number.isFinite(seconds) && seconds > 0) {
        frame = this.clock.advance(Math.min(seconds, this.clock.maxSteps * this.clock.dt), this.phase !== "running", stepFn);
      }
      const afterTicks = this.now();
      if (frame.pauseRequired && frame.cause === "invalid-delta") this.pause("long-frame");
      if (this.session !== session) return;
      if (!this.current(session)) throw new Error("stale-game-world");
      const beforePresent = this.now();
      session.adapter.present(frame.pauseRequired ? 1 : frame.alpha, Number.isFinite(seconds) && seconds >= 0 ? seconds : 0);
      if (this.session !== session) return;
      this.timing.record({ atMs: this.now(), frameMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0,
        tickCpuMs: Math.max(0, afterTicks - beforeTicks), presentCpuMs: Math.max(0, this.now() - beforePresent),
        steps: frame.steps, limitCause, cameraSafety: this.frameCameraSafety });
      this.frameCameraSafety = undefined;
    } catch (error) { if (this.session === session) this.fail(session, error); }
  }
  private fail(session: Session<Input>, error: unknown): void {
    if (this.session !== session) return;
    this.clearInput(); this.clock.clear(); this.phase = "error";
    this.reason = error instanceof Error ? error.message : "game-runtime-error";
    this.session = null; this.cleanup(session); this.options.onError?.(this.reason);
  }
  private cleanup(session: Session<Input>): void {
    if (session.cleaned) return;
    session.cleaned = true; session.abort.abort();
    try { session.lease.setFrameHook(null); } catch { /* release also clears the hook */ }
    try { session.adapter.dispose(); } catch { /* host ownership must still return */ }
    try { session.lease.release(); } catch { /* terminal and idempotent */ }
  }
}
