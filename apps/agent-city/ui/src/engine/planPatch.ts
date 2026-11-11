/**
 * 规划修复补丁层（docs/CITY_PLAN_MANUAL_REPAIR_SPEC.md §4/§5，M1 首批）。
 *
 * 定位：layoutCity 之后的纯后处理——生成器（createCityPlan/layoutCity，city-opt 分支的地盘）
 * 每次数据刷新重算整张图，用户编辑表达为「种子生成结果之上的覆写补丁」：补丁按稳定 id
 * 引用对象（session_ref / parcelId / roadNode 坐标 id），套用确定性、顺序无关。
 *
 * 契约（verify-plan-patch.mjs 守卫）：
 *   - 同一底层布局 + 同一补丁 → 逐字段相等；buildingMoves/suppressedContext 条目序无关，roadOps 按日志顺序；
 *   - 补丁只套在**未打补丁的底层布局**上（CityEngine 每次 layoutCity 重建后重新套）。不承诺叠套：
 *     节点移动/删路改写了 id，第二次套用时原 id 已不存在——曾在注释里声称「幂等」，
 *     实测叠套会报 missing-node/missing-edge，契约收窄为如实的样子。buildingMoves 叠套仍是 no-op
 *     （layoutCity 的 pins 先把楼放到目标地块，套用时命中「已在目标」分支）；
 *   - 失效条目（对象不存在 / 边锁定 / 地块被占 / 节点撞车 / 跨档位）不套用、进 stale 清单如实上报，不静默吞；
 *   - 桥面不能单独改：擦桥面 = 擦整座桥（`bridgeChain`，登记同步撤掉，悬索桥的塔与缆一起拆）；桥面不能改路型、
 *     连着桥面的路口不能拖（SPEC §15，2026-10-21 放开「整座擦」）。
 *
 * **道路编辑是操作日志（roadOps），按顺序重放**：每个操作引用「执行当时的当前 id」。节点/路段 id 全由坐标推出
 * （`x:z` / `from/to`），所以同一底层布局 + 同一日志的重放是确定的，不需要把 id 翻回原始 id。
 * 曾经 nodeMoves/edgeDrops 两张表按原始 id 存——画路要把原路段从中间拆成两半，拆出来的新 id 在底层布局里不存在，
 * 「翻回原始 id」无从谈起；日志形式也让撤销自然（弹出最后一个操作）。代价：道路操作**有顺序**，
 * 不再满足「条目顺序倒排结果不变」（buildingMoves/suppressedContext 仍是集合，顺序无关）。
 *
 * 范围：buildingMoves 全量 + 道路日志（删/移/加）的套用与锁定规则；
 * suppressedContext（M3）仅透传过滤。plan 级约束复用（体检的另一半）等 city-opt 的
 * constraints.ts 导出稳定后再接（SPEC §0 重估条款）。
 */
import { kindOfWidth, isStandardRoadWidth } from "./roadStandard";
import { hashSeed, type CityBuilding, type CityModel } from "../cityModel";
import { clearsHighways, roadNodeId, segmentDistance } from "./cityPlan";
import type { CityLayout, RoadEdge, RoadNode, Vec2 } from "./cityLayout";
import { CITY_GENERATOR_VERSION } from "./generatorVersion";
import { applySiteOps, type SiteOp } from "./planSites";
import { regradeRoadLandings } from "./surface/roadLandingGrading";
import { applyTerrainOps, TERRAIN_OP_LIMITS, terrainOpProblem, terrainOpsTouch, type TerrainOp } from "./surface/terrainOps";
import { bridgeChain, buildingRect, clearanceRoads, edgeLocked, parcelIndex, quantize, rectClearOfEdges, rectClearOfRoads, rectsOverlap, reservedParcelIds, reservedParcelIdsShared, slotIndex, VIADUCT_DECK_WIDTH, wetSpan, curvePoints } from "./planGeometry";

export type { SiteOp } from "./planSites";
export type { TerrainOp } from "./surface/terrainOps";

export const PLAN_PATCH_VERSION = 1;

export { CITY_GENERATOR_VERSION } from "./generatorVersion";

/** 补丁写下时的生成器版本。旧存档没有这一项——它们都写于引入版本戳之前的同一代生成器，按 1 读。 */
export const patchGeneratorVersion = (patch: Pick<PlanPatchV1, "generatorVersion">): number => patch.generatorVersion ?? 1;

/** 补丁的 id 是否还对得上当前生成器：档位与生成器版本都一致。不一致时整份不套用，先重定位（planRemap.ts）。 */
export const patchMatchesLayout = (patch: Pick<PlanPatchV1, "scaleTier" | "generatorVersion">, scaleTier: number): boolean =>
  patch.scaleTier === scaleTier && patchGeneratorVersion(patch) === CITY_GENERATOR_VERSION;

/** 道路操作日志的一项。node/edge 是**执行当时**的当前 id。 */
export type RoadOp =
  /** anchor：写下时被引用对象的位置（路段折线中点 / 路口坐标），跨档重定位用（路线图 SPEC P0-2）。旧存档没有，按 id 里的坐标推。 */
  | { t: "drop"; edge: string; anchor?: Vec2 }
  | { t: "move"; node: string; to: Vec2; anchor?: Vec2 }
  /** 新增一段直路。端点吸附规则见 resolveEndpoint：靠近路口 → 接到路口；落在路段中间 → 把该路段拆成两半；否则新建路口。
   *  purpose=waterfront：滨海大道（与生成器的环岛滨海路同级，沿它铺滨海景观带）。
   *  起点是一条路的尽头且新路拐弯时，重放会在拐角处自动倒圆（filletAt，SPEC §17.3）。 */
  /** via：弧线经过点（二次贝塞尔，planGeometry.curvePoints）；缺省是直路。弧线不倒圆、不架桥（过河用直线）。 */
  | { t: "add"; from: Vec2; to: Vec2; width: number; purpose?: "waterfront"; via?: Vec2 }
  /** 改已有路段的路型（路线图 P1-4）：宽度 5/8/12 与用途（purpose 缺省 = 普通路，写了 waterfront = 滨海大道）。
   *  记的是**目标状态**不是增量，重放幂等；同一条路的一整段（run）在编辑器里一步写成几条、同一步撤销。桥面不能改。 */
  | { t: "restyle"; edge: string; width: number; purpose?: "waterfront"; anchor?: Vec2 };

/**
 * 高架操作日志（SPEC §17.2）。高架（layout.highways）是独立于地面路网的折线：渲染层两端各 90 平滑落地成匝道、
 * 中段架在 8.2 高，桥墩可以立在河里——所以它也是本期唯一能过河的路。
 *   add：一条新高架（≥ 2 点）；首/尾点落在已有高架的开口端附近就接上去，接缝处不会凭空多出两段匝道。
 *   cut：在 at 处切掉一截（最长 VIADUCT_CUT），一条高架断成两条，各自在断口落地成匝道。
 */
export type HighwayOp = { t: "add"; points: Vec2[] } | { t: "cut"; at: Vec2 };

export type PlanPatchV1 = {
  version: 1;
  seed: number;
  /** 补丁写下时的规模档位。跨档（岛放大、地块与节点重排）后按坐标重定位到新档（planRemap.ts，路线图 SPEC P0-2）；
   *  未重定位前套用时整份报 tier-changed。 */
  scaleTier: number;
  /** 写下时的生成器版本（generatorVersion.ts）。路口/路段/地块 id 是「某版生成器在某档」的产物，版本不符同跨档：
   *  先重定位再套用。旧存档没有，按 1 读（patchGeneratorVersion）。 */
  generatorVersion?: number;
  /** 写下时的岛半径（重定位的缩放比 = 新半径 / 旧半径）。旧存档没有，退回 √(新档/旧档)。 */
  islandRadius?: number;
  updatedAt: number;
  /** 道路操作日志，按顺序重放。 */
  roadOps: RoadOp[];
  /** 高架操作日志（可缺省，旧存档没有这一项）。 */
  highwayOps?: HighwayOp[];
  /** 设施（公共设施/花园/城区地标/背景楼）操作日志，按顺序重放，带位置校验（docs/…SPEC §14）。 */
  siteOps: SiteOp[];
  /** 会话楼 id（session_ref）→ 新地块 id（Parcel.id）。 */
  buildingMoves: Record<string, string>;
  /** 移楼目标地块写下时的中心（跨档重定位用）。不进指纹——锚点不影响重放。 */
  moveAnchors?: Record<string, Vec2>;
  /** 压制的背景楼 id（"context:<parcelId>"，M3）。 */
  suppressedContext: string[];
  /** 玩家土方（docs/CITY_REPAIR_TERRAIN_GRADING_SPEC.md），按顺序叠加；可缺省，旧存档没有这一项。 */
  terrainOps?: TerrainOp[];
};

