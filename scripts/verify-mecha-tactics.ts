import assert from "node:assert/strict";
import test from "node:test";
import {
  attackerCenter, bossExecute, bossPrepare, createMatch, footprintCenter, knockbackFromAttacker,
  setScriptCounters, validateAndApplyPlan, type MatchState,
} from "../apps/agent-city/ui/src/game/mecha/rules.ts";

function hold(state: MatchState) {
  return {
    revision: state.revision,
    items: state.mechs.filter((m) => m.hp > 0).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })),
  };
}

test("2x2 center is anchor plus one, attacker stays plus half", () => {
  assert.deepEqual(footprintCenter({ x: 4, y: 4 }), { x: 5, y: 5 });
  assert.notDeepEqual(footprintCenter({ x: 4, y: 4 }), { x: 4.5, y: 4.5 });
  assert.deepEqual(attackerCenter({ x: 5, y: 3 }), { x: 5.5, y: 3.5 });
});

test("knockback uses the true center, so (5,3) vs (4,4) goes south", () => {
  assert.deepEqual(knockbackFromAttacker({ x: 5, y: 3 }, { x: 4, y: 4 }), { x: 0, y: 1 });
  assert.deepEqual(knockbackFromAttacker({ x: 3, y: 3 }, { x: 4, y: 4 }), { x: 1, y: 0 });
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "stationary_smash",
    covers: [],
    boss: { x: 4, y: 4 },
    mechs: [
      { id: "Assault", pos: { x: 5, y: 3 } },
      { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 9, y: 9 } },
    ],
  });
  bossPrepare(state);
  const applied = validateAndApplyPlan(state, {
    revision: state.revision,
    items: [
      { mechId: "Assault", moveTo: null, action: { kind: "melee" } },
      { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
      { mechId: "Support", moveTo: null, action: { kind: "skip" } },
    ],
  });
  assert.equal("ok" in applied, true);
  assert.deepEqual(state.boss.anchor, { x: 4, y: 5 });
});

test("cadence is smash smash sweep and cd falls back to smash", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "cadence_ssw" });
  const skills = [];
  for (let i = 0; i < 3; i += 1) {
    skills.push(bossPrepare(state).skillId);
    assert.equal("ok" in validateAndApplyPlan(state, hold(state)), true);
    bossExecute(state);
  }
  assert.deepEqual(skills, ["smash", "smash", "sweep"]);

  const cooled = createMatch({ preset: "covers_sparse_mid", script: "cadence_ssw" });
  setScriptCounters(cooled, 2, 1);
  assert.equal(bossPrepare(cooled).skillId, "smash");
});

test("sweep picks the mech and the cover ahead of empty cells", () => {
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "cadence_ssw",
    covers: [{ x: 6, y: 0 }],
    boss: { x: 4, y: 0 },
    mechs: [
      { id: "Assault", pos: { x: 6, y: 1 } },
      { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 9, y: 9 } },
    ],
  });
  setScriptCounters(state, 2, 0);
  const intent = bossPrepare(state);
  assert.equal(intent.skillId, "sweep");
  assert.deepEqual([...intent.projected].sort((a, b) => a.x - b.x || a.y - b.y), [{ x: 6, y: 0 }, { x: 6, y: 1 }]);
});

test("an illegal second order rolls the whole pack back", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash" });
  bossPrepare(state);
  const before = structuredClone(state);
  const rejected = validateAndApplyPlan(state, {
    revision: state.revision,
    items: [
      { mechId: "Assault", moveTo: { x: 2, y: 8 }, action: { kind: "skip" } },
      { mechId: "Gunner", moveTo: { x: 5, y: 0 }, action: { kind: "skip" } },
      { mechId: "Support", moveTo: null, action: { kind: "skip" } },
    ],
  });
  assert.equal("ok" in rejected, false);
  assert.equal("code" in rejected && rejected.code, "PLAN_PACK_REJECTED");
  assert.deepEqual(state.mechs.map((m) => m.pos), before.mechs.map((m) => m.pos));
  assert.equal(state.revision, before.revision);
  assert.equal("ok" in validateAndApplyPlan(state, hold(state)), true);
});
