import type { MatchPlanner } from "./ai/contracts";
import type { EnemyPlanner } from "./enemy/contracts";
import { prepareEnemy, scriptedEnemyPlanner } from "./enemy/planner";
import { MAX_TURNS, playTurn, type ArenaPlan, type MatchState, type PlanFault } from "./rules";

export type AutoBattleTurn = {
  turn: number;
  before: MatchState;
  squadPlan: ArenaPlan;
  after: MatchState;
};

export type AutoBattleResult = {
  state: MatchState;
  turns: AutoBattleTurn[];
  reason: "outcome" | "turn_limit" | "plan_rejected";
  fault?: PlanFault;
};

export function runAutoBattle(initial: MatchState, options: {
  squad: MatchPlanner;
  enemy?: EnemyPlanner;
  maxTurns?: number;
}): AutoBattleResult {
  const state = structuredClone(initial);
  const enemy = options.enemy ?? scriptedEnemyPlanner;
  const maxTurns = Math.max(1, options.maxTurns ?? MAX_TURNS);
  const turns: AutoBattleTurn[] = [];
  if (state.phase === "enemy_prepare" && !state.outcome) prepareEnemy(state, enemy);
  while (!state.outcome && turns.length < maxTurns) {
    if (state.phase !== "player_plan") throw new Error(`Auto battle cannot plan during ${state.phase}`);
    const before = structuredClone(state);
    const squadPlan = options.squad.plan(state);
    const result = playTurn(state, squadPlan, enemy);
    if (!result.ok) return { state, turns, reason: "plan_rejected", fault: result.fault };
    Object.assign(state, result.state);
    turns.push({ turn: before.turn, before, squadPlan, after: structuredClone(state) });
  }
  return { state, turns, reason: state.outcome ? "outcome" : "turn_limit" };
}
