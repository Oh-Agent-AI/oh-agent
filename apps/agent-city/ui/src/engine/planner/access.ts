/**
 * 选址候选生成器骨架（CITY_NETWORK_FIRST_CODE_DESIGN §5 / 迁移批次 6a-3）。
 *
 * 五类 placement 各一个生成器（sitespec.PlacementClass ↔ 本文件函数一一对应）：
 *   inland-frontage  → inlandFrontageCandidates   沿路取点：投影到最近主干段、沿法线偏移 radius+12（两侧）
 *   shore            → shoreCandidates            沿岸取点：最近岸点为目标、朝它滑移到离岸 ≈ 0.7·radius
 *   offshore-island  → offshoreIslandCandidates   岸外取点：岸点沿「离核向外」半径 radius+40 的深水圈
 *   straddle-trunk   → straddleTrunkCandidates    主干中段（len ≥ 20）中点，开口轴沿路向
 *   plaza            → plazaCandidates            广场 === 核心点（构造保证，单候选）
 *
 * 骨架纪律（本批）：
 *   - 输入只依赖 geo + 网络数据（SiteCandidateWorld；不含 cityPlan 闭包，不 import cityPlan 运行时）；
 *   - 纯函数、无随机、候选数有确定上界、id 稳定（source+序号）——同输入同输出；
 *   - **不接线**：生产管线（place()/十道挪动遍）不调用这里；行为变更批把指派移到骨架后时，
 *     以 assign.ts 的指派循环消费这些生成器（守卫先证明确定性）。
 * 生成逻辑按 cityPlan 现行遍的取点公式登记（临街遍的法线偏移、贴岸遍的滑移步长、海上岛遍的
 * 岸外半径），但「先到先得」改为「hard 全过 + soft 加权后取最优」——这是行为变更批的差异点，
 * 不是本批的行为。
 */
import { roadWidthFor, EXPRESSWAY_DECK_WIDTH } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import type { Landmark } from "../cityPlan";
import { segmentDistance } from "../roadGeometry";
import type { PublicSite, RoadEdge, Vec2 } from "../cityLayout";
import type { SiteSpec } from "./sitespec";
import { spendPlanningWork } from "./operationBudget";
import { coastalSitingKinds, frontageExemptKinds, straddleSitingKinds } from "./sitespec";
import { isDeepWater, nearBridgeEnd, polylineDistance, wetCount, isDry } from "./footprint";
import { footprintCircleDistance, footprintRunsDistance, siteFootprint, siteFootprintSeparation, siteRoadClear, worldFootprintSamples } from "../planFootprint";

/** 候选点：坐标 + 朝向 + 稳定 id（排序 tie-break 用）+ 来源说明；shoreAnchor 供海上岛堤道校验。 */
export type SiteCandidate = {
  id: string;
  x: number; z: number; yaw: number;
  source: string;
  /** Actual generating ground-road segment and its probe; not a virtual grid frontage. */
  frontage?: { a: Vec2; b: Vec2; at: Vec2 };
  /** 海上岛候选的堤道陆地端（岸点向内 6）。 */
  shoreAnchor?: Vec2;
};

/**
 * 候选世界（geo + 网络数据的显式清单；与 cityPlan 闭包解耦，行为变更批由 buildPlan 组装）。
 * 只列生成器与 hard 闸门真正读的字段（context.ts 文化：一个遍用到什么，一眼可见）。
 */
