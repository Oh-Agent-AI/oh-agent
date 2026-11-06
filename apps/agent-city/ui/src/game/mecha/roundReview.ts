import { GDD_RULESET, MAX_TURNS, type ArenaPlan, type MatchState, type TurnEvent } from "./board";
import { canonicalJson } from "./contracts/match";
import { buildHealthTimeline } from "./healthTimeline";
import { pveRules } from "./rules/pve";
import { buildTurnRecap } from "./turnRecap";

/** The accepted local PvE recording, or rounds returned by the local archive verifier.
 * This deliberately does not accept a bare event log: it cannot prove missing events. */
export type RoundReviewRecord = {
  before: MatchState;
  after: MatchState;
  plan: ArenaPlan;
  log: TurnEvent[];
};

export type RoundReviewEntry = {
  turn: number;
  /** Gross HP lost; later repairs do not cancel damage. All buildings are included. */
  enemyDamage: number;
  mechDamage: number;
  buildingDamage: number;
  /** Distinct enemies crossing from positive HP to zero in this turn. */
  enemiesDown: number;
  /** Accepted actions recorded as fizzled; not shots that merely did zero damage. */
  fizzledActions: number;
};

export type RoundReview =
  | { status: "verified"; rounds: RoundReviewEntry[] }
  | { status: "unavailable"; rounds: [] };

const unavailable = (): RoundReview => ({ status: "unavailable", rounds: [] });
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/**
 * Verify a complete local PvE match from turn 1 through the supplied final state.
 * Re-settlement compares the entire accepted log as well as the resulting state;
 * HP reconciliation alone cannot detect missing zero-damage/fizzled actions.
 * The rules clone their input. Neither the recording nor the live match is changed.
 * This checks internal consistency, not the origin of an arbitrary fabricated first
 * state: callers must supply their own accepted local recording or verified archive.
 */
export function buildRoundReview(final: MatchState | null | undefined, rounds: readonly RoundReviewRecord[] | null | undefined): RoundReview {
  try {
    if (!final || final.ruleset !== GDD_RULESET || final.phase !== "finished" || !final.outcome
      || !Array.isArray(rounds) || !rounds.length || rounds.length > MAX_TURNS
      || !same(rounds[rounds.length - 1]?.after, final)) return unavailable();

    const entries: RoundReviewEntry[] = [];
    for (let i = 0; i < rounds.length; i++) {
      const round = rounds[i]!;
      if (!round || !round.before || !round.after || !round.plan || !Array.isArray(round.log)
        || round.before.ruleset !== GDD_RULESET || round.before.phase !== "player_plan"
        || round.before.outcome !== null || round.before.turn !== i + 1
        || (i > 0 && !same(rounds[i - 1]!.after, round.before))) return unavailable();
      const last = i === rounds.length - 1;
      if (last ? round.after.phase !== "finished" || round.after.outcome !== final.outcome
        : round.after.phase !== "player_plan" || round.after.outcome !== null) return unavailable();

      const played = pveRules.playTurn(round.before, round.plan);
      if (!played.ok || !same(played.state, round.after) || !same(played.log, round.log)) return unavailable();
      const timeline = buildHealthTimeline(round.before, round.after, round.log);
      if (!timeline.ok) return unavailable();
      const recap = buildTurnRecap(round.log, timeline);
      if (!recap.health) return unavailable();
      const enemyDamage = timeline.steps.reduce((sum, { effect }) =>
        sum + (effect.kind === "boss" || effect.kind === "raider" ? Math.max(0, effect.before - effect.after) : 0), 0);
      entries.push({ turn: round.before.turn, enemyDamage, ...recap.health, fizzledActions: recap.fizzledActions });
    }
    return { status: "verified", rounds: entries };
  } catch {
    // Malformed or incompatible historical data must never break the result screen.
    return unavailable();
  }
}
