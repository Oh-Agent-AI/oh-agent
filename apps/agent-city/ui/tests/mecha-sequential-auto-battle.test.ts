import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { SequentialTurn } from "../src/game/mecha/sequentialTurn.ts";
import { nextCommand } from "../src/game/mecha/ai/commandPolicy.ts";
import { compareSequentialPolicies, runSequentialAutoBattle } from "../src/game/mecha/ai/sequentialAutoBattle.ts";
import { nextCoordinatedCommand } from "../src/game/mecha/ai/coordinatedPolicy.ts";

function fixture() {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }] });
  bossPrepare(state); return state;
}

test("v1.5 EvE runs real commands deterministically and never mutates the opening", () => {
  const state = fixture(), before = structuredClone(state);
  const first = runSequentialAutoBattle(state, { maxSteps: 80, maxTurns: 6 });
  const second = runSequentialAutoBattle(state, { maxSteps: 80, maxTurns: 6 });
  assert.deepEqual(state, before);
  assert.ok(first.steps > 0);
  assert.deepEqual(first.state, second.state);
  assert.deepEqual(first.records.map(record => record.command), second.records.map(record => record.command));
  assert.ok(["outcome", "step_limit", "turn_limit"].includes(first.reason));
});

test("records from the harness replay to the same authoritative state", () => {
  const state = fixture();
  const result = runSequentialAutoBattle(state, { maxSteps: 80, maxTurns: 6 });
  const replayed = SequentialTurn.replay(state, result.records);
  assert.equal(replayed.snapshot().match.revision, result.state.revision);
  assert.equal(replayed.snapshot().match.outcome, result.state.outcome);
  assert.deepEqual(replayed.snapshot().match.mechs, result.state.mechs);
});

test("alternative policies are compared from the same opening", () => {
  const state = fixture();
  const comparison = compareSequentialPolicies(state, {
    aggressive: nextCommand,
    hold: () => ({ kind: "end" }),
  }, { maxSteps: 80, maxTurns: 6 });
  assert.equal(comparison.length, 2);
  assert.ok(comparison[0]!.result.steps >= comparison[1]!.result.steps);
  assert.equal(comparison[1]!.name, "hold");
});

test("coordinated policy commits an action plan without mutating the authority", () => {
  const state = fixture(), turn = new SequentialTurn(state), before = turn.snapshot();
  const command = nextCoordinatedCommand(turn);
  assert.equal(command.kind, "act");
  assert.deepEqual(turn.snapshot(), before);
});