/** 条目无法套用的原因——诚实降级：丢弃 + 上报，绝不猜测替代目标。 */
export type PatchStaleEntry = {
  kind: "building-move" | "road-drop" | "road-move" | "road-add" | "road-restyle" | "site-remove" | "site-move" | "context-suppress" | "highway-add" | "highway-cut" | "terrain-op";
  id: string;
  reason: "non-standard-width" | "missing-node" | "missing-edge" | "missing-parcel" | "unknown-building" | "missing-context" | "locked-edge" | "parcel-occupied" | "node-collision" | "tier-changed" | "generator-changed" | "edge-exists" | "degenerate" | "unknown-site" | "site-changed" | "missing-target" | "target-occupied" | "site-blocked" | "missing-highway" | "road-in-water"
    | "terrain-invalid" | "terrain-too-large" | "terrain-ramp-too-short" | "terrain-ramp-too-steep" | "terrain-on-water" | "terrain-too-many";
  detail: string;
};

export type PatchedLayout = { layout: CityLayout; stale: PatchStaleEntry[]; patchHash: string };

export function emptyPlanPatch(seed: number, scaleTier: number): PlanPatchV1 {
  return { version: PLAN_PATCH_VERSION, seed, scaleTier, generatorVersion: CITY_GENERATOR_VERSION, updatedAt: 0, roadOps: [], siteOps: [], buildingMoves: {}, suppressedContext: [] };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * 存档读回的宽容校验：顶层/必填字段不对 → null（整条丢弃）；集合字段里形状不对的单个条目丢弃。
 * 曾经用 `{...candidate, 默认值, ...candidate}` 补默认值——默认值被原值覆盖，存档里一个
 * `edgeDrops: null` 就让 applyPlanPatch 在 `[...null]` 处抛异常、整座城画不出来（tsc 也报 TS2783）。
 */
export function coercePlanPatch(raw: unknown): PlanPatchV1 | null {
  if (!isRecord(raw) || raw.version !== PLAN_PATCH_VERSION || !isFiniteNumber(raw.seed) || !isFiniteNumber(raw.scaleTier)) return null;
  const point = (value: unknown): Vec2 | null => (isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.z) ? { x: value.x, z: value.z } : null);
  const roadOps: RoadOp[] = [];
  // 早期开发版把道路编辑存成 edgeDrops/nodeMoves 两张表（原始 id）：先删后移，等价转成日志。
  if (Array.isArray(raw.edgeDrops)) for (const edge of raw.edgeDrops) if (typeof edge === "string") roadOps.push({ t: "drop", edge });
  if (isRecord(raw.nodeMoves)) for (const [node, to] of Object.entries(raw.nodeMoves).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const target = point(to); if (target) roadOps.push({ t: "move", node, to: target });
  }
  if (Array.isArray(raw.roadOps)) for (const op of raw.roadOps) {
    if (!isRecord(op)) continue;
    const anchor = point(op.anchor);
    if (op.t === "drop" && typeof op.edge === "string") roadOps.push({ t: "drop", edge: op.edge, ...(anchor ? { anchor } : {}) });
    else if (op.t === "move" && typeof op.node === "string") { const to = point(op.to); if (to) roadOps.push({ t: "move", node: op.node, to, ...(anchor ? { anchor } : {}) }); }
    else if (op.t === "restyle" && typeof op.edge === "string" && isFiniteNumber(op.width) && op.width > 0) roadOps.push({ t: "restyle", edge: op.edge, width: op.width, ...(op.purpose === "waterfront" ? { purpose: "waterfront" as const } : {}), ...(anchor ? { anchor } : {}) });
    else if (op.t === "add" && isFiniteNumber(op.width)) { const from = point(op.from); const to = point(op.to); const via = point(op.via); if (from && to) roadOps.push({ t: "add", from, to, width: op.width, ...(op.purpose === "waterfront" ? { purpose: "waterfront" as const } : {}), ...(via ? { via } : {}) }); }
  }
  const highwayOps: HighwayOp[] = [];
  if (Array.isArray(raw.highwayOps)) for (const op of raw.highwayOps) {
    if (!isRecord(op)) continue;
    if (op.t === "add" && Array.isArray(op.points)) { const points = op.points.map(point).filter((q): q is Vec2 => !!q); if (points.length >= 2) highwayOps.push({ t: "add", points }); }
    else if (op.t === "cut") { const at = point(op.at); if (at) highwayOps.push({ t: "cut", at }); }
  }
  const terrainOps: TerrainOp[] = [];
  const height = (value: unknown): (Vec2 & { h: number }) | null => { const p = point(value); return p && isRecord(value) && isFiniteNumber(value.h) ? { ...p, h: value.h } : null; };
  if (Array.isArray(raw.terrainOps)) for (const op of raw.terrainOps) {
    if (!isRecord(op) || !isFiniteNumber(op.falloff)) continue;
    if (op.t === "pad") { const at = point(op.at); if (at && isFiniteNumber(op.radius) && isFiniteNumber(op.height)) terrainOps.push({ t: "pad", at, radius: op.radius, falloff: op.falloff, height: op.height }); }
    else if (op.t === "ramp") { const from = height(op.from); const to = height(op.to); if (from && to && isFiniteNumber(op.width)) terrainOps.push({ t: "ramp", from, to, width: op.width, falloff: op.falloff }); }
  }
  const siteOps: SiteOp[] = [];
  if (Array.isArray(raw.siteOps)) for (const op of raw.siteOps) {
    if (!isRecord(op) || typeof op.id !== "string") continue;
    const at = point(op.at) ?? undefined;
    const cls = typeof op.cls === "string" ? { cls: op.cls } : {};
    if (op.t === "remove") siteOps.push({ t: "remove", id: op.id, ...(at ? { at } : {}), ...cls });
    else if (op.t === "move" && typeof op.to === "string") { const toAnchor = point(op.toAnchor); siteOps.push({ t: "move", id: op.id, to: op.to, ...(at ? { at } : {}), ...(toAnchor ? { toAnchor } : {}), ...cls }); }
  }
  const buildingMoves: Record<string, string> = {};
  if (isRecord(raw.buildingMoves)) for (const [id, parcelId] of Object.entries(raw.buildingMoves)) {
    if (typeof parcelId === "string") buildingMoves[id] = parcelId;
  }
  const moveAnchors: Record<string, Vec2> = {};
  if (isRecord(raw.moveAnchors)) for (const [id, at] of Object.entries(raw.moveAnchors)) { const p = point(at); if (p && id in buildingMoves) moveAnchors[id] = p; }
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  return {
    version: PLAN_PATCH_VERSION, seed: raw.seed, scaleTier: raw.scaleTier,
    updatedAt: isFiniteNumber(raw.updatedAt) ? raw.updatedAt : 0,
    roadOps, siteOps, buildingMoves, suppressedContext: strings(raw.suppressedContext),
    ...(highwayOps.length ? { highwayOps } : {}),
    ...(terrainOps.length ? { terrainOps } : {}),
    // 只保留正整数；坏值按缺省（=1）读，不能因为一个错型字段把整份补丁判成「别的生成器写的」。
    ...(Number.isInteger(raw.generatorVersion) && (raw.generatorVersion as number) >= 1 ? { generatorVersion: raw.generatorVersion as number } : {}),
    ...(isFiniteNumber(raw.islandRadius) && raw.islandRadius > 0 ? { islandRadius: raw.islandRadius } : {}),
    ...(Object.keys(moveAnchors).length ? { moveAnchors } : {}),
  };
}

/** 补丁指纹：道路日志按顺序、其余键排序后规范序列化 → FNV；进 activityKey 触发静态城缓存重画。 */
export function hashPlanPatch(patch: PlanPatchV1): string {
  const canonical = JSON.stringify({
    version: patch.version,
    scaleTier: patch.scaleTier,
    roadOps: patch.roadOps,
    // 只在有高架操作时进指纹：没有高架编辑的旧补丁指纹不变（activityKey 不变，静态城缓存不白白重画）。
    ...(patch.highwayOps?.length ? { highwayOps: patch.highwayOps } : {}),
    // 同理：只有非 1 的生成器版本进指纹——引入版本戳前后的同一份补丁指纹不变，静态城缓存不白白重画。
    ...(patchGeneratorVersion(patch) !== 1 ? { generatorVersion: patchGeneratorVersion(patch) } : {}),
    siteOps: patch.siteOps,
    buildingMoves: Object.keys(patch.buildingMoves).sort().map((id) => [id, patch.buildingMoves[id]]),
    suppressedContext: [...patch.suppressedContext].sort(),
    // 同理：只在有平整操作时进指纹——没有平整的补丁指纹与引入土方前逐字相同。
    ...(patch.terrainOps?.length ? { terrainOps: patch.terrainOps } : {}),
  });
  return String(Math.round(hashSeed(canonical) * 1e9));
}


