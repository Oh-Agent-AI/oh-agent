/**
 * 选址知识登记表（CITY_NETWORK_FIRST_CODE_DESIGN §5 / 迁移批次 6a-1）：把 cityPlan.ts 里
 * 散落在 place()/snap()/地标抽签/十道挪动遍的每类用地知识收拢为一行数据。
 *
 * 本批**只做登记与导出**：place()/snap() 的行为一字不改（计划/场景基线哈希不变），表也不被
 * 生产路径消费——它是行为变更批（骨架后指派）接线时的唯一数据源：
 *   - placement 五类对应 access.ts 的五类候选生成器；
 *   - hard 判据清单引用现有谓词（footprint.isDry / wetCount / isDeepWater / nearBridgeEnd、
 *     cityPlan.clearsHighways、snap 的 landClearance/hill/间距判据），bound 写在 id 文档里；
 *   - soft 偏好清单对应 score.ts 的评分项与各遍的目标量；
 *   - passes 字段登记该类**现在**跑哪些挪动遍——行为变更批逐类删遍时的对照清单。
 *
 * 数值全部取自 cityPlan.ts 现行常量（place() 调用与地标 candidates 表）；守卫
 * scripts/verify-city-sitespec.mjs 用真实规划核对「每个被放置的 kind 都有行、半径一致」。
 */
import type { Vec2 } from "../cityLayout";
import type { PlanarAccessDeclaration } from "../models/siteAccess";
import { STATION_PLANAR_ACCESS } from "../models/publicSiteGeometry";

/** 选址五类（设计 §5：候选沿骨架道路或岸线生成）。 */
export type PlacementClass =
  | "inland-frontage"   // 内陆：贴最近主干道一侧（边缘离路肩 12，朝向与路对齐）
  | "shore"             // 岸边：贴回岸线（中心离岸 ≈ 0.7·radius，占地落水 ≤3 点）
  | "offshore-island"   // 海上岛：岸外 radius+40 深水圈 + 堤道连岸（帆形歌剧院）
  | "straddle-trunk"    // 跨路：骑在主干道中段上，开口轴沿路向（凯旋门）
  | "plaza";            // 广场：核心点即广场，四周是环岛（构造保证，不走候选）

/**
 * 名义锚点（结构意图，不是锁死坐标）：place()/candidates 的初始 nominal 公式。
 * around = core + 角(turn+offset)·distanceFactor·R；coast-rank/fraction/farthest =
 * 「离核心距离」排序的岸点；river-bank 仅在有河时生效、无河退回 around。
 */
export type NominalAnchor =
  | { at: "core" }
  | { at: "around"; turnOffset: number; distanceFactor: number }
  | { at: "river-bank"; alongZFactor: number; bankOffset: number; fallbackTurnOffset: number; fallbackDistanceFactor: number }
  | { at: "coast-near-core"; minCoreDistance: number; inwardInset: number }
  | { at: "coast-rank-from-core"; index: number; inwardFactor: number }
  | { at: "coast-fraction-from-core"; fraction: number; inwardFactor: number }
  | { at: "coast-farthest-from-core"; inwardFactor: number }
  | { at: "hillside"; insetFromHillLine: number };

/** 朝向规则（最终 yaw 由对应挪动遍覆写；这里登记初始值与覆写规则）。 */
export type YawRule =
  | "constant"        // 初始 yaw 保持不变（tv-tower 等）
  | "trunk-direction" // 跨路遍覆写：开口轴沿主干方向 atan2(dx, dz)
  | "shore-to-core"   // 港口：-atan2(shore-core)，码头朝海
  | "outward-from-core" // 歌剧院海上岛遍覆写：堤道向外
  | "coast-tangent"   // 摩天轮：岸线切向 + π/2
  | "coast-parallel"  // 庄园：平行水线（局部 +Z 拱廊朝海）
  | "hill-angle"      // pagoda 沿山脊方位
  | "road-facing";    // 修复遍覆写：正面朝最近路（station）

