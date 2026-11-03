import {
  BOARD, footprintCenter, legalActions, living, moveBudget, pathDistance,
  type Action, type Cell, type MatchState, type MechId,
} from "../rules";
import type { CandidateAction, CandidateSource, PlannerDoctrine } from "./contracts";
import { approachCost, boardChargesTerrain, manh, mechAt, rankToward, same, threatened, threatFocus } from "./shared";

function reachable(state: MatchState, id: MechId): Cell[] {
  const mech = mechAt(state, id);
  const cap = moveBudget(id);
  const out: Cell[] = [];
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      const dist = pathDistance(state, mech.pos, { x, y }, id);
      if (dist !== null && dist <= cap) out.push({ x, y });
    }
  }
  return out;
}

function localScore(state: MatchState, id: MechId, dest: Cell, action: Action): number {
  let score = 0;
  if (action.kind === "charge") score += 100;
  else if (action.kind === "melee") score += 80;
  else if (action.kind === "pierce") score += 60;
  else if (action.kind === "shoot") score += 50;
  else if (action.kind === "repair") score += 40;
  const center = footprintCenter(state.boss.anchor);
  if (boardChargesTerrain(state)) score -= approachCost(state, dest, center, id);
  else {
    score -= Math.abs(dest.x + 0.5 - center.x) + Math.abs(dest.y + 0.5 - center.y);
    if (id === "Assault") score -= Math.abs(dest.x + 0.5 - center.x);
  }
  if (threatened(state, dest)) score -= 8;
  return score;
}

type Opt = { dest: Cell; action: Action; score: number };

function optionsFor(state: MatchState, id: MechId): Opt[] {
  const origin = mechAt(state, id).pos;
  const center = footprintCenter(state.boss.anchor);
  const ranked = reachable(state, id)
    .filter((cell) => !same(cell, origin))
    .sort(rankToward(state, id, center, "center"));
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
  return withStayOption(state, id, opts);
}

function peelLocalScore(state: MatchState, id: MechId, dest: Cell, action: Action): number {
  const focus = threatFocus(state);
  const aimed = action.kind !== "skip" && action.kind !== "repair" && (!("target" in action) || action.target === undefined || action.target === focus.id);
  let score = 0;
  if (aimed && action.kind === "charge") score += 100;
  else if (aimed && action.kind === "melee") score += 80;
  else if (aimed && action.kind === "pierce") score += 60;
  else if (aimed && action.kind === "shoot") score += 50;
  else if (action.kind === "repair") score += 20;
  else if (action.kind !== "skip") score += 8;
  score -= boardChargesTerrain(state) ? approachCost(state, dest, focus.cell, id) : manh(dest, focus.cell);
  if (threatened(state, dest)) score -= 8;
  return score;
}

function peelOptions(state: MatchState, id: MechId): Opt[] {
  const origin = mechAt(state, id).pos;
  const focus = threatFocus(state).cell;
  const ranked = reachable(state, id)
    .filter((cell) => !same(cell, origin))
    .sort(rankToward(state, id, focus, "cell"));
  const dests = [origin, ...ranked.slice(0, 3)];
  const opts: Opt[] = [];
  for (const dest of dests) {
    const scratch = structuredClone(state);
    mechAt(scratch, id).pos = dest;
    for (const action of legalActions(scratch, id)) opts.push({ dest, action, score: peelLocalScore(state, id, dest, action) });
  }
  opts.sort((a, b) => b.score - a.score || a.dest.x - b.dest.x || a.dest.y - b.dest.y || JSON.stringify(a.action).localeCompare(JSON.stringify(b.action)));
  return withStayOption(state, id, opts);
}

function withStayOption(state: MatchState, id: MechId, opts: Opt[]): Opt[] {
  const origin = mechAt(state, id).pos;
  const top = opts.slice(0, 5);
  const stay = opts.find((opt) => same(opt.dest, origin) && opt.action.kind === "skip");
  if (stay && !top.some((opt) => same(opt.dest, origin) && opt.action.kind === "skip")) top.push(stay);
  return top;
}

export function createCandidateSource(doctrine: PlannerDoctrine): CandidateSource {
  return {
    id: `${doctrine}-candidates:v1`,
    candidates(state: MatchState): CandidateAction[] {
      const options = doctrine === "peel" ? peelOptions : optionsFor;
      return living(state).flatMap((mech) => options(state, mech.id).map((opt) => ({
        mechId: mech.id,
        moveTo: same(opt.dest, mech.pos) ? null : { x: opt.dest.x, y: opt.dest.y },
        action: structuredClone(opt.action),
      })));
    },
  };
}