export { bridgeChain, bridgeChainPolyline, deckUnderLandmark, edgeLocked, clearanceRoads, parcelIndex, reservedParcelIds, reservedParcelIdsShared, slotIndex, rectClearOfEdges, rectClearOfRoads, edgesNear, buildingRect, rectsOverlap, quantize, VIADUCT_DECK_WIDTH, VIADUCT_RAMP, type BuildingRect } from "./planGeometry";

/** 编辑前校验（SPEC §7.3）：blockers 非空必须拒绝提交；warnings 只提示。
 *  `layout` 是当前 effective 布局（已套补丁），校验看的是用户眼前的城市。 */
export function validateBuildingMove(layout: CityLayout, model: CityModel, patch: PlanPatchV1, buildingId: string, targetParcelId: string): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const homeId = slotIndex(layout).homeOf.get(buildingId);
  const home = homeId === undefined ? undefined : layout.districts.find((district) => district.id === homeId);
  const building = buildingIndex(model).get(buildingId);
  if (!home || !building) return { blockers: ["unknown-building"], warnings };
  const parcels = parcelIndex(layout);
  const target = parcels.get(targetParcelId);
  if (!target) return { blockers: ["missing-parcel"], warnings };
  const ownParcelId = home.slots.get(buildingId)?.id;
  const reserved = reservedParcelIdsShared(layout, patch.suppressedContext);
  // 自己当前所在地块不算被占（原地重放、换过去再换回来都合法）。
  const occupied = (reserved.has(targetParcelId) && ownParcelId !== targetParcelId)
    // 补丁里已有别的楼要搬去同一地块 → 冲突。
    || Object.entries(patch.buildingMoves).some(([id, parcelId]) => id !== buildingId && parcelId === targetParcelId);
  if (occupied) blockers.push("parcel-occupied");
  if (!rectClearOfRoads(layout, target, 0.5)) blockers.push("building-over-road");
  if (!layout.terrain.buildable(target.x, target.z)) blockers.push("not-buildable");
  else if (layout.terrain.slope(target.x, target.z) > 0.55) blockers.push("steep-slope");
  if (!clearsHighways(target, target.width, target.depth, layout.highways)) blockers.push("highway-clearance");
  // buildingOverlap（SPEC §7.3 硬阻止）：新位置的占地矩形与任何别的会话楼相交。
  // 全城落位表与楼索引按布局/模型缓存（P0-1）：曾每次调用重建 4000 栋的 Map 并逐城区展开 slots。
  const buildingsById = buildingIndex(model);
  const rect = buildingRect(building, target);
  const { slots, districtOfBlock } = slotIndex(layout);
  const overlaps = slots.some(([id, slot]) => {
    if (id === buildingId || Math.abs(slot.x - target.x) >= 60 || Math.abs(slot.z - target.z) >= 60 || Math.hypot(slot.x - target.x, slot.z - target.z) >= 60) return false;
    const other = buildingsById.get(id);
    return !!other && rectsOverlap(rect, buildingRect(other, slot));
  });
  if (overlaps) blockers.push("building-overlap");
  // 软警告：跨小区（目标地块的街区被别的城区占用）——楼仍属原城区，只是搬出了自己的小区。
  const owner = districtOfBlock.get(target.blockId);
  if (owner && owner !== home.id) warnings.push("cross-district");
  return { blockers, warnings };
}

const buildingIndexCache = new WeakMap<CityModel, { list: CityModel["buildings"]; index: Map<string, CityBuilding> }>();
/** 模型里的楼按 id 索引（按模型缓存；模型对象不可变）。重复 id 取第一个，与 Array.find 一致。 */
export function buildingIndex(model: CityModel): ReadonlyMap<string, CityBuilding> {
  const hit = buildingIndexCache.get(model);
  if (hit && hit.list === model.buildings) return hit.index;
  const index = new Map<string, CityBuilding>();
  for (const building of model.buildings) if (!index.has(building.id)) index.set(building.id, building);
  buildingIndexCache.set(model, { list: model.buildings, index });
  return index;
}

/** layoutCity 的落位钉子（SPEC §5 / §12.4）：补丁里的移楼在**落位阶段**生效，而不是只做后处理。
 *  只做后处理时，底层布局不知道楼搬走了——新家所在的空置街区支路已被 growWithBuildings 剪掉
 *  （楼落在没有路的街区），老家街区却因「仍有楼」保住了路；数据刷新后目标地块还可能被分给新会话，
 *  补丁随即以 parcel-occupied 失效、用户的修改悄悄消失。layoutCity 只在档位一致时认钉子。 */
export function layoutPinsFor(patch: PlanPatchV1 | null | undefined): { scaleTier: number; parcels: ReadonlyMap<string, string> } | null {
  if (!patch || !Object.keys(patch.buildingMoves).length) return null;
  // 别的生成器版本写下的地块 id 指向的是另一张地图上的位置：钉子整份不认（与跨档一致，由 applyPlanPatch 报失效）。
  if (patchGeneratorVersion(patch) !== CITY_GENERATOR_VERSION) return null;
  return { scaleTier: patch.scaleTier, parcels: new Map(Object.keys(patch.buildingMoves).sort().map((id) => [id, patch.buildingMoves[id]])) };
}

/** 编辑器写补丁：追加一个道路操作（引用生效布局里的当前 id）。 */
/** 道路操作 → 失效条目的种类。 */
export const roadStaleKind = (op: RoadOp): PatchStaleEntry["kind"] =>
  op.t === "drop" ? "road-drop" : op.t === "move" ? "road-move" : op.t === "restyle" ? "road-restyle" : "road-add";

export function appendRoadOp(patch: PlanPatchV1, op: RoadOp, now = Date.now()): PlanPatchV1 {
  return { ...patch, updatedAt: now, roadOps: [...patch.roadOps, op] };
}

/** 编辑器写补丁：追加一个设施操作（at = 设施当前位置，用来在重放时校验「还是同一座」）。 */
export function appendSiteOp(patch: PlanPatchV1, op: SiteOp, now = Date.now()): PlanPatchV1 {
  return { ...patch, updatedAt: now, siteOps: [...patch.siteOps, op] };
}

export function appendHighwayOp(patch: PlanPatchV1, op: HighwayOp, now = Date.now()): PlanPatchV1 {
  return { ...patch, updatedAt: now, highwayOps: [...(patch.highwayOps ?? []), op] };
}

export function appendTerrainOp(patch: PlanPatchV1, op: TerrainOp, now = Date.now()): PlanPatchV1 {
  return { ...patch, updatedAt: now, terrainOps: [...(patch.terrainOps ?? []), op] };
}

/** 补丁是否什么都没改（会话据此把空补丁存成「无补丁」）。 */
export function planPatchEmpty(patch: PlanPatchV1): boolean {
  return !patch.roadOps.length && !(patch.highwayOps?.length) && !patch.siteOps.length && !Object.keys(patch.buildingMoves).length && !patch.suppressedContext.length && !(patch.terrainOps?.length);
}

/**
 * 删掉已失效的条目（用户在面板上点「清除失效修改」）。失效条目重放时本来就没生效（道路/设施操作先在试算副本上跑，
 * 失败即丢弃），删掉它们不改变其余条目的重放结果——后面的操作引用的是 id，不是序号。
 * 跨档失效（tier-changed）与生成器换代（generator-changed）是整份作废，清掉后等于空补丁，返回 null。
 */
export function pruneStalePatch(patch: PlanPatchV1, stale: readonly PatchStaleEntry[], now = Date.now()): PlanPatchV1 | null {
  if (!stale.length) return patch;
  if (stale.some((entry) => entry.reason === "tier-changed" || entry.reason === "generator-changed")) return null;
  const roadLabels = new Set(stale.filter((entry) => entry.kind.startsWith("road-")).map((entry) => entry.id));
  const siteLabels = new Set(stale.filter((entry) => entry.kind.startsWith("site-")).map((entry) => entry.id));
  const highwayLabels = new Set(stale.filter((entry) => entry.kind.startsWith("highway-")).map((entry) => entry.id));
  const buildings = new Set(stale.filter((entry) => entry.kind === "building-move").map((entry) => entry.id));
  const contexts = new Set(stale.filter((entry) => entry.kind === "context-suppress").map((entry) => entry.id));
  const terrainLabels = new Set(stale.filter((entry) => entry.kind === "terrain-op").map((entry) => entry.id));
  const next: PlanPatchV1 = {
    ...patch, updatedAt: now,
    roadOps: patch.roadOps.filter((op, index) => !roadLabels.has(`${index + 1}:${op.t}`)),
    ...(patch.highwayOps?.length ? { highwayOps: patch.highwayOps.filter((op, index) => !highwayLabels.has(`${index + 1}:${op.t}`)) } : {}),
    siteOps: patch.siteOps.filter((op, index) => !siteLabels.has(`${index + 1}:${op.t}`)),
    buildingMoves: Object.fromEntries(Object.entries(patch.buildingMoves).filter(([id]) => !buildings.has(id))),
    ...(patch.moveAnchors ? { moveAnchors: Object.fromEntries(Object.entries(patch.moveAnchors).filter(([id]) => !buildings.has(id))) } : {}),
    suppressedContext: patch.suppressedContext.filter((id) => !contexts.has(id)),
    ...(patch.terrainOps?.length ? { terrainOps: patch.terrainOps.filter((op, index) => !terrainLabels.has(`${index + 1}:${op.t}`)) } : {}),
  };
  return planPatchEmpty(next) ? null : next;
}

