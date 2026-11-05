import assert from "node:assert/strict";
import test from "node:test";
import { performanceFromLog } from "../src/game/mecha/performance.ts";
import { createMatch } from "../src/game/mecha/rules.ts";

// Synthetic snapshots only: the host does not yet emit a raider lifecycle log.
test("log conversion skips an unknown raider start without losing known movement", () => {
  const before = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash",
    raiders: [{ id: "raider-w", pos: { x: 1, y: 1 } }] });
  const after = structuredClone(before);
  after.raiders[0]!.pos = { x: 1, y: 2 };
  after.raiders.push({ id: "swarm:0", pos: { x: 3, y: 4 }, hp: 2, intent: null });
  const events = performanceFromLog(before, after, []);
  assert.deepEqual(events, [{ kind: "move", actor: "raider-w", path: [{ x: 1, y: 1 }, { x: 1, y: 2 }], duration: 0.3 }]);
});
