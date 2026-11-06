/** 展示裁剪的必要路径：仅恢复已接受的规划边，按实际折线长度，不创造几何捷径。 */
import { DetMath as Math } from "../detMath";
import type { RoadEdge } from "../cityLayout";

export type RetentionReport = { keep: Set<string>; restored: string[]; unresolved: string[]; anchorMissing: boolean };

/** Restore pruning gaps to a retained node or a genuine full-graph terminal. */
export function preserveDisplayJunctions(edges: readonly RoadEdge[], selected: ReadonlySet<string>, terminals: ReadonlySet<string>): { keep: Set<string>; restored: string[]; unresolved: string[] } {
  const keep = new Set(selected);
  const adjacency = new Map<string, RoadEdge[]>();
  for (const edge of edges) if (!edge.bridge) for (const node of [edge.from, edge.to]) {
    const list = adjacency.get(node) ?? []; list.push(edge); adjacency.set(node, list);
  }
  for (const list of adjacency.values()) list.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const degree = () => {
    const counts = new Map<string, number>();
    for (const edge of edges) if (!edge.bridge && keep.has(edge.id)) for (const node of [edge.from, edge.to]) counts.set(node, (counts.get(node) ?? 0) + 1);
    return counts;
  };
  const initial = degree();
  const gaps = [...initial.keys()].filter((node) => initial.get(node) === 1 && (adjacency.get(node)?.length ?? 0) > 1 && !terminals.has(node)).sort();
  const unresolved: string[] = [];
  for (const origin of gaps) {
    const current = degree();
    if (current.get(origin) !== 1) continue;
    const distances = new Map<string, number>([[origin, 0]]);
    const previous = new Map<string, { node: string; edge: string }>();
    const visited = new Set<string>();
    let goal: string | null = null;
    let closingEdge: string | null = null; let cyclePath: string[] | null = null; let goalCost = Infinity;
    const pathToOrigin = (node: string) => {
      const path: string[] = [];
      for (let cursor = node; cursor !== origin;) { const step = previous.get(cursor)!; path.push(step.edge); cursor = step.node; }
      return path;
    };
    while (true) {
      let next: string | null = null; let cost = Infinity;
      for (const [node, value] of distances) if (!visited.has(node) && (value < cost || (value === cost && (next === null || node < next)))) { next = node; cost = value; }
      if (next === null || cost >= goalCost) break;
      if (next !== origin && (current.has(next) || adjacency.get(next)?.length === 1)) { goal = next; cyclePath = null; break; }
      visited.add(next);
      for (const edge of adjacency.get(next) ?? []) {
        if (keep.has(edge.id)) continue;
        const to: string = edge.from === next ? edge.to : edge.from;
        const length = edge.points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - edge.points[i].x, p.z - edge.points[i].z), 0);
        if (!Number.isFinite(length) || length <= 0) continue;
        // A culled loop may return only to its own retained attachment. Do not
        // mistake that cycle for a missing route, or for immediate backtracking.
        if (to === origin && next !== origin && previous.get(next)?.edge !== edge.id) {
          const total = cost + length;
          if (total < goalCost || (total === goalCost && edge.id < (closingEdge ?? "\uffff"))) {
            goal = next; cyclePath = [edge.id, ...pathToOrigin(next)]; closingEdge = edge.id; goalCost = total;
          }
          continue;
        }
        if (next !== origin && to !== origin && previous.has(to)
          && previous.get(next)?.edge !== edge.id && previous.get(to)?.edge !== edge.id) {
          const chain = (node: string) => {
            const path = new Set<string>();
            for (let cursor = node; cursor !== origin;) { path.add(cursor); cursor = previous.get(cursor)!.node; }
            return path;
          };
          const left = chain(next), right = chain(to);
          if (![...left].some((node) => right.has(node))) {
            const total = cost + distances.get(to)! + length;
            if (total < goalCost || (total === goalCost && edge.id < (closingEdge ?? "\uffff"))) {
              goal = next; cyclePath = [edge.id, ...pathToOrigin(next), ...pathToOrigin(to)]; closingEdge = edge.id; goalCost = total;
            }
          }
        }
        if (visited.has(to)) continue;
        const total = cost + length, old = distances.get(to) ?? Infinity;
        if (total < old || (total === old && edge.id < (previous.get(to)?.edge ?? "\uffff"))) {
          distances.set(to, total); previous.set(to, { node: next, edge: edge.id });
        }
      }
    }
    if (!goal) { unresolved.push(origin); continue; }
    for (const id of cyclePath ?? pathToOrigin(goal)) keep.add(id);
  }
  return { keep, restored: [...keep].filter((id) => !selected.has(id)).sort(), unresolved };
}

