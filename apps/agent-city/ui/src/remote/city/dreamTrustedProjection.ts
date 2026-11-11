import { encodeDreamSnapshot, type DreamSnapshotEnvelopeV1 } from "./dreamSnapshotCodec";
import { parseDreamCitySnapshot, type DreamCitySnapshotV1 } from "./dreamSnapshotContract";
import { GEOGRAPHY_GENERATOR_IDS, validateGeographyBuildOptions, type GeographyGeneratorId } from "../../engine/planner/geography";

const MAX_PLAIN = 4 * 1024 * 1024;
const MAX_ENVELOPE = 230 * 1024;
type Obj = Record<string, any>;
const obj = (v: any): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: any): v is unknown[] => Array.isArray(v);
const keys = (v: any, required: string[], optional: string[] = []) => obj(v)
  && required.every(key => Object.hasOwn(v, key))
  && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
const exact = (v: any, expected: string[]) => obj(v) && Object.keys(v).length === expected.length && expected.every(key => Object.hasOwn(v, key));
const str = (v: unknown): v is string => typeof v === "string";
const finite = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const uint = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const fail = (code: string): never => { throw new Error(code); };
const aliasRx = (prefix: string, value: any): value is string => {
  if (!str(value) || !value.startsWith(prefix)) return false;
  const suffix = value.slice(prefix.length);
  return (/^\d{4,8}$/.test(suffix) && Number(suffix) > 0) || (/^(?=.*[1-9a-f])[a-f0-9]{16}(?:[a-f0-9]{16})?$/.test(suffix));
};
const entity = (value: unknown): value is string => ["entity-", "hotel:entity-", "oceandrive:entity-"].some(prefix => aliasRx(prefix, value));
const aliasPrefixes = ["district-", "building-", "hotel:entity-", "oceandrive:entity-", "entity-"] as const;
const aliasPrefix = (value: string) => aliasPrefixes.find(prefix => aliasRx(prefix, value));
const exactColor = (v: unknown) => str(v) && /^#[\da-f]{6}$/i.test(v);
const point = (v: any) => exact(v, ["x", "z"]) && finite(v.x, -200_000, 200_000) && finite(v.z, -200_000, 200_000);
const zone = (v: any) => ["downtown", "residential", "commercial", "waterfront"].includes(String(v));
const path = (v: any, min = 0, max = 20_000) => arr(v) && v.length >= min && v.length <= max && v.every(point);
const paths = (v: any, max = 5_000) => arr(v) && v.length <= max && v.every(item => path(item));
const placed = (v: any) => obj(v) && finite(v.x, -200_000, 200_000) && finite(v.z, -200_000, 200_000) && finite(v.y, -100_000, 100_000);
const rect = (v: any) => placed(v) && finite(v.yaw, -100, 100) && finite(v.width, 0.01, 10_000) && finite(v.depth, 0.01, 10_000);
const terrainMeta = (v: any) => exact(v, ["__remoteTerrain"]) && exact(v.__remoteTerrain, ["center", "radius", "hasRiver"])
  && point(v.__remoteTerrain.center) && finite(v.__remoteTerrain.radius, 0.01, 200_000) && typeof v.__remoteTerrain.hasRiver === "boolean";
const count = (v: any) => uint(v) && Number(v) <= Number.MAX_SAFE_INTEGER;

const SCRUB_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /bearer[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+[A-Za-z0-9._~+/=-]{20,}/gi,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----.*?-----END[A-Z ]*PRIVATE KEY-----/gs,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\r\n ]{40,}/gs,
];
function boundSessionTitle(raw: string): string | null {
  let text = raw;
  for (const pattern of SCRUB_PATTERNS) text = text.replace(pattern, "[…]");
  text = text.replace(/^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, "");
  return text ? [...text].slice(0, 256).join("") : null;
}
function displayText(v: unknown): v is string {
  return str(v) && boundSessionTitle(v) === v && new TextEncoder().encode(v).length <= 1024;
}

function validateDisplay(display: any, districts: Set<string>, buildings: Map<string, string>): void {
  if (!exact(display, ["schema", "city", "districts", "buildings"]) || display.schema !== "agent-city-display:v1"
      || !exact(display.city, ["sessionCount", "activeCount", "tokensTotal", "truncated"])
      || !count(display.city.sessionCount) || !count(display.city.activeCount) || display.city.activeCount > display.city.sessionCount
      || !count(display.city.tokensTotal) || typeof display.city.truncated !== "boolean"
      || !arr(display.districts) || !arr(display.buildings) || display.districts.length !== districts.size
      || display.buildings.length !== buildings.size || display.buildings.length > 4_000) fail("invalid_dream_display");
  const seenD = new Set<string>();
  for (const row of display.districts) {
    if (!exact(row, ["id", "label", "sessionCount", "activeCount", "tokensTotal"]) || !aliasRx("district-", row.id)
        || !displayText(row.label) || !count(row.sessionCount) || !count(row.activeCount) || row.activeCount > row.sessionCount || !count(row.tokensTotal)
        || !districts.has(row.id) || seenD.has(row.id)) fail("invalid_dream_display");
    seenD.add(row.id);
  }
  const seenB = new Set<string>();
  for (const row of display.buildings) {
    if (!exact(row, ["id", "title", "titleSource", "sessionCount", "active", "tokensTotal"]) || !aliasRx("building-", row.id)
        || !count(row.sessionCount) || row.sessionCount === 0 || typeof row.active !== "boolean" || !count(row.tokensTotal)
        || (row.title === null ? row.titleSource !== null : !displayText(row.title)
          || !["codex_thread_name", "claude_ai_title", "dsh_workspace_title"].includes(String(row.titleSource)))
        || !buildings.has(row.id) || seenB.has(row.id)) fail("invalid_dream_display");
    seenB.add(row.id);
  }
}

