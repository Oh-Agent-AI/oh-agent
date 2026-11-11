import test from "node:test";
import assert from "node:assert/strict";
import { ARID_DUNES_CITY_WORLD_V1, applyCitySkinToWorldProfile, BUILTIN_CITY_SKINS_V1, coastalConfigForWorld, cityWorldBuildConfig, MIAMI_CITY_WORLD_V1, parseCityWorldProfileJson, readCityAppearancePreference, readCitySkinPreference, readCityWorldProfilePreference, writeCitySkinPreference, writeCityWorldProfileJson, writeCityWorldProfilePreference } from "../src/engine/cityWorldProfile.ts";
import { activeTheme, themeFor } from "../src/engine/cityTheme.ts";
import { createCityShape } from "../src/engine/cityPlan.ts";

test("the official Miami world profile keeps geography and visual theme as distinct versioned choices", () => {
  assert.equal(MIAMI_CITY_WORLD_V1.id, "miami-islands");
  assert.equal(MIAMI_CITY_WORLD_V1.version, 1);
  assert.equal(MIAMI_CITY_WORLD_V1.geography.generator, "coastal-islands-v1");
  assert.equal(MIAMI_CITY_WORLD_V1.visuals.themeId, "miami");
  assert.equal(coastalConfigForWorld(MIAMI_CITY_WORLD_V1).profile, "miami-coastal");
});

test("world layout rejects an unimplemented geography generator instead of silently using Miami", () => {
  const unsupported = {
    ...MIAMI_CITY_WORLD_V1,
    geography: { ...MIAMI_CITY_WORLD_V1.geography, generator: "desert-dunes-v1" },
  } as unknown as typeof MIAMI_CITY_WORLD_V1;
  assert.throws(() => coastalConfigForWorld(unsupported), /city-world-generator-unsupported/);
});

test("world layout rejects an unimplemented visual theme instead of silently using Miami", () => {
  const unsupported = {
    ...MIAMI_CITY_WORLD_V1,
    visuals: { themeId: "desert-night" },
  } as unknown as typeof MIAMI_CITY_WORLD_V1;
  assert.throws(() => coastalConfigForWorld(unsupported), /city-world-theme-unsupported/);
});

test("explicit theme resolution preserves the Miami default and rejects unknown runtime IDs", () => {
  assert.equal(themeFor(MIAMI_CITY_WORLD_V1.visuals.themeId), activeTheme());
  assert.throws(() => themeFor("desert-night" as "miami"), /city-world-theme-unsupported/);
});

test("persists only registered world profile IDs and defaults unknown preferences to Miami", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(readCityWorldProfilePreference(storage), MIAMI_CITY_WORLD_V1);
  assert.equal(writeCityWorldProfilePreference(ARID_DUNES_CITY_WORLD_V1.id, storage), true);
  assert.equal(readCityWorldProfilePreference(storage), ARID_DUNES_CITY_WORLD_V1);
  assert.equal(writeCityWorldProfilePreference("untrusted-profile", storage), false);
  values.set("city.world-profile.v1", "unknown-profile");
  assert.equal(readCityWorldProfilePreference(storage), MIAMI_CITY_WORLD_V1);
});

test("imports SDK world profiles through registered City generators and persists the normalized data", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const custom = { ...ARID_DUNES_CITY_WORLD_V1, id: "my-dunes", geography: { ...ARID_DUNES_CITY_WORLD_V1.geography, parameters: { dunes: { duneScale: 240, duneAmplitude: 14, orientationDeg: -22 } } } };
  const raw = JSON.stringify(custom);
  const validated = parseCityWorldProfileJson(raw);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(validated.profile.id, "my-dunes");
  assert.equal(cityWorldBuildConfig(validated.profile, createCityShape(1)).geographyGenerator, "arid-dunes-v1");
  assert.equal(writeCityWorldProfileJson(raw, storage).ok, true);
  assert.equal(readCityWorldProfilePreference(storage).id, "my-dunes");
  assert.equal(readCityAppearancePreference(storage).visuals.themeId, "desert");
  assert.equal(writeCitySkinPreference("desert-evening", storage), true);
  assert.equal(readCityWorldProfilePreference(storage).id, "my-dunes");
  assert.equal(readCityAppearancePreference(storage).visuals.themeId, "desert");
  assert.equal(writeCityWorldProfilePreference(MIAMI_CITY_WORLD_V1.id, storage), true);
  assert.equal(readCityWorldProfilePreference(storage), MIAMI_CITY_WORLD_V1);
});

