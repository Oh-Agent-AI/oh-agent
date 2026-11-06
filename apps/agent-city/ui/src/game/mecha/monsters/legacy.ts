import type { BossScriptId, BossSkill } from "../board";

// Exhaustive identity maps preserve the old IDs and their separation: a script is
// a planner policy, not a species, and a skill is not a new signature skill.
type LegacyBossSkill = Extract<BossSkill, "smash" | "sweep" | "skip">;

export const LEGACY_BOSS_SKILL_MAP = Object.freeze({
  smash: "smash", sweep: "sweep", skip: "skip",
} as const satisfies { [K in LegacyBossSkill]: K });
export const LEGACY_BOSS_SCRIPT_MAP = Object.freeze({
  stationary_smash: "stationary_smash", cadence_ssw: "cadence_ssw", raid_ssw: "raid_ssw", siege: "siege",
} as const satisfies { [K in BossScriptId]: K });

export function mapLegacyBossSkill(value: unknown): LegacyBossSkill | null {
  return typeof value === "string" && Object.hasOwn(LEGACY_BOSS_SKILL_MAP, value)
    ? LEGACY_BOSS_SKILL_MAP[value as LegacyBossSkill] : null;
}

export function mapLegacyBossScript(value: unknown): BossScriptId | null {
  return typeof value === "string" && Object.hasOwn(LEGACY_BOSS_SCRIPT_MAP, value)
    ? LEGACY_BOSS_SCRIPT_MAP[value as BossScriptId] : null;
}