function validateModel(model: any): { districts: Set<string>; buildings: Map<string, string> } {
  if (!exact(model, ["districts", "buildings", "stats", "rows"]) || !arr(model.districts) || !arr(model.buildings) || !arr(model.rows)
      || model.districts.length === 0 || model.districts.length > 32 || model.buildings.length > 5_000 || model.rows.length !== 0) fail("invalid_dream_model");
  const districts = new Set<string>();
  for (const [index, district] of model.districts.entries()) {
    if (!exact(district, ["id", "label", "sessionCount", "tokensTotal", "activeCount", "anomaly"])
        || district.label !== `城区 ${index + 1}` || district.sessionCount !== 0 || district.tokensTotal !== 0 || district.activeCount !== 0 || district.anomaly !== null
        || !aliasRx("district-", district.id) || districts.has(district.id)) fail("invalid_dream_model");
    districts.add(district.id);
  }
  const buildings = new Map<string, string>();
  for (const building of model.buildings) {
    if (!exact(building, ["id", "districtId", "archetype", "facade", "seed", "tokensTotal", "height", "footprint", "active", "builtFraction", "busyness", "aggregated", "extraCount", "startedAt", "endedAt"])
        || !["tower", "slab", "midrise", "block", "landmark"].includes(String(building.archetype)) || !Number.isInteger(building.facade) || Number(building.facade) < 0 || Number(building.facade) > 2
        || !finite(building.seed, 0, 1) || !finite(building.height, 0, 100_000) || !finite(building.footprint, 0, 100_000)
        || building.builtFraction !== 1 || building.startedAt !== 1 || building.tokensTotal !== 0 || building.active !== false || building.busyness !== 0
        || building.aggregated !== false || building.extraCount !== 0 || building.endedAt !== null
        || !aliasRx("building-", building.id) || !aliasRx("district-", building.districtId) || !districts.has(building.districtId) || buildings.has(building.id)) fail("invalid_dream_model");
    buildings.set(building.id, building.districtId);
  }
  const stats = model.stats;
  if (!exact(stats, ["renderedSessions", "aggregatedSessions", "totalSessions", "tokensTotal", "activeCount", "truncated"])
      || ["renderedSessions", "aggregatedSessions", "totalSessions", "tokensTotal", "activeCount"].some(key => stats[key] !== 0) || stats.truncated !== false) fail("invalid_dream_model");
  return { districts, buildings };
}

function validateVisual(value: any): { districts: Set<string>; buildings: Map<string, string> } {
  if (!exact(value, ["schema", "revision", "snapshot", "display", "palettes", "heroBuildingId"]) || value.schema !== "dream-city-snapshot:v2"
      || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !exact(value.snapshot, ["layout", "model"]) || !arr(value.palettes)) fail("invalid_visual_contract");
  const { districts, buildings } = validateModel(value.snapshot.model);
  if (value.palettes.length !== districts.size) fail("invalid_visual_contract");
  validateDisplay(value.display, districts, buildings);
  const seen = new Set<string>(); let shares = 0;
  for (const entry of value.palettes) {
    if (!exact(entry, ["districtId", "palette", "landmarkHeight", "flagShare"]) || !exact(entry.palette, ["wall", "roof", "accent", "park"])
        || ["wall", "roof", "accent", "park"].some(key => !exactColor(entry.palette[key])) || !finite(entry.landmarkHeight, 0, 90)
        || !aliasRx("district-", entry.districtId) || !districts.has(entry.districtId) || seen.has(entry.districtId) || !finite(entry.flagShare, 0, 1)) fail("invalid_visual_contract");
    seen.add(entry.districtId); shares += entry.flagShare;
  }
  if (shares > 0 && Math.abs(shares - 1) > 1e-9) fail("invalid_visual_contract");
  if (value.heroBuildingId !== null) {
    const district = buildings.get(String(value.heroBuildingId));
    const layoutDistricts = value.snapshot.layout?.data?.districts;
    if (!district || !arr(layoutDistricts) || !layoutDistricts.some((item: any) => item?.id === district
        && arr(item.slots?.__remoteMap) && item.slots.__remoteMap.some((slot: any) => arr(slot) && slot.length === 2 && slot[0] === value.heroBuildingId))) fail("invalid_visual_contract");
  }
  return { districts, buildings };
}