/** 端点离已有路口这么近就接到路口上。 */
export const SNAP_NODE_RADIUS = 1;
/** 端点落在路段中间（离折线 ≤ 此值）就把该路段拆成两半。 */
export const SNAP_EDGE_RADIUS = 0.6;

type RoadState = { nodes: RoadNode[]; edges: RoadEdge[] };

const edgeIdOf = (from: string, to: string) => [from, to].sort().join("/");

export function nearestOnPolyline(p: Vec2, points: readonly Vec2[]): { distance: number; segment: number; point: Vec2 } {
  let best = { distance: Infinity, segment: 1, point: points[0] };
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]; const b = points[i];
    const dx = b.x - a.x; const dz = b.z - a.z; const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
    const q = { x: a.x + dx * t, z: a.z + dz * t };
    const distance = Math.hypot(p.x - q.x, p.z - q.z);
    if (distance < best.distance) best = { distance, segment: i, point: q };
  }
  return best;
}

/** 线段 a→b 与现有地面路（非桥）的真交点，离端点 1 以内的不算；按离 a 的距离排序。与 planRoadRules.crossingPoints 同口径。 */
function crossingsOf(edges: readonly RoadEdge[], a: Vec2, b: Vec2): Vec2[] {
  const out: Vec2[] = [];
  const r = { x: b.x - a.x, z: b.z - a.z };
  for (const edge of edges) {
    if (edge.bridge) continue;
    for (let i = 1; i < edge.points.length; i += 1) {
      const c = edge.points[i - 1]; const d = edge.points[i];
      const sv = { x: d.x - c.x, z: d.z - c.z };
      const denom = r.x * sv.z - r.z * sv.x;
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((c.x - a.x) * sv.z - (c.z - a.z) * sv.x) / denom;
      const u = ((c.x - a.x) * r.z - (c.z - a.z) * r.x) / denom;
      if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
      const hit = { x: a.x + r.x * t, z: a.z + r.z * t };
      if (Math.hypot(hit.x - a.x, hit.z - a.z) > 1 && Math.hypot(hit.x - b.x, hit.z - b.z) > 1) out.push(hit);
    }
  }
  return out.sort((p, q) => Math.hypot(p.x - a.x, p.z - a.z) - Math.hypot(q.x - a.x, q.z - a.z));
}

/** 把路段在 p 处拆成两半（属性完整继承；折线按最近一段切开）。p 取整到 0.01。 */
function splitEdge(state: RoadState, edge: RoadEdge, p: Vec2, segment: number): string {
  const at = quantize(p);
  const id = roadNodeId(at);
  const first = edge.points.slice(0, segment); first.push(at);
  const second = [at, ...edge.points.slice(segment)];
  if (!state.nodes.some((node) => node.id === id)) state.nodes.push({ id, x: at.x, z: at.z });
  state.edges = state.edges.filter((candidate) => candidate !== edge);
  state.edges.push({ ...edge, id: edgeIdOf(edge.from, id), from: edge.from, to: id, points: first });
  state.edges.push({ ...edge, id: edgeIdOf(id, edge.to), from: id, to: edge.to, points: second });
  return id;
}

/** 端点解析：路口 → 路段中间（拆开）→ 新建路口。碰到锁定路段（桥/引道/滨海）返回 "locked-edge"。 */
function resolveEndpoint(state: RoadState, p: Vec2): { id: string } | { error: "locked-edge" } {
  const at = quantize(p);
  const near = state.nodes.find((node) => Math.hypot(node.x - at.x, node.z - at.z) < SNAP_NODE_RADIUS);
  if (near) return { id: near.id };
  let host: { edge: RoadEdge; hit: ReturnType<typeof nearestOnPolyline> } | null = null;
  for (const edge of state.edges) {
    const hit = nearestOnPolyline(at, edge.points);
    if (hit.distance <= SNAP_EDGE_RADIUS && (!host || hit.distance < host.hit.distance)) host = { edge, hit };
  }
  if (host) {
    if (edgeLocked(host.edge)) return { error: "locked-edge" };
    return { id: splitEdge(state, host.edge, host.hit.point, host.hit.segment) };
  }
  const id = roadNodeId(at);
  state.nodes.push({ id, x: at.x, z: at.z });
  return { id };
}

/** 拐角倒圆：转角小于这个角度不倒（几乎直行），大于这个角度不倒（掉头式回折，倒出来是个小圈）。 */
const FILLET_MIN_TURN = (12 * Math.PI) / 180;
const FILLET_MAX_TURN = (150 * Math.PI) / 180;

export type Fillet = { center: Vec2; mid: Vec2; /** P1（含）→ mid（不含）的弧点 */ before: Vec2[]; /** mid（不含）→ P2（含）的弧点 */ after: Vec2[] };

/**
 * 在路口 b 处给「从 a 来、往 c 去」的拐弯倒一个圆角（SPEC §17.3）。半径按路宽取 3 倍（12–36），
 * 且切点离拐点不超过两侧路段长度的 45%（短路段上倒小圆）。不该倒（近乎直行 / 回折 / 路段太短）返回 null。
 * 用户画路是一段段直线，拐弯处原来是两个矩形硬接，贴图的圆角线帽只有半个路宽，看上去是一个硬折角。
 */
export function filletAt(a: Vec2, b: Vec2, c: Vec2, width: number): Fillet | null {
  const l1 = Math.hypot(b.x - a.x, b.z - a.z); const l2 = Math.hypot(c.x - b.x, c.z - b.z);
  if (l1 < 4 || l2 < 4) return null;
  const u1 = { x: (b.x - a.x) / l1, z: (b.z - a.z) / l1 }; const u2 = { x: (c.x - b.x) / l2, z: (c.z - b.z) / l2 };
  const turn = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.z * u2.z)));
  if (turn < FILLET_MIN_TURN || turn > FILLET_MAX_TURN) return null;
  const half = Math.tan(turn / 2);
  const tangent = Math.min(Math.max(12, Math.min(36, width * 3)) * half, l1 * 0.45, l2 * 0.45);
  if (tangent < 1.5) return null;
  const radius = tangent / half;
  const side = u1.x * u2.z - u1.z * u2.x > 0 ? 1 : -1; // 左转 / 右转
  const n1 = { x: -u1.z * side, z: u1.x * side };
  const p1 = { x: b.x - u1.x * tangent, z: b.z - u1.z * tangent };
  const center = { x: p1.x + n1.x * radius, z: p1.z + n1.z * radius };
  const start = Math.atan2(p1.z - center.z, p1.x - center.x);
  const steps = Math.max(4, Math.ceil(turn / (Math.PI / 16))) & ~1; // 偶数段：中点正好是一个弧点
  const arc = Array.from({ length: steps + 1 }, (_, k) => quantize({ x: center.x + Math.cos(start + side * turn * (k / steps)) * radius, z: center.z + Math.sin(start + side * turn * (k / steps)) * radius }));
  return { center, mid: arc[steps / 2], before: arc.slice(0, steps / 2), after: arc.slice(steps / 2 + 1) };
}

/**
 * 重放道路操作日志。每个操作在**试算副本**上执行，成功才提交——否则「端点已把路拆了、整条边却因重复而失败」
 * 会留下半截改动。失败的操作进 stale、不影响后续操作（后续操作若引用了它产生的 id，会各自报 missing）。
 */