export type SiteCandidateWorld = {
  core: Vec2;
  R: number;
  turn: number;
  coast: Vec2[];
  /** 骨架主干折线（生成临街/跨路候选）。 */
  trunkRuns: Vec2[][];
  /** Actual ground envelopes when available; legacy skeletons are width 12. */
  groundRoads?: ReadonlyArray<Pick<RoadEdge, "points" | "width">>;
  frontageCandidateLimit?: number;
  frontageProbeFractions?: readonly number[];
  /** Bounded region candidates tried only after all frontage candidates fail. */
  frontageFallbackPoints?: readonly Vec2[];
  /** Joint owner/network proposals may defer exact-shape trunk clearance to their atomic validator. */
  allowGroundCorridorRelocation?: boolean;
  /** Joint neighbour placement may consume complete owner shapes; legacy
   * callers without that contract keep their conservative plot proxies. */
  usePlacedFootprints?: boolean;
  /** 环线高架折线（hard 闸门的净空检查）。 */
  ringRuns: Vec2[][];
  bridges: Array<{ from: Vec2; to: Vec2 }>;
  /** 已放置用地（间距 hard 判据；assign 按序追加）。 */
  placed: Array<{ x: number; z: number; radius: number; id?: string; kind?: string; yaw?: number; shore?: Vec2 }>;
  height: (x: number, z: number) => number;
  inRiver: (x: number, z: number) => boolean;
  riverBank: (x: number, z: number, bank: number) => boolean;
  coastDistance: (x: number, z: number) => number;
  landClearance: (x: number, z: number) => number;
  buildable: (x: number, z: number) => boolean;
  hasRiver: boolean;
  riverX: (z: number) => number;
  riverWidth: (z: number) => number;
  hillDir: Vec2;
  hillLine: number;
  hillProj: (x: number, z: number) => number;
};

const segmentLength = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.z - a.z);

/** 折线全部线段（跨路/临街候选按段枚举）。 */
function runsToSegments(runs: Vec2[][]): Array<{ a: Vec2; b: Vec2; run: number; index: number }> {
  const out: Array<{ a: Vec2; b: Vec2; run: number; index: number }> = [];
  runs.forEach((run, r) => run.forEach((b, k) => { if (k > 0) out.push({ a: run[k - 1], b, run: r, index: k }); }));
  return out;
}

const projectOnSegment = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b.x - a.x; const dz = b.z - a.z; const len = Math.hypot(dx, dz) || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (len * len)));
  return { foot: { x: a.x + dx * t, z: a.z + dz * t }, dx, dz, len };
};

/** 环线净空（与 cityPlan.clearsHighways 同公式：EXPRESSWAY_DECK_WIDTH / 2 + 半对角 + 1；纯函数版，无空间索引）。 */
export function clearsRingRuns(p: Vec2, width: number, depth: number, ringRuns: Vec2[][]): boolean {
  return polylineDistance(ringRuns, p) >= EXPRESSWAY_DECK_WIDTH / 2 + Math.hypot(width, depth) / 2 + 1;
}

/** Read-only frontage spans: segmentation into short graph edges must not
 * hide an otherwise continuous straight road. Never chord a bent road, cross
 * a junction/bridge or merge different widths, structures or purposes. */
export function groundFrontageSegments(edges: readonly RoadEdge[], minWidth = roadWidthFor("arterial")): Array<[Vec2, Vec2]> {
  if (!Number.isFinite(minWidth) || minWidth <= 0) return [];
  const incident = new Map<string, RoadEdge[]>();
  for (const edge of edges) for (const id of [edge.from, edge.to]) {
    const list = incident.get(id); if (list) list.push(edge); else incident.set(id, [edge]);
  }
  const eligible = (edge: RoadEdge) => !edge.bridge && edge.width >= minWidth && (edge.structure ?? "ground-road") === "ground-road"
    && edge.points.length >= 2 && edge.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
  const straight = (points: Vec2[]) => {
    const a = points[0], b = points[points.length - 1], dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    if (length <= 0) return false;
    let previous = -Infinity;
    for (const point of points) {
      const t = ((point.x - a.x) * dx + (point.z - a.z) * dz) / (length * length);
      // Two centigrid endpoint roundings can differ by at most 0.02 units.
      if (Math.abs((point.x - a.x) * dz - (point.z - a.z) * dx) / length > 0.02 || t < previous) return false;
      previous = t;
    }
    return true;
  };
  const seen = new Set<string>(), result: Array<[Vec2, Vec2]> = [];
  for (const edge of [...edges].filter(eligible).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id); let points = [...edge.points], from = edge.from, to = edge.to;
    for (const prepend of [false, true]) for (;;) {
      const node = prepend ? from : to, neighbors = incident.get(node) ?? [];
      if (neighbors.length !== 2) break;
      const other = neighbors.find((road) => !seen.has(road.id));
      if (!other || !eligible(other) || other.width !== edge.width || other.kind !== edge.kind
        || other.purpose !== edge.purpose || other.structure !== edge.structure) break;
      const away = other.from === node ? other.points : [...other.points].reverse();
      const combined = prepend ? [...[...away].reverse().slice(0, -1), ...points] : [...points, ...away.slice(1)];
      if (!straight(combined)) break;
      points = combined; seen.add(other.id);
      const next = other.from === node ? other.to : other.from;
      if (prepend) from = next; else to = next;
    }
    if (straight(points)) result.push([points[0], points[points.length - 1]]);
    else for (let i = 1; i < points.length; i += 1) result.push([points[i - 1], points[i]]);
  }
  const id = (point: Vec2) => `${point.x}:${point.z}`;
  return result.map(([a, b]): [Vec2, Vec2] => id(a) < id(b) ? [a, b] : [b, a])
    .sort((a, b) => `${id(a[0])}/${id(a[1])}` < `${id(b[0])}/${id(b[1])}` ? -1 : `${id(a[0])}/${id(a[1])}` > `${id(b[0])}/${id(b[1])}` ? 1 : 0);
}

