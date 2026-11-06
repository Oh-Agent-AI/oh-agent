import { atLeast } from "./roadStandard";
import { DetMath as Math } from "./detMath"; // 跨引擎确定性：见 detMath.ts
/**
 * Seeded, data-independent geography and municipal land reservations.
 *
 * CITY_PLANNING_SPEC G1：先有地理、再铺街区、规模跟着档位走。
 *   L1 地理：种子 → 岛形（极坐标谐波 + 海湾 + 拉伸旋转）、河、山脊、城市核心点、生态带。
 *   规模：scaleTier（由会话总数分档，见 cityLayout）→ 目标地块数；岛按需放大到装得下
 *         （同一种子只放大不变形，档位不变时地图不变）。
 *   街区网格按岛的实际包围盒生成；公共用地与城区锚点相对核心点放置再贴到陆地上——
 *   不再有任何写死的岛形坐标（曾经全部写死：换种子岛形不变，岛一变就落海）。
 * 只读 (seed, scaleTier)，不读任何会话字段。
 */
import { hashSeed } from "../cityModel";
import { fbm, smoothstep } from "./cityNoise";
import { boulevardSegments, buildSeasideBand, MIAMI_COASTAL, seasideStripContains, type CoastalConfig, type SeasideBand, type SeasideWorld } from "./citySeaside";
import type { RepairContext } from "./planner/context";
import { initializeRepairPlanningWorld, runRepairDerivedFinalization, solvePlan } from "./planner/solve";
import { CONSTRAINTS, type CityPlan as ConstraintPlan } from "./planner/constraints";
import { closestPolylineSegment, polylineDistance } from "./planner/footprint";
import { canRelocateGroundSite, coastalSitingKinds, specByKind } from "./planner/sitespec";
import { candidatesFor, siteCandidateHardReject } from "./planner/access";
import { assignConnectedSite } from "./planner/jointSite";
import { proposeShorePlotAccess } from "./planner/shorePlotAccess";
import { frontSitesOnTrunks, resnapSitesOntoDryLand, restickSitesClearOfRingRuns, straddleSitesAcrossTrunk, groundFrontageSegments, type FrontageMoveContext } from "./planner/access";
import { localResiteCandidates, retreatShoreSitesToDryLand, settleHarborOnCoast, settleSailOperaOffshore, settleShoreSitesOnCoast, SAIL_OPERA_CONFIG, type ShoreMoveContext } from "./planner/siting";
import { buildGeography, type BayOptions } from "./planner/geography";
import { withPlanningWorkLedger, spendPlanningWork, type PlanningWorkLedger } from "./planner/operationBudget";
import { roadCandidateCrowding } from "./planner/roadAdmission";
import { extractRoadFaces } from "./planner/roadFaces";
import { generateRoadBlocks, type RoadBlockReport } from "./planner/roadBlocks";
import { componentOf, diagnoseNetwork, type ConnectionDemand } from "./planner/intent";
import { buildSkeleton, chooseCore } from "./planner/skeleton";
import { buildSeasideBoulevard } from "./planner/seasideBoulevard";
import { buildCoastalRingRoads } from "./planner/coastalRingRoad";
import { addNetworkEdge, commitNetwork, emptyNetwork, keyOf, type Network } from "./planner/network";
import { runConnection, endpointClear, commitFixedLink, parseFailure, type ConnectionAttempt, type ConnectorWorld } from "./planner/connect";
import { frontSitesAndAssignJointSites } from "./planner/siteFrontage";
import { buildSectorBlocks } from "./planner/sectorBlocks";
import { connectSiteEntrances } from "./planner/siteEntrances";
import { stitchStreetNetwork } from "./planner/streetStitch";
import { connectServiceLoops } from "./planner/loop";
import { mergeFragmentEdges } from "./planner/fragmentEdges";
import { finishDeadEnds } from "./planner/deadEnds";
import { connectGroundJunctions } from "./planner/junctions";
import { buildLandingCircles } from "./planner/landing";
import { buildJunctionRings, type JunctionRing } from "./planner/junctionRings";
import { rampLowZoneDiscs } from "./planner/rampLowZone";
import { planHighwayRamps, type HighwayRamp } from "./planner/highwayRamps";
import type { CityBlock, CityLayout, Parcel, PublicSite, RoadEdge, RoadNode, TerrainField, Vec2, Zone } from "./cityLayout";
import { clearsHighways, polygonDistance, roadNodeId, SegmentIndex, segmentDistance } from "./roadGeometry";
import { targetParcels } from "./scaleTier";
export { clearsHighways, polygonDistance, roadNodeId, SegmentIndex, segmentDistance } from "./roadGeometry";
export { MAX_TIER, scaleTierFor, SESSIONS_PER_TIER, targetParcels } from "./scaleTier";

export type Biome = "tropical" | "temperate" | "boreal" | "savanna" | "eastasian";

/** 致敬型地标（SPEC §4.4）：程序化几何、不复刻具体建筑；纯装饰，不占会话地块、不进统计。 */
export type LandmarkKind = "tv-tower" | "sail-opera" | "arch" | "pagoda" | "lighthouse" | "ferris-wheel" | "suspension-bridge" | "twin-towers" | "twist-tower" | "villa-complex" | "islet-mansion" | "islet-grounds";
/** shore：海上小岛地标（歌剧院）的堤道陆地端；有它即「立在水中的岛上」，不适用陆地/岸滩规则。 */
export type Landmark = Vec2 & { id: string; kind: LandmarkKind; yaw: number; radius: number; to?: Vec2; shore?: Vec2; access?: PublicSite["access"];
  /** islet-mansion：原点到岸线的距离（码头长度据此铺到水里）；islet-grounds：小岛半径。 */
  reach?: number;
  /** islet-mansion：整栋缩放（豪宅岛环路外侧住宅小一号）。 */
  scale?: number;
  /** islet-grounds：哪座湾内岛的场地（豪宅 / 高尔夫 / 制片厂），缺省豪宅。 */
  variant?: "estate" | "golf" | "studio";
  /** islet-grounds（golf）：穿岛道路中线的局部 z。 */
  roadZ?: number };
const BIOMES: Biome[] = ["tropical", "temperate", "boreal", "savanna", "eastasian"];

/** Capacity is discontinuous when terrain/site/skeleton choices change. Never
 * extrapolate an almost-empty plan into a many-hundred-fold area expansion. */
/** unsupportedNudge（v2，2026-10-20）：一次尝试一个街区都没有（路网拓扑不成立：roadBlockReport road-faces-have-unresolved-topology）不是容量信号。
 *  曾按 0 地块去外推半径（被 maxAreaGrowth 截成 ×√2），基线岛 1703366229/t2 在 773.45 处拓扑失败，下一次直接
 *  长到 1094、4486 个地块（应 ~1900）。同半径下 dev 代码同样失败，是潜在的拓扑缺陷；这里只在拓扑失败时把半径
 *  微调 1% 重试，避开坏点，正常的容量校正不变。 */
export const RADIUS_CALIBRATION_CONFIG = { version: 2, maxRetries: 4, maxAreaGrowth: 2, capacityMargin: 1.04, unsupportedNudge: 1.01 };
export function nextCalibrationRadius(radius: number, required: number, available: number): number {
  if (![radius, required, available].every(Number.isFinite) || radius <= 0 || required <= 0 || available < 0) throw new RangeError("invalid capacity calibration input");
  if (available >= required) return radius;
  return radius * Math.min(Math.sqrt(RADIUS_CALIBRATION_CONFIG.maxAreaGrowth),
    Math.sqrt(required / Math.max(1, available)) * RADIUS_CALIBRATION_CONFIG.capacityMargin);
}

export type Shape = {
  stretch: number; spin: number;
  harmonics: Array<{ k: number; a: number; p: number }>;
  bays: Array<{ at: number; depth: number; width: number }>;
};

/** Shared seed recipe for worker transport hydration; never approximate the
 * returned terrain with a sampled grid or rerun full planning on the UI. */
export function createCityShape(seed: number): Shape {
  const random = (key: string) => hashSeed(`${seed}:${key}`);
  return {
    stretch: 0.78 + random("stretch") * 0.5,
    spin: random("spin") * Math.PI * 2,
    harmonics: [2, 3, 5].map((k) => ({ k, a: 0.05 + random(`h${k}`) * (k === 2 ? 0.16 : 0.1), p: random(`hp${k}`) * Math.PI * 2 })),
    bays: Array.from({ length: 1 + Math.floor(random("bays") * 3) }, (_, i) => ({ at: random(`bay${i}`) * Math.PI * 2, depth: 0.14 + random(`bayd${i}`) * 0.18, width: 0.18 + random(`bayw${i}`) * 0.25 })),
  };
}

/** 海岸配置里的中央海湾参数（worker 复算地理时用同一个换算，两边逐位一致）。 */
export function bayOf(config: CoastalConfig | null): BayOptions | null {
  return config && config.bayHalfWidth > 0 ? { halfWidth: config.bayHalfWidth, shift: config.bayShift } : null;
}

