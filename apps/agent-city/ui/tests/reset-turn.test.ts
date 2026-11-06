import assert from "node:assert/strict";
import test from "node:test";
import { createMechaController, type Planner } from "../src/game/mecha/controller.ts";
import { bossPrepare, createMatch, living } from "../src/game/mecha/rules.ts";

const hold: Planner = (state) => ({ revision: state.revision, items: living(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) });
function controller(animate = false) {
  const match = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [] });
  bossPrepare(match);
  return createMechaController({ match, planner: hold, animate });
}

test("reset restores the opening draft without changing the match and is once per match", () => {
  const c = controller();
  const initial = c.getState();
  const original = structuredClone(initial.draft);
  const cell = initial.reach.find((p) => p.x !== initial.match.mechs[0]!.pos.x || p.y !== initial.match.mechs[0]!.pos.y)!;
  c.setMove(initial.selected, cell);
  assert.equal(c.getState().canUndoMove, true);
  c.setTargeting("melee");
  c.setHoveredEnemy("boss");
  c.resetTurn();
  const reset = c.getState();
  assert.equal(reset.match, initial.match);
  assert.deepEqual(reset.draft, original);
  assert.equal(reset.targeting, null);
  assert.equal(reset.hoveredEnemy, null);
  assert.equal(reset.canUndoMove, false);
  assert.equal(reset.canResetTurn, false);
  assert.equal(reset.resetTurnUsed, true);
  c.setLocale("en");
  assert.match(c.getState().notice!, /reset/i);
  c.setMove(initial.selected, cell);
  const changed = c.getState();
  c.resetTurn();
  assert.equal(c.getState(), changed);
  c.submit();
  assert.equal(c.getState().resetTurnUsed, true);
  assert.equal(c.getState().canResetTurn, false);
  c.restart();
  assert.equal(c.getState().resetTurnUsed, false);
  assert.equal(c.getState().canResetTurn, true);
});

test("reset is gated during auto, pause and playback; next turn starts blank", () => {
  const c = controller(true);
  c.startAuto();
  c.resetTurn();
  assert.equal(c.getState().resetTurnUsed, false);
  c.stopAuto();
  c.pause();
  c.resetTurn();
  assert.equal(c.getState().resetTurnUsed, false);
  c.resume();
  c.submit();
  assert.ok(c.getState().performance);
  const resolved = c.getState().match;
  c.resetTurn();
  assert.equal(c.getState().resetTurnUsed, false);
  c.finishPerformance();
  c.applyDoctrine();
  c.resetTurn();
  assert.equal(c.getState().match, resolved);
  assert.ok(Object.values(c.getState().draft).every((d) => !d.explicit && !d.moveTo));
  assert.equal(c.getState().resetTurnUsed, true);
});
