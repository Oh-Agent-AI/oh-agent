import test from "node:test";
import assert from "node:assert/strict";
import { createMatch } from "../src/game/mecha/rules.ts";
import { statusForecast } from "../src/game/mecha/statusForecast.ts";

function fixture() {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [] });
  state.statusEncounter = { schema: "mecha-status-encounter:v1", statuses: [] };
  return state;
}

test("status forecast reports only active declarations and never mutates them", () => {
  const state = fixture();
  for (const skill of ["spore_leap", "ring_pierce", "prism_frost"] as const) {
    state.boss.intent = { skillId: skill, local: [], projected: [{ x: 2, y: 3 }, { x: -1, y: 0 }], cdSweep: 0, status: "planned" };
    const before = structuredClone(state), forecast = statusForecast(state);
    assert.deepEqual(forecast, { skill, cells: [{ x: 2, y: 3 }], pulls: null });
    forecast!.cells[0]!.x = 9;
    assert.deepEqual(state, before);
    state.boss.intent.status = "void"; assert.equal(statusForecast(state), null);
  }
  state.boss.intent = { skillId: "prism_guard", local: [], projected: [], cdSweep: 0, status: "planned" };
  assert.equal(statusForecast(state), null);
  state.statusEncounter = undefined; assert.equal(statusForecast(state), null);
});

test("gravity forecast distinguishes unknown, movement and evidenced collision", () => {
  const state = fixture(), unit = state.mechs[0]!;
  state.boss.intent = { skillId: "gravity_well", local: [], projected: [], cdSweep: 0, status: "planned" };
  assert.equal(statusForecast(state)?.pulls, null);
  state.boss.intent.displacementProjection = { status: "reprojected", reason: null, attackCells: [], effects: [
    { entityId: `mech:${unit.id}`, status: "move", reason: null, from: { ...unit.pos }, to: { x: 2, y: 2 }, path: [{ x: 2, y: 2 }] },
    { entityId: "mech:missing", status: "void", reason: "obstacle", from: { ...unit.pos }, to: null, path: [] },
  ] };
  assert.deepEqual(statusForecast(state)?.pulls, [{ mech: unit.id, from: unit.pos, to: { x: 2, y: 2 }, collision: null }]);
  state.boss.intent.displacementProjection = { status: "reprojected", reason: null, attackCells: [], effects: [
    { entityId: `mech:${unit.id}`, status: "void", reason: "obstacle", from: { ...unit.pos }, to: null, path: [{ x: 2, y: 2 }], collision: { cell: { x: 2, y: 2 }, blocker: { kind: "obstacle", id: "2,2" } } },
  ] };
  assert.deepEqual(statusForecast(state)?.pulls, [{ mech: unit.id, from: unit.pos, to: null, collision: { x: 2, y: 2 } }]);
  unit.pos.x++; assert.deepEqual(statusForecast(state)?.pulls, []);
});
