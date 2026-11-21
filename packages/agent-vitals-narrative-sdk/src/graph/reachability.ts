import { narrativeErrorV1 } from "../contracts/diagnostics";
import { buildStoryGraphAdjacencyV1, StoryGraphStructureErrorV1, type StoryGraphAdjacencyV1 } from "./validate";
import type { StoryEdgePredicateV1, StoryGraphV1 } from "./types";

/**
 * 从 start 出发的有向 BFS 可达集（含 start 自身）。
 * 输出按节点 id 升序排序；输入不可变；图结构非法或 start 未知时抛
 * StoryGraphStructureErrorV1（V3-12：结构故障显式报错，绝不静默返回看似成功的结果）。
 */
export function reachability(graph: StoryGraphV1, start: string): readonly string[] {
  const adjacency = buildStoryGraphAdjacencyV1(graph);
  return reachableFrom(start, adjacency);
}

/**
 * 条件可达（RFC §4.2 检查 1）：有图边 ≠ 条件可达。
 * `canTraverse` 由调用方注入，逐条边判定是否可通行；本包不求值 ConditionV2
 * （那是 ADR-01 之后的宿主工作）。输出确定性排序；结构非法时抛
 * StoryGraphStructureErrorV1。
 */
export function conditionalReachability(
  graph: StoryGraphV1,
  start: string,
  canTraverse: StoryEdgePredicateV1,
): readonly string[] {
  const adjacency = buildStoryGraphAdjacencyV1(graph);
  requireKnownStart(start, adjacency);
  const reachable = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of adjacency.outgoingEdges.get(current) ?? []) {
      if (!canTraverse(edge)) continue;
      if (reachable.has(edge.to)) continue;
      reachable.add(edge.to);
      queue.push(edge.to);
    }
  }
  return [...reachable].sort(compareText);
}

function reachableFrom(start: string, adjacency: StoryGraphAdjacencyV1): readonly string[] {
  requireKnownStart(start, adjacency);
  const reachable = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.outgoingTargets.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }
  return [...reachable].sort(compareText);
}

function requireKnownStart(start: string, adjacency: StoryGraphAdjacencyV1): void {
  if (!adjacency.nodeIds.includes(start)) {
    throw new StoryGraphStructureErrorV1([
      narrativeErrorV1("narrative_graph_start_missing", "start", `Traversal start "${start}" is not a declared node id.`),
    ]);
  }
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