function validateGeometry(data: any): void {
  if (!Number.isSafeInteger(data.seed) || Number(data.seed) < 0 || Number(data.seed) > Number.MAX_SAFE_INTEGER
      || !Number.isInteger(data.scaleTier) || Number(data.scaleTier) < 1 || Number(data.scaleTier) > 32
      || !str(data.activityKey) || !/^dream-publication-[a-f0-9]{32}$/.test(data.activityKey)
      || !["tropical", "temperate", "boreal", "savanna", "eastasian", "arid"].includes(String(data.biome)) || !point(data.core) || !terrainMeta(data.terrain)
      || !finite(data.islandRadius, 10, 100_000) || !finite(data.extent, 10, 200_000) || !finite(data.boundsRadius, 0.01, 200_000)
      || !(data.geographyGeneratorId === "arid-dunes-v1" ? arr(data.coast) && data.coast.length === 0 : path(data.coast, 8)) || !path(data.river) || !path(data.districtAnchors) || !paths(data.highways) || !paths(data.boatLoops)
      || !(data.coastRoads === null || paths(data.coastRoads)) || !(data.culDeSacEnds === null || path(data.culDeSacEnds))) fail("invalid_dream_geometry");
  const hasGenerator = Object.hasOwn(data, "geographyGeneratorId") || Object.hasOwn(data, "geographyOptions")
    || Object.hasOwn(data, "features") || Object.hasOwn(data, "worldProfileKey");
  if (hasGenerator) {
    const generator = data.geographyGeneratorId;
    if (!(GEOGRAPHY_GENERATOR_IDS as readonly string[]).includes(generator) || !exact(data.features, ["coastline", "ocean", "river", "islets"])
        || Object.values(data.features).some(value => typeof value !== "boolean")
        || !str(data.worldProfileKey) || data.worldProfileKey.length < 1 || data.worldProfileKey.length > 512) fail("invalid_dream_geometry");
    try { validateGeographyBuildOptions(generator as GeographyGeneratorId, data.geographyOptions); } catch { fail("invalid_dream_geometry"); }
    if ((generator === "arid-dunes-v1") !== (data.biome === "arid")
        || (generator === "arid-dunes-v1" && Object.values(data.features).some(Boolean))
        || (generator === "coastal-islands-v1" && (data.features.coastline !== true || data.features.ocean !== true))) fail("invalid_dream_geometry");
  } else if (data.biome === "arid") fail("invalid_dream_geometry");
  const bounds = data.urbanBounds;
  if (!exact(bounds, ["left", "right", "north", "south"]) || ["left", "right", "north", "south"].some(k => !finite(bounds[k], -200_000, 200_000))
      || Number(bounds.left) > Number(bounds.right) || Number(bounds.north) > Number(bounds.south)) fail("invalid_dream_geometry");
  const arrCheck = (key: string, max: number, check: (x: any) => boolean) => arr(data[key]) && data[key].length <= max && data[key].every(check);
  if (!arrCheck("parkTrees", 50_000, item => exact(item, ["x", "z", "y", "seed"]) && placed(item) && finite(item.seed, 0, 1))
      || !arrCheck("bridges", 20_000, item => exact(item, ["from", "to", "angle", "length"]) && point(item.from) && point(item.to) && finite(item.angle, -100, 100) && finite(item.length, 0, 200_000))
      || !arrCheck("boatLanes", 5_000, item => exact(item, ["radius", "speed", "phase"]) && finite(item.radius, 0, 200_000) && finite(item.speed, -10_000, 10_000) && finite(item.phase, -10_000, 10_000))
      || !arrCheck("decorMountains", 5_000, item => exact(item, ["center", "radius", "terrain"]) && point(item.center) && finite(item.radius, 0.01, 100_000) && terrainMeta(item.terrain))
      || !arrCheck("seaMountains", 5_000, item => exact(item, ["center", "radius", "height", "seed"]) && point(item.center) && finite(item.radius, 0.01, 100_000) && finite(item.height, 0, 100_000) && finite(item.seed, -1e12, 1e12))) fail("invalid_dream_geometry");
  if (data.junctionRings !== null && !arrCheck("junctionRings", 20_000, item => exact(item, ["x", "z", "radius", "width", "kind"])
      && finite(item.x, -200_000, 200_000) && finite(item.z, -200_000, 200_000) && finite(item.radius, 0.01, 10_000) && finite(item.width, 0.01, 1_000) && ["major", "minor"].includes(String(item.kind)))) fail("invalid_dream_geometry");
  if (data.highwayRamps !== null && !arrCheck("highwayRamps", 20_000, item => exact(item, ["points", "width", "side"])
      && path(item.points) && finite(item.width, 0.01, 1_000) && (item.side === 1 || item.side === -1))) fail("invalid_dream_geometry");
}

function validateRoads(data: any): Set<string> {
  if (!arr(data.roadNodes) || !arr(data.roadEdges) || data.roadNodes.length > 50_000 || data.roadEdges.length > 20_000) fail("invalid_dream_roads");
  const nodes = new Set<string>();
  for (const node of data.roadNodes) {
    if (!exact(node, ["id", "x", "z"]) || !entity(node.id) || !finite(node.x, -200_000, 200_000) || !finite(node.z, -200_000, 200_000) || nodes.has(node.id)) fail("invalid_dream_roads");
    nodes.add(node.id);
  }
  const edges = new Set<string>(); let pointCount = 0;
  for (const edge of data.roadEdges) {
    if (!keys(edge, ["id", "from", "to", "width", "kind", "points"], ["bridge", "structure", "purpose"])
        || !entity(edge.id) || !nodes.has(String(edge.from)) || !nodes.has(String(edge.to)) || !finite(edge.width, 0.01, 1_000)
        || !["arterial", "local"].includes(String(edge.kind)) || (Object.hasOwn(edge, "bridge") && typeof edge.bridge !== "boolean")
        || (Object.hasOwn(edge, "structure") && !["ground-road", "ground-approach", "deck"].includes(String(edge.structure)))
        || (Object.hasOwn(edge, "purpose") && edge.purpose !== "waterfront") || !path(edge.points, 2, 5_000) || edges.has(String(edge.id))) fail("invalid_dream_roads");
    pointCount += edge.points.length; if (pointCount > 200_000) fail("invalid_dream_roads"); edges.add(edge.id as string);
  }
  return nodes;
}