/** 临街候选：最近 4 条主干段（按离 current 距离排序）× 两侧法线偏移 radius+12（临街遍公式）。 */
export function inlandFrontageCandidates(world: SiteCandidateWorld, spec: SiteSpec, current: Vec2): SiteCandidate[] {
  const requested = world.frontageCandidateLimit ?? 4;
  const ranked = runsToSegments(world.trunkRuns)
    .map((s) => ({ ...s, d: polylineDistance([[s.a, s.b]], current) }))
    .sort((x, y) => x.d - y.d || x.run - y.run || x.index - y.index);
  let selected = ranked.slice(0, requested);
  if (requested > 4) {
    const diverse: typeof ranked = [];
    const separation = Math.max(spec.radius * 2 + 20, 100);
    for (const segment of ranked) {
      const mid = { x: (segment.a.x + segment.b.x) / 2, z: (segment.a.z + segment.b.z) / 2 };
      if (diverse.every((other) => Math.hypot(mid.x - (other.a.x + other.b.x) / 2, mid.z - (other.a.z + other.b.z) / 2) >= separation)) diverse.push(segment);
      if (diverse.length === requested) break;
    }
    if (diverse.length < requested) for (const segment of ranked) {
      if (!diverse.includes(segment)) diverse.push(segment);
      if (diverse.length === requested) break;
    }
    selected = diverse;
  }
  selected = selected.slice(0, requested);
  const out: SiteCandidate[] = [];
  for (const seg of selected) {
    const { foot, dx, dz, len } = projectOnSegment(current, seg.a, seg.b);
    let nx = -dz / len; let nz = dx / len;
    if ((current.x - foot.x) * nx + (current.z - foot.z) * nz < 0) { nx = -nx; nz = -nz; }
    const probes = [foot, ...(world.frontageProbeFractions ?? []).map((t) => ({ x: seg.a.x + dx * t, z: seg.a.z + dz * t }))];
    for (const [probe, position] of probes.entries()) for (const sign of [1, -1]) {
      const offset = spec.radius + 12;
      out.push({
        id: `frontage:${seg.run}:${seg.index}:${sign > 0 ? "l" : "r"}${probe ? `:probe${probe}` : ""}`,
        // 与路网同一 0.01 坐标格；终筛消费的就是将发布的坐标，消除跨引擎末位漂移。
        x: Math.round((position.x + nx * sign * offset) * 100) / 100, z: Math.round((position.z + nz * sign * offset) * 100) / 100,
        yaw: -Math.atan2(dz, dx),
        source: `trunk segment ${seg.run}/${seg.index} normal ${sign > 0 ? "+" : "-"}`,
        frontage: { a: { ...seg.a }, b: { ...seg.b }, at: { ...position } },
      });
    }
  }
  for (const [index, point] of (world.frontageFallbackPoints ?? []).entries()) out.push({
    id: `service-region:${index}`,
    x: Math.round(point.x * 100) / 100,
    z: Math.round(point.z * 100) / 100,
    yaw: 0,
    source: `service region candidate ${index}`,
  });
  return out;
}

