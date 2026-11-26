import {
  narrativeErrorV1, narrativeFailureV1,
  type NarrativeDiagnosticV1, type NarrativeResult,
} from "../contracts/diagnostics";
import type { StoryEdgeV2, StoryGraphV1, StoryNodeV1 } from "./types";

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/**
 * 结构非法图的显式错误（RFC V3-12：检测器故障必须明确 error，不得报告 passed）。
 * 算法入口在图结构非法时抛出本错误；需要结构化诊断的消费方先调用 validateStoryGraphV1。
 */
export class StoryGraphStructureErrorV1 extends Error {
  readonly diagnostics: readonly NarrativeDiagnosticV1[];

  constructor(diagnostics: readonly NarrativeDiagnosticV1[]) {
    super(`story graph structure invalid: ${diagnostics.map(d => `${d.path}: ${d.code}`).join("; ")}`);
    this.name = "StoryGraphStructureErrorV1";
    this.diagnostics = diagnostics;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function validateNodeEntry(node: unknown, path: string): NarrativeDiagnosticV1[] {
  if (!isRecord(node)) return [narrativeErrorV1("narrative_graph_node_malformed", path, "Node entry must be an object.")];
  if (!isNonEmptyString(node.id)) return [narrativeErrorV1("narrative_graph_node_id_invalid", `${path}.id`, "Node id must be a non-empty string.")];
  if (node.title !== undefined && typeof node.title !== "string") {
    return [narrativeErrorV1("narrative_graph_node_title_invalid", `${path}.title`, "Node title must be a string when present.")];
  }
  if (node.meta !== undefined && !isRecord(node.meta)) {
    return [narrativeErrorV1("narrative_graph_node_meta_invalid", `${path}.meta`, "Node meta must be an object when present.")];
  }
  if (!isNonEmptyString(node.kind)) {
    return [narrativeErrorV1("narrative_graph_node_kind_invalid", `${path}.kind`, "Node kind must be a non-empty string.")];
  }
  return [];
}

function validateEdgeEntry(edge: unknown, path: string): NarrativeDiagnosticV1[] {
  if (!isRecord(edge)) return [narrativeErrorV1("narrative_graph_edge_malformed", path, "Edge entry must be an object.")];
  if (!isNonEmptyString(edge.id)) return [narrativeErrorV1("narrative_graph_edge_id_invalid", `${path}.id`, "Edge id must be a non-empty string.")];
  if (!isNonEmptyString(edge.from)) return [narrativeErrorV1("narrative_graph_edge_from_invalid", `${path}.from`, "Edge from must be a non-empty string.")];
  if (!isNonEmptyString(edge.to)) return [narrativeErrorV1("narrative_graph_edge_to_invalid", `${path}.to`, "Edge to must be a non-empty string.")];
  if (!isRecord(edge.preconditions)) {
    return [narrativeErrorV1("narrative_graph_edge_preconditions_invalid", `${path}.preconditions`, "Edge preconditions placeholder must be a present object; evaluation lives outside this package.")];
  }
  if (!Array.isArray(edge.effects) || !edge.effects.every(isRecord)) {
    return [narrativeErrorV1("narrative_graph_edge_effects_invalid", `${path}.effects`, "Edge effects placeholder must be an array of condition/effect objects; evaluation lives outside this package.")];
  }
  if (!Array.isArray(edge.eventDependencies) || !edge.eventDependencies.every(isNonEmptyString)) {
    return [narrativeErrorV1("narrative_graph_edge_event_dependencies_invalid", `${path}.eventDependencies`, "Edge eventDependencies must be an array of non-empty event ids.")];
  }
  if (!isNonEmptyString(edge.scope)) {
    return [narrativeErrorV1("narrative_graph_edge_scope_invalid", `${path}.scope`, "Edge scope placeholder must be a non-empty string until StateScopeV1 replaces it.")];
  }
  return [];
}

/**
 * 结构校验：收集全部诊断（不做 fail-fast），顺序与输入数组顺序一致（确定性）。
 * 覆盖：节点/边条目形状、重复节点 id、重复边 id、悬空 from/to、自环、start 缺失。
 * 合法时 ok=true 并回传同一图引用；失败时 ok=false 且 diagnostics 至少一条
 * （V3-12：失败绝不返回空成功报告）。
 */
export function validateStoryGraphV1(graph: StoryGraphV1): NarrativeResult<StoryGraphV1> {
  if (!isRecord(graph)) {
    return narrativeFailureV1([narrativeErrorV1("narrative_graph_malformed", "$", "Story graph must be an object.")]);
  }
  const diagnostics: NarrativeDiagnosticV1[] = [];

  if (!Array.isArray(graph.nodes)) {
    diagnostics.push(narrativeErrorV1("narrative_graph_nodes_invalid", "nodes", "nodes must be an array of StoryNodeV1."));
  } else {
    const seenNodeIds = new Set<string>();
    for (const [index, node] of graph.nodes.entries()) {
      const path = `nodes[${index}]`;
      const entry = validateNodeEntry(node, path);
      diagnostics.push(...entry);
      if (entry.length === 0) {
        const id = (node as StoryNodeV1).id;
        if (seenNodeIds.has(id)) {
          diagnostics.push(narrativeErrorV1("narrative_graph_node_id_duplicate", `${path}.id`, `Node id "${id}" is declared more than once.`));
        }
        seenNodeIds.add(id);
      }
    }
  }

  const declaredNodeIds = Array.isArray(graph.nodes)
    ? new Set(graph.nodes.filter(isRecord).map(node => node.id).filter(isNonEmptyString) as string[])
    : new Set<string>();
  if (!Array.isArray(graph.edges)) {
    diagnostics.push(narrativeErrorV1("narrative_graph_edges_invalid", "edges", "edges must be an array of StoryEdgeV2."));
  } else {
    const seenEdgeIds = new Set<string>();
    const knownNodeIds = declaredNodeIds;
    for (const [index, edge] of graph.edges.entries()) {
      const path = `edges[${index}]`;
      const entry = validateEdgeEntry(edge, path);
      diagnostics.push(...entry);
      if (entry.length > 0) continue;
      const typed = edge as unknown as StoryEdgeV2;
      if (seenEdgeIds.has(typed.id)) {
        diagnostics.push(narrativeErrorV1("narrative_graph_edge_id_duplicate", `${path}.id`, `Edge id "${typed.id}" is declared more than once.`));
      }
      seenEdgeIds.add(typed.id);
      if (!knownNodeIds.has(typed.from)) {
        diagnostics.push(narrativeErrorV1("narrative_graph_edge_from_missing", `${path}.from`, `Edge "${typed.id}" references unknown from node "${typed.from}".`));
      }
      if (!knownNodeIds.has(typed.to)) {
        diagnostics.push(narrativeErrorV1("narrative_graph_edge_to_missing", `${path}.to`, `Edge "${typed.id}" references unknown to node "${typed.to}".`));
      }
      if (typed.from === typed.to) {
        diagnostics.push(narrativeErrorV1("narrative_graph_edge_self_loop", path, `Edge "${typed.id}" is a self loop on node "${typed.from}".`));
      }
    }
  }

  if (!isNonEmptyString(graph.start)) {
    diagnostics.push(narrativeErrorV1("narrative_graph_start_invalid", "start", "start must be a non-empty string node id."));
  } else if (!declaredNodeIds.has(graph.start)) {
    diagnostics.push(narrativeErrorV1("narrative_graph_start_missing", "start", `start "${graph.start}" is not a declared node id.`));
  }

  if (diagnostics.length > 0) return narrativeFailureV1(diagnostics);
  return { ok: true, value: graph, diagnostics: [] };
}

/** 算法入口共用的结构守卫：非法即抛 StoryGraphStructureErrorV1，绝不静默继续。 */
export function requireStoryGraphV1(graph: StoryGraphV1): NarrativeResult<StoryGraphV1> {
  const result = validateStoryGraphV1(graph);
  if (!result.ok) throw new StoryGraphStructureErrorV1(result.diagnostics);
  return result;
}

/** 已验证图上的邻接视图：出边按 id 再按 to 排序（确定性遍历顺序）。 */
export interface StoryGraphAdjacencyV1 {
  readonly nodeIds: readonly string[];
  readonly outgoingEdges: ReadonlyMap<string, readonly StoryEdgeV2[]>;
  readonly outgoingTargets: ReadonlyMap<string, readonly string[]>;
  readonly undirectedNeighbors: ReadonlyMap<string, readonly string[]>;
}

/** 由已验证图构建确定性邻接索引（排序、目标去重）。 */
export function buildStoryGraphAdjacencyV1(graph: StoryGraphV1): StoryGraphAdjacencyV1 {
  requireStoryGraphV1(graph);
  const nodeIds = graph.nodes.map(node => node.id).sort(compareText);
  const outgoingEdges = new Map<string, StoryEdgeV2[]>();
  const outgoingTargets = new Map<string, Set<string>>();
  const undirectedNeighbors = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    outgoingEdges.set(id, []);
    outgoingTargets.set(id, new Set());
    undirectedNeighbors.set(id, new Set());
  }
  const sortedEdges = [...graph.edges].sort((left, right) =>
    compareText(left.from, right.from) || compareText(left.to, right.to) || compareText(left.id, right.id));
  for (const edge of sortedEdges) {
    outgoingEdges.get(edge.from)!.push(edge);
    outgoingTargets.get(edge.from)!.add(edge.to);
    undirectedNeighbors.get(edge.from)!.add(edge.to);
    undirectedNeighbors.get(edge.to)!.add(edge.from);
  }
  const frozenTargets = new Map<string, readonly string[]>();
  const frozenUndirected = new Map<string, readonly string[]>();
  for (const id of nodeIds) {
    frozenTargets.set(id, [...outgoingTargets.get(id)!].sort(compareText));
    frozenUndirected.set(id, [...undirectedNeighbors.get(id)!].sort(compareText));
  }
  return {
    nodeIds,
    outgoingEdges: outgoingEdges as ReadonlyMap<string, readonly StoryEdgeV2[]>,
    outgoingTargets: frozenTargets,
    undirectedNeighbors: frozenUndirected,
  };
}

export { compareText };
