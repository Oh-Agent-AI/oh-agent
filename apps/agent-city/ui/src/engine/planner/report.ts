/**
 * 路网优先优化方案 · 批次 0（实测基线）：不依赖渲染的道路诊断报告。
 *
 * 输入是「一张路网图 + 它的规划上下文」——完整规划图（createCityPlan 产物）或
 * layoutCity 生长剪枝后的显示图都行，同一组指标跑在同一函数里，只测量、不改规划。
 * 纯函数、确定性、无副作用：不 import three、不读文件、不碰输入对象的任何字段；
 * 所有输出集合按 id/键排序、数值取整，输入 roadEdges 的顺序不影响结果
 * （verify-city-road-report 用固定种子洗牌复证）。
 *
 * 口径来源（只读复用，不改这些模块）：
 *  - 主网定义：intent.primaryComponentId——「含 civic/plaza 骨架节点的连通分量」。本模块的
 *    最小输入没有 core，而 createCityPlan 会把 core 重新锚到 civic 广场上（cityPlan.ts 的
 *    place("civic-square") 之后 core = 广场中心），故取「离任一 civic 类 publicSite 最近的路端」
 *    所在分量为 primary；无 civic 用地时报 null（与 intent「civic 骨架缺失→只作诊断」一致）。
 *    分量代表取分量内字典序最小节点 id（intent.componentOf 的代表是合并顺序相关的，
 *    这里换成规范代表以保洗牌不变性）。
 *  - 度1非桥端角色：intent.classifyEndpoints 的 cul-de-sac 分类经 plan.culDeSacEnds /
 *    layout.culDeSacEnds 投影到对应图层（后者已按「最终图里仍是度1非桥端」过滤，
 *    cityLayout.ts 的 culDeSacEnds 口径），因此「在 culDeSacEnds 内」即「intent 判为
 *    cul-de-sac」。完整图分类不传 referenceRoadEdges，「可接近缺口」恒 0。
 *  - 设施门路：intent.evaluateDemands 的 site-access 判据半径（≤ radius+20；最近路含桥）。
 *    evaluateDemands 要求「全局最近的那条边」本身在主网上，这里分开报两个距离
 *    （最近任意边 / 最近主网边）+「最近主网边 ≤ radius+20」布尔，调用方可按任一口径复核。
 *  - 显示层锚点：cityLayout.ts growWithBuildings 的 anchors（活跃街区 hypot(w,d)/2+4、
 *    用地 radius+16、酒店地块 26）——空置区窄路的「预留/无支撑」判定与裁剪时的 serves() 同口径，
 *    于是「无支撑」即连通性 BFS 加回的窄边。
 */
import { atLeast, roadWidthFor } from "../roadStandard";
import { seasideHotelLots, type SeasideBand } from "../citySeaside";
import type { CityBlock, PublicSite, RoadEdge, RoadNode, Vec2 } from "../cityLayout";
import type { Landmark } from "../cityPlan";
import { bridgeLandingNodes, isOwnedIslandGate } from "./endpoints";
import { classifyRoadSegments, closestSegmentPoints, ROAD_RELATION_CONFIG, type SegmentRelationKind } from "./relations";

// ── 输入/输出契约 ─────────────────────────────────────────────────────────────

/** 跑全部指标所需的最小集合；完整规划图与显示图共用。 */
export type RoadReportInput = {
  /** 图层由调用方声明，不能根据空置街区猜测（全建成/空城仍是 display）。 */
  layer: "plan" | "display";
  roadEdges: RoadEdge[];
  /** 可选；缺省时端点坐标取自各边 points（端点键即 `${x}:${z}`）。 */
  nodes?: RoadNode[];
  blocks: CityBlock[];
  publicSites: PublicSite[];
  landmarks: Landmark[];
  culDeSacEnds?: Vec2[];
  seaside?: SeasideBand | null;
  /** 报显示图时传完整规划边（判「可接近缺口」：该端在完整图里有更多邻边）；完整图报告不传。 */
  referenceRoadEdges?: RoadEdge[];
};

