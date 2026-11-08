import { beginEnemyPhase } from "../combat";
import { resolveEnemyPhase } from "../execution/enemyPhase";
import { MECH_IDS, inb, manh, occupant, type Cell, type MatchState } from "../board";
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

const cardinal = (cell: Cell): Cell[] => [{ x: cell.x + 1, y: cell.y }, { x: cell.x - 1, y: cell.y }, { x: cell.x, y: cell.y + 1 }, { x: cell.x, y: cell.y - 1 }].filter(inb);

function raiderStrike(state: MatchState, pos: Cell): Intent | null {
  const targets = cardinal(pos).filter(cell => occupant(state, cell) !== "empty");
  if (targets.length === 0) return null;
  const target = targets.sort((a, b) => occupant(state, a) === "building" ? -1 : occupant(state, b) === "building" ? 1 : 0)[0]!;
  return { skillId: "smash", local: [{ x: target.x - pos.x, y: target.y - pos.y }], projected: [target], cdSweep: 0, status: "planned" };
}

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
  // Raider intents: keep the scripted position, vary the declared smash target to a
  // valuable adjacent cell. This is still deterministic and fully telegraphed.
  const raiderVariants = out.map(plan => {
    let plans = [plan];
    for (const raider of plan.raiders) {
      const options: EnemyPlan[] = [];
      for (const cell of adjacent(raider.pos)) {
        if (occupant(state, cell) === "empty") continue;
        const intent = { skillId: "smash" as const, local: [{ x: cell.x - raider.pos.x, y: cell.y - raider.pos.y }], projected: [cell], cdSweep: 0, status: "planned" as const };
        options.push({ ...plan, raiders: plan.raiders.map(item => item.id === raider.id ? { ...item, intent } : item) });
      }
      for (const to of cardinal(raider.pos)) {
        if (occupant(state, to) !== "empty") continue;
        options.push({ ...plan, raiders: plan.raiders.map(item => item.id === raider.id ? { ...item, pos: to, intent: raiderStrike(state, to) } : item) });
      }
      plans = plans.flatMap(item => [item, ...options.slice(0, 3)]);
    }
    return plans;
  }).flat();
  return [...out, ...raiderVariants].slice(0, 32);
}

function evaluate(initial: MatchState, plan: EnemyPlan, afterEnemy: MatchState): number {
  const hp = (state: MatchState) => state.mechs.reduce((sum, unit) => sum + unit.hp, 0);
  const buildings = (state: MatchState) => state.buildings.reduce((sum, building) => sum + building.hp, 0);
  const enemyHp = (state: MatchState) => state.boss.hp + state.raiders.reduce((sum, raider) => sum + raider.hp, 0);
  const mechDamage = Math.max(0, hp(initial) - hp(afterEnemy));
  const buildingDamage = Math.max(0, buildings(initial) - buildings(afterEnemy));
  const projected = [...(plan.boss.intent?.projected ?? []), ...plan.raiders.flatMap(raider => raider.intent?.projected ?? [])];
  const coverage = projected.filter(cell => occupant(initial, cell) !== "empty").length;
  const complexity = projected.length;
  return mechDamage * 12 + buildingDamage * 10 + enemyHp(afterEnemy) * 4 + coverage * 2 - complexity * 0.5;
}

function simulate(state: MatchState, plan: EnemyPlan): MatchState {
  const after = structuredClone(state);
  if (!applyEnemyPlan(after, plan)) throw new Error("baup_plan_rejected");
  beginEnemyPhase(after);
  resolveEnemyPhase(after, { capturePresentation: false });
  return after;
}

export const baupEnemyPlanner: EnemyPlanner = {
  policy: "baup:v1",
  plan(state: MatchState): EnemyPlan {
    const base = scriptedEnemyPlanner.plan(state);
    let best: { plan: EnemyPlan; score: number } | null = null;
    for (const candidate of candidates(base, state)) {
      try {
        const score = evaluate(state, candidate, simulate(state, candidate));
        if (!best || score > best.score) best = { plan: candidate, score };
      } catch { /* invalid candidates are not committed */ }
    }
    return best?.plan ?? base;
  },
};
