import { buildStoryGraphAdjacencyV1, compareText } from "./validate";
import { reachability } from "./reachability";
import type { StoryGraphV1 } from "./types";

/**
 * 死胡同节点：没有任何出边的节点（AVG Maker 迁移清单 `deadEndDetector` 的
 * 纯图部分，RFC §4.3）。输出升序排序；图结构非法时抛 StoryGraphStructureErrorV1。
 */
export function deadEnds(graph: StoryGraphV1): readonly string[] {
  const adjacency = buildStoryGraphAdjacencyV1(graph);
  return adjacency.nodeIds.filter(id => (adjacency.outgoingTargets.get(id) ?? []).length === 0);
}

/**
 * 孤岛：弱连通分量中不包含任何"从 graph.start 有向可达节点"的分量。
 * 语义说明（RFC §4.2）：判定在分量级别——分量内只要有一个节点可达即非孤岛；
 * 节点级不可达集可直接用 reachability(graph, graph.start) 的补集观察。
 * 每个分量内部升序排序，分量之间按最小成员升序排序；结构非法时抛错。
 */
export function islands(graph: StoryGraphV1): readonly (readonly string[])[] {
  const adjacency = buildStoryGraphAdjacencyV1(graph);
  const reachableSet = new Set(reachability(graph, graph.start));
  const visited = new Set<string>();
  const result: string[][] = [];
  for (const id of adjacency.nodeIds) {
    if (visited.has(id)) continue;
    const component: string[] = [];
    const queue: string[] = [id];
    visited.add(id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const next of adjacency.undirectedNeighbors.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    if (!component.some(member => reachableSet.has(member))) {
      result.push(component.sort(compareText));
    }
  }
  result.sort((left, right) => compareText(left[0]!, right[0]!));
  return result;
}
