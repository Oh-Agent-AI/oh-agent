import { roadWidthFor } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import type { Landmark } from "../cityPlan";
import { clearsHighways } from "../roadGeometry";
import type { PublicSite, Vec2 } from "../cityLayout";
import { isDeepWater, nearBridgeEnd, polylineDistance, wetCount } from "./footprint";
import { coastalSitingKinds, canRelocateGroundSite } from "./sitespec";
import type { RepairContext } from "./context";
import { registeredModelGroundFailure } from "./modelGround";

// 选址后置（CITY_ARCHITECTURE §6 步）：候选表 + 路网后落位。
//
// 原来的流程是「先把用地放在名义位置、再生成路网、再对着路网到处挪」——选址时看不见路，后面每一类违例都得补一个特例修复
// （路穿用地推开、车站贴路、岸边换位……）。这里把「选址」改成对**已经生成好的路网**求解：
//   候选表 candidatesFor(site)  —— 以当前位置为中心，按离原位置从近到远枚举（环形 6..120 步长 6，每圈 20 个方向）；
//   落位判据 acceptable(site, p) —— 同一组条件一次判完：干地、不与别的用地重叠、避开高架/主干、不贴桥头、
//                                   离最近路在 [0.85 半径, 半径+20]（门前有路又不被穿过）；
//   选择                          —— 第一个满足全部条件的候选（即离原位置最近的合法位置）。
// 只对仍然违例的用地启用（入水、重叠），所以对本来就合法的岛零影响。判据与 constraints.ts 的 measure 同口径。

type S = { id: string; x: number; z: number; yaw: number; radius: number; kind: string; shore?: Vec2; access?: unknown };

export function* localResiteCandidates(site: Vec2): Iterable<Vec2> {
  for (let radius = 6; radius <= 120; radius += 6) for (let k = 0; k < 20; k += 1) {
    const a = (k / 20) * Math.PI * 2 + radius * 0.37;
    yield { x: site.x + Math.cos(a) * radius, z: site.z + Math.sin(a) * radius };
  }
}

export function resiteViolatingSites(ctx: RepairContext, opts: { skipWetShore?: boolean } = {}): number {
  const all = [...ctx.publicSites, ...ctx.landmarks].filter((s) => s.radius) as S[];
  const solid = [...ctx.network.edges.values()].filter((e) => !e.bridge);
  const geo = { height: ctx.height, inRiver: ctx.inRiver };
  const nearestRoad = (x: number, z: number) => polylineDistance(solid.map((e) => e.points), { x, z });
  const limit = (s: S) => (ctx.SHORE_SITE_KINDS.has(s.kind) ? 3 : 0);
  const violates = (s: S): boolean => {
    if (!canRelocateGroundSite(s)) return false;
    // 与 constraints.ts siteInWater / sitesOverlap 同口径（此处只看地形高度，不含 inRiver，免得把没违例的岛也动了）
    const wet = wetCount(geo, s, s.radius);
    const groundFailure = registeredModelGroundFailure(s, geo);
    // The joint wet-shore path already spent this owner's original local tier;
    // do not repeat it through an overlap fallback with weaker admission.
    if (opts.skipWetShore && ctx.SHORE_SITE_KINDS.has(s.kind) && (wet > 4 || groundFailure)) return false;
    if (groundFailure) return true;
    if (wet > (ctx.SHORE_SITE_KINDS.has(s.kind) ? 4 : 0)) return true;
    // 重叠：与 sitesOverlap 同判据（kind 字典序较小的一方被标记）；对方是不能挪的（港口、广场、凯旋门、岛上地标）时，不论字典序都由这一方让开。
    const fixed = (o: S) => !canRelocateGroundSite(o);
    return all.some((o) => o !== s && (o.kind > s.kind || fixed(o)) && Math.hypot(o.x - s.x, o.z - s.z) < o.radius + s.radius);
  };
  const acceptable = (s: S, x: number, z: number): boolean => {
    if (ctx.height(x, z) <= 0.5 || wetCount(geo, { x, z }, s.radius, { river: true }) > limit(s)) return false;
    if (all.some((o) => o !== s && Math.hypot(o.x - x, o.z - z) < o.radius + s.radius)) return false;
    if (!clearsHighways({ x, z }, s.radius * 2, s.radius * 2, ctx.ringRuns)) return false;
    if (polylineDistance(ctx.trunkRuns, { x, z }) < s.radius * 0.7 || nearBridgeEnd(ctx.bridges, x, z, s.radius)) return false;
    const road = nearestRoad(x, z);
    return road >= s.radius * 0.85 && road <= s.radius + 20 && !registeredModelGroundFailure({ ...s, x, z }, geo);
  };
  let moved = 0;
  for (const s of all) {
    if (violates(s) && !s.access) {
      let chosen: Vec2 | null = null;
      for (const p of localResiteCandidates(s)) if (acceptable(s, p.x, p.z)) { chosen = p; break; }
      if (chosen) { s.x = chosen.x; s.z = chosen.z; moved += 1; }
    }
    // 无论是否挪过，都用地标实际底座半径 + 9 清空周边地块——曾只对「挪过的」
    // 用裸 radius 过滤，未挪的地标没有二次清地，会话楼贴到地标底座（如 TV 塔
    // 底座直径 17，地块中心 4.3–9.1 即重叠）。
    for (const block of ctx.blocks) block.parcels = block.parcels.filter((pc) => Math.hypot(pc.x - s.x, pc.z - s.z) >= s.radius + 9);
  }
  return moved;
}

