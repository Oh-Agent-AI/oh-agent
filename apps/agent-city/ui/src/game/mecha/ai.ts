/**
 * 机甲方脚本。Boss 仍走 rules.ts。
 * 搜索在提交前看完预告和敌方结算，所以会为输出走近，也会吃到挡路的预告格。
 * 有楼时，楼全毁和机甲全灭一样是输。
 */
import {
  BOARD, BOSS_HP, bossExecute, footprintCenter, legalActions, living, pathDistance, STATS_MOVE,
  validateAndApplyPlan,
  type Action, type ArenaPlan, type Cell, type MatchState, type MechId, type MechOrder,
} from "./rules";

function same(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

function mechAt(state: MatchState, id: MechId) {
  const found = state.mechs.find((m) => m.id === id);
  if (!found) throw new Error(id);
  return found;
}

function holdPlan(state: MatchState): ArenaPlan {
  return {
    revision: state.revision,
    items: living(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })),
  };
}

function reachable(state: MatchState, id: MechId): Cell[] {
  const me = mechAt(state, id);
  const cap = STATS_MOVE[id];
  const out: Cell[] = [];
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      const dist = pathDistance(state, me.pos, { x, y }, id);
      if (dist !== null && dist <= cap) out.push({ x, y });
    }
  }
  return out;
}

function orderOf(id: MechId, from: Cell, dest: Cell, action: Action): MechOrder {
  return { mechId: id, moveTo: same(from, dest) ? null : { x: dest.x, y: dest.y }, action: structuredClone(action) };
}

function localScore(state: MatchState, id: MechId, dest: Cell, action: Action): number {
  let score = 0;
  if (action.kind === "charge") score += 100;
  else if (action.kind === "melee") score += 80;
  else if (action.kind === "pierce") score += 60;
  else if (action.kind === "shoot") score += 50;
  else if (action.kind === "repair") score += 40;
  const center = footprintCenter(state.boss.anchor);
  score -= Math.abs(dest.x + 0.5 - center.x) + Math.abs(dest.y + 0.5 - center.y);
  if (id === "Assault") score -= Math.abs(dest.x + 0.5 - center.x);
  if (state.boss.intent?.projected.some((c) => same(c, dest))) score -= 8;
  return score;
}

type Opt = { dest: Cell; action: Action; score: number };

function optionsFor(state: MatchState, id: MechId): Opt[] {
  const origin = mechAt(state, id).pos;
  const center = footprintCenter(state.boss.anchor);
  const ranked = reachable(state, id)
    .filter((c) => !same(c, origin))
    .sort((a, b) => {
      const da = Math.abs(a.x + 0.5 - center.x) + Math.abs(a.y + 0.5 - center.y);
      const db = Math.abs(b.x + 0.5 - center.x) + Math.abs(b.y + 0.5 - center.y);
      return da - db || a.x - b.x || a.y - b.y;
    });
  const dests = [origin, ...ranked.slice(0, 3)];
  const opts: Opt[] = [];
  for (const dest of dests) {
    const scratch = structuredClone(state);
    mechAt(scratch, id).pos = dest;
    for (const action of legalActions(scratch, id)) opts.push({ dest, action, score: localScore(state, id, dest, action) });
  }
  opts.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.dest.x !== b.dest.x) return a.dest.x - b.dest.x;
    if (a.dest.y !== b.dest.y) return a.dest.y - b.dest.y;
    const ka = JSON.stringify(a.action);
    const kb = JSON.stringify(b.action);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
  const top = opts.slice(0, 5);
  const stay = opts.find((o) => same(o.dest, origin) && o.action.kind === "skip");
  if (stay && !top.some((o) => same(o.dest, stay.dest) && o.action.kind === "skip")) top.push(stay);
  return top;
}

function scorePlan(state: MatchState, plan: ArenaPlan): number | null {
  const clone = structuredClone(state);
  const result = validateAndApplyPlan(clone, plan);
  if (!("ok" in result)) return null;
  if (clone.boss.hp > 0 && clone.phase === "resolving_boss") bossExecute(clone);
  const center = footprintCenter(clone.boss.anchor);
  let score = (BOSS_HP - clone.boss.hp) * 20;
  for (const m of clone.mechs) {
    score += m.hp * 3;
    if (m.hp > 0) score -= Math.abs(m.pos.x + 0.5 - center.x) + Math.abs(m.pos.y + 0.5 - center.y);
  }
  for (const b of clone.buildings) score += b.hp * 4;
  if (clone.outcome === "victory") score += 5000;
  if (clone.outcome === "defeat_wipe" || clone.outcome === "defeat_buildings") score -= 3000;
  if (clone.outcome === "defeat_timeout") score -= 100;
  return score;
}

/** One legal pack for the living mechs. Falls back to three holds. */
export function squadPlan(state: MatchState): ArenaPlan {
  const ids = living(state).map((m) => m.id);
  const groups = ids.map((id) => optionsFor(state, id));
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestKey = "";
  let bestPlan: ArenaPlan | null = null;
  const consider = (items: MechOrder[]) => {
    const plan = { revision: state.revision, items };
    const score = scorePlan(state, plan);
    if (score === null) return;
    const key = JSON.stringify(items);
    if (!bestPlan || score > bestScore || (score === bestScore && key < bestKey)) {
      bestScore = score;
      bestKey = key;
      bestPlan = plan;
    }
  };
  const walk = (index: number, items: MechOrder[]) => {
    if (index === ids.length) {
      consider(items);
      return;
    }
    const id = ids[index];
    if (!id) return;
    const from = mechAt(state, id).pos;
    for (const opt of groups[index] ?? []) walk(index + 1, items.concat(orderOf(id, from, opt.dest, opt.action)));
  };
  walk(0, []);
  consider(holdPlan(state).items);
  return bestPlan ?? holdPlan(state);
}