/** 跨路候选：主干中段（len ≥ 20）按离 current 距离排序的中点，开口轴沿路向（跨路遍公式）。 */
export function straddleTrunkCandidates(world: SiteCandidateWorld, spec: SiteSpec, current: Vec2): SiteCandidate[] {
  return runsToSegments(world.trunkRuns)
    .filter((s) => segmentLength(s.a, s.b) >= 20)
    .map((s) => ({ s, d: polylineDistance([[s.a, s.b]], current) }))
    .sort((x, y) => x.d - y.d || x.s.run - y.s.run || x.s.index - y.s.index)
    .slice(0, 8)
    .map(({ s }) => {
      const dx = s.b.x - s.a.x; const dz = s.b.z - s.a.z;
      return {
        id: `straddle:${s.run}:${s.index}`,
        x: s.a.x + dx * 0.5, z: s.a.z + dz * 0.5,
        yaw: Math.atan2(dx, dz),
        source: `trunk mid ${s.run}/${s.index}`,
      };
    });
}

/** 岸线候选：最近 8 个岸点（按离 current 距离），朝每个岸点滑移（步长 3、上限 100 步）到离岸 ≈ 0.7·radius（贴岸遍公式）。 */
export function shoreCandidates(world: SiteCandidateWorld, spec: SiteSpec, current: Vec2): SiteCandidate[] {
  const targets = [...world.coast]
    .map((q, i) => ({ q, i, d: Math.hypot(q.x - current.x, q.z - current.z) }))
    .sort((x, y) => x.d - y.d || x.i - y.i)
    .slice(0, 8);
  const out: SiteCandidate[] = [];
  for (const { q, i } of targets) {
    let x = current.x; let z = current.z;
    for (let step = 0; step < 100 && world.coastDistance(x, z) > spec.radius * 0.7; step += 1) {
      const dx = q.x - x; const dz = q.z - z; const len = Math.hypot(dx, dz) || 1;
      x += (dx / len) * 3; z += (dz / len) * 3;
    }
    const tangent = Math.atan2(q.x - x, q.z - z); // 岸线近似切向（候选朝向；soft 偏好再调）
    out.push({ id: `shore:${i}`, x, z, yaw: tangent, source: `coast point ${i} (slid to ~0.7r of water)` });
  }
  return out;
}

/** 海上岛候选：最近 40 个岸点，沿「离核向外」radius+40（海上岛遍公式），堤道陆地端 = 岸点向内 6。 */
export function offshoreIslandCandidates(world: SiteCandidateWorld, spec: SiteSpec, current: Vec2): SiteCandidate[] {
  const targets = [...world.coast]
    .map((q, i) => ({ q, i, d: Math.hypot(q.x - current.x, q.z - current.z) }))
    .sort((x, y) => x.d - y.d || x.i - y.i)
    .slice(0, 40);
  const out: SiteCandidate[] = [];
  for (const { q, i } of targets) {
    const len = Math.hypot(q.x - world.core.x, q.z - world.core.z) || 1;
    const outx = (q.x - world.core.x) / len; const outz = (q.z - world.core.z) / len;
    out.push({
      id: `offshore:${i}`,
      x: q.x + outx * (spec.radius + 40), z: q.z + outz * (spec.radius + 40),
      yaw: -Math.atan2(outz, outx),
      source: `coast point ${i} + outward ${spec.radius + 40}`,
      shoreAnchor: { x: q.x - outx * 6, z: q.z - outz * 6 },
    });
  }
  return out;
}

/** 广场候选：核心点本身（chooseCore 硬门 + 核心跟随的构造保证；单候选）。 */
export function plazaCandidates(world: SiteCandidateWorld, spec: SiteSpec): SiteCandidate[] {
  return [{ id: "plaza:core", x: world.core.x, z: world.core.z, yaw: spec.initialYaw.value ?? 0, source: "core by construction" }];
}

/** placement 五类 → 生成器分派（assign.ts 的入口；新增 placement 必须显式登记）。 */
export function candidatesFor(world: SiteCandidateWorld, spec: SiteSpec, current: Vec2): SiteCandidate[] {
  switch (spec.placement) {
    case "inland-frontage": return inlandFrontageCandidates(world, spec, current);
    case "shore": return shoreCandidates(world, spec, current);
    case "offshore-island": return offshoreIslandCandidates(world, spec, current);
    case "straddle-trunk": return straddleTrunkCandidates(world, spec, current);
    case "plaza": return plazaCandidates(world, spec);
  }
}

