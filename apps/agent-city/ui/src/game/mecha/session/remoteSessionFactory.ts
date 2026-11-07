import type { MatchPlayer } from "../contracts/match";
import type { RemoteArenaV1 } from "../contracts/arena";
import type { MatchState } from "../board";
import type { DeployPlacement } from "../deployment";
import type { SequentialCommand } from "../sequentialTurn";
import { MatchSession, pveRules } from "./MatchSession";
import { SequentialMatchSession } from "./SequentialMatchSession";

export type RemoteCreateConfig =
  | { matchId: string; mode: "pve"; arena: RemoteArenaV1; state: MatchState; players: MatchPlayer[]; ruleset?: "mecha-v1.4" }
  | { matchId: string; ruleset: "mecha-v1.5"; initial: MatchState; placements: DeployPlacement[]; commands?: SequentialCommand[] };

export type RemoteHostSession =
  | { kind: "v1.4"; session: MatchSession<MatchState> }
  | { kind: "v1.5"; session: SequentialMatchSession };

/** One boundary for both transports; callers never build a plan session for v1.5. */
export function createRemoteSession(config: RemoteCreateConfig): RemoteHostSession {
  if (config.ruleset === "mecha-v1.5") {
    return { kind: "v1.5", session: new SequentialMatchSession(config.matchId, config.initial, config.placements, config.commands ?? []) };
  }
  return { kind: "v1.4", session: new MatchSession({ matchId: config.matchId, mode: "pve", arena: config.arena, state: config.state, players: config.players, rules: pveRules }) };
}
