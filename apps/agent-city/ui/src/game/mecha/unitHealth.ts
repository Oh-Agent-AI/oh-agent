import { enemyStatsOf, STATS, type MatchState } from "./board";

export function unitMaxHp(id: string, state?: MatchState | null): number | null {
  if (id === "Assault" || id === "Gunner" || id === "Support") return STATS[id].maxHp;
  if (id === "boss") return enemyStatsOf(state ?? {}).bossHp;
  if (["raider-w", "raider-e", "raider-west", "raider-east"].includes(id) || state?.raiders.some((raider) => raider.id === id)) return enemyStatsOf(state ?? {}).raiderHp;
  return null;
}

/** Unknown/invalid life is not rendered as a fabricated full or empty bar. */
export function unitHealth(hp: number | undefined, maxHp: number | undefined | null) {
  if (typeof hp !== "number" || !Number.isFinite(hp) || hp < 0 || typeof maxHp !== "number" || !Number.isFinite(maxHp) || maxHp <= 0) {
    return { known: false, ratio: null, text: "?" } as const;
  }
  return { known: true, ratio: Math.max(0, Math.min(1, hp / maxHp)), text: `${hp} / ${maxHp}` } as const;
}
