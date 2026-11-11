import { MIAMI_COASTAL, type CoastalConfig } from "./citySeaside";
import type { Shape } from "./cityShape";
import { validateCitySkinPack, validateCityWorldProfile, type CitySkinPackV1, type CityWorldProfileV1 } from "@agent-vitals/city-sdk";
import {
  type AridDunesOptionsV1,
  type GeographyBuildOptions,
  type GeographyGeneratorId,
  type GeographyGeneratorOptions,
  validateGeographyBuildOptions,
} from "./planner/geography";

/** Public versioned world contract is owned by the SDK; generation remains in City. */
export type { CityWorldProfileV1 };
export type MiamiCityWorldProfileV1 = Extract<CityWorldProfileV1, { geography: { generator: "coastal-islands-v1" } }>;
export type AridDunesCityWorldProfileV1 = Extract<CityWorldProfileV1, { geography: { generator: "arid-dunes-v1" } }>;

export type CityGeographyProfileV1 = CityWorldProfileV1["geography"];
export type CityWorldBiomeV1 = CityWorldProfileV1["biome"];

const MIAMI_GENERATION = Object.freeze({ ...MIAMI_COASTAL });

export const MIAMI_CITY_WORLD_V1: MiamiCityWorldProfileV1 = Object.freeze({
  schemaVersion: 1,
  id: "miami-islands",
  version: 1,
  biome: "tropical",
  geography: Object.freeze({
    generator: "coastal-islands-v1",
    parameters: Object.freeze({ coastal: MIAMI_GENERATION }),
  }),
  visuals: Object.freeze({ themeId: "miami" }),
});

export const ARID_DUNES_CITY_WORLD_V1: AridDunesCityWorldProfileV1 = Object.freeze({
  schemaVersion: 1,
  id: "arid-dunes",
  version: 1,
  biome: "arid",
  geography: Object.freeze({
    generator: "arid-dunes-v1",
    parameters: Object.freeze({ dunes: Object.freeze({ duneScale: 190, duneAmplitude: 11, orientationDeg: 18 }) }),
  }),
  visuals: Object.freeze({ themeId: "desert" }),
});

/** Compose a validated appearance pack without changing the world geometry. */
export function applyCitySkinToWorldProfile(profile: CityWorldProfileV1, candidate: unknown): CityWorldProfileV1 {
  assertSupportedProfile(profile);
  const skin = validateCitySkinPack(candidate);
  if (!skin.ok) throw new Error(skin.diagnostics[0]?.code ?? "city-skin-invalid");
  const generator = profile.geography.generator;
  if (!skin.value.compatibleGeographies.includes(generator)) throw new Error("city-skin-geography-incompatible");
  const visuals = { themeId: skin.value.visuals.themeId };
  return Object.freeze({ ...profile, visuals: Object.freeze(visuals) }) as CityWorldProfileV1;
}

export const BUILTIN_CITY_SKINS_V1: ReadonlyArray<CitySkinPackV1> = Object.freeze([
  Object.freeze({ schemaVersion: 1, id: "miami-vice", renderContract: "city-render-v1", compatibleGeographies: Object.freeze(["coastal-islands-v1", "arid-dunes-v1"]) as unknown as CitySkinPackV1["compatibleGeographies"], visuals: Object.freeze({ themeId: "miami" }) }),
  Object.freeze({ schemaVersion: 1, id: "desert-evening", renderContract: "city-render-v1", compatibleGeographies: Object.freeze(["coastal-islands-v1", "arid-dunes-v1"]) as unknown as CitySkinPackV1["compatibleGeographies"], visuals: Object.freeze({ themeId: "desert" }) }),
]);

const WORLD_PROFILE_STORAGE_KEY = "city.world-profile.v1";
const CITY_SKIN_STORAGE_KEY = "city.skin.v1";
/** Bound pasted and persisted data even though the schema itself is small. */
export const CITY_WORLD_PROFILE_IMPORT_MAX_BYTES = 64 * 1024;
export const CITY_WORLD_PROFILE_STORAGE_MAX_BYTES = 16 * 1024;

export type CityWorldProfileImportResult =
  | { ok: true; profile: CityWorldProfileV1; diagnostics: [] }
  | { ok: false; diagnostics: ReadonlyArray<{ code: string; message: string }> };

