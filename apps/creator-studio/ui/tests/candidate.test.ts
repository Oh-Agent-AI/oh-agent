import test from "node:test";
import assert from "node:assert/strict";
import { canAcceptCandidate, candidateEvidenceTrust, parseProjectCandidate } from "../src/contracts/candidate.ts";
import { workspaceNextStep } from "../src/features/preview/workspaceNextStep.ts";

const tested = {
  artifactKind: "candidate", candidateId: "release-candidate", projectId: "project-1", revision: 3,
  contentDigest: `sha256:${"a".repeat(64)}`, status: "tested", createdAtMs: 10, acceptedReleaseId: null,
  latestRun: { runId: "playtest-1", status: "completed", createdAtMs: 11, finishedAtMs: 12,
    evidenceSource: "city-client-reported", evidence: { tick: 20, outcome: "success", snapshotDigest: `sha256:${"a".repeat(64)}` }, failureCode: null },
};

test("candidate acceptance requires completed evidence with a recognized trust level", () => {
  const candidate = parseProjectCandidate(tested)!;
  assert.equal(canAcceptCandidate(candidate), true);
  assert.equal(candidateEvidenceTrust(candidate), "City 客户端回报（非 Host 验证）");
  assert.equal(canAcceptCandidate(parseProjectCandidate({ ...tested, status: "created", latestRun: null })), false);
  assert.equal(canAcceptCandidate(parseProjectCandidate({ ...tested, status: "testing", latestRun: { ...tested.latestRun, status: "claimed", evidenceSource: null, evidence: null } })), false);
  assert.equal(canAcceptCandidate(parseProjectCandidate({ ...tested, latestRun: { ...tested.latestRun, evidenceSource: "host-verified" } })), true);
  assert.equal(canAcceptCandidate(parseProjectCandidate({ ...tested, latestRun: { ...tested.latestRun, evidence: { outcome: "failure", snapshotDigest: `sha256:${"a".repeat(64)}` } } })), false);
  assert.equal(canAcceptCandidate(parseProjectCandidate({ ...tested, latestRun: { ...tested.latestRun, evidence: { outcome: "success", snapshotDigest: `sha256:${"b".repeat(64)}` } } })), false);
  assert.equal(canAcceptCandidate(parseProjectCandidate({ ...tested, status: "accepted", acceptedReleaseId: "release-formal" })), false);
});

test("candidate parsing is bounded and fails closed on malformed artifacts", () => {
  assert.equal(parseProjectCandidate(null), null);
  assert.equal(parseProjectCandidate({ ...tested, status: "future-status" })?.status, "unknown");
  assert.equal(canAcceptCandidate(parseProjectCandidate({ ...tested, status: "future-status" })), false);
  assert.throws(() => parseProjectCandidate({ ...tested, artifactKind: "release" }), /creator_candidate_invalid/);
  assert.throws(() => parseProjectCandidate({ ...tested, contentDigest: "not-a-digest" }), /creator_candidate_invalid/);
});

test("workspace next step respects draft, read-only, browser and evidence gates", () => {
  const context = { readOnly: false, hasProject: true, hasLayout: true, dirty: false, hasMounts: true, browserPreview: false,
    candidateRead: "ready" as const, published: false, candidate: null };
  assert.equal(workspaceNextStep(context).action, "create");
  assert.equal(workspaceNextStep({ ...context, hasMounts: false }).action, "mount");
  assert.equal(workspaceNextStep({ ...context, dirty: true }).action, "draft");
  assert.equal(workspaceNextStep({ ...context, candidateRead: "unavailable" }).action, "refresh");
  assert.equal(workspaceNextStep({ ...context, published: true }).action, "release");
  assert.equal(workspaceNextStep({ ...context, readOnly: true, published: true }).action, undefined);
  assert.equal(workspaceNextStep({ ...context, browserPreview: true, published: true }).action, "details");
  assert.equal(workspaceNextStep({ ...context, candidate: parseProjectCandidate({ ...tested, status: "created" }) }).action, "test");
  assert.equal(workspaceNextStep({ ...context, candidate: parseProjectCandidate(tested) }).status, "试玩完成 · 待复核");
  assert.equal(workspaceNextStep({ ...context, candidate: parseProjectCandidate({ ...tested, latestRun: null }) }).status, "已有试玩结果");
});
