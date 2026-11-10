import type { CityModel } from "../../cityModel";
import { createCityShape } from "../../engine/cityShape";
import type { CityLayout, BackdropMode } from "../../engine/cityLayout";
import { buildGeography } from "../../engine/planner/geography";
import { gradeRoadLandings } from "../../engine/surface/roadLandingGrading";
import { paletteFor, type DistrictPalette } from "../../engine/cityTextures";
import type { ReturnCameraView } from "../../game/types";
import { remoteArenaFromSite, type RemoteArenaV1 } from "../../game/mecha/contracts/arena";
import type { CityMechaSite } from "../../game/mecha/citySite";

const LAYOUT_FIELDS = [
  "scaleTier", "biome", "core", "islandRadius", "seed", "districts", "blocks", "roadNodes", "roadEdges",
  "activityKey", "coastRoads", "culDeSacEnds", "junctionRings", "highwayRamps", "districtLandmarks",
  "terrain", "extent", "coast", "river", "publicSites", "parkTrees", "urbanBounds", "bridges", "boatLanes",
  "boundsRadius", "decorMountains", "districtAnchors", "highways", "massing", "civics", "landmarks", "seaside",
  "airport", "coastalConfigKey", "coastalConfig", "contextBuildings", "gardens", "boatLoops", "seaMountains",
] as const;

const OMIT_LAYOUT_FIELDS = new Set([
  "planningOutcome", "derivedFinalization", "displayOutcome", "placementBudget", "sessionCapacity", "placementReport",
  "connections", "solveReport", "roadBlockReport", "skeletonDiagnostics", "skeletonReservationIds", "roadGenerationDiagnostics",
  "demandCatalogue", "siteObligations", "primaryAnchorNodeId", "networkVersion", "derivedNetworkVersion",
]);

type RemoteTerrainMeta = { center: { x: number; z: number }; radius: number; hasRiver: boolean };
type RemoteLayoutData = Record<string, unknown>;
export type RemoteCityLayoutSnapshotV1 = {
  schema: "remote-city-layout:v1";
  revision: number;
  generatorVersion: 1;
  seed: number;
  backdrop: BackdropMode;
  camera: { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; fov: number };
  data: RemoteLayoutData;
};

/** Display-only payload. None of the source session/building ids are serialized. */
export type RemoteCityDisplay = {
  schema: "remote-city-display:v2";
  seed: number;
  site: RemoteArenaV1;
  layout: RemoteCityLayoutSnapshotV1;
  model: Omit<CityModel, "rows" | "generatedAt" | "windowStartMs" | "windowEndMs" | "windowLabel"> & { rows: Array<{ id: string; title: string | null }> };
};

/** The renderer's city inputs are independent of any particular game. */
export type RemoteCitySnapshot = Pick<RemoteCityDisplay, "layout" | "model">;
export type RemoteCityVisualPalette = { districtId: string; palette: DistrictPalette; landmarkHeight: number; flagShare: number };

/** Preserve appearance without sending the host's district identifiers. */
export function captureCityVisualPalettes(model: CityModel, snapshot: RemoteCitySnapshot): RemoteCityVisualPalette[] {
  if (model.districts.length !== snapshot.model.districts.length) throw new Error("remote_city_district_mismatch");
  return model.districts.map((district, index) => ({
    districtId: snapshot.model.districts[index].id,
    // Dream appearance is deliberately independent from harness identity and
    // session-derived visual overrides. The scene contains one neutral palette.
    palette: { ...paletteFor("dream-anonymous") },
    landmarkHeight: 36,
    flagShare: 1 / snapshot.model.districts.length,
  }));
}

/** Capture the crown chosen after placement; the result contains only a publication alias. */
export function captureCityVisualHero(model: CityModel, layout: CityLayout, snapshot: RemoteCitySnapshot): string | null {
  if (model.buildings.length !== snapshot.model.buildings.length) throw new Error("remote_city_building_mismatch");
  const districts = new Map(layout.districts.map(district => [district.id, district]));
  const placed = model.buildings.flatMap((building, index) => {
    const slot = districts.get(building.districtId)?.slots.get(building.id);
    const publicId = snapshot.model.buildings[index]?.id;
    return slot && publicId ? [{ publicId, x: slot.x, z: slot.z }] : [];
  }).sort((a, b) => a.z - b.z || a.x - b.x || a.publicId.localeCompare(b.publicId));
  return placed[0]?.publicId ?? null;
}

/**
 * Project a snapshot of the already-applied desktop geometry. IDs are aliases only
 * after placement is complete, so their spelling cannot affect remote layout.
 */