/** Parse an SDK-produced data-only profile and enforce this City build's runtime registrations. */
export function parseCityWorldProfileJson(raw: string): CityWorldProfileImportResult {
  if (new TextEncoder().encode(raw).byteLength > CITY_WORLD_PROFILE_IMPORT_MAX_BYTES) {
    return { ok: false, diagnostics: [{ code: "world_profile_input_too_large", message: `Profile JSON must be at most ${CITY_WORLD_PROFILE_IMPORT_MAX_BYTES} bytes.` }] };
  }
  let candidate: unknown;
  try { candidate = JSON.parse(raw); }
  catch { return { ok: false, diagnostics: [{ code: "world_profile_invalid_json", message: "输入不是有效的 JSON。" }] }; }
  const validated = validateCityWorldProfile(candidate);
  if (!validated.ok) return { ok: false, diagnostics: validated.diagnostics.map(item => ({ code: item.code, message: item.message })) };
  if (validated.value.id === MIAMI_CITY_WORLD_V1.id || validated.value.id === ARID_DUNES_CITY_WORLD_V1.id) {
    return { ok: false, diagnostics: [{ code: "world_profile_reserved_id", message: "自定义世界不能使用内置世界 ID。" }] };
  }
  try { assertSupportedProfile(validated.value); }
  catch (error) {
    const code = error instanceof Error ? error.message : "city-world-profile-unsupported";
    return { ok: false, diagnostics: [{ code, message: code === "city-world-theme-unsupported" ? "该视觉主题未在 City 注册。" : "该地貌参数不受当前 City 生成器支持。" }] };
  }
  const normalized = JSON.stringify(validated.value);
  if (new TextEncoder().encode(normalized).byteLength > CITY_WORLD_PROFILE_STORAGE_MAX_BYTES) {
    return { ok: false, diagnostics: [{ code: "world_profile_storage_too_large", message: `规范化后的 Profile 必须小于 ${CITY_WORLD_PROFILE_STORAGE_MAX_BYTES} 字节。` }] };
  }
  return { ok: true, profile: validated.value, diagnostics: [] };
}

export function readCityWorldProfilePreference(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): CityWorldProfileV1 {
  try {
    const selected = storage?.getItem(WORLD_PROFILE_STORAGE_KEY);
    if (selected === ARID_DUNES_CITY_WORLD_V1.id) return ARID_DUNES_CITY_WORLD_V1;
    if (selected === MIAMI_CITY_WORLD_V1.id || !selected || new TextEncoder().encode(selected).byteLength > CITY_WORLD_PROFILE_STORAGE_MAX_BYTES) return MIAMI_CITY_WORLD_V1;
    const imported = parseCityWorldProfileJson(selected);
    return imported.ok ? imported.profile : MIAMI_CITY_WORLD_V1;
  } catch { return MIAMI_CITY_WORLD_V1; }
}
export function writeCityWorldProfilePreference(profileId: string, storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): boolean {
  if (profileId !== MIAMI_CITY_WORLD_V1.id && profileId !== ARID_DUNES_CITY_WORLD_V1.id) return false;
  try { storage?.setItem(WORLD_PROFILE_STORAGE_KEY, profileId); return storage !== null; } catch { return false; }
}

/** Persist only the validator's normalized profile; invalid imports never mutate storage. */
export function writeCityWorldProfileJson(raw: string, storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): CityWorldProfileImportResult {
  const result = parseCityWorldProfileJson(raw);
  if (!result.ok) return result;
  if (!storage) return { ok: false, diagnostics: [{ code: "world_profile_storage_unavailable", message: "本地存储不可用，无法应用世界。" }] };
  try { storage.setItem(WORLD_PROFILE_STORAGE_KEY, JSON.stringify(result.profile)); }
  catch { return { ok: false, diagnostics: [{ code: "world_profile_storage_failed", message: "本地存储失败，未应用世界。" }] }; }
  return result;
}

export function readCitySkinPreference(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): CitySkinPackV1 {
  try {
    const selected = storage?.getItem(CITY_SKIN_STORAGE_KEY);
    return BUILTIN_CITY_SKINS_V1.find(skin => skin.id === selected) ?? BUILTIN_CITY_SKINS_V1[0]!;
  } catch { return BUILTIN_CITY_SKINS_V1[0]!; }
}

export function readCityAppearancePreference(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): CityWorldProfileV1 {
  const world = readCityWorldProfilePreference(storage);
  // A world profile supplies its own default appearance. A separately saved
  // skin is an explicit user choice and takes precedence across worlds.
  let skin = BUILTIN_CITY_SKINS_V1.find(item => item.visuals.themeId === world.visuals.themeId) ?? BUILTIN_CITY_SKINS_V1[0]!;
  try {
    const selected = storage?.getItem(CITY_SKIN_STORAGE_KEY);
    if (selected) skin = BUILTIN_CITY_SKINS_V1.find(item => item.id === selected) ?? skin;
  } catch { /* Keep the profile's safe, registered default appearance. */ }
  try { return applyCitySkinToWorldProfile(world, skin); } catch { return applyCitySkinToWorldProfile(world, BUILTIN_CITY_SKINS_V1[0]); }
}