test("rejects unsupported generators, unknown fields, reserved IDs, oversized input and out-of-bounds profiles", () => {
  const base = { ...ARID_DUNES_CITY_WORLD_V1, id: "custom-dunes" };
  assert.equal(parseCityWorldProfileJson(JSON.stringify({ ...base, extra: "asset/path.glb" })).ok, false);
  assert.equal(parseCityWorldProfileJson(JSON.stringify({ ...base, id: MIAMI_CITY_WORLD_V1.id })).ok, false);
  assert.equal(parseCityWorldProfileJson(JSON.stringify({ ...base, geography: { generator: "custom-code-v1", parameters: {} } })).ok, false);
  assert.equal(parseCityWorldProfileJson(JSON.stringify({ ...base, geography: { ...base.geography, parameters: { dunes: { ...base.geography.parameters.dunes, duneAmplitude: 99 } } } })).ok, false);
  assert.equal(parseCityWorldProfileJson("{".padEnd(64 * 1024 + 1, " ")).ok, false);
  assert.equal(parseCityWorldProfileJson("{".repeat(100)).ok, false);
});

test("invalid imported profiles do not replace a previously selected built-in profile", () => {
  const values = new Map<string, string>([["city.world-profile.v1", ARID_DUNES_CITY_WORLD_V1.id]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const result = writeCityWorldProfileJson(JSON.stringify({ ...MIAMI_CITY_WORLD_V1, extra: true }), storage);
  assert.equal(result.ok, false);
  assert.equal(readCityWorldProfilePreference(storage), ARID_DUNES_CITY_WORLD_V1);
});

test("applies a compatible visual skin without changing the selected geography", () => {
  const skin = BUILTIN_CITY_SKINS_V1.find(item => item.id === "desert-evening")!;
  const coastalWithDesertSkin = applyCitySkinToWorldProfile(MIAMI_CITY_WORLD_V1, skin);
  assert.equal(coastalWithDesertSkin.geography.generator, "coastal-islands-v1");
  assert.equal(cityWorldBuildConfig(coastalWithDesertSkin, createCityShape(1)).themeId, "desert");
  assert.equal(coastalConfigForWorld(coastalWithDesertSkin)?.profile, "miami-coastal");
  assert.throws(() => applyCitySkinToWorldProfile(MIAMI_CITY_WORLD_V1, { ...skin, compatibleGeographies: ["arid-dunes-v1"] }), /city-skin-geography-incompatible/);
});

test("persists skin choice independently from geography and applies it on next City start", () => {
  const values = new Map<string, string>([["city.world-profile.v1", ARID_DUNES_CITY_WORLD_V1.id]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(readCitySkinPreference(storage).id, "miami-vice");
  assert.equal(writeCitySkinPreference("desert-evening", storage), true);
  assert.equal(readCityWorldProfilePreference(storage).id, ARID_DUNES_CITY_WORLD_V1.id);
  const appearance = readCityAppearancePreference(storage);
  assert.equal(appearance.geography.generator, "arid-dunes-v1");
  assert.equal(appearance.visuals.themeId, "desert");
  assert.equal(writeCitySkinPreference("untrusted-skin", storage), false);
});

test("an explicit saved skin overrides a profile default, while an unset or invalid skin uses the profile default", () => {
  const values = new Map<string, string>([["city.world-profile.v1", ARID_DUNES_CITY_WORLD_V1.id]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(readCityAppearancePreference(storage).visuals.themeId, "desert");
  values.set("city.skin.v1", "miami-vice");
  assert.equal(readCityAppearancePreference(storage).visuals.themeId, "miami");
  values.set("city.skin.v1", "unregistered-skin");
  assert.equal(readCityAppearancePreference(storage).visuals.themeId, "desert");
});
