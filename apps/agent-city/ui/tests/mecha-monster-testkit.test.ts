import assert from "node:assert/strict";
import test from "node:test";
import { bossPrepare, createMatch, playTurn, previewPlan, type ArenaPlan, type PlanPreview, type TurnEvent } from "../src/game/mecha/rules.ts";
import { assertEvents, assertPlanRejectedAtomically, assertPreviewMatchesTurn, assertSerializedReplay, holdPlan, monsterSkillFixture } from "./monster-skill-testkit.ts";

type SuccessfulPreview = Extract<PlanPreview, { ok: true }>;

function combatFixture() {
  const state = createMatch({ preset: "covers_sparse_mid", script: "cadence_ssw", covers: [], boss: { x: 4, y: 4 },
    buildings: [{ id: "tower", cells: [{ x: 0, y: 0 }], hp: 100 }], raiders: [{ id: "west", pos: { x: 2, y: 6 }, hp: 100 }],
    mechs: [{ id: "Assault", pos: { x: 4, y: 3 } }, { id: "Gunner", pos: { x: 5, y: 3 } }, { id: "Support", pos: { x: 9, y: 9 } }],
  });
  bossPrepare(state);
  return state;
}

test("real combat checks ordered payloads, projected state and multi-turn JSON replay", () => {
  const initial = combatFixture(), first = holdPlan(initial);
  const result = assertPreviewMatchesTurn(initial, first);
  const expected: TurnEvent[] = [
    { type: "enemy", actor: "boss", skill: "smash", cells: [{ x: 4, y: 3 }], damage: 4,
      effects: [{ kind: "mech", id: "Assault", before: 14, after: 10, order: 0, sequence: 0 }] },
    { type: "shove", unit: "Assault", dir: { x: 0, y: -1 }, damage: 0, sequence: 1 },
    { type: "enemy", actor: "west", skill: "smash", cells: [{ x: 1, y: 3 }], damage: 0 },
  ];
  assertEvents(result.log, expected);
  assert.throws(() => assertEvents(result.log, [...expected].reverse()));
  const wrongDamage = structuredClone(expected);
  if (wrongDamage[0]!.type === "enemy") wrongDamage[0]!.damage += 1;
  assert.throws(() => assertEvents(result.log, wrongDamage));
  assert.equal(result.state.mechs[0]!.hp, 10);
  assert.deepEqual(result.state.mechs[0]!.pos, { x: 4, y: 2 });
  const second = holdPlan(result.state), secondResult = assertPreviewMatchesTurn(result.state, second);
  assert.equal(secondResult.state.buildings[0]!.hp, 97);
  assert.equal(secondResult.state.boss.intent?.skillId, "sweep");
  const third = holdPlan(secondResult.state);
  assertSerializedReplay(initial, [first, second, third]);
});

test("preview parity helper detects independent changes to all exposed projections", () => {
  const corruptions: Array<[string, (preview: SuccessfulPreview) => void, RegExp]> = [
    ["assumed", (p) => { p.assumed.push("Assault"); }, /fixture must include/],
    ["event order", (p) => { p.log.reverse(); }, /event order differs/],
    ["presentation stage", (p) => { p.stages!.afterEnemy.boss.hp -= 1; }, /presentation differs/],
    ["outcome", (p) => { p.outcome = "victory"; }, /outcome differs/],
    ["damage", (p) => { p.hitsAfter.Assault += 1; }, /damage differs/],
    ["buildings", (p) => { p.buildings[0]!.endHp -= 1; }, /buildings differ/],
    ["enemy order", (p) => { p.enemyOrder.reverse(); }, /enemy order differs/],
    ["actor telegraphs", (p) => { p.telegraphByActor.boss = []; }, /actor telegraphs differ/],
    ["telegraph union", (p) => { p.telegraphAfter.reverse(); }, /telegraphs differ/],
  ];
  for (const [name, corrupt, message] of corruptions) {
    const state = combatFixture(), plan = holdPlan(state);
    assert.throws(() => assertPreviewMatchesTurn(state, plan, { preview: (s, p) => {
      const result = previewPlan(s, p);
      assert.ok(result.ok);
      corrupt(result);
      return result;
    } }), message, name);
  }
  const state = combatFixture();
  assert.throws(() => assertPreviewMatchesTurn(state, holdPlan(state), { play: (s, p) => {
    const result = playTurn(s, p);
    assert.ok(result.ok);
    result.state.boss.hp -= 1;
    return result;
  } }), /presentation end differs from execution state/);
});

test("valid and rejected calls check each input immediately, before the other call can hide a mutation", () => {
  for (const rejected of [false, true]) for (const api of ["preview", "play"] as const) for (const target of ["state", "plan"] as const) {
    const state = monsterSkillFixture(), plan = holdPlan(state);
    if (rejected) plan.revision -= 1;
    const overrides = api === "preview" ? { preview: (s: typeof state, p: ArenaPlan) => {
      const result = previewPlan(s, p);
      if (target === "state") s.boss.hp -= 1; else p.revision -= 1;
      return result;
    } } : { play: (s: typeof state, p: ArenaPlan) => {
      const result = playTurn(s, p);
      if (target === "state") s.boss.hp -= 1; else p.revision -= 1;
      return result;
    } };
    const check = rejected ? assertPlanRejectedAtomically : assertPreviewMatchesTurn;
    assert.throws(() => check(state, plan, overrides), /mutated the (input|command)/, `${rejected} ${api} ${target}`);
  }
});

