import { roadWidthFor } from "../roadStandard";
import type { RepairContext } from "./context";
import { isPlanningInterrupted, spendPlanningWork, checkPlanningWork } from "./operationBudget";
import { CONSTRAINTS } from "./constraints";
import { componentOf, diagnoseNetwork, primaryComponentId, remapDemandNode, retainRepairDemands } from "./intent";
import type { NetworkRemap } from "./network";
import type { ConnectionDemand } from "./intent";
import { DetMath as Math } from "../detMath";
import { localResiteCandidates, resiteViolatingSites } from "./siting";
import { joinNearMissEnds, connectLooseEnd, pruneShortSpurs, resolveAcuteJunctions, resolveCrowdedArterials, componentConnectionSources, connectDisconnectedComponent } from "./networkRepairs";
import { detourAroundSites, extendLooseEnds, frontStationsAndStadiums, nudgeSitesOffRoads, siteGeometry, shoreRelocationCandidates } from "./repairs";
import { snapNearJunctions, snapNearEdgeJunctions, snapShortCrossings, rerouteUnsafeGroundCrossings, trimLeafBeforeUnsafeCrossing, jointGroundRelineCandidates, relineGroundJunction, endpointRelineCandidates, relineLooseEndpoint, jointJunctionSiteCandidates, moveJunctionSite, relocatedSitePositionFailure } from "./snapJunctions";
import { normalizeGroundJunctions } from "./junctions";
import { consolidateTerminalCorridors } from "./consolidateCorridors";
import { applyNetworkReferences } from "./references";
import { groundJunctionFindings } from "./report";
import { groundFrontageSegments, straddleSitesAcrossTrunk } from "./access";
import { polylineDistance } from "./footprint";
import { canRelocateGroundSite, specByKind } from "./sitespec";
import { planarAccessPose, resolvePlanarAccess } from "../models/siteAccess";
import { applyWorldPatch, createPlanningWorld } from "./world";
import type { PlanningWorld, Reservation, WorldDemand, WorldOperation, WorldVersionDomain, WorldVersions } from "./world";
import { inspectModelGround, registeredModelGroundFailure } from "./modelGround";
import { GROUND_MODEL_FACTORIES } from "../models/groundRegistry";
import { prepareJointSiteRoadRelocation, relocateSiteWithGroundRoads } from "./jointSiteRoad";

/**
 * 规划求解循环（CITY_ARCHITECTURE §2 迁移步 5b）：把 buildPlan 尾部内联的修复遍登记成「约束 id → 修复策略」的表。
 *
 * 策略顺序保留原迁移表；现在逐策略在隔离草稿执行，接受检查通过才发布。
 * 顺序仍影响候选，但后一步不能以破坏已满足需求/安全关系换取自身分数：
 *   1. frontStationsAndStadiums  车站/体育场临街（先拉近，再转车站正面朝路）       ← stationDoorFacesRoad
 *   2. nudgeSitesOffRoads        路穿过用地中心的，沿离路方向推开（≤6 轮；岸边用地推不开则沿海岸换位，
 *                                即 repairs.ts::relocateShoreSite，它在每轮逐用地的兜底里被调用，无法与推开拆成两遍）← roadThroughSite
 *   3. detourAroundSites         被用地截断的两个共线断头，用绕用地外缘的折线接起来      ← looseInlandRoadEnds
 *   4. extendLooseEnds           其余内陆断头顺自己方向延伸到下一条路（≤2 遍）          ← looseInlandRoadEnds
 * 之后的「终筛」（按路段距离筛地块）不是修复路网而是收尾过滤，留在 cityPlan.ts。
 * 注册表继续复用旧候选策略；拒绝与原因进入产物 solveReport。
 */
export type RepairResult = number | { changes: number; reason?: string };
export type RepairStrategy = { constraint: string; name: string; run: (ctx: RepairContext) => RepairResult;
  candidates?: (ctx: RepairContext) => RepairStrategy[]; emptyReason?: (ctx: RepairContext) => string | undefined };
export const ARCH_RESITE_CONFIG = { version: 1, probes: [0.5, 0.25, 0.75] as readonly number[] };

/** A nominal arch is not a valid fallback. Once streets exist, retry only
 * unbound arches on actual continuous wide ground-road spans. */
export function resiteArchesOnAcceptedRoads(ctx: RepairContext): number {
  const bad = new Set(CONSTRAINTS.filter((constraint) => ["archStraddlesRoad", "siteInWater"].includes(constraint.id))
    .flatMap((constraint) => constraint.measure(planView(ctx))).filter((violation) => violation.site === "arch")
    .map((violation) => `${violation.at!.x}:${violation.at!.z}`));
  const arches = ctx.landmarks.filter((site) => site.kind === "arch" && !site.access && bad.has(`${site.x}:${site.z}`));
  if (!arches.length) return 0;
  const previousLoose = new Set(CONSTRAINTS.find((constraint) => constraint.id === "looseInlandRoadEnds")!.measure(planView(ctx))
    .map((violation) => `${violation.at!.x}:${violation.at!.z}`));
  const old = new Map(arches.map((site) => [site.id, { x: site.x, z: site.z, yaw: site.yaw }]));
  straddleSitesAcrossTrunk({ publicSites: ctx.publicSites, landmarks: ctx.landmarks,
    groundRoads: [...ctx.network.edges.values()].filter(road => !road.bridge),
    trunkSegments: groundFrontageSegments([...ctx.network.edges.values()]), ringRuns: ctx.ringRuns,
    straddleProbeFractions: ARCH_RESITE_CONFIG.probes,
    buildable: ctx.geo.buildable, height: ctx.geo.height, inRiver: ctx.inRiver,
    riverBank: (x, z, bank) => ctx.geo.hasRiver && Math.abs(x - ctx.geo.riverX(z)) < ctx.geo.riverWidth(z) + bank,
    relocateSiteIds: new Set(arches.map((site) => site.id)) });
  const changed = arches.filter((site) => { const before = old.get(site.id)!; return site.x !== before.x || site.z !== before.z || site.yaw !== before.yaw; }).length;
  return changed ? changed + repairExposedSiteEnds(ctx, previousLoose) : 0;
}

