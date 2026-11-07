import { beginEnemyPhase } from "../combat";
import { resolveEnemyPhase } from "../execution/enemyPhase";
import { SequentialTurn, type SequentialCommand } from "../sequentialTurn";
import { nextCommand } from "../ai/commandPolicy";
import { stateValue } from "../ai/commandPolicy";
import { MECH_IDS, inb, manh, type Cell, type MatchState } from "../board";
import type { Intent } from "../rules";
import { applyEnemyPlan, scriptedEnemyPlanner } from "./planner";
import type { EnemyPlan, EnemyPlanner } from "./contracts";

const adjacent = (anchor: Cell): Cell[] => {
  const out: Cell[] = [];
  for (let y = anchor.y - 1; y <= anchor.y + 1; y++) for (let x = anchor.x - 1; x <= anchor.x + 1; x++) {
    const cell = { x, y };
    if (inb(cell) && !(x === anchor.x && y === anchor.y)) out.push(cell);
  }
  return out;
};

function intentFor(plan: EnemyPlan, skill: Intent["skillId"], cells: Cell[]): Intent {
  const anchor = plan.boss.anchor;
  return {
    ...plan.boss.intent ?? { cdSweep: plan.boss.cdSweep, local: [], projected: [], status: "planned" as const },
    skillId: skill,
    local: cells.map(cell => ({ x: cell.x - anchor.x, y: cell.y - anchor.y })),
    projected: cells.filter(inb),
    status: cells.every(inb) ? "planned" : "void",
    cdSweep: plan.boss.cdSweep,
  };
}

function candidates(base: EnemyPlan, state: MatchState): EnemyPlan[] {
  const out = [base];
  const anchor = base.boss.anchor;
  if (state.monsterContent) return out; // monster skills keep the scripted contract.
  const planned = base.boss.intent?.skillId;
  if (!planned || planned === "smash") {
    for (const cell of adjacent(anchor)) out.push({ ...base, boss: { ...base.boss, intent: intentFor(base, "smash", [cell]) } });
  }
  if (!planned || planned === "sweep") {
    const cells = adjacent(anchor);
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
      if (manh(cells[i]!, cells[j]!) > 2) continue;
      out.push({ ...base, boss: { ...base.boss, intent: intentFor(base, "sweep", [cells[i]!, cells[j]!]) } });
    }
  }
  return out;
}

function playerResponse(state: MatchState): MatchState {
  const turn = new SequentialTurn(state);
  let steps = 0;
  while (!turn.snapshot().match.outcome && steps < 12) {
    const intent = nextCommand(turn);
    if (intent.kind === "end") break;
    const revision = turn.snapshot().match.revision;
    const command: SequentialCommand = { ...intent, id: `baup-player-${steps}`, revision };
    const result = turn.execute(command);
    if (!result.ok) break;
    steps++;
  }
  return turn.snapshot().match;
}

function evaluate(state: MatchState): number {
  // stateValue is player-perspective; invert it and add enemy survival.
  const enemyHp = state.boss.hp + state.raiders.reduce((sum, raider) => sum + raider.hp, 0);
  return -stateValue(state) + enemyHp * 2;
}

function simulate(state: MatchState, plan: EnemyPlan): MatchState {
  const after = structuredClone(state);
  if (!applyEnemyPlan(after, plan)) throw new Error("baup_plan_rejected");
  beginEnemyPhase(after);
  resolveEnemyPhase(after, { capturePresentation: false });
  return playerResponse(after);
}

export const baupEnemyPlanner: EnemyPlanner = {
  policy: "baup:v1",
  plan(state: MatchState): EnemyPlan {
    const base = scriptedEnemyPlanner.plan(state);
    let best: { plan: EnemyPlan; score: number } | null = null;
    for (const candidate of candidates(base, state)) {
      try {
        const score = evaluate(simulate(state, candidate));
        if (!best || score > best.score) best = { plan: candidate, score };
      } catch { /* invalid candidates are not committed */ }
    }
    return best?.plan ?? base;
  },
};
