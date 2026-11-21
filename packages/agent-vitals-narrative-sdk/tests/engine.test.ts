import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateProposal, eligibleEdges,
  type ActorProposalV1, type NarrativeSnapshotV1,
  type StoryEdgeV2, type StoryGraphV1, type StoryNodeV1,
} from "../src/index";

// ── 咖啡馆 Story 包（OH_AGENT_NARRATIVE_ENGINE_SPEC §1 垂直切片）────────
// 玩家邀请 NPC 去咖啡馆：需要好感度 ≥1（前置条件），效果是好感度 +1、
// 布尔标记 date_planned=true、追加剧情事件、游标推进到 node_cafe_reply。

const node = (id: string): StoryNodeV1 => ({ id, kind: "beat" });

const EDGE_INVITE: StoryEdgeV2 = {
  id: "e-invite", from: "start", to: "cafe_reply",
  preconditions: [{ op: "counter.gte", key: "affection", value: 1 }],
  effects: [
    { op: "counter.add", key: "affection", value: 1 },
    { op: "flag.set", key: "date_planned", value: true },
    { op: "event.append", eventId: "evt-invite-1", ruleId: "cafe-invite" },
    { op: "cursor.advance", to: "cafe_reply" },
  ],
  eventDependencies: [],
  scope: "test",
};

const EDGE_REJECT: StoryEdgeV2 = {
  id: "e-reject", from: "start", to: "cafe_reject",
  preconditions: [{ op: "counter.lte", key: "affection", value: 0 }],
  effects: [{ op: "event.append", eventId: "evt-reject-1", ruleId: "cafe-reject" }],
  eventDependencies: [],
  scope: "test",
};

const CAFE_GRAPH: StoryGraphV1 = {
  start: "start",
  nodes: [node("start"), node("cafe_reply"), node("cafe_reject")],
  edges: [EDGE_INVITE, EDGE_REJECT],
};

const makeSnapshot = (overrides?: Partial<NarrativeSnapshotV1>): NarrativeSnapshotV1 => ({
  scope: { playerId: "player-1", cityId: "city-1", storyId: "story.detective", storyRunId: "run-1" },
  contentDigest: "sha256:cafe",
  stateVersion: "v1",
  cursor: "start",
  committedEvents: [],
  flags: {},
  counters: { affection: 1 },
  clockTick: 42,
  ...overrides,
});

const makeProposal = (edgeId: string): ActorProposalV1 => ({
  turnId: "turn-1", operationId: "op-1", edgeId, dialogue: "去咖啡馆吧？",
});

// ── 确定性：相同输入 → 相同裁决 ─────────────────────────────────────────

test("same snapshot and proposal always produce the same decision", () => {
  const snap = makeSnapshot();
  const prop = makeProposal("e-invite");
  const a = evaluateProposal(CAFE_GRAPH, snap, prop);
  const b = evaluateProposal(CAFE_GRAPH, snap, prop);
  assert.deepStrictEqual(a, b);
});

// ── 通过路径：好感度 ≥1 → 邀请成功 ──────────────────────────────────────

test("proposal accepted when affection >= 1, effects carried", () => {
  const decision = evaluateProposal(CAFE_GRAPH, makeSnapshot(), makeProposal("e-invite"));
  assert.equal(decision.accepted, true);
  assert.equal(decision.newCursor, "cafe_reply");
  assert.equal(decision.evaluatedAtVersion, "v1");
  const ops = decision.effects.map(e => e.op);
  assert.ok(ops.includes("counter.add"));
  assert.ok(ops.includes("flag.set"));
  assert.ok(ops.includes("event.append"));
  assert.ok(ops.includes("cursor.advance"));
});

// ── 拒绝路径：好感度 0 → 拒绝边可用，邀请边不可 ────────────────────────

