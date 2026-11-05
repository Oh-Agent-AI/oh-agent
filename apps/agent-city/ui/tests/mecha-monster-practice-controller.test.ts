import assert from "node:assert/strict";
import test from "node:test";
import { MECH_IDS } from "../src/game/mecha/board.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { createMechaController } from "../src/game/mecha/controller.ts";
import { deployableCells } from "../src/game/mecha/deployment.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { remoteStateFromSite } from "../src/game/mecha/contracts/arena.ts";
import { PLANNED_SIGNATURE_SKILLS, type PlannedMonsterSpeciesId } from "../src/game/mecha/monsters/contracts.ts";

const site: CityMechaSite = {
  originX: 7, originZ: 4, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)), buildings: [], blocked: [],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
  boss: { x: 4, y: 1 }, raiders: [], spawnSpread: 0,
};
const opts = { preset: "covers_sparse_mid", script: "stationary_smash", deployment: true } as const;
const playable: PlannedMonsterSpeciesId[] = ["spore_leaper", "flux_lancer", "porous_shaper", "prism_warden", "swarm_mantle", "phase_stalker", "gravity_core"];

function deploy(controller: ReturnType<typeof createMechaController>) {
  const cells = deployableCells(controller.getState().match);
  MECH_IDS.forEach((id, i) => controller.placeMech(id, cells[i]!));
  assert.equal(controller.getState().deployment?.canConfirm, true);
  controller.confirmDeployment();
  assert.equal(controller.getState().match.phase, "player_plan");
}

test("site adapter forwards explicit monster content but leaves legacy states unchanged", () => {
  const legacy = matchFromSite(site, opts);
  assert.equal(Object.hasOwn(legacy, "monsterContent"), false);
  for (const speciesId of playable) {
    const state = matchFromSite(site, { ...opts, monsterContent: { speciesId, contentVersion: 1 } });
    assert.deepEqual(state.monsterContent, { speciesId, contentVersion: 1 });
    assert.equal(state.phase, "deployment");
    assert.throws(() => remoteStateFromSite(site, state), /remote_match_unsupported/);
  }
});

for (const speciesId of playable) {
  test(`${speciesId}: actual deployment, signature intent, turn resolution, reset and switch back`, () => {
    const controller = createMechaController({ site, script: "stationary_smash" });
    const legacy = controller.getState().match;
    assert.equal(Object.hasOwn(legacy, "monsterContent"), false);
    assert.equal(controller.restart({ mission: null, monsterContent: { speciesId, contentVersion: 1 } }), true);
    assert.notEqual(controller.getState().match, legacy);
    assert.equal(controller.getState().match.phase, "deployment");
    deploy(controller);
    const before = controller.getState().match;
    assert.equal(before.boss.intent?.skillId, PLANNED_SIGNATURE_SKILLS[speciesId]);
    for (const mech of before.mechs.filter(m => m.hp > 0)) controller.setAction(mech.id, { kind: "skip" });
    assert.equal(controller.getState().packReady, true);
    controller.submit();
    if (controller.getState().holdConfirmation) controller.confirmHold();
    const after = controller.getState().match;
    assert.ok(after.revision > before.revision, "authoritative turn must advance");
    assert.ok(controller.getState().lastLog.length > 0, "turn must emit real events");
    assert.equal(after.monsterContent?.speciesId, speciesId);
    assert.equal(controller.restart(), true);
    assert.equal(controller.getState().match.monsterContent?.speciesId, speciesId);
    assert.equal(controller.getState().match.phase, "deployment");
    assert.equal(controller.restart({ monsterContent: null }), true);
    assert.equal(Object.hasOwn(controller.getState().match, "monsterContent"), false);
    assert.equal(controller.getState().match.phase, "deployment");
  });
}

