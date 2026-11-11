import test from "node:test";
import assert from "node:assert/strict";
import { BUILDING_COLLISION_RULESET, type MatchState } from "../src/game/mecha/board.ts";
import { createMatch, bossPrepare } from "../src/game/mecha/rules.ts";
import { previewEnemyPhase } from "../src/game/mecha/enemyPhasePreview.ts";

function prepared(ruleset: "mecha-v1.4" | typeof BUILDING_COLLISION_RULESET = "mecha-v1.4"): MatchState {
  const state = createMatch({ ruleset, preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 2, y: 7 } }, { id: "Gunner", pos: { x: 5, y: 7 } }, { id: "Support", pos: { x: 8, y: 7 } }] });
  bossPrepare(state);
  return state;
}
function intent(cell: { x: number; y: number }) {
  return { skillId: "smash" as const, local: [], projected: [cell], cdSweep: 0, status: "planned" as const };
}
function waitPlan(state: MatchState) {
  return { revision: state.revision, items: state.mechs.filter(mech => mech.hp > 0).map(mech => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" as const } })) };
}

test("enemy phase preview uses boss then stored raider order and reports each actor's HP delta", () => {
  const state = prepared();
  state.boss.intent = { skillId: "skip", local: [], projected: [], cdSweep: 0, status: "void" };
  state.raiders = [
    { id: "raider-b", pos: { x: 1, y: 1 }, hp: 8, intent: intent({ x: 2, y: 7 }) },
    { id: "raider-a", pos: { x: 8, y: 1 }, hp: 8, intent: intent({ x: 5, y: 7 }) },
  ];
  const before = structuredClone(state);
  const preview = previewEnemyPhase(state, waitPlan(state));
  assert.ok(preview.ok, JSON.stringify(preview));
  assert.deepEqual(preview.steps.map(step => [step.order, step.actor, step.cancel]), [
    [1, "boss", "no_target"], [2, "raider-b", ""], [3, "raider-a", ""],
  ]);
  assert.equal(preview.steps[1]!.outcome.hp.Assault, -1);
  assert.equal(preview.steps[2]!.outcome.hp.Gunner, -2);
  assert.deepEqual(state, before, "preview must not mutate the source match");
});

test("enemy phase preview explains dead actors without changing the source match", () => {
  const state = prepared();
  state.raiders = [{ id: "raider-dead", pos: { x: 1, y: 1 }, hp: 0, intent: intent({ x: 2, y: 7 }) }];
  const before = structuredClone(state);
  const preview = previewEnemyPhase(state, waitPlan(state));
  assert.ok(preview.ok, JSON.stringify(preview));
  assert.equal(preview.steps.find(step => step.actor === "raider-dead")?.cancel, "dead");
  assert.deepEqual(state, before);
});

test("v1.5 poison tick is ordered before enemy attacks and preview remains read-only", () => {
  const state = prepared(BUILDING_COLLISION_RULESET);
  state.statusEncounter = { schema: "mecha-status-encounter:v1", statuses: [
    { kind: "poison", target: "Assault", source: "test", magnitude: 1, remainingTurns: 2 },
  ] };
  const before = structuredClone(state);
  const preview = previewEnemyPhase(state);
  assert.ok(preview.ok, JSON.stringify(preview));
  assert.deepEqual(preview.steps.slice(0, 2).map(step => [step.order, step.actor, step.skill]), [[1, "status", "status_tick"], [2, "boss", state.boss.intent?.skillId ?? "skip"]]);
  assert.equal(preview.steps[0]!.outcome.hp.Assault, -1);
  assert.deepEqual(state, before);
});
