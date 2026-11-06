import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch, type MonsterSpeciesId } from "../src/game/mecha/rules.ts";
import { buildPresentationChanges } from "../src/game/mecha/presentationChanges.ts";
import { buildHealthTimeline } from "../src/game/mecha/healthTimeline.ts";
import { performanceFromLog } from "../src/game/mecha/performance.ts";
import { SequentialTurn } from "../src/game/mecha/sequentialTurn.ts";
import { sequentialPresentation } from "../src/game/mecha/sequentialPresentation.ts";

function fixture(speciesId: MonsterSpeciesId) {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 4 }, covers: [],
    mechs: [{ id: "Assault", pos: { x: 4, y: 7 } }, { id: "Gunner", pos: { x: 4, y: 8 } }, { id: "Support", pos: { x: 0, y: 9 } }],
    raiders: speciesId === "neural_weaver" ? [{ id: "r1", pos: { x: 3, y: 4 } }] : [], monsterContent: { speciesId, contentVersion: 1 } });
  bossPrepare(state); return state;
}
for (const species of ["spore_leaper", "flux_lancer", "porous_shaper", "phase_stalker", "gravity_core", "swarm_mantle", "neural_weaver", "prism_warden"] as const) {
  test(`v1.5 ${species} enemy command carries verifiable presentation evidence`, () => {
    const before = fixture(species), turn = new SequentialTurn(before);
    const result = turn.execute({ kind: "end", id: "end", revision: before.revision, confirmUnused: true });
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(result.presentationStages);
    const changes = buildPresentationChanges(result.presentationStages, result.events);
    assert.ok(changes.ok, JSON.stringify({ species, changes, events: result.events }));
    const health = buildHealthTimeline(before, result.snapshot.match, result.events, result.presentationStages);
    assert.ok(health.ok, JSON.stringify({ species, health }));
    const animation = performanceFromLog(before, result.snapshot.match, result.events, { healthTimeline: health, presentationChanges: changes });
    const verified = sequentialPresentation(before, result.snapshot.match, result.events, result.presentationStages);
    assert.ok(verified.ok, JSON.stringify({ species, verified }));
    if (["phase_stalker", "gravity_core"].includes(species)) assert.ok(animation.some(event => event.kind === "monster_displacement"));
    if (species === "porous_shaper") assert.ok(animation.some(event => event.kind === "corrode_field"));
    assert.deepEqual(SequentialTurn.replay(before, turn.records()).snapshot(), turn.snapshot());
  });
}

test("charge into a building reconciles both collision victims and ordered presentation", () => {
  const before = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], raiders: [],
    boss: { x: 4, y: 4 }, buildings: [{ id: "tower", cells: [{ x: 6, y: 4 }, { x: 6, y: 5 }], hp: 5 }],
    mechs: [{ id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }] });
  bossPrepare(before); const turn = new SequentialTurn(before);
  const result = turn.execute({ kind: "act", id: "charge", revision: before.revision, mech: "Assault", action: { kind: "charge", target: "boss" } });
  assert.ok(result.ok); assert.ok(result.presentationStages);
  const changes = buildPresentationChanges(result.presentationStages, result.events);
  const health = buildHealthTimeline(before, result.snapshot.match, result.events, result.presentationStages);
  assert.ok(changes.ok, JSON.stringify(changes)); assert.ok(health.ok, JSON.stringify(health));
  assert.equal(result.snapshot.match.buildings[0]!.hp, 3);
  assert.ok(health.steps.some(step => step.effect.kind === "building" && step.effect.before === 5 && step.effect.after === 3));
  assert.ok(health.steps.some(step => step.effect.kind === "boss"));
  const stages = structuredClone(result.presentationStages); stages.afterPrepare.boss.hp++;
  assert.deepEqual(sequentialPresentation(before, result.snapshot.match, result.events, stages), { ok: false, reason: "stage_boundary_mismatch" });
  assert.equal(sequentialPresentation(before, result.snapshot.match, [], result.presentationStages).ok, false);
});
