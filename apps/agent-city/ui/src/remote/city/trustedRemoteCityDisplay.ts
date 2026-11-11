import type { RemoteCityDisplay } from "./cityDisplayProjection";
import { GEOGRAPHY_GENERATOR_IDS, validateGeographyBuildOptions, type GeographyGeneratorId } from "../../engine/planner/geography";

const MAX_BYTES = 230 * 1024;
type Obj = Record<string, any>;
const isObj = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);
const isArray = Array.isArray;
const exact = (value: unknown, keys: readonly string[]): value is Obj => isObj(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hasExactKeys = (value: Obj, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const finite = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const uint = (value: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const LEGACY_DISPLAY_KEYS = ["scaleTier", "biome", "core", "islandRadius", "seed", "districts", "blocks", "roadNodes", "roadEdges", "activityKey", "coastRoads", "culDeSacEnds", "junctionRings", "highwayRamps", "districtLandmarks", "terrain", "extent", "coast", "river", "publicSites", "parkTrees", "urbanBounds", "bridges", "boatLanes", "boundsRadius", "decorMountains", "districtAnchors", "highways", "massing", "civics", "landmarks", "seaside", "airport", "coastalConfigKey", "coastalConfig", "contextBuildings", "gardens", "boatLoops", "seaMountains"] as const;
const DISPLAY_KEYS = [...LEGACY_DISPLAY_KEYS.slice(0, 5), "features", "geographyGeneratorId", "geographyOptions", "worldProfileKey", ...LEGACY_DISPLAY_KEYS.slice(5)] as const;
const ALIAS_PREFIXES = ["district-", "building-", "hotel:entity-", "oceandrive:entity-", "entity-"] as const;
const FIELD_ALIAS_PREFIXES = ["building-", "district-", "entity-", "hotel:entity-", "oceandrive:entity-"] as const;

function aliasPrefix(value: string): string | null {
  for (const prefix of ALIAS_PREFIXES) {
    if (!value.startsWith(prefix)) continue;
    const suffix = value.slice(prefix.length);
    if ((/^\d{4,8}$/.test(suffix) && Number(suffix) > 0)
      || (/^(?=.*[1-9a-f])[a-f0-9]{32}$/.test(suffix))) return prefix;
  }
  return null;
}

function collectAliases(value: unknown, found: Set<string>): void {
  if (typeof value === "string") { if (aliasPrefix(value)) found.add(value); return; }
  if (isArray(value)) { for (const item of value) collectAliases(item, found); return; }
  if (isObj(value)) for (const [key, item] of Object.entries(value)) {
    if (aliasPrefix(key)) found.add(key);
    collectAliases(item, found);
  }
}

function randomAlias(prefix: string): string {
  if (!globalThis.crypto?.getRandomValues) throw new Error("remote_alias_random_failed");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  if (bytes.every(byte => byte === 0)) bytes[15] = 1;
  return `${prefix}${[...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function rekey(value: unknown, aliases: Map<string, string>): unknown {
  if (typeof value === "string") return aliases.get(value) ?? value;
  if (isArray(value)) return value.map(item => rekey(item, aliases));
  if (isObj(value)) {
    const result: Obj = {};
    for (const [key, item] of Object.entries(value)) result[aliases.get(key) ?? key] = rekey(item, aliases);
    return result;
  }
  return value;
}

function hasForbiddenKey(value: unknown): boolean {
  if (isArray(value)) return value.some(hasForbiddenKey);
  if (!isObj(value)) return false;
  return Object.entries(value).some(([key, child]) => ["sessionid", "assetref", "filepath", "workingdirectory", "prompt", "rawerror", "finding", "cost", "logpath"].includes(key.toLowerCase()) || hasForbiddenKey(child));
}

function validAliases(value: unknown, key = ""): boolean {
  if (isArray(value)) return value.every(item => validAliases(item, key));
  if (!isObj(value)) {
    if (typeof value === "string" && (key === "id" || key.endsWith("Id") || ["from", "to", "fromNode", "toNode", "mergedWith"].includes(key))) return aliasPrefix(value) !== null;
    return true;
  }
  return Object.entries(value).every(([childKey, child]) => {
    if (childKey === "__remoteMap" && (!isArray(child) || !child.every(entry => isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && aliasPrefix(entry[0]) !== null && validAliases(entry)))) return false;
    if ((childKey === "id" || childKey.endsWith("Id") || ["from", "to", "fromNode", "toNode", "mergedWith"].includes(childKey))
        && typeof child === "string" && !FIELD_ALIAS_PREFIXES.some(prefix => child.startsWith(prefix) && aliasPrefix(child) === prefix)) return false;
    return validAliases(child, childKey);
  });
}

function validateModel(model: unknown): boolean {
  if (!exact(model, ["districts", "buildings", "stats", "rows"])) return false;
  const districts = model.districts, buildings = model.buildings, rows = model.rows;
  if (!isArray(districts) || !isArray(buildings) || !isArray(rows) || districts.length === 0 || districts.length > 32 || buildings.length > 5_000 || rows.length > 4_000) return false;
  const districtIds = new Set<string>();
  for (const district of districts) {
    if (!exact(district, ["id", "label", "sessionCount", "tokensTotal", "activeCount", "anomaly"]) || typeof district.id !== "string" || !district.id.startsWith("district-") || !aliasPrefix(district.id)
        || typeof district.label !== "string" || !district.label.length || district.label.length > 120 || !uint(district.sessionCount, 1_000_000)
        || !uint(district.activeCount, 1_000_000) || !finite(district.tokensTotal, 0, 1e18) || district.anomaly !== null || districtIds.has(district.id)) return false;
    districtIds.add(district.id);
  }
  const buildingIds = new Set<string>();
  for (const building of buildings) {
    if (!exact(building, ["id", "districtId", "archetype", "facade", "seed", "tokensTotal", "height", "footprint", "active", "builtFraction", "busyness", "aggregated", "extraCount", "startedAt", "endedAt"])
        || typeof building.id !== "string" || !building.id.startsWith("building-") || !aliasPrefix(building.id) || !districtIds.has(building.districtId)
        || !["tower", "slab", "midrise", "block", "landmark"].includes(building.archetype) || !uint(building.facade, 2)
        || !finite(building.seed, 0, 1) || !finite(building.tokensTotal, 0, 1e18) || !finite(building.height, 0, 100_000) || !finite(building.footprint, 0, 100_000)
        || typeof building.active !== "boolean" || !finite(building.builtFraction, 0, 1) || !finite(building.busyness, 0, 1) || typeof building.aggregated !== "boolean"
        || !uint(building.extraCount, 1_000_000) || !uint(building.startedAt, 5_000) || building.endedAt !== null || buildingIds.has(building.id)) return false;
    buildingIds.add(building.id);
  }
  const stats = model.stats;
  if (!exact(stats, ["renderedSessions", "aggregatedSessions", "totalSessions", "tokensTotal", "activeCount", "truncated"])
      || !uint(stats.renderedSessions, 4_000) || !uint(stats.aggregatedSessions, 1_000_000) || !uint(stats.totalSessions, 1_000_000)
      || !finite(stats.tokensTotal, 0, 1e18) || !uint(stats.activeCount, 1_000_000) || typeof stats.truncated !== "boolean") return false;
  const rowIds = new Set<string>();
  return rows.every(row => exact(row, ["id", "title"]) && typeof row.id === "string" && row.id.startsWith("building-") && buildingIds.has(row.id)
    && (row.title === null || typeof row.title === "string" && row.title.length <= 500) && !rowIds.has(row.id) && Boolean(rowIds.add(row.id)));
}

function validDistrict(value: unknown): boolean {
  return exact(value, ["id", "label", "center", "radius", "terrain", "slots", "grounds", "carPaths", "river", "riverHalfWidth", "trees", "plaza", "anomaly", "sessionCount", "landValue", "roads"])
    && value.anomaly === null;
}

function validateLayout(layout: unknown, seed: number): boolean {
  if (!exact(layout, ["schema", "revision", "generatorVersion", "seed", "backdrop", "camera", "data"]) || layout.schema !== "remote-city-layout:v1"
      || layout.generatorVersion !== 1 || !uint(layout.revision, 1_000_000) || layout.revision === 0 || layout.seed !== seed || !["off", "auto", "full"].includes(layout.backdrop)) return false;
  const camera = layout.camera;
  if (!exact(camera, ["position", "target", "up", "fov"]) || !finite(camera.fov, 10, 120)
      || ["position", "target", "up"].some(key => !isArray(camera[key]) || camera[key].length !== 3 || !camera[key].every((n: unknown) => finite(n, -100_000, 100_000)))) return false;
  const data = layout.data as Obj;
  const legacy = hasExactKeys(data, LEGACY_DISPLAY_KEYS);
  if ((!legacy && !hasExactKeys(data, DISPLAY_KEYS)) || data.seed !== seed || !uint(data.scaleTier, 32) || data.scaleTier === 0 || !finite(data.islandRadius, 10, 100_000) || !finite(data.extent, 10, 200_000)
      || !["tropical", "temperate", "boreal", "savanna", "eastasian", "arid"].includes(data.biome) || !isArray(data.districts) || data.districts.length === 0 || data.districts.length > 32
      || !data.districts.every(validDistrict) || !isArray(data.blocks) || data.blocks.length > 20_000 || !isArray(data.roadEdges) || data.roadEdges.length > 20_000
      || !isArray(data.roadNodes) || data.roadNodes.length > 50_000 || !isObj(data.terrain?.__remoteTerrain)) return false;
  if (!legacy) {
    const generator = data.geographyGeneratorId;
    if (!(GEOGRAPHY_GENERATOR_IDS as readonly string[]).includes(generator) || !isObj(data.features)
        || !exact(data.features, ["coastline", "ocean", "river", "islets"])
        || Object.values(data.features).some(value => typeof value !== "boolean")
        || typeof data.worldProfileKey !== "string" || data.worldProfileKey.length < 1 || data.worldProfileKey.length > 512) return false;
    try { validateGeographyBuildOptions(generator as GeographyGeneratorId, data.geographyOptions); } catch { return false; }
    if ((generator === "arid-dunes-v1") !== (data.biome === "arid")
        || (generator === "arid-dunes-v1" && Object.values(data.features).some(Boolean))
        || (generator === "coastal-islands-v1" && (data.features.coastline !== true || data.features.ocean !== true))) return false;
  } else if (data.biome === "arid") return false;
  return !hasForbiddenKey(data) && validAliases(data);
}

export function validateRemoteCityDisplay(value: unknown): asserts value is RemoteCityDisplay {
  if (!exact(value, ["schema", "seed", "model", "layout"]) || value.schema !== "remote-city-display:v2" || !uint(value.seed)
      || !validateModel(value.model) || !validateLayout(value.layout, value.seed)) {
    throw new Error("remote_projection_invalid");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_BYTES) throw new Error("remote_city_too_large");
}

/** Validate the v2 display contract and unlink all City entity aliases per handoff. */
export function prepareRemoteCityDisplay(value: unknown): RemoteCityDisplay {
  validateRemoteCityDisplay(value);
  const aliasesFound = new Set<string>();
  collectAliases(value, aliasesFound);
  const replacements = new Map<string, string>();
  const generated = new Set<string>();
  for (const id of aliasesFound) {
    const prefix = aliasPrefix(id);
    if (!prefix) throw new Error("remote_projection_invalid");
    let replacement = "";
    do { replacement = randomAlias(prefix); } while (generated.has(replacement));
    generated.add(replacement);
    replacements.set(id, replacement);
  }
  const projected = rekey(value, replacements);
  validateRemoteCityDisplay(projected);
  return projected;
}