export type Degree1Finding = {
  id: string;
  cls: "bridge-landing" | "legal-cul-de-sac" | "approachable-gap" | "unclassified";
  at: Vec2;
  reason: string;
};
export type CrossingFinding = { id: string; edges: [string, string]; reason: string; relation: SegmentRelationKind; distance: number };
export type AcuteJunctionFinding = { id: string; angleDeg: number; reason: string };
export type BridgeFinding = { id: string; reason: string };
export type FacilityFinding = {
  id: string;
  kind: string;
  radius: number;
  nearestRoadDist: number | null;
  nearestPrimaryDist: number | null;
  withinPrimaryNeighborhood: boolean;
  reason: string;
};

export type RoadReport = {
  /** display = 输入 blocks 带生长剪枝的 vacant 标记（显示层）；plan = 完整规划图。 */
  layer: "plan" | "display";
  edgeCount: number;
  nodeCount: number;
  graph: {
    componentCount: number;
    primaryComponentId: string | null;
    primaryBasis: string;
    degree1: { total: number; bridgeLandings: number; legalCulDeSac: number; approachableGap: number; unclassified: number; findings: Degree1Finding[] };
    planarCrossings: { count: number; findings: CrossingFinding[] };
    lengthByWidth: { ge12: { length: number; share: number }; ge8lt12: { length: number; share: number }; lt8: { length: number; share: number } };
    junctions: { total: number; degreeHistogram: Array<{ degree: number; count: number }>; minAngleDeg: number | null; acuteBelow30: number; findings: AcuteJunctionFinding[] };
    bridges: { total: number; violations: BridgeFinding[] };
  };
  facilities: { total: number; doorsOk: number; findings: FacilityFinding[] };
  blocks: {
    analyzed: number;
    area: { p50: number; max: number };
    aspectRatio: { p50: number; max: number };
    frontageEdges: { p50: number; max: number };
    /** 主导边方向角 mod 90° 分 6 桶（每桶 15°）。 */
    orientationBuckets: number[];
    gridRepetition: { districts: Array<{ districtId: string; blocks: number; repetition: number }>; cityMax: number };
  };
  /** 仅显示层（blocks 含 vacant 标记）存在。 */
  display?: {
    liveBlocks: number;
    vacantBlocks: number;
    activityServiceRate: number;
    vacantNarrowRoads: {
      totalLength: number;
      reservedLength: number;
      unsupportedLength: number;
      reservedEdgeIds: string[];
      unsupportedEdgeIds: string[];
    };
  };
};

// ── 几何与统计原语（全部纯函数） ──────────────────────────────────────────────

const CROSSING_TOLERANCE = ROAD_RELATION_CONFIG.nearDistance;
const FRONTAGE_MAX_DISTANCE = 3;
const FRONTAGE_MAX_ANGLE_DEG = 25;
const SERVICE_RADIUS = 30;
const ACUTE_ANGLE_DEG = 30;
const AREA_BUCKET_WIDTH = 40;
const CELL = 60;

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const pointSegDistance = (p: Vec2, a: Vec2, b: Vec2): number => {
  const dx = b.x - a.x; const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
};

/** 两线段最小距离（Ericson《Real-Time Collision Detection》闭式解，含端点钳制）。 */
const segSegDistance = (p1: Vec2, q1: Vec2, p2: Vec2, q2: Vec2): number => {
  return closestSegmentPoints(p1, q1, p2, q2).distance;
};

/** 两方向所在的直线夹角（0 = 平行，90 = 垂直）。 */
const lineAngleDeg = (u: Vec2, v: Vec2): number => {
  const lu = Math.hypot(u.x, u.z); const lv = Math.hypot(v.x, v.z);
  if (lu < 1e-9 || lv < 1e-9) return 90;
  const d = Math.abs((u.x * v.x + u.z * v.z) / (lu * lv));
  return Math.acos(Math.max(0, Math.min(1, d))) * 180 / Math.PI;
};

const percentile50 = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

type Seg = { id: string; edge: RoadEdge; a: Vec2; b: Vec2 };