/** `opts.skipSolve` 仅供守卫（verify-city-solve）取「修复前」的草案；生产调用不传。 */
export type CityPlanOptions = { skipSolve?: boolean; memoizeTerrain?: boolean; legacyGridParcels?: boolean; workLedger?: PlanningWorkLedger };
export function createCityPlan(seed: number, tier = 2, config: CoastalConfig | null = null, opts: CityPlanOptions = {}) {
  if (!opts.workLedger) return createCityPlanDraft(seed, tier, config, opts);
  const ledger = opts.workLedger;
  const plan = withPlanningWorkLedger(ledger, () => createCityPlanDraft(seed, tier, config, opts));
  return { ...plan, workBudget: ledger.snapshot() };
}
function createCityPlanDraft(seed: number, tier: number, config: CoastalConfig | null, opts: CityPlanOptions) {
  const random = (key: string) => hashSeed(`${seed}:${key}`);
  // 岛形参数（与半径无关）：放大时形状不变。
  const shape = createCityShape(seed);
  // 海滨配置（VICE B1）：提供 config 时强制生态带（miami-coastal → tropical），
  // 否则保持原有随机五选一——无配置调用方行为不变。
  const biome: Biome = config ? config.biome : BIOMES[Math.floor(random("biome") * BIOMES.length) % BIOMES.length];
  // 先按档位估一个半径，再按实测地块数校正（最多 4 次）：面积 ∝ R²。
  // 起始估计：390 半径 ≈ 一档 400 会话的地皮，再按实测地块数校正。
  let radius = 390 * Math.sqrt(tier);
  let plan = buildPlan(seed, radius, shape, biome, config, tier, !!opts.skipSolve, opts.memoizeTerrain === true, opts.legacyGridParcels === true);
  let radiusAttempts = 0; // 诊断（批次 8 §5.7「先测再做」）：半径校正实际重建次数的分布
  const radiusHistory = [{ attempt: 0, radius, generatedParcels: plan.parcelGeneration.generated,
    available: plan.blocks.reduce((sum, block) => sum + block.parcels.length, 0), roads: plan.roadEdges.length, blocks: plan.blocks.length }];
  for (let attempt = 0; attempt < RADIUS_CALIBRATION_CONFIG.maxRetries; attempt += 1) {
    const parcels = plan.blocks.reduce((sum, block) => sum + block.parcels.length, 0);
    if (parcels >= targetParcels(tier)) break;
    radius = plan.blocks.length === 0 ? radius * RADIUS_CALIBRATION_CONFIG.unsupportedNudge : nextCalibrationRadius(radius, targetParcels(tier), parcels);
    plan = buildPlan(seed, radius, shape, biome, config, tier, !!opts.skipSolve, opts.memoizeTerrain === true, opts.legacyGridParcels === true);
    radiusAttempts += 1;
    radiusHistory.push({ attempt: radiusAttempts, radius, generatedParcels: plan.parcelGeneration.generated,
      available: plan.blocks.reduce((sum, block) => sum + block.parcels.length, 0), roads: plan.roadEdges.length, blocks: plan.blocks.length });
  }
  const availableParcels = plan.blocks.reduce((sum, block) => sum + block.parcels.length, 0);
  const planningOutcome = availableParcels < targetParcels(tier)
    ? { ...plan.planningOutcome, status: "failed" as const, reasons: [...plan.planningOutcome.reasons, "required parcel capacity remains unmet"] }
    : plan.planningOutcome;
  return { ...plan, planningOutcome, scaleTier: tier, biome, radiusAttempts, radiusHistory,
    capacity: { required: targetParcels(tier), available: availableParcels, satisfied: availableParcels >= targetParcels(tier) } };
}

