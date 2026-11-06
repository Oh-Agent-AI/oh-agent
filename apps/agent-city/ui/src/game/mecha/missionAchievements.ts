import { BOARD, GDD_RULESET, MAX_TURNS, MECH_IDS, STATS, stakeBuildings, type MatchState, type TurnEvent, type ArenaPlan } from "./board";
import { canonicalJson } from "./contracts/match";
import { buildHealthTimeline } from "./healthTimeline";
import { pveRules } from "./rules/pve";

export type MissionAchievementStatus = "achieved" | "not-achieved" | "not-applicable" | "unverifiable";
export type MissionAchievement = { id: "all-survived" | "protected-buildings-undamaged"; status: MissionAchievementStatus };
export type MissionAchievements = { items: [MissionAchievement, MissionAchievement] };
export type MissionAchievementRound = { before: MatchState; after: MatchState; log: TurnEvent[]; plan?: ArenaPlan };

// The caller must establish the local PvE boundary; MatchState alone cannot distinguish remote games.
export type MissionAchievementInput = {
  scope: "local-pve" | "other";
  final: MatchState | null | undefined;
  rounds?: readonly MissionAchievementRound[] | null;
};

const status = (id: MissionAchievement["id"], value: MissionAchievementStatus): MissionAchievement => ({ id, status: value });
const finiteHp = (hp: number, max = Infinity) => Number.isFinite(hp) && hp >= 0 && hp <= max;
const unique = (ids: string[]) => ids.every(id => typeof id === "string" && id.length > 0) && new Set(ids).size === ids.length;
const validCell = (cell: { x: number; y: number }) => !!cell && Number.isInteger(cell.x) && Number.isInteger(cell.y)
  && cell.x >= 0 && cell.x < BOARD && cell.y >= 0 && cell.y < BOARD;

function validState(state: MatchState): boolean {
  if (state.ruleset !== GDD_RULESET || !Array.isArray(state.mechs) || state.mechs.length !== MECH_IDS.length
    || !unique(state.mechs.map(m => m.id)) || !MECH_IDS.every(id => state.mechs.some(m => m.id === id && finiteHp(m.hp, STATS[id].maxHp)))
    || !Array.isArray(state.buildings) || !unique(state.buildings.map(b => b.id))
    || !state.buildings.every(b => Number.isFinite(b.maxHp) && b.maxHp > 0 && finiteHp(b.hp, b.maxHp)
      && Array.isArray(b.cells) && b.cells.length > 0 && b.cells.every(validCell))
    || !state.boss || !finiteHp(state.boss.hp) || !Array.isArray(state.raiders)
    || !unique(state.raiders.map(r => r.id)) || !state.raiders.every(r => finiteHp(r.hp))
    || (state.stake !== "all" && state.stake !== "frontage")) return false;
  if (state.mission !== undefined && (state.mission?.kind !== "rescue:v1" || !validCell(state.mission.target))) return false;
  // Frontage's fallback depends on the entire board, not just cells that happen to be present.
  if (state.stake === "frontage" && (!Array.isArray(state.terrain) || state.terrain.length !== BOARD
    || !state.terrain.every(row => Array.isArray(row) && row.length === BOARD
      && row.every(cell => ["land", "water", "mountain", "road"].includes(cell))))) return false;
  return true;
}

function fixedData(state: MatchState): string {
  return canonicalJson({ mission: state.mission ?? null, stake: state.stake,
    terrain: state.stake === "frontage" ? state.terrain : null,
    buildings: state.buildings.map(({ id, cells, maxHp }) => ({ id, cells, maxHp })) });
}

/** Optional descriptive facts only. Never mutates the match or participates in adjudication.
 * History-based claims require the complete opening-to-victory local recording, reconciled health
 * effects and stable objective data. Old/incomplete recordings degrade to unverifiable. */
