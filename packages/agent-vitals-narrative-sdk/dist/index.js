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

// src/contracts/canon.ts
var CANON_BACKSTORY_MAX_BYTES_V1 = 2048;
var isRecord2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isNonEmptyString2 = (value) => typeof value === "string" && value.length > 0;
var isNonNegativeInteger = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0;
var compareText3 = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 128) {
      bytes += 1;
      continue;
    }
    if (code < 2048) {
      bytes += 2;
      continue;
    }
    if (code >= 55296 && code <= 56319) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 56320 && next <= 57343) {
        bytes += 4;
        index++;
        continue;
      }
      bytes += 3;
      continue;
    }
    if (code >= 56320 && code <= 57343) {
      bytes += 3;
      continue;
    }
    bytes += 3;
  }
  return bytes;
}
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
}
function residualCycleStates(edges) {
  const indegree = /* @__PURE__ */ new Map();
  const successors = /* @__PURE__ */ new Map();
  const seenTransitions = /* @__PURE__ */ new Set();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const transition = `${edge.from}\0${edge.to}`;
    if (seenTransitions.has(transition)) continue;
    seenTransitions.add(transition);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    if (!indegree.has(edge.from)) indegree.set(edge.from, 0);
    const targets = successors.get(edge.from) ?? [];
    targets.push(edge.to);
    successors.set(edge.from, targets);
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([state]) => state);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of successors.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  return [...indegree.entries()].filter(([, degree]) => degree > 0).map(([state]) => state).sort(compareText3);
}
function knownEventContext(context) {
  const known = context?.knownEventIds;
  if (known === void 0) return {};
  if (!(known instanceof Set) && !Array.isArray(known)) {
    return { diagnostic: narrativeErrorV1("canon_context_events_invalid", "context.knownEventIds", "context.knownEventIds must be an array or Set of non-empty event id strings.") };
  }
  const events = /* @__PURE__ */ new Set();
  for (const id of known) {
    if (!isNonEmptyString2(id)) {
      return { diagnostic: narrativeErrorV1("canon_context_events_invalid", "context.knownEventIds", "context.knownEventIds must contain only non-empty event id strings.") };
    }
    events.add(id);
  }
  return { events };
}
function validateCharacterCanonV1(canon, context) {
  if (!isRecord2(canon)) {
    return narrativeFailureV1([narrativeErrorV1("canon_malformed", "$", "Character canon must be an object.")]);
  }
  const diagnostics = [];
  if (!isNonEmptyString2(canon.storyId)) {
    diagnostics.push(narrativeErrorV1("canon_story_id_invalid", "storyId", "storyId must be a non-empty string."));
  }
  if (!isNonEmptyString2(canon.characterId)) {
    diagnostics.push(narrativeErrorV1("canon_character_id_invalid", "characterId", "characterId must be a non-empty string."));
  }
  if (!isNonEmptyString2(canon.displayName)) {
    diagnostics.push(narrativeErrorV1("canon_display_name_invalid", "displayName", "displayName must be a non-empty string."));
  }
  if (!isNonNegativeInteger(canon.version) || canon.version < 1) {
    diagnostics.push(narrativeErrorV1("canon_version_invalid", "version", "version must be an integer >= 1."));
  }
  if (canon.backstory !== void 0) {
    if (typeof canon.backstory !== "string") {
      diagnostics.push(narrativeErrorV1("canon_backstory_invalid", "backstory", "backstory must be a string when present."));
    } else if (utf8ByteLength(canon.backstory) > CANON_BACKSTORY_MAX_BYTES_V1) {
      diagnostics.push(narrativeErrorV1(
        "canon_backstory_too_large",
        "backstory",
        `backstory exceeds ${CANON_BACKSTORY_MAX_BYTES_V1} UTF-8 bytes.`
      ));
    }
  }
  const known = knownEventContext(context);
  if (known.diagnostic) diagnostics.push(known.diagnostic);
  const growthEdges = canon.growthEdges;
  const wellFormedEdges = [];
  if (growthEdges !== void 0) {
    if (!Array.isArray(growthEdges)) {
      diagnostics.push(narrativeErrorV1("canon_growth_edges_invalid", "growthEdges", "growthEdges must be an array of growth edges."));
    } else {
      const seenTransitions = /* @__PURE__ */ new Set();
      for (const [index, edge] of growthEdges.entries()) {
        const path = `growthEdges[${index}]`;
        if (!isRecord2(edge)) {
          diagnostics.push(narrativeErrorV1("canon_growth_edge_malformed", path, "Growth edge entry must be an object."));
          continue;
        }
        if (!isNonEmptyString2(edge.from)) {
          diagnostics.push(narrativeErrorV1("canon_growth_edge_from_invalid", `${path}.from`, "Growth edge from must be a non-empty string."));
        }
        if (!isNonEmptyString2(edge.to)) {
          diagnostics.push(narrativeErrorV1("canon_growth_edge_to_invalid", `${path}.to`, "Growth edge to must be a non-empty string."));
        }
        if (!isNonEmptyString2(edge.requireEvent)) {
          diagnostics.push(narrativeErrorV1("canon_growth_edge_event_invalid", `${path}.requireEvent`, "Growth edge requireEvent must be a non-empty story event id."));
        }
        if (!isNonEmptyString2(edge.from) || !isNonEmptyString2(edge.to) || !isNonEmptyString2(edge.requireEvent)) continue;
        if (edge.from === edge.to) {
          diagnostics.push(narrativeErrorV1("canon_growth_edge_self_loop", path, `Growth edge "${edge.requireEvent}" is a self loop on state "${edge.from}".`));
        }
        const transition = `${edge.from}\0${edge.to}`;
        if (seenTransitions.has(transition)) {
          diagnostics.push(narrativeErrorV1("canon_growth_edge_duplicate", path, `Growth transition "${edge.from}" -> "${edge.to}" is declared more than once.`));
        }
        seenTransitions.add(transition);
        wellFormedEdges.push(edge);
      }
      if (known.events !== void 0) {
        for (const [index, edge] of wellFormedEdges.entries()) {
          if (!known.events.has(edge.requireEvent)) {
            diagnostics.push(narrativeErrorV1(
              "canon_growth_edge_event_missing",
              `growthEdges[${index}].requireEvent`,
              `Growth edge references unknown story event "${edge.requireEvent}".`
            ));
          }
        }
      }
      const residual = residualCycleStates(wellFormedEdges);
      if (residual.length > 0) {
        diagnostics.push(narrativeErrorV1(
          "canon_growth_edge_cycle",
          "growthEdges",
          `Growth trajectory contains a cycle; allowed growth must be acyclic. States involved: ${residual.join(", ")}.`
        ));
      }
    }
  }
  if (diagnostics.length > 0) return narrativeFailureV1(diagnostics);
  deepFreeze(canon);
  return { ok: true, value: canon, diagnostics: [] };
}