// ── 岸线挪动四遍（V2 网络优先批次 6b-1：从 buildPlan 逐字迁出，闭包改显式 ctx；迭代顺序、
// 步长、阈值与注释一律不变——行为保持由计划/场景基线哈希证明）─────────────────────────
// 岸边类集合由 sitespec 表派生（coastalSitingKinds === cityPlan 的 SHORE_SITE_KINDS，守卫证值相等）：
// 表成为唯一数据源后，行为变更批改表即可改临水语义，不再改散落的 Set 字面量。

/** 岸线挪动四遍共用的只读依赖 + 可变用地表（publicSites/landmarks 是 buildPlan 的同一份引用，原地改）。 */
export type ShoreMoveContext = {
  publicSites: PublicSite[];
  landmarks: Landmark[];
  /** Optional relocation transaction scope; omitted means the existing full pass. */
  relocateSiteIds?: ReadonlySet<string>;
  /** Transaction-owned extra separation from reserved neighbours, by owner ID. */
  neighbourMargins?: ReadonlyMap<string, number>;
  /** Accepted candidate-world road envelopes for explicitly forced relocation. */
  roadEnvelopes?: ReadonlyArray<{ points: Vec2[]; width: number }>;
  core: Vec2;
  coast: Vec2[];
  coastDistance: (x: number, z: number) => number;
  height: (x: number, z: number) => number;
  inRiver: (x: number, z: number) => boolean;
  riverBank: (x: number, z: number, bank: number) => boolean;
  trunkRuns: Vec2[][];
  bridges: Array<{ from: Vec2; to: Vec2 }>;
  ringRuns: Vec2[][];
};

const SHORE_KINDS = coastalSitingKinds();

/**
 * 岸边内移遍（原 buildPlan「岸边地标向核心方向内移」）：占地圈落水 >3 点时朝核心走（步长 3、最多 20 步），
 * 每步要求中心在陆上、不在河里、不压主干道（r+4）与桥头；任一不过即停。
 */
