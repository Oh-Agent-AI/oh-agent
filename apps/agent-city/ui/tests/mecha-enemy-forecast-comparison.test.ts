import assert from "node:assert/strict";
import test from "node:test";
import { createMechaController, type MechaPreview } from "../src/game/mecha/controller.ts";
import { compareEnemyForecasts } from "../src/game/mecha/enemyForecastComparison.ts";
import { bossPrepare, createMatch, living, type ArenaPlan, type MatchState, type TurnEvent } from "../src/game/mecha/rules.ts";

type Attack = Extract<TurnEvent, { type: "enemy" }>;
const hold = (state: MatchState): ArenaPlan => ({ revision: state.revision, items: living(state).map(mech => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" } })) });
function forecast(bossHp = 20) {
  const match = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }] });
  match.boss.hp = bossHp; bossPrepare(match);
  const controller = createMechaController({ match, planner: hold });
  controller.setTargeting("melee"); controller.previewTarget("boss", "selection");
  const s = controller.getState();
  assert.ok(s.preview.ok && s.candidate?.preview.ok);
  return { before: s.preview, after: s.candidate.preview };
}
const attack = (actor: string, skill: Attack["skill"], cells: Attack["cells"]): Attack => ({ type: "enemy", actor, skill, cells, damage: 1 });

test("real rule previews show a pushed boss's reprojected cells without mutating either preview", () => {
  const { before, after } = forecast(); const original = structuredClone({ before, after });
  const comparison = compareEnemyForecasts(before, after);
  assert.equal(comparison.status, "ready");
  if (comparison.status !== "ready") return;
  assert.deepEqual(comparison.changes, [{ actor: "boss", kind: "changed", beforeCount: 1, afterCount: 1, beforeSkills: ["smash"], afterSkills: ["smash"], beforeCells: [{ x: 3, y: 1 }], afterCells: [{ x: 4, y: 1 }] }]);
  assert.deepEqual({ before, after }, original);
});

test("real early victory forecasts no further boss attack, without inferring interruption", () => {
  const { before, after } = forecast(1);
  assert.equal(after.outcome, "victory");
  const result = compareEnemyForecasts(before, after);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.changes[0]?.kind, "stopped");
});

test("synthetic multisets handle multiple actors, repeat attacks, skill and cell order", () => {
  const { before, after } = forecast();
  const a = { x: 1, y: 2 }, b = { x: 2, y: 3 };
  const first = { ...before, enemyOrder: [attack("r1", "smash", [a, b]), attack("r1", "smash", [b]), attack("r2", "smash", [a])] };
  const reordered = { ...after, enemyOrder: [attack("r2", "smash", [a]), attack("r1", "smash", [b]), attack("r1", "smash", [b, a, a])] };
  assert.deepEqual(compareEnemyForecasts(first, reordered), { status: "ready", changes: [] });
  const changed = { ...reordered, enemyOrder: [attack("r1", "sweep", [a, b]), attack("r3", "smash", [b])] };
  const result = compareEnemyForecasts(first, changed);
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.deepEqual(result.changes.map(c => [c.actor, c.kind, c.beforeCount, c.afterCount]), [["r1", "changed", 2, 1], ["r2", "stopped", 1, 0], ["r3", "started", 0, 1]]);
  }
});

test("unavailable, invalid and stale predictions are unknown, not no threats", () => {
  const { before, after } = forecast();
  const unavailable: MechaPreview = { ok: false, status: "unavailable", revision: before.revision, draftVersion: before.draftVersion };
  const invalid: MechaPreview = { ok: false, status: "invalid", fault: { code: "PLAN_PACK_REJECTED", reason: "synthetic invalid plan" }, revision: before.revision, draftVersion: before.draftVersion };
  assert.deepEqual(compareEnemyForecasts(null, after), { status: "unknown" });
  assert.deepEqual(compareEnemyForecasts(invalid, after), { status: "unknown" });
  assert.deepEqual(compareEnemyForecasts(before, unavailable), { status: "unknown" });
  assert.deepEqual(compareEnemyForecasts(before, { ...after, revision: after.revision + 1 }), { status: "unknown" });
  assert.deepEqual(compareEnemyForecasts(before, { ...after, draftVersion: after.draftVersion + 1 }), { status: "unknown" });
});

test("synthetic skill changes are detected, but damage and global order are not claimed", () => {
  const { before, after } = forecast(); const cell = { x: 1, y: 1 };
  const a = { ...before, enemyOrder: [attack("boss", "smash", [cell]), attack("r1", "smash", [cell])] };
  const reordered = { ...after, enemyOrder: [{ ...attack("r1", "smash", [cell]), damage: 99 }, attack("boss", "smash", [cell])] };
  assert.deepEqual(compareEnemyForecasts(a, reordered), { status: "ready", changes: [] });
  const skillChange = { ...reordered, enemyOrder: [attack("r1", "sweep", [cell]), attack("boss", "smash", [cell])] };
  const result = compareEnemyForecasts(a, skillChange);
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.deepEqual(result.changes.map(change => [change.actor, change.kind]), [["r1", "changed"]]);
    assert.deepEqual(result.changes[0]?.beforeSkills, ["smash"]);
    assert.deepEqual(result.changes[0]?.afterSkills, ["sweep"]);
  }
});