test("proposal rejected when affection is 0", () => {
  const snap = makeSnapshot({ counters: { affection: 0 } });
  const decision = evaluateProposal(CAFE_GRAPH, snap, makeProposal("e-invite"));
  assert.equal(decision.accepted, false);
  assert.ok(decision.diagnostics.some(d => d.includes("preconditions not satisfied")));
  // 拒绝边可用
  const reject = evaluateProposal(CAFE_GRAPH, snap, makeProposal("e-reject"));
  assert.equal(reject.accepted, true);
  assert.equal(reject.newCursor, "cafe_reject");
});

// ── 条件缺失 fail-closed ────────────────────────────────────────────────

test("unknown condition op fails closed", () => {
  const edge: StoryEdgeV2 = {
    ...EDGE_INVITE,
    preconditions: [{ op: "quantum.flip", key: "x" } as never],
  };
  const graph: StoryGraphV1 = { ...CAFE_GRAPH, edges: [edge] };
  const decision = evaluateProposal(graph, makeSnapshot(), makeProposal("e-invite"));
  assert.equal(decision.accepted, false);
});

// ── 未知效果 fail-closed ────────────────────────────────────────────────

test("unknown effect op fails closed", () => {
  const edge: StoryEdgeV2 = {
    ...EDGE_INVITE,
    effects: [{ op: "teleport.resident" } as never],
  };
  const graph: StoryGraphV1 = { ...CAFE_GRAPH, edges: [edge] };
  const decision = evaluateProposal(graph, makeSnapshot(), makeProposal("e-invite"));
  assert.equal(decision.accepted, false);
  assert.ok(decision.diagnostics.some(d => d.includes("unknown ops")));
});

// ── 伪造事实：声称事件已存在但快照中无 → 前置不满足 ────────────────────

test("agent claiming an event exists without committed evidence fails", () => {
  const edge: StoryEdgeV2 = {
    ...EDGE_INVITE,
    preconditions: [{ op: "event.exists", eventId: "evt-date-done" }],
  };
  const graph: StoryGraphV1 = { ...CAFE_GRAPH, edges: [edge] };
  const decision = evaluateProposal(graph, makeSnapshot(), makeProposal("e-invite"));
  assert.equal(decision.accepted, false);
});

// ── 游标不匹配：Agent 不能跳节点 ───────────────────────────────────────

test("proposal from wrong cursor is rejected", () => {
  const snap = makeSnapshot({ cursor: "cafe_reply" });
  const decision = evaluateProposal(CAFE_GRAPH, snap, makeProposal("e-invite"));
  assert.equal(decision.accepted, false);
  assert.ok(decision.diagnostics.some(d => d.includes("cursor")));
});

// ── 伪造 edgeId 拒绝 ────────────────────────────────────────────────────

test("proposal with fabricated edgeId is rejected", () => {
  const decision = evaluateProposal(CAFE_GRAPH, makeSnapshot(), makeProposal("e-fake"));
  assert.equal(decision.accepted, false);
});

// ── eligibleEdges 菜单 ──────────────────────────────────────────────────

test("eligibleEdges reflects current snapshot", () => {
  const aff1 = eligibleEdges(CAFE_GRAPH, makeSnapshot());
  assert.ok(aff1.some(e => e.edgeId === "e-invite"));
  const aff0 = eligibleEdges(CAFE_GRAPH, makeSnapshot({ counters: { affection: 0 } }));
  assert.ok(aff0.some(e => e.edgeId === "e-reject"));
  assert.ok(!aff0.some(e => e.edgeId === "e-invite"));
});

// ── 状态版本绑定：旧裁决在新版本下拒绝 ─────────────────────────────────

test("decision carries evaluatedAtVersion for CAS check", () => {
  const snap = makeSnapshot({ stateVersion: "v7" });
  const decision = evaluateProposal(CAFE_GRAPH, snap, makeProposal("e-invite"));
  assert.equal(decision.evaluatedAtVersion, "v7");
});
