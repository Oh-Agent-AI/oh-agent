import test from "node:test";
import assert from "node:assert/strict";
import {
  canApproveTaskPlan, canCancelTask, canExecuteTask, canReviewTask, canReviseTaskPlan, defaultStudioPlanSteps,
  mergeStudioEvents, parseStudioCapabilityStatus, parseStudioConnections, parseStudioEventBatch, parseStudioTask, studioPhaseLabel,
} from "../src/contracts/studioTask.ts";

const task = {
  taskId: "studio-task-1", sessionId: "session-1", goalId: "goal-1", goalRevision: 2, humanRequest: "Validate the saved game",
  artifact: { kind: "creator-project", projectId: "project-1", expectedRevision: 3 }, planRevision: 1, stepIds: ["human-review"], phase: "awaiting-review",
  proposedChangeSetId: null, lastEvidenceId: "evidence-1",
  steps: [{ stepId: "human-review", ordinal: 2, title: "Human review", kind: "review" }],
  evidence: [{ evidenceId: "evidence-1", planRevision: 1, stepId: "human-review", criterionId: "manual-review", kind: "human-note",
    trustLevel: "creator-declared", summary: "Reviewed manually", data: null, createdAtMs: 10 }],
};

test("Studio task projection restores goal plan steps and evidence", () => {
  const checked = parseStudioTask(task);
  assert.equal(checked.artifact.expectedRevision, 3);
  assert.equal(checked.steps[0]?.kind, "review");
  assert.equal(checked.evidence[0]?.trustLevel, "creator-declared");
  assert.equal(canReviewTask(checked), true);
  assert.equal(canExecuteTask(checked), false);
  assert.equal(canExecuteTask(parseStudioTask({ ...task, phase: "ready" })), true);
  assert.equal(canApproveTaskPlan(checked), false);
  assert.equal(canReviseTaskPlan(checked), true);
  assert.equal(canCancelTask(checked), true);
  assert.equal(studioPhaseLabel(checked.phase), "等待人工验收");
});

test("Task phase gates fail closed on unknown or terminal states", () => {
  assert.equal(parseStudioTask({ ...task, phase: "future-phase" }).phase, "unknown");
  assert.equal(canCancelTask(parseStudioTask({ ...task, phase: "accepted" })), false);
  assert.equal(canReviseTaskPlan(parseStudioTask({ ...task, phase: "accepted" })), false);
  assert.equal(canReviewTask(parseStudioTask({ ...task, phase: "ready" })), false);
  assert.throws(() => parseStudioTask({ ...task, artifact: { kind: "release", projectId: "project-1", expectedRevision: 3 } }), /creator_task_invalid/);
});

test("Default plan is reviewable without an executor", () => {
  const steps = defaultStudioPlanSteps();
  assert.equal(steps.length, 3);
  assert.equal(steps[0]?.kind, "analysis");
  assert.equal(steps[1]?.kind, "validation");
  assert.equal(steps[2]?.kind, "review");
});

test("Realtime event batches resume by eventId and merge without duplicates", () => {
  const first = parseStudioEventBatch({
    taskId: "studio-task-1", nextAfterEventId: 8, hasMore: true, waitTimedOut: false,
    events: [{ eventId: 8, taskId: "studio-task-1", seq: 3, kind: "progress", source: "acp", trustLevel: "agent-reported", summary: "ACP 已返回消息片段", data: { chunkCount: 1 }, createdAtMs: 20 }],
  });
  const resumed = parseStudioEventBatch({
    taskId: "studio-task-1", nextAfterEventId: 9, hasMore: false, waitTimedOut: false,
    events: [
      { eventId: 8, taskId: "studio-task-1", seq: 3, kind: "progress", source: "acp", trustLevel: "agent-reported", summary: "重复传输", data: null, createdAtMs: 20 },
      { eventId: 9, taskId: "studio-task-1", seq: 4, kind: "preview", source: "host", trustLevel: "host-observed", summary: "Host Preview 已签发", data: { previewId: "preview-1" }, createdAtMs: 21 },
    ],
  });
  const merged = mergeStudioEvents(first.events, resumed.events);
  assert.equal(first.nextAfterEventId, 8);
  assert.equal(resumed.nextAfterEventId, 9);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(event => event.eventId), [8, 9]);
  assert.equal(merged[0]?.summary, "ACP 已返回消息片段");
  assert.equal(parseStudioEventBatch({ taskId: "studio-task-1", events: [], nextAfterEventId: 9, hasMore: false, waitTimedOut: true }).waitTimedOut, true);
  assert.throws(() => parseStudioEventBatch({ taskId: "studio-task-1", events: [], nextAfterEventId: -1, hasMore: false, waitTimedOut: false }), /creator_event_invalid/);
});

test("Connection and capability projections expose TTL state and Studio-only boundaries", () => {
  const value = {
    studioOnline: true,
    connections: [{ agentId: "agent-a", sessionId: "session-a", executor: "acp", transport: "acp-stdio", state: "busy", lastSeenMs: 10, expiresAtMs: 15010, capabilities: ["task.pull"], lastStableError: null }],
    capabilities: [
      { id: "task.pull", headless: true, requiresStudioWebView: false, note: "pull 可 headless" },
      { id: "preview.scene", headless: false, requiresStudioWebView: true, note: "需要 Studio" },
    ],
  };
  const status = parseStudioCapabilityStatus(value);
  assert.equal(status.studioOnline, true);
  assert.equal(status.connections[0]?.state, "busy");
  assert.equal(status.capabilities.find(item => item.id === "preview.scene")?.headless, false);
  assert.equal(parseStudioConnections(value)[0]?.expiresAtMs, 15010);
  const expired = parseStudioConnections({ connections: [{ ...value.connections[0], state: "offline" }] });
  assert.equal(expired[0]?.state, "offline");
});
