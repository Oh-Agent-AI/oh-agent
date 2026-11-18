import {
  ACTOR_INTENT_KINDS_V1, ANCHOR_KINDS_V2, ROAD_KINDS_V2, TRAVEL_MODES_V1,
  WORLD_CAPABILITIES_V2, WORLD_VOLUME_KINDS_V1,
} from "./contracts";

export type CityJsonSchemaV1 = Readonly<Record<string, unknown>>;

const ref = (name: string): CityJsonSchemaV1 => ({ $ref: `#/$defs/${name}` });
const list = (items: CityJsonSchemaV1, minItems = 0, maxItems = 100_000): CityJsonSchemaV1 => ({ type: "array", items, minItems, maxItems });
const object = (properties: Record<string, CityJsonSchemaV1>, required: readonly string[] = Object.keys(properties)): CityJsonSchemaV1 => ({
  type: "object", properties, required: [...required], additionalProperties: false,
});
const string = (minLength = 1, maxLength = 256): CityJsonSchemaV1 => ({ type: "string", minLength, maxLength });
const number = (minimum?: number): CityJsonSchemaV1 => ({ type: "number", ...(minimum === undefined ? {} : { minimum }) });
const positive = (): CityJsonSchemaV1 => ({ type: "number", exclusiveMinimum: 0 });
const stableId = (): CityJsonSchemaV1 => ({ ...string(4, 128), pattern: "^[a-z][a-z0-9]*:[a-z0-9][a-z0-9._-]*$" });
const digest = (): CityJsonSchemaV1 => ({ ...string(71, 71), pattern: "^sha256:[a-f0-9]{64}$" });
const revision = (): CityJsonSchemaV1 => string(1, 256);
const vector = (length: number): CityJsonSchemaV1 => ({ type: "array", items: number(), minItems: length, maxItems: length });
const travelModes = (): CityJsonSchemaV1 => ({ ...list({ enum: [...TRAVEL_MODES_V1] }, 1, TRAVEL_MODES_V1.length), uniqueItems: true });

