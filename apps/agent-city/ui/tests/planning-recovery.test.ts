import test from "node:test";
import assert from "node:assert/strict";
import { canReplayUnstartedPlanningWorker } from "../src/engine/planningRecovery.ts";
import type { PlanningJobResult } from "../src/engine/planningWorker/planningJob.ts";

const unstarted = (status: "failed" | "unsupported", reason: string): PlanningJobResult => ({ status, reason });

test("replays only a planning worker that never started", () => {
  assert.equal(canReplayUnstartedPlanningWorker(unstarted("unsupported", "planning-worker-unavailable")), true);
  assert.equal(canReplayUnstartedPlanningWorker(unstarted("failed", "planning-worker-failed")), true);
  assert.equal(canReplayUnstartedPlanningWorker(unstarted("failed", "planning-worker-post-failed")), true);
  assert.equal(canReplayUnstartedPlanningWorker(unstarted("failed", "planning-worker-message-failed")), true);
});

test("does not replay timeouts, cancellation, or a worker that already reported work", () => {
  assert.equal(canReplayUnstartedPlanningWorker(unstarted("failed", "planning-worker-timeout")), false);
  assert.equal(canReplayUnstartedPlanningWorker(unstarted("failed", "planning-outcome-failed")), false);
  assert.equal(canReplayUnstartedPlanningWorker(unstarted("failed", "invalid-planning-parameters")), false);
  assert.equal(canReplayUnstartedPlanningWorker({ status: "cancelled", reason: "cancelled-before-start" }), false);
  assert.equal(canReplayUnstartedPlanningWorker({ status: "computed", plan: {} as never, requestKey: "k" }), false);
  const checkpoint = { limits: {}, consumed: {} } as PlanningJobResult & { status: "failed" };
  assert.equal(canReplayUnstartedPlanningWorker({
    status: "failed", reason: "planning-worker-failed", lastCheckpoint: checkpoint as never,
  }), false);
  assert.equal(canReplayUnstartedPlanningWorker({
    status: "failed", reason: "planning-worker-timeout", workBudget: checkpoint as never,
  }), false);
});