function buildPlan(seed: number, R: number, shape: Shape, biome: Biome, config: CoastalConfig | null, tier: number, skipSolve: boolean, memoizeTerrain: boolean, legacyGridParcels: boolean) {
  spendPlanningWork("radius:attempt", { radiusAttempt: 1 });
  const random = (key: string) => hashSeed(`${seed}:${key}`);

  // ── L1 地理（V2 步 2a：逐字迁至 planner/geography.ts，random 无状态键控哈希、迁移不改调用序）──
  const geo = buildGeography(seed, R, shape, { memoize: memoizeTerrain, bay: bayOf(config) });
  const { coast, bbox, hasRiver, river, riverShift, riverX, riverWidth, coastDistance, landClearance, hillAngle, hillDir, hillLine, hillProj, height, buildable, terrain } = geo;

  // ── 核心点（V2 步 2a 迁出；步 4 起带环线成活率降分与出口弦净空，见 skeleton.ts）──
  let core = chooseCore(geo, seed, random);

  /** 从名义位置就近找可建地：同心环搜索，离岸/离河至少 clearance，与已放置点保持间距。 */
  const snap = (nominal: Vec2, clearance: number, placed: Array<Vec2 & { radius: number }>, radius: number, accept?: (q: Vec2) => boolean): Vec2 => {
    for (let ring = 0; ring <= 60; ring += 1) {
      const steps = Math.max(1, ring * 8);
      for (let k = 0; k < steps; k += 1) {
        const a = (k / steps) * Math.PI * 2 + ring * 0.37;
        const q = { x: nominal.x + Math.cos(a) * ring * 12, z: nominal.z + Math.sin(a) * ring * 12 };
        if (landClearance(q.x, q.z) < clearance || hillProj(q.x, q.z) > hillLine - clearance * 0.5) continue;
        if (placed.some((o) => Math.hypot(o.x - q.x, o.z - q.z) < o.radius + radius + 20)) continue;
        if (accept && !accept(q)) continue;
        return q;
      }
    }
    return nominal;
  };
  const around = (angle: number, distance: number): Vec2 => ({ x: core.x + Math.cos(angle) * distance, z: core.z + Math.sin(angle) * distance });
  const turn = random("siteTurn") * Math.PI * 2;

  // ── 公共用地：相对核心点放置再贴陆地（按条件选址在 G3 细化）。
  const publicSites: PublicSite[] = [];
  // Municipal commitments exist before either skeleton or joint site search.
  // A failed station/stadium candidate cannot erase its placement/access duty.
  const declaredSiteDemands: ConnectionDemand[] = ["civic-square", "observation-tower", "riverside-park",
    "working-harbor", "central-station", "east-stadium"].map((ownerId) => ({ id: `site:${ownerId}`,
      class: "site-access", required: true, anchor: ownerId, originAnchor: ownerId }));
  // 离水的最小距离：港口只要 ~24（堆场 1.5r×1.2r，近边正好落在水线上），其余预留地仍是 radius+14。
  // 曾一律 radius+14=51，港口中心被推到离水 ~60 的内陆，码头和吊车立在沙地上（拍照实测）。
  const siteClearance = (kind: string, radius: number) => (kind === "harbor" ? 24 : radius + 14);
  const place = (id: string, kind: PublicSite["kind"], nominal: Vec2, radius: number, yaw: number) => {
    const q = snap(nominal, siteClearance(kind, radius), publicSites, radius);
    publicSites.push({ id, kind, x: q.x, z: q.z, radius, yaw });
  };
  place("civic-square", "civic", core, 44, -0.15);
  // 步 4 起 chooseCore 的硬门保证 snap 的环 0 必然命中（广场 === 核心点，civicPlazaCentred 构造成立）；
  // 无门控候选的小岛仍走旧口径：广场被推离核心时，广场挪到哪里核心点就跟到哪里，
  // 否则环岛、放射主干道、高架都围着旧核心画，广场孤悬一旁（用户截图；30 岛里 10 个偏 12–60）。
  { const plaza = publicSites[publicSites.length - 1]; core = { x: plaza.x, z: plaza.z }; }
  place("observation-tower", "tower", around(turn + 0.9, 0.16 * R), 26, 0);
  // 开湾时公园放西岸（大陆、核心一侧）的湾边：东岸往里 60 正好是窄东岛上堤道上岸的地方，引道从公园里穿过
  // （seed 4001256748/1 档实测 roadThroughSite park d=28）。对应迈阿密市中心湾边的 Bayfront Park。
  const parkSide = geo.maxWaterSpan > 140 ? -1 : 1;
  place("riverside-park", "park", hasRiver ? { x: riverX(core.z + 0.18 * R) + parkSide * (riverWidth(core.z) + 60), z: core.z + 0.18 * R } : around(turn + 3.6, 0.3 * R), 47, 0);
  // 岸边用地（港口、岸边地标）的候选岸点：开湾时排除湾口那段轮廓——整岛轮廓在海湾两端横跨湾口，
  // 那几个「岸点」其实在湾面上；核心又贴着湾，最近的岸点正好落在湾口，港口被放进水里、路接不上
  // （seed 1703350391/2 档实测：港口中心离湾中线 38、湾半宽 100+）。窄河不变。
  const outerShore = geo.maxWaterSpan > 140 ? coast.filter((p) => Math.abs(p.x - riverX(p.z)) > riverWidth(p.z) + 40) : coast;
  {
    // 港口：离核心最近的一段海岸内侧（码头离市中心不远）。
    // 取离核心 ≥150 的最近岸点：核心贴海时（用户种子）曾取到市政广场旁的岸点，再被避让推进内陆，港口落在市中心（真机截图）。
    // 开湾时港口只放西岛外岸：东岛外岸是整段海滩（海滨带窗口 ~160°），港口落在里面会和海滩带贴脸
    // （seed 3668340084/1 档实测：港口离海滨带仅 12）。西岸没有岸点时才退回全部外岸。
    const westShore = geo.maxWaterSpan > 140 ? outerShore.filter((p) => p.x < riverX(p.z) - riverWidth(p.z)) : outerShore;
    const byDistance = [...(westShore.length ? westShore : outerShore)].sort((a, b) => Math.hypot(a.x - core.x, a.z - core.z) - Math.hypot(b.x - core.x, b.z - core.z));
    const shore = byDistance.find((p) => Math.hypot(p.x - core.x, p.z - core.z) >= 150) ?? byDistance[0];
    // 中心只内移 10：码头半边伸向水面（buildMarina 的栈桥由此入海）。
    const toCore = Math.max(1, Math.hypot(core.x - shore.x, core.z - shore.z));
    const inset = Math.min(10, toCore * 0.5);
    const inward = { x: shore.x + ((core.x - shore.x) / toCore) * inset, z: shore.z + ((core.z - shore.z) / toCore) * inset };
    place("working-harbor", "harbor", inward, 37, -Math.atan2(shore.z - core.z, shore.x - core.x));
  }

  // ── 致敬型地标：种子从候选里抽 2–3 座，按地理条件选址；和公共用地一样先于街区预留土地。
  const landmarks: Landmark[] = [];
  {
    const shoreOrder = [...outerShore].sort((p, q) => Math.hypot(p.x - core.x, p.z - core.z) - Math.hypot(q.x - core.x, q.z - core.z));
    const inwardFrom = (shore: Vec2, amount: number) => ({ x: shore.x + (core.x - shore.x) * amount, z: shore.z + (core.z - shore.z) * amount });
    const taken = () => [...publicSites, ...landmarks].map((site) => ({ x: site.x, z: site.z, radius: site.radius }));
    const candidates: Array<{ kind: LandmarkKind; weight: number; site: () => { at: Vec2; radius: number; clearance: number; yaw: number } | null }> = [
      { kind: "tv-tower", weight: 2, site: () => ({ at: around(turn + 0.4, 0.14 * R), radius: 16, clearance: 20, yaw: 0 }) },
      { kind: "twin-towers", weight: 1, site: () => ({ at: around(turn + 3.1, 0.12 * R), radius: 22, clearance: 20, yaw: turn }) },
      { kind: "twist-tower", weight: 1, site: () => ({ at: around(turn + 2.6, 0.17 * R), radius: 16, clearance: 20, yaw: 0 }) },
      { kind: "arch", weight: 1, site: () => ({ at: around(turn + 5.6, 0.26 * R), radius: 18, clearance: 20, yaw: turn + 5.6 }) },
      { kind: "sail-opera", weight: 2, site: () => { const shore = shoreOrder[Math.min(shoreOrder.length - 1, 3)]; return { at: inwardFrom(shore, 0.1), radius: 34, clearance: 16, yaw: -Math.atan2(shore.z - core.z, shore.x - core.x) }; } },
      { kind: "lighthouse", weight: 2, site: () => { const shore = shoreOrder[shoreOrder.length - 1]; return { at: inwardFrom(shore, 0.04), radius: 12, clearance: 6, yaw: 0 }; } },
      { kind: "ferris-wheel", weight: 2, site: () => { const shore = shoreOrder[Math.floor(shoreOrder.length * 0.45)]; return { at: inwardFrom(shore, 0.08), radius: 26, clearance: 14, yaw: -Math.atan2(shore.z - core.z, shore.x - core.x) + Math.PI / 2 }; } },
      { kind: "pagoda", weight: biome === "eastasian" ? 5 : 1, site: () => ({ at: { x: hillDir.x * (hillLine - 80), z: hillDir.z * (hillLine - 80) }, radius: 18, clearance: 18, yaw: hillAngle }) },
      // 地中海庄园：低层纪念性地标，天际线里「横向白楼 + 红陶坡顶」的断点。热带海滨优先；
      // 站位与帆顶剧院（shoreOrder[3]）错开；拱廊面（局部 +Z）朝向放置点看到的局部岸线方向，
      // 大岛上这与「朝城心反向」并不重合——平行水线才能读成滨海庄园。
      { kind: "villa-complex", weight: biome === "tropical" ? 4 : 1, site: () => { const shore = shoreOrder[Math.min(shoreOrder.length - 1, 5)]; const at = inwardFrom(shore, 0.08); return { at, radius: 34, clearance: 16, yaw: Math.atan2(shore.x - at.x, shore.z - at.z) }; } },
    ];
    // 数量随岛规模增长：1 档 4 座，每两档多一座，最多 7 座。曾固定抽 2–3 座：摩天轮只在 16/60 个种子里出现，
    // 真机反馈「原来的吊桥和摩天轮为什么没看见」。
    const count = Math.min(9, 6 + Math.floor((tier - 1) / 2)); // 固定地标增至 5 座（塔/庄园/摩天轮/歌剧院/灯塔），总数随之上调，仍给抽签留 1–4 席
    const pool = [...candidates];
    // Vice City 的第一眼轮廓需要一座 downtown 高塔；若完全按抽签，某些种子会
    // 只抽到灯塔/摩天轮/低矮文化馆，低会话量时整座城就像空地块规划图。
    // 高塔属于固定城市地标，不代表会话、不进数据统计；具体造型仍由 seed 决定。
    if (config?.profile === "miami-coastal") {
      const skylineKinds: LandmarkKind[] = ["twin-towers", "twist-tower"];
      const skylineKind = skylineKinds[Math.floor(random("miami-skyline") * skylineKinds.length)];
      const skylineIndex = pool.findIndex((candidate) => candidate.kind === skylineKind);
      if (skylineIndex >= 0) {
        const skyline = pool.splice(skylineIndex, 1)[0];
        // 双子塔与扭转塔二选一：固定高塔占位后，另一座不再进抽签池（曾在 5 档岛上两座同时出现）。
        for (let k = pool.length - 1; k >= 0; k -= 1) if (pool[k].kind === "twin-towers" || pool[k].kind === "twist-tower") pool.splice(k, 1);
        const site = skyline.site();
        if (site) {
          const q = snap(site.at, site.clearance, taken(), site.radius);
          landmarks.push({ id: `landmark:${skyline.kind}`, kind: skyline.kind, x: q.x, z: q.z, yaw: site.yaw, radius: site.radius });
        }
      }
    }
    // 摩天轮是海滨城的第二个固定标志（与高塔一样不代表会话），其余仍由种子抽选。
    if (config?.profile === "miami-coastal") {
      // 地中海庄园与摩天轮一样是海滨城固定地标（用户：「没有看见这些城市地标建筑物」——抽签抽不到就永远看不见）。
      // 海滨城识别锚点不靠抽签（用户：「种子彩票」——小档位的抽签名额被固定地标挤占，灯塔/帆顶剧院可能永远看不到）：
      // 帆形歌剧院与灯塔也固定放置，和庄园、摩天轮同一模式。
      for (const fixedKind of ["sail-opera", "lighthouse"] as LandmarkKind[]) {
        const index = pool.findIndex((candidate) => candidate.kind === fixedKind);
        if (index < 0) continue;
        const fixed = pool.splice(index, 1)[0];
        const site = fixed.site();
        if (!site) continue;
        const q = snap(site.at, site.clearance, taken(), site.radius);
        landmarks.push({ id: `landmark:${fixed.kind}`, kind: fixed.kind, x: q.x, z: q.z, yaw: site.yaw, radius: site.radius });
      }
      const villaIndex = pool.findIndex((candidate) => candidate.kind === "villa-complex");
      if (villaIndex >= 0) {
        const villa = pool.splice(villaIndex, 1)[0];
        const site = villa.site();
        if (site) {
          const q = snap(site.at, site.clearance, taken(), site.radius);
          landmarks.push({ id: `landmark:${villa.kind}`, kind: villa.kind, x: q.x, z: q.z, yaw: site.yaw, radius: site.radius });
        }
      }
      const wheelIndex = pool.findIndex((candidate) => candidate.kind === "ferris-wheel");
      if (wheelIndex >= 0) {
        const wheel = pool.splice(wheelIndex, 1)[0];
        const site = wheel.site();
        if (site) {
          const q = snap(site.at, site.clearance, taken(), site.radius);
          landmarks.push({ id: `landmark:${wheel.kind}`, kind: wheel.kind, x: q.x, z: q.z, yaw: site.yaw, radius: site.radius });
        }
      }
    }
    // 高塔已占一席；余下地标保持种子抽选。
    for (let n = landmarks.length; n < count && pool.length; n += 1) {
      const total = pool.reduce((sum, c) => sum + c.weight, 0);
      let pick = random(`landmark${n}`) * total;
      let index = 0;
      while (index < pool.length - 1 && pick >= pool[index].weight) { pick -= pool[index].weight; index += 1; }
      const chosen = pool.splice(index, 1)[0];
      // 双子塔与扭转塔同属 downtown 高塔：抽到一个就不再抽另一个。
      if (chosen.kind === "twin-towers" || chosen.kind === "twist-tower") for (let k = pool.length - 1; k >= 0; k -= 1) if (pool[k].kind === "twin-towers" || pool[k].kind === "twist-tower") pool.splice(k, 1);
      const site = chosen.site();
      if (!site) continue;
      const q = snap(site.at, site.clearance, taken(), site.radius);
      landmarks.push({ id: `landmark:${chosen.kind}`, kind: chosen.kind, x: q.x, z: q.z, yaw: site.yaw, radius: site.radius });
    }
  }
  /** 公共用地 + 地标：街区与地块都要避开的预留地。 */
  const reservations = () => [...publicSites, ...landmarks];

  // ── L2 骨架（CITY_PLANNING_SPEC §4.3）──
  // 主干道从核心放射、沿陆地延伸到海边，过河处自动成桥；环线高架绕核心一圈（沿陆地断续）；
  // 主干道之间每个扇区各铺一张朝向沿扇区放射方向的街网——不再是全岛一张方格（曾经整张方格盖在岛上）。
  // 路网原语（V2 步 2b-lite）：nodes/edges/key/addEdge 由 planner/network.ts 唯一实现，此处只留薄包装。
  const network = emptyNetwork();
  const { nodes, edges } = network;
  const coastalRoadEdgeIds = new Set<string>();
  const coastalRoadNodeIds = new Set<string>();
  const key = keyOf;
  const addEdge = (a0: Vec2, b0: Vec2, arterial: boolean, bridge = false, primary = false) => addNetworkEdge(network, a0, b0, arterial, bridge, primary);
  // 湾心小岛不是水面：穿岛堤道在岛上是一段地面路（两座桥之间），否则桥面压在岛上穿模（用户截图）。
  const inRiver = (x: number, z: number) => hasRiver && coastDistance(x, z) > 0 && Math.abs(x - riverX(z)) < riverWidth(z) && !(geo.isletClearance(x, z) > 0);
  // 占地谓词统一走 planner/footprint（V2 步 1）：此处只注入地理闭包；河岸带口径（不含 coastDistance）与
  // inRiver 不同，历史上就是两套判断，按原语义各自保留。
  const footprintGeo = { height, inRiver, riverBank: (x: number, z: number, bank: number) => hasRiver && Math.abs(x - riverX(z)) < riverWidth(z) + bank };

  // 岸边类集合由 sitespec 表派生（V2 网络优先 6b-2：值 === 原 Set 字面量，守卫 verify-city-sitespec 证相等）。
  const SHORE_SITE_KINDS = coastalSitingKinds(); // 庄园：临水拱廊，同属岸边地标
  // Selected landmarks are committed before roads; optional selection itself
  // remains a distinct capability, not a reason to drop an accepted owner.
  for (const site of landmarks) if (site.radius) declaredSiteDemands.push({ id: `site:${site.id}`,
    class: "site-access", required: true, anchor: site.id, originAnchor: site.id });
  // ── 骨架（V2 步 2b-full：逐字迁至 planner/skeleton.ts::buildSkeleton）──
  // Only accepted fixed reservations constrain this stage. Other nominal
  // candidates are deliberately reassigned in the frontage/shore passes below;
  // treating their temporary locations as immutable kills valid corridors.
  const fixedSkeletonSites = publicSites.filter((site) => site.kind === "civic" || site.kind === "harbor" || site.access);
  const fixedSkeletonLandmarks = landmarks.filter((site) => "access" in site && site.access);
  const skeletonReservationIds = [...fixedSkeletonSites, ...fixedSkeletonLandmarks].map((site) => site.id);
  const { trunks, bridges, ringRuns, primaryAnchorNodeId, primaryAnchorNodeIds, diagnostics: skeletonDiagnostics } = buildSkeleton({ geo, seed, core,
    publicSites: fixedSkeletonSites, landmarks: fixedSkeletonLandmarks, shoreSiteKinds: SHORE_SITE_KINDS, random, network, inRiver });
  const trunkRuns = trunks.map((trunk) => trunk.points);
  const trunkIndex = new SegmentIndex(trunkRuns);
  const distanceToTrunks = (p: Vec2) => polylineDistance(trunkRuns, p);

  // 主干按段（桥段剔除）与临路挪动四遍的显式依赖（V2 网络优先 6b-2：遍体逐字迁至 planner/access.ts；
  // trunkSegments 提前到避高架遍之前定义——纯计算无副作用，snap/siteClearance 环搜闭包按引用传入）。
  const trunkSegments = trunks.flatMap((trunk) => trunk.points.slice(1).map((b, k) => [trunk.points[k], b] as const))
    .filter(([a, b]) => !bridges.some((bridge) => bridge.to === b || bridge.from === a && bridge.to === b));
  // ── 用地临街（R5 步 5：逐字迁至 planner/siteFrontage.ts）：组 frontageCtx/shoreCtx → 避高架 → 岸边内移 → 跨路/临街/重贴干地
  // → 港口/岸边地标/歌剧院贴岸 → 联合站点（车站/体育场）落位与让位重试。publicSites/landmarks/network 原地改。
  const { sailOperaCandidateSets, siteObligations, jointSiteProgramme } = frontSitesAndAssignJointSites({ geo, core, turn, network, publicSites, landmarks,
    trunkRuns, trunkSegments, ringRuns, bridges, inRiver, riverBank: footprintGeo.riverBank, snap, siteClearance, primaryAnchorNodeId, reservations });
  const ringIndex = new SegmentIndex(ringRuns);
  const distanceToRing = (p: Vec2) => polylineDistance(ringRuns, p);

  // ── 海滨带 + 滨海大道（R5 步 3：逐字迁至 planner/seasideBoulevard.ts）──
  const { seaside, coastalRoadRuns, trimmedTrunkEnds } = buildSeasideBoulevard({ network, publicSites, landmarks, coast, hasRiver, riverX, riverWidth,
    coastDistance, height, coastalRoadEdgeIds, coastalRoadNodeIds }, { config, seed, core });

  // ── 环岛滨海路 + 河岸路（R5 步 4：逐字迁至 planner/coastalRingRoad.ts）──
  const { coastRoadRuns, coastalRunCount } = buildCoastalRingRoads({ network, coast, bbox, hasRiver, riverX, riverWidth, coastDistance, landClearance,
    hillProj, hillLine, height, inRiver, reservations, ringIndex }, { core, seaside });
  const coastRoadIndex = new SegmentIndex(coastRoadRuns);

  // 两端都接入陆侧主干道，避免只有拓扑连通但车辆到大道时会瞬移/断头。
  // 连接线按 4 单位采样，避让水面、陡坡、海岸和市政/地标预留地。
  const safeRoadLink = (a: Vec2, b: Vec2) => {
    const distance = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(distance / 4));
    for (let i = 0; i <= steps; i += 1) {
      const p = { x: a.x + (b.x - a.x) * i / steps, z: a.z + (b.z - a.z) * i / steps };
      if (!buildable(p.x, p.z) || terrain.slope(p.x, p.z) > 0.9) return false;
      if (reservations().some((site) => Math.hypot(p.x - site.x, p.z - site.z) < site.radius + 5)) return false;
    }
    return true;
  };
  // ── 接入路（Parish–Müller 式 localConstraints）：把一个端点「垂直」接到最近的已有路段上，
  // 落点把那条路切成 T 路口；落点离路段端点 <12 时吸附到端点（不留碎段）。拒绝：与被接道路夹角 <60°、
  // 与其它道路交叉、穿过水面/陡坡/预留地。曾经直连「700/400 内最近的主干道节点」：
  // 不看角度、不看沿途道路——真机里那束 X 形长斜线与 8° 锐角路口都出自这里（docs/CITY_ROAD_PLANNING_AUDIT.md）。
  // ── 统一连接器（网络优先批次 4-2）：本函数改走 planner/connect.ts 的 direct-projection 策略，
  // 经 commitNetworkPatch 事务提交；搜索判据逐字保留（投影/吸附/夹角/safeRoadLink/clearAngle/交叉），
  // 规划基线哈希不变是行为等价的证明。
  // 高架落地端低段禁行区（planner/rampLowZone.ts）：只并进连接器的预留——新地面路绕开低段；用地/地块不受影响。
  const rampLowZones = rampLowZoneDiscs(ringRuns);
  const connectorWorld: ConnectorWorld = { network, geo, inRiver, reservations: () => [...reservations(), ...rampLowZones] };
  let connectSeq = 0;
  const connectToNetwork = (endpoint: Vec2, maxDistance: number, arterial: boolean, exclude: (edge: RoadEdge) => boolean = () => false, minAngle = 60): boolean =>
    runConnection({
      id: `connect:${connectSeq += 1}`,
      source: endpoint,
      target: { kind: "edges", include: (edge) => !exclude(edge) },
      purpose: "district-access",
      allowBridge: false,
      maxLength: maxDistance,
      roadClass: arterial ? "arterial" : "local",
      minAngleDeg: minAngle,
    }, connectorWorld, { strategies: ["direct-projection"] }).ok;
  for (const p of trimmedTrunkEnds) connectToNetwork(p, 40, true, (edge) => !coastalRoadEdgeIds.has(edge.id), 35);
  for (const segment of coastalRoadRuns) {
    if (segment.length < 2) continue;
    for (const endpoint of [segment[0], segment[segment.length - 1]]) {
      connectToNetwork(endpoint, 160, true, (edge) => coastalRoadEdgeIds.has(edge.id));
    }
  }

  // 分区判定 + 扇区街网（R5 步 6b：逐字迁至 planner/sectorBlocks.ts）：zoneFor 的惰性主干索引、街区网格、
  // 经 commitFixedLink 事务加街；网络原地改，blocks/parcelBuilders/frontNodes/roadGenerationDiagnostics 作返回值。
  const { zoneFor, blocks, roadGenerationDiagnostics, parcelBuilders, frontNodes } = buildSectorBlocks({ R, core, trunks, random, network,
    connectorWorld, seaside, buildable, coastDistance, reservations, key, trunkIndex, ringIndex, coastRoadIndex });

  // 街网缝合（R5 步 6s：逐字迁至 planner/streetStitch.ts）：沿海路断头互接 → 环岛路 T 接 → 中途节点切边 → 首排角点接主干道 → 大道端接入。
  // 网络原地改（经 connectToNetwork / runConnection / addEdge），顺序不变。
  stitchStreetNetwork({ network, connectorWorld, connectToNetwork, addEdge, key, safeRoadLink, coastRoadRuns, coastalRoadRuns, coastRoadIndex,
    trunkIndex, coastalRoadEdgeIds, frontNodes });

  // 入口路（R2）：仍离路较远的用地/地标（岸边对象，或找不到临街位置的）从朝向最近道路的边缘
  // 拉一条支路接入路网——门前要有路（真机：双子塔、摩天轮、港口门前无路）。
  // 批次 5-1 桥接统一：堤道与「过水门前路」都改走连接器的显式桥候选（ground→bridge→ground
  // 三段、桥头干地与跨距校验、候选按距离前 40 个投影点），经事务补丁提交；判据逐字保留。
  // 批 A：堤道/门路的失败都如实进 connectionLog（诊断面，不进基线哈希）。
  const connectionLog: ConnectionAttempt[] = [];
  // 地面路口收口 → 孤立分量接入 → 逐用地入口路/堤道（R5 步 6e：逐字迁至 planner/siteEntrances.ts）。
  // connectionLog 须先于调用建好（connectGeneratedComponents 也写它）；network/publicSites/landmarks/bridges/connectionLog 原地改。
  const { junctionReport } = connectSiteEntrances({ geo, core, network, connectorWorld, connectToNetwork, connectGeneratedComponents,
    publicSites, landmarks, bridges, connectionLog, sailOperaCandidateSets, primaryAnchorNodeIds, reservations, seaside,
    coastRoadRuns, coastalRunCount, siteObligations, declaredSiteDemands });

  // ── 连通（网络优先批次 4-3）：各扇区街网可能被河/保留用地切成几块。并查集找连通分量，每个不含
  // 主网的分量经统一连接器接入。主网目标 = intent.primaryComponentId 的分量（离核心最近路端所在，
  // 批次 2 的主网定义），不许「接最近分量」——两个孤岛互连不等于接入主网。
  // 设计明令删除的 tolerance=[1,0.7,0] 不校验直连兜底（2026-10-08 实测：150 岛 141 条兜底边里
  // 63 条穿水、16 条不可建、2 条陡坡、9 条穿既有路）：禁止用降低硬约束换连通；失败进诊断
  // （intent 需求体系记 unmet + 本处 connectionLog 记原因），必要时允许局部分量保持隔离。
  function connectGeneratedComponents() {
    const parent = new Map<string, string>();
    const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let c = x; while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
    for (const id of nodes.keys()) parent.set(id, id);
    for (const edge of edges.values()) { const ra = find(edge.from); const rb = find(edge.to); if (ra !== rb) parent.set(ra, rb); }
    // 主网锚点：离核心最近的路端（与 intent.primaryComponentId 同规则；环路围绕核心，正常落在骨架分量上）。
    const primaryNodeId = primaryAnchorNodeId;
    const coreRoot = () => (primaryNodeId && nodes.has(primaryNodeId) ? find(primaryNodeId) : null);
    // 每个孤立分量按 localConstraints 垂直接入主网分量；接上一个就重算分量。
    // 逐级放宽：严格（≤220、≥60°）→ 放远放宽（≤400、≥35°）→ 连接器兜底阶梯（并线/绕行/有界 A*，全程校验）。
    const recompute = () => {
      for (const id of nodes.keys()) if (!parent.has(id)) parent.set(id, id);
      for (const edge of edges.values()) { const ra = find(edge.from); const rb = find(edge.to); if (ra !== rb) parent.set(ra, rb); }
    };
    for (let pass = 0; pass < 3; pass += 1) {
      recompute();
      const groupsNow = new Map<string, RoadNode[]>();
      for (const node of nodes.values()) { const r = find(node.id); const list = groupsNow.get(r); if (list) list.push(node); else groupsNow.set(r, [node]); }
      for (const [root, members] of groupsNow) {
        const target = coreRoot();
        if (!target || root === target) continue;
        const isPrimaryNode = (id: string) => find(id) === target;
        // pass 0/1 沿用历史的 top-12（按离主干距离）；pass 2 与历史兜底同覆盖面：并线遍历全部分量成员
        // （实测 seed 1927/t4：381 节点的分量，唯一合法并线点排在 top-12 之外，只试 12 个会漏掉），
        // 绕行/A* 只对头部成员执行（同分量内不同起点的可达性基本相同，A* 逐成员重跑纯费预算）。
        const ordered = [...members].sort((a, b) => distanceToTrunks(a) - distanceToTrunks(b));
        let linked = false;
        for (const member of pass < 2 ? ordered.slice(0, 12) : ordered) {
          const base = { source: member, target: { kind: "primary", isPrimaryNode } as const, purpose: "district-access", allowBridge: false, roadClass: "local" } as const;
          const result = pass < 2
            ? runConnection({ ...base, id: `isolate:${pass}:${member.id}`, maxLength: pass === 0 ? 220 : 400, minAngleDeg: pass === 0 ? 60 : 35 }, connectorWorld, { strategies: ["direct-projection"] })
            : runConnection({ ...base, id: `isolate:${pass}:${member.id}`, maxLength: 700 }, connectorWorld, { strategies: ["node-merge"] });
          if (pass === 2) connectionLog.push({ id: `isolate:${root}:${member.id}`, purpose: "district-access", ok: result.ok, strategy: result.ok ? result.strategy : undefined, reason: result.ok ? undefined : result.reason, detail: result.ok ? undefined : result.detail });
          if (result.ok) { linked = true; break; }
        }
        if (!linked && pass === 2) {
          for (const member of ordered.slice(0, 6)) {
            const result = runConnection({ source: member, target: { kind: "primary", isPrimaryNode }, id: `isolate:${pass}:${member.id}`, purpose: "district-access", allowBridge: false, maxLength: 700, roadClass: "local" }, connectorWorld, { strategies: ["detour", "grid-astar"] });
            connectionLog.push({ id: `isolate:${root}:${member.id}`, purpose: "district-access", ok: result.ok, strategy: result.ok ? result.strategy : undefined, reason: result.ok ? undefined : result.reason, detail: result.ok ? undefined : result.detail });
            if (result.ok) { linked = true; break; }
          }
        }
        if (!linked && pass === 2) {
          // 最后手段：并线角度从宽（转弯是软成本，设计 §4.1）——只放松端点净空角，走廊（水/坡/用地）
          // 与交叉检查仍是硬约束；质量代价由 acuteJunctions 约束如实度量。被删除的 tolerance 兜底
          // 连水/坡/用地/交叉都不查，本档是其合法化替代（实测 seed 1927/t4：381 节点分量与主网最近
          // 一对仅隔 2.7 单位、走廊干净，唯端点角 <35°，严格档拒之门外会把整个街区留在主网之外）。
          for (const member of ordered) {
            const result = runConnection({ source: member, target: { kind: "primary", isPrimaryNode }, id: `isolate:${pass}:${member.id}`, purpose: "district-access", allowBridge: false, maxLength: 700, roadClass: "local" }, connectorWorld, { strategies: ["node-merge"], anglePolicy: "relaxed" });
            connectionLog.push({ id: `isolate-relaxed:${root}:${member.id}`, purpose: "district-access", ok: result.ok, strategy: result.ok ? result.strategy : undefined, reason: result.ok ? undefined : result.reason, detail: result.ok ? undefined : result.detail });
            if (result.ok) { linked = true; break; }
          }
        }
        if (!linked && pass === 2) {
          // 跨河档（设计 §4.2「跨河允许 ground→bridge→ground」）：连续水段 ≤84 才可成桥——跨距上限
          // 本身就排除了跨海长桥（不从「遇水」自动推断可修桥的落点）。桥头干地/用地避让/落点拆边
          // 全在 bridge-candidate 判据内；桥梁注册表同步登记。实测 seed 123456789/t2：143 节点分量与
          // 主网隔一条 ~40 宽的河口，前几档全部 slope/water-span 拒绝。
          for (const member of ordered) {
            const result = runConnection({ source: member, target: { kind: "primary", isPrimaryNode }, id: `isolate:${pass}:${member.id}`, purpose: "district-access", allowBridge: true, maxLength: 700, roadClass: "local" }, connectorWorld, { strategies: ["bridge-candidate"], bridge: { blockers: reservations(), siteGate: true }, crossings: true });
            connectionLog.push({ id: `isolate-bridge:${root}:${member.id}`, purpose: "district-access", ok: result.ok, strategy: result.ok ? result.strategy : undefined, reason: result.ok ? undefined : result.reason, detail: result.ok ? undefined : result.detail });
            if (result.ok) {
              for (const span of result.bridgeSpans) bridges.push({ from: span.from, to: span.to, angle: Math.atan2(span.to.z - span.from.z, span.to.x - span.from.x), length: Math.hypot(span.to.x - span.from.x, span.to.z - span.from.z) });
              linked = true; break;
            }
          }
        }
        recompute();
      }
    }
  }

  // ── 尽端环路（lollipop service loop，G 批 2026-10-08）：连接器孤立分量阶梯之后的专用遍
  // （planner/loop.ts）。「包含/紧邻用地服务环的孤立分量」（体育场类：环形服务路不接主网、
  // 通向用地的路断头，用户截图 ②）以单入口接入——一根入口路从主网最近边（split 成 T 口）连到
  // 环上，环保持闭环。判据/入口角/确定性排序见 LOOP_CONFIG；入口路走 direct-projection 的地面
  // 走廊校验（水/坡/用地/交叉），事务提交；失败进 connectionLog（id 前缀 loop:），不静默。
  // 非服务环形态的残余分量（混合等级街区残片、<6 边碎枝）不属于本遍：如实保持隔离并计入
  // disconnectedComponents 诊断。
  connectServiceLoops({ world: connectorWorld, core, primaryAnchorNodeId, log: connectionLog });

  const parkTrees: CityLayout["parkTrees"] = [];
  const spanX = bbox.maxX - bbox.minX + 120; const spanZ = bbox.maxZ - bbox.minZ + 120;
  // 路段按 60 单位网格分桶：逐棵树对全部路段算距离是百万级运算（单岛 0.2–1 s 的主要来源）。
  const CELL = 60;
  const edgeBuckets = new Map<string, RoadEdge[]>();
  for (const edge of edges.values()) {
    const [a, b] = edge.points;
    for (let gx = Math.floor(Math.min(a.x, b.x) / CELL) - 1; gx <= Math.floor(Math.max(a.x, b.x) / CELL) + 1; gx += 1)
      for (let gz = Math.floor(Math.min(a.z, b.z) / CELL) - 1; gz <= Math.floor(Math.max(a.z, b.z) / CELL) + 1; gz += 1) {
        const key = `${gx}:${gz}`;
        const list = edgeBuckets.get(key);
        if (list) list.push(edge); else edgeBuckets.set(key, [edge]);
      }
  }
  // 山体植被（tinyskies 的教训：山不能光秃秃）——高度 3.2 以上、坡度可站立
  // （slope < 1.5）的山坡是主要林区；公园/河岸/近海沙滩维持原有条件。
  const slope = (x: number, z: number) => Math.hypot(height(x + 1, z) - height(x - 1, z), height(x, z + 1) - height(x, z - 1)) / 2;
  for (let i = 0; i < 2600; i += 1) {
    const x = bbox.minX - 60 + random(`tx${i}`) * spanX; const z = bbox.minZ - 60 + random(`tz${i}`) * spanZ;
    const h = height(x, z);
    const park = publicSites.some((s) => s.kind === "park" && Math.hypot(x - s.x, z - s.z) < s.radius - 5);
    const bank = Math.abs(x - riverX(z)) - riverWidth(z);
    const mountainside = h > 3.2 && h < 60 && slope(x, z) < 1.5;
    const wild = hillProj(x, z) > hillLine - 20 || coastDistance(x, z) < 30 || mountainside;
    if (h < 2.5 || (!park && !wild && !(hasRiver && bank < 23))) continue;
    if ((edgeBuckets.get(`${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`) ?? []).some((e) => segmentDistance({ x, z }, e.points[0], e.points[1]) < e.width / 2 + 3)) continue;
    parkTrees.push({ x, z, y: height(x, z), seed: random(`tree${i}`) });
  }
  // 碎边合并（planner/fragmentEdges.ts）：原地改写 network，见该文件头注。
  mergeFragmentEdges(network,{ publicSites, primaryAnchorNodeIds });

  const carPaths: Vec2[][] = [];
  const buildTrafficPaths = (blocks: CityBlock[], carPaths: Vec2[][]) => {
  carPaths.push(...blocks.filter((b, i) => b.parcels.length > 0 && i % 7 === 0).map((b) => {
    const boundary = b.roadBoundary ?? b.polygon;
    return [...boundary, boundary[0]];
  }));
  // 海滨大道车流沿海岸单向行驶，再通过真实路网回到起点；找不到完整地面回路时
  // 不生成假路线。返程搜索排除大道自身边，避免车辆在两端掉头后原路折返。
  const roadReturnPath = (from: Vec2, to: Vec2): Vec2[] | null => {
    const start = roadNodeId(key(from)); const goal = roadNodeId(key(to));
    const adjacency = new Map<string, string[]>();
    for (const id of nodes.keys()) adjacency.set(id, []);
    for (const edge of edges.values()) {
      if (coastalRoadEdgeIds.has(edge.id)) continue;
      adjacency.get(edge.from)?.push(edge.to); adjacency.get(edge.to)?.push(edge.from);
    }
    const previous = new Map<string, string | null>([[start, null]]); const queue = [start];
    for (let i = 0; i < queue.length && !previous.has(goal); i += 1) {
      for (const next of adjacency.get(queue[i]) ?? []) if (!previous.has(next)) { previous.set(next, queue[i]); queue.push(next); }
    }
    if (!previous.has(goal)) return null;
    const path: string[] = [];
    for (let cursor: string | null = goal; cursor; cursor = previous.get(cursor) ?? null) path.push(cursor);
    return path.reverse().map((id) => nodes.get(id)!).filter(Boolean).map(({ x, z }) => ({ x, z }));
  };
  for (const segment of coastalRoadRuns) {
    if (segment.length < 2) continue;
    const homeward = roadReturnPath(segment[segment.length - 1], segment[0]);
    if (homeward && homeward.length > 1) carPaths.push([...segment, ...homeward.slice(1)]);
    else {
      // Some valid beach segments have only one safe district-road access because
      // the opposite end is screened by river mouths/reservations. Keep deterministic
      // shuttle traffic on the rendered boulevard rather than wrapping/teleporting.
      carPaths.push([...segment, ...segment.slice(0, -1).reverse()]);
    }
  }
  };

  // 城区锚点：第一名执行环境在核心，其余绕核心等角分布再贴陆地，彼此至少隔 ~200。
  const anchorsPlaced: Array<Vec2 & { radius: number }> = [];
  const nominalAnchors = [core, around(turn + 1.6, 0.42 * R), around(turn + 3.7, 0.42 * R), around(turn + 5.3, 0.42 * R)];
  for (const nominal of nominalAnchors) {
    const q = snap(nominal, 40, [...anchorsPlaced, ...publicSites.map((site) => ({ x: site.x, z: site.z, radius: site.radius * 0.4 }))], 90);
    anchorsPlaced.push({ ...q, radius: 90 });
  }
  const districtAnchors = anchorsPlaced.map(({ x, z }) => ({ x, z }));

  // 高架：环线（沿陆地断续），取代原来按常量画在城北的一条直线。
  const highwayRuns: Vec2[][] = ringRuns;

  // 下游读的边界：全部由岛的实际包围盒推导（曾是常量 ±570 / -350..430 / 650 / 1600）。
  const urbanBounds = { left: bbox.minX + 30, right: bbox.maxX - 30, north: bbox.minZ + 30, south: bbox.maxZ - 30 };
  const boundsRadius = Math.max(bbox.maxX - bbox.minX, bbox.maxZ - bbox.minZ) / 2 + 40;
  const extent = Math.ceil((Math.max(Math.abs(bbox.minX), Math.abs(bbox.maxX), Math.abs(bbox.minZ), Math.abs(bbox.maxZ)) + 260) * 2 / 100) * 100;
  // 断头路收尾（planner/deadEnds.ts）：原地改写 network，接入路闭包原样传入。
  finishDeadEnds(network, { publicSites, landmarks, coastDistance, inRiver, connectToNetwork });

  // A failed skeleton placement remains a commitment. Road growth can expose
  // new legal frontage, so revisit only missing owners before any parcels are
  // accepted. This bounded phase never relocates an already-bound owner.
  for (const obligation of siteObligations.filter((entry) => !entry.placed)) {
    const programme = jointSiteProgramme.find(([id]) => id === obligation.ownerId);
    if (!programme || publicSites.some((site) => site.id === obligation.ownerId)) continue;
    const ownerRules = CONSTRAINTS.filter((rule) => ["siteInWater", "siteWithoutDoorRoad", "roadThroughSite",
      "sitesOverlap", "stationStadiumSetback", "stationDoorFacesRoad", "archStraddlesRoad", "unjoinedGroundJunctions",
      "crowdedArterials", "bridgeheadContinuity"].includes(rule.id));
    const view = (candidate: Network, sites: PublicSite[]) => ({ roadEdges: [...candidate.edges.values()],
      roadNodes: [...candidate.nodes.values()], publicSites: sites, landmarks, blocks: [], terrain, core, coast, river, waterEdges: geo.waterEdges,
      seaside, coastRoads: coastRoadRuns.slice(0, coastalRunCount), riverRoadRuns: coastRoadRuns.slice(coastalRunCount),
      primaryAnchorNodeId: primaryAnchorNodeIds.find((id) => candidate.nodes.has(id)) ?? null } as unknown as ConstraintPlan);
    const identity = (finding: { site?: string; at?: Vec2; detail?: string }) => JSON.stringify([finding.site, finding.at, finding.detail]);
    const baseline = new Map(ownerRules.map((rule) => [rule.id, new Set(rule.measure(view(network, publicSites)).map(identity))]));
    const assigned = assignConnectedSite({ ...geo, core, turn,
      trunkRuns: [...edges.values()].filter((edge) => !edge.bridge && atLeast(edge, "collector")).map((edge) => edge.points),
      ringRuns, bridges, placed: reservations(), height, inRiver, riverBank: footprintGeo.riverBank },
      connectorWorld, specByKind(programme[1])!, obligation.ownerId,
      primaryAnchorNodeIds.find((id) => nodes.has(id)) ?? null, (owner, candidate) => {
        for (const rule of ownerRules) if (rule.measure(view(candidate, [...publicSites, owner]))
          .some((finding) => !baseline.get(rule.id)!.has(identity(finding)))) return `post-growth-new-${rule.id}`;
        return null;
      });
    obligation.routeRetries = (obligation.routeRetries ?? 0) + (assigned.routeRetries ?? 0);
    if (!assigned.site || !assigned.network) {
      obligation.reason = `${obligation.reason ?? "initial placement failed"}; post-growth: ${assigned.reason ?? "no connected candidate"}`;
      continue;
    }
    commitNetwork(network, assigned.network);
    publicSites.push(assigned.site);
    obligation.placed = true; delete obligation.reason;
    // Trees are presentation drafts, not accepted parcels or service owners.
    for (let index = parkTrees.length - 1; index >= 0; index -= 1) {
      const tree = parkTrees[index];
      if (Math.hypot(tree.x - assigned.site.x, tree.z - assigned.site.z) < assigned.site.radius + 9
        || [...edges.values()].some((edge) => polylineDistance([edge.points], tree) < edge.width / 2 + 3)) parkTrees.splice(index, 1);
    }
  }

  // ── 桥头落地环（E 轨 2026-10-08，planner/landing.ts）：桥全部生成、断头收尾之后、solve 之前的一遍。
  // 桥的地面端方向失配（桥轴向与接地路向夹角 >25°）或接地路缺失/可被 solve 的 pruneShortSpurs
  // 删除时，桥头插入半径 10–14 的落地环——桥面端点落在环上、接地路接入环，环形吸收方向差，
  // 桥头的地面度数 ≥2 使「桥 +1 地面边」不再被当断头链删除。桥边与 bridges 注册表不动
  // （悬索桥装饰选址 withBridgeLandmark、nearBridgeEnd 桥头避让全部保持兼容）。树先于此遍放置，
  // 落到新增地面边上的按报告清除（与放置时的 width/2+3 同口径）。
  {
    const landingReport = buildLandingCircles({ network, geo, inRiver, sites: reservations, carPaths,
      pinned: new Set(ringRuns.flatMap((run) => [run[0], run[run.length - 1]].map((p) => roadNodeId(keyOf(p))))) });
    if (landingReport.addedEdges.length) {
      for (let t = parkTrees.length - 1; t >= 0; t -= 1) {
        const tree = parkTrees[t];
        if (landingReport.addedEdges.some((e) => segmentDistance(tree, e.a, e.b) < e.width / 2 + 3)) parkTrees.splice(t, 1);
      }
    }
  }

  // ── 路口环岛（planner/junctionRings.ts）：度 ≥5 / ≥3 条主干交汇建主干环岛，支路三岔/十字路口稀疏建小环。
  // 放在落地环之后、solve 之前：街区随后按最终路网生成，自然绕开环岛；被引用的折线（干道、岸路、滨海路、车流）同步改写成绕环。
  let junctionRings: JunctionRing[] = [];
  {
    const pinned = new Set<string>([
      ...[...publicSites, ...landmarks].flatMap((site) => site.access ? [site.access.nodeId] : []),
      ...primaryAnchorNodeIds,
      ...ringRuns.flatMap((run) => [run[0], run[run.length - 1]].map((p) => roadNodeId(keyOf(p)))),
    ]);
    const report = buildJunctionRings({ network, world: connectorWorld, core, random, routes: [carPaths, trunkRuns, coastRoadRuns, coastalRoadRuns], pinned });
    junctionRings = report.rings;
    if (junctionRings.length) {
      for (let t = parkTrees.length - 1; t >= 0; t -= 1) {
        const tree = parkTrees[t];
        if (junctionRings.some((ring) => Math.hypot(tree.x - ring.x, tree.z - ring.z) < ring.radius + ring.width / 2 + 3)) parkTrees.splice(t, 1);
      }
    }
  }

  // ── F1 闭环（CITY_ROAD_F1_ALGORITHM_SPEC）：路网不是一次生成就完事——所有改路步骤（接入路、断头路收尾、
  // 碎边合并）之后，对违规的用地/断头修复。修复遍已搬到 planner/repairs.ts，由 planner/solve.ts 的策略表按原顺序执行
  // （临街 → 推开穿路用地 → 绕行被截断的路 → 延伸断头；顺序见 solve.ts 头注释）。
  const repairCtx: RepairContext = { network, connectionLog, siteObligations, demandCatalogue: declaredSiteDemands, primaryAnchorNodeId: primaryAnchorNodeIds.find((id) => nodes.has(id)) ?? null, geo, height, inRiver, trunkRuns, bridges, publicSites, landmarks, blocks, ringRuns, coast, core, SHORE_SITE_KINDS, carPaths, seaside, coastRoadRunEnds: coastRoadRuns.flatMap((r) => [r[0], r[r.length - 1]]), coastRoadRuns, coastalRunCount, riverRoadRuns: coastRoadRuns.slice(coastalRunCount) };
  const solveReport = skipSolve ? null : solvePlan(repairCtx);
  if (skipSolve) initializeRepairPlanningWorld(repairCtx);
  // ── 高架立交匝道（planner/highwayRamps.ts）：高架跨越干道处做菱形立交，匝道走廊随后与高架一起作为街区生成的避让。
  let highwayRamps: HighwayRamp[] = [];
  {
    highwayRamps = planHighwayRamps({ highways: ringRuns, roads: [...network.edges.values()], buildable, sites: reservations() }).ramps;
    if (highwayRamps.length) {
      for (let t = parkTrees.length - 1; t >= 0; t -= 1) {
        const tree = parkTrees[t];
        if (highwayRamps.some((ramp) => ramp.points.some((p, k) => k > 0 && segmentDistance(tree, ramp.points[k - 1], p) < ramp.width / 2 + 3))) parkTrees.splice(t, 1);
      }
    }
  }

  let generatedParcels = 0;
  let roadBlockReport: RoadBlockReport | null = null;
  const derivedFinalization = runRepairDerivedFinalization(repairCtx, (draft) => {
  const blocks = draft.blocks, carPaths = draft.carPaths;
  if (legacyGridParcels) finalizeParcels(blocks);
  else {
    const roads = [...draft.network.edges.values()], faces = extractRoadFaces(roads);
    // This is a finite geometric slot bound, not an increased route/snap budget:
    // at most two frontage rows per real face, each slot retaining width 7.2.
    const maxCandidates = faces.faces.reduce((total, face) => total + 2 * face.boundary.reduce((count, point, index) => {
      const next = face.boundary[(index + 1) % face.boundary.length];
      return count + Math.floor(Math.hypot(next.x - point.x, next.z - point.z) / 7.2);
    }, 0), 0);
    const generated = generateRoadBlocks({ faces, roads,
      primaryAnchorNodeId: draft.primaryAnchorNodeId ?? null,
      networkVersion: draft.network.version,
      // 环岛中心岛按预留地处理：不在里面切地块（半径取到环道内缘）。
      districtFor: () => "", zoneFor, buildable, sites: [...draft.publicSites, ...draft.landmarks, ...junctionRings.map((ring, i) => ({ id: `junction-ring:${i}`, x: ring.x, z: ring.z, radius: Math.max(1, ring.radius - ring.width / 2) }))], highways: [...draft.ringRuns, ...highwayRamps.map((ramp) => ramp.points)],
      reserved: (point) => !!seaside && seasideStripContains(seaside, point, 1), maxCandidates,
      presentationSupportsHoles: true });
    roadBlockReport = generated.report;
    if (generated.report.status === "budget-exhausted" || generated.report.status === "cancelled") throw new Error(generated.report.status);
    const frontage = new Map(generated.access.map((proof) => [proof.parcelId, proof]));
    const sourceFaces = new Map(faces.faces.map((face) => [face.id, face]));
    for (const block of generated.blocks) {
      block.roadBoundary = sourceFaces.get(block.sourceFaceId)!.boundary.map((point) => ({ ...point }));
      for (const parcel of block.parcels) parcel.frontage = frontage.get(parcel.id);
    }
    blocks.splice(0, blocks.length, ...generated.blocks);
    generatedParcels = generated.report.accepted;
  }
  buildTrafficPaths(blocks, carPaths);
  // 车流折线的收口放在求解之后：修复（删冗余路段、切 T 路口、近距接入）会增删路段，车流必须按最终路网校验——
  // 曾放在求解之前，删路后海滨车流折线引用了已不存在的路段（verify-react-city-seaside 抓到）。
  // 接入路把已有路段切成 T 路口后，车流折线还按旧端点走：把落在线段上的路口节点按顺序插回去。
  {
    const allNodes = [...nodes.values()];
    for (let r = 0; r < carPaths.length; r += 1) {
      const route = carPaths[r]; const out: Vec2[] = [route[0]];
      for (let i = 1; i < route.length; i += 1) {
        const a = route[i - 1]; const b = route[i];
        const dx = b.x - a.x; const dz = b.z - a.z; const l2 = dx * dx + dz * dz || 1;
        const between = allNodes
          .map((n) => ({ n, t: ((n.x - a.x) * dx + (n.z - a.z) * dz) / l2 }))
          .filter(({ n, t }) => t > 1e-4 && t < 1 - 1e-4 && segmentDistance(n, a, b) < 0.02)
          .sort((x, y) => x.t - y.t);
        for (const { n } of between) out.push({ x: n.x, z: n.z });
        out.push(b);
      }
      carPaths[r] = out;
    }
    // 贴主干道那条边不再单独成路：绕街区一圈的车流若经过不存在的路段就整条丢弃（不让车开在没有路的地方）。
    const pairs = new Set([...edges.values()].map((edge) => [edge.from, edge.to].sort().join("/")));
    // 落地环批（2026-10-08）：桥头落地环会把既有路段重锚到环缘（桥头→环缘→对端，新折点不在原线段上），
    // 车流折线里失效的相邻对不再整条丢弃，而是改走当前路网的最短路（例如经落地环绕行）；
    // 折点本身被合并残点清除的（近失误重锚的 0.x–2 并点）先吸附 ≤2 内最近现存节点。仍无路可代才丢弃。
    const adjacency = new Map<string, string[]>();
    for (const id of nodes.keys()) adjacency.set(id, []);
    for (const edge of edges.values()) { adjacency.get(edge.from)?.push(edge.to); adjacency.get(edge.to)?.push(edge.from); }
    const bfsMiddle = (from: string, to: string): string[] | null => {
      if (from === to) return [];
      const previous = new Map<string, string | null>([[from, null]]); const queue = [from];
      for (let i = 0; i < queue.length && !previous.has(to); i += 1) {
        for (const next of adjacency.get(queue[i]) ?? []) if (!previous.has(next)) { previous.set(next, queue[i]); queue.push(next); }
      }
      if (!previous.has(to)) return null;
      const chain: string[] = [];
      for (let cursor: string | null = to; cursor && cursor !== from; cursor = previous.get(cursor) ?? null) chain.push(cursor);
      chain.shift(); // 去掉 to 本身（调用方随后压入 cur）
      return chain.reverse();
    };
    for (let r = carPaths.length - 1; r >= 0; r -= 1) {
      // 碎边合并/断头清理后，折线里可能留下相距 <1 的两个点（原来的碎边已并成一个节点）：把中间点并掉再核对，
      // 不因为一个 0.4 长的碎边就丢掉整条 220 点的车流回路（海滨大道回路因此消失，滨海车流守卫抓到）。
      const raw = carPaths[r];
      const route = raw.filter((q, i) => i === 0 || i === raw.length - 1 || Math.hypot(q.x - raw[i + 1].x, q.z - raw[i + 1].z) >= 1);
      // 折点被落地环并点/吞并清除的：≤2 内吸附最近现存节点（近失误重锚的 0.x–2 并点）；
      // 更远的（环内被吞节点）直接剔除折点——相邻存活点由下方的最短路经环绕行接回。
      const resnap: Vec2[] = [];
      for (const q of route) {
        if (nodes.has(roadNodeId(key(q)))) { resnap.push(q); continue; }
        let best: RoadNode | null = null;
        for (const n of nodes.values()) if (!best || Math.hypot(n.x - q.x, n.z - q.z) < Math.hypot(best.x - q.x, best.z - q.z)) best = n;
        if (best && Math.hypot(best.x - q.x, best.z - q.z) <= 2) resnap.push({ x: best.x, z: best.z });
      }
      const out: Vec2[] = [];
      let ok = true;
      for (let i = 0; i < resnap.length && ok; i += 1) {
        const cur = resnap[i];
        if (i > 0) {
          const prev = out[out.length - 1];
          if (roadNodeId(key(prev)) !== roadNodeId(key(cur)) && !pairs.has([roadNodeId(key(prev)), roadNodeId(key(cur))].sort().join("/"))) {
            const middle = bfsMiddle(roadNodeId(key(prev)), roadNodeId(key(cur)));
            if (!middle) { ok = false; break; }
            for (const id of middle) { const n = nodes.get(id); if (n) out.push({ x: n.x, z: n.z }); }
          }
        }
        if (!out.length || roadNodeId(key(out[out.length - 1])) !== roadNodeId(key(cur))) out.push(cur);
      }
      // A graph edge may be a bent polyline; endpoint adjacency alone must not
      // turn it into a straight traffic chord through the intervening terrain.
      const shaped: Vec2[] = out.length ? [out[0]] : [];
      for (let i = 1; i < out.length && ok; i += 1) {
        const from = roadNodeId(key(out[i - 1])), to = roadNodeId(key(out[i]));
        const edge = edges.get([from, to].sort().join("/"));
        if (!edge) { ok = false; break; }
        shaped.push(...(edge.from === from ? edge.points : [...edge.points].reverse()).slice(1));
      }
      if (!ok || shaped.length < 2) carPaths.splice(r, 1); else carPaths[r] = shaped;
    }
  }
  draft.landmarks.splice(0, draft.landmarks.length,
    ...withBridgeLandmark(draft.landmarks, bridges, random, highwayRuns, geo.islets));
  });
  if (!derivedFinalization.ok) generatedParcels = blocks.reduce((sum, block) => sum + block.parcels.length, 0);
  // 终筛：所有改路步骤（接入路、断头路收尾、碎边合并）之后，对每个地块统一核对「到任何路段的距离」。
  // 曾放在断头路收尾与碎边合并之前：那两步新增/移动的路段会压到地块上（凯旋门骑路改位后布局守卫抓到 gap 6.2）。
  // 块级检查只看街区四角与中心到主干道的距离，边中点更近的地块会漏过；连接支路又长达上百单位直穿街区、
  // 且在地块之后才加入——布局守卫抓到过 gap 6.4 的压路地块。
  function finalizeParcels(blocks: CityBlock[]) {
    for (const block of blocks) block.parcels = parcelBuilders.get(block.id)?.(block) ?? [];
    generatedParcels = blocks.reduce((sum, block) => sum + block.parcels.length, 0);
    const CELL = 60;
    const grid = new Map<string, RoadEdge[]>();
    for (const edge of edges.values()) {
      for (let segment = 1; segment < edge.points.length; segment += 1) {
      const a0 = edge.points[segment - 1], b0 = edge.points[segment];
      for (let gx = Math.floor(Math.min(a0.x, b0.x) / CELL) - 1; gx <= Math.floor(Math.max(a0.x, b0.x) / CELL) + 1; gx += 1)
        for (let gz = Math.floor(Math.min(a0.z, b0.z) / CELL) - 1; gz <= Math.floor(Math.max(a0.z, b0.z) / CELL) + 1; gz += 1) {
          const key2 = `${gx}:${gz}`;
          const list = grid.get(key2);
          if (list) list.push(edge); else grid.set(key2, [edge]);
        }
      }
    }
    for (const block of blocks) {
      block.parcels = block.parcels.filter((parcel) => {
        const need = Math.hypot(parcel.width, parcel.depth) / 2;
        return (grid.get(`${Math.floor(parcel.x / CELL)}:${Math.floor(parcel.z / CELL)}`) ?? []).every((edge) =>
          edge.points.slice(1).every((b, k) => segmentDistance(parcel, edge.points[k], b) >= need + edge.width / 2 + 0.5));
      });
    }
  }

  // ── 尽端回车点（路网形态批 §5-3，docs/CITY_PLANNER_V2_FINDINGS.md §5）：合法尽端
  // （EndpointRole cul-de-sac：滨海大道计划断点 planned-local / 近水终止 coast）语义上
  // 是计划内终点，几何上却是路戛然而止——把它们的坐标作为加性字段输出，渲染层据此画
  // 死胡同回车圈。classifyEndpoints 经 diagnoseNetwork 调用，只读（verify-city-intent
  // 已证诊断前后 plan 深比较一致），不改任何路网/用地字段，计划基线哈希不受影响。
  const plan = { blocks, roadNodes: [...nodes.values()], roadEdges: [...edges.values()], terrain, extent, coast, river, publicSites, parkTrees,
    urbanBounds, bridges, boundsRadius, carPaths, junctionRings, highwayRamps, coastRoads: coastRoadRuns.slice(0, coastalRunCount), riverRoadRuns: coastRoadRuns.slice(coastalRunCount), districtAnchors, highways: highwayRuns, core, islandRadius: R, landmarks, seaside, islets: geo.islets, waterEdges: geo.waterEdges,
    // 修复可能合并掉一个 civic 节点；只在骨架预先声明的锚点集合内重绑，不能选附近支路。
    connections: connectionLog, primaryAnchorNodeId: repairCtx.primaryAnchorNodeId ?? null, junctionReport, solveReport, siteObligations,
    demandCatalogue: repairCtx.demandCatalogue?.map((demand) => ({ ...demand })),
    planningOutcome: derivedFinalization.outcome,
    parcelSource: legacyGridParcels ? "legacy-grid" as const : "accepted-road-faces" as const, roadBlockReport,
    derivedFinalization: { ok: derivedFinalization.ok, ...(derivedFinalization.reason ? { reason: derivedFinalization.reason } : {}) },
    derivedNetworkVersion: network.version, skeletonDiagnostics, skeletonReservationIds, roadGenerationDiagnostics,
    parcelGeneration: { generated: generatedParcels, roadClearanceRejected: generatedParcels - blocks.reduce((sum, block) => sum + block.parcels.length, 0) } };
  const culDeSacEnds: Vec2[] = (diagnoseNetwork(plan)?.endpoints ?? [])
    .filter((endpoint) => endpoint.role.kind === "cul-de-sac")
    .map((endpoint) => endpoint.at);
  return { ...plan, culDeSacEnds };
}

