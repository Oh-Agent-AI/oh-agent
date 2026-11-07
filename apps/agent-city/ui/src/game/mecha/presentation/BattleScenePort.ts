import type { MatchSnapshot, TurnResolved } from "../contracts/match";
import type { MatchState } from "../rules";
export type RemoteBattleState = MatchState;

export interface BattleScenePort {
  applySnapshot(snapshot: MatchSnapshot<RemoteBattleState>): void;
  playTurn(turn: TurnResolved<RemoteBattleState>): Promise<void>;
  setPaused(paused: boolean): void;
  dispose(): void;
}
