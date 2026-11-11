import test from "node:test";
import assert from "node:assert/strict";
import {
  MONSTER_CATALOG, STATUS_SPECIES, catalogSupports, isStatusSpecies, monsterCatalogEntry, practiceSpecies, statusKindOf, statusSpecies,
} from "../src/game/mecha/monsters/catalog.ts";
import { PLANNED_MONSTER_SPECIES_IDS, PLANNED_SIGNATURE_SKILLS } from "../src/game/mecha/monsters/contracts.ts";
import { MONSTER_SKILLS, MONSTER_SPECIES_IDS } from "../src/game/mecha/board.ts";
import { isMonsterSpeciesDesign } from "../src/render/mecha/monsterSpeciesOrnaments.ts";
import { lookupMonsterDefinition } from "../src/game/mecha/monsters/registry.ts";

test("the catalog covers every planned species exactly once", () => {
  assert.equal(MONSTER_CATALOG.length, PLANNED_MONSTER_SPECIES_IDS.length);
  assert.equal(new Set(MONSTER_CATALOG.map(entry => entry.id)).size, MONSTER_CATALOG.length);
  for (const id of PLANNED_MONSTER_SPECIES_IDS) assert.ok(monsterCatalogEntry(id), id);
  for (const entry of MONSTER_CATALOG) {
    assert.equal(entry.skillId, PLANNED_SIGNATURE_SKILLS[entry.id]);
    assert.equal(isMonsterSpeciesDesign(entry.visualKey), true, `${entry.id} visualKey`);
    assert.ok(entry.supportedRulesets.length > 0);
  }
});

test("runtime monster skill map is derived from the canonical skill table", () => {
  assert.deepEqual(Object.keys(MONSTER_SKILLS), [...MONSTER_SPECIES_IDS]);
  for (const id of MONSTER_SPECIES_IDS) assert.equal(MONSTER_SKILLS[id], PLANNED_SIGNATURE_SKILLS[id]);
  assert.equal(Object.hasOwn(MONSTER_SKILLS, "many_core"), false);
  assert.equal(Object.hasOwn(MONSTER_SKILLS, "field_sovereign"), false);
});

test("status species are the only v1.5-capable species and keep their status kind", () => {
  assert.deepEqual([...statusSpecies()].sort(), [...STATUS_SPECIES].sort());
  for (const id of STATUS_SPECIES) {
    assert.equal(isStatusSpecies(id), true);
    assert.equal(catalogSupports(id, "mecha-v1.5"), true);
    assert.ok(statusKindOf(id));
  }
  for (const entry of MONSTER_CATALOG) {
    assert.equal(catalogSupports(entry.id, "mecha-v1.5"), entry.practice, entry.id);
  }
  assert.equal(isStatusSpecies("legacy_boss"), false);
  assert.equal(catalogSupports("legacy_boss", "mecha-v1.5"), false);
  assert.equal(monsterCatalogEntry("unknown_species"), undefined);
});

test("practice and registry definitions derive from the same catalog facts", () => {
  assert.deepEqual(practiceSpecies(), [
    "spore_leaper", "flux_lancer", "porous_shaper", "prism_warden",
    "swarm_mantle", "phase_stalker", "gravity_core", "neural_weaver",
  ]);
  for (const entry of MONSTER_CATALOG) {
    const lookup = lookupMonsterDefinition("mecha-v1.4", 1, entry.id);
    assert.ok(lookup.ok, entry.id);
    if (!lookup.ok || lookup.definition.kind !== "planned_species") continue;
    assert.equal(lookup.definition.name, entry.name);
    assert.equal(lookup.definition.threatLevel, entry.threatLevel);
    assert.equal(lookup.definition.deliveryMilestone, entry.deliveryMilestone);
    assert.equal(lookup.definition.signatureSkill.id, entry.skillId);
  }
});