/**
 * 硬判据 id（bound 与现行出处）。全部引用现有谓词，不新造第二套口径：
 *  - snap-land-clearance    landClearance(q) ≥ clearance（snap 环搜；clearance = 行内 clearance 字段）
 *  - snap-hill-line         hillProj(q) < hillLine − clearance·0.5（snap 环搜）
 *  - snap-site-spacing      与已放置点保持 o.radius + radius + 20（snap 环搜）
 *  - dry-footprint          footprint.isDry：占地内外两圈 16 点全干（临街/跨路/干地遍）
 *  - land-clearance-r+4     landClearance ≥ radius + 4（临街/干地遍）
 *  - buildable-center       buildable(q)（临街/跨路遍）
 *  - trunk-clearance-r+8    到主干折线距离 ≥ radius + 8（临街/干地/内移遍）
 *  - trunk-clearance-r+4    到主干折线距离 ≥ radius + 4（内移/贴岸遍滑移）
 *  - clear-of-highways      cityPlan.clearsHighways（避高架/临街/贴岸遍；净空 5.25+半对角+1）
 *  - others-spacing-r+10    与其它用地 o.radius + radius + 10（跨路/临街遍）
 *  - others-spacing-plain   与其它用地 o.radius + radius（海上岛遍）
 *  - wet-budget-3           wetCount ≤ 3（只看地形水位；岸边内移遍）
 *  - wet-budget-3-riverbank wetCount(含河道 + 河岸带 14) ≤ 3（贴岸遍）
 *  - wet-budget-2           wetCount ≤ 2（贴岸遍的环形兜底搜索）
 *  - coast-distance-0.7r    coastDistance ≤ 0.7·radius（贴岸遍目标）
 *  - coast-distance-12      coastDistance ≤ 12（港口贴岸遍目标）
 *  - not-in-river           !inRiver（内移/贴岸遍滑移）
 *  - height-above-0.5       height > 0.5（内移/贴岸遍滑移）
 *  - not-near-bridge-end    footprint.nearBridgeEnd = false（内移/贴岸遍）
 *  - trunk-mid-segment      跨路遍：主干段 len ≥ 20 且中点通过 buildable/dry/避高架/间距
 *  - deep-water-ring        footprint.isDeepWater（海上岛遍：整圈 ≤ −0.8、不贴河岸 60 带）
 *  - causeway-land-dry      堤道陆地端 height ≥ 0.3（海上岛遍）
 *  - harbor-distance-120    海上岛离港口 ≥ o.radius + radius + 120、其它用地 +30（海上岛遍）
 *  - plaza-ring-by-construction 广场与环岛同心由构造保证（chooseCore 硬门 + 核心跟随），无独立遍
 */
export type HardCheckId =
  | "snap-land-clearance" | "snap-hill-line" | "snap-site-spacing"
  | "dry-footprint" | "land-clearance-r+4" | "buildable-center"
  | "trunk-clearance-r+8" | "trunk-clearance-r+4" | "clear-of-highways"
  | "others-spacing-r+10" | "others-spacing-plain"
  | "wet-budget-3" | "wet-budget-3-riverbank" | "wet-budget-2"
  | "coast-distance-0.7r" | "coast-distance-12" | "not-in-river" | "height-above-0.5"
  | "not-near-bridge-end" | "trunk-mid-segment" | "deep-water-ring"
  | "causeway-land-dry" | "harbor-distance-120" | "plaza-ring-by-construction";

/** 软偏好 id（不阻塞候选，只在合法候选间排序；对应 score.ts 评分项与各遍目标量）。 */
export type SoftPreferenceId =
  | "near-nominal-anchor"  // 名义位置承载城市结构（score.siteDrift）
  | "frontage-offset-r+12" // 贴主干一侧、边缘离路肩 12（临街遍；stationStadiumSetback ≤ 1.3r）
  | "face-road"            // 正面朝最近路（stationDoorFacesRoad / score.doorAlignment）
  | "hug-coast-0.7r"       // 中心离岸 ≈ 0.7·radius（score.shoreHug；港口 0.3）
  | "coast-parallel-face"  // 拱廊/门面平行水线（庄园/摩天轮的朝向规则）
  | "hillside-setting"     // 山脊带上的观景位（pagoda）
  | "spread-from-others";  // 地标两两散布（score.landmarkSpread）

