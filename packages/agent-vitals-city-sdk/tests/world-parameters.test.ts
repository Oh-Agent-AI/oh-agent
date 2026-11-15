import test from "node:test";
import assert from "node:assert/strict";
import { ARID_DUNES_WORLD_V2, ARID_DUNES_LEGACY_KEYS, COASTAL_ISLANDS_WORLD_V1, resolveWorldPresetV1, validateWorldCapabilityV1, validateWorldParametersV1 } from "../src/worldParameters";
import { validateCityWorldProfile } from "../src/validate";

const aridProfile = (diversity?: Record<string, number | string>) => ({
  schemaVersion: 1, id: "diversity-probe", version: 1, biome: "arid",
  geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 }, ...(diversity ? { diversity } : {}) } },
  visuals: { themeId: "desert" },
});

test("builtin world capabilities self-validate and declare complete defaults", () => {
  for (const capability of [ARID_DUNES_WORLD_V2, COASTAL_ISLANDS_WORLD_V1]) {
    const checked = validateWorldCapabilityV1(capability);
    assert.equal(checked.ok, true, JSON.stringify("ok" in checked ? checked.diagnostics : []));
    if (checked.ok) {
      const merged = validateWorldParametersV1(capability, {});
      assert.equal(merged.ok, true);
      if (merged.ok) {
        // 每个声明字段都必须有默认值：默认缺失会让「省略即现行为」的锁步失效。
        assert.equal(Object.keys(merged.value).length, capability.parameters.length);
      }
    }
  }
});

test("world parameters validate strictly against the capability key space", () => {
  const ok = validateWorldParametersV1(ARID_DUNES_WORLD_V2, { "shape.family": "lobed", "shape.coastFractal": 0.2 });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value["shape.family"], "lobed");
    // 未设置的键必须由默认值补全：省略即现行为是本契约的根基。
    assert.equal(ok.value["shape.cores"], 1);
    assert.equal(ok.value["landform.duneScale"], 190);
  }
  assert.equal(validateWorldParametersV1(ARID_DUNES_WORLD_V2, { "shape.unknown": 1 }).ok, false);
  assert.equal(validateWorldParametersV1(ARID_DUNES_WORLD_V2, { "shape.family": "spiral" }).ok, false);
  assert.equal(validateWorldParametersV1(ARID_DUNES_WORLD_V2, { "shape.coastFractal": 0.9 }).ok, false);
  assert.equal(validateWorldParametersV1(ARID_DUNES_WORLD_V2, { "shape.cores": 1.5 }).ok, false);
  assert.equal(validateWorldParametersV1(ARID_DUNES_WORLD_V2, { "shape.cores": "two" }).ok, false);
  const tooMany = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`x${i}`, 0]));
  const budget = validateWorldParametersV1(ARID_DUNES_WORLD_V2, tooMany);
  assert.equal(budget.ok, false);
  if (!budget.ok) assert.equal(budget.diagnostics[0]?.code, "world_params_budget_exceeded");
});

test("presets expand over defaults and unknown ids fail closed", () => {
  const lobed = resolveWorldPresetV1(ARID_DUNES_WORLD_V2, "lobed");
  assert.equal(lobed.ok, true);
  if (lobed.ok) {
    assert.equal(lobed.value["shape.family"], "lobed");
    assert.equal(lobed.value["shape.cores"], 3);
    assert.equal(lobed.value["shape.coastFractal"], 0.035);
  }
  assert.equal(resolveWorldPresetV1(ARID_DUNES_WORLD_V2, "spiral").ok, false);
  const vice = resolveWorldPresetV1(COASTAL_ISLANDS_WORLD_V1, "vice-bay");
  assert.equal(vice.ok, true);
});

test("arid profiles carry an optional diversity record without restating v1 fields", () => {
  const base = validateCityWorldProfile(aridProfile());
  assert.equal(base.ok, true);
  const withDiversity = validateCityWorldProfile(aridProfile({ "shape.coastFractal": 0.2, "water.oasisCount": 2 }));
  assert.equal(withDiversity.ok, true, JSON.stringify("ok" in withDiversity ? withDiversity.diagnostics : []));
  if (withDiversity.ok) {
    const parameters = withDiversity.value.geography.parameters as { dunes: unknown; diversity?: Record<string, unknown> };
    assert.deepEqual(Object.keys(parameters.diversity ?? {}), ["shape.coastFractal", "water.oasisCount"]);
    // 只持久化显式键：默认值在构建期归一化，存储不钉死当前默认。
    assert.equal(parameters.diversity?.["landform.duneScale"], undefined);
  }
  assert.equal(validateCityWorldProfile(aridProfile({ "landform.duneScale": 300 })).ok, false);
  assert.equal(validateCityWorldProfile(aridProfile({ "shape.family": "spiral" })).ok, false);
  assert.equal(validateCityWorldProfile(aridProfile({ "shape.unknown": 1 })).ok, false);
});

test("legacy keys stay reserved and immutable in the catalog", () => {
  assert.deepEqual(ARID_DUNES_LEGACY_KEYS, ["landform.duneScale", "landform.duneAmplitude", "landform.orientationDeg"]);
  assert.throws(() => { (ARID_DUNES_WORLD_V2.parameters as unknown as string[]).push("x"); });
});
