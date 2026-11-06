import { assertMonsterState, eq, validSwarmBinding, reconcileNeural, swapEventSink } from "../board";
import { scriptedEnemyPrepare } from "../enemy";
import type { Intent, MatchState } from "../rules";
import type { EnemyPlan, EnemyPlanner } from "./contracts";

function skipIntent(state: MatchState): Intent {
  return { skillId: "skip", local: [], projected: [], cdSweep: state.boss.cdSweep, status: "void" };
}

export const scriptedEnemyPlanner: EnemyPlanner = {
  policy: "scripted:v1",
  plan(state: MatchState): EnemyPlan {
    assertMonsterState(state);
    const next = structuredClone(state);
    // Planning is speculative: its reconciliation must never publish turn events.
    const outer = state.neural ? swapEventSink(null) : null;
    try { scriptedEnemyPrepare(next); } finally { if (state.neural) swapEventSink(outer); }
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

// Untrusted custom L8 planners may not smuggle getters, prototypes, cycles or
// unbounded structures into validation/stringification. The canonical plan is
// still compared in full before any authoritative movement is applied.
function plainNeuralPlan(value: unknown): boolean {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (v: unknown, depth: number): boolean => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v !== "object" || depth > 16 || ++nodes > 2048 || seen.has(v)) return false;
    seen.add(v);
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
    const keys = Reflect.ownKeys(v);
    if (keys.length > 1025 || keys.some(k => typeof k !== "string")) return false;
    if (array && (v.length > 1024 || keys.length !== v.length + 1)) return false;
    for (const key of keys) {
      if (array && key === "length") continue;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d?.enumerable || !("value" in d) || !visit(d.value, depth + 1)) return false;
    }
    return true;
  };
  try { return visit(value, 0); } catch { return false; }
}

export function applyEnemyPlan(state: MatchState, plan: EnemyPlan): boolean {
  assertMonsterState(state);
  if (state.monsterContent?.speciesId === "neural_weaver" && !plainNeuralPlan(plan)) return false;
  if (state.monsterContent?.speciesId !== "neural_weaver") assertMonsterState(state, plan.boss.intent);
  if (state.phase !== "enemy_prepare" || state.revision !== plan.revision) return false;
  // Until a swarm-aware planner contract can validate movement and lifecycle
  // evidence, accept only the deterministic scripted plan. Otherwise a custom
  // planner could announce fabricated birth slots or teleport existing units;
  // preview uses the scripted planner and would not match execution.
  if (state.monsterContent?.speciesId === "swarm_mantle" || state.monsterContent?.speciesId === "neural_weaver") {
    const expected = scriptedEnemyPlanner.plan(state);
    if (JSON.stringify(plan) !== JSON.stringify(expected)) return false;
  }
  // A planner cannot move the swarm caster or bind a different origin while
  // presenting an apparently legitimate prepared split action.
  if (state.monsterContent?.speciesId === "swarm_mantle" && state.boss.hp > 0 &&
      (!eq(state.boss.anchor, plan.boss.anchor) || !plan.boss.intent || plan.boss.intent.skillId !== "split_swarm" ||
       !validSwarmBinding(state, plan.boss.intent) || !eq(plan.boss.intent.swarmOrigin!, plan.boss.anchor))) return false;
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
    reconcileNeural(state);
    raider.intent = structuredClone(planned.intent);
  }
  if (state.neural && state.boss.intent?.skillId === "neural_link" && state.boss.intent.swarm) {
    state.neural.pending = structuredClone(state.boss.intent.swarm);
  }
  state.phase = plan.next.phase;
  state.revision = plan.next.revision;
  state.outcome = plan.next.outcome;
  if (state.neural) { reconcileNeural(state); assertMonsterState(state); }
  return true;
}

export function prepareEnemy(state: MatchState, planner: EnemyPlanner = scriptedEnemyPlanner): Intent {
  assertMonsterState(state);
  if (state.phase !== "enemy_prepare") return skipIntent(state);
  const isNeural = state.monsterContent?.speciesId === "neural_weaver";
  const outer = isNeural ? swapEventSink(null) : null;
  let plan: EnemyPlan;
  try { plan = planner.plan(isNeural ? structuredClone(state) : state); }
  finally { if (isNeural) swapEventSink(outer); }
  if (!applyEnemyPlan(state, plan)) throw new Error("Enemy plan rejected");
  return state.boss.intent ?? skipIntent(state);
}

export function bossPrepare(state: MatchState): Intent {
  return prepareEnemy(state);
}