export type SiteSpec = {
  kind: string;
  /** 现行占地半径（place()/candidates 常量；守卫核对与实际放置一致）。 */
  radius: number;
  placement: PlacementClass;
  /** Legacy placement default, not permission to move a bound/frozen instance. */
  mobility: "fixed" | "relocatable" | "dependency-bound";
  shoreTargetRadiusFactor?: number;
  /** Explicit supported access capability; absence is unsupported, not implicit geometry. */
  planarAccess?: PlanarAccessDeclaration;
  /** Legacy circular plot evidence only; not a physical model entrance declaration. */
  plotBoundaryAccess?: { schemaVersion: 1; type: "shore-plot-proxy"; gateOffset: number };
  /** 放置顺序：public 用地 = place() 调用序（0..5）；地标 = 100（先后由抽签/miami 固定位决定）。 */
  priority: number;
  /** 地标抽签权重（public 用地不抽签）。pagoda/villa 随生态带加权。 */
  drawWeight?: number | { byBiome: Record<string, number> };
  /** miami-coastal 档的固定放置说明（不进抽签池；双子塔/扭转塔二选一）。 */
  fixedInMiami?: string;
  nominalAnchor: NominalAnchor;
  /** snap 初始落位的离水净空：public 用地 = siteClearance(kind, radius)，地标 = candidates clearance。 */
  clearance: number;
  initialYaw: { value?: number; rule: YawRule };
  hard: HardCheckId[];
  soft: SoftPreferenceId[];
  /** 该类今天实际经过的放置/挪动遍（顺序即执行序；行为变更批的删遍对照清单）。 */
  passes: string[];
};

/** 表版本（改表 = 改选址契约，需在提交信息写明；守卫输出记录该值）。 */
export const SITING_TABLE_VERSION = 3;

/** 内陆公共用地/地标的共用 hard 集（snap 初始 + 避高架 + 临街 + 干地兜底）。 */
const INLAND_HARD: HardCheckId[] = [
  "snap-land-clearance", "snap-hill-line", "snap-site-spacing", "clear-of-highways",
  "buildable-center", "dry-footprint", "land-clearance-r+4", "trunk-clearance-r+8", "others-spacing-r+10",
];
/** 岸边类（灯塔/摩天轮/庄园；港口歌剧院另有专属判据）。 */
const SHORE_HARD: HardCheckId[] = [
  "snap-land-clearance", "snap-hill-line", "snap-site-spacing", "clear-of-highways",
  "wet-budget-3", "wet-budget-3-riverbank", "coast-distance-0.7r",
  "not-in-river", "height-above-0.5", "not-near-bridge-end", "trunk-clearance-r+4",
];

/**
 * 选址登记表（15 行 = 6 类公共用地 + 9 类地标候选；suspension-bridge 是「最长过河桥」的
 * 派生装饰（radius 0、不占用地），不走选址，故不登记）。
 */
