import test from "node:test";
import assert from "node:assert/strict";
import { validateCityInstance } from "../src/validate.ts";

const profile = () => ({ schemaVersion: 1, id: "egypt-desert", version: 1, biome: "arid",
  geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } },
  visuals: { themeId: "desert" } });
const city = () => ({ schemaVersion: 1, cityId: "city-desert", revision: 0, name: "沙海之门", seed: 42, profile: profile() });

test("City instance identity is independent of its profile and is detached from input", () => {
  const input = city();
  const result = validateCityInstance(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.cityId, "city-desert");
  assert.equal(result.value.profile.id, "egypt-desert");
  input.profile.geography.parameters.dunes.duneScale = 300;
  assert.equal(result.value.profile.geography.generator, "arid-dunes-v1");
  if (result.value.profile.geography.generator === "arid-dunes-v1") assert.equal(result.value.profile.geography.parameters.dunes.duneScale, 190);
  assert.ok(Object.isFrozen(result.value));
});

test("City rejects unscoped extra fields, invalid identities and invalid world recipes", () => {
  for (const candidate of [
    { ...city(), cityId: "../miami" }, { ...city(), revision: -1 }, { ...city(), revision: 1.5 },
    { ...city(), seed: 2 ** 32 }, { ...city(), name: " " }, { ...city(), name: "city\nother" },
    { ...city(), active: true }, { ...city(), profile: { ...profile(), biome: "tropical" } },
  ]) assert.equal(validateCityInstance(candidate).ok, false);
});

test("City retains an isolated patch and rejects wrong seed, invalid version and session moves", () => {
  const patch = { version: 1, seed: 42, scaleTier: 1, generatorVersion: 6, updatedAt: 1, roadOps: [], siteOps: [], buildingMoves: {}, suppressedContext: [] };
  const checked = validateCityInstance({ ...city(), planPatch: patch });
  assert.equal(checked.ok, true); if (checked.ok) assert.deepEqual(checked.value.planPatch, patch);
  assert.equal(validateCityInstance({ ...city(), planPatch: { ...patch, seed: 43 } }).ok, false);
  assert.equal(validateCityInstance({ ...city(), planPatch: { ...patch, generatorVersion: "6" } }).ok, false);
  assert.equal(validateCityInstance({ ...city(), planPatch: { ...patch, buildingMoves: { "session:1": "parcel:2" } } }).ok, false);
});
