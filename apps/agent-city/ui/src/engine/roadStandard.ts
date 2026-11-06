/**
 * 道路标准表（唯一来源；docs/CITY_WORLD_PRECISION_AND_SIZE_STANDARD_SPEC.md 第二部分）。
 *
 * 为什么要有这张表：生成结果事实上只有 5 / 8 / 12 三档（10 / 16 / 24 m，15 座规划城 + 10 座完整城实测，没出现过第四种），
 * 但这套标准散在三处互不引用的定义（worldScale 注释、connect.roadWidthOf、修复工具 ROAD_SPEC）和 76 处宽度字面量里，
 * 下游靠 `width >= 8` / `width >= 12` 区间猜等级。补丁入口又只要求 width > 0——一条宽 4.2 的路会被所有区间判断默默当成支路。
 * 现在：宽度只从这里取，等级由宽度**严格**反查（不再用区间猜），非标宽度在补丁入口明确拒绝（non-standard-width）。
 *
 * `RoadEdge.kind` 保持两级（local / arterial）：次干道记成 arterial，三级等级由宽度唯一推出——不改类型，快照与基线不动。
 * 纯常量模块（L1）：不依赖 three；规划层、渲染层、修复工具都能引用。
 */

export type RoadClassId = "local" | "collector" | "arterial";
export type RoadClassSpec = Readonly<{
  id: RoadClassId;
  /** 世界单位（1 = 2 m）；整个规划/布局/修复代码里唯一允许出现路宽字面量的地方。 */
  width: number;
  kind: "local" | "arterial";
  /** 修复工具的路型名（滨海大道 = 主干道 + purpose: "waterfront"，不是独立等级）。 */
  repairType: "local" | "secondary" | "main";
  label: Readonly<{ zh: string; en: string }>;
  /** 人行道每侧宽度（= cityRoadJunctions.SIDEWALK_BAND，三档相同，集中登记在这里）。 */
  sidewalk: number;
  // —— 第二期才填，本期为 null；填之前必须先有测量和验收集证据（同 VALIDATION_CONFIG 的规矩）——
  /** 路面纵坡上限。 */
  maxGrade: number | null;
  /** 桥头缓和段最短长度。 */
  bridgeTransition: number | null;
  /** 桥轴与所接道路的最大斜交角（度）。 */
  maxBridgeSkewDeg: number | null;
}>;

const SIDEWALK = 1.8;
const spec = (id: RoadClassId, width: number, kind: RoadClassSpec["kind"], repairType: RoadClassSpec["repairType"], zh: string, en: string): RoadClassSpec =>
  Object.freeze({ id, width, kind, repairType, label: Object.freeze({ zh, en }), sidewalk: SIDEWALK, maxGrade: null, bridgeTransition: null, maxBridgeSkewDeg: null });

/** 地面道路三档，按宽度从窄到宽（atLeast 依赖这个顺序）。 */
export const ROAD_CLASSES: readonly RoadClassSpec[] = Object.freeze([
  spec("local", 5, "local", "local", "支路", "Local road"),
  spec("collector", 8, "arterial", "secondary", "次干道", "Collector"),
  spec("arterial", 12, "arterial", "main", "主干道", "Arterial"),
]);

const BY_ID = new Map(ROAD_CLASSES.map((item) => [item.id, item] as const));
export function roadClassSpec(id: RoadClassId): RoadClassSpec {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown road class: ${id}`);
  return found;
}

/** 比较宽度时的容差：只吸收 JSON 往返的舍入，不是「差不多就算」。 */
const WIDTH_EPSILON = 1e-9;
/** 严格反查：只认三档标准宽度，其余返回 null（不再用 >= 8 / >= 12 区间猜）。 */
export function roadClassOfWidth(width: number): RoadClassId | null {
  for (const item of ROAD_CLASSES) if (Math.abs(item.width - width) <= WIDTH_EPSILON) return item.id;
  return null;
}
export function isStandardRoadWidth(width: number): boolean { return roadClassOfWidth(width) !== null; }

const RANK: Readonly<Record<RoadClassId, number>> = { local: 0, collector: 1, arterial: 2 };
/**
 * 等级比较，替代散落的 `width >= 8` / `width >= 12`。语义是「不低于这一档」：非标宽度按它够得着的最高一档算
 * （与原区间判断在三档上逐一等价，且不把一条宽 10 的非标路突然判成支路——非标宽度由补丁入口与验收脚本拦，不在这里改语义）。
 */
export function atLeast(edge: Readonly<{ width: number }>, id: RoadClassId): boolean {
  return edge.width >= roadClassSpec(id).width - WIDTH_EPSILON;
}
/** 宽度 → 路段 kind（两级）。非标宽度按「不低于次干道即 arterial」处理，与原 `width >= 8 ? "arterial" : "local"` 一致。 */
export function kindOfWidth(width: number): "local" | "arterial" {
  const id = roadClassOfWidth(width);
  return id ? roadClassSpec(id).kind : atLeast({ width }, "collector") ? "arterial" : "local";
}
/** 规划层的等级（主干 / 次干 / 支路）→ 宽度：connect.roadWidthOf 等处 `primary ? 12 : arterial ? 8 : 5` 的唯一写法。 */
export function roadWidthFor(id: RoadClassId): number { return roadClassSpec(id).width; }

/** 区界高架桥面宽（10.5 = 21 m）：结构等级 expressway；顶面 9.1 = EXPRESSWAY_DECK_Y 8.2 + 厚 0.9（structureProfiles）。 */
export const EXPRESSWAY_DECK_WIDTH = 10.5;
/** 修复工具画的高架在「压到建筑」判定与推土机里按桥面宽 + 1 的净空当路段算（planRoadRules.viaductEdges）；不进路网。 */
export const REPAIR_VIADUCT_EXTRA = 1;

/** 路段的宽度是标准档、且 kind 与该档一致（connect.roundaboutRebuildable / snapJunctions 的「规整路段」判定）。 */
export function isStandardEdge(edge: Readonly<{ width: number; kind: "local" | "arterial" }>): boolean {
  const id = roadClassOfWidth(edge.width);
  return id !== null && roadClassSpec(id).kind === edge.kind;
}