/** 悬索大桥：有河桥时把最长的那座做成悬索桥（地标，不改路网）。曾按 55% 概率：用户的岛恰好没抽中。 */
function withBridgeLandmark(landmarks: Landmark[], bridges: CityLayout["bridges"], _random: (key: string) => number, highways: Vec2[][] = [], islets: Array<Vec2 & { radius: number }> = []): Landmark[] {
  if (!bridges.length) return landmarks;
  // 悬索桥的门式塔高 34、桥宽 12：环线高架（离地 8）若从桥身中段穿过，会直接穿过塔架与主缆（用户截图）。
  // 取最长的、且整段离高架 ≥ 36 的过河桥；都不满足就不做悬索桥（桥仍是普通桥）。
  const clearOfHighways = (b: CityLayout["bridges"][number]) => highways.every((run) => run.every((q, i) => { if (i === 0) return true; for (let k = 0; k <= 10; k += 1) { const t = k / 10; if (segmentDistance({ x: b.from.x + (b.to.x - b.from.x) * t, z: b.from.z + (b.to.z - b.from.z) * t }, run[i - 1], q) < 36) return false; } return true; }));
  // 穿过湾心小岛的堤道不做悬索桥：开湾后它往往是最长的一座，门式塔一座落水、一座贴岛，桥面压在岛上（用户截图）。
  const clearOfIslets = (b: CityLayout["bridges"][number]) => islets.every((islet) => segmentDistance(islet, b.from, b.to) > islet.radius * 1.25 + 20);
  const longest = [...bridges].sort((a, b) => b.length - a.length).find((b) => clearOfHighways(b) && clearOfIslets(b));
  if (!longest) return landmarks;
  return [...landmarks, { id: "landmark:suspension-bridge", kind: "suspension-bridge", x: longest.from.x, z: longest.from.z, to: longest.to, yaw: longest.angle, radius: 0 }];
}
