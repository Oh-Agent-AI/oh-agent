/**
 * 纯 TS 求值器（OH_AGENT_NARRATIVE_ENGINE_SPEC §4 可执行子集）。
 *
 * 相同快照 + 规则版本 + 提案 → 相同裁决（确定性）。
 * 不依赖宿主 / DB / 网络 / 时钟；所有事实由 Snapshot 显式提供。
 * 未识别条件 / 效果 / 伪造事实 fail-closed。
 */
import type {
  ActorProposalV1, NarrativeConditionV1, NarrativeDecisionV1,
  NarrativeEffectV1, NarrativeSnapshotV1,
} from "../contracts/engine";
import { NARRATIVE_MAX_CONDITIONS, NARRATIVE_MAX_EFFECTS } from "../contracts/engine";
import type { StoryEdgeV2, StoryGraphV1 } from "../graph/types";

/** 单个条件的确定性求值。未知 op 返回 false（fail-closed：条件不满足）。 */
function evalCondition(condition: NarrativeConditionV1, snapshot: NarrativeSnapshotV1, depth = 0): boolean {
  if (!condition || typeof condition !== "object" || depth > NARRATIVE_MAX_CONDITIONS) return false;
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
      return Array.isArray(condition.of) && condition.of.every(nested => evalCondition(nested, snapshot, depth + 1));
    default:
      return false;
  }
}

function conditionCount(condition: NarrativeConditionV1): number {
  let count = 0;
  const pending = [condition];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!current || typeof current !== "object") return NARRATIVE_MAX_CONDITIONS + 1;
    count += 1;
    if (count > NARRATIVE_MAX_CONDITIONS) return count;
    if (current.op === "all") {
      if (!Array.isArray(current.of)) return NARRATIVE_MAX_CONDITIONS + 1;
      pending.push(...current.of);
    }
  }
  return count;
}

/** 求值一条边的所有前置条件。空对象与空 conditions 恒通过。 */
function evalEdgePreconditions(edge: StoryEdgeV2, snapshot: NarrativeSnapshotV1): boolean {
  const conditions = edge.preconditions as unknown as NarrativeConditionV1 | NarrativeConditionV1[] | undefined;
  if (!conditions || (typeof conditions === "object" && !Array.isArray(conditions) && Object.keys(conditions).length === 0)) return true;
  const list = Array.isArray(conditions) ? conditions : [conditions];
  if (list.length > NARRATIVE_MAX_CONDITIONS || list.reduce((count, condition) => count + conditionCount(condition), 0) > NARRATIVE_MAX_CONDITIONS) return false;
  return list.every(condition => evalCondition(condition, snapshot));
}

/** 求值一条边的效果列表。未知 op 返回空列表（fail-closed：不产效果）。 */
function evalEdgeEffects(edge: StoryEdgeV2, snapshot: NarrativeSnapshotV1): NarrativeEffectV1[] {
  const effects = edge.effects as unknown as NarrativeEffectV1[] | undefined;
  if (!effects || !Array.isArray(effects)) return [];
  if (effects.length > NARRATIVE_MAX_EFFECTS) return [];
  return effects.filter(effect => {
    switch (effect.op) {
      case "flag.set": case "counter.add": case "event.append": case "cursor.advance":
        return true;
      default:
        return false;
    }
  });
}

/**
 * 核心求值入口：Agent 提交一条提案，宿主在当前快照下裁决。
 *
 * 判定顺序：
 * 1. 快照游标必须等于提案边的 from 节点（Agent 不能跳节点）。
 * 2. 边必须在图中存在（防伪造 edgeId）。
 * 3. 前置条件全部满足。
 * 4. 效果子集合法。
 *
 * 任何一步不满足 → accepted:false + 诊断。全部满足 → accepted:true + 效果列表。
 */
export function evaluateProposal(
  graph: StoryGraphV1,
  snapshot: NarrativeSnapshotV1,
  proposal: ActorProposalV1,
): NarrativeDecisionV1 {
  const diagnostics: string[] = [];
  const edge = graph.edges.find(e => e.id === proposal.edgeId);

  if (!edge) {
    diagnostics.push(`edge ${proposal.edgeId} not found in graph`);
    return { accepted: false, diagnostics, evaluatedAtVersion: snapshot.stateVersion, effects: [], newCursor: snapshot.cursor };
  }
  if (edge.from !== snapshot.cursor) {
    diagnostics.push(`edge ${proposal.edgeId} starts at ${edge.from} but cursor is ${snapshot.cursor}`);
    return { accepted: false, diagnostics, evaluatedAtVersion: snapshot.stateVersion, effects: [], newCursor: snapshot.cursor };
  }
  if (!evalEdgePreconditions(edge, snapshot)) {
    diagnostics.push(`edge ${proposal.edgeId} preconditions not satisfied at current snapshot`);
    return { accepted: false, diagnostics, evaluatedAtVersion: snapshot.stateVersion, effects: [], newCursor: snapshot.cursor };
  }
  const effects = evalEdgeEffects(edge, snapshot);
  if (effects.length === 0 && (edge.effects as unknown as NarrativeEffectV1[] | undefined)?.length) {
    diagnostics.push(`edge ${proposal.edgeId} effects contain unknown ops; nothing will be applied`);
    return { accepted: false, diagnostics, evaluatedAtVersion: snapshot.stateVersion, effects: [], newCursor: snapshot.cursor };
  }

  return {
    accepted: true,
    diagnostics: [],
    evaluatedAtVersion: snapshot.stateVersion,
    effects,
    newCursor: edge.to,
  };
}

/** 对给定图的指定节点计算 eligibleBeats 菜单（替代旧版硬编码邀请规则）。 */
export function eligibleEdges(
  graph: StoryGraphV1, snapshot: NarrativeSnapshotV1,
): { edgeId: string; to: string }[] {
  return graph.edges
    .filter(e => e.from === snapshot.cursor && evalEdgePreconditions(e, snapshot))
    .map(e => ({ edgeId: e.id, to: e.to }));
}