function replayRoadOps(layout: CityLayout, ops: readonly RoadOp[], stale: PatchStaleEntry[]): { nodes: RoadNode[]; edges: RoadEdge[]; endMap: Map<string, string> } {
  let state: RoadState = { nodes: layout.roadNodes.map((node) => ({ ...node })), edges: [...layout.roadEdges] };
  // 回车点跟随：底层回车点节点 id → 当前 id（移动会改 id）。
  const endMap = new Map((layout.culDeSacEnds ?? []).map((end) => { const id = roadNodeId(quantize(end)); return [id, id] as [string, string]; }));
  ops.forEach((op, index) => {
    const label = `${index + 1}:${op.t}`;
    if ((op.t === "add" || op.t === "restyle") && !isStandardRoadWidth(op.width)) {
      stale.push({ kind: op.t === "add" ? "road-add" : "road-restyle", id: label, reason: "non-standard-width", detail: "道路宽度不符合标准：请选择支路、次干道或主干道" }); return;
    }
    const trial: RoadState = { nodes: state.nodes.map((node) => ({ ...node })), edges: [...state.edges] };
    if (op.t === "drop") {
      const edge = trial.edges.find((candidate) => candidate.id === op.edge);
      if (!edge) { stale.push({ kind: "road-drop", id: label, reason: "missing-edge", detail: `路段 ${op.edge} 不存在（规划已重算或前序操作已改动）` }); return; }
      // 擦桥面 = 擦整座桥（bridgeChain）；桥头的引道失去桥后就是普通地面路（不再提示「擦掉引道桥会断开」）。
      const dropped = new Set(bridgeChain(trial.edges, edge));
      trial.edges = trial.edges.filter((candidate) => !dropped.has(candidate));
      const touched = new Set([...dropped].flatMap((candidate) => [candidate.from, candidate.to]));
      const onDeck = new Set(trial.edges.filter(edgeLocked).flatMap((candidate) => [candidate.from, candidate.to]));
      if (dropped.size > 1 || edgeLocked(edge)) trial.edges = trial.edges.map((candidate) => candidate.structure === "ground-approach"
        && [candidate.from, candidate.to].some((id) => touched.has(id)) && ![candidate.from, candidate.to].some((id) => onDeck.has(id))
        ? { ...candidate, structure: "ground-road" as const } : candidate);
      const kept = new Set(trial.edges.flatMap((candidate) => [candidate.from, candidate.to]));
      trial.nodes = trial.nodes.filter((node) => kept.has(node.id) || !touched.has(node.id));
    } else if (op.t === "restyle") {
      const edge = trial.edges.find((candidate) => candidate.id === op.edge);
      if (!edge) { stale.push({ kind: "road-restyle", id: label, reason: "missing-edge", detail: `路段 ${op.edge} 不存在（规划已重算或前序操作已改动）` }); return; }
      if (edgeLocked(edge)) { stale.push({ kind: "road-restyle", id: label, reason: "locked-edge", detail: "桥面由桥梁模型绑定，不能改路型" }); return; }
      if (edge.width === op.width && edge.purpose === op.purpose) return; // 已是目标路型：无操作，不算失效
      const { purpose: _old, ...rest } = edge;
      void _old;
      trial.edges = trial.edges.map((candidate) => (candidate !== edge ? candidate
        : { ...rest, width: op.width, kind: kindOfWidth(op.width), ...(op.purpose ? { purpose: op.purpose } : {}) }));
    } else if (op.t === "move") {
      const node = trial.nodes.find((candidate) => candidate.id === op.node);
      if (!node) { stale.push({ kind: "road-move", id: label, reason: "missing-node", detail: `路口 ${op.node} 不存在` }); return; }
      if (trial.edges.some((edge) => (edge.from === node.id || edge.to === node.id) && edgeLocked(edge))) {
        stale.push({ kind: "road-move", id: label, reason: "locked-edge", detail: "路口连着桥/引道/滨海段，不可编辑" }); return;
      }
      const target = quantize(op.to);
      const fresh = roadNodeId(target);
      if (fresh === node.id) return; // 原地不动：无操作，不算失效
      // 目标落在别的路口上 → 重复节点/重复路段/零长边（曾一路流进渲染），整条拒绝。
      if (trial.nodes.some((other) => other.id === fresh)) { stale.push({ kind: "road-move", id: label, reason: "node-collision", detail: `目标 ${fresh} 已有路口` }); return; }
      const old = node.id;
      node.id = fresh; node.x = target.x; node.z = target.z;
      trial.edges = trial.edges.map((edge) => {
        if (edge.from !== old && edge.to !== old) return edge;
        const from = edge.from === old ? fresh : edge.from; const to = edge.to === old ? fresh : edge.to;
        const points = [...edge.points];
        if (edge.from === old) points[0] = { x: target.x, z: target.z };
        if (edge.to === old) points[points.length - 1] = { x: target.x, z: target.z };
        return { ...edge, id: edgeIdOf(from, to), from, to, points };
      });
      for (const [key, value] of endMap) if (value === old) endMap.set(key, fresh);
    } else {
      const a = resolveEndpoint(trial, op.from);
      if ("error" in a) { stale.push({ kind: "road-add", id: label, reason: a.error, detail: "起点落在桥/引道/滨海段上，不能从这里接路" }); return; }
      const b = resolveEndpoint(trial, op.to);
      if ("error" in b) { stale.push({ kind: "road-add", id: label, reason: b.error, detail: "终点落在桥/引道/滨海段上，不能从这里接路" }); return; }
      if (a.id === b.id) { stale.push({ kind: "road-add", id: label, reason: "degenerate", detail: "起点和终点是同一个路口" }); return; }
      let na = trial.nodes.find((node) => node.id === a.id)!; const nb = trial.nodes.find((node) => node.id === b.id)!;
      if (op.via) {
        // 弧线：按 curvePoints 铺折线，逐小段找与现有路的交点（自动路口，同直路）；交点处断开成几条折线路段。
        const pts = curvePoints(na, op.via, nb);
        for (let i = 1; i < pts.length; i += 1) {
          if (wetSpan(layout, pts[i - 1], pts[i]).kind !== "dry") { stale.push({ kind: "road-add", id: label, reason: "road-in-water", detail: "弧线不能过水——过河请用直线（会自动架桥）" }); return; }
        }
        const kind = kindOfWidth(op.width);
        const mine = new Set<string>();
        let prev = na.id; let run: Vec2[] = [{ x: na.x, z: na.z }]; let laid = 0;
        const close = (to: string, at: Vec2) => {
          run.push(at);
          const id = edgeIdOf(prev, to);
          if (prev !== to && !trial.edges.some((edge) => edge.id === id)) {
            trial.edges.push({ id, from: prev, to, width: op.width, kind, points: run, structure: "ground-road", ...(op.purpose ? { purpose: op.purpose } : {}) });
            mine.add(id); laid += 1;
          }
          prev = to; run = [at];
        };
        for (let i = 1; i < pts.length; i += 1) {
          for (const p of crossingsOf(trial.edges.filter((edge) => !mine.has(edge.id)), pts[i - 1], pts[i])) {
            const hit = resolveEndpoint(trial, p);
            if ("error" in hit) { stale.push({ kind: "road-add", id: label, reason: hit.error, detail: "弧线要穿过桥面，桥上不能开路口" }); return; }
            const node = trial.nodes.find((candidate) => candidate.id === hit.id)!;
            close(hit.id, { x: node.x, z: node.z });
          }
          if (i === pts.length - 1) break;
          // 采样点正好落在现有路上（经过点点在路上时必然如此）：crossingsOf 排除离端点 1 以内的交点，两侧小段都看不见它——
          // 曾因此弧线从路上压过去却不开路口。这里按「路上的点」补一个路口。
          const onRoad = trial.edges.some((edge) => !mine.has(edge.id) && !edge.bridge && nearestOnPolyline(pts[i], edge.points).distance < 1);
          if (onRoad) {
            const hit = resolveEndpoint(trial, pts[i]);
            if ("error" in hit) { stale.push({ kind: "road-add", id: label, reason: hit.error, detail: "弧线要穿过桥面，桥上不能开路口" }); return; }
            const node = trial.nodes.find((candidate) => candidate.id === hit.id)!;
            close(hit.id, { x: node.x, z: node.z });
          } else run.push(pts[i]);
        }
        close(nb.id, { x: nb.x, z: nb.z });
        if (!laid) { stale.push({ kind: "road-add", id: label, reason: "edge-exists", detail: "这条弧线与已有路重合" }); return; }
        state = trial;
        return;
      }
      // 拐角倒圆：起点是一条地面路的尽头（度为 1）且这一笔拐了弯——把拐点挪到圆弧中点，旧路尾段与新路首段各带半段弧。
      let lead: Vec2[] = []; // 新路首段在起点之后、交叉检测之前要经过的弧点（含 P2）
      const incident = trial.edges.filter((edge) => edge.from === na.id || edge.to === na.id);
      if (incident.length === 1 && !edgeLocked(incident[0])) {
        const prev = incident[0];
        const oriented = prev.to === na.id ? prev.points : [...prev.points].reverse(); // na 在末尾
        const fillet = filletAt(oriented[oriented.length - 2], na, nb, Math.min(prev.width, op.width));
        const midId = fillet ? roadNodeId(fillet.mid) : null;
        if (fillet && midId && !trial.nodes.some((node) => node.id === midId)) {
          const old = na.id;
          const node = { id: midId, x: fillet.mid.x, z: fillet.mid.z };
          trial.nodes = trial.nodes.map((candidate) => (candidate.id === old ? node : candidate));
          const bent = [...oriented.slice(0, -1), ...fillet.before, fillet.mid];
          const other = prev.to === old ? prev.from : prev.to;
          trial.edges = trial.edges.map((edge) => (edge !== prev ? edge
            : prev.to === old ? { ...prev, id: edgeIdOf(other, midId), to: midId, points: bent } : { ...prev, id: edgeIdOf(midId, other), from: midId, points: [...bent].reverse() }));
          for (const [key, value] of endMap) if (value === old) endMap.set(key, midId);
          na = node; lead = fillet.after;
        }
      }
      // 交叉：SimCity 式自动路口——在每个交点处把被交的路拆开，新路分段经过这些路口。曾经直接拒绝交叉，
      // 用户画路处处碰壁；交点按离起点的距离排序，拆路复用端点解析（交点离已有路口 < 1 时直接接到那个路口）。
      const chain = [na.id];
      for (const point of crossingsOf(trial.edges, lead.length ? lead[lead.length - 1] : na, nb)) {
        const hit = resolveEndpoint(trial, point);
        if ("error" in hit) { stale.push({ kind: "road-add", id: label, reason: hit.error, detail: "新路要穿过桥面，桥上不能开路口" }); return; }
        if (hit.id !== chain[chain.length - 1]) chain.push(hit.id);
      }
      if (b.id !== chain[chain.length - 1]) chain.push(b.id);
      let added = 0;
      const kind = kindOfWidth(op.width);
      const nodeAt = (p: Vec2): string => { const id = roadNodeId(p); if (!trial.nodes.some((node) => node.id === id)) trial.nodes.push({ id, x: p.x, z: p.z }); return id; };
      for (let i = 1; i < chain.length; i += 1) {
        const id = edgeIdOf(chain[i - 1], chain[i]);
        if (chain[i - 1] === chain[i] || trial.edges.some((edge) => edge.id === id)) continue; // 与已有路重合的那一段不重复铺
        const p = trial.nodes.find((node) => node.id === chain[i - 1])!; const q = trial.nodes.find((node) => node.id === chain[i])!;
        // 地面桥（路线图 P1-5）：这一段跨一段水 → 拆成 引道 + 桥面 + 引道，与生成器的桥同构（deck 段 bridge:true，
        // 挨着它的地面段 ground-approach）。倒圆弧段（lead）不在水上判——拐角在路尽头的陆地上。
        const span = i === 1 && lead.length ? { kind: "dry" as const } : wetSpan(layout, p, q);
        if (span.kind === "invalid") { stale.push({ kind: "road-add", id: label, reason: "road-in-water", detail: `新路要过的水面不能修桥（${span.reason}）` }); return; }
        if (span.kind === "bridge") {
          const s = Math.hypot(span.from.x - p.x, span.from.z - p.z) < 0.5 ? p.id : nodeAt(span.from);
          const e = Math.hypot(span.to.x - q.x, span.to.z - q.z) < 0.5 ? q.id : nodeAt(span.to);
          const at = (nodeId: string) => trial.nodes.find((node) => node.id === nodeId)!;
          const piece = (from: string, to: string, extra: Partial<RoadEdge>) => {
            const a = at(from); const b = at(to);
            trial.edges.push({ id: edgeIdOf(from, to), from, to, width: op.width, kind, points: [{ x: a.x, z: a.z }, { x: b.x, z: b.z }], ...extra } as RoadEdge);
          };
          if (s !== p.id) piece(p.id, s, { structure: "ground-approach", ...(op.purpose ? { purpose: op.purpose } : {}) });
          piece(s, e, { bridge: true, structure: "deck" });
          if (e !== q.id) piece(e, q.id, { structure: "ground-approach", ...(op.purpose ? { purpose: op.purpose } : {}) });
          added += 1;
          continue;
        }
        trial.edges.push({
          id, from: chain[i - 1], to: chain[i], width: op.width, kind,
          points: [{ x: p.x, z: p.z }, ...(i === 1 ? lead : []), { x: q.x, z: q.z }], structure: "ground-road",
          ...(op.purpose ? { purpose: op.purpose } : {}),
        });
        added += 1;
      }
      if (!added) { stale.push({ kind: "road-add", id: label, reason: "edge-exists", detail: `路段 ${edgeIdOf(a.id, b.id)} 已存在` }); return; }
    }
    state = trial;
  });
  return { nodes: state.nodes, edges: state.edges, endMap };
}

