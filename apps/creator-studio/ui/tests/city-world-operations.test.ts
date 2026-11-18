import test from "node:test";
import assert from "node:assert/strict";
import { applyCityWorldOperations } from "../src/cityWorldOperations";
import { validateCityWorldProfile, type CityWorldProfileV1 } from "@oh-agent/city-sdk";

/**
 * world.set 合并语义测试（世界多样化规格 §5.2，S4）：合并结果必须通过
 * validateCityWorldProfile；legacy 沙丘键落到 parameters.dunes；其余显式键写入
 * diversity 且不钉死默认值；coastal 只允许已解冻字段。任何结构/语义失配判负。
 */

const aridProfile = (diversity?: Record<string, number | string>): CityWorldProfileV1 => ({
  schemaVersion: 1, id: "diversity-probe", version: 1, biome: "arid",
  geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 }, ...(diversity ? { diversity } : {}) } },
  visuals: { themeId: "desert" },
}) as CityWorldProfileV1;

const coastalProfile = (): CityWorldProfileV1 => ({
  schemaVersion: 1, id: "vice-probe", version: 1, biome: "tropical",
  geography: { generator: "coastal-islands-v1", parameters: { coastal: {
    profile: "miami-coastal", version: 1, biome: "tropical", preferredAzimuth: 0, azimuthTolerance: 0.1,
    segmentArc: 0.5, wetSandWidth: 10, drySandWidth: 20, promenadeOffset: 30, boulevardOffset: 40,
    hotelOffset: 50, bandOuter: 60, maxCoastalSlope: 1, maxCoastalHeight: 10, riverMargin: 5, siteMargin: 5,
    minValidRatio: 0.5, bayHalfWidth: 0.22, bayShift: 0.33 } } },
  visuals: { themeId: "miami" },
}) as CityWorldProfileV1;

test("world.set merges preset and params into the diversity record over defaults", () => {
  const merged = applyCityWorldOperations(aridProfile(), [
    { op: "world.set", preset: "lobed", params: { "shape.corridorPull": 0.2 } },
  ]);
  assert.ok(merged);
  const checked = validateCityWorldProfile(merged);
  assert.equal(checked.ok, true);
  const parameters = merged.geography.parameters as { dunes: Record<string, number>; diversity?: Record<string, number | string> };
  // 只持久化显式键：默认值不进存储。
  assert.deepEqual(Object.keys(parameters.diversity ?? {}).sort(), ["shape.cores", "shape.corridorPull", "shape.family"]);
  assert.equal(parameters.diversity?.["shape.family"], "lobed");
  assert.equal(parameters.diversity?.["shape.cores"], 3);
  assert.equal(parameters.diversity?.["shape.corridorPull"], 0.2);
  assert.equal(parameters.diversity?.["landform.duneScale"], undefined);
  assert.equal(parameters.dunes.duneScale, 190);
});

test("world.set routes legacy dune keys into parameters.dunes", () => {
  const merged = applyCityWorldOperations(aridProfile(), [
    { op: "world.set", params: { "landform.duneScale": 300, "shape.family": "coastal" } },
  ]);
  assert.ok(merged);
  const parameters = merged.geography.parameters as { dunes: Record<string, number>; diversity?: Record<string, number | string> };
  assert.equal(parameters.dunes.duneScale, 300);
  assert.equal(parameters.diversity?.["shape.family"], "coastal");
  assert.equal(parameters.diversity?.["landform.duneScale"], undefined);
  assert.equal(validateCityWorldProfile(merged).ok, true);
});

test("coastal world.set writes unfrozen bay fields and rejects unknown fields", () => {
  const merged = applyCityWorldOperations(coastalProfile(), [{ op: "world.set", params: { "shape.bayShift": 0.4 } }]);
  assert.ok(merged);
  assert.equal((merged.geography.parameters as { coastal: Record<string, unknown> }).coastal.bayShift, 0.4);
  assert.equal(applyCityWorldOperations(coastalProfile(), [{ op: "world.set", params: { "shape.family": "lobed" } }]), null);
});

test("world.set fails closed on structural or semantic violations", () => {
  const base = aridProfile();
  assert.equal(applyCityWorldOperations(base, []), null);
  assert.equal(applyCityWorldOperations(base, "nope"), null);
  assert.equal(applyCityWorldOperations(base, [{ op: "style.set", params: { timeOfDay: "dawn" } }]), null);
  assert.equal(applyCityWorldOperations(base, [{ op: "world.set" }]), null);
  assert.equal(applyCityWorldOperations(base, [{ op: "world.set", extra: 1, params: { "shape.family": "lobed" } }]), null);
  assert.equal(applyCityWorldOperations(base, [{ op: "world.set", params: { "shape.mood": "calm" } }]), null);
  assert.equal(applyCityWorldOperations(base, [{ op: "world.set", params: { "shape.family": "spiral" } }]), null);
  assert.equal(applyCityWorldOperations(base, [{ op: "world.set", params: { "shape.cores": 9 } }]), null);
  assert.equal(applyCityWorldOperations(base, [{ op: "world.set", preset: "spiral" }]), null);
  // 预算镜像宿主硬上限：>16 operations 判负。
  const tooMany = Array.from({ length: 17 }, () => ({ op: "world.set", params: { "shape.family": "lobed" } }));
  assert.equal(applyCityWorldOperations(base, tooMany), null);
});

test("merged profile survives a follow-up world.set on an existing diversity record", () => {
  const first = applyCityWorldOperations(aridProfile(), [{ op: "world.set", params: { "shape.family": "lobed", "shape.cores": 3 } }]);
  assert.ok(first);
  const second = applyCityWorldOperations(first, [{ op: "world.set", params: { "shape.family": "dumbbell", "shape.cores": 2 } }]);
  assert.ok(second);
  const parameters = second.geography.parameters as { diversity?: Record<string, number | string> };
  assert.equal(parameters.diversity?.["shape.family"], "dumbbell");
  assert.equal(parameters.diversity?.["shape.cores"], 2);
});
