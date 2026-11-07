import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { spawnNextWave } from "../src/game/mecha/board.ts";
import { refresh } from "../src/game/mecha/combat.ts";

function fixture() {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", deployment: false,
    raiders: [], boss: { x: 4, y: 0 },
    waves: { count: 2, raidersPerWave: 2, spawns: [{ x: 1, y: 4 }, { x: 8, y: 4 }, { x: 1, y: 5 }] } });
  state.boss.hp = 0;
  return state;
}

test("a cleared wave does not end the match and the next wave spawns into declared cells", () => {
  const state = fixture();
  refresh(state);
  assert.equal(state.outcome, null);
  assert.equal(spawnNextWave(state), true);
  assert.equal(state.raiders.length, 2);
  assert.deepEqual(state.raiders.map(raider => raider.pos), [{ x: 1, y: 4 }, { x: 8, y: 4 }]);
  assert.equal(state.waves?.remaining, 1);
  assert.equal(state.waves?.spawned, 1);
});

test("the final cleared wave wins only when no waves remain", () => {
  const state = fixture();
  state.waves!.remaining = 0;
  refresh(state);
  assert.equal(state.outcome, "victory");
});

test("the enemy phase spawns the next wave before planning new intents", () => {
  const state = fixture();
  bossPrepare(state);
  assert.equal(state.outcome, null);
  assert.equal(state.raiders.length, 2);
  assert.equal(state.phase, "player_plan");
  assert.ok(state.raiders.every(raider => raider.intent !== null));
});