export function retreatShoreSitesToDryLand(ctx: ShoreMoveContext): void {
  const { landmarks, core, height, inRiver, trunkRuns, bridges } = ctx;
  const footprintGeo = { height: ctx.height, inRiver: ctx.inRiver, riverBank: ctx.riverBank };
  const distanceToTrunks = (p: Vec2) => polylineDistance(trunkRuns, p);
  for (const site of landmarks) {
    if (ctx.relocateSiteIds && !ctx.relocateSiteIds.has(site.id)) continue;
    if (!site.radius || !SHORE_KINDS.has(site.kind)) continue;
    const wetCountAt = (c: Vec2) => wetCount(footprintGeo, c, site.radius); // 内移判据：只看地形水位（不含河道），与原实现同口径
    const dx = core.x - site.x; const dz = core.z - site.z; const len = Math.hypot(dx, dz) || 1;
    // 每步都要求中心仍在陆上、不在河里：直线朝核心走可能跨过河道（geography 守卫 seed 3668352332 抓到摩天轮进河）。
    let candidate = { x: site.x, z: site.z }, admitted: Vec2 | null = null;
    for (let step = 0; step < 20 && (wetCountAt(candidate) > 3 || registeredModelGroundFailure({ ...site, ...candidate }, footprintGeo)); step += 1) {
      const nx = candidate.x + (dx / len) * 3; const nz = candidate.z + (dz / len) * 3;
      if (height(nx, nz) <= 0.5 || inRiver(nx, nz) || distanceToTrunks({ x: nx, z: nz }) < site.radius + 4 || nearBridgeEnd(bridges, nx, nz, site.radius)) break; // 也不推到主干道/桥头上
      candidate = { x: nx, z: nz };
      if (!registeredModelGroundFailure({ ...site, ...candidate }, footprintGeo)) admitted = candidate;
    }
    if (admitted) { site.x = admitted.x; site.z = admitted.z; }
  }
}

/**
 * 港口贴岸遍（原 buildPlan「港口最后贴回岸线」）：前面的避让会把港口推进内陆——朝最近岸点
 * 逐步移动（步长 3、最多 80 步）到中心离岸 ≤ 12（码头半边伸进水面），朝向重设为岸→核心反方向。
 */
export function settleHarborOnCoast(ctx: ShoreMoveContext): void {
  const { publicSites, coast, coastDistance, core } = ctx;
  for (const site of publicSites) {
    if (site.kind !== "harbor") continue;
    let nearest = coast[0];
    for (const q of coast) if (Math.hypot(q.x - site.x, q.z - site.z) < Math.hypot(nearest.x - site.x, nearest.z - site.z)) nearest = q;
    for (let step = 0; step < 80 && coastDistance(site.x, site.z) > 12; step += 1) {
      const dx = nearest.x - site.x; const dz = nearest.z - site.z; const len = Math.hypot(dx, dz) || 1;
      site.x += (dx / len) * 3; site.z += (dz / len) * 3;
    }
    site.yaw = -Math.atan2(nearest.z - core.z, nearest.x - core.x);
  }
}

/**
 * 贴岸遍（原 buildPlan「岸边地标贴回岸线」）：对每个岸边地标试最近的 8 个岸点，朝每个岸点滑移
 * （步长 3、最多 100 步）到离岸 ≈ 0.7 半径；滑移不得落水 >3（含河道+河岸带 14）、进河、压桥头/主干道/
 * 高架/其它用地。取最终离岸最近的落点；落点压主干道（< 0.7 半径）则留在原位；仍 >3 点在水上时
 * 在 70 内环形搜索干燥落点（wet ≤2）。
 */
