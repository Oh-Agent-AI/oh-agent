import { auditKeyId, auditCaseId, freezeAuditCase, validateManifest } from "./AuditIdentity";
import { DrivingRouteRunner } from "./DrivingRouteRunner";
import type { AuditKey, AuditManifest, AuditRunState, RoadAuditCase, RoadAuditCaseResult } from "./contracts";
import type { AuditEvidenceSink } from "./AuditEvidenceStore";
export type AuditBatchReport = Readonly<{
  key: AuditKey; state: AuditRunState | "budget-exhausted"; results: readonly RoadAuditCaseResult[];
}>;
export type AuditScheduleOptions = {
  evidence?:AuditEvidenceSink;
  ticksPerBatch: number;
  maxTotalTicks: number;
  currentKey: () => AuditKey;
  isCancelled: () => boolean;
  /** Mandatory yielding supplied by browser/worker/CLI adapter. No rAF in core. */
  yieldControl: () => Promise<void>;
};
/** No callbacks publish partial greens. Only a complete, current report can reach
 * release policy; cancelled/stale reports have no usable successful results. */
export async function scheduleAudit(manifest: AuditManifest,
  factory: (test: RoadAuditCase) => DrivingRouteRunner,
  options: AuditScheduleOptions): Promise<AuditBatchReport> {
  validateManifest(manifest);
  if (!Number.isSafeInteger(options.ticksPerBatch) || options.ticksPerBatch < 1 || options.ticksPerBatch > 10000) throw new Error("invalid-audit-batch");
  if (!Number.isSafeInteger(options.maxTotalTicks) || options.maxTotalTicks < 1) throw new Error("invalid-total-audit-budget");
  let totalTicks = 0;
  const key = Object.freeze({ ...manifest.key }); const identity = auditKeyId(key);
  const plan = manifest.cases.map(freezeAuditCase);
  const results: RoadAuditCaseResult[] = [];
  const report = (state: AuditRunState | "budget-exhausted"): AuditBatchReport => {
    if(state!=="complete")try{options.evidence?.invalidate();}catch{/* diagnostics cannot affect audit outcome */}
    return Object.freeze({ key, state,results: Object.freeze(state === "complete" ? [...results] : []) });
  };
  const interrupted = (): "cancelled" | "stale" | null => options.isCancelled() ? "cancelled" : auditKeyId(options.currentKey()) !== identity ? "stale" : null;
  for (const test of plan) {
    const before = interrupted(); if (before) return report(before);
    const runner = factory(test);
    if (auditKeyId(runner.key) !== identity || auditCaseId(runner.test) !== auditCaseId(test)) throw new Error("runner-plan-mismatch");
    while (!runner.result) {
      const reason = interrupted();
      if (reason) { runner.cancel(); return report(reason); }
      const remaining = options.maxTotalTicks - totalTicks;
      if (remaining <= 0) { runner.cancel(); return report("budget-exhausted"); }
      const beforeTicks = runner.simulatedTicks;
      runner.advance(Math.min(options.ticksPerBatch, remaining), key);
      totalTicks += runner.simulatedTicks - beforeTicks;
      await options.yieldControl();
    }
    const after = interrupted(); if (after) return report(after);
    const result = runner.result;
    if (!result || runner.status !== "complete") return report("cancelled");
    results.push(result);
  }
  const final = interrupted(); return report(final ?? "complete");
}
