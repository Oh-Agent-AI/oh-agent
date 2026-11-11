import { atLeast, roadWidthFor } from "../roadStandard";
import { DetMath as Math } from "../detMath";
/**
 * 街网缝合（R5 步 6s）：自 cityPlan.ts::buildPlan 逐字迁出的、扇区街网生成之后的几遍接路 / 切边工序段。
 *
 * 顺序（与原内联段一字不差）：沿海路/河岸路断头互接（node-merge 连接器）→ 环岛路段端与近旁街网节点以 T 路口接上 →
 * 节点落在别的路段中间时切开该路段（至多 3 遍）→ 首排街区角点接入主干道 → 大道两端补接入路。
 *
 * 对外部世界的读写（原为 buildPlan 闭包变量，现显式传入）：
 *   读：coastRoadRuns、coastalRoadRuns、coastRoadIndex / trunkIndex（只查询）、coastalRoadEdgeIds（Set，只读）、frontNodes、
 *       safeRoadLink（闭包，纯查询）、connectorWorld、connectToNetwork（闭包，内部自增 connectSeq——调用序不变）、
 *       addEdge（闭包，写 network）、key、network
 *   原地改：network（nodes/edges 经 connectToNetwork / runConnection / addEdge；切边时 edges.delete 再 addEdge，顺序不变）
 *   无新产生的值，无返回。random() 不被本段使用。
 */
import type { RoadEdge, Vec2 } from "../cityLayout";
import { roadNodeId, segmentDistance, type SegmentIndex } from "../roadGeometry";
import type { Network } from "./network";
import { runConnection, endpointClear, type ConnectorWorld } from "./connect";

export type StreetStitchWorld = {
  network: Network;
  connectorWorld: ConnectorWorld;
  connectToNetwork: (endpoint: Vec2, maxDistance: number, arterial: boolean, exclude?: (edge: RoadEdge) => boolean, minAngle?: number) => boolean;
  addEdge: (a0: Vec2, b0: Vec2, arterial: boolean, bridge?: boolean, primary?: boolean) => unknown;
  key: (p: Vec2) => Vec2;
  safeRoadLink: (a: Vec2, b: Vec2) => boolean;
  coastRoadRuns: Vec2[][];
  /** 海滨大道段（boulevardSegments 映射 key；只读）。 */
  coastalRoadRuns: Vec2[][];
  coastRoadIndex: SegmentIndex;
  trunkIndex: SegmentIndex;
  coastalRoadEdgeIds: ReadonlySet<string>;
  frontNodes: Vec2[];
};

