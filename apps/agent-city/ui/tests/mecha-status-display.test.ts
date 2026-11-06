import test from "node:test";
import assert from "node:assert/strict";
import { applyStatusDisplayCue, describeStatusBadges, type DisplayStatus } from "../src/game/mecha/statusDisplay.ts";
import type { MechaPerformanceEvent } from "../src/render/mecha/performance.ts";

const cue = (change: "applied" | "refreshed" | "advanced" | "damage" | "expired" | "removed", source: string, remainingTurns?: number): Extract<MechaPerformanceEvent, { kind: "status_cue" }> =>
  ({ kind: "status_cue", actor: "Assault", source, status: "poison", change, ...(remainingTurns === undefined ? {} : { remainingTurns }), cell: { x: 1, y: 2 }, duration: .4 });

test("status badges follow each validated source and expose readable localised duration", () => {
  const first = applyStatusDisplayCue([], cue("applied", "boss", 2)); assert.ok(first);
  const both = applyStatusDisplayCue(first, cue("applied", "raider", 1)); assert.ok(both);
  assert.equal(describeStatusBadges(both, "Assault", "zh-Hans").text, "☠️2");
  assert.match(describeStatusBadges(both, "Assault", "en").accessible, /Poison.*2 turns.*2 sources/);
  const advanced = applyStatusDisplayCue(both, cue("advanced", "boss", 1)); assert.ok(advanced);
  const expired = applyStatusDisplayCue(advanced, cue("expired", "raider")); assert.ok(expired);
  assert.equal(describeStatusBadges(expired, "Assault", "en").text, "☠️1");
  assert.deepEqual(first, [{ target: "Assault", source: "boss", kind: "poison", remainingTurns: 2 }]);
  assert.deepEqual(describeStatusBadges(expired, "Gunner", "en"), { text: "", accessible: "" });
});

test("playback rejects malformed, duplicated or out-of-order status transitions", () => {
  const initial: DisplayStatus[] = [{ target: "Assault", source: "boss", kind: "poison", remainingTurns: 2 }];
  assert.equal(applyStatusDisplayCue(initial, cue("applied", "boss", 2)), null);
  assert.equal(applyStatusDisplayCue(initial, cue("advanced", "boss", 2)), null);
  assert.equal(applyStatusDisplayCue(initial, cue("expired", "boss")), null);
  assert.equal(applyStatusDisplayCue(initial, cue("removed", "unknown")), null);
  assert.equal(applyStatusDisplayCue(initial, cue("refreshed", "boss", 1)), null);
  assert.deepEqual(applyStatusDisplayCue(initial, cue("damage", "boss")), initial);
});