function validateParcelValue(v: any): boolean {
  return keys(v, ["id", "blockId", "x", "z", "yaw", "zone", "width", "depth"], ["mergedWith"])
    && entity(v.id) && entity(v.blockId) && finite(v.x, -200_000, 200_000) && finite(v.z, -200_000, 200_000) && finite(v.yaw, -100, 100)
    && zone(v.zone) && finite(v.width, 0.01, 10_000) && finite(v.depth, 0.01, 10_000) && (!Object.hasOwn(v, "mergedWith") || entity(v.mergedWith));
}
function sameParcelFields(a: Obj, b: Obj): boolean {
  const fields = Object.keys(a);
  return fields.length === Object.keys(b).length && fields.every(field => Object.hasOwn(b, field) && a[field] === b[field]);
}
function sameMergedParcel(base: Obj, merged: Obj, partner: Obj | undefined): boolean {
  if (!partner || partner.id === base.id || merged.id !== base.id || merged.blockId !== base.blockId || merged.mergedWith !== partner.id
      || partner.blockId !== base.blockId || merged.yaw !== base.yaw || partner.yaw !== base.yaw
      || merged.zone !== base.zone || partner.zone !== base.zone || merged.depth !== base.depth || partner.depth !== base.depth) return false;
  const tx = Math.cos(base.yaw), tz = -Math.sin(base.yaw);
  const along = (partner.x - base.x) * tx + (partner.z - base.z) * tz;
  const lo = Math.min(-base.width / 2, along - partner.width / 2), hi = Math.max(base.width / 2, along + partner.width / 2);
  const mid = (lo + hi) / 2;
  const close = (actual: number, expected: number) => Math.abs(actual - expected) <= 1e-6;
  return close(merged.x, base.x + tx * mid) && close(merged.z, base.z + tz * mid) && close(merged.width, hi - lo);
}
function polygon(v: any): boolean { return path(v, 3, 5_000); }
function exclusion(v: any): boolean {
  if (v?.kind === "road-corridor" || v?.kind === "highway-corridor") return exact(v, ["id", "kind", "points", "width"]) && entity(v.id)
    && finite(v.width, 0.01, 10_000) && path(v.points, 2, 5_000);
  if (v?.kind === "site-circle") return exact(v, ["id", "kind", "x", "z", "radius"]) && entity(v.id)
    && finite(v.x, -200_000, 200_000) && finite(v.z, -200_000, 200_000) && finite(v.radius, 0.01, 10_000);
  return false;
}

function validateParcels(data: any, buildings: Map<string, string>): void {
  if (!arr(data.blocks) || !arr(data.districts) || data.blocks.length > 20_000 || data.districts.length > 32 || buildings.size > 5_000) fail("invalid_dream_parcels");
  const blockIds = new Set<string>(), sourceParcels = new Map<string, any>(); let total = 0;
  for (const block of data.blocks) {
    if (!keys(block, ["id", "districtId", "x", "z", "width", "depth", "zone", "parcels", "polygon"], ["holes", "surfaceCoverage", "surfaceExclusions", "vacant"])
        || !entity(block.id) || !entity(block.districtId) || !zone(block.zone) || !finite(block.x, -200_000, 200_000) || !finite(block.z, -200_000, 200_000)
        || !finite(block.width, 0.01, 10_000) || !finite(block.depth, 0.01, 10_000) || !polygon(block.polygon) || !arr(block.parcels)
        || (Object.hasOwn(block, "vacant") && typeof block.vacant !== "boolean")
        || (Object.hasOwn(block, "surfaceCoverage") && !["road-width-inset", "requires-envelope-clipping"].includes(String(block.surfaceCoverage)))
        || (Object.hasOwn(block, "holes") && (!arr(block.holes) || block.holes.length > 1_000 || !block.holes.every(polygon)))
        || (Object.hasOwn(block, "surfaceExclusions") && (!arr(block.surfaceExclusions) || block.surfaceExclusions.length > 5_000 || !block.surfaceExclusions.every(exclusion)))) fail("invalid_dream_parcels");
    if (blockIds.has(block.id as string) || block.parcels.length > 5_000) fail("invalid_dream_parcels");
    blockIds.add(block.id as string); total += block.parcels.length; if (total > 100_000) fail("invalid_dream_parcels");
    for (const p of block.parcels) {
      if (!validateParcelValue(p) || p.blockId !== block.id) fail("invalid_dream_parcels");
      const id = `${p.blockId}/${p.id}`; if (sourceParcels.has(id)) fail("invalid_dream_parcels"); sourceParcels.set(id, p);
    }
  }
  const slottedBuildings = new Set<string>(), slottedParcels = new Set<string>(), districtIds = new Set<string>();
  for (const district of data.districts) {
    if (!aliasRx("district-", district?.id) || districtIds.has(district.id) || !exact(district.slots, ["__remoteMap"]) || !arr(district.slots.__remoteMap) || district.slots.__remoteMap.length > 5_000) fail("invalid_dream_parcels");
    districtIds.add(district.id);
    for (const slot of district.slots.__remoteMap) {
      if (!arr(slot) || slot.length !== 2 || !aliasRx("building-", slot[0]) || buildings.get(slot[0]) !== district.id || slottedBuildings.has(slot[0]) || !validateParcelValue(slot[1])) fail("invalid_dream_parcels");
      slottedBuildings.add(slot[0] as string);
      const parcel = slot[1] as Obj; const parcelKey = `${parcel.blockId}/${parcel.id}`;
      if (slottedParcels.has(parcelKey)) fail("invalid_dream_parcels"); slottedParcels.add(parcelKey);
      const source = sourceParcels.get(parcelKey);
      const partner = source && typeof parcel.mergedWith === "string" ? sourceParcels.get(`${parcel.blockId}/${parcel.mergedWith}`) : undefined;
      if (source ? !(sameParcelFields(source, parcel) || sameMergedParcel(source, parcel, partner)) : parcel.zone !== "waterfront") fail("invalid_dream_parcels");
    }
  }
  if (slottedBuildings.size !== buildings.size || [...buildings.keys()].some(id => !slottedBuildings.has(id))) fail("invalid_dream_parcels");
}