/**
 * hard 闸门（骨架）：候选必须全过本类 hard 判据才参与 soft 排序。判据按 sitespec 的
 * HardCheckId 文档执行、全部复用现有谓词（footprint.*、clearsRingRuns = clearsHighways 公式）。
 * 返回首个不过的判据名（诊断用；null = 全过）。
 */
export function siteCandidateHardReject(world: SiteCandidateWorld, spec: SiteSpec, candidate: SiteCandidate): string | null {
  spendPlanningWork("site:hard-candidate", { candidate: 1 });
  const geo = { height: world.height, inRiver: world.inRiver, riverBank: world.riverBank };
  const at = { x: candidate.x, z: candidate.z };
  const r = spec.radius;
  const footprint = siteFootprint(spec.kind, `candidate:${spec.kind}`, r);
  const exactFootprint = footprint.exact ? footprint : null;
  const shapeDry = () => {
    if (!exactFootprint) return isDry(geo, at, r) ? null : "dry-footprint";
    const footprintSamples = worldFootprintSamples(footprint, at, candidate.yaw);
    return footprintSamples.length && footprintSamples.every((point) => world.height(point.x, point.z) >= 0.8 && !world.inRiver(point.x, point.z)
      && (world.landClearance(point.x, point.z) >= 4)) ? null : "dry-footprint";
  };
  const spacing = (gap: number) => world.placed.some((o) => world.usePlacedFootprints && o.kind && o.id && Number.isFinite(o.yaw)
    ? siteFootprintSeparation({ ...at, id: candidate.id, kind: spec.kind, yaw: candidate.yaw, radius: r },
      { ...o, id: o.id, kind: o.kind, yaw: o.yaw! }) < gap
    : exactFootprint ? footprintCircleDistance(footprint, at, candidate.yaw, o, o.radius) < gap
      : Math.hypot(o.x - at.x, o.z - at.z) < o.radius + r + gap) ? `site-spacing(+${gap})` : null;
  const ring = () => (clearsRingRuns(at, r * 2, r * 2, world.ringRuns) ? null : "clear-of-highways");
  switch (spec.placement) {
    case "plaza":
      return world.landClearance(at.x, at.z) >= r + 14 ? null : "snap-land-clearance";
    case "inland-frontage":
      if (!world.buildable(at.x, at.z)) return "buildable-center";
      if (exactFootprint) {
        // Keep the complete physical checks, but reject on inexpensive geometry before sampling terrain.
        if (!world.allowGroundCorridorRelocation && footprintRunsDistance(footprint, at, candidate.yaw, world.trunkRuns) < 8)
          return "trunk-clearance-r+8";
        const highwayFailure = ring();
        if (highwayFailure) return highwayFailure;
        const spacingFailure = spacing(10);
        if (spacingFailure) return spacingFailure;
        return shapeDry();
      }
      return (shapeDry())
        ?? (world.landClearance(at.x, at.z) < r + 4 ? "land-clearance-r+4" : null)
        ?? (polylineDistance(world.trunkRuns, at) >= r + 8 ? null : "trunk-clearance-r+8")
        ?? ring()
        ?? spacing(10);
    case "straddle-trunk":
      return (world.buildable(at.x, at.z) ? null : "buildable-center")
        ?? (isDry(geo, at, r) ? null : "dry-footprint")
        ?? ring()
        ?? spacing(10)
        ?? ((world.groundRoads ?? world.trunkRuns.map(points => ({ points, width: roadWidthFor("arterial") }))).every(road => road.points.slice(1).every((point, i) => siteRoadClear(
          { ...at, id: candidate.id, kind: spec.kind, yaw: candidate.yaw, radius: r }, road.points[i], point, road.width)))
          ? null : "declared-passage-road-clearance");
    case "shore":
      return (wetCount(geo, at, r, { river: true, riverBank: 14 }) <= 3 ? null : "wet-budget-3-riverbank")
        ?? (world.coastDistance(at.x, at.z) <= r * 0.7 ? null : "coast-distance-0.7r")
        ?? (world.height(at.x, at.z) > 0.5 ? null : "height-above-0.5")
        ?? (!world.inRiver(at.x, at.z) ? null : "not-in-river")
        ?? (polylineDistance(world.trunkRuns, at) >= r + 4 ? null : "trunk-clearance-r+4")
        ?? (nearBridgeEnd(world.bridges, at.x, at.z, r) ? "not-near-bridge-end" : null)
        ?? ring()
        ?? spacing(0);
    case "offshore-island": {
      if (!isDeepWater(geo, at, r)) return "deep-water-ring";
      const anchor = candidate.shoreAnchor;
      if (!anchor || world.height(anchor.x, anchor.z) < 0.3) return "causeway-land-dry";
      const harbor = world.placed.find((o) => Math.hypot(o.x - at.x, o.z - at.z) < o.radius + r + 120);
      if (harbor) return "harbor-distance-120";
      return spacing(30);
    }
  }
}

