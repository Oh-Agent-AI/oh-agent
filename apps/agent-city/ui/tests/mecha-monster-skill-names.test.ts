import test from "node:test";
import assert from "node:assert/strict";
import { monsterSkillName } from "../src/game/mecha/skillNames";
import { PLANNED_SIGNATURE_SKILLS } from "../src/game/mecha/monsters/contracts";

test("all ten monster skills have distinct Chinese and English presentation names", () => {
  const skills = Object.values(PLANNED_SIGNATURE_SKILLS);
  for (const locale of ["zh-Hans", "en"] as const) {
    const names = skills.map(skill => monsterSkillName(skill, locale));
    assert.equal(new Set(names).size, skills.length);
    for (let i = 0; i < skills.length; i++) assert.notEqual(names[i], skills[i]);
  }
});

test("legacy skills remain named and unknown skills do not masquerade as skip", () => {
  assert.equal(monsterSkillName("smash", "zh-Hans"), "砸击");
  assert.equal(monsterSkillName("sweep", "en"), "Sweep");
  assert.equal(monsterSkillName("skip", "en"), "Skip");
  assert.equal(monsterSkillName("future_skill", "en"), "future_skill");
  assert.equal(monsterSkillName(null, "zh-Hans"), "无攻击");
});
