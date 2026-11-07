import { PLANNED_SIGNATURE_SKILLS, type DeliveryMilestone, type PlannedMonsterSpeciesId, type ThreatLevel } from "./contracts";

/** Rulesets a species can be played under. This is a capability claim, not a definition lookup key. */
export type CatalogRuleset = "mecha-v1.4" | "mecha-v1.5";
export type MonsterStatusKind = "poison" | "burn" | "freeze" | "stun";

/**
 * Single source of truth for monster capability. Definitions and copy live in
 * `registry.ts`; every list (practice, status challenge, ruleset support) is
 * derived from this catalog instead of maintained separately.
 */
export type MonsterCatalogEntry = Readonly<{
  id: PlannedMonsterSpeciesId;
  name: string;
  threatLevel: ThreatLevel;
  deliveryMilestone: DeliveryMilestone;
  skillId: (typeof PLANNED_SIGNATURE_SKILLS)[PlannedMonsterSpeciesId];
  supportedRulesets: readonly CatalogRuleset[];
  practice: boolean;
  statusKind?: MonsterStatusKind;
  visualKey: string;
}>;

const BOTH = ["mecha-v1.4", "mecha-v1.5"] as const;
const LEGACY_ONLY = ["mecha-v1.4"] as const;

export const MONSTER_CATALOG: readonly MonsterCatalogEntry[] = [
  { id: "spore_leaper", name: "孢群体", threatLevel: 1, deliveryMilestone: "M2", skillId: PLANNED_SIGNATURE_SKILLS.spore_leaper, supportedRulesets: BOTH, practice: true, statusKind: "poison", visualKey: "spore_leaper" },
  { id: "flux_lancer", name: "流环体", threatLevel: 2, deliveryMilestone: "M2", skillId: PLANNED_SIGNATURE_SKILLS.flux_lancer, supportedRulesets: BOTH, practice: true, statusKind: "burn", visualKey: "flux_lancer" },
  { id: "porous_shaper", name: "孔洞行者", threatLevel: 3, deliveryMilestone: "M3", skillId: PLANNED_SIGNATURE_SKILLS.porous_shaper, supportedRulesets: LEGACY_ONLY, practice: true, visualKey: "porous_shaper" },
  { id: "prism_warden", name: "晶簇体", threatLevel: 4, deliveryMilestone: "M2", skillId: PLANNED_SIGNATURE_SKILLS.prism_warden, supportedRulesets: BOTH, practice: true, statusKind: "freeze", visualKey: "prism_warden" },
  { id: "swarm_mantle", name: "群构体", threatLevel: 5, deliveryMilestone: "M4", skillId: PLANNED_SIGNATURE_SKILLS.swarm_mantle, supportedRulesets: LEGACY_ONLY, practice: true, visualKey: "swarm_mantle" },
  { id: "phase_stalker", name: "相位体", threatLevel: 6, deliveryMilestone: "M3", skillId: PLANNED_SIGNATURE_SKILLS.phase_stalker, supportedRulesets: LEGACY_ONLY, practice: true, visualKey: "phase_stalker" },
  { id: "gravity_core", name: "引力核", threatLevel: 7, deliveryMilestone: "M3", skillId: PLANNED_SIGNATURE_SKILLS.gravity_core, supportedRulesets: BOTH, practice: true, statusKind: "stun", visualKey: "gravity_core" },
  { id: "neural_weaver", name: "织网体", threatLevel: 8, deliveryMilestone: "M4", skillId: PLANNED_SIGNATURE_SKILLS.neural_weaver, supportedRulesets: LEGACY_ONLY, practice: true, visualKey: "neural_weaver" },
  { id: "many_core", name: "多核生命", threatLevel: 9, deliveryMilestone: "M5", skillId: PLANNED_SIGNATURE_SKILLS.many_core, supportedRulesets: LEGACY_ONLY, practice: false, visualKey: "many_core" },
  { id: "field_sovereign", name: "场域生命", threatLevel: 10, deliveryMilestone: "M6", skillId: PLANNED_SIGNATURE_SKILLS.field_sovereign, supportedRulesets: LEGACY_ONLY, practice: false, visualKey: "field_sovereign" },
];

export const STATUS_SPECIES = ["spore_leaper", "flux_lancer", "prism_warden", "gravity_core"] as const;
export type StatusMonsterId = (typeof STATUS_SPECIES)[number];

const BY_ID = new Map<string, MonsterCatalogEntry>(MONSTER_CATALOG.map(entry => [entry.id, entry]));
const STATUS_SET = new Set<string>(STATUS_SPECIES);

/** Unknown values never select a default species. */
export function monsterCatalogEntry(id: unknown): MonsterCatalogEntry | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

export function catalogSupports(id: unknown, ruleset: CatalogRuleset): boolean {
  return Boolean(monsterCatalogEntry(id)?.supportedRulesets.includes(ruleset));
}

export function isStatusSpecies(value: unknown): value is StatusMonsterId {
  return typeof value === "string" && STATUS_SET.has(value);
}

export function practiceSpecies(): PlannedMonsterSpeciesId[] {
  return MONSTER_CATALOG.filter(entry => entry.practice).map(entry => entry.id);
}

export function statusSpecies(): StatusMonsterId[] {
  return MONSTER_CATALOG.flatMap(entry => entry.statusKind ? [entry.id as StatusMonsterId] : []);
}

export function statusKindOf(id: unknown): MonsterStatusKind | undefined {
  return monsterCatalogEntry(id)?.statusKind;
}