/** 朝向是独立候选，不要求接受旧批量临街策略的整组位置/容量变化。 */
function orientStationDoors(ctx: RepairContext): number {
  let changes = 0;
  for (const site of [...ctx.publicSites, ...ctx.landmarks]) {
    if (!canRelocateGroundSite(site)) continue;
    const access = resolvePlanarAccess(specByKind(site.kind)?.planarAccess, site.radius);
    if (!access.ok) continue;
    let best: { distance: number; x: number; z: number; id: string } | null = null;
    for (const edge of ctx.network.edges.values()) {
      if (edge.bridge) continue;
      for (let k = 1; k < edge.points.length; k += 1) {
        const a = edge.points[k - 1]; const b = edge.points[k];
        const dx = b.x - a.x; const dz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((site.x - a.x) * dx + (site.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        const x = a.x + dx * t; const z = a.z + dz * t; const distance = Math.hypot(x - site.x, z - site.z);
        if (!best || distance < best.distance || (distance === best.distance && edge.id < best.id)) best = { x, z, distance, id: edge.id };
      }
    }
    if (!best || best.distance < 0.01 || best.distance > site.radius + 90) continue;
    const yaw = planarAccessPose(access.access, site, { x: best.x - site.x, z: best.z - site.z }).yaw;
    if (yaw !== site.yaw) { site.yaw = yaw; changes += 1; }
  }
  return changes;
}

/** Site movement can expose a former proximity-exempt road end. Repair that
 * obligation inside the same isolated owner transaction, never after publish. */
function nudgeSiteWithAccessRepair(ctx: RepairContext, ownerId: string): number {
  const loose = CONSTRAINTS.find((constraint) => constraint.id === "looseInlandRoadEnds")!;
  const previous = new Set(loose.measure(planView(ctx)).map((violation) => `${violation.at!.x}:${violation.at!.z}`));
  const moved = nudgeSitesOffRoads(ctx, ownerId);
  if (!moved) return 0;
  return moved + repairExposedSiteEnds(ctx, previous);
}

/** Common to every owner relocation: disappearance of a proximity exemption
 * creates an obligation, not permission to hide or discard the road end. */
function repairExposedSiteEnds(ctx: RepairContext, previous: ReadonlySet<string>): number {
  const loose = CONSTRAINTS.find((constraint) => constraint.id === "looseInlandRoadEnds")!;
  let repaired = 0;
  const exposed = loose.measure(planView(ctx)).map((violation) => `${violation.at!.x}:${violation.at!.z}`).filter((id) => !previous.has(id)).sort();
  for (const id of exposed) {
    for (const strategy of ["direct-projection", "node-merge", "detour", "grid-astar"] as const) {
      const outcome = runRepairTransaction(ctx, { constraint: "looseInlandRoadEnds", name: `site-end:${id}:${strategy}`,
        run: (draft) => connectLooseEnd(draft, id, strategy) });
      repaired += outcome.changes;
      if (outcome.changes) break;
    }
  }
  if (loose.measure(planView(ctx)).some((violation) => !previous.has(`${violation.at!.x}:${violation.at!.z}`))) {
    repaired += pruneShortSpurs(ctx);
  }
  return repaired;
}

/** An otherwise dry coastal owner with a failed service route is still an
 * obligation. Reuse the existing coastal candidate budget, not a wider snap. */
function unservedShoreCandidates(ctx: RepairContext, constraint: "siteWithoutDoorRoad" | "siteInWater" | "roadThroughSite" | "sitesOverlap" = "siteWithoutDoorRoad"): RepairStrategy[] {
  const plan = planView(ctx), diagnostics = diagnoseNetwork(plan);
  const unmet = new Set(diagnostics?.demands.filter((entry) => entry.demand.required && !entry.satisfied
    && entry.demand.class === "site-access").map((entry) => entry.demand.anchor) ?? []);
  const wetFindings = constraint !== "siteWithoutDoorRoad" ? CONSTRAINTS.find((entry) => entry.id === constraint)!.measure(plan) : [];
  const groundGeo = { height: ctx.height, inRiver: ctx.inRiver };
  const groundFailed = new Set(constraint === "siteInWater" ? [...ctx.publicSites, ...ctx.landmarks]
    .filter(owner => registeredModelGroundFailure(owner, groundGeo)).map(owner => owner.id) : []);
  const isWetOwner = (owner: { id: string; kind: string; x: number; z: number }) => groundFailed.has(owner.id) || wetFindings.some((finding) =>
    (constraint === "sitesOverlap" && finding.identity?.split("/").includes(owner.id))
    || (finding.site === owner.kind && finding.at?.x === owner.x && finding.at?.z === owner.z));
  if (constraint !== "siteWithoutDoorRoad" ? !wetFindings.length && !groundFailed.size : !unmet.size) return [];
  const comp = componentOf(plan), primary = primaryComponentId(plan, comp);
  const primaryRoads = plan.roadEdges.filter((edge) => !edge.bridge && comp.get(edge.from) === primary).map((edge) => edge.points);
  const sites = [...ctx.publicSites, ...ctx.landmarks];
  const candidates: RepairStrategy[] = [];
  for (const owner of sites) {
    if (!owner.id || !(constraint !== "siteWithoutDoorRoad" ? isWetOwner(owner) : unmet.has(owner.id))
      || !canRelocateGroundSite(owner) || !ctx.SHORE_SITE_KINDS.has(owner.kind)) continue;
    const others = sites.filter((site) => site !== owner && site.radius);
    // Wet/foundation failures need the same declared coastal fallback as a
    // road-blocked owner, after its original local candidates are exhausted.
    function* positions() {
      if (constraint !== "siteWithoutDoorRoad") yield* localResiteCandidates(owner);
      yield* shoreRelocationCandidates(ctx, owner, siteGeometry(ctx, owner.id), others);
    }
    for (const at of positions()) {
      const placementFailure = relocatedSitePositionFailure(ctx, owner, at, true);
      const joint = constraint !== "siteWithoutDoorRoad" && placementFailure === "owner-road-envelope";
      if ((placementFailure && !joint) || polylineDistance(primaryRoads, at) > owner.radius + 20) continue;
      if (ctx.blocks.some((block) => block.parcels.some((parcel) => Math.hypot(parcel.x - at.x, parcel.z - at.z)
        < owner.radius + 9 + Math.hypot(parcel.width, parcel.depth) / 2))) continue;
      if (registeredModelGroundFailure({ ...owner, ...at }, groundGeo)) continue;
      if (joint) {
        if (prepareJointSiteRoadRelocation(ctx, owner.id, at).ok) candidates.push({ constraint,
          name: `resiteGroundJointRoad:${owner.id}:${at.x}:${at.z}`, run: draft => relocateSiteWithGroundRoads(draft, owner.id, at) });
        continue;
      }
      candidates.push({ constraint, name: `${constraint === "siteInWater" ? "resiteWetShore" : "resiteUnservedShore"}:${owner.id}:${at.x}:${at.z}`, run: (draft) => {
        const site = [...draft.publicSites, ...draft.landmarks].find((entry) => entry.id === owner.id);
        const missing = constraint !== "siteWithoutDoorRoad" ? !!site && ((constraint === "siteInWater" && registeredModelGroundFailure(site, { height: draft.height, inRiver: draft.inRiver }))
          || CONSTRAINTS.find((entry) => entry.id === constraint)!.measure(planView(draft))
            .some((finding) => (constraint === "sitesOverlap" && finding.identity?.split("/").includes(site.id))
              || (finding.site === site.kind && finding.at?.x === site.x && finding.at?.z === site.z)))
          : diagnoseNetwork(planView(draft))?.demands.some((entry) => entry.demand.anchor === owner.id
            && entry.demand.class === "site-access" && !entry.satisfied);
        if (!missing || !site || !canRelocateGroundSite(site)) return 0;
        const failure = relocatedSitePositionFailure(draft, site, at, true);
        if (failure) return { changes: 0, reason: failure };
        if (draft.blocks.some((block) => block.parcels.some((parcel) => Math.hypot(parcel.x - at.x, parcel.z - at.z)
          < site.radius + 9 + Math.hypot(parcel.width, parcel.depth) / 2))) return { changes: 0, reason: "owner-parcel-envelope" };
        const groundFailure = registeredModelGroundFailure({ ...site, ...at }, { height: draft.height, inRiver: draft.inRiver });
        if (groundFailure) return { changes: 0, reason: groundFailure };
        const previousLoose = new Set(CONSTRAINTS.find((constraint) => constraint.id === "looseInlandRoadEnds")!
          .measure(planView(draft)).map((violation) => `${violation.at!.x}:${violation.at!.z}`));
        site.x = at.x; site.z = at.z;
        return 1 + repairExposedSiteEnds(draft, previousLoose);
      } });
    }
  }
  return candidates;
}

export const REPAIR_STRATEGIES: RepairStrategy[] = [
  { constraint: "disconnectedComponents", name: "connectDisconnectedComponents", run: () => 0,
    candidates: (ctx) => componentConnectionSources(ctx).flatMap((sourceId) =>
      (["direct-projection", "node-merge", "detour", "grid-astar"] as const).map((strategy) => ({
        constraint: "disconnectedComponents", name: `connectComponent:${sourceId}:${strategy}`,
        run: (draft) => connectDisconnectedComponent(draft, sourceId, strategy),
      }))) },
  { constraint: "unjoinedGroundJunctions", name: "consolidateTerminalCorridors", run: consolidateTerminalCorridors },
  { constraint: "unjoinedGroundJunctions", name: "snapNearJunctions", run: snapNearJunctions },
  { constraint: "unjoinedGroundJunctions", name: "snapNearEdgeJunctions", run: snapNearEdgeJunctions,
    candidates: (ctx) => groundJunctionFindings([...ctx.network.edges.values()]).flatMap((finding) =>
      [false, true].map((preferHost) => ({ constraint: "unjoinedGroundJunctions",
        name: `snapNearEdge:${finding.id}:${preferHost ? "host" : "incoming"}`,
        run: (draft) => snapNearEdgeJunctions(draft, preferHost, finding.id),
      }))) },
  { constraint: "unjoinedGroundJunctions", name: "snapShortCrossings", run: snapShortCrossings },
  { constraint: "unjoinedGroundJunctions", name: "normalizeGroundJunctions", run: normalizeGroundJunctions },
  { constraint: "unjoinedGroundJunctions", name: "jointJunctionSite", run: () => 0,
    candidates: (ctx) => jointJunctionSiteCandidates(ctx).map(({ findingId, ownerId, at, shoreReassignment }) => ({
      constraint: "unjoinedGroundJunctions", name: `jointJunctionSite:${ownerId}:${findingId}:${at.x}:${at.z}${shoreReassignment ? ":shore" : ""}`,
      run: (draft) => {
        const previous = new Set(CONSTRAINTS.find((constraint) => constraint.id === "looseInlandRoadEnds")!.measure(planView(draft))
          .map((violation) => `${violation.at!.x}:${violation.at!.z}`));
        const result = moveJunctionSite(draft, findingId, ownerId, at, shoreReassignment);
        return result.changes ? { ...result, changes: result.changes + repairExposedSiteEnds(draft, previous) } : result;
      },
    })) },
  { constraint: "unjoinedGroundJunctions", name: "relineCrossingTerminal", run: () => 0,
    candidates: (ctx) => groundJunctionFindings([...ctx.network.edges.values()]).flatMap((finding) =>
      finding.edges.flatMap((id) => {
        const own = ctx.network.edges.get(id); if (!own) return [];
        return [own.from, own.to].flatMap((sourceId) => endpointRelineCandidates(ctx, sourceId)
          .filter((candidate) => finding.edges.includes(candidate.hostId)).map(({ hostId, at }) => ({
            constraint: "unjoinedGroundJunctions", name: `relineCrossingTerminal:${sourceId}:${hostId}:${at.x}:${at.z}`,
            run: (draft) => relineLooseEndpoint(draft, sourceId, hostId, at),
          })));
      })) },
  { constraint: "unjoinedGroundJunctions", name: "jointGroundReline", run: () => 0,
    candidates: (ctx) => jointGroundRelineCandidates(ctx).map(({ edges, at }) => ({
      constraint: "unjoinedGroundJunctions", name: `jointGroundReline:${edges.join("|")}:${at.x}:${at.z}`,
      run: (draft) => relineGroundJunction(draft, edges, at),
    })) },
  { constraint: "unjoinedGroundJunctions", name: "rerouteUnsafeGroundCrossings", run: rerouteUnsafeGroundCrossings },
  { constraint: "unjoinedGroundJunctions", name: "trimLeafBeforeUnsafeCrossing", run: trimLeafBeforeUnsafeCrossing },
  { constraint: "stationDoorFacesRoad", name: "frontStationsAndStadiums", run: frontStationsAndStadiums },
  { constraint: "stationDoorFacesRoad", name: "orientStationDoors", run: orientStationDoors },
  { constraint: "archStraddlesRoad", name: "resiteArchesOnAcceptedRoads", run: resiteArchesOnAcceptedRoads },
  { constraint: "siteWithoutDoorRoad", name: "resiteUnservedShoreSites", run: () => 0, candidates: unservedShoreCandidates },
  { constraint: "roadThroughSite", name: "nudgeSitesOffRoads", run: nudgeSitesOffRoads },
  { constraint: "roadThroughSite", name: "nudgeSitesWithAccessRepair", run: () => 0,
    candidates: (ctx) => CONSTRAINTS.find((constraint) => constraint.id === "roadThroughSite")!.measure(planView(ctx))
      .flatMap((violation) => [...ctx.publicSites, ...ctx.landmarks].filter((site) => site.kind === violation.site
        && site.x === violation.at?.x && site.z === violation.at?.z && site.id).map((site) => site.id!)).sort()
      .map((id) => ({ constraint: "roadThroughSite", name: `nudgeSiteWithAccess:${id}`, run: (draft) => nudgeSiteWithAccessRepair(draft, id) })) },
  { constraint: "roadThroughSite", name: "resiteRoadBlockedShoreSites", run: () => 0,
    candidates: ctx => unservedShoreCandidates(ctx, "roadThroughSite") },
  { constraint: "sitesOverlap", name: "resiteOverlappingShoreSites", run: () => 0,
    candidates: ctx => unservedShoreCandidates(ctx, "sitesOverlap") },
  { constraint: "looseInlandRoadEnds", name: "detourAroundSites", run: detourAroundSites },
  { constraint: "looseInlandRoadEnds", name: "extendLooseEnds", run: extendLooseEnds,
    candidates: (ctx) => CONSTRAINTS.find((constraint) => constraint.id === "looseInlandRoadEnds")!.measure(planView(ctx))
      .map((violation) => `${violation.at!.x}:${violation.at!.z}`).sort().map((id) => ({
        constraint: "looseInlandRoadEnds", name: `extendLooseEnd:${id}`, run: (draft) => extendLooseEnds(draft, id),
      })) },
  // 以下三条会改变规划（删冗余路段），见 networkRepairs.ts 的三道保险；顺序在断头延伸之后，让「删出来的新断头」下一轮被延伸/修剪。
  { constraint: "crowdedArterials", name: "resolveCrowdedArterials", run: resolveCrowdedArterials },
  { constraint: "crowdedArterials", name: "resolveCrowdedWithEnds", run: (ctx) => {
    const changed = resolveCrowdedArterials(ctx);
    return changed ? changed + joinNearMissEnds(ctx) + pruneShortSpurs(ctx) : 0;
  } },
  { constraint: "acuteJunctions", name: "resolveAcuteJunctions", run: resolveAcuteJunctions },
  { constraint: "acuteJunctions", name: "resolveAcuteWithEnds", run: (ctx) => {
    const changed = resolveAcuteJunctions(ctx);
    return changed ? changed + joinNearMissEnds(ctx) + pruneShortSpurs(ctx) : 0;
  } },
  { constraint: "looseInlandRoadEnds", name: "joinNearMissEnds", run: joinNearMissEnds,
    candidates: (ctx) => CONSTRAINTS.find((constraint) => constraint.id === "looseInlandRoadEnds")!.measure(planView(ctx))
      .map((violation) => `${violation.at!.x}:${violation.at!.z}`).sort().flatMap((id) => {
        const primaryLeaf = [...ctx.network.edges.values()].some((edge) => !edge.bridge && edge.width === roadWidthFor("arterial") && (edge.from === id || edge.to === id));
        return (primaryLeaf ? [false, true] : [false]).flatMap((collector) =>
          (["direct-projection", "node-merge", "detour", "grid-astar"] as const).map((strategy) => ({
            constraint: "looseInlandRoadEnds", name: `joinNearMissEnd:${id}:${strategy}${collector ? ":collector" : ""}`,
            run: (draft) => connectLooseEnd(draft, id, strategy, collector),
          })));
      }) },
  { constraint: "looseInlandRoadEnds", name: "jointEndpointReline", run: () => 0,
    candidates: (ctx) => CONSTRAINTS.find((constraint) => constraint.id === "looseInlandRoadEnds")!.measure(planView(ctx))
      .map((violation) => `${violation.at!.x}:${violation.at!.z}`).sort().flatMap((sourceId) =>
        endpointRelineCandidates(ctx, sourceId).map(({ hostId, at }) => ({ constraint: "looseInlandRoadEnds",
          name: `jointEndpointReline:${sourceId}:${hostId}:${at.x}:${at.z}`, run: (draft) => relineLooseEndpoint(draft, sourceId, hostId, at),
        }))) },
  { constraint: "looseInlandRoadEnds", name: "pruneShortSpurs", run: pruneShortSpurs },
  // 选址后置（siting.ts）：路网定型后，对仍然入水/重叠的用地在候选表里重新落位。放在表尾，不动点循环会让前面的策略对新位置再跑一遍。
  { constraint: "siteInWater", name: "resiteWetShoreSites", run: () => 0, candidates: (ctx) => unservedShoreCandidates(ctx, "siteInWater"),
    emptyReason: (ctx) => [...ctx.publicSites, ...ctx.landmarks].some(owner => canRelocateGroundSite(owner) && ctx.SHORE_SITE_KINDS.has(owner.kind)
      && registeredModelGroundFailure(owner, { height: ctx.height, inRiver: ctx.inRiver }))
      ? "registered ground placement unsupported or original wet-shore candidate budget exhausted; no expanded search or fabricated water support" : undefined },
  { constraint: "siteInWater", name: "resiteViolatingSites", run: (ctx) => resiteViolatingSites(ctx, { skipWetShore: true }) },
];

export type SolveReport = Array<{ constraint: string; name: string; changes: number; declined: number; reasons: string[] }>;

/** 草稿只复制数据；地形函数保持只读，不复制或调用外部副作用。 */
function copyData<T>(value: T): T {
  if (value && typeof value === "object" && Object.isFrozen(value)) return value;
  if (value && typeof value === "object") spendPlanningWork("repair:clone-row", { cloneRow: 1 });
  if (Array.isArray(value)) return value.map(copyData) as T;
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, copyData(item)])) as T;
  if (value instanceof Set) return new Set(value) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyData(item)])) as T;
  return value;
}