const definitions: Record<string, CityJsonSchemaV1> = {
  StableIdV1: stableId(),
  DigestV1: digest(),
  RevisionIdV1: revision(),
  Vec2V1: vector(2),
  Vec3V1: vector(3),
  QuatV1: vector(4),
  Bounds3V1: object({ min: ref("Vec3V1"), max: ref("Vec3V1") }),
  TransformV1: object({ position: ref("Vec3V1"), rotation: ref("QuatV1"), scale: vector(3) }),
  CityTerrainV1: object({
    format: { const: "heightfield-tiles-v1" },
    tiles: list(object({ id: ref("StableIdV1"), assetDigest: ref("DigestV1"), bounds: ref("Bounds3V1") })),
  }),
  SiteDtoV2: object({
    id: ref("StableIdV1"), kind: string(1, 128), bounds: ref("Bounds3V1"),
    objectIds: { ...list(ref("StableIdV1"), 0, 100_000), uniqueItems: true }, placeId: ref("StableIdV1"),
  }, ["id", "kind", "bounds", "objectIds"]),
  WorldObjectDtoV2: object({
    id: ref("StableIdV1"), kind: string(1, 128), transform: ref("TransformV1"), bounds: ref("Bounds3V1"),
    siteId: ref("StableIdV1"), assetDigest: ref("DigestV1"),
    collision: { anyOf: [
      object({ kind: { const: "none" } }), object({ kind: { const: "box" } }),
      object({ kind: { const: "mesh" }, assetDigest: ref("DigestV1") }),
    ] },
  }, ["id", "kind", "transform", "bounds", "collision"]),
  AnchorDtoV2: object({
    id: ref("StableIdV1"), kind: { enum: [...ANCHOR_KINDS_V2] }, position: ref("Vec3V1"),
    radiusMeters: positive(), objectId: ref("StableIdV1"), travelModes: travelModes(),
  }, ["id", "kind", "position", "travelModes"]),
  RoadEdgeDtoV2: object({
    id: ref("StableIdV1"), kind: { enum: [...ROAD_KINDS_V2] }, fromAnchorId: ref("StableIdV1"),
    toAnchorId: ref("StableIdV1"), directed: { type: "boolean" }, travelModes: travelModes(),
    centerline: list(ref("Vec3V1"), 2, 100_000),
  }),
  VolumeGeometryV1: { anyOf: [
    object({ kind: { const: "box" }, bounds: ref("Bounds3V1") }),
    object({ kind: { const: "sphere" }, center: ref("Vec3V1"), radiusMeters: positive() }),
    object({ kind: { const: "convex-prism" }, polygonXZ: list(ref("Vec2V1"), 3, 10_000), minY: number(), maxY: number() }),
    object({
      kind: { const: "ring" }, center: ref("Vec3V1"), normal: ref("Vec3V1"),
      innerRadiusMeters: positive(), outerRadiusMeters: positive(), thicknessMeters: positive(),
    }),
  ] },
  WorldVolumeDtoV1: object({
    id: ref("StableIdV1"), kind: { enum: [...WORLD_VOLUME_KINDS_V1] }, geometry: ref("VolumeGeometryV1"),
    travelModes: travelModes(), objectId: ref("StableIdV1"),
  }, ["id", "kind", "geometry"]),
  CityPlaceV1: object({
    id: ref("StableIdV1"), kind: string(1, 128), displayName: string(1, 256), objectRef: ref("StableIdV1"),
    activities: { ...list(string(1, 128), 0, 1_024), uniqueItems: true },
  }),
  CityResidentScheduleV1: object({
    daysOfWeek: { ...list({ type: "integer", minimum: 0, maximum: 6 }, 1, 7), uniqueItems: true },
    startLocalTime: { ...string(5, 5), pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" },
    endLocalTime: { ...string(5, 5), pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" },
    placeId: ref("StableIdV1"),
  }),
  CityResidentV1: object({
    id: ref("StableIdV1"), displayName: string(1, 256), prefabRef: string(1, 512),
    homePlaceId: ref("StableIdV1"), schedule: list(ref("CityResidentScheduleV1"), 0, 1_024),
    interactions: { ...list(string(1, 128), 0, 1_024), uniqueItems: true },
  }, ["id", "displayName", "prefabRef", "interactions"]),
  RoutePlanV1: object({
    id: ref("StableIdV1"), kind: { enum: [...ROAD_KINDS_V2] }, fromAnchorId: ref("StableIdV1"),
    toAnchorId: ref("StableIdV1"), bidirectional: { type: "boolean" }, travelModes: travelModes(),
    centerline: list(ref("Vec3V1"), 2, 100_000),
  }),
  CityResolvedGeneratorIdentityV1: object({
    id: string(1, 128), contractVersion: { const: 1 }, version: string(1, 64), codeDigest: ref("DigestV1"),
  }),
  WorldCapabilityV2: { enum: [...WORLD_CAPABILITIES_V2] },
  CitySemanticEnvironmentV1: object({
    medium: { enum: ["air", "water", "vacuum", "mixed"] }, biome: string(1, 128),
  }),
  CityRevisionSetV1: object({
    worldRevision: ref("RevisionIdV1"), environmentRevision: ref("RevisionIdV1"),
    weatherRevision: ref("RevisionIdV1"), placeRevision: ref("RevisionIdV1"),
    residentRevision: ref("RevisionIdV1"), interactionRevision: ref("RevisionIdV1"),
    appearanceRevision: ref("RevisionIdV1"), renderRevision: ref("RevisionIdV1"), clockRevision: ref("RevisionIdV1"),
  }),
  CityWorldHeaderV1: object({
    schemaVersion: { const: 1 }, cityId: string(1, 128), cityRevision: { type: "integer", minimum: 0 },
    seed: { type: "integer", minimum: 0, maximum: 0xffff_ffff }, generator: ref("CityResolvedGeneratorIdentityV1"),
    coordinateSystem: { const: "city-local-m-v1" },
    capabilities: { ...list(ref("WorldCapabilityV2"), 0, WORLD_CAPABILITIES_V2.length), uniqueItems: true },
    revisions: ref("CityRevisionSetV1"), topologyDigest: ref("DigestV1"), snapshotDigest: ref("DigestV1"),
  }),
  ActorIntentV1: object({
    kind: { enum: [...ACTOR_INTENT_KINDS_V1] }, targetId: ref("StableIdV1"),
    payload: { type: "object", additionalProperties: { anyOf: [{ type: "string" }, number(), { type: "boolean" }] }, maxProperties: 128 },
  }, ["kind"]),
};

const document = (root: CityJsonSchemaV1): CityJsonSchemaV1 => ({
  $schema: "https://json-schema.org/draft/2020-12/schema", ...root, $defs: definitions,
});

export const CITY_WORLD_PLAN_V1_JSON_SCHEMA = document(object({
  schemaVersion: { const: 1 }, terrain: ref("CityTerrainV1"), environment: ref("CitySemanticEnvironmentV1"),
  sites: list(ref("SiteDtoV2")), routes: list(ref("RoutePlanV1")), objects: list(ref("WorldObjectDtoV2")),
  anchors: list(ref("AnchorDtoV2")), volumes: list(ref("WorldVolumeDtoV1")),
  places: list(ref("CityPlaceV1")), residents: list(ref("CityResidentV1")),
}, ["schemaVersion", "terrain", "sites", "routes", "objects", "anchors", "volumes", "places", "residents"]));
export const CITY_WORLD_SNAPSHOT_V4_JSON_SCHEMA = document(object({
  schemaVersion: { const: 4 }, header: ref("CityWorldHeaderV1"), terrain: ref("CityTerrainV1"),
  environment: ref("CitySemanticEnvironmentV1"), roads: list(ref("RoadEdgeDtoV2")), sites: list(ref("SiteDtoV2")),
  objects: list(ref("WorldObjectDtoV2")), anchors: list(ref("AnchorDtoV2")), volumes: list(ref("WorldVolumeDtoV1")),
  places: list(ref("CityPlaceV1")), residents: list(ref("CityResidentV1")),
}));
export const CITY_COMPILE_CONTEXT_V1_JSON_SCHEMA = document(object({
  cityId: string(1, 128), cityRevision: { type: "integer", minimum: 0 }, seed: { type: "integer", minimum: 0, maximum: 0xffff_ffff },
  generator: ref("CityResolvedGeneratorIdentityV1"), assetsDigest: ref("DigestV1"),
  capabilities: { ...list(ref("WorldCapabilityV2"), 0, WORLD_CAPABILITIES_V2.length), uniqueItems: true },
}));
export const CITY_SHARED_CONTRACT_SCHEMAS_V1 = Object.freeze({
  worldPlan: CITY_WORLD_PLAN_V1_JSON_SCHEMA,
  worldSnapshot: CITY_WORLD_SNAPSHOT_V4_JSON_SCHEMA,
  compileContext: CITY_COMPILE_CONTEXT_V1_JSON_SCHEMA,
});