export function createCitySnapshotProjector(seed: number, layout: CityLayout, backdrop: BackdropMode, camera: ReturnCameraView) {
  if (layout.seed !== seed) throw new Error("remote_city_seed_mismatch");
  return (model: CityModel): RemoteCitySnapshot => {
    const districtIds = [...new Set(model.districts.map(item => item.id))].sort();
    const districtMap = new Map(districtIds.map((id, index) => [id, `district-${String(index + 1).padStart(4, "0")}`]));
    const buildingIds = [...new Set([...model.buildings.map(item => item.id), ...model.rows.keys()])].sort();
    const buildingMap = new Map(buildingIds.map((id, index) => [id, `building-${String(index + 1).padStart(4, "0")}`]));
    const aliases = new Map<string, string>([...districtMap, ...buildingMap]);
    let entityOrdinal = 0;
    for (const id of [...new Set(collectIdentifierValues(layout))].sort()) {
      if (!aliases.has(id)) {
        const prefix = id.startsWith("hotel:") ? "hotel:entity-" : id.startsWith("oceandrive:") ? "oceandrive:entity-" : "entity-";
        aliases.set(id, `${prefix}${String(++entityOrdinal).padStart(6, "0")}`);
      }
    }
    const startedAtRank = new Map([...model.buildings]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((building, index) => [building.id, index + 1]));
    const modelProjection = {
      districts: model.districts.map(district => ({
        id: districtMap.get(district.id)!, label: district.label, sessionCount: district.sessionCount,
        tokensTotal: district.tokensTotal, activeCount: district.activeCount, anomaly: null,
      })),
      buildings: model.buildings.map(building => ({
        id: buildingMap.get(building.id)!, districtId: districtMap.get(building.districtId)!,
        archetype: building.archetype, facade: building.facade, seed: building.seed, tokensTotal: building.tokensTotal,
        height: building.height, footprint: building.footprint, active: building.active, builtFraction: building.builtFraction,
        busyness: building.busyness, aggregated: building.aggregated, extraCount: building.extraCount,
        startedAt: startedAtRank.get(building.id) ?? 0, endedAt: null,
      })),
      stats: {
        renderedSessions: model.stats.renderedSessions,
        aggregatedSessions: model.stats.aggregatedSessions,
        totalSessions: model.stats.totalSessions,
        tokensTotal: model.stats.tokensTotal,
        activeCount: model.stats.activeCount,
        truncated: model.stats.truncated,
      },
      rows: [...model.rows].map(([id, row]) => ({ id: buildingMap.get(id)!, title: row.title })),
    };
    const source = compactLayoutForDisplay(layout);
    const layoutData = Object.fromEntries(LAYOUT_FIELDS.map(key => [key, projectValue((source as unknown as Record<string, unknown>)[key], key, aliases)]));
    layoutData.activityKey = `remote-layout-${layout.seed}-${layout.scaleTier}`;
    const snapshot: RemoteCityLayoutSnapshotV1 = {
      schema: "remote-city-layout:v1", revision: 1, generatorVersion: 1, seed,
      backdrop, camera: {
        position: camera.position, target: camera.target, up: camera.up, fov: camera.fov,
      },
      data: layoutData,
    };
    return {
      layout: snapshot,
      model: modelProjection as RemoteCityDisplay["model"],
    };
  };
}

/** The existing mecha handoff adds its arena to the shared city snapshot. */
export function createCityDisplayProjector(seed: number, site: CityMechaSite, layout: CityLayout, backdrop: BackdropMode, camera: ReturnCameraView) {
  const projectCity = createCitySnapshotProjector(seed, layout, backdrop, camera);
  return (model: CityModel): RemoteCityDisplay => ({
    schema: "remote-city-display:v2", seed,
    site: remoteArenaFromSite(site, { arenaId: "city-flat", sourceRevision: "flat-1" }),
    ...projectCity(model),
  });
}