class ProtectedDemandMutation extends Error {}
const protectedCatalogues = new WeakMap<RepairContext, readonly ConnectionDemand[]>();
const draftScopes = new WeakMap<RepairContext, { referenceCursor: number; failure?: string }>();
type RepairWorldState = { world: PlanningWorld; network: string; sites: string; blocks: string; reservations: string; bindings: string;
  height: RepairContext["height"]; terrain: string; terrainFunctions: Record<string, unknown>; inRiver: RepairContext["inRiver"] };
const repairWorldStates = new WeakMap<RepairContext, RepairWorldState>();
const sorted = <T extends { id: string }>(rows: T[]): T[] => rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const legacyPhysical = { status: "pending" as const, reason: "legacy planning admission; full model, foundation and entrance corridor proof is not registered" };
const unknownElevation = { status: "unknown" as const, reason: "swept terrain/foundation/deck elevation is not registered" };

/** Import observed geometry without upgrading circle/frontage heuristics into physical proof. */
function repairWorldProjection(ctx: RepairContext) {
  const catalogue = diagnoseNetwork(planView(ctx))?.demands.map(entry => entry.demand) ?? ctx.demandCatalogue ?? [];
  const demands: WorldDemand[] = catalogue.map(d => ({ id: d.id, purpose: d.class, required: d.required,
    ...(d.class === "site-access" ? { ownerId: d.anchor } : {}) }));
  const reservations: Reservation[] = [];
  for (const edge of sorted([...ctx.network.edges.values()])) reservations.push({ id: `road:${edge.id}`, ownerId: `road:${edge.id}`,
    purpose: "road-corridor", envelope: { type: "corridor", points: edge.points.map(p => ({ ...p })), width: edge.width },
    layer: edge.structure ?? (edge.bridge ? "deck" : "ground-road"), elevation: unknownElevation,
    state: "tentative", immutable: false, required: false, demandIds: [], physical: legacyPhysical });
  for (const site of sorted([...ctx.publicSites, ...ctx.landmarks])) {
    if (!site.id) continue;
    const demandIds = demands.filter(d => d.ownerId === site.id).map(d => d.id).sort();
    reservations.push({ id: `site:${site.id}`, ownerId: site.id, purpose: "model-and-access-space",
      envelope: site.radius ? { type: "proxy-circle", centre: { x: site.x, z: site.z }, radius: site.radius,
        reason: "legacy nominal plot; not actual model footprint or doorway" }
        : { type: "unregistered", anchor: { x: site.x, z: site.z }, reason: "model has no registered physical footprint" },
      layer: "model-unregistered", elevation: unknownElevation, state: "tentative",
      immutable: !!site.access || !!("shore" in site && site.shore) || specByKind(site.kind)?.mobility === "fixed",
      required: demands.some(d => demandIds.includes(d.id) && d.required), demandIds, physical: legacyPhysical });
  }
  for (const parcel of sorted(ctx.blocks.flatMap(block => block.parcels))) {
    const cos = Math.cos(parcel.yaw), sin = Math.sin(parcel.yaw);
    const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => ({
      x: parcel.x + x * parcel.width / 2 * cos + z * parcel.depth / 2 * sin,
      z: parcel.z - x * parcel.width / 2 * sin + z * parcel.depth / 2 * cos,
    }));
    reservations.push({ id: `parcel:${parcel.id}`, ownerId: parcel.id, purpose: "parcel-buildable-and-frontage",
      envelope: { type: "polygon", points }, layer: "ground", elevation: unknownElevation,
      state: "tentative", immutable: false, required: false, demandIds: [], physical: legacyPhysical });
  }
  for (const block of sorted([...ctx.blocks])) reservations.push({ id: `block:${block.id}`, ownerId: block.id,
    purpose: "block-face-and-service", envelope: block.polygon.length >= 3 ? { type: "polygon", points: block.polygon.map(p => ({ ...p })) }
      : { type: "unregistered", anchor: { x: Number.isFinite(block.x) ? block.x : ctx.core.x, z: Number.isFinite(block.z) ? block.z : ctx.core.z },
        reason: "block boundary is unregistered; anchor is a location hint only" },
    layer: "ground", elevation: unknownElevation, state: "tentative", immutable: false, required: false, demandIds: [], physical: legacyPhysical });
  const demandBindings = catalogue.map(d => ({ demandId: d.id, anchor: d.anchor, ...(d.originAnchor ? { originAnchor: d.originAnchor } : {}) }))
    .sort((a, b) => a.demandId < b.demandId ? -1 : a.demandId > b.demandId ? 1 : 0);
  return { demands, demandBindings, reservations: sorted(reservations),
    network: JSON.stringify({ nodes: sorted([...ctx.network.nodes.values()]), edges: sorted([...ctx.network.edges.values()]) }),
    sites: JSON.stringify({ publicSites: sorted([...ctx.publicSites]), landmarks: sorted([...ctx.landmarks]), obligations: ctx.siteObligations ?? [] }),
    blocks: JSON.stringify(sorted([...ctx.blocks])),
  };
}
function makeWorldState(ctx: RepairContext, world: PlanningWorld, projection = repairWorldProjection(ctx)): RepairWorldState {
  return { world, network: projection.network, sites: projection.sites, blocks: projection.blocks,
    reservations: JSON.stringify(projection.reservations), bindings: JSON.stringify(projection.demandBindings),
    height: ctx.height, terrain: JSON.stringify(ctx.geo.terrain),
    terrainFunctions: Object.fromEntries(Object.entries(ctx.geo.terrain).filter(([, value]) => typeof value === "function")), inRiver: ctx.inRiver };
}
function installRepairWorld(ctx: RepairContext, state: RepairWorldState): void {
  repairWorldStates.set(ctx, state);
  Object.defineProperty(ctx, "planningWorld", { enumerable: true, configurable: true,
    get: () => repairWorldStates.get(ctx)?.world,
    set: () => { throw new ProtectedDemandMutation("repair replaced protected planning world"); } });
}
function initialRepairWorld(ctx: RepairContext): RepairWorldState {
  const projection = repairWorldProjection(ctx);
  const versions = { network: ctx.network.version,
    site: 0, reservation: 0, terrain: 0, policy: 0, model: 0 };
  const world = createPlanningWorld({ versions, demands: projection.demands, demandBindings: projection.demandBindings, reservations: projection.reservations,
    sourceStatus: { network: "observed", site: "observed", reservation: "observed", terrain: "pending", policy: "pending", model: "pending" } });
  return makeWorldState(ctx, world, projection);
}
/** Call before the first production repair; counters start at the observed attempt, not a fabricated verified model version. */
export function initializeRepairPlanningWorld(ctx: RepairContext): PlanningWorld {
  const current = repairWorldStates.get(ctx);
  if (current) return current.world;
  const initial = initialRepairWorld(ctx);
  installRepairWorld(ctx, initial);
  return initial.world;
}
function worldBaseFailure(ctx: RepairContext, state: RepairWorldState): string | undefined {
  if (ctx.planningWorld && ctx.planningWorld !== state.world) return "repair planning-world authority replaced";
  const actualVersion = ctx.network.version;
  if (actualVersion !== state.world.versions.network) return "stale repair world: network version";
  if (ctx.height !== state.height || JSON.stringify(ctx.geo.terrain) !== state.terrain || ctx.inRiver !== state.inRiver ||
      Object.entries(state.terrainFunctions).some(([key, value]) => (ctx.geo.terrain as unknown as Record<string, unknown>)[key] !== value))
    return "stale repair world: terrain source changed";
  const projection = repairWorldProjection(ctx);
  if (projection.network !== state.network || projection.sites !== state.sites || projection.blocks !== state.blocks || JSON.stringify(projection.reservations) !== state.reservations ||
      JSON.stringify(projection.demandBindings) !== state.bindings)
    return "stale repair world: out-of-transaction geometry mutation";
}
function updatedRepairWorld(base: RepairWorldState, draft: RepairContext): { state?: RepairWorldState; reason?: string } {
  const projection = repairWorldProjection(draft), operations: WorldOperation[] = [];
  const old = new Map(base.world.reservations.map(r => [r.id, r]));
  const current = new Set(projection.reservations.map(r => r.id));
  for (const demand of projection.demands) if (!base.world.demands.some(d => d.id === demand.id)) operations.push({ type: "register-demand", demand });
  for (const binding of projection.demandBindings) {
    const prior = base.world.demandBindings.find(oldBinding => oldBinding.demandId === binding.demandId);
    if (JSON.stringify(prior) !== JSON.stringify(binding)) operations.push({ type: "bind-demand", binding,
      ...(prior ? { previousAnchor: prior.anchor } : {}) });
  }
  for (const reservation of projection.reservations) {
    const prior = old.get(reservation.id);
    if (!prior) operations.push({ type: "reserve", reservation });
    else if (JSON.stringify(prior) !== JSON.stringify(reservation)) operations.push({ type: "revise-tentative", reservation });
  }
  for (const prior of base.world.reservations) if (prior.state !== "released" && !current.has(prior.id)) {
    operations.push({ type: "transition", id: prior.id, to: "released", reason: "accepted repair removed legacy tentative geometry" });
  }
  const changedDomains: WorldVersionDomain[] = [];
  if (projection.network !== base.network) changedDomains.push("network");
  if (projection.sites !== base.sites) changedDomains.push("site");
  if (projection.blocks !== base.blocks) changedDomains.push("reservation");
  const result = applyWorldPatch(base.world, { expectedVersions: base.world.versions, operations, changedDomains });
  if (!result.ok) return { reason: result.reason };
  return { state: makeWorldState(draft, result.world, projection) };
}

