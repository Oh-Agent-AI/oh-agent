import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { SequentialTurn } from "../src/game/mecha/sequentialTurn.ts";
import { AI_DIFFICULTIES, policyFor } from "../src/game/mecha/ai/difficulty.ts";

function fixture() {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }] });
  bossPrepare(state); return state;
}

test("every difficulty selects a policy that returns a command without mutating the authority", () => {
  assert.deepEqual([...AI_DIFFICULTIES], ["greedy", "coordinated", "beam"]);
  const state = fixture(), turn = new SequentialTurn(state), before = turn.snapshot();
  for (const difficulty of AI_DIFFICULTIES) {
    const command = policyFor(difficulty)(turn);
    assert.equal(command.kind, "act", difficulty);
    assert.deepEqual(turn.snapshot(), before, difficulty);
  }
  assert.notEqual(policyFor("greedy"), policyFor("beam"));
});