function validateDistricts(data: any, model: any): void {
  if (!arr(data.districts) || !arr(model.districts) || data.districts.length !== model.districts.length || data.districts.length > 32) fail("invalid_dream_districts");
  const expected = new Map<string, any>(model.districts.map((row: any) => [row.id, row]));
  const owners = new Map(model.buildings.map((row: any) => [row.id, row.districtId])); const seen = new Set<string>();
  const numberMap = (value: any, allowed: Set<string>, min: number, max: number) => {
    if (!exact(value, ["__remoteMap"]) || !arr(value.__remoteMap) || value.__remoteMap.length !== allowed.size) return false;
    const seen = new Set<string>();
    return value.__remoteMap.every((pair: any) => arr(pair) && pair.length === 2 && aliasRx("building-", pair[0])
      && allowed.has(pair[0]) && !seen.has(pair[0]) && seen.add(pair[0]) && finite(pair[1], min, max));
  };
  for (const d of data.districts) {
    if (!exact(d, ["id", "label", "center", "radius", "terrain", "slots", "grounds", "roads", "carPaths", "river", "riverHalfWidth", "trees", "plaza", "anomaly", "sessionCount", "landValue"])
        || !point(d.center) || !finite(d.radius, 0, 200_000) || !terrainMeta(d.terrain) || d.anomaly !== null || d.sessionCount !== 0
        || !arr(d.roads) || d.roads.length !== 0 || !paths(d.carPaths) || !(d.river === null || path(d.river)) || !finite(d.riverHalfWidth, 0, 10_000)
        || !exact(d.plaza, ["x", "z", "y"]) || !finite(d.plaza.x, -200_000, 200_000) || !finite(d.plaza.z, -200_000, 200_000) || !finite(d.plaza.y, -100_000, 100_000)
        || !arr(d.trees) || d.trees.length > 50_000 || !d.trees.every((tree: any) => exact(tree, ["x", "z", "y", "seed"])
          && finite(tree.x, -200_000, 200_000) && finite(tree.z, -200_000, 200_000) && finite(tree.y, -100_000, 100_000) && finite(tree.seed, 0, 1))
        || !exact(d.slots, ["__remoteMap"])) fail("invalid_dream_districts");
    if (!aliasRx("district-", d.id) || seen.has(d.id) || expected.get(d.id)?.label !== d.label) fail("invalid_dream_districts"); seen.add(d.id);
    const slots = d.slots.__remoteMap;
    if (!arr(slots) || slots.length > 5_000) fail("invalid_dream_districts");
    const allowed = new Set<string>();
    for (const slot of slots) {
      if (!arr(slot) || slot.length !== 2 || !aliasRx("building-", slot[0]) || owners.get(slot[0]) !== d.id || allowed.has(slot[0])) fail("invalid_dream_districts");
      allowed.add(slot[0] as string);
    }
    if (!numberMap(d.grounds, allowed, -100_000, 100_000) || !numberMap(d.landValue, allowed, 0, 1)) fail("invalid_dream_districts");
  }
}

function validateFacilities(data: any, model: any): void {
  const districtIds = new Set(model.districts.map((item: any) => item.id));
  for (const name of ["massing", "civics", "contextBuildings", "gardens"]) if (!arr(data[name]) || data[name].length > 20_000) fail("invalid_dream_facilities");
  for (const item of data.massing as any[]) if (!exact(item, ["districtId", "x", "z", "y", "count", "tokens", "height"]) || !districtIds.has(item.districtId)
      || !placed(item) || item.count !== 0 || item.tokens !== 0 || !finite(item.height, 0, 100_000)) fail("invalid_dream_facilities");
  for (const item of data.civics as any[]) if (!exact(item, ["id", "kind", "districtId", "parcelId", "x", "z", "y", "yaw", "width", "depth", "unlockAt"])
      || !entity(item.id) || !entity(item.parcelId) || !districtIds.has(item.districtId) || !["school", "mall", "hospital"].includes(item.kind)
      || !rect(item) || item.unlockAt !== 0) fail("invalid_dream_facilities");
  for (const item of data.contextBuildings as any[]) if (!exact(item, ["id", "x", "z", "y", "yaw", "width", "depth", "height", "seed", "zone", "appearAt"])
      || !entity(item.id) || !rect(item) || !zone(item.zone) || !finite(item.height, 0, 100_000) || !finite(item.seed, 0, 1) || item.appearAt !== 0) fail("invalid_dream_facilities");
  for (const item of data.gardens as any[]) if (!exact(item, ["id", "districtId", "blockId", "x", "z", "y", "yaw", "width", "depth", "seed"])
      || !entity(item.id) || !entity(item.blockId) || !districtIds.has(item.districtId) || !rect(item) || !finite(item.seed, 0, 1)) fail("invalid_dream_facilities");
  if (data.districtLandmarks !== null) {
    if (!arr(data.districtLandmarks) || data.districtLandmarks.length > 32) fail("invalid_dream_facilities");
    const seen = new Set<string>();
    for (const item of data.districtLandmarks as any[]) if (!exact(item, ["districtId", "parcelId", "x", "z", "y", "yaw"])
        || !districtIds.has(item.districtId) || !entity(item.parcelId) || !placed(item) || !finite(item.yaw, -100, 100) || seen.has(item.districtId)) fail("invalid_dream_facilities"); else seen.add(item.districtId);
  }
}

