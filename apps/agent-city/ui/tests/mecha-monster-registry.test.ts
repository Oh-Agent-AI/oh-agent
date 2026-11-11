import test from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_BOSS_SCRIPT_MAP, LEGACY_BOSS_SKILL_MAP, MONSTER_CONTENT_VERSION_V1, MONSTER_RULESET_V1,
  PLANNED_MONSTER_SPECIES_IDS, PLANNED_SIGNATURE_SKILLS, lookupMonsterDefinition,
  mapLegacyBossScript, mapLegacyBossSkill, resolveEncounterContent,
} from "../src/game/mecha/monsters/index.ts";

const expected = [
  ["spore_leaper", "孢群体", "spore_leap", "孢子弹跳", "M2"],
  ["flux_lancer", "流环体", "ring_pierce", "环轨穿刺", "M2"],
  ["porous_shaper", "孔洞行者", "corrode_cell", "蚀格", "M3"],
  ["prism_warden", "晶簇体", "prism_guard", "棱镜护盾", "M2"],
  ["swarm_mantle", "群构体", "split_swarm", "分群围猎", "M4"],
  ["phase_stalker", "相位体", "phase_swap", "相位交换", "M3"],
  ["gravity_core", "引力核", "gravity_well", "引力井", "M3"],
  ["neural_weaver", "织网体", "neural_link", "神经链接", "M4"],
  ["many_core", "多核生命", "core_migration", "核心迁移", "M5"],
  ["field_sovereign", "场域生命", "space_fold", "空间折叠", "M6"],
] as const;

function lookup(speciesId: unknown) {
  return lookupMonsterDefinition(MONSTER_RULESET_V1, MONSTER_CONTENT_VERSION_V1, speciesId);
}

test("the v1 catalog describes all ten distinct planned species and their fixed signature IDs", () => {
  assert.deepEqual(PLANNED_MONSTER_SPECIES_IDS, expected.map((item) => item[0]));
  assert.equal(new Set(PLANNED_MONSTER_SPECIES_IDS).size, 10);
  assert.equal(new Set(Object.values(PLANNED_SIGNATURE_SKILLS)).size, 10);
  expected.forEach(([id, name, skill, skillName, milestone], index) => {
    const found = lookup(id);
    assert.equal(found.ok, true);
    if (!found.ok || found.definition.kind !== "planned_species") assert.fail(`expected planned species ${id}`);
    const definition = found.definition;
    assert.equal(definition.id, id);
    assert.equal(definition.ruleset, "mecha-v1.4");
    assert.equal(definition.contentVersion, 1);
    assert.equal(definition.threatLevel, index + 1);
    assert.equal(definition.name, name);
    assert.deepEqual(definition.footprint, { width: 2, height: 2 });
    assert.equal(definition.signatureSkill.id, skill);
    assert.equal(definition.signatureSkill.name, skillName);
    assert.ok(definition.signatureSkill.intent);
    assert.ok(definition.signatureSkill.counterplay);
    assert.ok(definition.signatureSkill.rulePrimitive);
    assert.equal(definition.deliveryMilestone, milestone);
    assert.equal("enabled" in definition, false);
    assert.equal("handler" in definition.signatureSkill, false);
  });
});

test("legacy skills and scripts retain their exact distinct identities", () => {
  const result = lookup("legacy_boss");
  assert.equal(result.ok, true);
  if (!result.ok || result.definition.kind !== "legacy_boss") assert.fail("expected legacy entry");
  const legacy = result.definition;
  assert.deepEqual(legacy.footprint, { width: 2, height: 2 });
  assert.deepEqual(legacy.skillIds, ["smash", "sweep", "skip"]);
  assert.deepEqual(legacy.scriptIds, ["stationary_smash", "cadence_ssw", "raid_ssw", "siege"]);
  assert.deepEqual(Object.keys(LEGACY_BOSS_SKILL_MAP), legacy.skillIds);
  assert.deepEqual(Object.keys(LEGACY_BOSS_SCRIPT_MAP), legacy.scriptIds);
  for (const id of legacy.skillIds) assert.equal(mapLegacyBossSkill(id), id);
  for (const id of legacy.scriptIds) assert.equal(mapLegacyBossScript(id), id);
  for (const value of ["spore_leap", "siege", "__proto__", "constructor", "toString", "", null, 1]) {
    assert.equal(mapLegacyBossSkill(value), null);
  }
  for (const value of ["smash", "spore_leaper", "__proto__", "constructor", "toString", "", null, 1]) {
    assert.equal(mapLegacyBossScript(value), null);
  }
});

test("definition lookup rejects unknown or incompatible tuples without fallback or coercion", () => {
  for (const bad of ["mecha-v1.3", "mecha-v1.5", "MECHA-V1.4", "", null, 1]) {
    assert.deepEqual(lookupMonsterDefinition(bad, 1, "spore_leaper"), { ok: false, reason: "unsupported_ruleset" });
  }
  for (const bad of [0, 2, -1, 1.1, "1", NaN, Infinity, null, undefined]) {
    assert.deepEqual(lookupMonsterDefinition(MONSTER_RULESET_V1, bad, "spore_leaper"), { ok: false, reason: "unsupported_content_version" });
  }
  for (const bad of ["spore", "flat", "shore", "ridge", "alley", "__proto__", "constructor", "toString", "", null, 1]) {
    assert.deepEqual(lookup(bad), { ok: false, reason: "unknown_species" });
  }
});