// ── 临路挪动四遍（V2 网络优先批次 6b-2：从 buildPlan 逐字迁出，闭包改显式 ctx；迭代顺序、
// 阈值与注释一律不变——行为保持由计划/场景基线哈希证明）─────────────────────────────
// 岸边/跨路/广场豁免集合由 sitespec 表派生（frontageExemptKinds === SHORE_BOUND ∪ STRADDLE、
// straddleSitingKinds === STRADDLE，守卫证值相等）。segmentDistance 仍取自 cityPlan
// （原语反转移是后续依赖倒置批次的事，本批不新增第三份实现）。

/** 临路挪动四遍共用的只读依赖 + 可变用地表 + buildPlan 的两个环搜闭包（snap/siteClearance 按引用传入）。 */
export type FrontageMoveContext = {
  groundRoads?: ReadonlyArray<Pick<RoadEdge, "points" | "width">>;
  publicSites: PublicSite[];
  landmarks: Landmark[];
  /** Optional relocation transaction scope; omitted means the existing full pass. */
  relocateSiteIds?: ReadonlySet<string>;
  /** Additional along-road probes only for an explicit late arch retry. */
  straddleProbeFractions?: readonly number[];
  /** 主干折线（distanceToTrunks = polylineDistance）。 */
  trunkRuns: Vec2[][];
  /** 主干按段、桥段剔除（跨路/临街遍的候选段；与 buildPlan 的 trunkSegments 同一份数组）。 */
  trunkSegments: Array<readonly [Vec2, Vec2]>;
  ringRuns: Vec2[][];
  height: (x: number, z: number) => number;
  inRiver: (x: number, z: number) => boolean;
  riverBank: (x: number, z: number, bank: number) => boolean;
  buildable: (x: number, z: number) => boolean;
  landClearance: (x: number, z: number) => number;
  snap: (nominal: Vec2, clearance: number, placed: Array<Vec2 & { radius: number }>, radius: number, accept?: (q: Vec2) => boolean) => Vec2;
  siteClearance: (kind: string, radius: number) => number;
};

const FRONTAGE_EXEMPT = frontageExemptKinds();
const STRADDLE_KINDS = straddleSitingKinds();

/** 避高架遍（原 buildPlan「压环线的预留地重新贴位」）：用地与地标先于环线选址，名义位置可能正压在
 *  高架下——压线的（clearsHighways 不过）用 snap 原地重贴到不压高架的位置（accept 含高架净空）。 */
export function restickSitesClearOfRingRuns(ctx: FrontageMoveContext): void {
  const { publicSites, landmarks, ringRuns, snap, siteClearance } = ctx;
  for (const site of [...publicSites, ...landmarks]) {
    if (ctx.relocateSiteIds && !ctx.relocateSiteIds.has(site.id)) continue;
    if (!site.radius || ("access" in site && site.access) || clearsRingRuns(site, site.radius * 2, site.radius * 2, ringRuns)) continue;
    const others = [...publicSites, ...landmarks].filter((o) => o !== site).map((o) => ({ x: o.x, z: o.z, radius: o.radius }));
    const q = snap(site, siteClearance(site.kind, site.radius), others, site.radius, (c) => clearsRingRuns(c, site.radius * 2, site.radius * 2, ringRuns));
    site.x = q.x; site.z = q.z;
  }
}