/** Final consumers must not report unsafe success from legacy zero-violation heuristics. */
export function repairPlanningOutcome(ctx: RepairContext): {
  status: "degraded" | "failed"; versions?: WorldVersions; reasons: string[];
  requiredDemands: number; unmetDemandIds: string[]; pendingPhysicalReservations: number; unsupportedPhysicalReservations: number;
  groundCoverage: { total: number; partial: number; violations: number; unsupported: number };
  groundFailures: Array<{ ownerId: string; reason: string }>;
} {
  const state = repairWorldStates.get(ctx), diagnostics = diagnoseNetwork(planView(ctx));
  const unmetDemandIds = diagnostics?.unmet.map(d => d.demandId) ?? [];
  const stale = state ? worldBaseFailure(ctx, state) : "production world is not initialized";
  const reservations = state?.world.reservations.filter(r => r.state !== "released") ?? [];
  const groundInspections = [...ctx.publicSites, ...ctx.landmarks].map(owner => ({ owner, inspection: inspectModelGround(owner, { height: ctx.height, inRiver: ctx.inRiver }) }));
  const groundFailures = groundInspections.flatMap(({ owner, inspection }) => inspection.status === "violation"
    ? [{ ownerId: owner.id, reason: inspection.findings.map(finding => finding.code).join(",") }]
    : inspection.status === "unsupported" && Object.hasOwn(GROUND_MODEL_FACTORIES, owner.kind) ? [{ ownerId: owner.id, reason: inspection.reason }] : []);
  const reasons = ["full model/foundation/entrance policy coverage is pending", "whole-plan operation budget/cancellation is not registered", ...(stale ? [stale] : []),
    ...(!diagnostics ? ["required primary network evidence missing"] : []), ...(unmetDemandIds.length ? ["required connection demands remain unmet"] : []),
    ...(groundFailures.length ? ["registered model ground admission remains failed or unsupported"] : [])];
  return { status: stale || !diagnostics || unmetDemandIds.length || groundFailures.length ? "failed" : "degraded", versions: state?.world.versions,
    reasons, requiredDemands: diagnostics?.demands.filter(d => d.demand.required).length ?? 0, unmetDemandIds,
    pendingPhysicalReservations: reservations.filter(r => r.physical.status === "pending").length,
    unsupportedPhysicalReservations: reservations.filter(r => r.physical.status === "unsupported").length,
    groundCoverage: { total: groundInspections.length, partial: groundInspections.filter(entry => entry.inspection.status === "partial").length,
      violations: groundInspections.filter(entry => entry.inspection.status === "violation").length,
      unsupported: groundInspections.filter(entry => entry.inspection.status === "unsupported").length }, groundFailures };
}