export function stitchStreetNetwork(w: StreetStitchWorld): void {
  const { network, connectorWorld, connectToNetwork, addEdge, key, safeRoadLink, coastRoadRuns, coastalRoadRuns, coastRoadIndex, trunkIndex, coastalRoadEdgeIds, frontNodes } = w;
  const { nodes, edges } = network;
  // 沿海路 / 河岸路的断头互接：一段的端点 80 内有另一段（或同段另一端）的断头，就直连成一条（不过水、不穿用地）。
  // 河岸路在入海口附近停下、环岛路在河口另一侧停下，两端都是断头却互不相接（真机截图）。
  // 批次 4-2：互接的加边改走连接器 node-merge（目标 = 指名节点），校验口径保留历史档
  // （safeRoadLink 同判据 + 两端净空角，不查交叉），经 commitNetworkPatch 事务提交。
  {
    let coastalJoinSeq = 0;
    const deg = () => { const d = new Map<string, number>(); for (const e of edges.values()) for (const n of [e.from, e.to]) d.set(n, (d.get(n) ?? 0) + 1); return d; };
    const ends = coastRoadRuns.flatMap((run, r) => [{ p: run[0], r }, { p: run[run.length - 1], r }]);
    const joined = new Set<string>();
    for (const a of ends) {
      const d = deg(); const ida = roadNodeId(key(a.p));
      if ((d.get(ida) ?? 0) !== 1 || joined.has(ida)) continue;
      const mate = ends
        .filter((b) => b !== a && (d.get(roadNodeId(key(b.p))) ?? 0) === 1 && !joined.has(roadNodeId(key(b.p))))
        .map((b) => ({ b, dist: Math.hypot(b.p.x - a.p.x, b.p.z - a.p.z) }))
        .filter(({ dist, b }) => dist > 1 && dist < 80 && safeRoadLink(a.p, b.p) && endpointClear(network, a.p, b.p) && endpointClear(network, b.p, a.p))
        .sort((x, y) => x.dist - y.dist)[0];
      if (!mate) continue;
      runConnection({
        id: `coastal-join:${coastalJoinSeq += 1}`,
        source: a.p,
        target: { kind: "node", id: roadNodeId(key(mate.b.p)) },
        purpose: "coastal-link",
        allowBridge: false,
        maxLength: 80,
        roadClass: "arterial",
        primary: true,
      }, connectorWorld, { strategies: ["node-merge"], siteMargin: 5, crossings: true });
      joined.add(ida); joined.add(roadNodeId(key(mate.b.p)));
    }
  }
  // 环岛滨海路段端接入路网；离它 ≤16 的街网节点以 T 路口接上（街区一直排到沿海路）。
  for (const runPts of coastRoadRuns) for (const end of [runPts[0], runPts[runPts.length - 1]]) {
    if (Math.hypot(end.x - runPts[0].x, end.z - runPts[0].z) < 0.01 && end !== runPts[0]) continue;
    connectToNetwork(end, 160, false, (edge) => coastRoadRuns.some((r) => r.some((q) => Math.hypot(q.x - edge.points[0].x, q.z - edge.points[0].z) < 0.01) && r.some((q) => Math.hypot(q.x - edge.points[1].x, q.z - edge.points[1].z) < 0.01)));
  }
  for (const node of [...nodes.values()]) {
    if (!coastRoadIndex.closerThan(node, 16) || coastRoadIndex.closerThan(node, 0.5)) continue;
    connectToNetwork(node, 18, false, (edge) => edge.width < roadWidthFor("arterial") || !coastRoadIndex.closerThan(edge.points[0], 0.5));
  }
  // 节点落在别的路段中间时把那条路段切开（S4 裁切块的边沿网格线只走到裁切点，与相邻整格的同线整边重叠成 0° 「锐角」）：
  // 重叠的共线边因此变成共享路段，T 接点成为真正的路口。按 60 分桶避免 O(N·E)。
  {
    for (let pass = 0; pass < 3; pass += 1) {
      const CELL = 60; const buckets = new Map<string, RoadEdge[]>();
      for (const edge of edges.values()) {
        if (edge.bridge) continue;
        const [a, b] = edge.points;
        for (let gx = Math.floor(Math.min(a.x, b.x) / CELL); gx <= Math.floor(Math.max(a.x, b.x) / CELL); gx += 1)
          for (let gz = Math.floor(Math.min(a.z, b.z) / CELL); gz <= Math.floor(Math.max(a.z, b.z) / CELL); gz += 1) {
            const k = `${gx}:${gz}`; (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(edge);
          }
      }
      let split = 0;
      for (const node of [...nodes.values()]) {
        const host = (buckets.get(`${Math.floor(node.x / CELL)}:${Math.floor(node.z / CELL)}`) ?? []).find((edge) =>
          edges.has(edge.id) && edge.from !== node.id && edge.to !== node.id && segmentDistance(node, edge.points[0], edge.points[1]) < 0.05
          && Math.hypot(node.x - edge.points[0].x, node.z - edge.points[0].z) > 0.5 && Math.hypot(node.x - edge.points[1].x, node.z - edge.points[1].z) > 0.5);
        if (!host) continue;
        edges.delete(host.id);
        const primary = atLeast(host, "arterial"); const art = host.kind === "arterial";
        addEdge(host.points[0], node, art, false, primary); addEdge(node, host.points[1], art, false, primary);
        split += 1;
      }
      if (!split) break;
    }
  }

  // 横街接入主干道：首排街区的角点（及离主干道 ≤16 的街网节点）垂直接到主干道上，形成 T 路口。
  {
    const seen = new Set<string>();
    const candidates = [...frontNodes, ...[...nodes.values()].filter((n) => trunkIndex.closerThan(n, 16))];
    for (const p of candidates) {
      const id = roadNodeId(key(p));
      if (seen.has(id)) continue; seen.add(id);
      if (!nodes.has(id)) continue; // 角点上没有任何街道（整条边都贴主干道）就不必接
      connectToNetwork(p, 18, false, (edge) => edge.kind !== "arterial" || edge.width < roadWidthFor("arterial"));
    }
  }
  // 街网生成后再给大道两端各补一条到街区街道的接入路（同一套 localConstraints）。
  for (const segment of coastalRoadRuns) {
    if (segment.length < 2) continue;
    for (const endpoint of [segment[0], segment[segment.length - 1]]) connectToNetwork(endpoint, 160, false, (edge) => coastalRoadEdgeIds.has(edge.id));
  }
}
