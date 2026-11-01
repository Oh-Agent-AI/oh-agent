import { playTurn, type MatchState } from "../rules";
import type { MatchRuleAdapter } from "../contracts/match";

/** Shared authoritative PvE turn boundary; transport/session concerns stay outside. */
export const pveRules: MatchRuleAdapter<MatchState> = {
  ruleset: "mecha-v1.4",
  activeSide: (state) => state.phase === "player_plan" && !state.outcome ? "A" : null,
  playTurn,
  isFinished: (state) => Boolean(state.outcome) || state.phase === "finished",
};
