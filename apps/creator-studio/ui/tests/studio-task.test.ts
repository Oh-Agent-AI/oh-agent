import test from "node:test";
import assert from "node:assert/strict";
import {
  canApproveTaskPlan, canCancelTask, canExecuteTask, canReviewTask, canReviseTaskPlan, defaultStudioPlanSteps,
  isDefaultStudioPlan, mergeStudioEvents, parseStudioCapabilityStatus, parseStudioConnections, parseStudioEventBatch, parseStudioTask, studioPhaseLabel, studioTaskScopeId,
} from "../src/contracts/studioTask.ts";
import { taskHasSceneObjectPreview } from "../src/features/agent/taskCommit.ts";

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

test("City and story artifacts keep their scope id through the parse", () => {  const city = parseStudioTask({ ...task, artifact: { kind: "creator-city", cityId: "city-1", expectedRevision: 0 } });
  assert.equal(city.artifact.kind, "creator-city");
  assert.equal(city.artifact.cityId, "city-1");
  assert.equal(studioTaskScopeId(city), "city-1");
  const story = parseStudioTask({ ...task, artifact: { kind: "creator-story", storyId: "story-1", expectedRevision: 2 } });
  assert.equal(story.artifact.kind, "creator-story");
  assert.equal(story.artifact.storyId, "story-1");
  assert.equal(studioTaskScopeId(story), "story-1");
  assert.throws(() => parseStudioTask({ ...task, artifact: { kind: "creator-story", storyId: "story-1", expectedRevision: 2, extra: true } }), /creator_task_invalid/);
});

test("Default plan is reviewable without an executor", () => {
  const steps = defaultStudioPlanSteps();
  assert.equal(steps.length, 3);
  assert.equal(steps[0]?.kind, "analysis");
  assert.equal(steps[1]?.kind, "validation");
  assert.equal(steps[2]?.kind, "review");
});

test("Plan gate only stops for plans that carry information", () => {
  const defaults = defaultStudioPlanSteps();
  const defaultTask = parseStudioTask({ ...task, steps: defaults, stepIds: defaults.map(step => step.stepId) });
  assert.equal(isDefaultStudioPlan(defaultTask), true, "constant template plans are auto-approved by the fast path");
  const proposed = parseStudioTask({ ...task, steps: [...defaults, { stepId: "add-tree", ordinal: 3, title: "在场景中添加一棵树", kind: "change" as const }], stepIds: [...defaults.map(step => step.stepId), "add-tree"] });
  assert.equal(isDefaultStudioPlan(proposed), false, "agent-proposed steps must stop at the approval gate");
  const reordered = parseStudioTask({ ...task, steps: [...defaults].reverse(), stepIds: [...defaults].reverse().map(step => step.stepId) });
  assert.equal(isDefaultStudioPlan(reordered), false, "order is part of the plan");
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

test("Executor probe contract matches the real host response shape", () => {
  // fixture 逐字段对齐 Rust probe_executors 的输出（数组 + 协议/登录/模式分列），
  // 宿主 capabilities.status 把它挂在顶层 executors 键上。
  const value = {
    studioOnline: true,
    executors: [
      { id: "codex", name: "Codex CLI", available: true,
        modes: [{ id: "full-access", restricted: false, label: "完全访问" }],
        detail: "exec 单发无审批处理者；写闸在宿主 MCP 只读 + 确认保存。受限执行待 app-server 适配（上线阻塞项）。" },
      { id: "acp:claude-code", name: "Claude Code (ACP)", available: true, protocolReachable: true, needsLogin: false,
        modes: [{ id: "plan", restricted: true, label: "Plan Mode", current: false },
                { id: "bypassPermissions", restricted: false, label: "Bypass" }],
        creatorToolsVerified: false, detail: "会话能力来自 agent 实测" },
      { id: "acp:zcode", name: "ZCode CLI (ACP)", available: false, protocolReachable: false, needsLogin: true,
        modes: [], creatorToolsVerified: false, detail: "agent 需要先完成自身登录" },
    ],
    connections: [], capabilities: [],
  };
  const status = parseStudioCapabilityStatus(value);
  assert.equal(status.executors.length, 3);
  const codex = status.executors.find(item => item.id === "codex");
  assert.equal(codex?.available, true);
  assert.equal(codex?.modes.every(mode => !mode.restricted), true, "codex exec 只有完全访问形态");
  const claude = status.executors.find(item => item.id === "acp:claude-code");
  assert.equal(claude?.modes.find(mode => mode.id === "plan")?.restricted, true, "plan 档标为受限");
  const zcode = status.executors.find(item => item.id === "acp:zcode");
  assert.equal(zcode?.available, false);
  assert.equal(zcode?.detail, "agent 需要先完成自身登录");
  // 旧宿主（无 executors 键）回退为空，不崩。
  assert.equal(parseStudioCapabilityStatus({ studioOnline: true, connections: [], capabilities: [] }).executors.length, 0);
});


test("scene save gate remains required for the current Host preview only", () => {
  const preview = {
    evidenceId: "evidence-preview", planRevision: 1, stepId: "change", criterionId: "agent-preview", kind: "preview",
    trustLevel: "host-observed", summary: "Host preview", createdAtMs: 20,
    data: { previewId: "preview-1", changedObjects: [{ id: "taxi", kind: "sceneObject", action: "updated" }] },
  };
  const checked = parseStudioTask({ ...task, proposedChangeSetId: "preview-1", evidence: [preview] });
  assert.equal(taskHasSceneObjectPreview(checked), true);
  assert.equal(taskHasSceneObjectPreview(parseStudioTask({ ...task, phase: "accepted", proposedChangeSetId: "preview-1", evidence: [preview] })), false);
  assert.equal(taskHasSceneObjectPreview(parseStudioTask({ ...task, proposedChangeSetId: "preview-2", evidence: [preview] })), false);
  assert.equal(taskHasSceneObjectPreview(parseStudioTask({ ...task, proposedChangeSetId: "preview-1",
    evidence: [{ ...preview, data: { ...preview.data, changedObjects: [{ id: "game", kind: "game" }] } }] })), false);
});


test("task human requests accept the Host 4000-character context contract", () => {
  const humanRequest = `修改对象 Preview entity context: ${JSON.stringify({ previewEntity: { entityId: "decor:site:civic", pose: "x".repeat(600) } })}`;
  assert.equal(parseStudioTask({ ...task, humanRequest }).humanRequest, humanRequest);
  assert.throws(() => parseStudioTask({ ...task, humanRequest: "x".repeat(4_001) }), /creator_task_invalid/);
});
