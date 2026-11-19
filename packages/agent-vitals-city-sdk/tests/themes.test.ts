import test from "node:test";
import assert from "node:assert/strict";
import { CITY_SKIN_PACK_IDS_V1, CITY_THEMES_V1, CITY_THEME_IDS_V1, cityThemeForSkinPack, isCityThemeIdV1 } from "../src/themes";

// 主题注册表（2026-11-19 硬编码收敛）：此前 "miami"|"desert" 闭集词汇散落在
// types/validate/City 引擎/能力目录多处，新增主题要改 ≥7 处。注册表化之后
// 类型、守卫、皮肤目录全部从同一声明派生；这里钉住派生关系本身，任何一侧
// 单独漂移在这里失败，而不是等到"能力目录说支持但校验拒绝"才暴露。

test("theme registry derives the id vocabulary and the skin pack catalog", () => {
  assert.deepEqual([...CITY_THEME_IDS_V1], ["miami", "desert"]);
  assert.deepEqual([...CITY_SKIN_PACK_IDS_V1], ["miami-vice", "desert-evening"]);
  assert.equal(cityThemeForSkinPack("miami-vice")?.id, "miami");
  assert.equal(cityThemeForSkinPack("desert-evening")?.id, "desert");
  assert.equal(cityThemeForSkinPack("unknown-pack"), undefined);
});

test("theme registry rejects unknown ids and keeps ids and skin packs unique", () => {
  assert.equal(isCityThemeIdV1("miami"), true);
  assert.equal(isCityThemeIdV1("desert"), true);
  for (const value of ["noir", "", "MIAMI", 3, null]) {
    assert.equal(isCityThemeIdV1(value), false, String(value));
  }
  assert.equal(new Set(CITY_THEME_IDS_V1).size, CITY_THEME_IDS_V1.length);
  const packs = CITY_THEMES_V1.flatMap(theme => [...theme.skinPacks]);
  assert.equal(new Set(packs).size, packs.length, "each skin pack belongs to exactly one theme");
  for (const pack of packs) {
    assert.equal((CITY_SKIN_PACK_IDS_V1 as readonly string[]).includes(pack), true, `${pack} is themed but not cataloged`);
  }
});

test("registry arrays stay exhaustive against the type declarations", () => {
  // 类型侧新增 id 而忘记登记数组（或反之）在这里失败；TS 7.0.2 下
  // `(typeof ARR)[number]` 会丢字面量联合，所以穷举性由本测试而不是编译期保证。
  assert.deepEqual([...CITY_THEME_IDS_V1].sort(), ["desert", "miami"]);
  assert.deepEqual([...CITY_SKIN_PACK_IDS_V1].sort(), ["desert-evening", "miami-vice"]);
});