/** Explicit last derived producer: never call after independently mutating the authority arrays.
 * Only unpublished parcel/traffic products and new non-plot model decorations may change.
 * This publishes a consistent tentative world, not physical acceptance or a frozen success.
 */
export function runRepairDerivedFinalization(ctx: RepairContext, derive: (draft: RepairContext) => void): {
  ok: boolean; reason?: string; outcome: ReturnType<typeof repairPlanningOutcome>;
} {
  try { return repairDerivedFinalizationDraft(ctx, derive); }
  catch (error) {
    if (isPlanningInterrupted(error)) throw error;
    const reason = error instanceof Error ? error.message : "invalid derived finalization", outcome = repairPlanningOutcome(ctx);
    return { ok: false, reason, outcome: { ...outcome, status: "failed", reasons: [...outcome.reasons, `derived finalization rejected: ${reason}`] } };
  }
}
function repairDerivedFinalizationDraft(ctx: RepairContext, derive: (draft: RepairContext) => void): ReturnType<typeof runRepairDerivedFinalization> {
  const base = repairWorldStates.get(ctx) ?? initialRepairWorld(ctx);
  const fail = (reason: string): ReturnType<typeof runRepairDerivedFinalization> => {
    const outcome = repairPlanningOutcome(ctx);
    return { ok: false, reason, outcome: { ...outcome, status: "failed", reasons: [...outcome.reasons, `derived finalization rejected: ${reason}`] } };
  };
  const stale = worldBaseFailure(ctx, base);
  if (stale) return fail(stale);
  const draft = copyData(ctx);
  installRepairWorld(draft, makeWorldState(draft, base.world));
  installDemandCatalogue(draft, diagnoseNetwork(planView(ctx))?.demands.map(entry => entry.demand) ?? ctx.demandCatalogue ?? []);
  try { derive(draft); }
  catch (error) { if (isPlanningInterrupted(error)) throw error; return fail(error instanceof Error ? error.message : "derived finalization failed"); }
  if (draft.planningWorld !== repairWorldStates.get(draft)?.world || draft.demandCatalogue !== protectedCatalogues.get(draft))
    return fail("derived finalization replaced protected authority");
  const projection = repairWorldProjection(draft);
  if (projection.network !== base.network) return fail("derived finalization changed accepted network");
  const previousOwners = [...ctx.publicSites, ...ctx.landmarks], nextOwners = [...draft.publicSites, ...draft.landmarks];
  if (previousOwners.some(owner => JSON.stringify(owner) !== JSON.stringify(nextOwners.find(next => next.id === owner.id))) ||
      nextOwners.some(owner => !previousOwners.some(previous => previous.id === owner.id) && owner.radius !== 0))
    return fail("derived finalization changed a plot owner");
  for (const field of ["bridges", "core", "ringRuns", "trunkRuns", "coast", "coastRoadRuns", "riverRoadRuns", "coastRoadRunEnds", "siteObligations", "primaryAnchorNodeId"] as const)
    if (JSON.stringify(ctx[field]) !== JSON.stringify(draft[field])) return fail(`derived finalization changed ${field}`);
  if (ctx.height !== draft.height || ctx.inRiver !== draft.inRiver || JSON.stringify(ctx.geo.terrain) !== JSON.stringify(draft.geo.terrain) ||
      Object.entries(base.terrainFunctions).some(([key, value]) => (draft.geo.terrain as unknown as Record<string, unknown>)[key] !== value))
    return fail("derived finalization changed terrain source");
  const pointKey = (p: { x: number; z: number }) => `${Math.round(p.x * 100)}:${Math.round(p.z * 100)}`;
  const roadSegments = new Set<string>();
  for (const edge of draft.network.edges.values()) for (let i = 1; i < edge.points.length; i += 1) {
    const a = pointKey(edge.points[i - 1]), b = pointKey(edge.points[i]);
    roadSegments.add(`${a}/${b}`); roadSegments.add(`${b}/${a}`);
  }
  for (const path of draft.carPaths) {
    if (path.length < 2 || path.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.z))) return fail("invalid derived traffic path");
    for (let i = 1; i < path.length; i += 1) if (!roadSegments.has(`${pointKey(path[i - 1])}/${pointKey(path[i])}`))
      return fail("derived traffic segment does not follow actual road polyline");
  }
  const beforeDemands = diagnoseNetwork(planView(ctx))?.demands ?? [], afterDemands = diagnoseNetwork(planView(draft))?.demands ?? [];
  if (beforeDemands.some(entry => entry.demand.required && (!afterDemands.some(next => next.demand.id === entry.demand.id) ||
      (entry.satisfied && !afterDemands.some(next => next.demand.id === entry.demand.id && next.satisfied)))))
    return fail("derived finalization lost a required demand");
  const recheck = worldBaseFailure(ctx, base);
  if (recheck) return fail(recheck);
  const publication = updatedRepairWorld(base, draft);
  if (!publication.state) return fail(publication.reason ?? "derived world publication failed");
  acceptDraft(ctx, draft, [], publication.state);
  return { ok: true, outcome: repairPlanningOutcome(ctx) };
}