test("unsupported content and incompatible rescue preserve the current match and restart configuration", () => {
  const controller = createMechaController({ site, script: "stationary_smash" });
  const before = controller.getState().match;
  assert.equal(controller.restart({ monsterContent: { speciesId: "__unknown__" as PlannedMonsterSpeciesId, contentVersion: 1 } }), false);
  assert.equal(controller.getState().match, before);
  assert.equal(controller.restart({ mission: "rescue:v1", monsterContent: { speciesId: "spore_leaper", contentVersion: 1 } }), false);
  assert.equal(controller.getState().match, before);
  assert.equal(controller.restart(), true);
  assert.equal(Object.hasOwn(controller.getState().match, "monsterContent"), false);
});


test("switching species and sites retains only the last accepted choice", () => {
  const controller = createMechaController({ site, script: "stationary_smash" });
  const choice = { speciesId: "spore_leaper", contentVersion: 1 } as { speciesId: PlannedMonsterSpeciesId; contentVersion: 1 };
  assert.equal(controller.restart({ monsterContent: choice }), true);
  choice.speciesId = "porous_shaper";
  assert.equal(controller.restart(), true);
  assert.equal(controller.getState().match.monsterContent?.speciesId, "spore_leaper");
  const otherSite = { ...site, originX: site.originX + 5 };
  assert.equal(controller.restart({ site: otherSite, script: "cadence_ssw" }), true);
  assert.equal(controller.getState().site, otherSite);
  assert.equal(controller.getState().match.monsterContent?.speciesId, "spore_leaper");
  assert.equal(controller.restart({ monsterContent: { speciesId: "flux_lancer", contentVersion: 1 } }), true);
  assert.equal(controller.getState().match.monsterContent?.speciesId, "flux_lancer");
  deploy(controller);
  assert.equal(controller.getState().match.boss.intent?.skillId, "ring_pierce");
});

for (const speciesId of ["porous_shaper", "phase_stalker", "gravity_core"] as const) {
  test(`${speciesId}: real close-range deployment resolves its bound skill and matches the preview`, () => {
    const closeSite: CityMechaSite = { ...site, boss: { x: 4, y: 4 },
      mechs: [{ id: "Assault", pos: { x: 4, y: 7 } }, { id: "Gunner", pos: { x: 4, y: 8 } }, { id: "Support", pos: { x: 0, y: 9 } }] };
    const controller = createMechaController({ site: closeSite, script: "stationary_smash", animate: false });
    assert.equal(controller.restart({ monsterContent: { speciesId, contentVersion: 1 } }), true);
    for (const mech of closeSite.mechs) controller.placeMech(mech.id, mech.pos);
    assert.equal(controller.getState().deployment?.canConfirm, true);
    controller.confirmDeployment();
    const initial = controller.getState().match;
    const intent = structuredClone(initial.boss.intent);
    assert.equal(intent?.status, "planned");
    for (const mech of initial.mechs) controller.setAction(mech.id, { kind: "skip" });
    const preview = controller.getState().preview;
    assert.ok(preview.ok && preview.monsterProjection);
    controller.submit();
    if (controller.getState().holdConfirmation) controller.confirmHold();
    const settled = controller.getState();
    assert.deepEqual(settled.lastLog, preview.log);
    assert.deepEqual(settled.combat.presentationStages, preview.stages);
    assert.equal(settled.match.outcome, preview.outcome);
    assert.ok(settled.replayAvailable > 0);
    if (speciesId === "porous_shaper") {
      const created = settled.lastLog.find(event => event.type === "corrode_field" && event.change === "created");
      assert.ok(created && created.type === "corrode_field");
      assert.deepEqual(created.field.cell, intent!.corrode!.target);
    } else {
      assert.deepEqual(preview.monsterProjection.displacement!.request.targetIds, intent!.displacement!.request.targetIds);
      const moves = settled.lastLog.filter(event => event.type === "monster_displacement");
      assert.ok(moves.length);
      const projected = preview.monsterProjection.displacementProjection!.effects.filter(effect => effect.status === "move");
      assert.deepEqual(moves.flatMap(event => event.type === "monster_displacement" ? event.moves.map(move => [move.unit, move.to]) : []),
        projected.map(effect => [effect.entityId, effect.to]));
    }
  });
}

