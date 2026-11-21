/**
 * Narrative 求值器（OH_AGENT_NARRATIVE_ENGINE_SPEC §5.1，rquickjs 嵌入载体）。
 * 编译期 include_str! 进宿主二进制；每次调用建全新 Runtime/Context。
 * 入口：narrativeEngine.evaluate(snapshotJson, proposalJson) → Decision JSON 字符串。
 * nonce 关联：Host 生成 evaluationNonce → 求值器原样回填 → Host 校验一致。
 * 与 narrative-sdk runtime/evaluate.ts 保持 lockstep（同逻辑同步更新）。
 */
var narrativeEngine = (function () {
  "use strict";

  function evalCondition(condition, snapshot) {
    switch (condition.op) {
      case "flag":
        return (snapshot.flags[condition.key] ?? false) === condition.expected;
      case "counter.gte":
        return (snapshot.counters[condition.key] ?? 0) >= condition.value;
      case "counter.lte":
        return (snapshot.counters[condition.key] ?? 0) <= condition.value;
      case "event.exists":
        return snapshot.committedEvents.includes(condition.eventId);
      case "all":
        return condition.of.every(function (nested) { return evalCondition(nested, snapshot); });
      default:
        return false;
    }
  }

  function evalEdgePreconditions(edge, snapshot) {
    var conditions = edge.preconditions;
    if (!conditions || !Array.isArray(conditions)) return true;
    if (conditions.length > 8) return false;
    return conditions.every(function (c) { return evalCondition(c, snapshot); });
  }

  function evalEdgeEffects(edge, snapshot) {
    var effects = edge.effects;
    if (!effects || !Array.isArray(effects)) return [];
    if (effects.length > 4) return [];
    return effects.filter(function (e) {
      return e.op === "flag.set" || e.op === "counter.add" ||
             e.op === "event.append" || e.op === "cursor.advance";
    });
  }

  function evaluate(graph, snapshot, proposal) {
    var diagnostics = [];
    var edge = graph.edges.find(function (e) { return e.id === proposal.edgeId; });
    if (!edge) {
      diagnostics.push("edge " + proposal.edgeId + " not found in graph");
      return { accepted: false, diagnostics: diagnostics, evaluatedAtVersion: snapshot.stateVersion, effects: [], newCursor: snapshot.cursor };
    }
    if (edge.from !== snapshot.cursor) {
      diagnostics.push("edge " + proposal.edgeId + " starts at " + edge.from + " but cursor is " + snapshot.cursor);
      return { accepted: false, diagnostics: diagnostics, evaluatedAtVersion: snapshot.stateVersion, effects: [], newCursor: snapshot.cursor };
    }
    if (!evalEdgePreconditions(edge, snapshot)) {
      diagnostics.push("edge " + proposal.edgeId + " preconditions not satisfied at current snapshot");
      return { accepted: false, diagnostics: diagnostics, evaluatedAtVersion: snapshot.stateVersion, effects: [], newCursor: snapshot.cursor };
    }
    var effects = evalEdgeEffects(edge, snapshot);
    if (effects.length === 0 && edge.effects.length > 0) {
      diagnostics.push("edge " + proposal.edgeId + " effects contain unknown ops; nothing will be applied");
      return { accepted: false, diagnostics: diagnostics, evaluatedAtVersion: snapshot.stateVersion, effects: [], newCursor: snapshot.cursor };
    }
    return { accepted: true, diagnostics: [], evaluatedAtVersion: snapshot.stateVersion, effects: effects, newCursor: edge.to };
  }

  function eligibleEdges(graph, snapshot) {
    return graph.edges
      .filter(function (e) { return e.from === snapshot.cursor && evalEdgePreconditions(e, snapshot); })
      .map(function (e) { return { edgeId: e.id, to: e.to }; });
  }

  function invoke(entry, argsJson) {
    var args = JSON.parse(argsJson);
    if (entry === "evaluate") {
      var decision = evaluate(args.graph, args.snapshot, args.proposal);
      decision.evaluationNonce = args.evaluationNonce;
      return JSON.stringify(decision);
    }
    if (entry === "eligibleEdges") {
      // graph/snapshot 由宿主以 JSON 对象传入（与 evaluate 同形状），不再二次 parse。
      var edges = eligibleEdges(args.graph, args.snapshot);
      return JSON.stringify({ edges: edges, evaluationNonce: args.evaluationNonce });
    }
    return JSON.stringify({ error: "unknown narrative entry " + entry });
  }

  return { invoke: invoke, evaluate: evaluate, eligibleEdges: eligibleEdges };
})();
