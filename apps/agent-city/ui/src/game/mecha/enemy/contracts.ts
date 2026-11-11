import type { DecisionPlanner } from "../decision";
import type { Cell, Intent, MatchState, Outcome, Phase } from "../rules";

export type EnemyPlan = {
  policy: string;
  revision: number;
  boss: {
    anchor: Cell;
    cadence: number;
    cdSweep: number;
    intent: Intent | null;
  };
  raiders: Array<{
    id: string;
    pos: Cell;
    intent: Intent | null;
  }>;
  next: {
    phase: Phase;
    revision: number;
    outcome: Outcome | null;
  };
};

export type EnemyPolicy = "scripted" | "baup";

export interface EnemyPlanner extends DecisionPlanner<MatchState, EnemyPlan> {
  readonly policy: string;
}
