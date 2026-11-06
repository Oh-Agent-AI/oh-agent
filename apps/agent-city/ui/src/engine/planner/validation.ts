/**
 * 候选路线统一终筛（CITY_NETWORK_FIRST_OPTIMIZATION_PLAN 批 A）：搜索提案与固定定线共用
 * 一个候选表示与纯验证入口，废除策略级整体豁免——siteGate 全免、湿桥地面段不复查、
 * maxSlope=Infinity 都改为按段结构检查：
 *
 *   ground-road      普通地面段：不过水 / 可建 / 坡度 ≤0.9 / 避让预留地（直连阶梯的历史口径，逐字保留）。
 *   ground-approach  引道段（bridge-candidate 的地面引线、门路）：不要求 buildable（前滩按道路
 *                    可行条件，不套建筑判据）/ 坡度 ≤ roadApproachMaxSlope（有限值，实测标定）。
 *                    所有引道提交时重新检查水、坡度及其他用地；桥接点只豁免水线端点。
 *                    发起用地自身仍不在 blockers 里；显式入口通道尚待接线，
 *                    不能把这一兼容路径视为已证明不会穿过自身建筑。
 *   deck             桥面：不吃地面判据（跨距/桥头在提议期判据）；被允许立体跨越既有路时须查
 *                    高度净空——RoadEdge 无高程模型，信息不足按设计返回 unsupported（违规），
 *                    不是关闭平面交叉检查。
 *
 * 纯函数：只读传入网络与地理；验证失败零副作用（设计 §5A-7）。
 */
import { DetMath as Math } from "../detMath";
import type { Vec2 } from "../cityLayout";
import { keyOf, type Network } from "./network";
import { siteRoadClear, siteFootprint } from "../planFootprint";
import type { ConnectorWorld, ConnectionFailure } from "./connect";
import { classifyRoadSegments } from "./relations";

export const VALIDATION_CONFIG = {
  version: 2,
  // 实测标定（2026-10-08，两条种子线分开测，避免单线定标）：
  //  - 调优线（30 基线 + 60 普查 t1 + 10 t3）：桥邻接地面边 n=623 最差坡度 max=2.447，用地邻接入口边 n=766 max=0.409；
  //  - 独立验收线（3e9，t1×60）：桥邻接 n=353 max=4.98（seed 3001256748 帆船剧院翻崖岸引道），用地邻接 n=442 max=0.17。
  // 6.0 = 全体实测包络 4.98 × ~1.2 余量：覆盖所有历史已接受引道，仍拒绝不可行陡坡（旧口径是
  // maxSlope=Infinity，任何有限值都是收紧）。改此值必须引用新测量与验收集证据。
  roadApproachMaxSlope: 6,
  approachSiteMargin: 2, // 引道段的用地避让 r+2（提议期同口径）
  sampleSpacing: 4, // 普通地面段走廊采样步长（safeRoadLink 历史口径；landing.ts 有自己的同值常量）
  // 所有路段统一有限采样，历史采样漏检不构成豁免依据。
};

export type SegmentKind = "ground-road" | "ground-approach" | "deck";
export type RouteSegment = {
  a: Vec2;
  b: Vec2;
  kind: SegmentKind;
  width: number;
  /** 地面段贴 deck（相邻段是桥面）：端点豁免触水线（提议期 k=1..n-1 同标准，非第二口径）。 */
  touchesDeck?: boolean;
};
export type RouteCandidate = {
  id: string;
  segments: RouteSegment[];
  /** 兼容旧提案字段；终筛始终检查交叉，不授予安全豁免。 */
  crossings: boolean;
  /** 引道段的避让盘（兼容路径不含发起用地自身；明确入口通道仍待实现）。 */
  blockers: Array<{ x: number; z: number; radius: number }>;
  /** 用途标签；不授予水域、坡度或其他用地豁免。 */
  gate?: boolean;
};
export type CandidateViolation = { segment: number; kind: ConnectionFailure | "vertical-clearance-unsupported"; detail: string };
export type CandidateValidation = { ok: true } | { ok: false; violations: CandidateViolation[] };

/** 圆预留采用精确胶囊距离；地形在纵向/横向 ≤4 单位格点采样（不是连续地形证明）。
 *  skipEnds 只豁免桥接点水线，不豁免障碍、坡度或 buildable。 */