/** 跨路遍（原 buildPlan「凯旋门骑上主干中段」）：取离用地最近的主干段（len ≥ 20）中点，
 *  要求可建、占地全干、不压环线高架、距其它用地 ≥ r_o+r+10；开口轴（局部 z）沿道路方向。 */
export function straddleSitesAcrossTrunk(ctx: Pick<FrontageMoveContext, "publicSites" | "landmarks" | "trunkSegments" | "groundRoads" | "ringRuns" | "buildable" | "height" | "inRiver" | "riverBank" | "relocateSiteIds" | "straddleProbeFractions">): void {
  const { publicSites, landmarks, trunkSegments, ringRuns, buildable, height, inRiver, riverBank } = ctx;
  const footprintGeo = { height, inRiver, riverBank };
  const footprintDry = (c: Vec2, r: number) => isDry(footprintGeo, c, r);
  for (const site of landmarks) {
    if (ctx.relocateSiteIds && !ctx.relocateSiteIds.has(site.id)) continue;
    if (!STRADDLE_KINDS.has(site.kind)) continue;
    const ranked = trunkSegments.map(([a, b]) => ({ a, b, d: segmentDistance(site, a, b) })).sort((x, y) => x.d - y.d);
    const others = [...publicSites, ...landmarks].filter((o) => o !== site && o.radius);
    place: for (const probe of ctx.straddleProbeFractions ?? [0.5]) for (const { a, b } of ranked) {
      const dx = b.x - a.x; const dz = b.z - a.z; const len = Math.hypot(dx, dz);
      if (len < 20) continue;
      const q = { x: a.x + dx * probe, z: a.z + dz * probe };
      if (!buildable(q.x, q.z) || !footprintDry(q, site.radius)) continue;
      if (!clearsRingRuns(q, site.radius * 2, site.radius * 2, ringRuns)) continue; // 不能压在环线高架下（geography 守卫）
      if (others.some((o) => Math.hypot(o.x - q.x, o.z - q.z) < o.radius + site.radius + 10)) continue;
      const pose = { ...site, ...q, yaw: Math.atan2(dx, dz) };
      const roads = ctx.groundRoads ?? trunkSegments.map(([u, v]) => ({ points: [u, v], width: roadWidthFor("arterial") }));
      if (!roads.every(road => road.points.slice(1).every((point, i) => siteRoadClear(pose, road.points[i], point, road.width)))) continue;
      site.x = q.x; site.z = q.z; site.yaw = pose.yaw;
      break place;
    }
  }
}

/** 临街遍（原 buildPlan「内陆用地贴到最近主干道一侧」）：最近 4 条主干段的投影垂足、沿法线偏移
 *  radius+12（两侧），边缘离路肩、朝向与路对齐；全干、离水 ≥ r+4、别的主干道也不能穿过（r+8）、
 *  避高架、距其它用地 ≥ r_o+r+10。找不到临街位置且被主干穿过时，snap 挪到离主干 ≥ r+8 处。 */