export const SITE_SPECS: readonly SiteSpec[] = [
  {
    kind: "civic", radius: 44, placement: "plaza", mobility: "fixed", priority: 0,
    nominalAnchor: { at: "core" }, clearance: 58, initialYaw: { value: -0.15, rule: "constant" },
    hard: ["plaza-ring-by-construction", "snap-land-clearance", "snap-hill-line", "snap-site-spacing", "clear-of-highways"],
    soft: ["near-nominal-anchor"],
    passes: ["place/snap（广场 === 核心点；snap 推开时核心跟随）", "避高架遍", "修复:resiteViolatingSites（豁免：civic 不挪）"],
  },
  {
    kind: "tower", radius: 26, placement: "inland-frontage", mobility: "relocatable", priority: 1,
    nominalAnchor: { at: "around", turnOffset: 0.9, distanceFactor: 0.16 }, clearance: 40, initialYaw: { value: 0, rule: "constant" },
    hard: INLAND_HARD, soft: ["near-nominal-anchor", "frontage-offset-r+12"],
    passes: ["place/snap", "避高架遍", "临街遍", "干地遍", "修复:nudgeSitesOffRoads", "修复:resiteViolatingSites"],
  },
  {
    kind: "station", radius: 46, placement: "inland-frontage", mobility: "relocatable", priority: 2,
    planarAccess: STATION_PLANAR_ACCESS,
    nominalAnchor: { at: "around", turnOffset: 2.2, distanceFactor: 0.38 }, clearance: 60, initialYaw: { value: 0.12, rule: "road-facing" },
    hard: INLAND_HARD, soft: ["near-nominal-anchor", "frontage-offset-r+12", "face-road"],
    passes: ["place/snap", "避高架遍", "临街遍", "干地遍", "修复:frontStationsAndStadiums（拉到 0.85r + 正面朝路）", "修复:nudgeSitesOffRoads", "修复:resiteViolatingSites"],
  },
  {
    kind: "park", radius: 47, placement: "inland-frontage", mobility: "relocatable", priority: 3,
    nominalAnchor: { at: "river-bank", alongZFactor: 0.18, bankOffset: 60, fallbackTurnOffset: 3.6, fallbackDistanceFactor: 0.3 },
    clearance: 61, initialYaw: { value: 0, rule: "constant" },
    hard: INLAND_HARD, soft: ["near-nominal-anchor", "frontage-offset-r+12"],
    passes: ["place/snap", "避高架遍", "临街遍", "干地遍", "修复:nudgeSitesOffRoads", "修复:resiteViolatingSites"],
  },
  {
    kind: "stadium", radius: 49, placement: "inland-frontage", mobility: "relocatable", priority: 4,
    // Existing plot-gate proxy only; no invented model door or verified approach.
    planarAccess: { schemaVersion: 1, type: "ground-frontage", entrance: { id: "plot", outward: { x: 0, z: 1 } } },
    nominalAnchor: { at: "around", turnOffset: 4.8, distanceFactor: 0.45 }, clearance: 63, initialYaw: { value: 0.2, rule: "constant" },
    hard: INLAND_HARD, soft: ["near-nominal-anchor", "frontage-offset-r+12", "face-road"],
    passes: ["place/snap", "避高架遍", "临街遍", "干地遍", "修复:frontStationsAndStadiums", "修复:nudgeSitesOffRoads", "修复:resiteViolatingSites"],
  },
  {
    kind: "harbor", radius: 37, placement: "shore", mobility: "fixed", shoreTargetRadiusFactor: 0.3, priority: 5,
    plotBoundaryAccess: { schemaVersion: 1, type: "shore-plot-proxy", gateOffset: 6 },
    nominalAnchor: { at: "coast-near-core", minCoreDistance: 150, inwardInset: 10 }, clearance: 24,
    initialYaw: { rule: "shore-to-core" },
    hard: [...SHORE_HARD, "coast-distance-12"],
    soft: ["near-nominal-anchor", "hug-coast-0.7r"],
    passes: ["place/snap（离水仅 24：堆场近边正好落在水线上）", "避高架遍", "港口贴岸遍（最后执行：把被避让推进内陆的港口拉回离岸 ≤12）", "修复:resiteViolatingSites（豁免：harbor 不挪）"],
  },
  {
    kind: "tv-tower", radius: 16, placement: "inland-frontage", mobility: "relocatable", priority: 100, drawWeight: 2,
    nominalAnchor: { at: "around", turnOffset: 0.4, distanceFactor: 0.14 }, clearance: 20, initialYaw: { value: 0, rule: "constant" },
    hard: INLAND_HARD, soft: ["near-nominal-anchor", "frontage-offset-r+12", "spread-from-others"],
    passes: ["抽签/snap", "避高架遍", "临街遍", "干地遍", "修复:nudgeSitesOffRoads", "修复:resiteViolatingSites"],
  },
  {
    kind: "twin-towers", radius: 22, placement: "inland-frontage", mobility: "relocatable", priority: 100, drawWeight: 1,
    fixedInMiami: "downtown 高塔（与 twist-tower 二选一，另一个不进池）",
    nominalAnchor: { at: "around", turnOffset: 3.1, distanceFactor: 0.12 }, clearance: 20, initialYaw: { rule: "constant" },
    hard: INLAND_HARD, soft: ["near-nominal-anchor", "frontage-offset-r+12", "spread-from-others"],
    passes: ["抽签或 miami 固定/snap", "避高架遍", "临街遍", "干地遍", "修复:nudgeSitesOffRoads", "修复:resiteViolatingSites"],
  },
  {
    kind: "twist-tower", radius: 16, placement: "inland-frontage", mobility: "relocatable", priority: 100, drawWeight: 1,
    fixedInMiami: "downtown 高塔（与 twin-towers 二选一，另一个不进池）",
    nominalAnchor: { at: "around", turnOffset: 2.6, distanceFactor: 0.17 }, clearance: 20, initialYaw: { value: 0, rule: "constant" },
    hard: INLAND_HARD, soft: ["near-nominal-anchor", "frontage-offset-r+12", "spread-from-others"],
    passes: ["抽签或 miami 固定/snap", "避高架遍", "临街遍", "干地遍", "修复:nudgeSitesOffRoads", "修复:resiteViolatingSites"],
  },
  {
    kind: "arch", radius: 18, placement: "straddle-trunk", mobility: "dependency-bound", priority: 100, drawWeight: 1,
    nominalAnchor: { at: "around", turnOffset: 5.6, distanceFactor: 0.26 }, clearance: 20,
    initialYaw: { rule: "trunk-direction" },
    hard: ["snap-land-clearance", "snap-hill-line", "snap-site-spacing", "trunk-mid-segment",
      "buildable-center", "dry-footprint", "clear-of-highways", "others-spacing-r+10"],
    soft: ["near-nominal-anchor"],
    passes: ["抽签/snap", "避高架遍", "跨路遍（骑上最近主干中段，开口轴沿路向）", "修复:resiteViolatingSites（豁免：arch 不挪）"],
  },
  {
    kind: "sail-opera", radius: 34, placement: "offshore-island", mobility: "dependency-bound", priority: 100, drawWeight: 2,
    fixedInMiami: "海滨城固定锚点（不再靠抽签）",
    nominalAnchor: { at: "coast-rank-from-core", index: 3, inwardFactor: 0.1 }, clearance: 16,
    initialYaw: { rule: "outward-from-core" },
    hard: ["snap-land-clearance", "snap-hill-line", "snap-site-spacing", "wet-budget-3", "wet-budget-3-riverbank",
      "coast-distance-0.7r", "deep-water-ring", "causeway-land-dry", "harbor-distance-120", "others-spacing-plain"],
    soft: ["near-nominal-anchor", "hug-coast-0.7r", "spread-from-others"],
    passes: ["抽签或 miami 固定/snap（名义在岸上）", "避高架遍", "岸边内移遍", "贴岸遍", "海上岛遍（最终落位：岸外 r+40 深水 + 堤道）", "入口路（堤道桥 + 岸点接路）"],
  },
  {
    kind: "lighthouse", radius: 12, placement: "shore", mobility: "relocatable", priority: 100, drawWeight: 2,
    fixedInMiami: "海滨城固定锚点（不再靠抽签）",
    nominalAnchor: { at: "coast-farthest-from-core", inwardFactor: 0.04 }, clearance: 6, initialYaw: { value: 0, rule: "constant" },
    hard: SHORE_HARD, soft: ["near-nominal-anchor", "hug-coast-0.7r", "spread-from-others"],
    passes: ["抽签或 miami 固定/snap", "避高架遍", "岸边内移遍", "贴岸遍", "入口路（兜底直连常服务岬角灯塔）"],
  },
  {
    kind: "ferris-wheel", radius: 26, placement: "shore", mobility: "relocatable", priority: 100, drawWeight: 2,
    fixedInMiami: "海滨城固定锚点（不再靠抽签）",
    nominalAnchor: { at: "coast-fraction-from-core", fraction: 0.45, inwardFactor: 0.08 }, clearance: 14,
    initialYaw: { rule: "coast-tangent" },
    hard: SHORE_HARD, soft: ["near-nominal-anchor", "hug-coast-0.7r", "coast-parallel-face", "spread-from-others"],
    passes: ["抽签或 miami 固定/snap", "避高架遍", "岸边内移遍", "贴岸遍", "入口路"],
  },
  {
    kind: "pagoda", radius: 18, placement: "inland-frontage", mobility: "relocatable", priority: 100,
    drawWeight: { byBiome: { eastasian: 5, default: 1 } },
    nominalAnchor: { at: "hillside", insetFromHillLine: 80 }, clearance: 18,
    initialYaw: { rule: "hill-angle" },
    hard: INLAND_HARD, soft: ["near-nominal-anchor", "hillside-setting", "frontage-offset-r+12"],
    passes: ["抽签/snap（hillDir·(hillLine−80)）", "避高架遍", "临街遍", "干地遍", "修复:nudgeSitesOffRoads", "修复:resiteViolatingSites"],
  },
  {
    kind: "villa-complex", radius: 34, placement: "shore", mobility: "relocatable", priority: 100,
    drawWeight: { byBiome: { tropical: 4, default: 1 } },
    fixedInMiami: "海滨城固定锚点（与帆顶剧院 shoreOrder[3]/[5] 错开）",
    nominalAnchor: { at: "coast-rank-from-core", index: 5, inwardFactor: 0.08 }, clearance: 16,
    initialYaw: { rule: "coast-parallel" },
    hard: SHORE_HARD, soft: ["near-nominal-anchor", "hug-coast-0.7r", "coast-parallel-face", "spread-from-others"],
    passes: ["抽签或 miami 固定/snap", "避高架遍", "岸边内移遍", "贴岸遍", "入口路（跨河时桥段 + 切 T 口）"],
  },
];

