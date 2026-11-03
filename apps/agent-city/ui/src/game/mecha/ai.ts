import { footprintCenter, type Cell, type MatchState } from "./rules";
import type { PlanEvaluation, PlannerDoctrine } from "./ai/contracts";
import { createMatchPlanner } from "./ai/planner";
import { nearestStakeCell, threatFocus } from "./ai/shared";

export type { CandidateAction, CandidateSource, MatchPlanner, PlanEvaluation, PlanScorer, PlanSimulator, PlannerDoctrine, ScoreFactor, ScoreFactorId } from "./ai/contracts";

const tunnelPlanner = createMatchPlanner("tunnel");
const peelPlanner = createMatchPlanner("peel");

export type DoctrineId = PlannerDoctrine;

export function evaluatePlansForDoctrine(state: MatchState, doctrine: DoctrineId): PlanEvaluation[] {
  return (doctrine === "peel" ? peelPlanner : tunnelPlanner).evaluate(state);
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