/** 高架首尾点离已有高架开口端这么近就接上去。 */
export const VIADUCT_JOIN_RADIUS = 12;
/** 一次切掉的最长一截。 */
export const VIADUCT_CUT = 40;

/** 线段 a→b 上离 p 最近的参数 t∈[0,1]。 */
const projectT = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b.x - a.x; const dz = b.z - a.z; const l2 = dx * dx + dz * dz || 1;
  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
};
const isClosed = (run: readonly Vec2[]) => run.length > 2 && Math.hypot(run[0].x - run[run.length - 1].x, run[0].z - run[run.length - 1].z) < 0.01;

/** 高架上离 p 最近的位置（宽容半径 = 桥面半宽 + 4）。 */
export function highwayHit(highways: readonly Vec2[][], p: Vec2): { run: number; segment: number; point: Vec2; distance: number } | null {
  let best: { run: number; segment: number; point: Vec2; distance: number } | null = null;
  highways.forEach((run, r) => {
    for (let i = 1; i < run.length; i += 1) {
      const t = projectT(p, run[i - 1], run[i]);
      const q = { x: run[i - 1].x + (run[i].x - run[i - 1].x) * t, z: run[i - 1].z + (run[i].z - run[i - 1].z) * t };
      const distance = Math.hypot(p.x - q.x, p.z - q.z);
      if (distance <= VIADUCT_DECK_WIDTH / 2 + 4 && (!best || distance < best.distance)) best = { run: r, segment: i, point: q, distance };
    }
  });
  return best;
}

/** 切掉的那一截（落在 at 所在的线段内，长度 ≤ VIADUCT_CUT）：返回切口两端。 */
export function highwayCutWindow(run: readonly Vec2[], segment: number, at: Vec2): { from: Vec2; to: Vec2 } {
  const a = run[segment - 1]; const b = run[segment];
  const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const centre = projectT(at, a, b) * length;
  const lo = Math.max(0, Math.min(centre - VIADUCT_CUT / 2, length - VIADUCT_CUT)); const hi = Math.min(length, lo + VIADUCT_CUT);
  const at_ = (d: number) => quantize({ x: a.x + (b.x - a.x) * (d / length), z: a.z + (b.z - a.z) * (d / length) });
  return { from: at_(lo), to: at_(hi) };
}

function replayHighwayOps(highways: readonly Vec2[][], ops: readonly HighwayOp[], stale: PatchStaleEntry[]): Vec2[][] {
  let runs = highways.map((run) => [...run]);
  ops.forEach((op, index) => {
    const label = `${index + 1}:${op.t}`;
    if (op.t === "cut") {
      const hit = highwayHit(runs, op.at);
      if (!hit) { stale.push({ kind: "highway-cut", id: label, reason: "missing-highway", detail: "这里已经没有高架了（规划已重算或前序操作已改动）" }); return; }
      const run = runs[hit.run];
      const cut = highwayCutWindow(run, hit.segment, op.at);
      const head = [...run.slice(0, hit.segment), cut.from]; const tail = [cut.to, ...run.slice(hit.segment)];
      const dedupe = (piece: Vec2[]) => piece.filter((q, i) => i === 0 || Math.hypot(q.x - piece[i - 1].x, q.z - piece[i - 1].z) > 0.01);
      // 环线切一刀变成一条首尾在切口两侧的开线。
      const pieces = isClosed(run) ? [dedupe([...tail, ...run.slice(1, hit.segment), cut.from])] : [dedupe(head), dedupe(tail)];
      runs = [...runs.slice(0, hit.run), ...pieces.filter((piece) => piece.length >= 2 && Math.hypot(piece[0].x - piece[piece.length - 1].x, piece[0].z - piece[piece.length - 1].z) > 1), ...runs.slice(hit.run + 1)];
      return;
    }
    let points = op.points.map(quantize);
    if (points.length < 2 || points.every((q) => Math.hypot(q.x - points[0].x, q.z - points[0].z) < 1)) { stale.push({ kind: "highway-add", id: label, reason: "degenerate", detail: "高架至少要两个不同的点" }); return; }
    // 首/尾接到已有高架的开口端上：拼成一条，接缝处不落地。
    const join = (end: Vec2): { run: number; atStart: boolean } | null => {
      for (let r = 0; r < runs.length; r += 1) {
        const run = runs[r];
        if (isClosed(run)) continue;
        if (Math.hypot(run[0].x - end.x, run[0].z - end.z) <= VIADUCT_JOIN_RADIUS) return { run: r, atStart: true };
        if (Math.hypot(run[run.length - 1].x - end.x, run[run.length - 1].z - end.z) <= VIADUCT_JOIN_RADIUS) return { run: r, atStart: false };
      }
      return null;
    };
    const head = join(points[0]);
    if (head) {
      const run = runs[head.run];
      const oriented = head.atStart ? [...run].reverse() : run; // 让接口在末尾
      points = [...oriented, ...points.slice(1)];
      runs = runs.filter((_, r) => r !== head.run);
    }
    const tail = join(points[points.length - 1]);
    if (tail && !(head && tail.run === head.run)) {
      const run = runs[tail.run];
      const oriented = tail.atStart ? run : [...run].reverse(); // 让接口在开头
      points = [...points.slice(0, -1), ...oriented];
      runs = runs.filter((_, r) => r !== tail.run);
    }
    runs.push(points);
  });
  return runs;
}