test("encounter assignments validate and round-trip independently of terrain or visual seed", () => {
  for (const speciesId of ["legacy_boss", ...PLANNED_MONSTER_SPECIES_IDS]) {
    const definitions = [0, 42, Number.MAX_SAFE_INTEGER].map((visualSeed) => {
      const assignment = JSON.parse(JSON.stringify({ speciesId, contentVersion: 1, visualSeed }));
      const result = resolveEncounterContent(MONSTER_RULESET_V1, assignment);
      assert.equal(result.ok, true);
      if (!result.ok) assert.fail(result.reason);
      assert.deepEqual(result.content, assignment);
      assert.ok(Object.isFrozen(result.content));
      return result.definition;
    });
    assert.equal(definitions[0], definitions[1]);
    assert.equal(definitions[1], definitions[2]);
  }
  for (const value of [null, [], "spore_leaper", {}, { speciesId: "spore_leaper", contentVersion: 1 }, Object.create({ speciesId: "spore_leaper", contentVersion: 1, visualSeed: 0 })]) {
    assert.deepEqual(resolveEncounterContent(MONSTER_RULESET_V1, value), { ok: false, reason: "invalid_encounter_content" });
  }
  const accessor = { speciesId: "spore_leaper", contentVersion: 1, get visualSeed() { throw new Error("must not execute"); } };
  assert.deepEqual(resolveEncounterContent(MONSTER_RULESET_V1, accessor), { ok: false, reason: "invalid_encounter_content" });
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("bad descriptor"); } });
  assert.deepEqual(resolveEncounterContent(MONSTER_RULESET_V1, hostile), { ok: false, reason: "invalid_encounter_content" });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(resolveEncounterContent(MONSTER_RULESET_V1, revoked.proxy), { ok: false, reason: "invalid_encounter_content" });
  for (const visualSeed of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "42", null]) {
    assert.deepEqual(resolveEncounterContent(MONSTER_RULESET_V1, { speciesId: "spore_leaper", contentVersion: 1, visualSeed }), { ok: false, reason: "invalid_visual_seed" });
  }
  assert.deepEqual(resolveEncounterContent("mecha-v1.3", { speciesId: "spore_leaper", contentVersion: 1, visualSeed: 0 }), { ok: false, reason: "unsupported_ruleset" });
  assert.deepEqual(resolveEncounterContent(MONSTER_RULESET_V1, { speciesId: "spore_leaper", contentVersion: 2, visualSeed: 0 }), { ok: false, reason: "unsupported_content_version" });
  assert.deepEqual(resolveEncounterContent(MONSTER_RULESET_V1, { speciesId: "flat", contentVersion: 1, visualSeed: 0 }), { ok: false, reason: "unknown_species" });
});

test("catalog and compatibility maps cannot be mutated through their public references", () => {
  const result = lookup("spore_leaper");
  assert.ok(result.ok);
  if (!result.ok || result.definition.kind !== "planned_species") assert.fail("expected planned species");
  assert.ok(Object.isFrozen(result.definition));
  assert.ok(Object.isFrozen(result.definition.footprint));
  assert.ok(Object.isFrozen(result.definition.signatureSkill));
  assert.ok(Object.isFrozen(PLANNED_MONSTER_SPECIES_IDS));
  assert.ok(Object.isFrozen(PLANNED_SIGNATURE_SKILLS));
  assert.ok(Object.isFrozen(LEGACY_BOSS_SKILL_MAP));
  assert.ok(Object.isFrozen(LEGACY_BOSS_SCRIPT_MAP));
  assert.throws(() => { (result.definition.signatureSkill as { name: string }).name = "changed"; }, TypeError);
  const legacy = lookup("legacy_boss");
  assert.ok(legacy.ok);
  if (!legacy.ok || legacy.definition.kind !== "legacy_boss") assert.fail("expected legacy entry");
  assert.ok(Object.isFrozen(legacy.definition));
  assert.ok(Object.isFrozen(legacy.definition.skillIds));
  assert.ok(Object.isFrozen(legacy.definition.scriptIds));
});


test("registered effect resolution uses the bound skill and rejects unknown skills without mutation", async () => {
  const { createMatch } = await import("../src/game/mecha/rules.ts");
  const { resolveRegisteredUnitEffect } = await import("../src/game/mecha/unitRegistry.ts");
  const { hurtMech, hurtRaider, strike, refresh } = await import("../src/game/mecha/combat.ts");
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash" });
  const ops = { hurtMech, hurtRaider, strike, refresh };
  const before = structuredClone(state);
  const unknown = { skillId: "__proto__", local: [], projected: [], cdSweep: 0, status: "planned" } as any;
  assert.equal(resolveRegisteredUnitEffect(state, unknown, ops), "unregistered");
  assert.deepEqual(state, before);
  const prism = { skillId: "prism_guard", targetId: "boss", shieldHits: 1, local: [], projected: [], cdSweep: 0, status: "planned" } as const;
  assert.equal(resolveRegisteredUnitEffect(state, structuredClone(prism) as any, ops), "handled");
  assert.deepEqual(state.boss.shield, { kind: "prism_guard", hits: 1 });
});