/** No strategy can erase a promise, even temporarily before a nested call.
 * Binding updates are dispatcher-owned and visible through the same getter. */
function installDemandCatalogue(ctx: RepairContext, demands: readonly ConnectionDemand[]): void {
  const reject = (): never => { throw new ProtectedDemandMutation("repair modified protected demand catalogue"); };
  const traps = { set: reject, deleteProperty: reject, defineProperty: reject, setPrototypeOf: reject };
  const catalogue = new Proxy(demands.map((demand) => new Proxy({ ...demand }, traps)), traps);
  protectedCatalogues.set(ctx, catalogue);
  Object.defineProperty(ctx, "demandCatalogue", { enumerable: true, configurable: true,
    get: () => protectedCatalogues.get(ctx), set: reject });
}

/** Parent journals are flushed before a nested transaction takes its snapshot.
 * Already-consumed child journals remain as evidence, never applied twice. */
function flushDraftReferences(ctx: RepairContext): string | null {
  const scope = draftScopes.get(ctx);
  if (!scope) return null;
  if (scope.failure) return scope.failure;
  if (ctx.demandCatalogue !== protectedCatalogues.get(ctx)) return scope.failure = "repair replaced protected demand catalogue";
  const remaps = (ctx.network.patchRemaps ?? []).slice(scope.referenceCursor);
  const failure = applyNetworkReferences(ctx, remaps);
  if (failure) return scope.failure = failure;
  const rebound: ConnectionDemand[] = [];
  for (const demand of ctx.demandCatalogue ?? []) {
    let anchor = demand.anchor;
    if (demand.class === "endpoint-access" || demand.class === "district-access") {
      const next = remapDemandNode(anchor, remaps);
      if (!next || !ctx.network.nodes.has(next)) return scope.failure = `required demand binding removed: ${demand.id}`;
      anchor = next;
    }
    rebound.push({ ...demand, anchor });
  }
  installDemandCatalogue(ctx, rebound);
  scope.referenceCursor = ctx.network.patchRemaps?.length ?? 0;
  return null;
}

