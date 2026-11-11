import assert from "node:assert/strict";
import test from "node:test";
import { createMechaController, type MechaControllerState, type Planner } from "../src/game/mecha/controller.ts";
import { bossPrepare, collectTelegraphs, createMatch, living, previewPlan, type ArenaPlan, type MatchState } from "../src/game/mecha/rules.ts";

const hold = (state: MatchState): ArenaPlan => ({
  revision: state.revision,
  items: living(state).map((mech) => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" as const } })),
});
function duel(): MatchState {
  const state = createMatch({
    preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }],
  });
  bossPrepare(state);
  return state;
}
function assertThreatContract(state: MechaControllerState) {
  assert.deepEqual(state.declaredThreats, collectTelegraphs(state.match));
  assert.equal(state.preview.revision, state.match.revision);
  if (state.preview.ok) {
    assert.equal(state.preview.status, "ready");
    assert.deepEqual(state.projectedThreats, { cells: state.preview.telegraphAfter, byActor: state.preview.telegraphByActor });
  } else assert.equal(state.projectedThreats, null);
  assert.deepEqual(state.telegraph, (state.projectedThreats ?? state.declaredThreats).cells);
}

test("current draft excludes candidate projections and reflects a committed shove", () => {
  const c = createMechaController({ match: duel(), planner: hold });
  const initial = c.getState();
  assertThreatContract(initial);
  assert.deepEqual(initial.declaredThreats.byActor.boss, [{ x: 3, y: 1 }]);
  assert.deepEqual(initial.projectedThreats?.byActor.boss, [{ x: 3, y: 1 }]);
  c.setTargeting("melee");
  c.previewTarget("boss", "selection");
  const candidate = c.getState();
  assert.ok(candidate.candidate?.preview.ok);
  assert.deepEqual(candidate.candidate.preview.telegraphByActor.boss, [{ x: 4, y: 1 }]);
  assert.deepEqual(candidate.projectedThreats, initial.projectedThreats);
  assert.equal(candidate.preview.draftVersion, initial.preview.draftVersion);
  c.confirmTarget();
  const changed = c.getState();
  assertThreatContract(changed);
  assert.ok(changed.preview.draftVersion > initial.preview.draftVersion);
  assert.deepEqual(changed.declaredThreats, initial.declaredThreats);
  assert.deepEqual(changed.projectedThreats?.byActor.boss, [{ x: 4, y: 1 }]);
  c.setHoveredEnemy("boss");
  assert.deepEqual(c.getState().focusedTelegraph, [{ x: 4, y: 1 }]);
});

test("successful empty projection is not unknown when the draft defeats the enemy", () => {
  const match = duel();
  match.boss.hp = 1;
  const c = createMechaController({ match, planner: hold });
  c.setAction("Assault", { kind: "melee", target: "boss" });
  const state = c.getState();
  assertThreatContract(state);
  assert.ok(state.declaredThreats.cells.length > 0);
  assert.ok(state.preview.ok && state.preview.outcome === "victory");
  assert.deepEqual(state.projectedThreats, { cells: [], byActor: {} });
  assert.deepEqual(state.telegraph, []);
  c.submit();
  const finished = c.getState();
  assertThreatContract(finished);
  assert.equal(finished.match.outcome, "victory");
  assert.equal(finished.preview.status, "invalid");
  assert.equal(finished.projectedThreats, null, "a finished match has no current draft prediction");
});

test("prediction removes a defeated raider while retaining the boss threat", () => {
  const match = createMatch({
    preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], boss: { x: 4, y: 0 },
    raiders: [{ id: "r1", pos: { x: 3, y: 6 }, hp: 1 }],
    mechs: [{ id: "Assault", pos: { x: 3, y: 7 } }, { id: "Gunner", pos: { x: 8, y: 8 } }, { id: "Support", pos: { x: 9, y: 9 } }],
  });
  bossPrepare(match);
  const c = createMechaController({ match, planner: hold });
  assert.ok(c.getState().declaredThreats.byActor.r1?.length);
  c.setSelectedEnemy("r1");
  assert.equal(c.getState().selectedEnemy, "r1");
  c.setAction("Assault", { kind: "melee", target: "r1" });
  const state = c.getState();
  assertThreatContract(state);
  assert.equal(state.draft.Assault.action.kind, "melee");
  assert.ok(state.declaredThreats.byActor.r1?.length);
  assert.equal(state.projectedThreats?.byActor.r1, undefined);
  assert.equal(state.selectedEnemy, "r1", "the living declaration remains inspectable when the draft predicts a kill");
  assert.ok(state.projectedThreats?.byActor.boss?.length);
  assert.ok(state.preview.ok && !state.preview.enemyOrder.some((event) => event.actor === "r1"));
});