function validateFacilityReferences(data: any): void {
  const blocks = data.blocks as any[];
  if (!arr(blocks)) fail("invalid_dream_facilities");
  const blockIds = new Set(blocks.map(block => block.id));
  const parcels = new Set(blocks.flatMap(block => arr(block.parcels) ? block.parcels.map((p: any) => p.id) : []));
  for (const garden of data.gardens as any[]) if (!blockIds.has(garden.blockId)) fail("invalid_dream_facilities");
  if (arr(data.districtLandmarks)) for (const landmark of data.districtLandmarks as any[]) if (!parcels.has(landmark.parcelId)) fail("invalid_dream_facilities");
}

function validConfig(config: any, key: any): boolean {
  if (config === null) return key === "none" || (str(key) && /^dream-publication-[a-f0-9]{32}$/.test(key));
  const fields = ["preferredAzimuth", "azimuthTolerance", "segmentArc", "wetSandWidth", "drySandWidth", "promenadeOffset", "boulevardOffset", "hotelOffset", "bandOuter", "maxCoastalSlope", "maxCoastalHeight", "riverMargin", "siteMargin", "minValidRatio", "bayHalfWidth", "bayShift"];
  if (!exact(config, ["profile", "version", "biome", ...fields]) || config.profile !== "miami-coastal" || config.biome !== "tropical"
      || !Number.isInteger(config.version) || config.version < 1 || config.version > 100 || fields.some(field => !finite(config[field], -10_000, 10_000))
      || !finite(config.minValidRatio, 0, 1) || !finite(config.bayHalfWidth, 0, 1) || !finite(config.bayShift, -1, 1) || !str(key) || key.length > 512) return false;
  if (/^dream-publication-[a-f0-9]{32}$/.test(key)) return true;
  const prefix = `miami-coastal:v${config.version}:`; if (!key.startsWith(prefix)) return false;
  const values = key.slice(prefix.length).split(",");
  return values.length === fields.length && values.every((value, i) => /^[-+\deE.]+$/.test(value) && Number(value) === config[fields[i]!]);
}

function validateCoastal(data: any): void {
  if (data.geographyGeneratorId === "arid-dunes-v1" && (data.coastalConfig !== null
      || !(data.coastalConfigKey === "none" || (str(data.coastalConfigKey) && /^dream-publication-[a-f0-9]{32}$/.test(data.coastalConfigKey))))) fail("invalid_dream_coast");
  if (data.geographyGeneratorId === "arid-dunes-v1" && data.seaside !== null) fail("invalid_dream_coast");
  if (!validConfig(data.coastalConfig, data.coastalConfigKey)) fail("invalid_dream_coast");
  const nodes = data.roadNodes as any[];
  if (!arr(nodes)) fail("invalid_dream_coast");
  const nodeIds = new Set(nodes.map(item => item.id));
  const allowedReason = ["hotel-line-off-land", "boulevard-off-land", "steep-promenade", "steep-boulevard", "high-ground", "boulevard-high-ground", "river", "river-boulevard", "reservation", "boulevard-reservation"];
  const seaside = data.seaside;
  if (seaside !== null) {
    if (!exact(seaside, ["id", "azimuthFrom", "azimuthTo", "samples", "validRatio", "degraded", "reason"]) || !entity(seaside.id)
        || !finite(seaside.azimuthFrom, -100, 100) || !finite(seaside.azimuthTo, -100, 100) || !finite(seaside.validRatio, 0, 1) || typeof seaside.degraded !== "boolean"
        || !(seaside.reason === null || seaside.reason === "no-coast" || (str(seaside.reason) && seaside.reason.startsWith("valid-ratio-")
          && seaside.reason.slice("valid-ratio-".length).length === 4 && finite(Number(seaside.reason.slice("valid-ratio-".length)), 0, 1)))) fail("invalid_dream_coast");
    if (!arr(seaside.samples) || seaside.samples.length > 20_000) fail("invalid_dream_coast");
    for (const sample of seaside.samples as any[]) if (!exact(sample, ["azimuth", "waterline", "inward", "wetOuter", "dryOuter", "promenade", "boulevard", "hotelLine", "outer", "groundY", "valid", "reason"])
        || !finite(sample.azimuth, -100, 100) || !finite(sample.groundY, -100_000, 100_000) || typeof sample.valid !== "boolean"
        || ["waterline", "inward", "wetOuter", "dryOuter", "promenade", "boulevard", "hotelLine", "outer"].some(field => !point(sample[field]))
        || !(sample.reason === null || allowedReason.includes(String(sample.reason)))) fail("invalid_dream_coast");
  }
  const siteKinds: Record<string, string[]> = {
    publicSites: ["civic", "station", "stadium", "park", "tower", "harbor"],
    landmarks: ["tv-tower", "sail-opera", "arch", "pagoda", "lighthouse", "ferris-wheel", "suspension-bridge", "twin-towers", "twist-tower", "villa-complex", "islet-mansion", "islet-grounds"],
  };
  for (const [name, kinds] of Object.entries(siteKinds)) {
    if (!arr(data[name]) || data[name].length > 20_000) fail("invalid_dream_coast");
    const seen = new Set<string>();
    for (const item of data[name] as any[]) {
      const allowed = name === "landmarks" ? ["access", "to", "shore", "reach", "scale", "variant", "roadZ"] : ["access"];
      if (!keys(item, ["id", "kind", "x", "z", "yaw", "radius"], allowed) || !entity(item.id) || !kinds.includes(item.kind)
          || !finite(item.x, -200_000, 200_000) || !finite(item.z, -200_000, 200_000) || !finite(item.yaw, -100, 100)
          || !finite(item.radius, name === "landmarks" ? 0 : 0.01, 100_000) || (item.access !== undefined && !validPlotAccess(item.access, nodeIds))
          || (item.to !== undefined && !point(item.to)) || (item.shore !== undefined && !point(item.shore))
          || (item.reach !== undefined && !finite(item.reach, 0, 200_000)) || (item.scale !== undefined && !finite(item.scale, 0.01, 100))
          || (item.roadZ !== undefined && !finite(item.roadZ, -200_000, 200_000))
          || (item.variant !== undefined && !["estate", "golf", "studio"].includes(String(item.variant))) || seen.has(item.id)) fail("invalid_dream_coast");
      seen.add(item.id);
    }
  }
}

