import test from "node:test";
import assert from "node:assert/strict";
import { canAcceptCandidate, candidateEvidenceTrust, parseProjectCandidate } from "../src/contracts/candidate.ts";

const tested = {
  artifactKind: "candidate", candidateId: "release-candidate", projectId: "project-1", revision: 3,
  contentDigest: `sha256:${"a".repeat(64)}`, status: "tested", createdAtMs: 10, acceptedReleaseId: null,
  latestRun: { runId: "playtest-1", status: "completed", createdAtMs: 11, finishedAtMs: 12,
    evidenceSource: "city-client-reported", evidence: { tick: 20, outcome: "success", snapshotDigest: `sha256:${"a".repeat(64)}` }, failureCode: null },
};

test("candidate acceptance requires real completed client-reported evidence", () => {
  const candidate = parseProjectCandidate(tested)!;
  assert.equal(canAcceptCandidate(candidate), true);
  assert.equal(candidateEvidenceTrust(candidate), "City 客户端回报（非 Host 验证）");
  assert.equal(canAcceptCandidate(parseProjectCandidate({ ...tested, status: "created", latestRun: null })), false);
  assert.equal(canAcceptCandidate(parseProjectCandidate({ ...tested, status: "testing", latestRun: { ...tested.latestRun, status: "claimed", evidenceSource: null, evidence: null } })), false);
  assert.equal(canAcceptCandidate(parseProjectCandidate({ ...tested, latestRun: { ...tested.latestRun, evidenceSource: "host-verified" } })), false);
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
