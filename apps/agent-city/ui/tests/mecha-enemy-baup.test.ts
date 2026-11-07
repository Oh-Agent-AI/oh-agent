import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { SequentialTurn } from "../src/game/mecha/sequentialTurn.ts";
import { applyEnemyPlan } from "../src/game/mecha/enemy/planner.ts";
import { baupEnemyPlanner } from "../src/game/mecha/enemy/plannerV2.ts";

function fixture(script = "siege", prepared = true) {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script, deployment: false,
    mechs: [{ id: "Assault", pos: { x: 3, y: 8 } }, { id: "Gunner", pos: { x: 5, y: 8 } }, { id: "Support", pos: { x: 7, y: 8 } }] });
  if (prepared) bossPrepare(state);
  return state;
}

test("BAUP is deterministic and commits a legal plan", () => {
  const state = fixture("siege", false);
  const first = baupEnemyPlanner.plan(state), second = baupEnemyPlanner.plan(state);
  assert.deepEqual(first, second);
  const clone = structuredClone(state);
  assert.equal(applyEnemyPlan(clone, first), true);
  assert.equal(clone.phase, first.next.phase);
});

test("BAUP can drive the real enemy phase through SequentialTurn", () => {
  const state = fixture("stationary_smash");
  const turn = new SequentialTurn(state, { enemyPlanner: baupEnemyPlanner });
  const result = turn.execute({ kind: "end", id: "end", revision: state.revision, confirmUnused: true });
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.snapshot.match.turn >= 2);
});