export function frontSitesOnTrunks(ctx: FrontageMoveContext): void {
  const { publicSites, landmarks, trunkSegments, trunkRuns, ringRuns, buildable, landClearance, height, inRiver, riverBank, snap, siteClearance } = ctx;
  const footprintGeo = { height, inRiver, riverBank };
  const footprintDry = (c: Vec2, r: number) => isDry(footprintGeo, c, r);
  const distanceToTrunks = (p: Vec2) => polylineDistance(trunkRuns, p);
  for (const site of [...publicSites, ...landmarks]) {
    if (ctx.relocateSiteIds && !ctx.relocateSiteIds.has(site.id)) continue;
    if (!site.radius || ("access" in site && site.access) || FRONTAGE_EXEMPT.has(site.kind)) continue;
    const ranked = trunkSegments.map(([a, b]) => ({ a, b, d: segmentDistance(site, a, b) })).sort((x, y) => x.d - y.d).slice(0, 4);
    const others = [...publicSites, ...landmarks].filter((o) => o !== site && o.radius);
    let placed = false;
    for (const { a, b } of ranked) {
      const dx = b.x - a.x; const dz = b.z - a.z; const len = Math.hypot(dx, dz) || 1;
      const t = Math.max(0.2, Math.min(0.8, ((site.x - a.x) * dx + (site.z - a.z) * dz) / (len * len)));
      const foot = { x: a.x + dx * t, z: a.z + dz * t };
      let nx = -dz / len; let nz = dx / len;
      if ((site.x - foot.x) * nx + (site.z - foot.z) * nz < 0) { nx = -nx; nz = -nz; }
      for (const sign of [1, -1]) {
        const offset = site.radius + 12;
        const q = { x: foot.x + nx * sign * offset, z: foot.z + nz * sign * offset };
        // 整个占地都要在陆上：曾只要求中心离水 0.6 半径，双子塔（两塔各偏 13）一半立进河里（真机截图）。
        if (!buildable(q.x, q.z) || landClearance(q.x, q.z) < site.radius + 4 || !footprintDry(q, site.radius)) continue;
        if (distanceToTrunks(q) < site.radius + 8) continue;               // 别的主干道也不能穿过它
        if (!clearsRingRuns(q, site.radius * 2, site.radius * 2, ringRuns)) continue;
        if (others.some((o) => Math.hypot(o.x - q.x, o.z - q.z) < o.radius + site.radius + 10)) continue;
        site.x = q.x; site.z = q.z; site.yaw = -Math.atan2(dz, dx);
        placed = true; break;
      }
      if (placed) break;
    }
    // 找不到临街位置时，至少别让主干道从中间穿过：就近挪到离主干道 ≥ 半径+8 的位置。
    const requiredRelocation = ctx.relocateSiteIds?.has(site.id) ?? false;
    if (!placed && (requiredRelocation || distanceToTrunks(site) < site.radius + 6)) {
      const q = snap(site, siteClearance(site.kind, site.radius), others.map((o) => ({ x: o.x, z: o.z, radius: o.radius })), site.radius,
        (c) => distanceToTrunks(c) >= site.radius + 8 && (!requiredRelocation || distanceToTrunks(c) <= site.radius + 20)
          && landClearance(c.x, c.z) >= site.radius + 4 && footprintDry(c, site.radius) && clearsRingRuns(c, site.radius * 2, site.radius * 2, ringRuns));
      site.x = q.x; site.z = q.z;
    }
  }
}

/** 干地遍（原 buildPlan「仍不在干地的用地重贴」）：非岸边/跨路类用地若 landClearance < r+4 或占地
 *  不全干，用 snap（accept 含四项联合判据）重贴。岸边/跨路/广场豁免（各有专属遍/构造保证）。 */
export function resnapSitesOntoDryLand(ctx: FrontageMoveContext): void {
  const { publicSites, landmarks, trunkRuns, ringRuns, landClearance, height, inRiver, riverBank, snap, siteClearance } = ctx;
  const footprintGeo = { height, inRiver, riverBank };
  const footprintDry = (c: Vec2, r: number) => isDry(footprintGeo, c, r);
  const distanceToTrunks = (p: Vec2) => polylineDistance(trunkRuns, p);
  for (const site of [...publicSites, ...landmarks]) {
    if (ctx.relocateSiteIds && !ctx.relocateSiteIds.has(site.id)) continue;
    if (!site.radius || ("access" in site && site.access) || FRONTAGE_EXEMPT.has(site.kind) || (landClearance(site.x, site.z) >= site.radius + 4 && footprintDry(site, site.radius))) continue;
    const others = [...publicSites, ...landmarks].filter((o) => o !== site && o.radius).map((o) => ({ x: o.x, z: o.z, radius: o.radius }));
    const q = snap(site, siteClearance(site.kind, site.radius), others, site.radius,
      (c) => landClearance(c.x, c.z) >= site.radius + 4 && footprintDry(c, site.radius) && distanceToTrunks(c) >= site.radius + 8 && clearsRingRuns(c, site.radius * 2, site.radius * 2, ringRuns));
    site.x = q.x; site.z = q.z;
  }
}
