import { scriptedEnemyPrepare } from "../enemy";
import type { Intent, MatchState } from "../rules";
import type { EnemyPlan, EnemyPlanner } from "./contracts";

function skipIntent(state: MatchState): Intent {
  return { skillId: "skip", local: [], projected: [], cdSweep: state.boss.cdSweep, status: "void" };
}

export const scriptedEnemyPlanner: EnemyPlanner = {
  policy: "scripted:v1",
  plan(state: MatchState): EnemyPlan {
    const next = structuredClone(state);
    scriptedEnemyPrepare(next);
    return {
      policy: "scripted:v1",
      revision: state.revision,
      boss: {
        anchor: { ...next.boss.anchor },
        cadence: next.boss.cadence,
        cdSweep: next.boss.cdSweep,
        intent: structuredClone(next.boss.intent),
      },
      raiders: next.raiders.map((raider) => ({
        id: raider.id,
        pos: { ...raider.pos },
        intent: structuredClone(raider.intent),
      })),
      next: {
        phase: next.phase,
        revision: next.revision,
        outcome: next.outcome,
      },
    };
  },
};

export function applyEnemyPlan(state: MatchState, plan: EnemyPlan): boolean {
  if (state.phase !== "enemy_prepare" || state.revision !== plan.revision) return false;
  if (state.raiders.length !== plan.raiders.length) return false;
  for (let index = 0; index < state.raiders.length; index += 1) {
    if (state.raiders[index]?.id !== plan.raiders[index]?.id) return false;
  }
  state.boss.anchor = { ...plan.boss.anchor };
  state.boss.cadence = plan.boss.cadence;
  state.boss.cdSweep = plan.boss.cdSweep;
  state.boss.intent = structuredClone(plan.boss.intent);
  for (let index = 0; index < state.raiders.length; index += 1) {
    const raider = state.raiders[index]!;
    const planned = plan.raiders[index]!;
    raider.pos = { ...planned.pos };
    raider.intent = structuredClone(planned.intent);
  }
  state.phase = plan.next.phase;
  state.revision = plan.next.revision;
  state.outcome = plan.next.outcome;
  return true;
}

export function prepareEnemy(state: MatchState, planner: EnemyPlanner = scriptedEnemyPlanner): Intent {
  if (state.phase !== "enemy_prepare") return skipIntent(state);
  const plan = planner.plan(state);
  if (!applyEnemyPlan(state, plan)) throw new Error("Enemy plan rejected");
  return state.boss.intent ?? skipIntent(state);
}

export function bossPrepare(state: MatchState): Intent {
  return prepareEnemy(state);
}
