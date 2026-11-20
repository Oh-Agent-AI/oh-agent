import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStoryGraphAdjacencyV1, conditionalReachability, deadEnds, islands,
  narrativeFailureV1, reachability, requireStoryGraphV1, StoryGraphStructureErrorV1,
  STORY_GRAPH_CHECK_STATUSES_V1, storyGraphCheckStatusV1, stronglyConnectedComponents,
  validateStoryGraphV1,
  type StoryEdgeV2, type StoryGraphV1, type StoryNodeV1,
} from "../src/index";

// 固定 fixtures（S-5 第一部分验收，RFC OH_AGENT_CITY_SDK_V3_INTEGRATION §4.2/§4.3、V3-12）：
// 覆盖线性链、分支汇合、SCC 环、死胡同、孤岛、条件边（谓词 true/false）、非法图诊断。
// 所有算法输出断言确定性（升序排序、输入顺序无关、输入不可变）。

const SCOPE_FIXTURE = "story:player-1:city-1:romance:run-1";

const node = (id: string, kind = "beat"): StoryNodeV1 => ({ id, kind });

const edge = (id: string, from: string, to: string): StoryEdgeV2 => ({
  id, from, to,
  preconditions: {},
  effects: [],
  eventDependencies: [],
  scope: SCOPE_FIXTURE,
});

const graph = (start: string, nodes: StoryNodeV1[], edges: StoryEdgeV2[]): StoryGraphV1 => ({ start, nodes, edges });

const LINEAR = graph("a", ["a", "b", "c", "d"].map(id => node(id)), [
  edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "d"),
]);

const BRANCH_JOIN = graph("a", ["a", "b", "c", "d"].map(id => node(id)), [
  edge("e1", "a", "b"), edge("e2", "a", "c"), edge("e3", "b", "d"), edge("e4", "c", "d"),
]);

const CYCLE_THEN_EXIT = graph("a", ["a", "b", "c", "d"].map(id => node(id)), [
  edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a"), edge("e4", "c", "d"),
]);

const ISLANDS = graph("s", ["s", "t", "x", "y", "m"].map(id => node(id)), [
  edge("e1", "s", "t"), edge("e2", "x", "y"), edge("e3", "m", "s"),
]);

const CONDITIONAL = graph("a", ["a", "b", "c"].map(id => node(id)), [
  edge("gate-open", "a", "b"), edge("e2", "a", "c"), edge("e3", "c", "b"),
]);

const GATED_CHAIN = graph("a", ["a", "b", "c"].map(id => node(id)), [
  edge("gate-open", "a", "b"), edge("e2", "b", "c"),
]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function expectStructureError(action: () => unknown, expectedCode: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof StoryGraphStructureErrorV1, `expected StoryGraphStructureErrorV1, got ${String(error)}`);
    assert.equal(error.diagnostics.length > 0, true, "structure error must carry diagnostics");
    assert.equal(error.diagnostics.some(d => d.code === expectedCode), true, `expected diagnostic ${expectedCode}`);
    return true;
  });
}

test("linear chain: reachability covers every node and finds the single dead end", () => {
  assert.deepEqual([...reachability(LINEAR, "a")], ["a", "b", "c", "d"]);
  assert.deepEqual([...deadEnds(LINEAR)], ["d"]);
  assert.deepEqual(stronglyConnectedComponents(LINEAR), [["a"], ["b"], ["c"], ["d"]]);
  assert.deepEqual(islands(LINEAR), []);
});

test("branch/join graph converges on one terminal and stays acyclic", () => {
  assert.deepEqual([...reachability(BRANCH_JOIN, "a")], ["a", "b", "c", "d"]);
  assert.deepEqual([...reachability(BRANCH_JOIN, "b")], ["b", "d"]);
  assert.deepEqual([...deadEnds(BRANCH_JOIN)], ["d"]);
  assert.deepEqual(stronglyConnectedComponents(BRANCH_JOIN), [["a"], ["b"], ["c"], ["d"]]);
});