/** 按种类查行（守卫与行为变更批的入口）。 */
export function specByKind(kind: string): SiteSpec | undefined {
  return SITE_SPECS.find((row) => row.kind === kind);
}

/** The registry is an adapter. Core movement permission follows declarations
 * and current bindings, not a special list of building names. */
export function canRelocateGroundSite(site: { kind: string; access?: unknown; shore?: unknown }, spec = specByKind(site.kind)): boolean {
  return !site.access && !site.shore && spec?.mobility === "relocatable";
}

/**
 * 临水类 = cityPlan 的 SHORE_SITE_KINDS（含海上岛 sail-opera：它的内移/贴岸/堤道语义都按岸边类跑）。
 * 6b 起 cityPlan 的 SHORE_SITE_KINDS / STRADDLE / SHORE_BOUND 由这里派生（值不变，基线哈希证明）。
 */
export function coastalSitingKinds(): Set<string> {
  return new Set(SITE_SPECS.filter((row) => row.placement === "shore" || row.placement === "offshore-island").map((row) => row.kind));
}

/** 跨路类 = cityPlan 的 STRADDLE（凯旋门）。 */
export function straddleSitingKinds(): Set<string> {
  return new Set(SITE_SPECS.filter((row) => row.placement === "straddle-trunk").map((row) => row.kind));
}

