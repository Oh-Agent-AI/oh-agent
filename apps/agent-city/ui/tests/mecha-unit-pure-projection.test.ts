import test from "node:test";
import assert from "node:assert/strict";
import { createMatch, bossPrepare } from "../src/game/mecha/rules.ts";
import { unitForSpecies, projectUnitPure } from "../src/game/mecha/unitRegistry.ts";
import type { MonsterSpeciesId } from "../src/game/mecha/board.ts";

for (const speciesId of ["spore_leaper", "flux_lancer", "porous_shaper", "prism_warden", "swarm_mantle", "phase_stalker", "gravity_core", "neural_weaver"] as MonsterSpeciesId[]) {
  test(`${speciesId} projection isolates its input and matches existing projection`, () => {
    const state = createMatch({ preset: "covers_sparse_mid", script: "siege", monsterContent: { speciesId, contentVersion: 1 } });
    bossPrepare(state);
    const intent = state.boss.intent!;
    const unit = unitForSpecies(speciesId)!;
    const before = structuredClone({ state, intent });
    const actual = projectUnitPure(unit, state, intent);
    assert.deepEqual({ state, intent }, before);
    const expected = structuredClone(before);
    unit.project(expected.state, expected.intent);
    assert.deepEqual(actual, expected.intent);
  });
}