const segsOf = (edges: RoadEdge[]): Seg[] => edges.map((edge) => ({
  id: edge.id, edge, a: edge.points[0], b: edge.points[edge.points.length - 1],
}));

/** 60 单位格空间索引（同 cityPlan 的 SegmentIndex 思路；查询按包围盒取格、按 id 去重）。 */
const bucket = (segs: Seg[]): Map<string, Seg[]> => {
  const cells = new Map<string, Seg[]>();
  for (const s of segs) {
    for (let gx = Math.floor(Math.min(s.a.x, s.b.x) / CELL); gx <= Math.floor(Math.max(s.a.x, s.b.x) / CELL); gx += 1)
      for (let gz = Math.floor(Math.min(s.a.z, s.b.z) / CELL); gz <= Math.floor(Math.max(s.a.z, s.b.z) / CELL); gz += 1) {
        const key = `${gx}:${gz}`;
        const list = cells.get(key);
        if (list) list.push(s); else cells.set(key, [s]);
      }
  }
  return cells;
};
const querySegs = (cells: Map<string, Seg[]>, minX: number, minZ: number, maxX: number, maxZ: number): Seg[] => {
  const seen = new Set<string>();
  const out: Seg[] = [];
  for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx += 1)
    for (let gz = Math.floor(minZ / CELL); gz <= Math.floor(maxZ / CELL); gz += 1)
      for (const s of cells.get(`${gx}:${gz}`) ?? []) if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
  return out.sort(byId);
};

/** 并查集（桥计入连通），分量代表规范为「分量内字典序最小节点 id」。 */
const componentsOf = (edges: RoadEdge[]): { compOf: Map<string, string>; count: number } => {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = x;
    while (parent.get(cursor) !== root) { const next = parent.get(cursor)!; parent.set(cursor, root); cursor = next; }
    return root;
  };
  for (const e of edges) for (const id of [e.from, e.to]) if (!parent.has(id)) parent.set(id, id);
  for (const e of edges) { const ra = find(e.from); const rb = find(e.to); if (ra !== rb) parent.set(ra, rb); }
  const canonical = new Map<string, string>();
  for (const id of parent.keys()) {
    const root = find(id);
    const best = canonical.get(root);
    if (best === undefined || id < best) canonical.set(root, id);
  }
  const compOf = new Map<string, string>();
  for (const id of parent.keys()) compOf.set(id, canonical.get(find(id))!);
  return { compOf, count: new Set(compOf.values()).size };
};

// ── 报告主体 ─────────────────────────────────────────────────────────────────

/** 求解与报告共用的未接入平面交叉/近接度量。 */
export function groundJunctionFindings(edges: readonly RoadEdge[]): CrossingFinding[] {
  const segments: Seg[] = [...edges].sort(byId).flatMap((edge) => edge.points.slice(1).map((point, index) => ({ id: JSON.stringify([edge.id, index]), edge, a: edge.points[index], b: point })));
  const nonBridgeSegs = segments.filter((s) => !s.edge.bridge);
  const cells = bucket(nonBridgeSegs);
  const findings = new Map<string, { finding: CrossingFinding; distance: number }>();
  for (const s of nonBridgeSegs) {
    const pad = CROSSING_TOLERANCE;
    const minX = Math.min(s.a.x, s.b.x) - pad; const maxX = Math.max(s.a.x, s.b.x) + pad;
    const minZ = Math.min(s.a.z, s.b.z) - pad; const maxZ = Math.max(s.a.z, s.b.z) + pad;
    for (const o of querySegs(cells, minX, minZ, maxX, maxZ)) {
      if (o.id <= s.id) continue; // 每个无序对只从字典序小的一侧看一次
      if (o.edge.id === s.edge.id) continue;
      const same = (a: Vec2, b: Vec2) => a.x === b.x && a.z === b.z;
      const containsEndpoint = (segment: Seg, node: string) => {
        const point = node === segment.edge.from ? segment.edge.points[0] : segment.edge.points[segment.edge.points.length - 1];
        return same(segment.a, point) || same(segment.b, point);
      };
      const shared = [s.edge.from, s.edge.to].filter((node) => node === o.edge.from || node === o.edge.to);
      if (shared.some((node) => containsEndpoint(s, node) && containsEndpoint(o, node))) continue;
      const relation = classifyRoadSegments(s.a, s.b, o.a, o.b);
      const d = relation.distance;
      if (d <= CROSSING_TOLERANCE) {
        const pair = [s.edge.id, o.edge.id].sort() as [string, string];
        const id = pair.join("|");
        if (!findings.has(id) || d < findings.get(id)!.distance) findings.set(id, { distance: d, finding: { id, edges: pair, relation: relation.kind, distance: round4(d), reason: `non-bridge segments meet (distance ${round2(d)} ≤ ${CROSSING_TOLERANCE}) without a shared node at this location` } });
      }
    }
  }
  return [...findings.values()].map(({ finding }) => finding).sort(byId);
}