function validPlotAccess(access: any, nodeIds: Set<string>): boolean {
  return keys(access, ["role", "nodeId", "ownerX", "ownerZ", "ownerYaw"], ["capability", "entranceId", "entranceEvidence", "doorX", "doorZ"])
    && access.role === "plot-gate" && finite(access.ownerX, -200_000, 200_000) && finite(access.ownerZ, -200_000, 200_000) && finite(access.ownerYaw, -100, 100)
    && entity(access.nodeId) && nodeIds.has(access.nodeId)
    && (access.capability === undefined || ["ground-frontage", "island-causeway", "shore-plot-boundary"].includes(String(access.capability)))
    && (access.entranceId === undefined || access.entranceId === null || entity(access.entranceId))
    && (access.entranceEvidence === undefined || ["model-position", "plot-proxy"].includes(String(access.entranceEvidence)))
    && (access.doorX === undefined || finite(access.doorX, -200_000, 200_000)) && (access.doorZ === undefined || finite(access.doorZ, -200_000, 200_000))
    && (Object.hasOwn(access, "doorX") === Object.hasOwn(access, "doorZ"));
}

function samePoint(a: any, b: any) { return obj(a) && obj(b) && finite(a.x, -200_000, 200_000) && finite(a.z, -200_000, 200_000)
  && finite(b.x, -200_000, 200_000) && finite(b.z, -200_000, 200_000) && Math.abs(a.x - b.x) <= 0.01 && Math.abs(a.z - b.z) <= 0.01; }
function validateAirport(data: any): void {
  const nodes = validateRoads(data);
  if (!Object.hasOwn(data, "airport")) fail("invalid_dream_airport");
  const airport = data.airport;
  if (airport === null) return;
  if (!keys(airport, ["shore", "centre", "yaw", "outward"], ["causeway"]) || !point(airport.shore) || !point(airport.centre) || !point(airport.outward)
      || !finite(airport.yaw, -Math.PI, Math.PI)) fail("invalid_dream_airport");
  const { x, z } = airport.outward as Obj;
  if (Math.abs(Math.hypot(Number(x), Number(z)) - 1) > 1e-5 || Math.abs(Math.sin(Number(airport.yaw)) - Number(x)) > 1e-5 || Math.abs(Math.cos(Number(airport.yaw)) - Number(z)) > 1e-5) fail("invalid_dream_airport");
  if (!Object.hasOwn(airport, "causeway")) return;
  const causeway = airport.causeway;
  if (!exact(causeway, ["from", "fromNode", "to"]) || !point(causeway.from) || !point(causeway.to) || !samePoint(airport.shore, causeway.from)) fail("invalid_dream_airport");
  const expected = { x: Number(airport.centre.x) - Number(x) * 51, z: Number(airport.centre.z) - Number(z) * 51 };
  if (!samePoint(expected, causeway.to) || !entity(causeway.fromNode) || !nodes.has(causeway.fromNode)
      || !(data.roadNodes as any[]).some(node => node.id === causeway.fromNode && samePoint(node, causeway.from))) fail("invalid_dream_airport");
  const targetNodes = new Set((data.roadNodes as any[]).filter(node => samePoint(node, causeway.to)).map(node => node.id));
  const linked = (data.roadEdges as any[]).some(edge => {
    if (!arr(edge.points)) return false;
    return edge.bridge === true && edge.structure === "deck" && edge.points.length === 2
      && ((edge.from === causeway.fromNode && targetNodes.has(edge.to) && samePoint(edge.points[0], causeway.from) && samePoint(edge.points[1], causeway.to))
        || (edge.to === causeway.fromNode && targetNodes.has(edge.from) && samePoint(edge.points[1], causeway.from) && samePoint(edge.points[0], causeway.to)));
  });
  if (!linked) fail("invalid_dream_airport");
}