test("invalid draft prediction is unknown until a valid draft replaces it", () => {
  const invalid: Planner = (state) => {
    const plan = hold(state);
    plan.items.find((item) => item.mechId === "Gunner")!.action = { kind: "melee", target: "boss" };
    return plan;
  };
  const c = createMechaController({ match: duel(), planner: invalid });
  const first = c.getState();
  assertThreatContract(first);
  assert.equal(first.preview.status, "invalid");
  assert.equal(first.projectedThreats, null);
  assert.ok(first.declaredThreats.cells.length);
  c.setHoveredEnemy("boss");
  assert.deepEqual(c.getState().focusedTelegraph, first.declaredThreats.byActor.boss);
  c.setAction("Gunner", { kind: "skip" });
  const recovered = c.getState();
  assertThreatContract(recovered);
  assert.equal(recovered.preview.status, "ready");
  assert.ok(recovered.preview.draftVersion > first.preview.draftVersion);
  assert.notEqual(recovered.projectedThreats, null);
});

test("failed preview after a draft change cannot reuse a stale prediction and may recover", () => {
  let fail = false;
  const c = createMechaController({ match: duel(), planner: hold, preview: (state, plan) => {
    if (fail) throw new Error("synthetic prediction failure");
    return previewPlan(state, plan);
  } });
  const first = c.getState();
  assertThreatContract(first);
  assert.notEqual(first.projectedThreats, null);
  fail = true;
  c.setMove("Gunner", { x: 0, y: 8 });
  const failed = c.getState();
  assertThreatContract(failed);
  assert.equal(failed.preview.status, "unavailable");
  assert.ok(failed.preview.draftVersion > first.preview.draftVersion);
  assert.equal(failed.hits, null);
  assert.deepEqual(failed.declaredThreats, first.declaredThreats);
  fail = false;
  c.setHoveredEnemy("boss");
  const recovered = c.getState();
  assertThreatContract(recovered);
  assert.equal(recovered.preview.status, "ready");
  assert.equal(recovered.preview.draftVersion, failed.preview.draftVersion);
});

test("partial drafts preserve wait assumptions and next-turn revision invalidates the projection", () => {
  const partial: Planner = (state) => ({ revision: state.revision, items: hold(state).items.filter((item) => item.mechId === "Gunner") });
  const c = createMechaController({ match: duel(), planner: partial });
  const initial = c.getState();
  assertThreatContract(initial);
  assert.ok(initial.preview.ok);
  assert.deepEqual(initial.preview.assumed, ["Assault", "Support"]);
  c.setMove("Support", { x: 8, y: 8 });
  const moved = c.getState();
  assertThreatContract(moved);
  assert.ok(moved.preview.ok);
  assert.deepEqual(moved.preview.assumed, ["Assault", "Support"]);
  assert.ok(moved.preview.draftVersion > initial.preview.draftVersion);
  c.setAction("Assault", { kind: "skip" });
  c.setAction("Support", { kind: "skip" });
  const ready = c.getState();
  assert.ok(ready.preview.ok);
  assert.deepEqual(ready.preview.assumed, []);
  c.submit();
  const next = c.getState();
  assertThreatContract(next);
  assert.ok(next.match.revision > ready.match.revision);
  assert.ok(next.preview.draftVersion > ready.preview.draftVersion);
  assert.ok(next.preview.ok);
  assert.deepEqual(next.preview.assumed, living(next.match).map((mech) => mech.id));
});


test("restarting invalidates the projection even when the new match has the same revision", () => {
  const c = createMechaController({ match: duel(), planner: hold });
  const before = c.getState();
  assertThreatContract(before);
  c.restart({ script: "siege" });
  const after = c.getState();
  assertThreatContract(after);
  assert.notEqual(after.match, before.match);
  assert.equal(after.match.revision, before.match.revision);
  assert.ok(after.preview.draftVersion > before.preview.draftVersion);
  assert.notDeepEqual(after.declaredThreats, before.declaredThreats);
  assert.notDeepEqual(after.projectedThreats, before.projectedThreats);
});

test("idle living enemies remain inspectable; dead and unknown selections clear", () => {
  const match = duel(); match.boss.intent = null;
  const c = createMechaController({ match, planner: hold });
  c.setSelectedEnemy("boss");
  assert.equal(c.getState().selectedEnemy, "boss");
  c.setSelectedEnemy("missing");
  assert.equal(c.getState().selectedEnemy, null);
  match.boss.hp = 0;
  c.setSelectedEnemy("boss");
  assert.equal(c.getState().selectedEnemy, null);
});