/** 以既有对象为身份保护安全关系，而非只比较总分。 */
export function repairAcceptance(before: RepairContext, after: RepairContext, remaps: readonly NetworkRemap[] = []): string | null {
  let improved = false;
  if (before.primaryAnchorNodeId) {
    const anchor = remapDemandNode(before.primaryAnchorNodeId, remaps);
    if (!anchor || !after.network.nodes.has(anchor) || after.primaryAnchorNodeId !== anchor) return `required primary anchor lost: ${before.primaryAnchorNodeId}->${anchor} (declared ${after.primaryAnchorNodeId})`;
  }
  const retained = retainRepairDemands(planView(before), planView(after), remaps);
  if (retained.reason) return retained.reason;
  const previousComponents = componentOf(planView(before)); const currentComponents = componentOf(planView(after));
  const previousPrimary = primaryComponentId(planView(before), previousComponents); const currentPrimary = primaryComponentId(planView(after), currentComponents);
  const inherited = new Map<string, Set<string>>();
  for (const [id, previous] of previousComponents) {
    const mapped = remapDemandNode(id, remaps);
    const current = mapped ? currentComponents.get(mapped) : undefined; if (!current) continue;
    if (previous === previousPrimary && current !== currentPrimary) return "required main-network node detached";
    const roots = inherited.get(previous) ?? new Set<string>(); roots.add(current); inherited.set(previous, roots);
    if (roots.size > 1) return "existing component split";
  }
  for (const constraint of CONSTRAINTS) {
    const old = constraint.measure(planView(before)); const next = constraint.measure(planView(after));
    if (next.length > old.length) return `${constraint.id} increased ${old.length}->${next.length}`;
    if (next.length < old.length) improved = true;
    // 分量代表/报告坐标不是稳定对象身份；上面的节点继承检查已经禁止新断连或拆分。
    if (constraint.id === "disconnectedComponents") continue;
    const identity = (v: typeof old[number], ctx: RepairContext) => {
      if (v.identity !== undefined) return `${v.constraint}:${v.identity}`;
      const owner = v.site ? [...ctx.publicSites, ...ctx.landmarks].find((s) => s.kind === v.site && (!v.at || (s.x === v.at.x && s.z === v.at.z))) : null;
      return owner?.id ? `${v.constraint}:${owner.id}` : JSON.stringify([v.constraint, v.site, v.at, v.detail]);
    };
    const existing = new Set(old.map((v) => identity(v, before)));
    if (next.some((v) => !existing.has(identity(v, after)))) return `${constraint.id} introduced at a new object`;
  }
  const oldOwners = [...before.publicSites, ...before.landmarks], newOwners = [...after.publicSites, ...after.landmarks];
  for (const owner of newOwners) {
    const old = oldOwners.find(previous => previous.id === owner.id);
    if (old && Object.hasOwn(GROUND_MODEL_FACTORIES, old.kind) && !Object.hasOwn(GROUND_MODEL_FACTORIES, owner.kind))
      return `repair removed registered ground contract: ${owner.id}`;
    const changed = !old || owner.x !== old.x || owner.z !== old.z || owner.yaw !== old.yaw || owner.radius !== old.radius || owner.kind !== old.kind;
    if (!changed) continue;
    const failure = registeredModelGroundFailure(owner, { height: after.height, inRiver: after.inRiver });
    if (failure) return `${owner.id}: ${failure}`;
    if (old && registeredModelGroundFailure(old, { height: before.height, inRiver: before.inRiver })
      && Object.hasOwn(GROUND_MODEL_FACTORIES, owner.kind)) improved = true;
  }
  const previousDemands = diagnoseNetwork(planView(before))?.demands ?? [];
  const satisfied = previousDemands.filter((d) => d.demand.required && d.satisfied);
  const next = new Map(retained.demands.map((d) => [d.demand.id, d.satisfied]));
  if (satisfied.some((d) => next.get(d.demand.id) !== true)) return "required demand lost";
  if (previousDemands.some((d) => d.demand.required && !d.satisfied && next.get(d.demand.id) === true)) improved = true;
  const parcelCount = (ctx: RepairContext) => ctx.blocks.reduce((n, block) => n + block.parcels.length, 0);
  if (parcelCount(after) < parcelCount(before)) return "repair discarded reserved parcel capacity";
  const parcelIds = new Set(after.blocks.flatMap((block) => block.parcels.map((parcel) => parcel.id)));
  if (before.blocks.some((block) => block.parcels.some((parcel) => !parcelIds.has(parcel.id)))) return "repair replaced a reserved parcel identity";
  if (!improved) return "no verified constraint or demand improvement";
  return null;
}

function acceptDraft(ctx: RepairContext, draft: RepairContext, remaps: readonly NetworkRemap[], worldState: RepairWorldState): void {
  ctx.network.nodes.clear(); for (const [id, node] of draft.network.nodes) ctx.network.nodes.set(id, node);
  ctx.network.edges.clear(); for (const [id, edge] of draft.network.edges) ctx.network.edges.set(id, edge);
  const network = ctx.network;
  network.version = worldState.world.versions.network;
  ctx.primaryAnchorNodeId = draft.primaryAnchorNodeId;
  installDemandCatalogue(ctx, draft.demandCatalogue ?? []);
  const parentScope = draftScopes.get(ctx);
  if (parentScope) {
    (ctx.network.patchRemaps ??= []).push(...remaps);
    parentScope.referenceCursor = ctx.network.patchRemaps.length;
  }
  for (const field of ["publicSites", "landmarks", "blocks", "carPaths", "trunkRuns", "bridges", "connectionLog", "coastRoadRuns", "riverRoadRuns", "coastRoadRunEnds", "siteObligations"] as const) {
    const target = ctx[field]; const source = draft[field];
    if (target && source) (target as unknown[]).splice(0, target.length, ...source);
  }
  installRepairWorld(ctx, makeWorldState(ctx, worldState.world));
}