test("Tarjan SCC groups the cycle and orders components deterministically", () => {
  assert.deepEqual(stronglyConnectedComponents(CYCLE_THEN_EXIT), [["a", "b", "c"], ["d"]]);
  assert.deepEqual([...deadEnds(CYCLE_THEN_EXIT)], ["d"]);
  assert.deepEqual([...reachability(CYCLE_THEN_EXIT, "a")], ["a", "b", "c", "d"]);
  // SCC 的集合划分唯一：打乱输入数组顺序后输出必须完全一致（规范化排序）。
  const shuffled = graph("a", [...CYCLE_THEN_EXIT.nodes].reverse(), [...CYCLE_THEN_EXIT.edges].reverse());
  assert.deepEqual(stronglyConnectedComponents(shuffled), stronglyConnectedComponents(CYCLE_THEN_EXIT));
  assert.deepEqual([...reachability(shuffled, "a")], [...reachability(CYCLE_THEN_EXIT, "a")]);
});

test("islands are weak components with no member reachable from graph.start", () => {
  // s/t 是 start 分量；m→s 让 m 与 start 同属一个弱分量（分量级判定，非孤岛）；
  // x/y 与 start 无任何连接，构成孤岛。
  assert.deepEqual([...reachability(ISLANDS, "s")], ["s", "t"]);
  assert.deepEqual(islands(ISLANDS), [["x", "y"]]);
  const reversedPair = graph("s", [...ISLANDS.nodes].reverse(), [...ISLANDS.edges].reverse());
  assert.deepEqual(islands(reversedPair), islands(ISLANDS));
});

test("conditional reachability honors the injected predicate in both directions", () => {
  const allowAll = () => true;
  const blockGate = (edgeRef: StoryEdgeV2) => edgeRef.id !== "gate-open";
  const allowGateOnly = (edgeRef: StoryEdgeV2) => edgeRef.id === "gate-open";
  // 谓词放行全部：与结构可达一致。
  assert.deepEqual([...conditionalReachability(CONDITIONAL, "a", allowAll)], ["a", "b", "c"]);
  // 封锁 gate 但存在绕行边 c→b：b 仍条件可达（谓词按边判定，不是按节点剪枝）。
  assert.deepEqual([...conditionalReachability(CONDITIONAL, "a", blockGate)], ["a", "b", "c"]);
  // 只放行 gate：绕行被封锁，c 不可达。
  assert.deepEqual([...conditionalReachability(CONDITIONAL, "a", allowGateOnly)], ["a", "b"]);
  // 谓词收到完整边（占位 scope 可用于按 scope 过滤）。
  const byScope = (edgeRef: StoryEdgeV2) => edgeRef.scope === SCOPE_FIXTURE;
  assert.deepEqual([...conditionalReachability(CONDITIONAL, "a", byScope)], ["a", "b", "c"]);
  // 无绕行的门控链：封锁 gate 后 b、c 均条件不可达。
  assert.deepEqual([...conditionalReachability(GATED_CHAIN, "a", allowAll)], ["a", "b", "c"]);
  assert.deepEqual([...conditionalReachability(GATED_CHAIN, "a", blockGate)], ["a"]);
});

test("structural reachability differs from conditional reachability on gated graphs", () => {
  // 结构上有边即可达；条件上 gate 封锁后 b、c 不可达（RFC §4.2 检查 1 的核心语义）。
  assert.deepEqual([...reachability(GATED_CHAIN, "a")], ["a", "b", "c"]);
  assert.deepEqual([...conditionalReachability(GATED_CHAIN, "a", edgeRef => edgeRef.id !== "gate-open")], ["a"]);
});

test("validation accepts a sound graph and returns the same reference", () => {
  const result = validateStoryGraphV1(LINEAR);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, LINEAR);
    assert.deepEqual([...result.diagnostics], []);
  }
  assert.equal(storyGraphCheckStatusV1(result), "passed");
});

