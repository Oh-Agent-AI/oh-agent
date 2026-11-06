import { createCityPlan } from "../cityPlan";
import { createPlanningWorkLedger, isPlanningInterrupted, type PlanningWorkLedger } from "../planner/operationBudget";
import { PLANNING_PROTOCOL_VERSION, serializePlanningPlan, validPlanningParameters,
  type PlanningRequest, type PlanningWorkerResponse } from "./planningProtocol";

/** Local CPU-only job: no model/session rows, host IPC or networking. */
export function executePlanningWorkerJob(input: unknown,
  onProgress?: (response: Extract<PlanningWorkerResponse, { status: "progress" }>) => void): Exclude<PlanningWorkerResponse, { status: "progress" }> {
  const request = input as Partial<PlanningRequest> | null;
  const requestId = typeof request?.requestId === "string" && request.requestId.length <= 128 ? request.requestId : "";
  const fail = (reason: string): Extract<PlanningWorkerResponse, { status: "failed" }> => ({ version: PLANNING_PROTOCOL_VERSION, requestId, status: "failed", reason });
  if (!requestId || request?.version !== PLANNING_PROTOCOL_VERSION || !validPlanningParameters(request.parameters)) return fail("invalid-planning-request");
  let ledger: PlanningWorkLedger | undefined;
  try {
    ledger = createPlanningWorkLedger(request.parameters.limits, () => false, onProgress ? workBudget =>
      onProgress({ version: PLANNING_PROTOCOL_VERSION, requestId, status: "progress", workBudget }) : undefined);
    const plan = createCityPlan(request.parameters.seed, request.parameters.tier, request.parameters.coastal,
      { workLedger: ledger, memoizeTerrain: request.parameters.memoizeTerrain });
    if (!plan.derivedFinalization.ok || !plan.capacity.satisfied || plan.planningOutcome.status === "failed")
      return { ...fail("planning-outcome-failed"), workBudget: ledger.snapshot() };
    return { version: PLANNING_PROTOCOL_VERSION, requestId, status: "computed", snapshot: serializePlanningPlan(plan, request.parameters) };
  } catch (error) {
    return { ...fail(isPlanningInterrupted(error) ? error.detail.status : "planning-job-failed"),
      ...(isPlanningInterrupted(error) ? { stop: error.detail } : {}), ...(ledger ? { workBudget: ledger.snapshot() } : {}) };
  }
}
