import test from "node:test";
import assert from "node:assert/strict";
import { parseCityDiagnostics, parseCodeTestRecord, parseGroundInspection, parsePlaytestHistory, traceSummary } from "../src/features/evidence/evidenceCenterModel.ts";

test("Run evidence preserves Host verification, disagreement and trace bounds", () => {
  const runs = parsePlaytestHistory({ runs: [{ runId: "run-1", releaseId: "candidate-1", revision: 3, status: "completed",
    createdAtMs: 10, finishedAtMs: 20, evidenceSource: "host-verified", failureCode: null,
    evidence: { outcome: "success", trace: [{ tick: 4 }, { tick: 9 }] } }] });
  assert.equal(runs[0].evidenceSource, "host-verified");
  assert.deepEqual(traceSummary(runs[0].evidence), { count: 2, firstTick: 4, lastTick: 9, hostDisagreement: false });
  assert.equal(traceSummary({ trace: [], hostDisagreement: { code: "outcome" } })?.hostDisagreement, true);
});

test("Evidence projections reject malformed host rows", () => {
  assert.throws(() => parsePlaytestHistory({ runs: [{ runId: "run-1" }] }), /creator_playtest_history_invalid/);
  assert.throws(() => parseCityDiagnostics({ events: [{ event: "view_ready" }] }), /creator_city_diagnostics_invalid/);
  const diagnostics = parseCityDiagnostics({ events: [{ revision: 2, correlationId: "view:1", event: "view_ready", code: null, elapsedMs: 15, atMs: 20 }] });
  assert.equal(diagnostics[0].revision, 2);
});

test("Ground Debug reports actual wheel heights and fails closed on malformed support", () => {
  const ground = parseGroundInspection({ status: "ready", regionId: "road-1", y: 1.25, pitch: 0.1, roll: -0.05,
    wheels: [1.2, 1.3, 1.1, 1.4], worldRevision: "world-2" });
  assert.deepEqual(ground.wheels, [1.2, 1.3, 1.1, 1.4]);
  assert.throws(() => parseGroundInspection({ status: "ready", wheels: [0, 1] }), /ground_inspection_invalid/);
  assert.equal(parseGroundInspection({ status: "unsupported", code: "no-surface", reason: "wheel:missing" }).code, "no-surface");
});

// PR06：无头测试记录把「执行成功」与「测试通过」分开呈现。
const codeTestDigest = "a".repeat(64);
const codeTestRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  buildId: codeTestDigest, workspaceRevision: "b".repeat(64), ok: true, seed: 7, ticks: 600,
  source: { source: "city", cityId: "city-1", cityRevision: 7, snapshotDigest: codeTestDigest }, atMs: 1,
  executionOk: true, verdict: "passed", scenarioId: "route.complete",
  assertions: [{ id: "win", kind: "outcome", status: "passed" }], worldSnapshotDigest: codeTestDigest,
  ...overrides,
});

test("Code test records separate executionOk from the scenario verdict", () => {
  const record = parseCodeTestRecord(codeTestRecord());
  assert.equal(record.verdict, "passed");
  assert.equal(record.executionOk, true);
  assert.equal(record.scenarioId, "route.complete");
  assert.equal(record.worldSnapshotDigest, codeTestDigest);
  assert.equal(record.cityId, "city-1");
  assert.equal(record.cityRevision, 7);
  assert.equal(record.snapshotDigest, codeTestDigest);
  assert.deepEqual(record.assertions.map(row => row.status), ["passed"]);
  const synthetic = parseCodeTestRecord(codeTestRecord({ source: { source: "synthetic" }, worldSnapshotDigest: undefined, scenarioId: undefined, assertions: [] }));
  assert.equal(synthetic.cityId, null);
  assert.equal(synthetic.worldSnapshotDigest, null);
  assert.equal(synthetic.scenarioId, null);
  const inconclusive = parseCodeTestRecord(codeTestRecord({ verdict: "inconclusive", verdictReason: "tick_budget_exhausted" }));
  assert.equal(inconclusive.verdict, "inconclusive");
  assert.equal(inconclusive.verdictReason, "tick_budget_exhausted");
});

test("Code test record projections reject malformed and pre-PR06 rows", () => {
  // pre-PR06：没有 verdict 字段的记录不是证据投影（发布门同样按 stale 拒绝）。
  const { verdict: _verdict, ...preVerdict } = codeTestRecord();
  assert.throws(() => parseCodeTestRecord(preVerdict), /creator_code_test_record_invalid/);
  assert.throws(() => parseCodeTestRecord(codeTestRecord({ verdict: "maybe" })), /creator_code_test_record_invalid/);
  assert.throws(() => parseCodeTestRecord(codeTestRecord({ buildId: "not-a-digest" })), /creator_code_test_record_invalid/);
  assert.throws(() => parseCodeTestRecord(codeTestRecord({ assertions: [{ id: "win", kind: "outcome" }] })), /creator_code_test_record_invalid/);
  assert.throws(() => parseCodeTestRecord(codeTestRecord({ assertions: [{ id: "win", kind: "entityPresent", status: "passed" }] })), /creator_code_test_record_invalid/);
  const capped = parseCodeTestRecord(codeTestRecord({
    assertions: Array.from({ length: 12 }, (_, index) => ({ id: `a${index}`, kind: "outcome", status: "passed" })),
  }));
  assert.equal(capped.assertions.length, 8, "assertions are capped at the contract bound");
});
