import { DrivingKernel } from "../DrivingKernel";
import type { DrivingState } from "../../DrivingSimulation";
import { auditKeyId, freezeAuditCase, validateManifest } from "./AuditIdentity";
import type { AuditCause, AuditKey, AuditObserver, AuditRunState, RoadAuditCase, RoadAuditCaseResult, RoutePilot } from "./contracts";
import type { AuditEvidenceCapture, AuditEvidenceSink } from "./AuditEvidenceStore";

/** Resumable, renderer-free execution. advance(N) is deterministic work, not wall
 * time. Caller schedules small batches and checks cancellation/revision each time.
 * No recovery/reset API: any reset is a separate case with a separate start. */
export class DrivingRouteRunner {
  private current: Readonly<DrivingState>;
  private ticks = 0;
  private noProgressTicks = 0;
  private bestProgress = -Infinity;
  private runState: AuditRunState = "queued";
  private terminal: RoadAuditCaseResult | null = null;
  private diagnostic: RoadAuditCaseResult["diagnostic"];
  private readonly identity: string;
  private capture:AuditEvidenceCapture|null=null;
  readonly key: AuditKey;
  readonly test: RoadAuditCase;
  constructor(key: AuditKey, test: RoadAuditCase, private readonly kernel: DrivingKernel,
    private readonly pilot: RoutePilot, private readonly observer: AuditObserver, private readonly evidence?:AuditEvidenceSink) {
    for (const field of ["baseSnapshotHash", "vehicleConfigHash", "kernelBuildId", "physicsVersion", "collisionVersion", "queryVersion"] as const) {
      if (kernel.identity[field] !== key[field]) throw new Error("kernel-audit-identity-mismatch");
    }
    validateManifest({ key, units: test.units.map((id) => ({ id, kind: "directed-edge" as const })), exclusions: [], cases: [test] });
    this.identity = auditKeyId(key); this.key = Object.freeze({ ...key });
    // Freeze the supplied plan, not just its top-level reference.
    this.test = freezeAuditCase(test);
    if (!Number.isSafeInteger(test.maxTicks) || test.maxTicks < 1 || !Number.isSafeInteger(test.maxNoProgressTicks) || test.maxNoProgressTicks < 1 || test.maxNoProgressTicks > test.maxTicks || !test.units.length || !test.gates.length) throw new Error("invalid-runner-case");
    this.current = this.test.start;
    try{this.capture=evidence?.begin(this.key,this.test)??null;}catch{/* diagnostics cannot change a verdict */}
  }
  get state(): Readonly<DrivingState> { return this.current; }
  get simulatedTicks(): number { return this.ticks; }
  get status(): AuditRunState { return this.runState; }
  get result(): RoadAuditCaseResult | null { return this.terminal; }
  cancel(): void {
    if (this.terminal) return;
    try{this.evidence?.invalidate();}catch{/* diagnostics only */}
    this.finish("cancelled"); this.runState = "cancelled";
  }
  advance(maxTicks: number, currentKey: AuditKey): RoadAuditCaseResult | null {
    if (!Number.isSafeInteger(maxTicks) || maxTicks < 1 || maxTicks > 10000) throw new Error("invalid-audit-batch");
    // Even a completed result becomes stale if the snapshot/config changes.
    if (auditKeyId(currentKey) !== this.identity) {
      try{this.evidence?.invalidate();}catch{/* diagnostics only */}
      this.finish("unconfirmed", true); this.runState = "stale"; return this.terminal;
    }
    if (this.terminal) return this.terminal;
    if (this.runState === "queued") {
      let validation;
      try { validation = this.observer.begin(this.current); }
      catch { this.finish("unconfirmed"); return this.terminal; }
      if (validation !== "valid") {
        this.finish(validation === "simulation-invalid" || validation === "budget-exhausted" ? validation : "route-deviation");
        return this.terminal;
      }
    }
    this.runState = "running";
    for (let i = 0; i < maxTicks && !this.terminal; i++) {
      let input;
      try { input = this.pilot.input(this.current, this.ticks); }
      catch { this.finish("pilot-failed"); break; }
      if (!input || ![input.forward, input.backward, input.left, input.right].every((value) => typeof value === "boolean")) {
        this.finish("pilot-failed"); break;
      }
      let next;
      try { next = this.kernel.step(this.current, input); }
      catch (error) {
        const known = ["invalid-driving-state", "unexpected-position-jump", "unexpected-surface-distance-jump"];
        const message = error && typeof error === "object" && "message" in error ? error.message : null;
        this.recordDiagnostic("kernel", typeof message === "string" && known.includes(message) ? message : "kernel-exception");
        this.finish("simulation-invalid"); break;
      }
      this.ticks++;
      try{this.capture?.record(this.ticks,input,this.current,next.state);}catch{
        try{this.capture?.discard();}catch{/* diagnostics only */}this.capture=null;
      }
      let observation;
      try { observation = this.observer.observe(this.current, next, this.ticks); }
      catch { this.finish("unconfirmed"); break; }
      this.current = next.state;
      if (!Number.isFinite(observation.progress)) { this.finish("simulation-invalid"); break; }
      if (observation.status === "route-deviation" || observation.status === "simulation-invalid" || observation.status === "budget-exhausted") {
        if (observation.status === "simulation-invalid" || observation.status === "budget-exhausted") this.recordDiagnostic("observer",
          next.motion.queryStatus === "unresolved" ? (next.motion.reason === "continuous-collision:budget" ? "collision-query-budget" : "collision-query-unresolved") : "independent-validation-failed");
        this.finish(observation.status); break;
      }
      if (observation.status === "complete") { this.finish("none"); break; }
      if (observation.status !== "continue") { this.finish("unconfirmed"); break; }
      if (observation.progress > this.bestProgress + 1e-4) {
        this.bestProgress = observation.progress; this.noProgressTicks = 0;
      } else if (!observation.plannedStop) this.noProgressTicks++;
      if (this.ticks >= this.test.maxTicks) this.finish("budget-exhausted");
      else if (this.noProgressTicks >= this.test.maxNoProgressTicks) this.finish("pilot-failed");
    }
    return this.terminal;
  }
  private recordDiagnostic(stage: "kernel" | "observer", reason: string): void {
    this.diagnostic = Object.freeze({ stage, reason, tick: this.ticks, x: this.current.x, y: this.current.y, z: this.current.z });
  }
  private finish(cause: AuditCause, replace = false): void {
    if (this.terminal && !replace) return;
    this.terminal = Object.freeze({ key: this.key, caseId: this.test.id,
      verdict: cause === "none" ? "passed" : "inconclusive", cause,
      coveredUnits: Object.freeze(cause === "none" ? [...this.test.units] : []), simulatedTicks: this.ticks,
      ...(this.diagnostic && (cause === "simulation-invalid" || cause === "budget-exhausted") ? { diagnostic: this.diagnostic } : {}) });
    try{this.capture?.finish(this.terminal);}catch{try{this.capture?.discard();}catch{/* diagnostics only */}}
    this.capture=null;
    this.runState = "complete";
  }
}