test("rejected complete plans return only matching faults, including a late failure after tentative movement", () => {
  const cases: Array<[string, (plan: ArenaPlan) => void, string]> = [
    ["stale", (p) => { p.revision -= 1; }, "STALE_REVISION"],
    ["duplicate", (p) => { p.items[1]!.mechId = p.items[0]!.mechId; }, "NEED_ALL_OR_CONFIRM"],
    ["unreachable", (p) => { p.items[2]!.moveTo = { x: 99, y: 99 }; }, "PLAN_PACK_REJECTED"],
    ["late illegal action", (p) => { p.items[0]!.moveTo = { x: 3, y: 2 }; p.items[2]!.action = { kind: "melee", target: "boss" }; }, "PLAN_PACK_REJECTED"],
  ];
  for (const [name, mutate, code] of cases) {
    const state = monsterSkillFixture(), plan = holdPlan(state);
    mutate(plan);
    const actual = playTurn(state, plan);
    assert.ok(!actual.ok, name);
    assert.equal(actual.fault.code, code, name);
    assertPlanRejectedAtomically(state, plan);
  }
  const movementState = monsterSkillFixture(), movementPlan = holdPlan(movementState);
  movementPlan.items[0]!.moveTo = { x: 3, y: 2 };
  const movement = playTurn(movementState, movementPlan);
  assert.ok(movement.ok);
  assert.deepEqual(movement.log[0], { type: "move", mechId: "Assault", from: { x: 3, y: 3 }, to: { x: 3, y: 2 } });
  const state = monsterSkillFixture(), incomplete = holdPlan(state);
  incomplete.items.pop();
  const preview = previewPlan(state, incomplete), actual = playTurn(state, incomplete);
  assert.ok(preview.ok);
  assert.deepEqual(preview.assumed, ["Support"]);
  assert.ok(!actual.ok);
  assert.equal(actual.fault.code, "NEED_ALL_OR_CONFIRM");
  assert.throws(() => assertPlanRejectedAtomically(state, incomplete));
});

test("atomic rejection helper rejects mismatched faults and hidden effects", () => {
  const state = monsterSkillFixture(), plan = holdPlan(state);
  plan.revision -= 1;
  assert.throws(() => assertPlanRejectedAtomically(state, plan, { play: (s, p) => {
    const result = playTurn(s, p);
    assert.ok(!result.ok);
    return { ...result, fault: { ...result.fault, reason: "different" } };
  } }), /rejection faults differ/);
  assert.throws(() => assertPlanRejectedAtomically(state, plan, { play: (s, p) => ({ ...playTurn(s, p), log: [] }) }), /must not return effects/);
});

test("JSON replay helper catches intermediate state, event and presentation divergence", () => {
  const initial = combatFixture(), first = holdPlan(initial), result = playTurn(initial, first);
  assert.ok(result.ok);
  const plans = [first, holdPlan(result.state)];
  for (const field of ["state", "log", "stages"] as const) {
    let calls = 0;
    assert.throws(() => assertSerializedReplay(initial, plans, (s, p) => {
      const turn = playTurn(s, p);
      calls += 1;
      if (calls === 4 && turn.ok) {
        if (field === "state") turn.state.boss.cadence += 1;
        if (field === "log") turn.log.reverse();
        if (field === "stages") turn.presentationStages!.afterPlayer.boss.hp -= 1;
      }
      return turn;
    }), /serialized replay diverged at turn 2/, field);
  }
  assert.throws(() => assertSerializedReplay(initial, []), /requires at least one command/);
  const nonJsonState = monsterSkillFixture();
  nonJsonState.boss.cadence = NaN; // JSON turns NaN into null; a clone-only replay would miss this.
  assert.throws(() => assertSerializedReplay(nonJsonState, [holdPlan(nonJsonState)]), /serialized replay diverged at turn 1/);
  const staleSecond = structuredClone(plans);
  staleSecond[1]!.revision -= 1;
  assert.throws(() => assertSerializedReplay(initial, staleSecond), /STALE_REVISION/);
});

test("JSON replay checks original and restored input and command mutations separately", () => {
  for (const call of [1, 2]) for (const target of ["state", "plan"] as const) {
    const initial = combatFixture(), plans = [holdPlan(initial)];
    let calls = 0;
    assert.throws(() => assertSerializedReplay(initial, plans, (s, p) => {
      const result = playTurn(s, p);
      calls += 1;
      if (calls === call) { if (target === "state") s.boss.hp -= 1; else p.revision -= 1; }
      return result;
    }), /mutated at turn 1/, `${call} ${target}`);
  }
});
