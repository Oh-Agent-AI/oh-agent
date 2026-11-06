/**
 * 路口环岛（2026-10-15，CITY_ROAD_NETWORK_SPEC §5「环岛：度 ≥ 5，或 ≥ 3 条主干交汇」的落地 + 支路小环）。
 *
 * 用户：「之前设计了几种类型的交叉路口，包括环岛，没有用上吗」——实测 28 座城（14 种子 × 2 档）里，市政广场环岛每城 1 个，
 * 交叉口小环（connect.ts mini-roundabout）只作为锐角三岔的修复档、11 次尝试 0 次建成；§5 的「度 ≥5 / ≥3 主干交汇 → 环岛」
 * 从未实现（8 个五岔以上路口、上千个主干交汇全是平交）。这一遍在桥头落地环之后、solve 之前跑，街区随后按最终路网生成，
 * 自然绕开环岛：
 *   · 主干环岛（major）：度 ≥ 5、≥ 3 条宽 12 主干交汇，或四条干道（宽 ≥8）的十字，彼此相距 ≥ 220；半径 18 → 16 → 14（36–28 m），环道宽 8；
 *   · 支路小环（minor）：三至四条支路（宽 5）的三岔/十字路口，按种子哈希稀疏抽样（≈ MINOR_SHARE）；半径 10（20 m，再小环上切点相距
 *     < 12 会触发近距路口约束），环道宽 5。
 * 构造与校验全部走 connect.ts::runJunctionRing（走廊、交叉、环上 ≥30° 角度复核、事务提交、失败零副作用）。
 *
 * 引用折线（干道 trunk、岸路、滨海路、车流回路）：经过路口中心 V 的「前一点 → V → 后一点」改写为
 * 「前一点 → 进口切点 → 沿环逆时针的弧点 → 出口切点 → 后一点」；以 V 为端点的改从切点起。其余被引用的节点
 * （设施出入口、主锚点、高架出口、桥头）一律不建环——那些引用没有「绕环」的语义。
 */
import { atLeast, roadWidthFor } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import { roadNodeId } from "../roadGeometry";
import type { RoadEdge, Vec2 } from "../cityLayout";
import { keyOf, type Network } from "./network";
import { runJunctionRing, type ConnectorWorld, type JunctionRingOptions } from "./connect";

export const JUNCTION_RING_CONFIG = {
  version: 1,
  major: { radii: [18, 16, 14], arcStepDeg: 30, ringArterial: true, maxSegments: 18 } satisfies JunctionRingOptions,
  minor: { radii: [10], arcStepDeg: 30, ringArterial: false, maxSegments: 14 } satisfies JunctionRingOptions,
  /** 支路三岔/十字路口里建小环的比例（种子哈希抽样）。 */
  minorShare: 0.14,
  /** 离市政广场核心多远之内不建（那里已有礼仪环岛）。 */
  coreClear: 140,
  /** 主干环岛之间的最小间距（环心距离）：大环岛是路网的稀疏结构节点。 */
  majorSpacing: 220,
  /** 小环离任何环的最小间距。 */
  spacing: 130,
  /** 离桥端多远之内不建（桥头有落地环/引道）。 */
  bridgeClear: 60,
};

export type JunctionRing = { x: number; z: number; radius: number; width: number; kind: "major" | "minor" };

