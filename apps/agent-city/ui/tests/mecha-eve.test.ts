import assert from "node:assert/strict";
import { test } from "node:test";
import { createMatchPlanner } from "../src/game/mecha/ai/planner.ts";
import type { MatchPlanner } from "../src/game/mecha/ai/contracts.ts";
import { runAutoBattle } from "../src/game/mecha/autoBattle.ts";
import { scriptedEnemyPrepare } from "../src/game/mecha/enemy.ts";
import type { EnemyPlan, EnemyPlanner } from "../src/game/mecha/enemy/contracts.ts";
import { applyEnemyPlan, bossPrepare, scriptedEnemyPlanner } from "../src/game/mecha/enemy/planner.ts";
import { createMatch, type MatchState } from "../src/game/mecha/rules.ts";

function stateFor(script: "siege" | "cadence_ssw" = "cadence_ssw"): MatchState {
  return createMatch({ preset: "covers_sparse_mid", script });
}

test("the scripted enemy planner preserves legacy state and serializes its locked plan", () => {
  const state = stateFor("siege");
  const before = structuredClone(state);
  const expected = structuredClone(state);
  scriptedEnemyPrepare(expected);
  const plan = scriptedEnemyPlanner.plan(state);
  assert.equal(plan.policy, "scripted:v1");
  assert.deepEqual(state, before);
  const applied = structuredClone(state);
  assert.equal(applyEnemyPlan(applied, structuredClone(plan)), true);
  assert.deepEqual(applied, expected);
  const compatible = structuredClone(state);
  bossPrepare(compatible);
  assert.deepEqual(compatible, expected);
  const serialized = JSON.parse(JSON.stringify(plan)) as EnemyPlan;
  const restored = structuredClone(state);
  assert.equal(applyEnemyPlan(restored, serialized), true);
  assert.deepEqual(restored, expected);
});

test("a stale enemy plan is rejected without changing the state", () => {
  const state = stateFor("siege");
  const plan = scriptedEnemyPlanner.plan(state);
  state.revision += 1;
  const before = structuredClone(state);
  assert.equal(applyEnemyPlan(state, plan), false);
  assert.deepEqual(state, before);
});

test("EvE runs both planners through authoritative turns with deterministic replay", () => {
  const initial = stateFor();
  const before = structuredClone(initial);
  const options = { squad: createMatchPlanner("tunnel") };
  const first = runAutoBattle(initial, options);
  const second = runAutoBattle(initial, options);
  assert.deepEqual(first, second);
  assert.deepEqual(initial, before);
  assert.equal(first.reason, "outcome");
  assert.equal(first.state.outcome, "victory");
  assert.equal(first.state.turn, 7);
  assert.equal(first.turns.length, 7);
  for (let index = 0; index < first.turns.length; index += 1) {
    const turn = first.turns[index]!;
    assert.equal(turn.before.phase, "player_plan");
    assert.ok(turn.before.boss.intent);
    assert.equal(turn.after.revision > turn.before.revision, true);
    if (index > 0) assert.deepEqual(turn.before, first.turns[index - 1]!.after);
  }
});

test("EvE accepts an enemy policy without mutating the initial match", () => {
  const initial = stateFor();
  const before = structuredClone(initial);
  let calls = 0;
  const enemy: EnemyPlanner = {
    policy: "counting-test",
    plan(state) {
      calls += 1;
      return scriptedEnemyPlanner.plan(state);
    },
  };
  const result = runAutoBattle(initial, { squad: createMatchPlanner("peel"), enemy, maxTurns: 1 });
  assert.equal(calls, 2);
  assert.equal(result.reason, "turn_limit");
  assert.equal(result.turns.length, 1);
  assert.equal(result.state.phase, "player_plan");
  assert.deepEqual(initial, before);
});

test("EvE reports a rejected squad plan without partially applying a turn", () => {
  const initial = stateFor();
  const before = structuredClone(initial);
  const squad: MatchPlanner = {
    doctrine: "tunnel",
    plan: (state) => ({ revision: state.revision + 1, items: [] }),
    evaluate: () => [],
  };
  const result = runAutoBattle(initial, { squad });
  assert.equal(result.reason, "plan_rejected");
  assert.equal(result.fault?.code, "STALE_REVISION");
  assert.equal(result.turns.length, 0);
  assert.deepEqual(initial, before);
});
