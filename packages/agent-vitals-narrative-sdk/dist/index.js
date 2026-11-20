// src/contracts/diagnostics.ts
var STORY_GRAPH_CHECK_STATUSES_V1 = ["passed", "validator_error"];
function storyGraphCheckStatusV1(result) {
  if (!result.ok) return "validator_error";
  if (result.diagnostics.some((d) => d.severity === "error")) return "validator_error";
  return "passed";
}
function narrativeErrorV1(code, path, message) {
  return { code, severity: "error", path, message };
}
function narrativeFailureV1(diagnostics) {
  if (diagnostics.length === 0) {
    return { ok: false, diagnostics: [narrativeErrorV1("narrative_validator_internal_error", "$", "Validator failed without diagnostics; this is a validator bug and must surface as an error, never as a passed report.")] };
  }
  return { ok: false, diagnostics: [...diagnostics] };
}

// src/graph/validate.ts
var compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
var StoryGraphStructureErrorV1 = class extends Error {
  diagnostics;
  constructor(diagnostics) {
    super(`story graph structure invalid: ${diagnostics.map((d) => `${d.path}: ${d.code}`).join("; ")}`);
    this.name = "StoryGraphStructureErrorV1";
    this.diagnostics = diagnostics;
  }
};
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
function validateNodeEntry(node, path) {
  if (!isRecord(node)) return [narrativeErrorV1("narrative_graph_node_malformed", path, "Node entry must be an object.")];
  if (!isNonEmptyString(node.id)) return [narrativeErrorV1("narrative_graph_node_id_invalid", `${path}.id`, "Node id must be a non-empty string.")];
  if (node.title !== void 0 && typeof node.title !== "string") {
    return [narrativeErrorV1("narrative_graph_node_title_invalid", `${path}.title`, "Node title must be a string when present.")];
  }
  if (node.meta !== void 0 && !isRecord(node.meta)) {
    return [narrativeErrorV1("narrative_graph_node_meta_invalid", `${path}.meta`, "Node meta must be an object when present.")];
  }
  if (!isNonEmptyString(node.kind)) {
    return [narrativeErrorV1("narrative_graph_node_kind_invalid", `${path}.kind`, "Node kind must be a non-empty string.")];
  }
  return [];
}
function validateEdgeEntry(edge, path) {
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
function validateStoryGraphV1(graph) {
  if (!isRecord(graph)) {
    return narrativeFailureV1([narrativeErrorV1("narrative_graph_malformed", "$", "Story graph must be an object.")]);
  }
  const diagnostics = [];
  if (!Array.isArray(graph.nodes)) {
    diagnostics.push(narrativeErrorV1("narrative_graph_nodes_invalid", "nodes", "nodes must be an array of StoryNodeV1."));
  } else {
    const seenNodeIds = /* @__PURE__ */ new Set();
    for (const [index, node] of graph.nodes.entries()) {
      const path = `nodes[${index}]`;
      const entry = validateNodeEntry(node, path);
      diagnostics.push(...entry);
      if (entry.length === 0) {
        const id = node.id;
        if (seenNodeIds.has(id)) {
          diagnostics.push(narrativeErrorV1("narrative_graph_node_id_duplicate", `${path}.id`, `Node id "${id}" is declared more than once.`));
        }
        seenNodeIds.add(id);
      }
    }
  }
  const declaredNodeIds = Array.isArray(graph.nodes) ? new Set(graph.nodes.filter(isRecord).map((node) => node.id).filter(isNonEmptyString)) : /* @__PURE__ */ new Set();
  if (!Array.isArray(graph.edges)) {
    diagnostics.push(narrativeErrorV1("narrative_graph_edges_invalid", "edges", "edges must be an array of StoryEdgeV2."));
  } else {
    const seenEdgeIds = /* @__PURE__ */ new Set();
    const knownNodeIds = declaredNodeIds;
    for (const [index, edge] of graph.edges.entries()) {
      const path = `edges[${index}]`;
      const entry = validateEdgeEntry(edge, path);
      diagnostics.push(...entry);
      if (entry.length > 0) continue;
      const typed = edge;
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
function requireStoryGraphV1(graph) {
  const result = validateStoryGraphV1(graph);
  if (!result.ok) throw new StoryGraphStructureErrorV1(result.diagnostics);
  return result;
}
function buildStoryGraphAdjacencyV1(graph) {
  requireStoryGraphV1(graph);
  const nodeIds = graph.nodes.map((node) => node.id).sort(compareText);
  const outgoingEdges = /* @__PURE__ */ new Map();
  const outgoingTargets = /* @__PURE__ */ new Map();
  const undirectedNeighbors = /* @__PURE__ */ new Map();
  for (const id of nodeIds) {
    outgoingEdges.set(id, []);
    outgoingTargets.set(id, /* @__PURE__ */ new Set());
    undirectedNeighbors.set(id, /* @__PURE__ */ new Set());
  }
  const sortedEdges = [...graph.edges].sort((left, right) => compareText(left.from, right.from) || compareText(left.to, right.to) || compareText(left.id, right.id));
  for (const edge of sortedEdges) {
    outgoingEdges.get(edge.from).push(edge);
    outgoingTargets.get(edge.from).add(edge.to);
    undirectedNeighbors.get(edge.from).add(edge.to);
    undirectedNeighbors.get(edge.to).add(edge.from);
  }
  const frozenTargets = /* @__PURE__ */ new Map();
  const frozenUndirected = /* @__PURE__ */ new Map();
  for (const id of nodeIds) {
    frozenTargets.set(id, [...outgoingTargets.get(id)].sort(compareText));
    frozenUndirected.set(id, [...undirectedNeighbors.get(id)].sort(compareText));
  }
  return {
    nodeIds,
    outgoingEdges,
    outgoingTargets: frozenTargets,
    undirectedNeighbors: frozenUndirected
  };
}

// src/graph/reachability.ts
function reachability(graph, start) {
  const adjacency = buildStoryGraphAdjacencyV1(graph);
  return reachableFrom(start, adjacency);
}
function conditionalReachability(graph, start, canTraverse) {
  const adjacency = buildStoryGraphAdjacencyV1(graph);
  requireKnownStart(start, adjacency);
  const reachable = /* @__PURE__ */ new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of adjacency.outgoingEdges.get(current) ?? []) {
      if (!canTraverse(edge)) continue;
      if (reachable.has(edge.to)) continue;
      reachable.add(edge.to);
      queue.push(edge.to);
    }
  }
  return [...reachable].sort(compareText2);
}
function reachableFrom(start, adjacency) {
  requireKnownStart(start, adjacency);
  const reachable = /* @__PURE__ */ new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of adjacency.outgoingTargets.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }
  return [...reachable].sort(compareText2);
}
function requireKnownStart(start, adjacency) {
  if (!adjacency.nodeIds.includes(start)) {
    throw new StoryGraphStructureErrorV1([
      narrativeErrorV1("narrative_graph_start_missing", "start", `Traversal start "${start}" is not a declared node id.`)
    ]);
  }
}
var compareText2 = (left, right) => left < right ? -1 : left > right ? 1 : 0;

// src/graph/scc.ts
function stronglyConnectedComponents(graph) {
  const adjacency = buildStoryGraphAdjacencyV1(graph);
  const index = /* @__PURE__ */ new Map();
  const low = /* @__PURE__ */ new Map();
  const onStack = /* @__PURE__ */ new Set();
  const stack = [];
  const components = [];
  let nextIndex = 0;
  for (const root of adjacency.nodeIds) {
    if (index.has(root)) continue;
    index.set(root, nextIndex);
    low.set(root, nextIndex);
    nextIndex += 1;
    stack.push(root);
    onStack.add(root);
    const frames = [{ node: root, cursor: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const neighbors = adjacency.outgoingTargets.get(frame.node) ?? [];
      if (frame.cursor < neighbors.length) {
        const next = neighbors[frame.cursor];
        frame.cursor += 1;
        if (!index.has(next)) {
          index.set(next, nextIndex);
          low.set(next, nextIndex);
          nextIndex += 1;
          stack.push(next);
          onStack.add(next);
          frames.push({ node: next, cursor: 0 });
        } else if (onStack.has(next)) {
          const candidate = index.get(next);
          if (candidate < low.get(frame.node)) low.set(frame.node, candidate);
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        const childLow = low.get(frame.node);
        if (childLow < low.get(parent.node)) low.set(parent.node, childLow);
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        for (; ; ) {
          const member = stack.pop();
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        components.push(component.sort(compareText));
      }
    }
  }
  components.sort((left, right) => compareText(left[0], right[0]));
  return components;
}

// src/graph/topology.ts
function deadEnds(graph) {
  const adjacency = buildStoryGraphAdjacencyV1(graph);
  return adjacency.nodeIds.filter((id) => (adjacency.outgoingTargets.get(id) ?? []).length === 0);
}
function islands(graph) {
  const adjacency = buildStoryGraphAdjacencyV1(graph);
  const reachableSet = new Set(reachability(graph, graph.start));
  const visited = /* @__PURE__ */ new Set();
  const result = [];
  for (const id of adjacency.nodeIds) {
    if (visited.has(id)) continue;
    const component = [];
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const current = queue.shift();
      component.push(current);
      for (const next of adjacency.undirectedNeighbors.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    if (!component.some((member) => reachableSet.has(member))) {
      result.push(component.sort(compareText));
    }
  }
  result.sort((left, right) => compareText(left[0], right[0]));
  return result;
}
export {
  STORY_GRAPH_CHECK_STATUSES_V1,
  StoryGraphStructureErrorV1,
  buildStoryGraphAdjacencyV1,
  conditionalReachability,
  deadEnds,
  islands,
  narrativeErrorV1,
  narrativeFailureV1,
  reachability,
  requireStoryGraphV1,
  storyGraphCheckStatusV1,
  stronglyConnectedComponents,
  validateStoryGraphV1
};