export type CorridorViolation = { kind: ConnectionFailure; cause: "invalid-geometry" | "site-envelope" | "water-envelope" | "building-setback" | "road-slope" | "roadway-setback"; at?: Vec2 };
export function corridorViolation(world: ConnectorWorld, a: Vec2, b: Vec2, policy: CorridorPolicy, opts: { skipEnds?: boolean; spacing?: number } = {}): CorridorViolation | null {
  const distance = Math.hypot(b.x - a.x, b.z - a.z);
  const width = policy.roadWidth ?? 0;
  if (!Number.isFinite(width) || width < 0 || !Number.isFinite(distance)) return { kind: "projection-loss", cause: "invalid-geometry" };
  // 圆预留与道路胶囊精确相交；不依赖纵向采样相位，不能漏掉采样点之间的小障碍。
  for (const site of policy.sites) {
    if (site.kind && Number.isFinite(site.yaw)) {
      const footprint = siteFootprint(site.kind, site.id ?? `reservation:${site.kind}`, site.radius);
      if (footprint.exact) {
        if (!siteRoadClear({ ...site, kind: site.kind, yaw: site.yaw! }, a, b, width, policy.siteMargin))
          return { kind: "site-clearance", cause: "site-envelope" };
        continue;
      }
    }
    const dx = b.x - a.x; const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((site.x - a.x) * dx + (site.z - a.z) * dz) / (distance * distance || 1)));
    if (Math.hypot(site.x - a.x - dx * t, site.z - a.z - dz * t) < site.radius + policy.siteMargin + width / 2) return { kind: "site-clearance", cause: "site-envelope" };
  }
  const nx = distance ? -(b.z - a.z) / distance : 0;
  const nz = distance ? (b.x - a.x) / distance : 1;
  // 偶数切片保留中心线采样，同时覆盖两侧缘。
  const lateralSteps = width ? 2 * Math.ceil(width / (2 * VALIDATION_CONFIG.sampleSpacing)) : 0;
  const steps = Math.max(1, Math.ceil(distance / (opts.spacing ?? VALIDATION_CONFIG.sampleSpacing)));
  // 热路径（首次走廊检查约 115 采样/次，大岛上百万次）：属性读取提到循环外，采样点只在失败时才物化成对象
  // （原先每个采样点都分配 {x,z}，且结果只有失败分支读 at）。坐标表达式与运算顺序逐字不变，浮点结果逐位相同。
  const geo = world.geo;
  const terrain = geo.terrain;
  const waterfront = policy.waterfront;
  const dxAB = b.x - a.x; const dzAB = b.z - a.z;
  for (let i = 0; i <= steps; i += 1) {
    const endpoint = !!opts.skipEnds && (i === 0 || i === steps);
    for (let j = 0; j <= lateralSteps; j += 1) {
      const offset = width * (j / (lateralSteps || 1) - 0.5);
      const px = a.x + dxAB * i / steps + nx * offset;
      const pz = a.z + dzAB * i / steps + nz * offset;
      const height = geo.height(px, pz);
      if (!Number.isFinite(height)) return { kind: "projection-loss", cause: "invalid-geometry", at: { x: px, z: pz } };
      if (!endpoint && (height <= 0.5 || world.inRiver(px, pz))) return { kind: "water-span", cause: "water-envelope", at: { x: px, z: pz } };
      if (policy.requireBuildable && !geo.buildable(px, pz)) return { kind: "slope", cause: "building-setback", at: { x: px, z: pz } };
      if (waterfront) {
        const clearance = geo.landClearance?.(px, pz);
        const hillGap = geo.hillLine - geo.hillProj?.(px, pz);
        if (!Number.isFinite(clearance) || !Number.isFinite(hillGap)) return { kind: "projection-loss", cause: "invalid-geometry", at: { x: px, z: pz } };
        if (clearance <= waterfront.minLandClearance || hillGap <= waterfront.hillSetback
          || height >= waterfront.maxHeight) return { kind: "slope", cause: "roadway-setback", at: { x: px, z: pz } };
      }
      const slope = terrain.slope(px, pz);
      if (!Number.isFinite(slope) || slope > policy.maxSlope) return { kind: "slope", cause: "road-slope", at: { x: px, z: pz } };
    }
  }
  return null;
}

/** 走廊「是否被拒」的布尔判定：恰当 corridorViolation(world, a, b, policy) !== null 时返回 true（缺省 opts、
 *  无 waterfront 档——调用方保证）。只给「失败原因不再被观察」的调用方用（并线阶梯在已记下最近拒绝之后：
 *  候选按距离升序，后续拒绝不可能改写 nearest，只有「过/不过」影响结果）。
 *  为什么能更快：corridorViolation 从 a 端顺序采样、遇到第一个违规才返回；孤立分量隔水并线时 a 在岛上、水在
 *  走廊中段，顺序扫描要先走完整段岸上采样（实测平均 ~115 采样/次）。这里对同一组采样点改用二分细化顺序
 *  （端点与 2^k 步长先、逐级减半），隔水走廊通常几个采样就碰到水。判定是析取（任一采样违规/任一用地相交/
 *  几何非法即拒），与访问顺序无关；采样坐标表达式与运算顺序逐字照抄 corridorViolation，浮点逐位相同；
 *  全部采样通过时它与原函数同为「不拒」。不返回原因，因此不能替代需要 reason 的调用。 */
