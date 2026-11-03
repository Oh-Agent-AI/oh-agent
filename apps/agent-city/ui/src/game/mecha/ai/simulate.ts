import { bossExecute, validateAndApplyPlan, type ArenaPlan, type MatchState } from "../rules";
import type { PlanSimulator } from "./contracts";

export const rulePlanSimulator: PlanSimulator = {
  apply(state: MatchState, plan: ArenaPlan): MatchState | null {
    const clone = structuredClone(state);
    const result = validateAndApplyPlan(clone, plan);
    if (!("ok" in result)) return null;
    if (clone.phase === "resolving_boss") bossExecute(clone);
    return clone;
  },
};
