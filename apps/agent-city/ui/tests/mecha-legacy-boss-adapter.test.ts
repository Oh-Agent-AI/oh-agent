import test from "node:test";
import assert from "node:assert/strict";
import { scriptedEnemyPrepare } from "../src/game/mecha/enemy.ts";
import { applyEnemyPlan, bossPrepare, scriptedEnemyPlanner } from "../src/game/mecha/enemy/planner.ts";
import type { EnemyPlan, EnemyPlanner } from "../src/game/mecha/enemy/contracts.ts";
import { legacyBossPrepareAdapter } from "../src/game/mecha/monsters/legacyPrepare.ts";
import { lookupMonsterDefinition, MONSTER_CONTENT_VERSION_V1, MONSTER_RULESET_V1 } from "../src/game/mecha/monsters/registry.ts";
import { createMatch, playTurn, previewPlan, type BossScriptId, type MatchState } from "../src/game/mecha/rules.ts";

// Independent reference using the original prepare function. The adapter is not
// wired into the planner until the rule-core dependency boundary is redesigned.
const referencePlanner: EnemyPlanner = {
  policy: "scripted:v1",
  plan(state: MatchState): EnemyPlan {
    const next = structuredClone(state);
    scriptedEnemyPrepare(next);
    return {
      policy: "scripted:v1", revision: state.revision,
      boss: { anchor: { ...next.boss.anchor }, cadence: next.boss.cadence,
        cdSweep: next.boss.cdSweep, intent: structuredClone(next.boss.intent) },
      raiders: next.raiders.map((raider) => ({ id: raider.id, pos: { ...raider.pos }, intent: structuredClone(raider.intent) })),
      next: { phase: next.phase, revision: next.revision, outcome: next.outcome },
    };
  },
};

function fixture(script: BossScriptId): MatchState {
  const state = createMatch({
    preset: "covers_sparse_mid", script, covers: [], boss: { x: 4, y: 4 },
    buildings: [{ id: "tower", cells: [{ x: 0, y: 0 }], hp: 100 }],
    raiders: [{ id: "west", pos: { x: 2, y: 6 }, hp: 100 }, { id: "east", pos: { x: 7, y: 6 }, hp: 100 }],
    mechs: [
      { id: "Assault", pos: { x: 4, y: 3 } },
      { id: "Gunner", pos: { x: 5, y: 3 } },
      { id: "Support", pos: { x: 9, y: 9 } },
    ],
  });
  for (const mech of state.mechs) mech.hp = 100;
  return state;
}

function waitPlan(state: MatchState) {
  return { revision: state.revision, items: state.mechs.map(({ id }) => ({
    mechId: id, moveTo: null, action: { kind: "skip" as const },
  })) };
}

test("the adapter is bound to the legacy definition and invokes the original whole enemy prepare", () => {
  const result = lookupMonsterDefinition(MONSTER_RULESET_V1, MONSTER_CONTENT_VERSION_V1, "legacy_boss");
  assert.ok(result.ok);
  if (!result.ok) assert.fail(result.reason);
  assert.equal(legacyBossPrepareAdapter.definition, result.definition);
  assert.ok(Object.isFrozen(legacyBossPrepareAdapter));
  const input = fixture("siege");
  const legacy = structuredClone(input), adapted = structuredClone(input);
  assert.deepEqual(legacyBossPrepareAdapter.prepare(adapted), scriptedEnemyPrepare(legacy));
  assert.deepEqual(adapted, legacy);
  assert.ok(adapted.raiders.some((raider) => raider.intent), "old Raider planning must not be dropped");
});

for (const script of ["stationary_smash", "cadence_ssw", "raid_ssw", "siege"] as const) {
  test(`${script}: legacy planner and adapter baseline match for six turns`, () => {
    let expected = fixture(script), actual = structuredClone(expected);
    const before = structuredClone(actual);
    assert.deepEqual(scriptedEnemyPlanner.plan(actual), referencePlanner.plan(expected));
    assert.deepEqual(actual, before, "planning must not mutate input");
    const intent = scriptedEnemyPrepare(expected);
    assert.deepEqual(bossPrepare(actual), intent);
    assert.deepEqual(actual, expected);

    for (let round = 0; round < 6; round += 1) {
      assert.equal(actual.phase, "player_plan", `round ${round + 1} must remain playable`);
      const plan = waitPlan(actual);
      const originalState = structuredClone(actual);
      const preview = previewPlan(actual, plan);
      const result = playTurn(actual, plan);
      const reference = playTurn(expected, plan, referencePlanner);
      assert.deepEqual(result, reference, `state, log and presentation round ${round + 1}`);
      assert.deepEqual(actual, originalState, "turn execution must not mutate input");
      assert.ok(result.ok && reference.ok && preview.ok);
      assert.deepEqual(preview.log, reference.log, `preview log round ${round + 1}`);
      assert.deepEqual(preview.stages, reference.presentationStages, `preview stages round ${round + 1}`);
      actual = result.state;
      expected = reference.state;
    }
  });
}

test("prepare planning preserves stale-revision rejection and unusual old state handling", () => {
  for (const variant of ["deployment", "dead-boss", "no-enemies", "unknown-legacy-script"] as const) {
    const state = fixture("siege");
    if (variant === "deployment") state.phase = "deployment";
    if (variant === "dead-boss" || variant === "no-enemies") state.boss.hp = 0;
    if (variant === "no-enemies") for (const raider of state.raiders) raider.hp = 0;
    // This checks preservation of legacy handling, not support for a new script.
    if (variant === "unknown-legacy-script") state.script = "not_a_script" as BossScriptId;
    const before = structuredClone(state);
    const oldPlan = referencePlanner.plan(state);
    const newPlan = scriptedEnemyPlanner.plan(state);
    assert.deepEqual(newPlan, oldPlan, variant);
    assert.deepEqual(state, before);
    if (variant !== "deployment") {
      const legacy = structuredClone(state), integrated = structuredClone(state);
      assert.equal(applyEnemyPlan(legacy, oldPlan), true);
      assert.equal(applyEnemyPlan(integrated, newPlan), true);
      assert.deepEqual(integrated, legacy);
      const after = structuredClone(integrated);
      assert.equal(applyEnemyPlan(integrated, newPlan), false);
      assert.deepEqual(integrated, after, "stale plan must not mutate state");
    } else {
      const after = structuredClone(state);
      assert.equal(applyEnemyPlan(state, newPlan), false);
      assert.deepEqual(state, after);
    }
  }
});
