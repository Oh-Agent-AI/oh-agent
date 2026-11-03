import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePlansForDoctrine, planForDoctrine, type DoctrineId } from "../src/game/mecha/ai.ts";
import { createCandidateSource } from "../src/game/mecha/ai/candidates.ts";
import type { CandidateSource, PlanScorer } from "../src/game/mecha/ai/contracts.ts";
import { createMatchPlanner } from "../src/game/mecha/ai/planner.ts";
import { createPlanScorer } from "../src/game/mecha/ai/score.ts";
import { rulePlanSimulator } from "../src/game/mecha/ai/simulate.ts";
import { bossPrepare, createMatch, type ArenaPlan, type MatchState } from "../src/game/mecha/rules.ts";

function standardState(): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script: "siege" });
  bossPrepare(state);
  return state;
}

function guardState(): MatchState {
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "siege",
    covers: [],
    buildings: [{ id: "block", cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }] }],
    raiders: [
      { id: "raider-w", pos: { x: 1, y: 1 } },
      { id: "raider-e", pos: { x: 8, y: 8 } },
    ],
    mechs: [
      { id: "Assault", pos: { x: 4, y: 4 } },
      { id: "Gunner", pos: { x: 4, y: 5 } },
      { id: "Support", pos: { x: 5, y: 4 } },
    ],
    boss: { x: 6, y: 6 },
  });
  bossPrepare(state);
  return state;
}

const goldenCases: Array<{ name: string; state: () => MatchState; doctrine: DoctrineId; expected: ArenaPlan }> = [
  {
    name: "standard tunnel",
    state: standardState,
    doctrine: "tunnel",
    expected: { revision: 1, items: [
      { mechId: "Assault", moveTo: { x: 2, y: 5 }, action: { kind: "charge" } },
      { mechId: "Gunner", moveTo: { x: 5, y: 6 }, action: { kind: "pierce" } },
      { mechId: "Support", moveTo: { x: 6, y: 8 }, action: { kind: "skip" } },
    ] },
  },
  {
    name: "standard peel",
    state: standardState,
    doctrine: "peel",
    expected: { revision: 1, items: [
      { mechId: "Assault", moveTo: { x: 2, y: 5 }, action: { kind: "charge" } },
      { mechId: "Gunner", moveTo: { x: 6, y: 7 }, action: { kind: "pierce" } },
      { mechId: "Support", moveTo: { x: 6, y: 8 }, action: { kind: "repair", target: "Gunner" } },
    ] },
  },
  {
    name: "guard tunnel",
    state: guardState,
    doctrine: "tunnel",
    expected: { revision: 1, items: [
      { mechId: "Assault", moveTo: { x: 3, y: 6 }, action: { kind: "charge" } },
      { mechId: "Gunner", moveTo: { x: 5, y: 5 }, action: { kind: "pierce" } },
      { mechId: "Support", moveTo: { x: 6, y: 6 }, action: { kind: "melee" } },
    ] },
  },
  {
    name: "guard peel",
    state: guardState,
    doctrine: "peel",
    expected: { revision: 1, items: [
      { mechId: "Assault", moveTo: { x: 2, y: 5 }, action: { kind: "charge" } },
      { mechId: "Gunner", moveTo: { x: 3, y: 4 }, action: { kind: "pierce" } },
      { mechId: "Support", moveTo: null, action: { kind: "shoot" } },
    ] },
  },
];

for (const { name, state: makeState, doctrine, expected } of goldenCases) {
  test(`${name} keeps its deterministic golden plan without mutating the state`, () => {
    const state = makeState();
    const before = structuredClone(state);
    assert.deepEqual(planForDoctrine(state, doctrine), expected);
    assert.deepEqual(planForDoctrine(state, doctrine), expected);
    assert.deepEqual(state, before);
  });
}

test("the selected plan exposes stable weighted score factors", () => {
  const state = standardState();
  const plan = planForDoctrine(state, "tunnel");
  const evaluations = evaluatePlansForDoctrine(state, "tunnel");
  const selected = evaluations.find((evaluation) => evaluation.deterministicKey === JSON.stringify(plan.items));
  assert.ok(selected);
  assert.deepEqual(selected.factors.map((factor) => factor.id), ["boss_damage", "raider_damage", "building_damage", "mech_damage", "position"]);
  assert.equal(selected.score, selected.factors.reduce((sum, factor) => sum + factor.score, 0));
  for (const factor of selected.factors) assert.equal(factor.score, factor.value * factor.weight);
  assert.ok((selected.factors[0]?.value ?? 0) > 0);
  assert.equal(createPlanScorer("tunnel").weightVersion, "ai-weights:v1");
  assert.deepEqual(evaluatePlansForDoctrine(state, "tunnel"), evaluations);
});

test("candidate generation is deterministic and does not mutate the state", () => {
  const state = guardState();
  const before = structuredClone(state);
  const source = createCandidateSource("peel");
  const first = source.candidates(state);
  assert.equal(source.id, "peel-candidates:v1");
  assert.ok(first.length > 0);
  assert.deepEqual(source.candidates(state), first);
  assert.deepEqual(state, before);
});

test("rule simulation isolates valid results and atomically rejects stale plans", () => {
  const state = standardState();
  const before = structuredClone(state);
  const plan = planForDoctrine(state, "tunnel");
  const result = rulePlanSimulator.apply(state, plan);
  assert.ok(result);
  assert.notEqual(result, state);
  assert.deepEqual(state, before);
  assert.equal(rulePlanSimulator.apply(state, { ...plan, revision: plan.revision + 1 }), null);
  assert.deepEqual(state, before);
});

test("planner tie-break uses the stable deterministic key", () => {
  const source: CandidateSource = {
    id: "tie-test",
    candidates: () => [
      { mechId: "Assault", moveTo: null, action: { kind: "skip" } },
      { mechId: "Assault", moveTo: null, action: { kind: "repair", target: "Assault" } },
      { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
      { mechId: "Support", moveTo: null, action: { kind: "skip" } },
    ],
  };
  const scorer: PlanScorer = {
    weightVersion: "tie-test",
    score: (_state, plan) => ({ plan, score: 10, factors: [], deterministicKey: JSON.stringify(plan.items) }),
  };
  const planner = createMatchPlanner("tunnel", source, scorer);
  const plan = planner.plan(standardState());
  assert.equal(plan.items[0]?.action.kind, "repair");
  assert.equal(planner.evaluate(standardState()).length, 3);
});
