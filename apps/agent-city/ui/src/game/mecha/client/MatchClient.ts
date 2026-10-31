import type { MatchEvent, MatchResult, MatchSnapshot, RevisionState, SubmitPlanCommand, TurnResolved } from "../contracts/match";
import type { MatchState } from "../rules";

export interface MatchClient<S extends RevisionState = MatchState> {
  snapshot(matchId: string): Promise<MatchResult<MatchSnapshot<S>>>;
  submitPlan(command: SubmitPlanCommand): Promise<MatchResult<TurnResolved<S>>>;
  concede(matchId: string): Promise<MatchResult<TurnResolved<S>>>;
  close(matchId: string): Promise<MatchResult<MatchSnapshot<S>>>;
  subscribe(listener: (event: MatchEvent<S>) => void): () => void;
}
