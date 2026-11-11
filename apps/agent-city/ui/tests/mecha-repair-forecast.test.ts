import assert from "node:assert/strict";
import { test } from "node:test";
import { createMatch, bossPrepare, living, type ArenaPlan, type MatchState } from "../src/game/mecha/rules.ts";
import { createMechaController } from "../src/game/mecha/controller.ts";
import { repairEnemyStage, repairEnemyStageComparison } from "../src/game/mecha/repairForecast.ts";

const hold = (state: MatchState): ArenaPlan => ({ revision: state.revision, items: living(state).map(mech => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" } })) });
function forecast(hp = 2) {
  const match = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 3 },
    mechs: [{ id: "Assault", pos: { x: 0, y: 9 } }, { id: "Gunner", pos: { x: 3, y: 4 } }, { id: "Support", pos: { x: 2, y: 5 } }] });
  match.mechs.find(mech => mech.id === "Gunner")!.hp = hp;
  bossPrepare(match);
  const controller = createMechaController({ match, planner: hold });
  controller.selectMech("Support"); controller.setTargeting("repair"); controller.previewTarget("Gunner", "selection");
  const state = controller.getState();
  assert.ok(state.preview.ok && state.candidate?.preview.ok);
  return { baseline: state.preview, candidate: state.candidate.preview };
}

test("real repair preview observes enemy-stage HP without assigning causation", () => {
  const { baseline, candidate } = forecast();
  assert.deepEqual(repairEnemyStage(baseline, "Gunner"), { status: "resolved", before: 2, after: 0 });
  assert.deepEqual(repairEnemyStage(candidate, "Gunner"), { status: "resolved", before: 6, after: 1 });
  assert.equal(candidate.enemyOrder[0]?.damage, 5);
  const result = repairEnemyStageComparison(baseline, candidate, "Gunner");
  assert.equal(result.status, "ready");
});


test("real repair can still fail to prevent destruction", () => {
  const { candidate } = forecast(1);
  assert.deepEqual(repairEnemyStage(candidate, "Gunner"), { status: "resolved", before: 5, after: 0 });
});

test("no damage, early end, and pre-enemy destruction remain distinct", () => {
  const { candidate } = forecast();
  assert.ok(candidate.stages);
  const same = structuredClone(candidate);
  same.stages!.afterEnemy.mechs.find(mech => mech.id === "Gunner")!.hp = 6;
  assert.deepEqual(repairEnemyStage(same, "Gunner"), { status: "resolved", before: 6, after: 6 });
  same.stages!.afterPlayer.outcome = "victory";
  assert.deepEqual(repairEnemyStage(same, "Gunner"), { status: "ended" });
  same.stages!.afterPlayer.outcome = null;
  same.stages!.afterPlayer.mechs.find(mech => mech.id === "Gunner")!.hp = 0;
  assert.deepEqual(repairEnemyStage(same, "Gunner"), { status: "already-destroyed" });
});

test("missing snapshots and unmatched previews are unknown, not zero damage", () => {
  const { baseline, candidate } = forecast();
  assert.deepEqual(repairEnemyStage(null, "Gunner"), { status: "unknown" });
  assert.deepEqual(repairEnemyStage({ ...candidate, stages: null }, "Gunner"), { status: "unknown" });
  assert.deepEqual(repairEnemyStage(candidate, "missing"), { status: "unknown" });
  const missing = structuredClone(candidate);
  missing.stages!.afterEnemy.mechs = missing.stages!.afterEnemy.mechs.filter(mech => mech.id !== "Gunner");
  assert.deepEqual(repairEnemyStage(missing, "Gunner"), { status: "unknown" });
  assert.deepEqual(repairEnemyStageComparison(baseline, { ...candidate, draftVersion: candidate.draftVersion + 1 }, "Gunner"), { status: "unknown" });
  assert.deepEqual(repairEnemyStageComparison(baseline, { ...candidate, revision: candidate.revision + 1 }, "Gunner"), { status: "unknown" });
  assert.deepEqual(repairEnemyStageComparison({ ok: false, status: "unavailable", revision: baseline.revision, draftVersion: baseline.draftVersion }, candidate, "Gunner"), { status: "unknown" });
});