/**
 * 滨海景观带的折线（layout.coastRoads，seasideSystem 沿它向海一侧铺步道/矮墙/路灯）跟着滨海路走（SPEC §17.1）：
 *   - 生成器的岸段只保留仍压在滨海路上的那几段（擦掉/拖走的滨海路，景观带一起消失——曾留下悬空的景观带）；
 *   - 滨海路上还没被覆盖的部分（用户画的滨海大道、拖动过的滨海路段）按 8 加密补成新折线。
 * 河岸路（riverRoadRuns）也标 waterfront，但不铺海滨景观带：已在河岸折线上的不补。
 * 没有道路操作时不调用（底层布局逐字节不变）。
 */
function deriveCoastRoads(layout: CityLayout, edges: readonly RoadEdge[]): Vec2[][] {
  const waterfront = edges.filter((edge) => edge.purpose === "waterfront" && !edge.bridge);
  const onWaterfront = (p: Vec2) => waterfront.some((edge) => nearestOnPolyline(p, edge.points).distance <= 0.75);
  const kept: Vec2[][] = [];
  for (const run of layout.coastRoads ?? []) {
    let piece: Vec2[] = [];
    for (let i = 0; i < run.length; i += 1) {
      const mid = i ? { x: (run[i - 1].x + run[i].x) / 2, z: (run[i - 1].z + run[i].z) / 2 } : null;
      if (!i || (mid && onWaterfront(mid))) piece.push(run[i]);
      else { if (piece.length >= 2) kept.push(piece); piece = [run[i]]; }
    }
    if (piece.length >= 2) kept.push(piece);
  }
  const covered = [...kept, ...((layout as { riverRoadRuns?: Vec2[][] }).riverRoadRuns ?? [])];
  const isCovered = (p: Vec2) => covered.some((run) => nearestOnPolyline(p, run).distance <= 0.75);
  const added: Vec2[][] = [];
  for (const edge of waterfront) {
    const dense: Vec2[] = [];
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1]; const b = edge.points[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 8));
      for (let k = i === 1 ? 0 : 1; k <= steps; k += 1) dense.push({ x: a.x + (b.x - a.x) * (k / steps), z: a.z + (b.z - a.z) * (k / steps) });
    }
    const mid = dense[Math.floor(dense.length / 2)];
    if (dense.length >= 2 && mid && !isCovered(mid)) added.push(dense);
  }
  return [...kept, ...added];
}

/** 套用补丁（SPEC §5；顺序 道路日志 → 设施日志 → buildingMoves → 派生重算 → suppressedContext）。
 *  不改入参；失效条目进 stale。 */