export function writeCitySkinPreference(skinId: string, storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): boolean {
  if (!BUILTIN_CITY_SKINS_V1.some(skin => skin.id === skinId)) return false;
  try { storage?.setItem(CITY_SKIN_STORAGE_KEY, skinId); return storage !== null; } catch { return false; }
}

function assertSupportedProfile(profile: CityWorldProfileV1): void {
  const validated = validateCityWorldProfile(profile);
  if (!validated.ok) {
    const code = validated.diagnostics[0]?.code;
    if (code === "world_profile_generator_unsupported") throw new Error("city-world-generator-unsupported");
    if (code === "world_profile_invalid_visuals") throw new Error("city-world-theme-unsupported");
    throw new Error(code ?? "city-world-generator-unsupported");
  }
  switch (profile.geography.generator) {
    case "coastal-islands-v1":
      if (profile.visuals.themeId !== "miami" && profile.visuals.themeId !== "desert") throw new Error("city-world-theme-unsupported");
      if (profile.biome !== "tropical" || profile.geography.parameters.coastal.profile !== "miami-coastal") throw new Error("city-world-generator-unsupported");
      return;
    case "arid-dunes-v1":
      if (profile.visuals.themeId !== "miami" && profile.visuals.themeId !== "desert") throw new Error("city-world-theme-unsupported");
      if (profile.biome !== "arid") throw new Error("city-world-generator-unsupported");
      validateGeographyBuildOptions("arid-dunes-v1", profile.geography.parameters.dunes);
      return;
  }
}

export function coastalConfigForWorld(profile: MiamiCityWorldProfileV1): CoastalConfig;
export function coastalConfigForWorld(profile: AridDunesCityWorldProfileV1): null;
export function coastalConfigForWorld(profile: CityWorldProfileV1): CoastalConfig | null;
export function coastalConfigForWorld(profile: CityWorldProfileV1): CoastalConfig | null {
  assertSupportedProfile(profile);
  return profile.geography.generator === "coastal-islands-v1" ? profile.geography.parameters.coastal : null;
}

export function geographyGeneratorForWorld(profile: CityWorldProfileV1): GeographyGeneratorId {
  assertSupportedProfile(profile);
  return profile.geography.generator;
}

export function geographyBuildOptionsForWorld(profile: CityWorldProfileV1, seedShape: Shape): GeographyBuildOptions {
  assertSupportedProfile(profile);
  if (profile.geography.generator === "coastal-islands-v1") {
    const bay = profile.geography.parameters.coastal.bayHalfWidth > 0
      ? { halfWidth: profile.geography.parameters.coastal.bayHalfWidth, shift: profile.geography.parameters.coastal.bayShift }
      : null;
    return validateGeographyBuildOptions("coastal-islands-v1", { shape: seedShape, bay });
  }
  return validateGeographyBuildOptions("arid-dunes-v1", profile.geography.parameters.dunes);
}

export function biomeForWorld(profile: CityWorldProfileV1): CityWorldBiomeV1 {
  assertSupportedProfile(profile);
  return profile.biome;
}

/** Correlated configuration result so callers can dispatch without casts. */
export type CityWorldBuildConfigV1 =
  | { geographyGenerator: "coastal-islands-v1"; geographyOptions: GeographyGeneratorOptions["coastal-islands-v1"]; biome: "tropical"; themeId: "miami" | "desert" }
  | { geographyGenerator: "arid-dunes-v1"; geographyOptions: GeographyGeneratorOptions["arid-dunes-v1"]; biome: "arid"; themeId: "miami" | "desert" };

/** One validated composition result for synchronous, worker and remote callers. */
export function cityWorldBuildConfig(profile: CityWorldProfileV1, seedShape: Shape): CityWorldBuildConfigV1 {
  assertSupportedProfile(profile);
  if (profile.geography.generator === "coastal-islands-v1") return {
    geographyGenerator: "coastal-islands-v1",
    geographyOptions: geographyBuildOptionsForWorld(profile, seedShape) as GeographyGeneratorOptions["coastal-islands-v1"],
    biome: "tropical",
    themeId: profile.visuals.themeId,
  };
  return {
    geographyGenerator: "arid-dunes-v1",
    geographyOptions: geographyBuildOptionsForWorld(profile, seedShape) as GeographyGeneratorOptions["arid-dunes-v1"],
    biome: "arid",
    themeId: profile.visuals.themeId,
  };
}
