import type { BossScriptId, BossSkill } from "../board";

/** Definition lookup keys, not an assertion that a match or transport supports them. */
export type MonsterRuleset = "mecha-v1.4";
export type MonsterContentVersion = 1;

export const PLANNED_MONSTER_SPECIES_IDS = Object.freeze([
  "spore_leaper", "flux_lancer", "porous_shaper", "prism_warden", "swarm_mantle",
  "phase_stalker", "gravity_core", "neural_weaver", "many_core", "field_sovereign",
] as const);
export type PlannedMonsterSpeciesId = typeof PLANNED_MONSTER_SPECIES_IDS[number];
export type MonsterSpeciesId = "legacy_boss" | PlannedMonsterSpeciesId;

export const PLANNED_SIGNATURE_SKILLS = Object.freeze({
  spore_leaper: "spore_leap",
  flux_lancer: "ring_pierce",
  porous_shaper: "corrode_cell",
  prism_warden: "prism_guard",
  swarm_mantle: "split_swarm",
  phase_stalker: "phase_swap",
  gravity_core: "gravity_well",
  neural_weaver: "neural_link",
  many_core: "core_migration",
  field_sovereign: "space_fold",
} as const satisfies Record<PlannedMonsterSpeciesId, string>);
export type PlannedSignatureSkillId = typeof PLANNED_SIGNATURE_SKILLS[PlannedMonsterSpeciesId];
export type MonsterSkillId = BossSkill | PlannedSignatureSkillId;
export type MonsterPlannerPolicyId = BossScriptId;
export type ThreatLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type DeliveryMilestone = "M2" | "M3" | "M4" | "M5" | "M6";

/** Appearance seed belongs to an encounter, not to static species or battle rules. */
export type EncounterContent = Readonly<{
  speciesId: MonsterSpeciesId;
  contentVersion: MonsterContentVersion;
  visualSeed: number;
}>;

export type PlannedMonsterDefinition<K extends PlannedMonsterSpeciesId = PlannedMonsterSpeciesId> = Readonly<{
  kind: "planned_species";
  id: K;
  ruleset: MonsterRuleset;
  contentVersion: MonsterContentVersion;
  threatLevel: ThreatLevel;
  name: string;
  footprint: Readonly<{ width: 2; height: 2 }>;
  signatureSkill: Readonly<{
    id: typeof PLANNED_SIGNATURE_SKILLS[K];
    name: string;
    intent: string;
    counterplay: string;
    rulePrimitive: string;
  }>;
  deliveryMilestone: DeliveryMilestone;
}>;

/** The legacy entry is an identity bridge, not a reimplementation of the boss. */
export type LegacyBossDefinition = Readonly<{
  kind: "legacy_boss";
  id: "legacy_boss";
  ruleset: MonsterRuleset;
  contentVersion: MonsterContentVersion;
  footprint: Readonly<{ width: 2; height: 2 }>;
  skillIds: readonly BossSkill[];
  scriptIds: readonly BossScriptId[];
}>;
export type MonsterDefinition = LegacyBossDefinition | PlannedMonsterDefinition;

export type DefinitionLookupError = "unsupported_ruleset" | "unsupported_content_version" | "unknown_species";
export type DefinitionLookupResult =
  | { ok: true; definition: MonsterDefinition }
  | { ok: false; reason: DefinitionLookupError };
export type EncounterResolutionResult =
  | { ok: true; content: EncounterContent; definition: MonsterDefinition }
  | { ok: false; reason: DefinitionLookupError | "invalid_encounter_content" | "invalid_visual_seed" };
