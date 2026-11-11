import type { MatchState } from "../board";
import type { EnemyPlanner } from "../enemy/contracts";
import { SequentialTurn, type SequentialRecord } from "../sequentialTurn";
import { policyFor, type AiDifficulty } from "./difficulty";
import type { SequentialPolicy } from "./policy";

/** A squad policy only observes the authoritative command engine. */
export type SequentialAutoBattleResult = {
  state: MatchState;
  outcome: MatchState["outcome"];
  steps: number;
  records: SequentialRecord[];
  reason: "outcome" | "step_limit" | "turn_limit" | "command_rejected";
  fault?: string;
};

/**
 * v1.5 EvE harness: a squad policy fights the real enemy planner through
 * SequentialTurn. Every step is a real command, so records replay exactly.
 */
export function runSequentialAutoBattle(initial: MatchState, options: {
  squad?: SequentialPolicy;
  difficulty?: AiDifficulty;
  enemy?: EnemyPlanner;
  maxSteps?: number;
  maxTurns?: number;
} = {}): SequentialAutoBattleResult {
  const turn = new SequentialTurn(structuredClone(initial), options.enemy ? { enemyPlanner: options.enemy } : {});
  const squad = options.squad ?? policyFor(options.difficulty ?? "beam");
  const maxSteps = Math.min(2000, Math.max(1, options.maxSteps ?? 400));
  const maxTurns = Math.max(1, options.maxTurns ?? 15);
  let steps = 0;
  while (!turn.snapshot().match.outcome && steps < maxSteps) {
    const current = turn.snapshot().match;
    if (current.turn > maxTurns) return { state: current, outcome: current.outcome, steps, records: turn.records(), reason: "turn_limit" };
    const intent = squad(turn);
    const command = intent.kind === "end" ? { kind: "end" as const, confirmUnused: true, id: `eve-${steps}`, revision: current.revision } : { ...intent, id: `eve-${steps}`, revision: current.revision };
    const result = turn.execute(command);
    if (!result.ok) return { state: current, outcome: current.outcome, steps, records: turn.records(), reason: "command_rejected", fault: result.reason };
    steps++;
  }
  const state = turn.snapshot().match;
  return { state, outcome: state.outcome, steps, records: turn.records(), reason: state.outcome ? "outcome" : "step_limit" };
}

/** Compare named policies from the exact same opening. */
export function compareSequentialPolicies(initial: MatchState, policies: Record<string, SequentialPolicy>, options: {
  enemy?: EnemyPlanner;
  maxSteps?: number;
  maxTurns?: number;
  difficulty?: AiDifficulty;
} = {}): Array<{ name: string; result: SequentialAutoBattleResult }> {
  return Object.entries(policies).map(([name, squad]) => ({ name, result: runSequentialAutoBattle(initial, { ...options, squad }) }));
}