/** Deep business-contract validator. This is intentionally app-owned TypeScript. */
export function validateDreamCandidate(value: any): asserts value is DreamCitySnapshotV1 {
  if (!obj(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PLAIN) fail("dream_candidate_too_large");
  const { districts, buildings } = validateVisual(value);
  const snapshot = value.snapshot as Obj;
  const model = snapshot.model as Obj;
  const layout = snapshot.layout as Obj;
  if (!exact(layout, ["schema", "revision", "generatorVersion", "seed", "backdrop", "camera", "data"]) || layout.schema !== "remote-city-layout:v1"
      || layout.generatorVersion !== 1 || layout.revision !== value.revision || layout.seed !== (layout.data as any)?.seed
      || !["off", "auto", "full"].includes(String(layout.backdrop))) fail("invalid_dream_layout");
  const camera = layout.camera;
  if (!exact(camera, ["position", "target", "up", "fov"]) || !finite(camera.fov, 10, 120)
      || ["position", "target", "up"].some(field => !arr(camera[field]) || camera[field].length !== 3 || !camera[field].every((n: unknown) => finite(n, -200_000, 200_000)))) fail("invalid_dream_layout");
  const data = layout.data as Obj;
  const legacyFields = ["scaleTier", "biome", "core", "islandRadius", "seed", "districts", "blocks", "roadNodes", "roadEdges", "activityKey", "coastRoads", "culDeSacEnds", "junctionRings", "highwayRamps", "districtLandmarks", "terrain", "extent", "coast", "river", "publicSites", "parkTrees", "urbanBounds", "bridges", "boatLanes", "boundsRadius", "decorMountains", "districtAnchors", "highways", "massing", "civics", "landmarks", "seaside", "airport", "coastalConfigKey", "coastalConfig", "contextBuildings", "gardens", "boatLoops", "seaMountains"];
  const fields = [...legacyFields.slice(0, 5), "features", "geographyGeneratorId", "geographyOptions", "worldProfileKey", ...legacyFields.slice(5)];
  if (!exact(data, fields) && !exact(data, legacyFields)) fail("invalid_dream_layout");
  validateGeometry(data); validateDistricts(data, model); validateParcels(data, buildings); validateFacilities(data, model);
  validateFacilityReferences(data); validateCoastal(data); validateAirport(data);
  // Keep the existing full visitor parser as a second independent compatibility/bounds pass.
  parseDreamCitySnapshot(new TextEncoder().encode(JSON.stringify(value)));
}

function findAliases(root: unknown, ids = new Set<string>()): Set<string> {
  if (typeof root === "string" && aliasPrefix(root)) ids.add(root);
  else if (Array.isArray(root)) root.forEach(item => findAliases(item, ids));
  else if (obj(root)) Object.entries(root).forEach(([key, item]) => { if (aliasPrefix(key)) ids.add(key); findAliases(item, ids); });
  return ids;
}
function randomAlias(prefix: string, byteLength = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  if (bytes.every(byte => byte === 0)) bytes[byteLength - 1] = 1;
  return `${prefix}${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
function randomEntityAlias(prefix: string): string {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return `${prefix}${String(value[0] % 99_999_999 + 1).padStart(8, "0")}`;
}
function compactPointPrecision(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) return value.map(item => parentKey === "parkTrees" && obj(item)
    ? Object.fromEntries(Object.entries(item).map(([key, number]) => [key, typeof number === "number"
      ? compactNumberPrecision(number, key === "seed" ? 1_000_000 : 100) : compactPointPrecision(number, key)]))
    : compactPointPrecision(item, parentKey));
  if (!obj(value)) return value;
  if (parentKey !== "outward" && Object.keys(value).length === 2 && Object.hasOwn(value, "x") && Object.hasOwn(value, "z")
      && finite(value.x, -200_000, 200_000) && finite(value.z, -200_000, 200_000)) {
    return { x: compactNumberPrecision(value.x, 1_000), z: compactNumberPrecision(value.z, 1_000) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactPointPrecision(item, key)]));
}
function compactNumberPrecision(number: number, scale: number): number {
  const rounded = Math.round(number * scale) / scale;
  return Object.is(rounded, -0) ? 0 : rounded;
}
function rewrite(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map(item => rewrite(item, map));
  if (!obj(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [map.get(key) ?? key, rewrite(item, map)]));
}

/** Validate, anonymize IDs per publication, validate again, then bound gzip encoding. */
export async function prepareDreamSnapshotForPublication(value: unknown): Promise<{ candidate: DreamCitySnapshotV1; envelope: DreamSnapshotEnvelopeV1 }> {
  validateDreamCandidate(value);
  const sourceIds = findAliases(value);
  const mapping = new Map<string, string>();
  const generated = new Set<string>(sourceIds);
  for (const source of sourceIds) {
    const prefix = aliasPrefix(source)!;
    let next: string;
    // Entity aliases are publication-scoped opaque IDs. Eight random decimal
    // digits keep repeated scene references compact; collision checks preserve
    // referential integrity. The publication activity key remains 128-bit.
    do { next = randomEntityAlias(prefix); } while (generated.has(next));
    generated.add(next); mapping.set(source, next);
  }
  const candidate = compactPointPrecision(structuredClone(rewrite(value, mapping))) as DreamCitySnapshotV1;
  candidate.snapshot.layout.data.coastalConfigKey = randomAlias("dream-publication-", 16);
  validateDreamCandidate(candidate);
  const plain = new TextEncoder().encode(JSON.stringify(candidate));
  const envelope = await encodeDreamSnapshot(plain);
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > MAX_ENVELOPE) fail("dream_candidate_too_large");
  return { candidate, envelope };
}
