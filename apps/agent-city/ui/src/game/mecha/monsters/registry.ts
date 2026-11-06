import { PLANNED_SIGNATURE_SKILLS } from "./contracts";
import type {
  DefinitionLookupResult, EncounterContent, EncounterResolutionResult, LegacyBossDefinition,
  MonsterDefinition, PlannedMonsterDefinition, PlannedMonsterSpeciesId,
} from "./contracts";

/** V1 is a descriptor catalog only. It does not implement, enable, or authorize skills. */
export const MONSTER_RULESET_V1 = "mecha-v1.4" as const;
export const MONSTER_CONTENT_VERSION_V1 = 1 as const;
const FOOTPRINT = Object.freeze({ width: 2, height: 2 } as const);

const legacyBoss: LegacyBossDefinition = Object.freeze({
  kind: "legacy_boss", id: "legacy_boss", ruleset: MONSTER_RULESET_V1,
  contentVersion: MONSTER_CONTENT_VERSION_V1, footprint: FOOTPRINT,
  skillIds: Object.freeze(["smash", "sweep", "skip"] as const),
  scriptIds: Object.freeze(["stationary_smash", "cadence_ssw", "raid_ssw", "siege"] as const),
});

// These are design descriptions, not playable effects or final balance numbers.
// Keep a published version's entries stable; add another version instead of editing semantics.
const planned = {
  spore_leaper: {
    id: "spore_leaper", threatLevel: 1, name: "孢群体", deliveryMilestone: "M2",
    signatureSkill: { id: PLANNED_SIGNATURE_SKILLS.spore_leaper, name: "孢子弹跳", intent: "宣告落点和范围，移动后造成范围伤害。", counterplay: "离开落点、击退或封堵通道。", rulePrimitive: "敌方移动与范围伤害" },
  },
  flux_lancer: {
    id: "flux_lancer", threatLevel: 2, name: "流环体", deliveryMilestone: "M2",
    signatureSkill: { id: PLANNED_SIGNATURE_SKILLS.flux_lancer, name: "环轨穿刺", intent: "宣告方向、射线和穿透次序，按固定顺序命中。", counterplay: "横向躲避、改变朝向或调整单位次序。", rulePrimitive: "直线与穿透伤害" },
  },
  porous_shaper: {
    id: "porous_shaper", threatLevel: 3, name: "孔洞行者", deliveryMilestone: "M3",
    signatureSkill: { id: PLANNED_SIGNATURE_SKILLS.porous_shaper, name: "蚀格", intent: "宣告目标格和持续回合，生成有明确寿命的危险地形。", counterplay: "绕行、诱导选择低价值格或控制持续区。", rulePrimitive: "持续地形与回合计时" },
  },
  prism_warden: {
    id: "prism_warden", threatLevel: 4, name: "晶簇体", deliveryMilestone: "M2",
    signatureSkill: { id: PLANNED_SIGNATURE_SKILLS.prism_warden, name: "棱镜护盾", intent: "宣告保护对象、次数与失效条件，拦截符合条件的下一段伤害。", counterplay: "先破盾、换目标或拆分多段攻击。", rulePrimitive: "护盾与伤害拦截" },
  },
  swarm_mantle: {
    id: "swarm_mantle", threatLevel: 5, name: "群构体", deliveryMilestone: "M4",
    signatureSkill: { id: PLANNED_SIGNATURE_SKILLS.swarm_mantle, name: "分群围猎", intent: "宣告子体类型、候选出生格与寿命，只生成合法且有上限的子体。", counterplay: "分裂前击杀、封出生格或优先清理子体。", rulePrimitive: "召唤与实体生命周期" },
  },
  phase_stalker: {
    id: "phase_stalker", threatLevel: 6, name: "相位体", deliveryMilestone: "M3",
    signatureSkill: { id: PLANNED_SIGNATURE_SKILLS.phase_stalker, name: "相位交换", intent: "宣告交换对象、落点及后续攻击投影，位置非法时明确落空。", counterplay: "利用交换拉入危险区或破坏合法落点。", rulePrimitive: "位置交换与重投影" },
  },
  gravity_core: {
    id: "gravity_core", threatLevel: 7, name: "引力核", deliveryMilestone: "M3",
    signatureSkill: { id: PLANNED_SIGNATURE_SKILLS.gravity_core, name: "引力井", intent: "宣告范围、牵引顺序和各单位落点，然后结算已宣告攻击。", counterplay: "保持距离、挡住牵引路径或击退核心。", rulePrimitive: "拉动与有序多单位效果" },
  },
  neural_weaver: {
    id: "neural_weaver", threatLevel: 8, name: "织网体", deliveryMilestone: "M4",
    signatureSkill: { id: PLANNED_SIGNATURE_SKILLS.neural_weaver, name: "神经链接", intent: "宣告链接对象、范围、增益与断链条件。", counterplay: "击杀节点、拉开距离或先打被保护者。", rulePrimitive: "实体链接与条件状态" },
  },
  many_core: {
    id: "many_core", threatLevel: 9, name: "多核生命", deliveryMilestone: "M5",
    signatureSkill: { id: PLANNED_SIGNATURE_SKILLS.many_core, name: "核心迁移", intent: "宣告触发阈值、目标核心和阶段技能，只改变已声明的规则状态。", counterplay: "控制爆发时机并按核心位置调整目标。", rulePrimitive: "阶段状态与技能组切换" },
  },
  field_sovereign: {
    id: "field_sovereign", threatLevel: 10, name: "场域生命", deliveryMilestone: "M6",
    signatureSkill: { id: PLANNED_SIGNATURE_SKILLS.field_sovereign, name: "空间折叠", intent: "宣告受影响格子、映射和结算顺序，禁止任意随机重排。", counterplay: "解映射、利用安全区或打断和控制阶段。", rulePrimitive: "有界棋盘变换与多阶段效果" },
  },
} as const satisfies { [K in PlannedMonsterSpeciesId]: Pick<PlannedMonsterDefinition<K>, "id" | "threatLevel" | "name" | "signatureSkill" | "deliveryMilestone"> };