export function corridorBlocked(world: ConnectorWorld, a: Vec2, b: Vec2, policy: CorridorPolicy): boolean {
  const distance = Math.hypot(b.x - a.x, b.z - a.z);
  const width = policy.roadWidth ?? 0;
  if (!Number.isFinite(width) || width < 0 || !Number.isFinite(distance)) return true;
  const nx = distance ? -(b.z - a.z) / distance : 0;
  const nz = distance ? (b.x - a.x) / distance : 1;
  const lateralSteps = width ? 2 * Math.ceil(width / (2 * VALIDATION_CONFIG.sampleSpacing)) : 0;
  const steps = Math.max(1, Math.ceil(distance / VALIDATION_CONFIG.sampleSpacing));
  const geo = world.geo;
  const terrain = geo.terrain;
  const dxAB = b.x - a.x; const dzAB = b.z - a.z;
  const sampleFails = (i: number): boolean => {
    for (let j = 0; j <= lateralSteps; j += 1) {
      const offset = width * (j / (lateralSteps || 1) - 0.5);
      const px = a.x + dxAB * i / steps + nx * offset;
      const pz = a.z + dzAB * i / steps + nz * offset;
      const height = geo.height(px, pz);
      if (!Number.isFinite(height)) return true;
      if (height <= 0.5 || world.inRiver(px, pz)) return true;
      if (policy.requireBuildable && !geo.buildable(px, pz)) return true;
      const slope = terrain.slope(px, pz);
      if (!Number.isFinite(slope) || slope > policy.maxSlope) return true;
    }
    return false;
  };
  // 二分细化顺序：先 i ∈ {0, P, 2P, …}（P = ≤steps 的最大 2 的幂），再对 s = P/2 … 1 取 s 的奇数倍——每个 i ∈ [0, steps] 恰访问一次。
  let top = 1; while (top * 2 <= steps) top *= 2;
  for (let i = 0; i <= steps; i += top) if (sampleFails(i)) return true;
  for (let s = top / 2; s >= 1; s /= 2) for (let i = s; i <= steps; i += 2 * s) if (sampleFails(i)) return true;
  // 用地盘相交（corridorViolation 先查它；析取与顺序无关，放后面是因为隔水走廊多数在采样里就被拒）。
  // 与 corridorViolation 同一判据：有真实占地的用地（kind + yaw，占地精确）按占地判，其余按圆预留——
  // main 把走廊判定改成精确占地之后，这条快判仍按圆判，会和原函数对同一走廊给出不同的拒/不拒
  // （合并 main 时 30 岛里 2 个 5 档岛的路网因此与 main 不一致）。
  for (const site of policy.sites) {
    if (site.kind && Number.isFinite(site.yaw)) {
      const footprint = siteFootprint(site.kind, site.id ?? `reservation:${site.kind}`, site.radius);
      if (footprint.exact) {
        if (!siteRoadClear({ ...site, kind: site.kind, yaw: site.yaw! }, a, b, width, policy.siteMargin)) return true;
        continue;
      }
    }
    const dx = b.x - a.x; const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((site.x - a.x) * dx + (site.z - a.z) * dz) / (distance * distance || 1)));
    if (Math.hypot(site.x - a.x - dx * t, site.z - a.z - dz * t) < site.radius + policy.siteMargin + width / 2) return true;
  }
  return false;
}

/** Preserve the legacy failure enum while detailed diagnostics distinguish causes. */
export function corridorFailure(world: ConnectorWorld, a: Vec2, b: Vec2, policy: CorridorPolicy, opts: { skipEnds?: boolean; spacing?: number } = {}): ConnectionFailure | null {
  return corridorViolation(world, a, b, policy, opts)?.kind ?? null;
}

