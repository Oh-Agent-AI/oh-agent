import test from "node:test";
import assert from "node:assert/strict";
import { resolveProjectCity } from "../src/projectCityScope.ts";

test("independent projects only render their exact City identity, revision and seed", () => {
  const city = { schemaVersion: 1, cityId: "city-desert", revision: 2, name: "沙海之门", seed: 42,
    profile: { schemaVersion: 1, id: "egypt-desert", version: 1, biome: "arid",
      geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } }, visuals: { themeId: "desert" } } };
  const binding = { cityId: "city-desert", cityRevision: 2, seed: 42 };
  assert.equal(resolveProjectCity(city, binding)?.cityId, binding.cityId);
  assert.equal(resolveProjectCity(city, { ...binding, cityId: "city-miami" }), null);
  assert.equal(resolveProjectCity(city, { ...binding, cityRevision: 1 }), null);
  assert.equal(resolveProjectCity(city, { ...binding, seed: 43 }), null);
  assert.equal(resolveProjectCity(null, binding), null);
});