// src/contracts/knowledge.ts
var KNOWLEDGE_CONTENT_MAX_BYTES_V1 = 512;
var KNOWLEDGE_VISIBILITY_V1 = ["public", "private"];

// src/validate/knowledge.ts
var isRecord3 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isNonEmptyString3 = (value) => typeof value === "string" && value.length > 0;
var isNonNegativeInteger2 = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0;
var compareText4 = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function utf8ByteLength2(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 128) {
      bytes += 1;
      continue;
    }
    if (code < 2048) {
      bytes += 2;
      continue;
    }
    if (code >= 55296 && code <= 56319) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 56320 && next <= 57343) {
        bytes += 4;
        index++;
        continue;
      }
      bytes += 3;
      continue;
    }
    if (code >= 56320 && code <= 57343) {
      bytes += 3;
      continue;
    }
    bytes += 3;
  }
  return bytes;
}
function committedEventSet(committedEventIds, invalidCode) {
  if (committedEventIds instanceof Set) {
    for (const id of committedEventIds) {
      if (!isNonEmptyString3(id)) {
        return { events: /* @__PURE__ */ new Set(), diagnostic: narrativeErrorV1(invalidCode, "committedEventIds", "committedEventIds must contain only non-empty event id strings.") };
      }
    }
    return { events: committedEventIds };
  }
  if (!Array.isArray(committedEventIds)) {
    return { events: /* @__PURE__ */ new Set(), diagnostic: narrativeErrorV1(invalidCode, "committedEventIds", "committedEventIds must be an array of non-empty event id strings or a Set.") };
  }
  const events = /* @__PURE__ */ new Set();
  for (const id of committedEventIds) {
    if (!isNonEmptyString3(id)) {
      return { events: /* @__PURE__ */ new Set(), diagnostic: narrativeErrorV1(invalidCode, "committedEventIds", "committedEventIds must contain only non-empty event id strings.") };
    }
    events.add(id);
  }
  return { events };
}
function withCanonPrefix(diagnostics) {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    path: diagnostic.path === "$" ? "canon" : `canon.${diagnostic.path}`
  }));
}
function validateKnowledgeClaims(claims, committedEventIds, canon) {
  const canonCheck = validateCharacterCanonV1(canon);
  if (!canonCheck.ok) return narrativeFailureV1(withCanonPrefix(canonCheck.diagnostics));
  const committed = committedEventSet(committedEventIds, "knowledge_committed_events_invalid");
  if (committed.diagnostic) return narrativeFailureV1([committed.diagnostic]);
  if (!Array.isArray(claims)) {
    return narrativeFailureV1([narrativeErrorV1("knowledge_claims_invalid", "claims", "claims must be an array of KnowledgeClaimV1.")]);
  }
  const diagnostics = [];
  for (const [index, entry] of claims.entries()) {
    const path = `claims[${index}]`;
    if (!isRecord3(entry)) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_malformed", path, "Claim entry must be an object."));
      continue;
    }
    const claim = entry;
    if (!isNonEmptyString3(claim.claimId)) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_id_invalid", `${path}.claimId`, "claimId must be a non-empty string."));
    }
    if (!isNonEmptyString3(claim.characterId)) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_character_invalid", `${path}.characterId`, "characterId must be a non-empty string."));
    }
    if (!isNonEmptyString3(claim.subject)) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_subject_invalid", `${path}.subject`, "subject must be a non-empty string (who or what the belief is about)."));
    }
    if (typeof claim.content !== "string" || claim.content.length === 0) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_content_invalid", `${path}.content`, "content must be a non-empty string."));
    } else if (utf8ByteLength2(claim.content) > KNOWLEDGE_CONTENT_MAX_BYTES_V1) {
      diagnostics.push(narrativeErrorV1(
        "knowledge_claim_content_too_large",
        `${path}.content`,
        `content exceeds ${KNOWLEDGE_CONTENT_MAX_BYTES_V1} UTF-8 bytes.`
      ));
    }
    if (claim.sourceEventId !== void 0 && !isNonEmptyString3(claim.sourceEventId)) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_source_invalid", `${path}.sourceEventId`, "sourceEventId must be a non-empty string when present."));
    }
    if (!KNOWLEDGE_VISIBILITY_V1.includes(claim.visibility)) {
      diagnostics.push(narrativeErrorV1(
        "knowledge_claim_visibility_invalid",
        `${path}.visibility`,
        `visibility must be one of ${KNOWLEDGE_VISIBILITY_V1.map((v) => `"${v}"`).join(" | ")}.`
      ));
    }
    if (!isNonNegativeInteger2(claim.acquiredAtStoryRevision)) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_revision_invalid", `${path}.acquiredAtStoryRevision`, "acquiredAtStoryRevision must be a non-negative integer."));
    }
    if (typeof claim.stale !== "boolean") {
      diagnostics.push(narrativeErrorV1("knowledge_claim_stale_invalid", `${path}.stale`, "stale must be a boolean."));
    }
    const shapeValid = isNonEmptyString3(claim.claimId) && isNonEmptyString3(claim.characterId) && isNonEmptyString3(claim.subject) && typeof claim.content === "string" && claim.content.length > 0 && (claim.sourceEventId === void 0 || isNonEmptyString3(claim.sourceEventId)) && KNOWLEDGE_VISIBILITY_V1.includes(claim.visibility) && isNonNegativeInteger2(claim.acquiredAtStoryRevision) && typeof claim.stale === "boolean";
    if (!shapeValid) continue;
    if (claim.characterId !== canon.characterId) {
      diagnostics.push(narrativeErrorV1(
        "knowledge_character_mismatch",
        `${path}.characterId`,
        `Claim "${claim.claimId}" belongs to character "${claim.characterId}", but this validation covers "${canon.characterId}".`
      ));
      continue;
    }
    if (claim.visibility === "private" && claim.sourceEventId === void 0) {
      diagnostics.push(narrativeErrorV1(
        "knowledge_unverifiable",
        `${path}.sourceEventId`,
        `Private knowledge claim "${claim.claimId}" has no sourceEventId; an NPC cannot know about a private event without a committed source (V3-04).`
      ));
    }
    if (claim.sourceEventId !== void 0 && !committed.events.has(claim.sourceEventId)) {
      diagnostics.push(narrativeErrorV1(
        "knowledge_source_missing",
        `${path}.sourceEventId`,
        `Claim "${claim.claimId}" cites source event "${claim.sourceEventId}" which is not committed to the event log (V3-04).`
      ));
    }
  }
  if (diagnostics.length > 0) return narrativeFailureV1(diagnostics);
  return { ok: true, value: claims, diagnostics: [] };
}
function markStaleSummaries(summaries, currentStateRevision) {
  if (!isNonNegativeInteger2(currentStateRevision)) {
    return narrativeFailureV1([narrativeErrorV1("summary_state_revision_invalid", "currentStateRevision", "currentStateRevision must be a non-negative integer.")]);
  }
  if (!Array.isArray(summaries)) {
    return narrativeFailureV1([narrativeErrorV1("summaries_invalid", "summaries", "summaries must be an array of NarrativeSummaryV1.")]);
  }
  const diagnostics = [];
  for (const [index, summary] of summaries.entries()) {
    const path = `summaries[${index}]`;
    if (!isRecord3(summary)) {
      diagnostics.push(narrativeErrorV1("summary_malformed", path, "Summary entry must be an object."));
      continue;
    }
    if (!isNonEmptyString3(summary.summaryId)) {
      diagnostics.push(narrativeErrorV1("summary_id_invalid", `${path}.summaryId`, "summaryId must be a non-empty string."));
    }
    if (!isNonNegativeInteger2(summary.revision)) {
      diagnostics.push(narrativeErrorV1("summary_revision_invalid", `${path}.revision`, "revision must be a non-negative integer (State revision at summary time)."));
    }
  }
  if (diagnostics.length > 0) return narrativeFailureV1(diagnostics);
  const value = summaries.map((summary) => ({
    ...summary,
    stale: summary.stale === true || summary.revision < currentStateRevision
  }));
  return { ok: true, value, diagnostics: [] };
}
function checkCausalDependency(newEventDependencies, committedEventIds) {
  const committed = committedEventSet(committedEventIds, "causal_committed_events_invalid");
  if (committed.diagnostic) return narrativeFailureV1([committed.diagnostic]);
  if (!Array.isArray(newEventDependencies)) {
    return narrativeFailureV1([narrativeErrorV1("causal_dependencies_invalid", "newEventDependencies", "newEventDependencies must be an array of non-empty event id strings.")]);
  }
  const diagnostics = [];
  const satisfied = /* @__PURE__ */ new Set();
  for (const [index, dependency] of newEventDependencies.entries()) {
    const path = `newEventDependencies[${index}]`;
    if (!isNonEmptyString3(dependency)) {
      diagnostics.push(narrativeErrorV1("causal_dependency_malformed", path, "Causal dependency must be a non-empty event id string."));
      continue;
    }
    if (!committed.events.has(dependency)) {
      diagnostics.push(narrativeErrorV1(
        "causal_dependency_missing",
        path,
        `New event depends on "${dependency}" which is not committed to the event log.`
      ));
      continue;
    }
    satisfied.add(dependency);
  }
  if (diagnostics.length > 0) return narrativeFailureV1(diagnostics);
  return { ok: true, value: [...satisfied].sort(compareText4), diagnostics: [] };
}
export {
  CANON_BACKSTORY_MAX_BYTES_V1,
  KNOWLEDGE_CONTENT_MAX_BYTES_V1,
  KNOWLEDGE_VISIBILITY_V1,
  STORY_GRAPH_CHECK_STATUSES_V1,
  StoryGraphStructureErrorV1,
  buildStoryGraphAdjacencyV1,
  checkCausalDependency,
  conditionalReachability,
  deadEnds,
  islands,
  markStaleSummaries,
  narrativeErrorV1,
  narrativeFailureV1,
  reachability,
  requireStoryGraphV1,
  storyGraphCheckStatusV1,
  stronglyConnectedComponents,
  validateCharacterCanonV1,
  validateKnowledgeClaims,
  validateStoryGraphV1
};