/** 临街遍的豁免类 = SHORE_BOUND ∪ STRADDLE（岸边对象/广场/跨路门不贴主干）。 */
export function frontageExemptKinds(): Set<string> {
  const kinds = coastalSitingKinds();
  for (const kind of straddleSitingKinds()) kinds.add(kind);
  for (const row of SITE_SPECS) if (row.placement === "plaza") kinds.add(row.kind);
  return kinds;
}

/** 岸线锚点求值（行为变更批用；本批只登记——公式与 place()/candidates 逐字对应，无随机）。 */
export function nominalAnchorPoint(
  spec: SiteSpec,
  world: {
    core: Vec2; R: number; turn: number;
    coast: Vec2[];
    hasRiver: boolean;
    riverX: (z: number) => number; riverWidth: (z: number) => number;
    hillDir: Vec2; hillLine: number;
  },
): Vec2 {
  const a = spec.nominalAnchor;
  const around = (turnOffset: number, distanceFactor: number): Vec2 => ({
    x: world.core.x + Math.cos(world.turn + turnOffset) * distanceFactor * world.R,
    z: world.core.z + Math.sin(world.turn + turnOffset) * distanceFactor * world.R,
  });
  if (a.at === "core") return { x: world.core.x, z: world.core.z };
  if (a.at === "around") return around(a.turnOffset, a.distanceFactor);
  if (a.at === "river-bank") {
    if (!world.hasRiver) return around(a.fallbackTurnOffset, a.fallbackDistanceFactor);
    const z = world.core.z + a.alongZFactor * world.R;
    return { x: world.riverX(z) + world.riverWidth(z) + a.bankOffset, z };
  }
  if (a.at === "hillside") return { x: world.hillDir.x * (world.hillLine - a.insetFromHillLine), z: world.hillDir.z * (world.hillLine - a.insetFromHillLine) };
  const byDistance = [...world.coast].sort((p, q) => Math.hypot(p.x - world.core.x, p.z - world.core.z) - Math.hypot(q.x - world.core.x, q.z - world.core.z));
  const inwardFrom = (shore: Vec2, amount: number): Vec2 => ({ x: shore.x + (world.core.x - shore.x) * amount, z: shore.z + (world.core.z - shore.z) * amount });
  if (a.at === "coast-near-core") {
    const shore = byDistance.find((p) => Math.hypot(p.x - world.core.x, p.z - world.core.z) >= a.minCoreDistance) ?? byDistance[0];
    const toCore = Math.max(1, Math.hypot(world.core.x - shore.x, world.core.z - shore.z));
    const inset = Math.min(a.inwardInset, toCore * 0.5);
    return { x: shore.x + ((world.core.x - shore.x) / toCore) * inset, z: shore.z + ((world.core.z - shore.z) / toCore) * inset };
  }
  if (a.at === "coast-rank-from-core") return inwardFrom(byDistance[Math.min(byDistance.length - 1, a.index)], a.inwardFactor);
  if (a.at === "coast-fraction-from-core") return inwardFrom(byDistance[Math.floor(byDistance.length * a.fraction)], a.inwardFactor);
  return inwardFrom(byDistance[byDistance.length - 1], a.inwardFactor); // coast-farthest-from-core
}