export function buildMissionAchievements({ scope, final, rounds }: MissionAchievementInput): MissionAchievements | null {
  if (scope !== "local-pve" || !final || final.phase !== "finished" || final.outcome !== "victory") return null;
  const unknown = (): MissionAchievements => ({ items: [status("all-survived", "unverifiable"), status("protected-buildings-undamaged", "unverifiable")] });
  try {
    if (!validState(final)) return unknown();
    // Rescue has no protected-building win/loss objective, even if buildings exist on the map.
    const noBuildingObjective = final.mission?.kind === "rescue:v1" || stakeBuildings(final).length === 0;
    const unavailable = (): MissionAchievements => ({ items: [status("all-survived", "unverifiable"),
      status("protected-buildings-undamaged", noBuildingObjective ? "not-applicable" : "unverifiable")] });
    if (!rounds?.length || rounds.length > MAX_TURNS || rounds[0]!.before.turn !== 1
      || canonicalJson(rounds.at(-1)!.after) !== canonicalJson(final)) return unavailable();
    const first = rounds[0]!.before;
    if (!validState(first) || first.mechs.some(m => m.hp !== STATS[m.id].maxHp)
      || first.buildings.some(b => b.hp !== b.maxHp)) return unavailable();
    const fixed = fixedData(first);
    const protectedIds = new Set(noBuildingObjective ? [] : stakeBuildings(first).map(b => b.id));
    let allSurvived = true;
    let buildingsUndamaged = true;
    for (let i = 0; i < rounds.length; i++) {
      const { before, after, log, plan } = rounds[i]!;
      if (!validState(before) || !validState(after)) return unavailable();
      if (fixedData(before) !== fixed || fixedData(after) !== fixed) return unknown();
      if (before.phase !== "player_plan" || before.outcome !== null || before.turn !== i + 1
        || (i > 0 && canonicalJson(rounds[i - 1]!.after) !== canonicalJson(before)) || !Array.isArray(log)) return unavailable();
      const outcomes = log.filter(event => event.type === "outcome");
      if (i === rounds.length - 1 ? after.phase !== "finished" || after.turn !== before.turn || outcomes.length !== 1 || outcomes[0]?.outcome !== "victory"
        : after.phase !== "player_plan" || after.outcome !== null || after.turn !== i + 2 || outcomes.length !== 0) return unavailable();
      // Accepted rounds contain the submitted plan. Re-run the same authoritative PvE
      // turn boundary and require both the resulting state and complete log to match.
      // A self-consistent but fabricated health timeline is not historical evidence.
      if (!plan) return unavailable();
      const replay = pveRules.playTurn(before, plan);
      if (!replay.ok || canonicalJson(replay.state) !== canonicalJson(after)
        || canonicalJson(replay.log) !== canonicalJson(log)) return unavailable();
      // damage is actual post-armour, HP-capped loss, in the same HP units as effects.
      // An enemy event sums its direct victims; nested collision shoves are separate events.
      // A shove's damage is ONLY the pushed unit's loss, while its effects may also include
      // other collision victims. Thus the sum is a lower-bound check, never equality.
      // Repair has damage=0 and positive HP effects, so it must not be compared as damage.
      // Older events with unaccounted damage do not identify its victims reliably.
      if (log.some(event => (event.type === "act" || event.type === "enemy" || event.type === "shove")
        && (!finiteHp(event.damage) || (event.damage > 0 && (!Array.isArray(event.effects)
          || event.effects.reduce((sum, effect) => sum + Math.max(0, effect.before - effect.after), 0) < event.damage))))) return unavailable();
      const timeline = buildHealthTimeline(before, after, log);
      if (!timeline.ok) return unavailable();
      for (const { effect } of timeline.steps) {
        const max = effect.kind === "mech" ? STATS[effect.id as keyof typeof STATS]?.maxHp
          : effect.kind === "building" ? first.buildings.find(b => b.id === effect.id)?.maxHp : Infinity;
        if (max === undefined || !finiteHp(effect.before, max) || !finiteHp(effect.after, max)) return unavailable();
        if (effect.kind === "mech" && effect.after === 0) allSurvived = false;
        if (effect.kind === "building" && protectedIds.has(effect.id) && effect.after < effect.before) buildingsUndamaged = false;
      }
    }
    return { items: [status("all-survived", allSurvived ? "achieved" : "not-achieved"),
      status("protected-buildings-undamaged", noBuildingObjective ? "not-applicable" : buildingsUndamaged ? "achieved" : "not-achieved")] };
  } catch {
    // Partial/corrupt persisted input is not evidence of an achievement.
    return unknown();
  }
}
