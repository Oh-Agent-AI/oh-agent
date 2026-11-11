import assert from "node:assert/strict";
import test from "node:test";
import { MECH_IDS } from "../src/game/mecha/board.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { createMechaController } from "../src/game/mecha/controller.ts";
import { deployableCells } from "../src/game/mecha/deployment.ts";

const site: CityMechaSite = {
  originX: 7, originZ: 4, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)), buildings: [], blocked: [],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
  boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
};

test("local rescue mode survives restart, starts with manual planning, and can be switched off", () => {
  let plannerCalls = 0;
  const controller = createMechaController({ site, script: "stationary_smash", planner: () => { plannerCalls++; throw new Error("legacy planner must not run for rescue"); } });
  assert.equal(controller.getState().match.mission, undefined);
  assert.equal(controller.restart({ mission: "rescue:v1" }), true);
  let state = controller.getState();
  assert.equal(state.match.phase, "deployment");
  assert.equal(state.match.mission?.kind, "rescue:v1");
  const cells = deployableCells(state.match);
  MECH_IDS.forEach((id, i) => controller.placeMech(id, cells[i]!));
  assert.equal(controller.getState().deployment?.canConfirm, true);
  controller.confirmDeployment();
  state = controller.getState();
  assert.equal(state.match.phase, "player_plan");
  assert.equal(state.openingSuggestion, false);
  controller.applyDoctrine(); controller.requestDoctrineSuggestion(); controller.startAuto(); controller.tick();
  assert.equal(plannerCalls, 0);
  assert.equal(controller.getState().auto, false);
  assert.equal(controller.getState().match.phase, "player_plan");
  assert.equal(controller.restart(), true);
  assert.equal(controller.getState().match.mission?.kind, "rescue:v1");
  assert.equal(controller.getState().match.phase, "deployment");
  assert.equal(controller.restart({ mission: null }), true);
  assert.equal(controller.getState().match.mission, undefined);
});

test("unavailable rescue site rejects restart without replacing current match or configuration", () => {
  const controller = createMechaController({ site, script: "stationary_smash" });
  const before = controller.getState();
  const blockedSite: CityMechaSite = { ...site, blocked: Array.from({ length: 100 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10) })) };
  assert.equal(controller.restart({ mission: "rescue:v1", site: blockedSite, script: "siege" }), false);
  const after = controller.getState();
  assert.equal(after.match, before.match);
  assert.equal(after.site, before.site);
  assert.equal(after.script, before.script);
  assert.equal(after.replayAvailable, before.replayAvailable);
  assert.deepEqual(after.draft, before.draft);
  assert.match(after.notice ?? "", /没有可达的救援点/);
});
