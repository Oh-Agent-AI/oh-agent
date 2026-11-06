import type { DecisionPlanner } from "../decision";
import type { Action, ArenaPlan, Cell, MatchState, MechId } from "../rules";

export type PlannerDoctrine = "tunnel" | "peel";

export type CandidateAction = {
  mechId: MechId;
  moveTo: Cell | null;
  action: Action;
};

export interface CandidateSource {
  readonly id: string;
  candidates(state: MatchState): CandidateAction[];
}

export interface PlanSimulator {
  apply(state: MatchState, plan: ArenaPlan): MatchState | null;
}

export type ScoreFactorId =
  | "boss_damage"
  | "raider_damage"
  | "building_damage"
  | "mech_damage"
  | "kill"
  | "repair"
  | "victory"
  | "defeat"
  | "position"
  | "threat"
  | "cooldown"
  | "tie_break";

export type ScoreFactor = {
  id: ScoreFactorId;
  value: number;
  weight: number;
  score: number;
  note?: string;
};

export type PlanEvaluation = {
  plan: ArenaPlan;
  score: number;
  factors: ScoreFactor[];
  deterministicKey: string;
};

export interface PlanScorer {
  readonly weightVersion: string;
  score(state: MatchState, plan: ArenaPlan): PlanEvaluation | null;
}

export interface MatchPlanner extends DecisionPlanner<MatchState, ArenaPlan> {
  readonly doctrine: PlannerDoctrine;
  evaluate(state: MatchState): PlanEvaluation[];
}