export type CorridorPolicy = {
  requireBuildable: boolean;
  maxSlope: number;
  sites: Array<{ id?: string; kind?: string; yaw?: number; x: number; z: number; radius: number }>;
  siteMargin: number;
  /** 道路全宽（批 A2 胶囊口径）：避让判据从中心线点升级为「中心线 ± width/2 侧向展开」——
   *  宽路的侧缘不得压进用地盘（评审门禁「宽道路侧缘压楼」）。缺省 0 = 历史中心线口径
   *  （占位调用方）；模型多边形占地（非圆）随批 D SiteSpec 接线。 */
  roadWidth?: number;
  /** 批 A 起验证不再因该旗标授予任何豁免（保留仅为调用位标注用途）；豁免语义见 RouteCandidate.blockers。 */
  siteGate?: boolean;
  /** Explicit road-use predicate, in addition to full-width water/slope/site checks. */
  waterfront?: { minLandClearance: number; hillSetback: number; maxHeight: number };
};

/**
 * 统一终筛（纯）：ground-road 段用 roadPolicy（各阶梯的历史口径）；ground-approach 段用
 * 引道标准（有限坡度 + 前滩不套 buildable + 只避让 blockers）；deck 段不吃地面判据、
 * 与既有边严格相交 → vertical-clearance-unsupported（无高程模型，不静默放行）。
 * network 传草稿（提交期）或当前网络（提议期预筛）——两处同一入口。
 */
export function validateCandidate(
  world: ConnectorWorld,
  network: Network,
  candidate: RouteCandidate,
  opts: { roadPolicy: CorridorPolicy },
): CandidateValidation {
  const violations: CandidateViolation[] = [];
  for (let i = 0; i < candidate.segments.length; i += 1) {
    const original = candidate.segments[i];
    const s = { ...original, a: keyOf(original.a), b: keyOf(original.b) };
    if (!Number.isFinite(s.width) || s.width <= 0 || ![s.a.x, s.a.z, s.b.x, s.b.z].every(Number.isFinite)) {
      violations.push({ segment: i, kind: "projection-loss", detail: `${candidate.id} segment ${i} has invalid geometry/width` });
      continue;
    }
    const actual = network.edges.get([`${s.a.x}:${s.a.z}`, `${s.b.x}:${s.b.z}`].sort().join("/"));
    const same = (a: Vec2, b: Vec2) => a.x === b.x && a.z === b.z;
    if (actual && (actual.points.length !== 2 || !Number.isFinite(actual.width) || actual.width <= 0 || !!actual.bridge !== (s.kind === "deck")
      || !((same(actual.points[0], s.a) && same(actual.points[1], s.b)) || (same(actual.points[0], s.b) && same(actual.points[1], s.a))))) {
      violations.push({ segment: i, kind: "projection-loss", detail: `${candidate.id} segment ${i} conflicts with existing geometry/structure` });
      continue;
    }
    if (actual) s.width = actual.width;
    const contact = (other: typeof actual) => {
      if (!other || other.id === actual?.id) return null;
      for (let k = 1; k < other.points.length; k += 1) {
        const relation = classifyRoadSegments(s.a, s.b, other.points[k - 1], other.points[k]);
        if (relation.kind === "separate") continue;
        // Only contact at the same registered endpoint is a real junction.
        const shared = [other.from, other.to].some((id) => {
          const node = network.nodes.get(id);
          return node && (same(node, s.a) || same(node, s.b))
            && same(node, relation.a.point) && same(node, relation.b.point);
        });
        if (relation.kind === "endpoint-contact" && shared) continue;
        return relation.kind;
      }
      return null;
    };
    if (s.kind === "deck") {
      for (const other of network.edges.values()) {
        if (contact(other)) {
          violations.push({ segment: i, kind: "vertical-clearance-unsupported", detail: `deck overlaps edge ${other.id}; RoadEdge carries no elevation model` });
          break;
        }
      }
      continue;
    }
    const failure = s.kind === "ground-approach"
      ? corridorViolation(world, s.a, s.b, {
          requireBuildable: false,
          maxSlope: VALIDATION_CONFIG.roadApproachMaxSlope,
          sites: candidate.blockers,
          siteMargin: VALIDATION_CONFIG.approachSiteMargin,
          roadWidth: s.width,
        }, { skipEnds: s.touchesDeck })
      : corridorViolation(world, s.a, s.b, { ...opts.roadPolicy, roadWidth: s.width }, {});
    if (failure) violations.push({ segment: i, kind: failure.kind, detail: `${candidate.id} segment ${i} failed ${failure.cause}${failure.at ? ` at ${failure.at.x}:${failure.at.z}` : ""}` });
    for (const other of network.edges.values()) {
      const relation = contact(other);
      if (relation) {
        violations.push({ segment: i, kind: other.bridge ? "vertical-clearance-unsupported" : "crossing", detail: `${candidate.id} segment ${i} has ${relation} with edge ${other.id}` });
        break;
      }
    }
  }
  return violations.length ? { ok: false, violations } : { ok: true };
}
