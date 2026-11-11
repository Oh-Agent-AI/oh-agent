import test from "node:test";
import assert from "node:assert/strict";
import { validateCityWorldProfile } from "../src/validate";

const miami = {
  schemaVersion: 1, id: "miami-islands", version: 1, biome: "tropical",
  geography: { generator: "coastal-islands-v1", parameters: { coastal: {
    profile: "miami-coastal", version: 3, biome: "tropical", preferredAzimuth: 0, azimuthTolerance: 1.2,
    segmentArc: 1.4835298641951802, wetSandWidth: 8, drySandWidth: 40, promenadeOffset: 62,
    boulevardOffset: 74, hotelOffset: 92, bandOuter: 108, maxCoastalSlope: 0.9, maxCoastalHeight: 6,
    riverMargin: 26, siteMargin: 14, minValidRatio: 0.6, bayHalfWidth: 0.22, bayShift: 0.33,
  } } }, visuals: { themeId: "miami" },
};
const dunes = {
  schemaVersion: 1, id: "arid-dunes", version: 1, biome: "arid",
  geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } },
  visuals: { themeId: "desert" },
};

test("validates built-in geography profiles and returns an immutable SDK snapshot", () => {
  const coastal = validateCityWorldProfile(miami);
  const arid = validateCityWorldProfile(dunes);
  assert.equal(coastal.ok, true);
  assert.equal(arid.ok, true);
  if (coastal.ok) {
    assert.equal(Object.isFrozen(coastal.value.geography.parameters), true);
    assert.equal(Object.isFrozen(coastal.value.geography.parameters.coastal), true);
  }
  if (arid.ok) assert.equal(Object.isFrozen(arid.value.geography.parameters.dunes), true);
});

test("rejects unregistered generators, inconsistent biome, and out-of-range terrain parameters", () => {
  assert.equal(validateCityWorldProfile({ ...dunes, geography: { generator: "unsupported-v1", parameters: {} } }).ok, false);
  assert.equal(validateCityWorldProfile({ ...dunes, biome: "tropical" }).ok, false);
  assert.equal(validateCityWorldProfile({ ...dunes, geography: { ...dunes.geography, parameters: { dunes: { ...dunes.geography.parameters.dunes, duneAmplitude: 100 } } } }).ok, false);
});