const definitionsV1 = new Map<string, MonsterDefinition>([[legacyBoss.id, legacyBoss]]);
for (const entry of Object.values(planned)) {
  const definition: PlannedMonsterDefinition = Object.freeze({
    ...entry, kind: "planned_species", ruleset: MONSTER_RULESET_V1,
    contentVersion: MONSTER_CONTENT_VERSION_V1, footprint: FOOTPRINT,
    signatureSkill: Object.freeze({ ...entry.signatureSkill }),
  });
  definitionsV1.set(definition.id, definition);
}

/** Exact tuple lookup; unknown values never select a default or a nearby version. */
export function lookupMonsterDefinition(ruleset: unknown, contentVersion: unknown, speciesId: unknown): DefinitionLookupResult {
  if (ruleset !== MONSTER_RULESET_V1) return { ok: false, reason: "unsupported_ruleset" };
  if (contentVersion !== MONSTER_CONTENT_VERSION_V1) return { ok: false, reason: "unsupported_content_version" };
  if (typeof speciesId !== "string") return { ok: false, reason: "unknown_species" };
  const definition = definitionsV1.get(speciesId);
  return definition ? { ok: true, definition } : { ok: false, reason: "unknown_species" };
}

/** Validate an encounter's serializable assignment without touching terrain or match state. */
export function resolveEncounterContent(ruleset: unknown, value: unknown): EncounterResolutionResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "invalid_encounter_content" };
  }
  // Read own data properties once; inherited values and accessors are not assignments.
  // Hostile proxies can throw while inspecting their descriptors; reject them as well.
  let fields: Array<PropertyDescriptor | undefined>;
  try {
    if (Array.isArray(value)) return { ok: false, reason: "invalid_encounter_content" };
    fields = ["speciesId", "contentVersion", "visualSeed"].map((key) => Object.getOwnPropertyDescriptor(value, key));
  } catch {
    return { ok: false, reason: "invalid_encounter_content" };
  }
  if (fields.some((field) => !field || !("value" in field))) {
    return { ok: false, reason: "invalid_encounter_content" };
  }
  const [speciesId, contentVersion, visualSeed] = fields.map((field) => field!.value as unknown);
  const result = lookupMonsterDefinition(ruleset, contentVersion, speciesId);
  if (!result.ok) return result;
  if (typeof visualSeed !== "number" || !Number.isSafeInteger(visualSeed) || visualSeed < 0) {
    return { ok: false, reason: "invalid_visual_seed" };
  }
  const content: EncounterContent = Object.freeze({
    speciesId: result.definition.id, contentVersion: result.definition.contentVersion, visualSeed,
  });
  return { ok: true, content, definition: result.definition };
}