export function runRepairTransaction(ctx: RepairContext, strategy: RepairStrategy): { changes: number; reason?: string } {
  spendPlanningWork("repair:transaction", { transaction: 1 });
  const parentFailure = flushDraftReferences(ctx);
  if (parentFailure) return { changes: 0, reason: parentFailure };
  // Nested strategies may have already edited the parent's private draft. Bind
  // that unpublished state before a child takes its own versioned snapshot.
  if (draftScopes.has(ctx)) {
    const parentWorld = repairWorldStates.get(ctx);
    if (parentWorld) {
      const pending = updatedRepairWorld(parentWorld, ctx);
      if (!pending.state) return { changes: 0, reason: pending.reason };
      installRepairWorld(ctx, pending.state);
      ctx.network.version = pending.state.world.versions.network;
    }
  }
  let baseWorld: RepairWorldState;
  try {
    baseWorld = repairWorldStates.get(ctx) ?? initialRepairWorld(ctx);
    const baseFailure = worldBaseFailure(ctx, baseWorld);
    if (baseFailure) return { changes: 0, reason: baseFailure };
  } catch (error) {
    if (isPlanningInterrupted(error)) throw error;
    // Reject invalid observed inputs before running candidate/strategy code.
    // Do not invent missing polygons, dimensions or a verified authority.
    return { changes: 0, reason: `planning-world-initialization-refused: ${error instanceof Error ? error.message : "invalid source projection"}` };
  }
  if (strategy.candidates) {
    let changes = 0; const reasons: string[] = [];
    const candidates = strategy.candidates(ctx);
    if (!candidates.length) {
      const reason = strategy.emptyReason?.(ctx);
      return { changes: 0, ...(reason ? { reason } : {}) };
    }
    for (const candidate of candidates) {
      const outcome = runRepairTransaction(ctx, candidate);
      changes += outcome.changes;
      if (outcome.reason) reasons.push(`${candidate.name}: ${outcome.reason}`);
    }
    return { changes, ...(reasons.length ? { reason: reasons.join("; ") } : {}) };
  }
  const draft = copyData(ctx);
  installRepairWorld(draft, makeWorldState(draft, baseWorld.world));
  installDemandCatalogue(draft, diagnoseNetwork(planView(ctx))?.demands.map((entry) => entry.demand) ?? ctx.demandCatalogue ?? []);
  draftScopes.set(draft, { referenceCursor: 0 });
  draft.network.patchRemaps = [];
  let result: RepairResult;
  try { result = strategy.run(draft); }
  catch (error) {
    if (error instanceof ProtectedDemandMutation) return { changes: 0, reason: error.message };
    throw error;
  }
  if (draft.demandCatalogue !== protectedCatalogues.get(draft)) return { changes: 0, reason: "repair replaced protected demand catalogue" };
  if (draft.planningWorld !== repairWorldStates.get(draft)?.world) return { changes: 0, reason: "repair replaced protected planning world" };
  const changes = typeof result === "number" ? result : result.changes;
  const diagnostic = typeof result === "number" ? undefined : result.reason;
  if (!changes) {
    const rejected = (draft.connectionLog ?? []).slice(ctx.connectionLog?.length ?? 0).filter((attempt) => !attempt.ok);
    return { changes: 0, ...((diagnostic || rejected.length) ? { reason: [diagnostic, ...rejected.map((attempt) => `${attempt.id}: ${attempt.detail ?? attempt.reason}`)].filter(Boolean).join("; ") } : {}) };
  }
  const referenceFailure = flushDraftReferences(draft);
  if (referenceFailure) return { changes: 0, reason: referenceFailure };
  const reason = repairAcceptance(ctx, draft, draft.network.patchRemaps);
  if (reason) return { changes: 0, reason };
  installDemandCatalogue(draft, diagnoseNetwork(planView(draft))?.demands.map((entry) => entry.demand) ?? draft.demandCatalogue ?? []);
  const stale = worldBaseFailure(ctx, baseWorld);
  if (stale) return { changes: 0, reason: stale };
  const publication = updatedRepairWorld(baseWorld, draft);
  checkPlanningWork("repair:publication");
  if (!publication.state) return { changes: 0, reason: publication.reason };
  acceptDraft(ctx, draft, draft.network.patchRemaps, publication.state);
  return { changes, ...(diagnostic ? { reason: diagnostic } : {}) };
}

/** 外层循环上限：规划是确定性的，没有改动就是不动点，三轮足够；封顶防止两个策略互相撤销时无限振荡。 */
export const MAX_SOLVE_ROUNDS = 3;

/**
 * 按表顺序跑修复策略；一轮里只要有任何策略改动了东西，就整张表再跑一轮（后一步的改动可能让前一步重新有活可干，
 * 例如断头延伸接通后，原来被「路离用地太近」挡住的推开现在能执行了），直到一整轮零改动或达到 MAX_SOLVE_ROUNDS。
 * 返回每个策略在所有轮次里的改动数合计。
 */
export function solvePlan(ctx: RepairContext, maxRounds = MAX_SOLVE_ROUNDS): SolveReport {
  installDemandCatalogue(ctx, diagnoseNetwork(planView(ctx))?.demands.map((entry) => entry.demand) ?? ctx.demandCatalogue ?? []);
  initializeRepairPlanningWorld(ctx);
  const report: SolveReport = REPAIR_STRATEGIES.map((s) => ({ constraint: s.constraint, name: s.name, changes: 0, declined: 0, reasons: [] }));
  // 保留跨约束候选生成；每个候选都独立接受，不再原地运行后补救。
  const ids = new Set(REPAIR_STRATEGIES.map((s) => s.constraint));
  const anyViolation = CONSTRAINTS.some((c) => ids.has(c.id) && c.measure(planView(ctx)).length > 0)
    || [...ctx.publicSites, ...ctx.landmarks].some(owner => registeredModelGroundFailure(owner, { height: ctx.height, inRiver: ctx.inRiver }));
  if (anyViolation) {
    for (let round = 0; round < maxRounds; round += 1) {
      let changed = 0;
      REPAIR_STRATEGIES.forEach((s, i) => {
        const outcome = runRepairTransaction(ctx, s);
        if (outcome.reason) { report[i].declined += 1; if (!report[i].reasons.includes(outcome.reason)) report[i].reasons.push(outcome.reason); }
        report[i].changes += outcome.changes; changed += outcome.changes;
      });
      if (!changed) break;
    }
  }
  return report;
}

/** 约束 measure 可读的 ctx 视图：constraints.ts 只读下列字段（与 CityPlan 子集同构）。 */
function planView(ctx: RepairContext) {
  return {
    roadEdges: [...ctx.network.edges.values()], roadNodes: [...ctx.network.nodes.values()],
    publicSites: ctx.publicSites, landmarks: ctx.landmarks, blocks: ctx.blocks,
    terrain: ctx.geo.terrain, seaside: ctx.seaside, coast: ctx.coast, river: ctx.geo.river, waterEdges: ctx.geo.waterEdges,
    core: ctx.core, coastRoads: ctx.coastalRunCount === undefined ? ctx.coastRoadRuns : ctx.coastRoadRuns.slice(0, ctx.coastalRunCount), riverRoadRuns: ctx.riverRoadRuns,
    primaryAnchorNodeId: ctx.primaryAnchorNodeId,
    siteObligations: ctx.siteObligations,
    demandCatalogue: ctx.demandCatalogue,
  } as unknown as Parameters<typeof CONSTRAINTS[0]["measure"]>[0];
}