export function settleShoreSitesOnCoast(ctx: ShoreMoveContext): void {
  const { publicSites, landmarks, coast, coastDistance, height, inRiver, trunkRuns, bridges, ringRuns } = ctx;
  const footprintGeo = { height: ctx.height, inRiver: ctx.inRiver, riverBank: ctx.riverBank };
  const distanceToTrunks = (p: Vec2) => polylineDistance(trunkRuns, p);
  for (const site of landmarks) {
    if (ctx.relocateSiteIds && !ctx.relocateSiteIds.has(site.id)) continue;
    if (!site.radius || !SHORE_KINDS.has(site.kind)) continue;
    const wet = (x: number, z: number) => wetCount(footprintGeo, { x, z }, site.radius, { river: true, riverBank: 14 }); // 河道及两岸 14 内也算水：歌剧院曾立在河口上（用户截图）
    const others = [...publicSites, ...landmarks].filter((o) => o !== site && o.radius);
    // 试最近的 8 个岸点，取最终离岸最近的落点（一条路径被别的用地挡住时换个方向贴岸）。
    const targets = [...coast].sort((a, b) => Math.hypot(a.x - site.x, a.z - site.z) - Math.hypot(b.x - site.x, b.z - site.z)).slice(0, 8);
    let best = { x: site.x, z: site.z, d: coastDistance(site.x, site.z) };
    for (const target of targets) {
      let x = site.x; let z = site.z;
      for (let step = 0; step < 100 && coastDistance(x, z) > site.radius * 0.7; step += 1) {
        const dx = target.x - x; const dz = target.z - z; const len = Math.hypot(dx, dz) || 1;
        const nx = x + (dx / len) * 3; const nz = z + (dz / len) * 3;
        if (wet(nx, nz) > 3 || inRiver(nx, nz) || nearBridgeEnd(bridges, nx, nz, site.radius) || distanceToTrunks({ x: nx, z: nz }) < site.radius + 4 || !clearsHighways({ x: nx, z: nz }, site.radius * 2, site.radius * 2, ringRuns) || others.some((o) => Math.hypot(o.x - nx, o.z - nz) < o.radius + site.radius)
          || registeredModelGroundFailure({ ...site, x: nx, z: nz }, footprintGeo)) break; // 不滑到主干道上
        x = nx; z = nz;
      }
      const d = coastDistance(x, z);
      if (d < best.d) best = { x, z, d };
    }
    if (wet(best.x, best.z) <= 3 && (distanceToTrunks(best) >= site.radius * 0.7 || distanceToTrunks(site) < site.radius * 0.7)
      && !registeredModelGroundFailure({ ...site, x: best.x, z: best.z }, footprintGeo)) { site.x = best.x; site.z = best.z; } // 落点压到主干道上就留在原位
    // A dry, already coastal nominal position can still block a joint owner.
    // Explicitly scoped relocation reuses the existing local search tier;
    // otherwise this remains the historical wet-site fallback.
    const separation = (other: typeof others[number]) => other.radius + site.radius + (ctx.neighbourMargins?.get(other.id) ?? 0);
    const forced = ctx.relocateSiteIds?.has(site.id) && canRelocateGroundSite(site)
      && others.some((other) => Math.hypot(other.x - site.x, other.z - site.z) < separation(other));
    if (wet(site.x, site.z) > 3 || forced || registeredModelGroundFailure(site, footprintGeo)) {
      let found: Vec2 | null = null;
      for (let rr = 6; rr <= 70 && !found; rr += 6) {
        for (let k = 0; k < 24 && !found; k += 1) {
          const a = (k / 24) * Math.PI * 2; const nx = site.x + Math.cos(a) * rr; const nz = site.z + Math.sin(a) * rr;
          if (wet(nx, nz) > 2 || height(nx, nz) <= 0.5 || distanceToTrunks({ x: nx, z: nz }) < site.radius + 4) continue;
          if (!clearsHighways({ x: nx, z: nz }, site.radius * 2, site.radius * 2, ringRuns) || others.some((o) => Math.hypot(o.x - nx, o.z - nz) < separation(o))) continue;
          if (forced && coastDistance(nx, nz) > Math.max(site.radius * 2, coastDistance(site.x, site.z))) continue;
          if (forced && ctx.roadEnvelopes?.some((edge) => polylineDistance([edge.points], { x: nx, z: nz })
            < site.radius + edge.width / 2 + 3)) continue;
          if (registeredModelGroundFailure({ ...site, x: nx, z: nz }, footprintGeo)) continue;
          found = { x: nx, z: nz };
        }
      }
      if (found) { site.x = found.x; site.z = found.z; }
    }
  }
}

/**
 * 海上岛遍（原 buildPlan「帆形歌剧院改立海上小岛」）：取离当前最近的 40 个岸点，岸外 radius+40 处
 * 整个占地圈必须是深水（不在河口），且离港口 ≥ r_o+r+120 / 其它用地 ≥ +30；堤道陆地端（岸点向内 6）
 * 要踩在实地上（height ≥ 0.3）。首个满足者即落位（朝向沿离核向外，shore 记堤道端）。
 */