/** Drop planner-only parcel proofs and duplicate district fields not consumed by CityParts. */
function compactLayoutForDisplay(layout: CityLayout): CityLayout {
  const parcel = (item: CityLayout["blocks"][number]["parcels"][number]) => {
    const { frontage: _frontage, ...display } = item;
    return display;
  };
  const block = (item: CityLayout["blocks"][number]) => {
    const { sourceFaceId: _sourceFaceId, networkVersion: _networkVersion, roadBoundary: _roadBoundary, parcels, ...display } = item;
    return { ...display, parcels: parcels.map(parcel) };
  };
  return {
    ...layout,
    blocks: layout.blocks.map(block),
    districts: layout.districts.map(district => ({
      id: district.id, label: district.label, center: district.center, radius: district.radius, terrain: district.terrain,
      slots: new Map([...district.slots].map(([id, item]) => [id, parcel(item)])), grounds: district.grounds,
      carPaths: district.carPaths, river: district.river, riverHalfWidth: district.riverHalfWidth, trees: district.trees,
      plaza: district.plaza, anomaly: null, sessionCount: district.sessionCount, landValue: district.landValue,
      roads: [],
    })),
  };
}

/** Rebuild the JSON DTO's Maps and deterministic terrain functions for CityParts. */
export function hydrateRemoteCityLayout(snapshot: RemoteCityLayoutSnapshotV1): CityLayout {
  if (snapshot.schema !== "remote-city-layout:v1" || snapshot.generatorVersion !== 1 || snapshot.data.seed !== snapshot.seed) {
    throw new Error("remote_city_layout_unsupported");
  }
  const data = hydrateValue(snapshot.data) as Record<string, unknown>;
  const config = data.coastalConfig as { bayHalfWidth?: number; bayShift?: number } | null;
  const geography = buildGeography(snapshot.seed, Number(data.islandRadius), createCityShape(snapshot.seed), {
    bay: config && Number(config.bayHalfWidth) > 0 ? { halfWidth: Number(config.bayHalfWidth), shift: Number(config.bayShift ?? 0) } : null,
  });
  const roads = data.roadEdges as CityLayout["roadEdges"];
  const terrain = gradeRoadLandings(geography.terrain, roads);
  const terrainFor = (meta: RemoteTerrainMeta): CityLayout["terrain"] => ({
    ...terrain, center: meta.center, radius: meta.radius, hasRiver: meta.hasRiver,
  });
  data.terrain = terrainFor(data.terrain as RemoteTerrainMeta);
  data.districts = (data.districts as Array<Record<string, unknown>>).map(district => ({
    ...district, terrain: terrainFor(district.terrain as RemoteTerrainMeta),
  }));
  data.decorMountains = (data.decorMountains as Array<Record<string, unknown>>).map(mountain => ({
    ...mountain, terrain: terrainFor(mountain.terrain as RemoteTerrainMeta),
  }));
  return data as unknown as CityLayout;
}

function isIdentifierField(key: string): boolean {
  return key === "id" || key === "from" || key === "to" || key === "fromNode" || key === "toNode" || key === "mergedWith" || key.endsWith("Id");
}

function collectIdentifierValues(value: unknown, key = "", output = new Set<string>()): Set<string> {
  if (value instanceof Map) {
    for (const [mapKey, entry] of value) {
      if (typeof mapKey === "string") output.add(mapKey);
      collectIdentifierValues(entry, "", output);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) collectIdentifierValues(entry, key, output);
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) collectIdentifierValues(child, childKey, output);
  } else if (typeof value === "string" && isIdentifierField(key)) output.add(value);
  return output;
}

function projectValue(value: unknown, key: string, aliases: Map<string, string>): unknown {
  if (value === undefined || typeof value === "function") return null;
  if (typeof value === "string") return isIdentifierField(key) ? aliases.get(value) ?? "entity-000000" : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value instanceof Map) return { __remoteMap: [...value].map(([mapKey, entry]) => [
    typeof mapKey === "string" ? aliases.get(mapKey) ?? "entity-000000" : mapKey,
    projectValue(entry, "", aliases),
  ]) };
  if (Array.isArray(value)) return value.map(entry => projectValue(entry, key, aliases));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.height === "function" && typeof record.slope === "function" && record.center && typeof record.center === "object") {
      return { __remoteTerrain: { center: record.center as RemoteTerrainMeta["center"], radius: record.radius as number, hasRiver: record.hasRiver as boolean } satisfies RemoteTerrainMeta };
    }
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(record)) {
      if (OMIT_LAYOUT_FIELDS.has(childKey) || typeof child === "function") continue;
      result[childKey] = projectValue(child, childKey, aliases);
    }
    return result;
  }
  return null;
}

function hydrateValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrateValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.__remoteTerrain && typeof record.__remoteTerrain === "object") return record.__remoteTerrain as RemoteTerrainMeta;
  if (Array.isArray(record.__remoteMap)) return new Map((record.__remoteMap as unknown[][]).map(([key, entry]) => [key, hydrateValue(entry)]));
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, hydrateValue(entry)]));
}
