import { footprintCenter, type ArenaPlan, type Cell, type MatchState } from "./rules";
import type { PlanEvaluation, PlannerDoctrine } from "./ai/contracts";
import { createMatchPlanner } from "./ai/planner";
import { createPlanScorer } from "./ai/score";
import { STATS, swapEventSink } from "./board";
import { nearestStakeCell, threatFocus } from "./ai/shared";

export type { CandidateAction, CandidateSource, MatchPlanner, PlanEvaluation, PlanScorer, PlanSimulator, PlannerDoctrine, ScoreFactor, ScoreFactorId } from "./ai/contracts";

const tunnelPlanner = createMatchPlanner("tunnel");
const peelPlanner = createMatchPlanner("peel");

export type DoctrineId = PlannerDoctrine;

export function evaluatePlansForDoctrine(state: MatchState, doctrine: DoctrineId): PlanEvaluation[] {
  return (doctrine === "peel" ? peelPlanner : tunnelPlanner).evaluate(state);
}


/** Restore the original health-based score baseline while preserving the planner ranking. */
export type PlanScoreFactors = { boss: number; raiders: number; mechs: number; position: number; buildings: number; outcome: number };
export type DraftPlanEvaluation =
  | { ok: true; score: number; factors: PlanScoreFactors }
  | { ok: false; reason: "rejected" | "nonfinite" | "unavailable" };
export function evaluatePlan(state: MatchState, plan: ArenaPlan, doctrine: DoctrineId): DraftPlanEvaluation {
  const outer = swapEventSink(null);
  try {
    const evaluation = createPlanScorer(doctrine).score(state, plan);
    if (!evaluation) return { ok: false, reason: "rejected" };
    const factors: PlanScoreFactors = { boss: 0, raiders: 0, mechs: 0, position: 0, buildings: 0, outcome: 0 };
    for (const factor of evaluation.factors) {
      if (factor.id === "boss_damage") factors.boss += factor.score;
      else if (factor.id === "raider_damage") factors.raiders += factor.score;
      else if (factor.id === "mech_damage") factors.mechs += factor.score;
      else if (factor.id === "building_damage") factors.buildings += factor.score;
      else if (factor.id === "position") factors.position += factor.score;
      else if (factor.id === "victory" || factor.id === "defeat") factors.outcome += factor.score;
    }
    // Search uses negative damage while the HUD historically shows remaining health.
    // The initial max-health terms are constant for every plan in this match.
    factors.mechs += state.mechs.reduce((sum, mech) => sum + STATS[mech.id].maxHp * 3, 0);
    factors.buildings += state.buildings.reduce((sum, building) => sum + building.maxHp * (doctrine === "peel" ? 16 : 4), 0);
    const score = Object.values(factors).reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(score) || Object.values(factors).some(value => !Number.isFinite(value))) return { ok: false, reason: "nonfinite" };
    return { ok: true, score, factors };
  } catch { return { ok: false, reason: "unavailable" }; }
  finally { swapEventSink(outer); }
}

export function squadPlan(state: MatchState) {
  return tunnelPlanner.plan(state);
}

export function bossTunnelPlan(state: MatchState) {
  return squadPlan(state);
}

export function peelPlan(state: MatchState) {
  return peelPlanner.plan(state);
}

export function planForDoctrine(state: MatchState, doctrine: DoctrineId) {
  return doctrine === "peel" ? peelPlan(state) : squadPlan(state);
}

export type DoctrineFocus = { kind: "boss" | "raider"; id: string; cell: Cell; building: Cell | null };

export function doctrineFocus(state: MatchState, doctrine: DoctrineId): DoctrineFocus {
  if (doctrine !== "peel") return { kind: "boss", id: "boss", cell: footprintCenter(state.boss.anchor), building: null };
  const threat = threatFocus(state);
  if (threat.id === "boss") return { kind: "boss", id: "boss", cell: threat.cell, building: null };
  return { kind: "raider", id: threat.id, cell: threat.cell, building: nearestStakeCell(state, threat.cell) };
}

export function doctrineFocusCells(state: MatchState, doctrine: DoctrineId): Cell[] {
  const focus = doctrineFocus(state, doctrine);
  if (focus.kind === "boss") {
    const anchor = state.boss.anchor;
    return [anchor, { x: anchor.x + 1, y: anchor.y }, { x: anchor.x, y: anchor.y + 1 }, { x: anchor.x + 1, y: anchor.y + 1 }];
  }
  const cells = [focus.cell];
  if (focus.building && (focus.building.x !== focus.cell.x || focus.building.y !== focus.cell.y)) cells.push(focus.building);
  return cells;
}
