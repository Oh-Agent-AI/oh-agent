import { MAX_TURNS, STATS, stakeBuildings, type MatchState, type TurnEvent } from "./board";
import { canonicalJson } from "./contracts/match";
import { buildHealthTimeline, type HealthTimeline } from "./healthTimeline";
import { buildTurnRecap } from "./turnRecap";
import { SequentialTurn, type SequentialRecord } from "./sequentialTurn";
import type { RoundReview, RoundReviewEntry } from "./roundReview";
import type { MissionAchievements } from "./missionAchievements";
import type { MatchLoss, MatchRecap } from "./matchRecap";

/** Each command has its own effect numbering and must be reconciled separately. */
export function buildSequentialInterval(initial: MatchState, records: readonly SequentialRecord[]): { events: TurnEvent[]; health: HealthTimeline } {
  let before = initial;
  const events: TurnEvent[] = [], steps: Extract<HealthTimeline, { ok: true }>["steps"] = [];
  for (const record of records) {
    const timeline = buildHealthTimeline(before, record.snapshot.match, record.events, record.presentationStages);
    if (!timeline.ok) return { events: records.flatMap(item => item.events), health: timeline };
    for (const step of timeline.steps) steps.push({ ...step, eventIndex: step.eventIndex + events.length });
    events.push(...record.events);
    before = record.snapshot.match;
  }
  return { events, health: { ok: true, steps } };
}

/** Rebuild accepted command evidence before deriving round facts. */
export function buildSequentialReview(initial: MatchState, records: readonly SequentialRecord[], final: MatchState): { review: RoundReview; achievements: MissionAchievements | null; matchRecap: MatchRecap | null } {
  const unavailable = { review: { status: "unavailable", rounds: [] } as RoundReview, achievements: null, matchRecap: final.outcome === "victory" ? null : { status: "unavailable" } as MatchRecap };
  try {
    if (!final.outcome || final.phase !== "finished" || initial.turn !== 1 ||
        canonicalJson(SequentialTurn.replay(initial, records).snapshot().match) !== canonicalJson(final)) return unavailable;
    const protectedBuildings = stakeBuildings(initial);
    if (initial.mechs.some(unit => unit.hp !== STATS[unit.id].maxHp) ||
        protectedBuildings.some(building => building.hp !== building.maxHp)) return unavailable;
    const protectedIds = new Set(protectedBuildings.map(building => building.id));
    const rounds: RoundReviewEntry[] = [];
    const losses: MatchLoss[] = [];
    const seenLosses = new Set<string>();
    let start = initial, turnRecords: SequentialRecord[] = [], allSurvived = true, buildingsUndamaged = true;
    for (const record of records) {
      if (record.command.kind === "reset") { start = record.snapshot.match; turnRecords = []; continue; }
      turnRecords.push(record);
      const after = record.snapshot.match;
      if (record.command.kind !== "end" && !after.outcome) continue;
      const { events, health: timeline } = buildSequentialInterval(start, turnRecords);
      if (!timeline.ok) return unavailable;
      const recap = buildTurnRecap(events, timeline);
      if (!recap.health) return unavailable;
      let enemyDamage = 0;
      for (const { effect } of timeline.steps) {
        if (effect.kind === "mech" && effect.before > 0 && effect.after <= 0) allSurvived = false;
        if (effect.kind === "building" && protectedIds.has(effect.id) && effect.after < effect.before) buildingsUndamaged = false;
        if ((effect.kind === "mech" || (effect.kind === "building" && protectedIds.has(effect.id))) && effect.before > 0 && effect.after <= 0) {
          const key = `${effect.kind}:${effect.id}`;
          if (!seenLosses.has(key)) { seenLosses.add(key); losses.push({ turn: start.turn, kind: effect.kind, id: effect.id }); }
        }
        if (effect.kind === "boss" || effect.kind === "raider") enemyDamage += Math.max(0, effect.before - effect.after);
      }
      rounds.push({ turn: start.turn, enemyDamage, ...recap.health, fizzledActions: recap.fizzledActions });
      start = after; turnRecords = [];
    }
    if (!rounds.length || rounds.length !== Math.min(final.turn, MAX_TURNS) || rounds.some((round, index) => round.turn !== index + 1)) return unavailable;
    const achievements: MissionAchievements | null = final.outcome !== "victory" ? null : { items: [
      { id: "all-survived", status: allSurvived ? "achieved" : "not-achieved" },
      { id: "protected-buildings-undamaged", status: initial.mission || !protectedBuildings.length ? "not-applicable" : buildingsUndamaged ? "achieved" : "not-achieved" },
    ] };
    const matchRecap: MatchRecap | null = final.outcome === "victory" ? null : { status: "verified", losses };
    return { review: { status: "verified", rounds }, achievements, matchRecap };
  } catch { return unavailable; }
}