export type SailOperaCandidate = { x: number; z: number; yaw: number; shore: Vec2 };
export type SailOperaCandidateSet = { siteId: string; candidates: SailOperaCandidate[] };
export const SAIL_OPERA_CONFIG = { version: 2, coastCandidates: 40, jointCandidates: 40,
  landingInsets: [6, 8, 10, 12, 14, 16, 18, 20, 22, 24] as const, landingRoadWidth: roadWidthFor("local") };

/** A dry centre does not support a full-width causeway landing. Keep the
 * historical 6-unit inset when it is valid; otherwise search a bounded inland
 * collar, with the same water predicate as the ground approach validator. */
export function supportedShoreLanding(geo: Pick<ShoreMoveContext, "height" | "inRiver">, shore: Vec2, outward: Vec2): Vec2 | null {
  const halfWidth = SAIL_OPERA_CONFIG.landingRoadWidth / 2;
  for (const inset of SAIL_OPERA_CONFIG.landingInsets) {
    const point = { x: shore.x - outward.x * inset, z: shore.z - outward.z * inset };
    let dry = true;
    for (const lateral of [-halfWidth, 0, halfWidth]) for (const longitudinal of [-halfWidth, 0, halfWidth]) {
      const x = point.x - outward.z * lateral + outward.x * longitudinal;
      const z = point.z + outward.x * lateral + outward.z * longitudinal;
      const height = geo.height(x, z);
      if (!Number.isFinite(height) || height <= 0.5 || geo.inRiver(x, z)) { dry = false; break; }
    }
    if (dry) return point;
  }
  return null;
}

export function settleSailOperaOffshore(ctx: ShoreMoveContext): SailOperaCandidateSet[] {
  const { publicSites, landmarks, coast, core, height } = ctx;
  const footprintGeo = { height: ctx.height, inRiver: ctx.inRiver, riverBank: ctx.riverBank };
  const candidateSets: SailOperaCandidateSet[] = [];
  for (const site of landmarks) {
    if (ctx.relocateSiteIds && !ctx.relocateSiteIds.has(site.id)) continue;
    if (site.kind !== "sail-opera") continue;
    const others = [...publicSites, ...landmarks].filter((o) => o !== site && o.radius);
    const targets = coast.map((shore, index) => ({ shore, index, distance: Math.hypot(shore.x - site.x, shore.z - site.z) }))
      .sort((a, b) => a.distance - b.distance || a.index - b.index).slice(0, SAIL_OPERA_CONFIG.coastCandidates);
    const candidates: SailOperaCandidate[] = [];
    for (const { shore } of targets) {
      const len = Math.hypot(shore.x - core.x, shore.z - core.z) || 1;
      const out = { x: (shore.x - core.x) / len, z: (shore.z - core.z) / len };
      const c = { x: shore.x + out.x * (site.radius + 40), z: shore.z + out.z * (site.radius + 40) };
      const deep = isDeepWater(footprintGeo, c, site.radius);
      if (!deep || others.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < o.radius + site.radius + (o.kind === "harbor" ? 120 : 30))) continue;
      // 岸点落路净空（A 轨 4-3c 移植）：岸点被其它用地圈住时（实测 seed 42：villa-complex 挪到
      // 歌剧院岸点 21 单位处，路网变化后入口路全失败、堤道两头悬空），选址期直接避开，不靠修复遍。
      const landing = supportedShoreLanding(ctx, shore, out);
      if (!landing) continue;
      if (others.some((o) => Math.hypot(o.x - landing.x, o.z - landing.z) < o.radius + 30)) continue;
      candidates.push({ x: c.x, z: c.z, yaw: -Math.atan2(out.z, out.x), shore: landing });
    }
    candidateSets.push({ siteId: site.id ?? site.kind, candidates });
    const first = candidates[0];
    if (first) { site.x = first.x; site.z = first.z; site.shore = first.shore; site.yaw = first.yaw; }
  }
  return candidateSets;
}
