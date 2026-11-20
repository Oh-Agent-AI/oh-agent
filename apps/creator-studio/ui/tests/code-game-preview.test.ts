import test from "node:test";
import assert from "node:assert/strict";
import { canStopCodePreview, parseCodeBuilds, parseCodePreviewStatus, parseCodeStoryEvidence } from "../src/codeGamePreview";

test("Studio accepts bounded immutable build rows", () => {
  const rows = parseCodeBuilds({ builds: [{ buildId: "a".repeat(64), gameId: "community.demo", gameVersion: "1.0.0", byteLength: 42, createdAtMs: 1 }] });
  assert.equal(rows[0]?.gameId, "community.demo");
  assert.throws(() => parseCodeBuilds({ builds: [{ buildId: "../private", gameId: "bad" }] }), /creator_code_builds_invalid/);
  assert.throws(() => parseCodeBuilds({}), /creator_code_builds_invalid/);
});

test("Studio Preview status is projected to known telemetry and stop states", () => {
  const running = parseCodePreviewStatus({ available: true, status: "running", gameId: "community.demo", previewId: "preview-1", buildId: "b".repeat(64), runId: "run-1", tick: 12, entities: 1 });
  assert.equal(running.tick, 12);
  assert.equal(canStopCodePreview(running), true);
  const finished = parseCodePreviewStatus({ available: true, status: "finished", outcome: "success", tick: 120, entities: 0 });
  assert.equal(finished.outcome, "success");
  assert.equal(canStopCodePreview(finished), false);
  assert.throws(() => parseCodePreviewStatus(null), /creator_code_preview_status_invalid/);
});

test("Studio Story evidence is a whitelist projection, not a state copy", () => {
  const evidence = parseCodeStoryEvidence({ available: true, storyRevision: "sha256:story", state: { affection: 2, privateNote: "not projected" },
    rules: [{ ruleId: "date-saturday", nextDueUtcMs: 1_000, status: "scheduled" }],
    dialogue: [{ eventId: "event-1", text: "See you Saturday.", createdAtMs: 1 }] });
  assert.equal(evidence.affection, 2);
  assert.equal(evidence.rules[0]?.ruleId, "date-saturday");
  assert.equal(evidence.dialogue[0]?.text, "See you Saturday.");
  assert.equal("privateNote" in evidence, false);
  assert.equal(parseCodeStoryEvidence({ available: false }).rules.length, 0);
  assert.throws(() => parseCodeStoryEvidence({ available: true, dialogue: [{ eventId: "bad", text: "" }] }), /creator_code_story_invalid/);
});