export function roadReport(input: RoadReportInput): RoadReport {
  // 输入顺序不影响任何输出：先按 id 排序再消费。
  const edges = [...input.roadEdges].sort(byId);
  const segments = segsOf(edges);
  const edgeById = new Map(edges.map((e) => [e.id, e]));

  // 端点坐标表：边的 points 为准，nodes 提供时覆盖（同源值，仅防御性）。
  const positions = new Map<string, Vec2>();
  for (const e of edges) { positions.set(e.from, e.points[0]); positions.set(e.to, e.points[e.points.length - 1]); }
  for (const n of input.nodes ?? []) if (positions.has(n.id)) positions.set(n.id, { x: n.x, z: n.z });

  // A1 分量 + 主网（civic/plaza 骨架锚，见模块头口径说明）。
  const { compOf, count: componentCount } = componentsOf(edges);
  const civicSites = input.publicSites.filter((s) => s.kind === "civic");
  let primary: string | null = null;
  let primaryBasis: string;
  if (!civicSites.length) {
    primaryBasis = "no civic-kind publicSite in input — primary network undefined (intent.ts: absent civic skeleton is a planning failure, reported as-is)";
  } else if (!positions.size) {
    primaryBasis = "no road nodes in input — primary network undefined";
  } else {
    let best: { id: string; d: number; site: PublicSite } | null = null;
    for (const id of [...positions.keys()].sort()) {
      const at = positions.get(id)!;
      for (const site of civicSites) {
        const d = Math.hypot(site.x - at.x, site.z - at.z);
        if (!best || d < best.d || (d === best.d && id < best.id)) best = { id, d, site };
      }
    }
    primary = best ? compOf.get(best.id) ?? null : null;
    primaryBasis = best
      ? `civic site ${best.site.id} → nearest node ${best.id} (d ${round2(best.d)}) in component ${primary}`
      : "no road nodes in input — primary network undefined";
  }

  // 非桥邻接表（度口径：intent.classifyEndpoints / cityLayout culDeSacEnds 同为非桥度）。
  const incidence = new Map<string, string[]>();
  for (const e of edges) if (!e.bridge) for (const id of [e.from, e.to]) {
    const list = incidence.get(id);
    if (list) list.push(e.id); else incidence.set(id, [e.id]);
  }

  // A2 度1非桥端：连续桥头／合法尽端（culDeSacEnds，即 intent cul-de-sac 投影）／可接近缺口
  // （完整图里邻边更多，仅显示图有意义）／未分类。优先级 legal > gap > unclassified。
  const culDeSacKeys = new Set((input.culDeSacEnds ?? []).map((p) => `${p.x}:${p.z}`));
  const referenceDegree = new Map<string, number>();
  for (const e of input.referenceRoadEdges ?? []) if (!e.bridge) for (const id of [e.from, e.to]) referenceDegree.set(id, (referenceDegree.get(id) ?? 0) + 1);
  const degree1Findings: Degree1Finding[] = [];
  const landings = bridgeLandingNodes(edges);
  for (const id of [...incidence.keys()].sort()) {
    const list = incidence.get(id)!;
    if (list.length !== 1) continue;
    const at = positions.get(id) ?? { x: 0, z: 0 };
    if (landings.has(id)) {
      degree1Findings.push({ id, cls: "bridge-landing", at, reason: "ground and bridge edges share this actual node; continuation is present in the full road graph" });
    } else if (culDeSacKeys.has(id)) {
      degree1Findings.push({ id, cls: "legal-cul-de-sac", at, reason: "degree-1 non-bridge end listed in culDeSacEnds (intent classifyEndpoints cul-de-sac)" });
    } else if ((referenceDegree.get(id) ?? 0) >= 2) {
      degree1Findings.push({ id, cls: "approachable-gap", at, reason: `degree-1 in this graph but ${referenceDegree.get(id)} non-bridge edges meet here in the reference (full) graph — growth pruning left an approachable gap` });
    } else {
      degree1Findings.push({ id, cls: "unclassified", at, reason: "degree-1 non-bridge end with no legal-end evidence and no fuller connectivity in the reference graph" });
    }
  }
  const degree1 = {
    total: degree1Findings.length,
    bridgeLandings: degree1Findings.filter((f) => f.cls === "bridge-landing").length,
    legalCulDeSac: degree1Findings.filter((f) => f.cls === "legal-cul-de-sac").length,
    approachableGap: degree1Findings.filter((f) => f.cls === "approachable-gap").length,
    unclassified: degree1Findings.filter((f) => f.cls === "unclassified").length,
    findings: degree1Findings,
  };

  // A3 平面交叉：非桥边两两线段最小距离 ≤ 0.5 且无共享节点（包围盒分格粗筛 + id 严格序去重）。
  const crossingFindings = groundJunctionFindings(edges);
  const cells = bucket(segments.filter((segment) => !segment.edge.bridge));

  // A4 长度占比：宽 ≥12 / ≥8 且 <12 / 其余（12/8/5 三级；桥计入长度）。
  const lengthOf = (s: Seg) => Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z);
  const totalLength = segments.reduce((sum, s) => sum + lengthOf(s), 0);
  const bucketLength = (pred: (e: RoadEdge) => boolean) => segments.filter((s) => pred(s.edge)).reduce((sum, s) => sum + lengthOf(s), 0);
  const share = (len: number) => (totalLength > 0 ? round4(len / totalLength) : 0);
  const len12 = bucketLength((e) => atLeast(e, "arterial"));
  const len8 = bucketLength((e) => atLeast(e, "collector") && e.width < roadWidthFor("arterial"));
  const lenRest = bucketLength((e) => e.width < roadWidthFor("collector"));

  // A5 路口度数分布 + 最小交角（度≥3 计路口；角度取该点各对入边方向的夹角最小值）。
  const acuteFindings: AcuteJunctionFinding[] = [];
  let minAngleDeg: number | null = null;
  const junctionDegrees: number[] = [];
  for (const id of [...incidence.keys()].sort()) {
    const list = incidence.get(id)!;
    if (list.length < 3) continue;
    junctionDegrees.push(list.length);
    const at = positions.get(id) ?? { x: 0, z: 0 };
    const dirs = list.map((eid) => {
      const e = edgeById.get(eid)!;
      // Junction angle is the tangent of the road as it enters/leaves this
      // node, not the chord to the far endpoint (which is wrong for curves).
      const far = e.from === id ? e.points[1] : e.points[e.points.length - 2];
      const dx = far.x - at.x; const dz = far.z - at.z;
      const l = Math.hypot(dx, dz) || 1;
      return { x: dx / l, z: dz / l };
    });
    let local = 180;
    for (let i = 0; i < dirs.length; i += 1) for (let j = i + 1; j < dirs.length; j += 1) {
      const dot = Math.max(-1, Math.min(1, dirs[i].x * dirs[j].x + dirs[i].z * dirs[j].z));
      local = Math.min(local, Math.acos(dot) * 180 / Math.PI);
    }
    if (minAngleDeg === null || local < minAngleDeg) minAngleDeg = local;
    if (local < ACUTE_ANGLE_DEG) acuteFindings.push({ id, angleDeg: round2(local), reason: `junction with ${list.length} incident non-bridge edges has minimum intersection angle ${round2(local)}° < ${ACUTE_ANGLE_DEG}°` });
  }
  const degreeHistogram: Array<{ degree: number; count: number }> = [...junctionDegrees.reduce((counts, degree) => counts.set(degree, (counts.get(degree) ?? 0) + 1), new Map<number, number>())]
    .sort((x, y) => x[0] - y[0])
    .map(([degree, count]) => ({ degree, count }));

  // A6 设施门路：每用地最近任意边 / 最近主网边距离 +「最近主网边 ≤ radius+20」布尔。
  const facilityFindings: FacilityFinding[] = [];
  const siteList: Array<{ key: string; site: PublicSite | Landmark }> = [
    ...input.publicSites.map((site) => ({ key: `site:${site.id}`, site })),
    ...input.landmarks.map((site) => ({ key: `landmark:${site.id}`, site })),
  ].sort((x, y) => (x.key < y.key ? -1 : 1));
  for (const { key, site } of siteList) {
    if (!site.radius) continue;
    let nearest: number | null = null;
    let nearestPrimary: number | null = null;
    for (const s of segments) {
      const d = pointSegDistance(site, s.a, s.b);
      if (nearest === null || d < nearest) nearest = d;
      const onPrimary = primary !== null && (compOf.get(s.edge.from) === primary || compOf.get(s.edge.to) === primary);
      if (onPrimary && (nearestPrimary === null || d < nearestPrimary)) nearestPrimary = d;
    }
    const ok = nearestPrimary !== null && nearestPrimary <= site.radius + 20;
    facilityFindings.push({
      id: key, kind: site.kind, radius: site.radius,
      nearestRoadDist: nearest === null ? null : round2(nearest),
      nearestPrimaryDist: nearestPrimary === null ? null : round2(nearestPrimary),
      withinPrimaryNeighborhood: ok,
      reason: ok
        ? `nearest primary-network road within radius+20 (${round2(nearestPrimary!)} ≤ ${site.radius + 20})`
        : nearestPrimary === null
          ? `no primary-network road in this graph (nearest any-road distance ${nearest === null ? "n/a" : round2(nearest)})`
          : `nearest primary-network road ${round2(nearestPrimary)} > radius+20 ${site.radius + 20}`,
    });
  }

  // A7 Same contract as bridgeheadContinuity: an actual node plus a ground
  // road, or an explicitly owned, current island-side gate (not a landing).
  const bridgeViolations: BridgeFinding[] = [];
  const declaredNodes = new Set(input.nodes ? input.nodes.map((node) => node.id) : positions.keys());
  const islandSites = [...input.publicSites, ...input.landmarks];
  let bridgeTotal = 0;
  for (const e of edges) {
    if (!e.bridge) continue;
    bridgeTotal += 1;
    const endOk = (id: string) => declaredNodes.has(id) && ((incidence.get(id)?.length ?? 0) >= 1 || isOwnedIslandGate(id, islandSites));
    const fromOk = endOk(e.from);
    const toOk = endOk(e.to);
    if (!fromOk || !toOk) {
      const missing = [!fromOk ? e.from : null, !toOk ? e.to : null].filter(Boolean).join(", ");
      bridgeViolations.push({ id: e.id, reason: `bridge end ${missing} is missing or has neither an adjacent non-bridge edge nor a current owned island gate` });
    }
  }

  // B8 街区形态：面积 / 长宽比（按主导边方向的包围盒）/ 临街边数 / 朝向直方图 / 格网重复度。
  const areas: number[] = [];
  const aspects: number[] = [];
  const frontages: number[] = [];
  const orientationBuckets = [0, 0, 0, 0, 0, 0];
  const districts = new Map<string, Array<{ orientation: number; area: number }>>();
  for (const block of input.blocks) {
    const polygon = block.polygon ?? [];
    if (polygon.length < 3) continue;
    let area = 0;
    for (let k = 0; k < polygon.length; k += 1) {
      const a = polygon[k]; const b = polygon[(k + 1) % polygon.length];
      area += a.x * b.z - b.x * a.z;
    }
    area = Math.abs(area) / 2;
    // 主导边：最长的多边形边（并列取多边形序在前者）。
    let dominant: { index: number; length: number } | null = null;
    for (let k = 0; k < polygon.length; k += 1) {
      const a = polygon[k]; const b = polygon[(k + 1) % polygon.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (!dominant || len > dominant.length) dominant = { index: k, length: len };
    }
    const dp = polygon[dominant!.index]; const dq = polygon[(dominant!.index + 1) % polygon.length];
    const ux = (dq.x - dp.x) / (dominant!.length || 1); const uz = (dq.z - dp.z) / (dominant!.length || 1);
    let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
    for (const p of polygon) {
      const du = p.x * ux + p.z * uz; const dv = -p.x * uz + p.z * ux;
      minU = Math.min(minU, du); maxU = Math.max(maxU, du);
      minV = Math.min(minV, dv); maxV = Math.max(maxV, dv);
    }
    const extentU = maxU - minU; const extentV = maxV - minV;
    const aspect = Math.min(extentU, extentV) > 1e-6 ? Math.max(extentU, extentV) / Math.min(extentU, extentV) : 1;
    // 临街边：与某条非桥路段共线（夹角 ≤25°）且段距 ≤3 的多边形边（贴主干道的界面边不计——
    // 那条街属于主干道骨架，不属于本街区的街道；裁切线边本就不修街）。
    let front = 0;
    for (let k = 0; k < polygon.length; k += 1) {
      const a = polygon[k]; const b = polygon[(k + 1) % polygon.length];
      const dir = { x: b.x - a.x, z: b.z - a.z };
      if (Math.hypot(dir.x, dir.z) < 1e-6) continue;
      const candidates = querySegs(cells, Math.min(a.x, b.x) - FRONTAGE_MAX_DISTANCE, Math.min(a.z, b.z) - FRONTAGE_MAX_DISTANCE, Math.max(a.x, b.x) + FRONTAGE_MAX_DISTANCE, Math.max(a.z, b.z) + FRONTAGE_MAX_DISTANCE);
      if (candidates.some((s) => lineAngleDeg(dir, { x: s.b.x - s.a.x, z: s.b.z - s.a.z }) <= FRONTAGE_MAX_ANGLE_DEG && segSegDistance(a, b, s.a, s.b) <= FRONTAGE_MAX_DISTANCE)) front += 1;
    }
    const angleDeg = ((Math.atan2(dq.z - dp.z, dq.x - dp.x) * 180 / Math.PI) % 90 + 90) % 90;
    const orientation = Math.min(orientationBuckets.length - 1, Math.floor(angleDeg / 15));
    areas.push(area);
    aspects.push(aspect);
    frontages.push(front);
    orientationBuckets[orientation] += 1;
    const districtId = block.districtId ?? "";
    const list = districts.get(districtId);
    if (list) list.push({ orientation, area }); else districts.set(districtId, [{ orientation, area }]);
  }
  const gridDistricts = [...districts.keys()].sort().map((districtId) => {
    const members = districts.get(districtId)!;
    const combos = new Map<string, number>();
    for (const m of members) {
      const key = `${m.orientation}:${Math.floor(m.area / AREA_BUCKET_WIDTH)}`;
      combos.set(key, (combos.get(key) ?? 0) + 1);
    }
    // 众数组合（并列取组合键字典序最小，保洗牌/顺序无关）。
    let modal: { key: string; count: number } | null = null;
    for (const key of [...combos.keys()].sort()) {
      const count = combos.get(key)!;
      if (!modal || count > modal.count) modal = { key, count };
    }
    return { districtId, blocks: members.length, repetition: modal ? round4(modal.count / members.length) : 0 };
  });

  // B9 显示层：活动服务率 + 空置区保留窄路的预留/无支撑划分（锚点口径见模块头）。
  const layer = input.layer;
  let display: RoadReport["display"];
  if (layer === "display") {
    const live = input.blocks.filter((b) => !b.vacant);
    const liveAnchors = live.map((b) => ({ x: b.x, z: b.z, r: Math.hypot(b.width, b.depth) / 2 + 4 }));
    const siteAnchors = [...input.publicSites, ...input.landmarks].filter((s) => s.radius).map((s) => ({ x: s.x, z: s.z, r: s.radius + 16 }));
    const hotelAnchors = seasideHotelLots(input.seaside ?? null).map((lot) => ({ x: lot.x, z: lot.z, r: 26 }));
    const served = live.filter((b) => segments.some((s) => pointSegDistance(b, s.a, s.b) <= SERVICE_RADIUS));
    const reservedIds: string[] = [];
    const unsupportedIds: string[] = [];
    for (const s of segments) {
      if (s.edge.bridge || atLeast(s.edge, "arterial")) continue;
      const mid = { x: (s.a.x + s.b.x) / 2, z: (s.a.z + s.b.z) / 2 };
      if (liveAnchors.some((a) => Math.hypot(a.x - mid.x, a.z - mid.z) < a.r)) continue; // 服务建成街区，不在空置区
      if (siteAnchors.some((a) => Math.hypot(a.x - mid.x, a.z - mid.z) < a.r) || hotelAnchors.some((a) => Math.hypot(a.x - mid.x, a.z - mid.z) < a.r)) reservedIds.push(s.id);
      else unsupportedIds.push(s.id);
    }
    const lengthById = (ids: string[]) => ids.map((id) => lengthOf(segments.find((s) => s.id === id)!)).reduce((sum, v) => sum + v, 0);
    reservedIds.sort();
    unsupportedIds.sort();
    const reservedLength = lengthById(reservedIds);
    const unsupportedLength = lengthById(unsupportedIds);
    display = {
      liveBlocks: live.length,
      vacantBlocks: input.blocks.length - live.length,
      activityServiceRate: live.length ? round4(served.length / live.length) : 0,
      vacantNarrowRoads: {
        totalLength: round2(reservedLength + unsupportedLength),
        reservedLength: round2(reservedLength),
        unsupportedLength: round2(unsupportedLength),
        reservedEdgeIds: reservedIds,
        unsupportedEdgeIds: unsupportedIds,
      },
    };
  }

  return {
    layer,
    edgeCount: edges.length,
    nodeCount: positions.size,
    graph: {
      componentCount,
      primaryComponentId: primary,
      primaryBasis,
      degree1,
      planarCrossings: { count: crossingFindings.length, findings: crossingFindings },
      lengthByWidth: { ge12: { length: round2(len12), share: share(len12) }, ge8lt12: { length: round2(len8), share: share(len8) }, lt8: { length: round2(lenRest), share: share(lenRest) } },
      junctions: { total: degreeHistogram.reduce((sum, row) => sum + row.count, 0), degreeHistogram, minAngleDeg: minAngleDeg === null ? null : round2(minAngleDeg), acuteBelow30: acuteFindings.length, findings: acuteFindings },
      bridges: { total: bridgeTotal, violations: bridgeViolations },
    },
    facilities: { total: facilityFindings.length, doorsOk: facilityFindings.filter((f) => f.withinPrimaryNeighborhood).length, findings: facilityFindings },
    blocks: {
      analyzed: areas.length,
      area: { p50: round2(percentile50(areas)), max: round2(areas.length ? Math.max(...areas) : 0) },
      aspectRatio: { p50: round2(percentile50(aspects)), max: round2(aspects.length ? Math.max(...aspects) : 0) },
      frontageEdges: { p50: round2(percentile50(frontages)), max: frontages.length ? Math.max(...frontages) : 0 },
      orientationBuckets,
      gridRepetition: { districts: gridDistricts, cityMax: gridDistricts.reduce((max, d) => Math.max(max, d.repetition), 0) },
    },
    ...(display ? { display } : {}),
  };
}
