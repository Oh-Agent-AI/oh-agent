import test from "node:test";
import assert from "node:assert/strict";
import { AgentApprovalGate, matchesPreviewBase } from "../src/agentApproval.ts";

test("preview baseline is tied to the live seed and road revision and fails closed", () => {
  const live = { currentSeed: 42, getCitySdkLayoutView: () => ({ worldRevision: "road-v1" }) };
  assert.equal(matchesPreviewBase(live, 42, "road-v1"), true);
  assert.equal(matchesPreviewBase(live, 43, "road-v1"), false);
  assert.equal(matchesPreviewBase(live, 42, "road-v2"), false);
  assert.equal(matchesPreviewBase(null, 42, "road-v1"), false);
  assert.equal(matchesPreviewBase({ currentSeed: 42, getCitySdkLayoutView: () => { throw new Error("unavailable"); } }, 42, "road-v1"), false);
});

test("Agent commits require an unexpired preview bound to the same project and revision", () => {
  const gate = new AgentApprovalGate();
  const payload = { projectId: "project-a", previewId: "preview-a", expectedRevision: 3, operationId: "op-a" };
  assert.throws(() => gate.request("creator.project.commit", payload, 10), /preview_unavailable/);
  gate.remember({ projectId: "project-a", previewId: "preview-a", revision: 3, kind: "scene", summary: "scene", details: [], changes: "[]", expiresAt: 100 }, 10);
  assert.throws(() => gate.request("creator.project.commit", { ...payload, projectId: "project-b" }, 10), /scope_mismatch/);
  assert.throws(() => gate.request("creator.project.commit", { ...payload, expectedRevision: 4 }, 10), /scope_mismatch/);
  assert.throws(() => gate.request("creator.game.commit", payload, 10), /scope_mismatch/);
  const pending = gate.request("creator.project.commit", payload, 10);
  assert.equal(gate.isPending("project-a", "op-a", 11), true);
  assert.equal(gate.isPending("project-b", "op-a", 11), false);
  assert.equal(gate.request("creator.project.commit", payload, 11), pending);
  assert.throws(() => gate.request("creator.project.commit", { ...payload, operationId: "op-b" }, 11), /approval_busy/);
  gate.clear(pending);
  assert.equal(gate.isPending("project-a", "op-a", 12), false);
  assert.throws(() => gate.request("creator.project.commit", payload, 12), /preview_unavailable/);
  gate.remember({ projectId: "project-a", previewId: "preview-a", revision: 3, kind: "scene", summary: "scene", details: [], changes: "[]", expiresAt: 100 }, 10);
  gate.request("creator.project.commit", payload, 20);
  assert.equal(gate.isPending("project-a", "op-a", 100), false);
  assert.throws(() => gate.request("creator.project.commit", payload, 100), /preview_unavailable/);
});
