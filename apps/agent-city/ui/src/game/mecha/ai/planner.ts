import { living, type ArenaPlan, type MatchState, type MechOrder } from "../rules";
import { createCandidateSource } from "./candidates";
import type { CandidateSource, MatchPlanner, PlanEvaluation, PlanScorer, PlannerDoctrine } from "./contracts";
import { createPlanScorer } from "./score";

function holdPlan(state: MatchState): ArenaPlan {
  return {
    revision: state.revision,
    items: living(state).map((mech) => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" } })),
  };
}

function bestEvaluation(evaluations: PlanEvaluation[]): PlanEvaluation | null {
  let best: PlanEvaluation | null = null;
  for (const evaluation of evaluations) {
    if (!best || evaluation.score > best.score || (evaluation.score === best.score && evaluation.deterministicKey < best.deterministicKey)) best = evaluation;
  }
  return best;
}

export function createMatchPlanner(
  doctrine: PlannerDoctrine,
  source: CandidateSource = createCandidateSource(doctrine),
  scorer: PlanScorer = createPlanScorer(doctrine),
): MatchPlanner {
  const evaluate = (state: MatchState): PlanEvaluation[] => {
    const candidates = source.candidates(state);
    const ids = living(state).map((mech) => mech.id);
    const groups = ids.map((id) => candidates.filter((candidate) => candidate.mechId === id));
    const evaluations: PlanEvaluation[] = [];
    const consider = (items: MechOrder[]) => {
      const plan = { revision: state.revision, items };
      const evaluation = scorer.score(state, plan);
      if (evaluation) evaluations.push(evaluation);
    };
    const walk = (index: number, items: MechOrder[]) => {
      if (index === ids.length) {
        consider(items);
        return;
      }
      const id = ids[index];
      if (!id) return;
      for (const candidate of groups[index] ?? []) {
        walk(index + 1, items.concat({
          mechId: id,
          moveTo: candidate.moveTo ? { ...candidate.moveTo } : null,
          action: structuredClone(candidate.action),
        }));
      }
    };
    walk(0, []);
    consider(holdPlan(state).items);
    return evaluations;
  };
  return {
    doctrine,
    evaluate,
    plan(state: MatchState): ArenaPlan {
      return bestEvaluation(evaluate(state))?.plan ?? holdPlan(state);
    },
  };
}
