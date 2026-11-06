import { hydratePlanningPlan, planningRequestKey, validPlanningParameters, validPlanningWorkSnapshot, PLANNING_PROTOCOL_VERSION,
  type PlanningParameters, type PlanningWorkerResponse, type GeneratedCityPlan, type PlanningRequest } from "./planningProtocol";
import type { PlanningStop, PlanningWorkSnapshot } from "../planner/operationBudget";
export type PlanningJobResult =
  | { status: "computed"; plan: GeneratedCityPlan; requestKey: string }
  | { status: "cancelled" | "failed" | "unsupported"; reason: string; stop?: PlanningStop; workBudget?: PlanningWorkSnapshot;
      lastCheckpoint?: PlanningWorkSnapshot };
export type PlanningWorkerPort = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { preventDefault?: () => void }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage: (message: PlanningRequest) => void;
  terminate: () => void;
};
let sequence = 0;
/** A dedicated worker is terminated on abort, including during a synchronous
 * planning loop. No unsafe main-thread fallback or partial-plan publication. */
export function runPlanningJob(parameters: PlanningParameters, options: { signal: AbortSignal;
  workerFactory?: () => PlanningWorkerPort; onProgress?: (snapshot: PlanningWorkSnapshot) => void;
  heartbeatTimeoutMs?: number }): Promise<PlanningJobResult> {
  if (!validPlanningParameters(parameters)) return Promise.resolve({ status: "failed", reason: "invalid-planning-parameters" });
  const timeout = options.heartbeatTimeoutMs ?? 30000;
  if (!Number.isFinite(timeout) || timeout <= 0) return Promise.resolve({ status: "failed", reason: "invalid-planning-timeout" });
  if (options.signal.aborted) return Promise.resolve({ status: "cancelled", reason: "cancelled-before-start" });
  const captured = { ...parameters, limits: { ...parameters.limits }, coastal: parameters.coastal ? { ...parameters.coastal } : null };
  const requestKey = planningRequestKey(captured), requestId = `city-plan:${++sequence}`;
  return new Promise(resolve => {
    let worker: PlanningWorkerPort;
    try { worker = options.workerFactory?.() ?? new Worker(new URL("./planning.worker.ts", import.meta.url), { type: "module" }) as unknown as PlanningWorkerPort; }
    catch { resolve({ status: "unsupported", reason: "planning-worker-unavailable" }); return; }
    let settled = false;
    let lastPulse = performance.now(), lastCheckpoint: PlanningWorkSnapshot | undefined;
    const finish = (result: PlanningJobResult) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      options.signal.removeEventListener("abort", cancel);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      try { worker.terminate(); } catch { /* Logical result remains cancelled/failed; stale callbacks cannot publish. */ }
      resolve(result);
    };
    const cancel = () => finish({ status: "cancelled", reason: "cancelled-during-planning", ...(lastCheckpoint ? { lastCheckpoint } : {}) });
    const watchdog = setInterval(() => {
      if (performance.now() - lastPulse >= timeout) finish({ status: "failed", reason: "planning-worker-timeout",
        ...(lastCheckpoint ? { lastCheckpoint } : {}) });
    }, Math.min(1000, timeout));
    options.signal.addEventListener("abort", cancel, { once: true });
    worker.onerror = event => { event.preventDefault?.(); finish({ status: "failed", reason: "planning-worker-failed" }); };
    worker.onmessageerror = () => finish({ status: "failed", reason: "planning-worker-message-failed" });
    worker.onmessage = event => {
      if (settled) return;
      if (options.signal.aborted) { cancel(); return; }
      const response = event.data as PlanningWorkerResponse;
      if (!response || response.version !== PLANNING_PROTOCOL_VERSION || response.requestId !== requestId) {
        finish({ status: "failed", reason: "stale-planning-worker-response" }); return;
      }
      if (response.status === "progress") {
        if (!validPlanningWorkSnapshot(response.workBudget, captured.limits)) { finish({ status: "failed", reason: "invalid-planning-progress" }); return; }
        lastPulse = performance.now();
        lastCheckpoint = Object.freeze({ limits: Object.freeze({ ...response.workBudget.limits }), consumed: Object.freeze({ ...response.workBudget.consumed }) });
        try { options.onProgress?.(lastCheckpoint); } catch { finish({ status: "failed", reason: "planning-progress-handler-failed" }); }
        return;
      }
      if (response.status === "failed") {
        finish({ status: "failed", reason: typeof response.reason === "string" ? response.reason : "planning-worker-failed",
          ...(response.stop ? { stop: response.stop } : {}), ...(response.workBudget ? { workBudget: response.workBudget } : {}) }); return;
      }
      if (response.status !== "computed") { finish({ status: "failed", reason: "invalid-planning-worker-response" }); return; }
      try { finish({ status: "computed", plan: hydratePlanningPlan(response.snapshot, captured), requestKey }); }
      catch { finish({ status: "failed", reason: "invalid-planning-worker-snapshot" }); }
    };
    if (options.signal.aborted) { cancel(); return; }
    try { worker.postMessage({ version: PLANNING_PROTOCOL_VERSION, requestId, parameters: captured }); }
    catch { finish({ status: "failed", reason: "planning-worker-post-failed" }); }
  });
}
