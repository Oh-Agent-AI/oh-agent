import type { DeploymentResult, MatchEvent, MatchResult, MatchSnapshot, RevisionState, SubmitDeploymentCommand, SubmitPlanCommand, TurnResolved } from "../contracts/match";
import type { MatchSession } from "../session/MatchSession";
import type { MatchClient } from "./MatchClient";

export class LocalMatchClient<S extends RevisionState> implements MatchClient<S> {
  private readonly session: MatchSession<S>;
  private readonly playerId: string;

  constructor(session: MatchSession<S>, playerId: string) {
    this.session = session;
    this.playerId = playerId;
  }

  async snapshot(matchId: string): Promise<MatchResult<MatchSnapshot<S>>> {
    const snapshot = this.session.snapshot(this.playerId);
    if (!snapshot.ok) return snapshot;
    return snapshot.value.matchId === matchId ? snapshot : { ok: false, error: { code: "match_not_found" } };
  }

  async submitDeployment(command: SubmitDeploymentCommand): Promise<DeploymentResult<S>> {
    return this.session.submitDeployment(this.playerId, command);
  }

  async submitPlan(command: SubmitPlanCommand): Promise<MatchResult<TurnResolved<S>>> {
    return this.session.submitPlan(this.playerId, command);
  }


  async close(matchId: string): Promise<MatchResult<MatchSnapshot<S>>> {
    const snapshot = this.session.snapshot(this.playerId);
    if (!snapshot.ok) return snapshot;
    return snapshot.value.matchId === matchId ? this.session.close(this.playerId) : { ok: false, error: { code: "match_not_found" } };
  }

  subscribe(listener: (event: MatchEvent<S>) => void): () => void {
    return this.session.subscribe(listener);
  }
}