export function buildJunctionRings(opts: {
  network: Network; world: ConnectorWorld; core: Vec2; random: (key: string) => number;
  /** 会被改写的引用折线（原地修改数组元素）。 */
  routes: Vec2[][][];
  /** 不能建环的节点 id（设施出入口、主锚点、高架出口……）。 */
  pinned: Set<string>;
}): { rings: JunctionRing[]; declined: Array<{ node: string; reason: string }> } {
  const { network, world, core, random, routes, pinned } = opts;
  const rings: JunctionRing[] = [];
  const declined: Array<{ node: string; reason: string }> = [];
  const bridgeEnds = [...network.edges.values()].filter((e) => e.bridge).flatMap((e) => [e.points[0], e.points[e.points.length - 1]]);
  const incident = (id: string) => [...network.edges.values()].filter((e) => e.from === id || e.to === id).sort((a, b) => (a.id < b.id ? -1 : 1));
  const candidates = [...network.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((node) => {
    const legs = incident(node.id);
    const primary = legs.filter((e) => atLeast(e, "arterial")).length;
    const arterial = legs.filter((e) => atLeast(e, "collector")).length;
    // 主干环岛：度 ≥5、≥3 条主干交汇，或干道/次干道的十字（四岔里 ≥3 条宽 ≥8）——实测规划期的「≥3 条主干」几乎都在桥头
    // （岸路 × 引道），通往桥头的那条腿只有 8–12、放不下环。规划期城内的大路口实测是四条干道（宽 ≥8）的十字（大岛约 25 个），
    // 由 majorSpacing 稀疏化；「≥3 条宽 ≥8」会把每个 T 口也算进来（实测大岛 53 个），太密。
    const kind: JunctionRing["kind"] | null = legs.length >= 5 || (legs.length >= 3 && primary >= 3) || (legs.length === 4 && arterial === 4) ? "major"
      : (legs.length === 3 || legs.length === 4) && legs.every((e) => e.width === roadWidthFor("local") && e.kind === "local") && random(`junction-ring:${node.id}`) < JUNCTION_RING_CONFIG.minorShare ? "minor" : null;
    return { node, legs, kind };
  }).filter((c) => c.kind) as Array<{ node: { id: string; x: number; z: number }; legs: RoadEdge[]; kind: JunctionRing["kind"] }>;
  // 主干环岛优先（它们是路网的结构节点），同类按 id。
  candidates.sort((a, b) => (a.kind === b.kind ? (a.node.id < b.node.id ? -1 : 1) : a.kind === "major" ? -1 : 1));
  for (const { node, kind } of candidates) {
    const live = network.nodes.get(node.id);
    if (!live) continue;
    const legs = incident(node.id);
    const reason = pinned.has(node.id) ? "pinned"
      : Math.hypot(node.x - core.x, node.z - core.z) < JUNCTION_RING_CONFIG.coreClear ? "near-core"
        : rings.some((r) => Math.hypot(r.x - node.x, r.z - node.z) < (kind === "major" && r.kind === "major" ? JUNCTION_RING_CONFIG.majorSpacing : JUNCTION_RING_CONFIG.spacing)) ? "spacing"
          : bridgeEnds.some((p) => Math.hypot(p.x - node.x, p.z - node.z) < JUNCTION_RING_CONFIG.bridgeClear) ? "near-bridge"
            : legs.some((e) => e.bridge || e.structure !== "ground-road") ? "structure" : null;
    if (reason) { declined.push({ node: node.id, reason }); continue; }
    const options = kind === "major" ? JUNCTION_RING_CONFIG.major : JUNCTION_RING_CONFIG.minor;
    // 腿的远端（建环后腿剩余段仍接到这里），用于改写引用折线。
    const farOf = new Map(legs.map((leg) => {
      const far = leg.from === node.id ? leg.points[leg.points.length - 1] : leg.points[0];
      return [roadNodeId(keyOf(far)), far] as const;
    }));
    const result = runJunctionRing(world, { id: node.id, x: node.x, z: node.z }, legs, options);
    if (!result.ok) { declined.push({ node: node.id, reason: `${result.reason}: ${result.detail}` }); continue; }
    rings.push({ x: node.x, z: node.z, radius: result.radius, width: roadWidthFor(options.ringArterial ? "collector" : "local"), kind });
    rewriteRoutes(routes, node, result.ring, farOf);
  }
  return { rings, declined };
}

/** 环点按角度升序（runJunctionRing 的构造顺序就是升序 = 逆时针）；切点 = 环上与某条腿远端同方向的点。 */
function rewriteRoutes(routes: Vec2[][][], center: Vec2, ring: Vec2[], farOf: Map<string, Vec2>): void {
  const id = roadNodeId(keyOf(center));
  const tangentFor = (far: Vec2) => {
    const a = Math.atan2(far.z - center.z, far.x - center.x);
    let best = 0, bestGap = Infinity;
    ring.forEach((p, k) => { const g = Math.abs(Math.atan2(Math.sin(Math.atan2(p.z - center.z, p.x - center.x) - a), Math.cos(Math.atan2(p.z - center.z, p.x - center.x) - a))); if (g < bestGap) { bestGap = g; best = k; } });
    return best;
  };
  const arc = (from: number, to: number) => { const out: Vec2[] = []; for (let k = from; ; k = (k + 1) % ring.length) { out.push(ring[k]); if (k === to) break; } return out; };
  for (const group of routes) for (let r = 0; r < group.length; r += 1) {
    const path = group[r];
    if (!path.some((p) => roadNodeId(keyOf(p)) === id)) continue;
    const out: Vec2[] = [];
    for (let i = 0; i < path.length; i += 1) {
      const p = path[i];
      if (roadNodeId(keyOf(p)) !== id) { out.push(p); continue; }
      const prev = i > 0 ? path[i - 1] : null, next = i + 1 < path.length ? path[i + 1] : null;
      const inK = prev && farOf.has(roadNodeId(keyOf(prev))) ? tangentFor(prev) : null;
      const outK = next && farOf.has(roadNodeId(keyOf(next))) ? tangentFor(next) : null;
      if (inK !== null && outK !== null) out.push(...arc(inK, outK));
      else if (inK !== null) out.push(ring[inK]);
      else if (outK !== null) out.push(ring[outK]);
      // 前后都不是这个路口的腿（不该发生）：丢掉 V，由下游的引用校验如实报出。
    }
    group[r] = out.filter((p, k) => k === 0 || p.x !== out[k - 1].x || p.z !== out[k - 1].z);
  }
}