test("validation reports duplicate edge ids with paths", () => {
  const broken = graph("a", ["a", "b"].map(id => node(id)), [edge("e1", "a", "b"), edge("e1", "b", "a")]);
  const result = validateStoryGraphV1(broken);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostics.length >= 1, true);
    assert.deepEqual(
      result.diagnostics.filter(d => d.code === "narrative_graph_edge_id_duplicate").map(d => d.path),
      ["edges[1].id"],
    );
  }
  assert.equal(storyGraphCheckStatusV1(result), "validator_error");
});

test("validation reports dangling from and to endpoints separately", () => {
  const broken = graph("a", ["a"].map(id => node(id)), [edge("e1", "ghost", "a"), edge("e2", "a", "phantom")]);
  const result = validateStoryGraphV1(broken);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(
      result.diagnostics.filter(d => d.code === "narrative_graph_edge_from_missing").map(d => d.path),
      ["edges[0].from"],
    );
    assert.deepEqual(
      result.diagnostics.filter(d => d.code === "narrative_graph_edge_to_missing").map(d => d.path),
      ["edges[1].to"],
    );
  }
});

test("validation rejects self loops", () => {
  const broken = graph("a", ["a", "b"].map(id => node(id)), [edge("e1", "a", "b"), edge("e2", "b", "b")]);
  const result = validateStoryGraphV1(broken);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(
      result.diagnostics.filter(d => d.code === "narrative_graph_edge_self_loop").map(d => d.path),
      ["edges[1]"],
    );
  }
});

test("validation rejects duplicate node ids and missing start", () => {
  const duplicateNode = graph("a", [node("a"), node("a"), node("b")], [edge("e1", "a", "b")]);
  const duplicateResult = validateStoryGraphV1(duplicateNode);
  assert.equal(duplicateResult.ok, false);
  if (!duplicateResult.ok) {
    assert.deepEqual(
      duplicateResult.diagnostics.filter(d => d.code === "narrative_graph_node_id_duplicate").map(d => d.path),
      ["nodes[1].id"],
    );
  }

  const missingStart = graph("z", [node("a")], []);
  const missingResult = validateStoryGraphV1(missingStart);
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) {
    assert.deepEqual(
      missingResult.diagnostics.filter(d => d.code === "narrative_graph_start_missing").map(d => d.path),
      ["start"],
    );
  }
});

test("validation collects multiple diagnostics in deterministic input order", () => {
  const broken = graph("ghost", [node("a")], [
    edge("e1", "ghost", "ghost"),   // from missing + to missing + self loop
    edge("e1", "a", "ghost"),       // duplicate edge id + to missing
  ]);
  const first = validateStoryGraphV1(broken);
  const second = validateStoryGraphV1(broken);
  assert.deepEqual(first, second);
  assert.equal(first.ok, false);
  if (!first.ok) {
    assert.deepEqual(first.diagnostics.map(d => `${d.path}:${d.code}`), [
      "edges[0].from:narrative_graph_edge_from_missing",
      "edges[0].to:narrative_graph_edge_to_missing",
      "edges[0]:narrative_graph_edge_self_loop",
      "edges[1].id:narrative_graph_edge_id_duplicate",
      "edges[1].to:narrative_graph_edge_to_missing",
      "start:narrative_graph_start_missing",
    ]);
    assert.equal(first.diagnostics.length > 0, true);
  }
  assert.equal(storyGraphCheckStatusV1(first), "validator_error");
});

test("malformed entries and empty graphs produce structured failures, never empty successes", () => {
  const malformed = validateStoryGraphV1(graph("a", [42 as unknown as StoryNodeV1], [edge("e1", "a", "a")]));
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.deepEqual(malformed.diagnostics.map(d => `${d.path}:${d.code}`), [
      "nodes[0]:narrative_graph_node_malformed",
      "edges[0].from:narrative_graph_edge_from_missing",
      "edges[0].to:narrative_graph_edge_to_missing",
      "edges[0]:narrative_graph_edge_self_loop",
      "start:narrative_graph_start_missing",
    ]);
  }

  const empty = validateStoryGraphV1(graph("a", [], []));
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.diagnostics.some(d => d.code === "narrative_graph_start_missing"), true);

  // V3-12：任何失败都绝不允许空诊断的"成功报告"。
  const guarded = narrativeFailureV1([]);
  assert.equal(guarded.ok, false);
  if (!guarded.ok) assert.equal(guarded.diagnostics[0]!.code, "narrative_validator_internal_error");
});