test("built-in planning degrades to manual play for swarm and neural encounters", () => {
  const controller = createMechaController({ site, script: "stationary_smash" });
  for (const speciesId of ["swarm_mantle", "neural_weaver"] as const) {
    assert.equal(controller.restart({ monsterContent: { speciesId, contentVersion: 1 } }), true);
    assert.equal(controller.getState().aiAvailable, false);
    deploy(controller);
    const before = controller.getState();
    assert.equal(before.openingSuggestion, false);
    assert.ok(Object.values(before.draft).every(order => !order.explicit));
    controller.requestDoctrineSuggestion();
    controller.applyDoctrine();
    controller.startAuto();
    controller.tick();
    const after = controller.getState();
    assert.equal(after.doctrineConfirmation, false);
    assert.equal(after.auto, false);
    assert.deepEqual(after.draft, before.draft);
    assert.equal(after.match.revision, before.match.revision);
    for (const mech of after.match.mechs.filter(m => m.hp > 0)) controller.setAction(mech.id, { kind: "skip" });
    assert.equal(controller.getState().packReady, true, "manual planning remains available");
  }
  assert.equal(controller.restart({ monsterContent: null }), true);
  assert.equal(controller.getState().aiAvailable, true);
});

test("explicitly supplied planner retains control for a swarm encounter", () => {
  let calls = 0;
  const controller = createMechaController({ site, script: "stationary_smash", planner: state => {
    calls++;
    return { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) };
  } });
  assert.equal(controller.restart({ monsterContent: { speciesId: "swarm_mantle", contentVersion: 1 } }), true);
  deploy(controller);
  assert.equal(controller.getState().aiAvailable, true);
  assert.equal(controller.getState().openingSuggestion, true);
  assert.ok(calls > 0);
  controller.startAuto();
  assert.equal(controller.getState().auto, true);
});

test("swarm practice uses the same preview, authoritative turns, performance and current-match replay", () => {
  const closeSite: CityMechaSite = { ...site, boss: { x: 4, y: 4 },
    mechs: [{ id: "Assault", pos: { x: 4, y: 2 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 1, y: 9 } }] };
  const controller = createMechaController({ site: closeSite, script: "stationary_smash", deployment: false, animate: true,
    monsterContent: { speciesId: "swarm_mantle", contentVersion: 1 } });
  const recorded = [];
  for (let turn = 0; turn < 15 && !controller.getState().match.outcome; turn++) {
    const before = controller.getState().match;
    const target = turn === 1 ? before.raiders[0]?.id : undefined;
    if (turn === 1) assert.ok(target, "the first resolved turn creates a target");
    for (const mech of before.mechs.filter(m => m.hp > 0)) controller.setAction(mech.id,
      target && mech.id === "Assault" ? { kind: "melee", target } : { kind: "skip" });
    assert.equal(controller.getState().packReady, true);
    const preview = controller.getState().preview;
    assert.ok(preview.ok, "a manually planned turn must be previewable");
    controller.submit();
    if (controller.getState().holdConfirmation) controller.confirmHold();
    const state = controller.getState();
    assert.ok(state.match.revision > before.revision);
    assert.deepEqual(state.lastLog, preview.log);
    assert.deepEqual(state.combat.presentationStages, preview.stages);
    if (turn === 0) assert.equal(state.performance?.events.filter(e => e.kind === "raider_spawn").length, 2);
    if (turn === 1) assert.ok(state.performance?.events.some(e => e.kind === "raider_remove" && e.reason === "death"));
    recorded.push(structuredClone(state.lastLog));
    controller.finishPerformance();
  }
  const final = controller.getState().match;
  assert.ok(final.outcome);
  assert.equal(controller.getState().replayAvailable, recorded.length);
  controller.startReplay();
  for (let i = 0; i < recorded.length; i++) {
    const state = controller.getState();
    assert.equal(state.replay?.index, i);
    assert.deepEqual(state.replay?.log, recorded[i]);
    assert.equal(state.match, final, "replay must not change the authoritative match");
    controller.finishPerformance();
  }
  assert.equal(controller.getState().replay, null);
  assert.equal(controller.getState().match, final);
});
