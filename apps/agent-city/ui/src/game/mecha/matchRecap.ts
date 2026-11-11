import { stakeBuildings, type MatchState, type TurnEvent } from "./board";
import { canonicalJson } from "./contracts/match";
import { buildHealthTimeline } from "./healthTimeline";

export type MatchLoss = { turn: number; kind: "mech" | "building"; id: string };
export type MatchRecap = { status: "verified"; losses: MatchLoss[] } | { status: "unavailable" };
type RecordedTurn = { before: MatchState; after: MatchState; log: TurnEvent[] };

/** Actual first losses only, from the complete, continuous, reconciled local recording.
 * A loss is a fact, not a claim about causality or whether it could have been avoided. */
export function buildMatchRecap(final: MatchState, rounds: readonly RecordedTurn[]): MatchRecap | null {
  if (final.phase !== "finished" || !final.outcome || final.outcome === "victory") return null;
  const unavailable: MatchRecap = { status: "unavailable" };
  if (!rounds.length || rounds[0]!.before.turn !== 1 || canonicalJson(rounds.at(-1)!.after) !== canonicalJson(final)) return unavailable;
  const first = rounds[0]!.before;
  const protectedIds = new Set(stakeBuildings(first).map((building) => building.id));
  if (first.mechs.some((mech) => mech.hp <= 0) || stakeBuildings(first).some((building) => building.hp <= 0)) return unavailable;
  const losses: MatchLoss[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i]!;
    if (round.before.phase !== "player_plan" || round.before.turn !== i + 1 || (i > 0 && canonicalJson(rounds[i - 1]!.after) !== canonicalJson(round.before))) return unavailable;
    const outcomes = round.log.filter((event) => event.type === "outcome");
    if (i === rounds.length - 1 ? outcomes.length !== 1 || outcomes[0]?.outcome !== final.outcome : outcomes.length !== 0 || round.after.outcome !== null) return unavailable;
    const timeline = buildHealthTimeline(round.before, round.after, round.log);
    if (!timeline.ok) return unavailable;
    for (const { effect } of timeline.steps) {
      if (effect.before <= 0 || effect.after > 0 || (effect.kind !== "mech" && (effect.kind !== "building" || !protectedIds.has(effect.id)))) continue;
      const key = `${effect.kind}:${effect.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      losses.push({ turn: round.before.turn, kind: effect.kind, id: effect.id });
    }
  }
  return { status: "verified", losses };
}
