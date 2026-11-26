import test from "node:test";
import assert from "node:assert/strict";
import { parseCityDiagnostics, parseGroundInspection, parsePlaytestHistory, traceSummary } from "../src/features/evidence/evidenceCenterModel.ts";

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
