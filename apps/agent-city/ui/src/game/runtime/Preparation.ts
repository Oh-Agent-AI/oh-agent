/** Cooperative preparation on the host thread. Yields preserve the host heartbeat
 * and cancellation; they do not relax geometry checks or per-query budgets. */
export type PreparationStage = "world-capture" | "world-read" | "surface-index" | "surface-regions"
  | "static-solids" | "collision-world" | "diagnostic-spawn";
export type PreparationMetric = Readonly<{ stage: PreparationStage; durationMs: number }>;
export type PreparationProgress = Readonly<{ stage: PreparationStage; state: "started" | "completed"; completedCandidates?: number; candidateLimit?: number }>;
export const preparationNow = () => typeof performance !== "undefined" ? performance.now() : Date.now();
export async function preparationCheckpoint(signal?: AbortSignal, isCurrent: () => boolean = () => true): Promise<void> {
  if (signal?.aborted) throw new Error("cancelled");
  if (!isCurrent()) throw new Error("stale-game-world");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (signal?.aborted) throw new Error("cancelled");
  if (!isCurrent()) throw new Error("stale-game-world");
}
export function measurePreparation<T>(stage: PreparationStage, work: () => T, report?: (metric: PreparationMetric) => void): T {
  const started = preparationNow();
  try { return work(); }
  finally {
    // A diagnostic consumer must never change admission or cleanup semantics.
    try { report?.(Object.freeze({ stage, durationMs: Math.max(0, preparationNow() - started) })); } catch { /* local diagnostics only */ }
  }
}
