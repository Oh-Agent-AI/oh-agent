import test from "node:test";
import assert from "node:assert/strict";
import { playtestOutcome } from "../src/game/activity/playtestOutcome.ts";

test("successful playtests omit failure codes, failures retain a reason", () => {
  assert.deepEqual(playtestOutcome("success", "completed"), { status: "completed" });
  assert.deepEqual(playtestOutcome("failure", "time_limit"), { status: "failed", failureCode: "time_limit" });
  assert.deepEqual(playtestOutcome("error", null), { status: "failed", failureCode: "creator_minigame_failed" });
});
