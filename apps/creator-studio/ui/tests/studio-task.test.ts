import test from "node:test";
import assert from "node:assert/strict";
import { canApproveTaskPlan, canCancelTask, canExecuteTask, canReviewTask, canReviseTaskPlan, defaultStudioPlanSteps, parseStudioTask, studioPhaseLabel } from "../src/contracts/studioTask.ts";

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