export function applyPlanPatch(layout: CityLayout, patch: PlanPatchV1): PatchedLayout {
  const stale: PatchStaleEntry[] = [];
  const patchHash = hashPlanPatch(patch);

  // ── 0. 跨档位 / 生成器换代：地块/节点全部重排，整份补丁失效（套用这里不做坐标重定位，SPEC §4；
  //       重定位由会话层先调 planRemap 完成，之后补丁的档位与版本都对得上，不会走到这里）──
  // 档位优先：两者都不符时报 tier-changed，与引入版本戳前的上报逐字相同（界面文案、守卫断言都依赖它）。
  if (!patchMatchesLayout(patch, layout.scaleTier)) {
    const tierChanged = patch.scaleTier !== layout.scaleTier;
    const reason = tierChanged ? "tier-changed" as const : "generator-changed" as const;
    const detail = tierChanged
      ? `补丁写于第 ${patch.scaleTier} 档，城市已扩容到第 ${layout.scaleTier} 档`
      : `补丁写于第 ${patchGeneratorVersion(patch)} 版生成器，当前是第 ${CITY_GENERATOR_VERSION} 版`;
    for (const id of Object.keys(patch.buildingMoves).sort()) stale.push({ kind: "building-move", id, reason, detail });
    patch.roadOps.forEach((op, index) => stale.push({ kind: roadStaleKind(op), id: `${index + 1}:${op.t}`, reason, detail }));
    patch.siteOps.forEach((op, index) => stale.push({ kind: op.t === "remove" ? "site-remove" : "site-move", id: `${index + 1}:${op.t}`, reason, detail }));
    (patch.highwayOps ?? []).forEach((op, index) => stale.push({ kind: op.t === "add" ? "highway-add" : "highway-cut", id: `${index + 1}:${op.t}`, reason, detail }));
    for (const id of [...patch.suppressedContext].sort()) stale.push({ kind: "context-suppress", id, reason, detail });
    (patch.terrainOps ?? []).forEach((op, index) => stale.push({ kind: "terrain-op", id: `${index + 1}:${op.t}`, reason, detail }));
    return { layout, stale, patchHash };
  }

  // ── 0.5 玩家土方（docs/CITY_REPAIR_TERRAIN_GRADING_SPEC.md）：地形是最底层，先于道路重放——画路时校验看到的地形
  //        （已含之前的平整）与重放时一致。坏操作进失效清单、不改地形；操作中心落水不叠（水陆不由补丁改）。──
  const generatedTerrain = layout.terrain;
  const terrainOps: TerrainOp[] = [];
  (patch.terrainOps ?? []).forEach((op, index) => {
    const id = `${index + 1}:${op.t}`;
    if (index >= TERRAIN_OP_LIMITS.maxOps) { stale.push({ kind: "terrain-op", id, reason: "terrain-too-many", detail: `一份补丁最多 ${TERRAIN_OP_LIMITS.maxOps} 处平整` }); return; }
    const problem = terrainOpProblem(op);
    if (problem) { stale.push({ kind: "terrain-op", id, reason: problem, detail: "平整操作的尺寸或坡度超出允许范围" }); return; }
    const anchors = op.t === "pad" ? [op.at] : [op.from, op.to];
    if (anchors.some((p) => !(generatedTerrain.height(p.x, p.z) > 0))) { stale.push({ kind: "terrain-op", id, reason: "terrain-on-water", detail: "平整的中心或端点落在水里" }); return; }
    terrainOps.push(op);
  });
  // 道路重放基准 T_replay = 生成地形 ⊕ 玩家土方；后面的设施/移楼落位也读它。
  if (terrainOps.length) layout = { ...layout, terrain: applyTerrainOps(generatedTerrain, terrainOps) };

  // ── 1. 道路操作日志（删/移/加，按顺序重放）──
  const replayed = patch.roadOps.length ? replayRoadOps(layout, patch.roadOps, stale) : null;
  const roadNodes = replayed ? replayed.nodes : layout.roadNodes;
  const roadEdges = replayed ? replayed.edges : layout.roadEdges;
  // 桥头土方（surface/roadLandingGrading）是生成器的路自带的：补丁改了路，就从原始地形按补丁后仍在的**生成器桥**重新平整——
  // 擦掉的桥，它的土台随之撤掉；玩家新画的桥不自动垫土。后者不是遗漏：画桥的校验（validateRoadAdd / wetSpan 桥台延伸 /
  // 岸坡判断）都在没有新土台的地形上做，提交后再垫土就是事后改了校验通过的几何，桥面是按两端地形取平的一块，
  // 土台的过渡带让旁边的路面跟着起伏，叠到桥面下就是 height-conflict。要给玩家的桥动土方，得是一个先预览、再校验的工具。
  // 回归（2026-10-22，ceaa2cce 之后）：只在生成布局上平整、补丁不重算，旧桥头的土台留在原地，新桥两头都撞 height-conflict，
  // 一键修复从此一座桥也修不好。
  const generatedDecks = new Set(layout.roadEdges.filter((edge) => edge.bridge).map((edge) => edge.id));
  // 最终地形 T_final = 原始地形 ⊕ 生成器土方（只算仍在的生成器桥）⊕ 玩家土方；与 T_replay 只在被擦掉的生成器桥头处不同。
  const graded = replayed ? regradeRoadLandings(generatedTerrain, roadEdges.filter((edge) => !edge.bridge || generatedDecks.has(edge.id))) : generatedTerrain;
  const terrain = applyTerrainOps(graded, terrainOps);
  const highways = patch.highwayOps?.length ? replayHighwayOps(layout.highways ?? [], patch.highwayOps, stale) : layout.highways;
  const coastRoads = replayed ? deriveCoastRoads(layout, roadEdges) : layout.coastRoads;
  // 画路生成的地面桥登记进 bridges（渲染层的桁架装饰读它，与生成器的跨河桥同构）；整座擦掉的桥从登记里撤掉——
  // 登记与桥面段不一一对应（生成器的桥面可被路口重绑拆段），按「登记的桥中点下面还有没有桥面」判定。
  const baseIds = new Set(layout.roadEdges.map((edge) => edge.id));
  const newDecks = replayed ? roadEdges.filter((edge) => edge.bridge && !baseIds.has(edge.id)) : [];
  const decks = replayed ? roadEdges.filter(edgeLocked) : [];
  const deckIds = new Set(decks.map((edge) => edge.id));
  const decksDropped = replayed ? layout.roadEdges.some((edge) => edgeLocked(edge) && !deckIds.has(edge.id)) : false;
  const under = (bridge: { from: Vec2; to: Vec2 }, over: readonly RoadEdge[]) => {
    const mid = { x: (bridge.from.x + bridge.to.x) / 2, z: (bridge.from.z + bridge.to.z) / 2 };
    return over.some((edge) => edge.points.some((p, i) => i > 0 && segmentDistance(mid, edge.points[i - 1], p) <= edge.width / 2 + 1));
  };
  // 只撤「补丁前下面有桥面、补丁后没了」的：登记若本来就没压在桥面上（几何对不上），擦别的桥不该连带撤掉它。
  const baseDecks = decksDropped ? layout.roadEdges.filter(edgeLocked) : [];
  const erasedSpan = (bridge: { from: Vec2; to: Vec2 }) => decksDropped && under(bridge, baseDecks) && !under(bridge, decks);
  const bridges = newDecks.length || decksDropped ? [...(layout.bridges ?? []).filter((bridge) => !erasedSpan(bridge)), ...newDecks.map((edge) => {
    const [from, to] = [edge.points[0], edge.points[edge.points.length - 1]];
    return { from, to, angle: Math.atan2(to.z - from.z, to.x - from.x), length: Math.hypot(to.x - from.x, to.z - from.z) };
  })] : layout.bridges;

  // ── 2. 设施操作日志（删/移）：先于会话楼移动套用，后者看到的是设施改动后的占用 ──
  // 设施与会话楼的落位判定要看到改过的高架（新高架下不能落楼）。
  const base: CityLayout = highways === layout.highways ? layout : { ...layout, highways };
  const sites = patch.siteOps.length ? applySiteOps(base, patch.siteOps, patch.suppressedContext, stale) : null;
  const view: CityLayout = sites ? { ...base, ...sites } : base;

  // ── 3. buildingMoves：目标缺失/被占（按套用顺序先到先得）→ stale；否则换 slot 重算地面高度 ──
  const districts = layout.districts.map((district) => ({ ...district, slots: new Map(district.slots), grounds: new Map(district.grounds), carPaths: district.carPaths }));
  // 重新平整了：城区共用同一份地形，楼的地面高度与生成时同口径（terrain.height(地块)）重取。
  if (terrain !== generatedTerrain) for (const district of districts) {
    if (district.terrain === generatedTerrain) district.terrain = terrain;
    for (const [id, slot] of district.slots) district.grounds.set(id, terrain.height(slot.x, slot.z));
  }
  if (Object.keys(patch.buildingMoves).length) {
    const parcels = parcelIndex(view);
    const taken = reservedParcelIds(view, patch.suppressedContext);
    for (const buildingId of Object.keys(patch.buildingMoves).sort()) {
      const targetId = patch.buildingMoves[buildingId];
      const home = districts.find((district) => district.slots.has(buildingId));
      if (!home) { stale.push({ kind: "building-move", id: buildingId, reason: "unknown-building", detail: "会话楼不在当前布局（窗口已换）" }); continue; }
      if (home.slots.get(buildingId)!.id === targetId) continue; // 已在目标地块（layoutCity pins 已落位，或叠套）
      const target = parcels.get(targetId);
      if (!target) { stale.push({ kind: "building-move", id: buildingId, reason: "missing-parcel", detail: "目标地块不存在（规划已重算）" }); continue; }
      if (taken.has(targetId)) { stale.push({ kind: "building-move", id: buildingId, reason: "parcel-occupied", detail: "目标地块已被会话楼/配套/花园/地标/背景楼占用" }); continue; }
      taken.delete(home.slots.get(buildingId)!.id);
      taken.add(targetId);
      home.slots.set(buildingId, target);
      home.grounds.set(buildingId, terrain.height(target.x, target.z));
    }
  }

  // ── 4. 派生重算：回车点跟随节点映射按度口径重筛；车流按新边对集过滤（同 growWithBuildings）──
  const degree = new Map<string, number>();
  for (const edge of roadEdges) if (!edge.bridge) for (const id of [edge.from, edge.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const nodeById = new Map(roadNodes.map((node) => [node.id, node]));
  const culDeSacEnds = (layout.culDeSacEnds ?? []).flatMap((end) => {
    const original = roadNodeId(quantize(end));
    const id = replayed ? replayed.endMap.get(original) ?? original : original;
    const node = nodeById.get(id);
    return node && degree.get(id) === 1 ? [{ x: node.x, z: node.z }] : [];
  });
  // 车流路径逐节点走（growWithBuildings 按 from/to 对过滤）；折线路段再补中间点对，两种口径都认。
  const pairKey = (a: Vec2, b: Vec2) => [`${a.x}:${a.z}`, `${b.x}:${b.z}`].sort().join("/");
  const pairs = new Set<string>();
  for (const edge of roadEdges) {
    pairs.add([edge.from, edge.to].sort().join("/"));
    for (let i = 1; i < edge.points.length; i += 1) pairs.add(pairKey(edge.points[i - 1], edge.points[i]));
  }
  for (const district of districts) {
    district.carPaths = district.carPaths.filter((route) => route.every((p, i) => i === 0 || pairs.has(pairKey(route[i - 1], p))));
  }

  // ── 5. suppressedContext（M3 透传）──
  let { contextBuildings } = view;
  const suppressed = new Set(patch.suppressedContext);
  if (suppressed.size) {
    // 按原始集合逐条比对：曾以「总数没变」为前提，只要有一条压制生效，其余不存在的 id 就不再上报。
    const existing = new Set(view.contextBuildings.map((context) => context.id));
    for (const id of [...suppressed].sort()) if (!existing.has(id)) stale.push({ kind: "context-suppress", id, reason: "missing-context", detail: "背景楼不存在（布局重算后未生成）" });
    contextBuildings = contextBuildings.filter((context) => !suppressed.has(context.id));
  }

  const suffix = `|patch:${patchHash}`;
  const activityKey = typeof layout.activityKey === "string" && layout.activityKey.endsWith(suffix)
    ? layout.activityKey // 叠套时不重复追加指纹
    : `${layout.activityKey ?? ""}${suffix}`;

  // 悬索桥是「最长过河桥」的塔架与主缆（地标）：它下面的桥被整座擦掉，塔与缆一起拆（校验提示 erases-suspension-bridge）。
  const unhung = (l: CityLayout["landmarks"][number]) => l.kind === "suspension-bridge" && !!l.to && erasedSpan({ from: l, to: l.to });
  const landmarks = decksDropped && (view.landmarks ?? []).some(unhung) ? view.landmarks.filter((l) => !unhung(l)) : view.landmarks;
  // 玩家土方范围内、布局期按地形算死的高度，与生成时同口径重取（范围外一律不动：没有平整的补丁逐字不变）。
  const touched = (p: Vec2) => terrainOpsTouch(terrainOps, p.x, p.z);
  const reground = <T extends Vec2 & { y: number }>(items: readonly T[], floor = -Infinity): T[] =>
    terrainOps.length && items.some(touched) ? items.map((item) => (touched(item) ? { ...item, y: Math.max(floor, terrain.height(item.x, item.z)) } : item)) : (items as T[]);
  if (terrainOps.length) for (const district of districts) if (touched(district.plaza)) district.plaza = { ...district.plaza, y: Math.max(0.4, terrain.height(district.plaza.x, district.plaza.z)) };
  contextBuildings = reground(contextBuildings, 0.3);
  const heights = terrainOps.length ? {
    massing: reground(view.massing, 0.3), gardens: reground(view.gardens), parkTrees: reground(view.parkTrees),
    ...(view.districtLandmarks ? { districtLandmarks: reground(view.districtLandmarks) } : {}),
  } : {};
  return { layout: { ...view, ...heights, roadNodes, roadEdges, districts, ...(terrain !== view.terrain ? { terrain } : {}), culDeSacEnds, contextBuildings, activityKey, ...(coastRoads !== layout.coastRoads ? { coastRoads } : {}), ...(bridges !== layout.bridges ? { bridges } : {}), ...(landmarks !== view.landmarks ? { landmarks } : {}) }, stale, patchHash };
}
