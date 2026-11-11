import { enemyStatsOf, MAX_TURNS, STATS, SWARM_CHILD_HP, type MatchState } from "./board";

export function unitMaxHp(id: string, state?: MatchState | null): number | null {
  if (id === "Assault" || id === "Gunner" || id === "Support") return STATS[id].maxHp;
  if (id === "boss") return enemyStatsOf(state ?? {}).bossHp;
  // The ID alone cannot distinguish a summoned child from an ordinary raider.
  const raider = state?.raiders.find((candidate) => candidate.id === id);
  const summon = raider?.summon;
  if (summon?.parentId === "boss" && summon.speciesId === "swarm_child" &&
      Number.isSafeInteger(summon.expiresAtRound) && summon.expiresAtRound >= 3 && summon.expiresAtRound <= MAX_TURNS + 2) return SWARM_CHILD_HP;
  if (["raider-w", "raider-e", "raider-west", "raider-east"].includes(id) || raider) return enemyStatsOf(state ?? {}).raiderHp;
  return null;
}

/** Unknown/invalid life is not rendered as a fabricated full or empty bar. */
export function unitHealth(hp: number | undefined, maxHp: number | undefined | null) {
  if (typeof hp !== "number" || !Number.isFinite(hp) || hp < 0 || typeof maxHp !== "number" || !Number.isFinite(maxHp) || maxHp <= 0) {
    return { known: false, ratio: null, text: "?" } as const;
  }
  return { known: true, ratio: Math.max(0, Math.min(1, hp / maxHp)), text: `${hp} / ${maxHp}` } as const;
}
