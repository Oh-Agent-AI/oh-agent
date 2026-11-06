/** Bounded, local aggregate timings. Never records inputs, poses or world IDs. */
import type { ClockPauseCause } from "./FixedStepClock";
import type { PreparationStage } from "./Preparation";
export type RuntimeFrameMetric = Readonly<{
  atMs: number; frameMs: number; tickCpuMs: number; presentCpuMs: number; steps: number;
  limitCause: ClockPauseCause | null;
  /** 追尾相机本帧安全级（无相机呈现的帧缺省）：held 是瞬态降级，shrunk 是正常收缩。 */
  cameraSafety?: "clear" | "shrunk" | "held" | "unresolved";
}>;
export type RuntimeDiagnosticSnapshot = Readonly<{
  samples: number;
  frameMs: Readonly<{ p50: number; p95: number; p99: number }>;
  tickCpuMs: Readonly<{ p50: number; p95: number; p99: number }>;
  presentCpuMs: Readonly<{ p50: number; p95: number; p99: number }>;
  maxSteps: number;
  limits: Readonly<Record<ClockPauseCause, number>>;
  /** 相机降级计数（窗口内）：贴身保持次数与收缩次数——排查相机净空问题的第一手信号。 */
  camera: Readonly<{ holds: number; shrinks: number }>;
  /** Phase elapsed time, including cooperative waits; never presented as CPU time. */
  preparationMs?: Readonly<Partial<Record<PreparationStage, number>>>;
}>;
export class RuntimeDiagnostics {
  private readonly frames: (RuntimeFrameMetric | undefined)[];
  private cursor = 0;
  constructor(readonly capacity = 2048, readonly windowMs = 120_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 16384 || !Number.isFinite(windowMs) || windowMs <= 0) throw new Error("invalid-diagnostic-budget");
    this.frames = new Array(capacity);
  }
  record(metric: RuntimeFrameMetric): void {
    if (![metric.atMs, metric.frameMs, metric.tickCpuMs, metric.presentCpuMs, metric.steps].every(Number.isFinite) ||
      metric.frameMs < 0 || metric.tickCpuMs < 0 || metric.presentCpuMs < 0 || !Number.isSafeInteger(metric.steps) || metric.steps < 0) return;
    if (metric.cameraSafety !== undefined && !["clear", "shrunk", "held", "unresolved"].includes(metric.cameraSafety)) return;
    this.frames[this.cursor] = Object.freeze({ ...metric });
    this.cursor = (this.cursor + 1) % this.capacity;
  }
  snapshot(nowMs: number): RuntimeDiagnosticSnapshot {
    const frames = this.frames.filter((frame): frame is RuntimeFrameMetric => !!frame && frame.atMs <= nowMs && nowMs - frame.atMs <= this.windowMs);
    const quantiles = (key: "frameMs" | "tickCpuMs" | "presentCpuMs") => {
      const values = frames.map((frame) => frame[key]).sort((a, b) => a - b);
      const q = (ratio: number) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)] : 0;
      return Object.freeze({ p50: q(0.5), p95: q(0.95), p99: q(0.99) });
    };
    const limits = { "invalid-delta": 0, "frame-gap": 0, "catch-up-budget": 0 };
    for (const frame of frames) if (frame.limitCause) limits[frame.limitCause]++;
    const camera = { holds: 0, shrinks: 0 };
    for (const frame of frames) { if (frame.cameraSafety === "held") camera.holds += 1; else if (frame.cameraSafety === "shrunk") camera.shrinks += 1; }
    return Object.freeze({ samples: frames.length, frameMs: quantiles("frameMs"), tickCpuMs: quantiles("tickCpuMs"), presentCpuMs: quantiles("presentCpuMs"),
      maxSteps: frames.reduce((max, frame) => Math.max(max, frame.steps), 0), limits: Object.freeze(limits), camera: Object.freeze(camera) });
  }
  clear(): void { this.frames.fill(undefined); this.cursor = 0; }
}
