import type { PlanningJobResult } from "./planningWorker/planningJob";

/** The worker process never started. A timeout, cancellation, invalid request,
 * or any failure after a progress/stop/budget message is not this case. */
export function canReplayUnstartedPlanningWorker(result: PlanningJobResult): boolean {
  if (result.status === "computed" || result.status === "cancelled") return false;
  if (result.lastCheckpoint || result.workBudget || result.stop) return false;
  if (result.status === "unsupported") return result.reason === "planning-worker-unavailable";
  return result.status === "failed" && (
    result.reason === "planning-worker-failed"
    || result.reason === "planning-worker-post-failed"
    || result.reason === "planning-worker-message-failed"
  );
}