test("check statuses distinguish passed from validator_error strictly", () => {
  assert.deepEqual([...STORY_GRAPH_CHECK_STATUSES_V1].sort(), ["passed", "validator_error"]);
  assert.equal(storyGraphCheckStatusV1(validateStoryGraphV1(LINEAR)), "passed");
  for (const broken of [
    graph("a", ["a"].map(id => node(id)), [edge("e1", "a", "a")]),
    graph("a", ["a", "a"].map(id => node(id)), []),
    graph("z", [node("a")], []),
  ]) {
    const result = validateStoryGraphV1(broken);
    assert.equal(result.ok, false);
    assert.equal(storyGraphCheckStatusV1(result), "validator_error");
  }
});

test("algorithms throw StoryGraphStructureErrorV1 on illegal graphs instead of silent results", () => {
  const selfLoop = graph("a", [node("a")], [edge("e1", "a", "a")]);
  expectStructureError(() => reachability(selfLoop, "a"), "narrative_graph_edge_self_loop");
  expectStructureError(() => conditionalReachability(selfLoop, "a", () => true), "narrative_graph_edge_self_loop");
  expectStructureError(() => stronglyConnectedComponents(selfLoop), "narrative_graph_edge_self_loop");
  expectStructureError(() => deadEnds(selfLoop), "narrative_graph_edge_self_loop");
  expectStructureError(() => islands(selfLoop), "narrative_graph_edge_self_loop");
  assert.throws(() => requireStoryGraphV1(selfLoop), StoryGraphStructureErrorV1);

  const unknownStart = graph("a", [node("a")], []);
  expectStructureError(() => reachability(unknownStart, "b"), "narrative_graph_start_missing");
  expectStructureError(() => conditionalReachability(unknownStart, "b", () => true), "narrative_graph_start_missing");
});

test("algorithms never mutate their inputs", () => {
  const frozen = deepFreeze(structuredClone(ISLANDS)) as StoryGraphV1;
  const baseline = {
    reachable: [...reachability(frozen, "s")],
    scc: stronglyConnectedComponents(frozen).map(component => [...component]),
    dead: [...deadEnds(frozen)],
    isolated: islands(frozen).map(component => [...component]),
    conditional: [...conditionalReachability(frozen, "s", () => true)],
  };
  const repeat = {
    reachable: [...reachability(frozen, "s")],
    scc: stronglyConnectedComponents(frozen).map(component => [...component]),
    dead: [...deadEnds(frozen)],
    isolated: islands(frozen).map(component => [...component]),
    conditional: [...conditionalReachability(frozen, "s", () => true)],
  };
  assert.deepEqual(repeat, baseline);
  assert.deepEqual(Object.isFrozen(frozen), true);
  assert.deepEqual(Object.isFrozen(frozen.nodes), true);
  assert.deepEqual(Object.isFrozen(frozen.edges), true);
});

test("adjacency view is deterministic and mirrors the edge set", () => {
  const first = buildStoryGraphAdjacencyV1(BRANCH_JOIN);
  const second = buildStoryGraphAdjacencyV1(graph("a", [...BRANCH_JOIN.nodes].reverse(), [...BRANCH_JOIN.edges].reverse()));
  assert.deepEqual([...first.nodeIds], [...second.nodeIds]);
  assert.deepEqual(
    [...first.outgoingTargets.keys()].sort(),
    [...second.outgoingTargets.keys()].sort(),
  );
  assert.deepEqual([...first.outgoingTargets.get("a")!], ["b", "c"]);
  assert.deepEqual([...first.outgoingEdges.get("a")!.map(e => e.id)], ["e1", "e2"]);
  assert.deepEqual([...first.undirectedNeighbors.get("d")!], ["b", "c"]);
});