/** 桥头地面接驳是独立于图连通的必要边：两座相接的桥不能替代地面落地。 */
export function retainBridgeLandings(edges: readonly RoadEdge[], selected: ReadonlySet<string>): { selected: Set<string>; missing: string[] } {
  const keep = new Set(selected);
  const ground = new Map<string, RoadEdge[]>();
  const length = (edge: RoadEdge) => edge.points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - edge.points[i].x, p.z - edge.points[i].z), 0);
  for (const edge of edges) if (!edge.bridge) for (const node of [edge.from, edge.to]) {
    const list = ground.get(node) ?? []; list.push(edge); ground.set(node, list);
  }
  const missing = new Set<string>();
  for (const bridge of [...edges].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) if (bridge.bridge && keep.has(bridge.id)) for (const node of [bridge.from, bridge.to]) {
    const candidates = ground.get(node) ?? [];
    if (candidates.some((edge) => keep.has(edge.id))) continue;
    const best = [...candidates].sort((a, b) => length(a) - length(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    if (best) keep.add(best.id); else missing.add(node);
  }
  return { selected: keep, missing: [...missing].sort() };
}

export function preserveDemandPaths(edges: readonly RoadEdge[], selected: ReadonlySet<string>, anchor: string | null, required: readonly string[]): RetentionReport {
  const keep = new Set(selected);
  const adjacency = new Map<string, RoadEdge[]>();
  for (const edge of edges) for (const id of [edge.from, edge.to]) {
    const list = adjacency.get(id) ?? []; list.push(edge); adjacency.set(id, list);
  }
  const demands = [...new Set(required)].sort();
  if (!anchor || !adjacency.has(anchor)) return { keep, restored: [], unresolved: demands, anchorMissing: true };
  for (const list of adjacency.values()) list.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const distance = new Map<string, number>([[anchor, 0]]);
  const back = new Map<string, { previous: string; edge: string }>();
  const settled = new Set<string>();
  // 有限图、确定性 Dijkstra；无墙钟预算，等长按节点/边 id 固定选择。
  while (true) {
    let next: string | null = null; let cost = Infinity;
    for (const [id, d] of distance) if (!settled.has(id) && (d < cost || (d === cost && (next === null || id < next)))) { next = id; cost = d; }
    if (next === null) break;
    settled.add(next);
    for (const edge of adjacency.get(next) ?? []) {
      const to = edge.from === next ? edge.to : edge.from;
      if (settled.has(to)) continue;
      const length = edge.points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - edge.points[i].x, p.z - edge.points[i].z), 0);
      if (!Number.isFinite(length) || length <= 0) continue;
      const total = cost + length; const prior = distance.get(to) ?? Infinity;
      if (total < prior || (total === prior && edge.id < (back.get(to)?.edge ?? "\uffff"))) {
        distance.set(to, total); back.set(to, { previous: next, edge: edge.id });
      }
    }
  }
  const unresolved: string[] = [];
  const reachable = () => {
    const seen = new Set([anchor]); const queue = [anchor];
    for (let i = 0; i < queue.length; i += 1) for (const edge of adjacency.get(queue[i]) ?? []) {
      if (!keep.has(edge.id)) continue;
      const next = edge.from === queue[i] ? edge.to : edge.from;
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    return seen;
  };
  let covered = reachable();
  // 已被保留图接通的需求不再恢复第二条路；每个剩余分量优先使用距锚点最短的成员。
  for (const demand of [...demands].sort((a, b) => (distance.get(a) ?? Infinity) - (distance.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0))) {
    if (covered.has(demand)) continue;
    if (!settled.has(demand)) { unresolved.push(demand); continue; }
    for (let cursor = demand; cursor !== anchor;) {
      const step = back.get(cursor)!; keep.add(step.edge); cursor = step.previous;
    }
    covered = reachable();
  }
  // 即使空城也保留真实锚点，不以 first-wide-road 或隐式不存在节点代替。
  if (![...keep].some((id) => adjacency.get(anchor)?.some((e) => e.id === id))) keep.add(adjacency.get(anchor)![0].id);
  return { keep, restored: [...keep].filter((id) => !selected.has(id)).sort(), unresolved: unresolved.sort(), anchorMissing: false };
}
