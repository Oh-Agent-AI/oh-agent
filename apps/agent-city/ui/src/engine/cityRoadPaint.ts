import { atLeast } from "./roadStandard";
import type { RoadEdge, Vec2 } from "./cityLayout";

/** Merge degree-two continuations; junctions, bridges and width changes remain boundaries. */
export function roadPaintPlan(edges: RoadEdge[]) {
  const adjacency = new Map<string, RoadEdge[]>();
  for (const edge of edges) for (const node of [edge.from, edge.to]) {
    const list = adjacency.get(node) ?? []; list.push(edge); adjacency.set(node, list);
  }
  const junctions = new Set([...adjacency].filter(([, list]) => list.length >= 3).map(([id]) => id));
  const visited = new Set<string>();
  // startEdge/endEdge：run 两端各自是哪条边——路口标线（cityTextures）要按「这条边在该路口是主路还是次路」
  // 决定中线虚线的内缩与停止线，而 run 是合并后的折线，不带边身份就只能按方向猜。
  const runs: Array<{ width: number; kind: RoadEdge["kind"]; points: Vec2[]; from: string; to: string; startEdge: RoadEdge; endEdge: RoadEdge; edgeIds: string[] }> = [];
  const continuation = (edge: RoadEdge, node: string) => {
    const list = adjacency.get(node)!;
    if (list.length !== 2) return undefined;
    return list.find((next) => next !== edge && !next.bridge && next.width === edge.width && next.kind === edge.kind);
  };
  const walk = (first: RoadEdge, start: string) => {
    const edgeIds: string[] = [];
    const points: Vec2[] = []; let edge = first; let node = start; let last = first;
    while (!visited.has(edge.id)) {
      visited.add(edge.id); edgeIds.push(edge.id); last = edge;
      const oriented = edge.from === node ? edge.points : [...edge.points].reverse();
      points.push(...(points.length ? oriented.slice(1) : oriented));
      node = edge.from === node ? edge.to : edge.from;
      const next = continuation(edge, node);
      if (!next || visited.has(next.id)) break;
      edge = next;
    }
    runs.push({ width: first.width, kind: first.kind, points, from: start, to: node, startEdge: first, endEdge: last, edgeIds });
  };
  const surface = edges.filter((edge) => !edge.bridge);
  // Start at a boundary so a chain is not split at an arbitrary input edge.
  for (const edge of surface) if (!visited.has(edge.id)) {
    if (!continuation(edge, edge.from)) walk(edge, edge.from);
    else if (!continuation(edge, edge.to)) walk(edge, edge.to);
  }
  for (const edge of surface) if (!visited.has(edge.id)) walk(edge, edge.from); // closed loops
  return { runs, junctions };
}

/** 渠化上限（渲染层带口）：相邻边最小夹角 < 50° 的三岔做渠化。30–50° 是 acuteJunctions
 *  守卫（≥ 30°，planner/constraints.ts）上方的「合法但读作锐角硬接」边缘带；< 30° 的
 *  普查残留违例（上限 5 岛）一并渠化——同一算法同一角度量，阈值上限取 50°。 */
export const CHANNEL_T_GAP = (50 * Math.PI) / 180;

/** 渠化 T 的一条渠化臂：edge 原样携带宽度/等级（渲染侧用），dir 是从节点指向该路第二个
 *  点的单位向量——与 acuteJunctions 的测角方向完全一致（ bends 在第二点之后不参与选口）。 */
export type ChannelizedArm = { edge: RoadEdge; dir: Vec2 };
/** 渠化 T 选口结果：stem = 合入的支路口（分流岛沿它摆），host = 被锐角贴着的那条主臂。 */
export type ChannelizedMouth = { node: string; x: number; z: number; gap: number; stem: ChannelizedArm; host: ChannelizedArm };

/** 渠化 T 选口（渲染层，纯函数；规划拓扑零改动）：地面三岔（非桥、恰好 3 条入边）且三条
 *  路全为窄路（宽 < 12，主干不渠化）时，按 acuteJunctions 的同款算法——入边方向角排序后
 *  含回绕的相邻间隙——取最小间隙；< 50°（CHANNEL_T_GAP）即渠化。三岔里最大间隙的两侧是
 *  「直行穿过」的一对，剩下的第三条是合入支路（stem），最小间隙的另一条是被贴着汇入的主臂
 *  （host）。结果按节点 id 排序，渲染批的顶点顺序随之确定。 */
export function channelizedTPlan(edges: RoadEdge[]): ChannelizedMouth[] {
  const incident = new Map<string, RoadEdge[]>();
  for (const edge of edges) if (!edge.bridge) for (const node of [edge.from, edge.to]) {
    const list = incident.get(node) ?? []; list.push(edge); incident.set(node, list);
  }
  const bridged = new Set(edges.filter((edge) => edge.bridge).flatMap((edge) => [edge.from, edge.to]));
  const mouths: ChannelizedMouth[] = [];
  for (const [id, list] of incident) {
    if (list.length !== 3 || list.some((edge) => atLeast(edge, "arterial"))) continue;
    if (bridged.has(id)) continue; // 节点上挂着桥 = 桥头而不是画在地面上的三岔口
    const node = list[0].from === id ? list[0].points[0] : list[0].points[list[0].points.length - 1];
    const angleOf = (edge: RoadEdge) => {
      const pts = edge.from === id ? edge.points : [...edge.points].reverse();
      return Math.atan2(pts[1].z - node.z, pts[1].x - node.x);
    };
    const dirOf = (edge: RoadEdge): Vec2 => {
      const pts = edge.from === id ? edge.points : [...edge.points].reverse();
      const length = Math.hypot(pts[1].x - node.x, pts[1].z - node.z) || 1;
      return { x: (pts[1].x - node.x) / length, z: (pts[1].z - node.z) / length };
    };
    const angles = list.map(angleOf).sort((a, b) => a - b);
    let minGap = Math.PI * 2; let minAt = 0;
    let maxGap = -1; let maxAt = angles.length - 1;
    for (let k = 0; k < angles.length; k += 1) {
      const gap = (k + 1 < angles.length ? angles[k + 1] : angles[0] + Math.PI * 2) - angles[k];
      if (gap < minGap) { minGap = gap; minAt = k; }
      if (gap > maxGap) { maxGap = gap; maxAt = k; }
    }
    if (minGap >= CHANNEL_T_GAP) continue;
    const order = list.map((_, index) => index).sort((a, b) => angleOf(list[a]) - angleOf(list[b]));
    const minPair = [order[minAt], order[minAt + 1 < order.length ? minAt + 1 : 0]];
    const maxPair = [order[maxAt], order[maxAt + 1 < order.length ? maxAt + 1 : 0]];
    // stem = 最小间隙对里不属于最大间隙对的那条（第三臂）；host = 同属两对的合入侧主臂。
    const stemIndex = minPair.find((index) => !maxPair.includes(index)) ?? minPair[0];
    const hostIndex = minPair.find((index) => index !== stemIndex) ?? minPair[1];
    mouths.push({ node: id, x: node.x, z: node.z, gap: minGap, stem: { edge: list[stemIndex], dir: dirOf(list[stemIndex]) }, host: { edge: list[hostIndex], dir: dirOf(list[hostIndex]) } });
  }
  return mouths.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
}
