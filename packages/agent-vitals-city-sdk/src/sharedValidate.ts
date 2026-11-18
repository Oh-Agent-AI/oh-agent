import type {
  AnchorDtoV2, Bounds3V1, CityRevisionSetV1, CityWorldSnapshotV4, CompileContextV1,
  RoadEdgeDtoV2, RoutePlanV1, StableIdV1, Vec2V1, Vec3V1, WorldPlanV1,
} from "./contracts";
import { canonicalDigest } from "./digest";
import { canonicalJson } from "./package";
import {
  CITY_COMPILE_CONTEXT_V1_JSON_SCHEMA, CITY_WORLD_PLAN_V1_JSON_SCHEMA,
  CITY_WORLD_SNAPSHOT_V4_JSON_SCHEMA, type CityJsonSchemaV1,
} from "./schema";
import type { DiagnosticV1, Result } from "./types";

export const CITY_WORLD_FLOAT_SCALE_V1 = 1_000_000;
export const CITY_ROAD_ENDPOINT_TOLERANCE_METERS_V1 = 0.001;

const error = (code: string, path: string, message: string, objectId?: string): DiagnosticV1 => ({
  code, severity: "error", path, message, ...(objectId ? { objectId } : {}),
});
const failure = (code: string, path: string, message: string, objectId?: string): Result<never> => ({
  ok: false, diagnostics: [error(code, path, message, objectId)],
});
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const byId = <T extends { readonly id: string }>(left: T, right: T): number => compareText(left.id, right.id);
const sortedStrings = <T extends string>(values: readonly T[]): T[] => [...values].sort(compareText);

function resolveSchema(schema: CityJsonSchemaV1, root: CityJsonSchemaV1): CityJsonSchemaV1 {
  const reference = schema.$ref;
  if (typeof reference !== "string") return schema;
  if (!reference.startsWith("#/$defs/")) throw new TypeError(`Unsupported schema reference: ${reference}`);
  const definitions = root.$defs as Record<string, CityJsonSchemaV1>;
  const resolved = definitions[reference.slice("#/$defs/".length)];
  if (!resolved) throw new TypeError(`Missing schema definition: ${reference}`);
  return resolved;
}

function schemaDiagnostics(value: unknown, schema: CityJsonSchemaV1, root: CityJsonSchemaV1, path = "$"): DiagnosticV1[] {
  const current = resolveSchema(schema, root);
  if ("const" in current && canonicalJson(value) !== canonicalJson(current.const)) {
    return [error("city_schema_const_mismatch", path, "Value does not match the required contract constant.")];
  }
  if (Array.isArray(current.enum) && !current.enum.some(candidate => canonicalJson(value) === canonicalJson(candidate))) {
    return [error("city_schema_enum_mismatch", path, "Value is not a declared contract enum member.")];
  }
  if (Array.isArray(current.anyOf)) {
    const matches = current.anyOf.some(candidate => schemaDiagnostics(value, candidate, root, path).length === 0);
    return matches ? [] : [error("city_schema_union_mismatch", path, "Value does not match any declared contract variant.")];
  }
  const type = current.type;
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)
      || (type === "integer" && !Number.isSafeInteger(value))) {
      return [error("city_number_invalid", path, "Number must be finite, non-negative-zero and match the contract integer rule.")];
    }
    if (typeof current.minimum === "number" && value < current.minimum) return [error("city_number_out_of_range", path, "Number is below the contract minimum.")];
    if (typeof current.maximum === "number" && value > current.maximum) return [error("city_number_out_of_range", path, "Number is above the contract maximum.")];
    if (typeof current.exclusiveMinimum === "number" && value <= current.exclusiveMinimum) return [error("city_number_out_of_range", path, "Number must be greater than the contract minimum.")];
    return [];
  }
  if (type === "string") {
    if (typeof value !== "string") return [error("city_string_invalid", path, "Expected a string.")];
    const length = [...value].length;
    if (typeof current.minLength === "number" && length < current.minLength) return [error("city_string_invalid", path, "String is shorter than the contract minimum.")];
    if (typeof current.maxLength === "number" && length > current.maxLength) return [error("city_string_invalid", path, "String is longer than the contract maximum.")];
    if (typeof current.pattern === "string" && !new RegExp(current.pattern, "u").test(value)) return [error("city_string_invalid", path, "String does not match the contract format.")];
    return [];
  }
  if (type === "boolean") return typeof value === "boolean" ? [] : [error("city_boolean_invalid", path, "Expected a boolean.")];
  if (type === "array") {
    if (!Array.isArray(value)) return [error("city_array_invalid", path, "Expected an array.")];
    if (typeof current.minItems === "number" && value.length < current.minItems) return [error("city_array_invalid", path, "Array has too few entries.")];
    if (typeof current.maxItems === "number" && value.length > current.maxItems) return [error("city_budget_exceeded", path, "Array exceeds the contract entry budget.")];
    if (current.uniqueItems === true) {
      const entries = value.map(item => canonicalJson(item));
      if (new Set(entries).size !== entries.length) return [error("city_array_duplicate", path, "Array entries must be unique.")];
    }
    if (current.items) {
      for (const [index, item] of value.entries()) {
        const diagnostics = schemaDiagnostics(item, current.items as CityJsonSchemaV1, root, `${path}[${index}]`);
        if (diagnostics.length) return diagnostics;
      }
    }
    return [];
  }
  if (type === "object") {
    if (!isObject(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      return [error("city_object_invalid", path, "Expected a plain object.")];
    }
    const properties = (current.properties ?? {}) as Record<string, CityJsonSchemaV1>;
    const required = Array.isArray(current.required) ? current.required as string[] : [];
    for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) return [error("city_required_field_missing", `${path}.${key}`, "Required contract field is missing.")];
    if (typeof current.maxProperties === "number" && Object.keys(value).length > current.maxProperties) return [error("city_budget_exceeded", path, "Object exceeds the contract property budget.")];
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        const diagnostics = schemaDiagnostics(item, propertySchema, root, `${path}.${key}`);
        if (diagnostics.length) return diagnostics;
      } else if (current.additionalProperties === false) {
        return [error("city_unknown_field", `${path}.${key}`, "Field is not declared by this contract version.")];
      } else if (isObject(current.additionalProperties)) {
        const diagnostics = schemaDiagnostics(item, current.additionalProperties, root, `${path}.${key}`);
        if (diagnostics.length) return diagnostics;
      }
    }
    return [];
  }
  return [];
}

export function validateCityJsonSchema(value: unknown, schema: CityJsonSchemaV1): Result<unknown> {
  try {
    const diagnostics = schemaDiagnostics(value, schema, schema);
    if (diagnostics.length) return { ok: false, diagnostics };
    return { ok: true, value: JSON.parse(canonicalJson(value)) as unknown, diagnostics: [] };
  } catch (cause) {
    return failure("city_schema_invalid", "$", cause instanceof Error ? cause.message : "Contract schema validation failed.");
  }
}

const quantize = (value: number): number => {
  const result = Math.round(value * CITY_WORLD_FLOAT_SCALE_V1) / CITY_WORLD_FLOAT_SCALE_V1;
  return Object.is(result, -0) ? 0 : result;
};
const normalizeUnit = (values: number[]): number[] => {
  const length = Math.hypot(...values);
  return length > 0 && Number.isFinite(length) ? values.map(value => value / length) : values;
};
function normalizeNumbers(value: unknown): unknown {
  if (typeof value === "number") return quantize(value);
  if (Array.isArray(value)) return value.map(normalizeNumbers);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeNumbers(item)]));
  return value;
}
function normalizeWorld(value: unknown): unknown {
  const clone = JSON.parse(canonicalJson(value)) as unknown;
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (!isObject(item)) return;
    if (Array.isArray(item.rotation) && item.rotation.length === 4 && item.rotation.every(entry => typeof entry === "number")) {
      item.rotation = normalizeUnit(item.rotation as number[]);
    }
    if (item.kind === "ring" && Array.isArray(item.normal) && item.normal.length === 3 && item.normal.every(entry => typeof entry === "number")) {
      item.normal = normalizeUnit(item.normal as number[]);
    }
    Object.values(item).forEach(visit);
  };
  visit(clone);
  return normalizeNumbers(clone);
}

function canonicalizeCollections<T extends WorldPlanV1 | CityWorldSnapshotV4>(world: T): T {
  const result = {
    ...world,
    terrain: { ...world.terrain, tiles: [...world.terrain.tiles].sort(byId) },
    sites: world.sites.map(site => ({ ...site, objectIds: sortedStrings(site.objectIds) })).sort(byId),
    objects: [...world.objects].sort(byId),
    anchors: world.anchors.map(anchor => ({ ...anchor, travelModes: sortedStrings(anchor.travelModes) })).sort(byId),
    volumes: world.volumes.map(volume => ({ ...volume, ...(volume.travelModes ? { travelModes: sortedStrings(volume.travelModes) } : {}) })).sort(byId),
    places: world.places.map(place => ({ ...place, activities: sortedStrings(place.activities) })).sort(byId),
    residents: world.residents.map(resident => ({
      ...resident, interactions: sortedStrings(resident.interactions),
      ...(resident.schedule ? { schedule: resident.schedule.map(entry => ({ ...entry, daysOfWeek: [...entry.daysOfWeek].sort((a, b) => a - b) })).sort((a, b) => compareText(canonicalJson(a), canonicalJson(b))) } : {}),
    })).sort(byId),
  };
  if (world.schemaVersion === 1) {
    (result as unknown as { routes: RoutePlanV1[] }).routes = world.routes.map(route => ({ ...route, travelModes: sortedStrings(route.travelModes) })).sort(byId);
  } else {
    (result as unknown as { roads: RoadEdgeDtoV2[] }).roads = world.roads.map(road => ({ ...road, travelModes: sortedStrings(road.travelModes) })).sort(byId);
    (result as unknown as { header: CityWorldSnapshotV4["header"] }).header = {
      ...world.header, capabilities: sortedStrings(world.header.capabilities) as CityWorldSnapshotV4["header"]["capabilities"],
    };
  }
  return result as T;
}

const distance = (left: Vec3V1, right: Vec3V1): number => Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
const validBounds = (bounds: Bounds3V1): boolean => bounds.min.every((value, index) => value <= bounds.max[index]!);
const cross = (a: Vec2V1, b: Vec2V1, c: Vec2V1): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a: Vec2V1, b: Vec2V1, point: Vec2V1): boolean => Math.min(a[0], b[0]) - 1e-9 <= point[0] && point[0] <= Math.max(a[0], b[0]) + 1e-9
  && Math.min(a[1], b[1]) - 1e-9 <= point[1] && point[1] <= Math.max(a[1], b[1]) + 1e-9;
function segmentsIntersect(a: Vec2V1, b: Vec2V1, c: Vec2V1, d: Vec2V1): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  const epsilon = 1e-9;
  if (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
    && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) return true;
  return (Math.abs(abC) <= epsilon && onSegment(a, b, c)) || (Math.abs(abD) <= epsilon && onSegment(a, b, d))
    || (Math.abs(cdA) <= epsilon && onSegment(c, d, a)) || (Math.abs(cdB) <= epsilon && onSegment(c, d, b));
}
function hasSelfIntersection(points: readonly Vec2V1[], closed: boolean): boolean {
  const count = closed ? points.length : points.length - 1;
  for (let first = 0; first < count; first += 1) for (let second = first + 1; second < count; second += 1) {
    if (Math.abs(first - second) <= 1 || (closed && first === 0 && second === count - 1)) continue;
    if (segmentsIntersect(points[first]!, points[(first + 1) % points.length]!, points[second]!, points[(second + 1) % points.length]!)) return true;
  }
  return false;
}
const validUnit = (values: readonly number[]): boolean => Math.abs(Math.hypot(...values) - 1) <= 2 / CITY_WORLD_FLOAT_SCALE_V1;

function validateWorldSemantics(world: WorldPlanV1 | CityWorldSnapshotV4): Result<WorldPlanV1 | CityWorldSnapshotV4> {
  const ids = new Map<StableIdV1, string>();
  const collections: readonly [string, readonly { readonly id: StableIdV1 }[]][] = [
    ["terrain.tiles", world.terrain.tiles], ["sites", world.sites], ["objects", world.objects],
    ["anchors", world.anchors], ["volumes", world.volumes], ["places", world.places], ["residents", world.residents],
    [world.schemaVersion === 1 ? "routes" : "roads", world.schemaVersion === 1 ? world.routes : world.roads],
  ];
  for (const [path, entries] of collections) for (const entry of entries) {
    const previous = ids.get(entry.id);
    if (previous) return failure("city_duplicate_stable_id", `${path}.${entry.id}`, `Stable ID is already used by ${previous}.`, entry.id);
    ids.set(entry.id, path);
  }
  const objects = new Map(world.objects.map(item => [item.id, item]));
  const anchors = new Map(world.anchors.map(item => [item.id, item]));
  const sites = new Map(world.sites.map(item => [item.id, item]));
  const places = new Map(world.places.map(item => [item.id, item]));
  const roads: readonly RoadEdgeDtoV2[] = world.schemaVersion === 1 ? world.routes.map(route => ({
    id: route.id, kind: route.kind, fromAnchorId: route.fromAnchorId, toAnchorId: route.toAnchorId,
    directed: !route.bidirectional, travelModes: route.travelModes, centerline: route.centerline,
  })) : world.roads;
  for (const tile of world.terrain.tiles) if (!validBounds(tile.bounds)) return failure("city_bounds_invalid", `terrain.tiles.${tile.id}.bounds`, "Terrain tile minimum must not exceed its maximum.", tile.id);
  for (const site of world.sites) {
    if (!validBounds(site.bounds)) return failure("city_bounds_invalid", `sites.${site.id}.bounds`, "Site minimum must not exceed its maximum.", site.id);
    if (site.placeId && !places.has(site.placeId)) return failure("city_reference_missing", `sites.${site.id}.placeId`, "Site place reference does not exist.", site.placeId);
    for (const objectId of site.objectIds) {
      const object = objects.get(objectId);
      if (!object) return failure("city_reference_missing", `sites.${site.id}.objectIds`, "Site object reference does not exist.", objectId);
      if (object.siteId && object.siteId !== site.id && sites.has(object.siteId)) return failure("city_site_binding_conflict", `sites.${site.id}.objectIds`, "Object is bound to a different site.", objectId);
    }
  }
  for (const object of world.objects) {
    if (!validBounds(object.bounds)) return failure("city_bounds_invalid", `objects.${object.id}.bounds`, "Object minimum must not exceed its maximum.", object.id);
    if (!validUnit(object.transform.rotation)) return failure("city_quaternion_invalid", `objects.${object.id}.transform.rotation`, "Object rotation must be a non-zero unit quaternion.", object.id);
    if (object.transform.scale.some(value => value <= 0)) return failure("city_scale_invalid", `objects.${object.id}.transform.scale`, "Object scale components must be positive.", object.id);
    if (object.siteId && !sites.has(object.siteId)) return failure("city_reference_missing", `objects.${object.id}.siteId`, "Object site reference does not exist.", object.siteId);
  }
  for (const anchor of world.anchors) {
    if (anchor.objectId && !objects.has(anchor.objectId)) return failure("city_reference_missing", `anchors.${anchor.id}.objectId`, "Anchor object reference does not exist.", anchor.objectId);
  }
  for (const road of roads) {
    const from = anchors.get(road.fromAnchorId), to = anchors.get(road.toAnchorId);
    if (!from) return failure("city_reference_missing", `roads.${road.id}.fromAnchorId`, "Road source anchor does not exist.", road.fromAnchorId);
    if (!to) return failure("city_reference_missing", `roads.${road.id}.toAnchorId`, "Road destination anchor does not exist.", road.toAnchorId);
    if (road.fromAnchorId === road.toAnchorId) return failure("city_road_endpoint_invalid", `roads.${road.id}`, "Road endpoints must be distinct anchors.", road.id);
    for (const mode of road.travelModes) if (!from.travelModes.includes(mode) || !to.travelModes.includes(mode)) {
      return failure("city_road_travel_mode_unsupported", `roads.${road.id}.travelModes`, "Both road anchors must support every road travel mode.", road.id);
    }
    if (distance(road.centerline[0]!, from.position) > CITY_ROAD_ENDPOINT_TOLERANCE_METERS_V1
      || distance(road.centerline.at(-1)!, to.position) > CITY_ROAD_ENDPOINT_TOLERANCE_METERS_V1) {
      return failure("city_road_centerline_disconnected", `roads.${road.id}.centerline`, "Road centerline endpoints must coincide with their anchors.", road.id);
    }
    const points = road.centerline.map(point => [point[0], point[2]] as Vec2V1);
    if (hasSelfIntersection(points, false)) return failure("city_road_centerline_self_intersects", `roads.${road.id}.centerline`, "Road centerline must not self-intersect.", road.id);
  }
  for (const volume of world.volumes) {
    if (volume.objectId && !objects.has(volume.objectId)) return failure("city_reference_missing", `volumes.${volume.id}.objectId`, "Volume object reference does not exist.", volume.objectId);
    const geometry = volume.geometry;
    if (geometry.kind === "box" && !validBounds(geometry.bounds)) return failure("city_bounds_invalid", `volumes.${volume.id}.geometry.bounds`, "Volume minimum must not exceed its maximum.", volume.id);
    if (geometry.kind === "ring" && (!validUnit(geometry.normal) || geometry.innerRadiusMeters >= geometry.outerRadiusMeters)) {
      return failure("city_volume_geometry_invalid", `volumes.${volume.id}.geometry`, "Ring normal must be non-zero and inner radius must be smaller than outer radius.", volume.id);
    }
    if (geometry.kind === "convex-prism") {
      if (geometry.minY >= geometry.maxY || hasSelfIntersection(geometry.polygonXZ, true)) return failure("city_volume_geometry_invalid", `volumes.${volume.id}.geometry`, "Convex prism must have ordered Y bounds and a simple polygon.", volume.id);
      const signs = geometry.polygonXZ.map((point, index) => cross(point, geometry.polygonXZ[(index + 1) % geometry.polygonXZ.length]!, geometry.polygonXZ[(index + 2) % geometry.polygonXZ.length]!));
      if (signs.some(value => Math.abs(value) <= 1e-9) || (signs.some(value => value > 0) && signs.some(value => value < 0))) {
        return failure("city_volume_geometry_invalid", `volumes.${volume.id}.geometry.polygonXZ`, "Convex prism polygon must be strictly convex and non-degenerate.", volume.id);
      }
    }
  }
  for (const place of world.places) if (!objects.has(place.objectRef) && !anchors.has(place.objectRef)) {
    return failure("city_reference_missing", `places.${place.id}.objectRef`, "Place must reference a real object or anchor.", place.objectRef);
  }
  for (const resident of world.residents) {
    if (resident.homePlaceId && !places.has(resident.homePlaceId)) return failure("city_reference_missing", `residents.${resident.id}.homePlaceId`, "Resident home place does not exist.", resident.homePlaceId);
    for (const schedule of resident.schedule ?? []) if (!places.has(schedule.placeId)) return failure("city_reference_missing", `residents.${resident.id}.schedule.placeId`, "Resident schedule place does not exist.", schedule.placeId);
  }
  return { ok: true, value: world, diagnostics: [] };
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (isObject(value)) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export function validateWorldPlan(value: unknown): Result<WorldPlanV1> {
  const checked = validateCityJsonSchema(value, CITY_WORLD_PLAN_V1_JSON_SCHEMA);
  if (!checked.ok) return checked;
  const normalized = canonicalizeCollections(normalizeWorld(checked.value) as WorldPlanV1);
  const semantic = validateWorldSemantics(normalized);
  if (!semantic.ok) return semantic;
  return { ok: true, value: deepFreeze(normalized), diagnostics: [] };
}

export function validateCompileContext(value: unknown): Result<CompileContextV1> {
  const checked = validateCityJsonSchema(value, CITY_COMPILE_CONTEXT_V1_JSON_SCHEMA);
  if (!checked.ok) return checked;
  const context = normalizeWorld(checked.value) as CompileContextV1;
  return { ok: true, value: deepFreeze({ ...context, capabilities: sortedStrings(context.capabilities) as CompileContextV1["capabilities"] }), diagnostics: [] };
}

export interface CityWorldDigestSetV1 {
  readonly topologyDigest: string;
  readonly snapshotDigest: string;
  readonly revisions: CityRevisionSetV1;
}

export function computeCityWorldDigests(snapshot: CityWorldSnapshotV4): CityWorldDigestSetV1 {
  const topologyDigest = canonicalDigest({ roads: snapshot.roads, anchors: snapshot.anchors });
  const worldContent = {
    terrain: snapshot.terrain, roads: snapshot.roads, sites: snapshot.sites, objects: snapshot.objects,
    anchors: snapshot.anchors, volumes: snapshot.volumes, environment: { medium: snapshot.environment.medium },
  };
  const revisions: CityRevisionSetV1 = {
    worldRevision: canonicalDigest({ domain: "city.world.v1", content: worldContent }),
    environmentRevision: canonicalDigest({ domain: "city.environment.v1", content: snapshot.environment }),
    weatherRevision: canonicalDigest({ domain: "city.weather.v1", content: null }),
    placeRevision: canonicalDigest({ domain: "city.place.v1", content: snapshot.places }),
    residentRevision: canonicalDigest({ domain: "city.resident.v1", content: snapshot.residents }),
    interactionRevision: canonicalDigest({ domain: "city.interaction.v1", content: [] }),
    appearanceRevision: canonicalDigest({ domain: "city.appearance.v1", content: null }),
    renderRevision: canonicalDigest({ domain: "city.render.v1", content: null }),
    clockRevision: canonicalDigest({ domain: "city.clock.v1", content: null }),
  };
  const snapshotDigest = canonicalDigest({
    schemaVersion: snapshot.schemaVersion,
    header: {
      schemaVersion: snapshot.header.schemaVersion, cityId: snapshot.header.cityId, seed: snapshot.header.seed,
      generator: snapshot.header.generator, coordinateSystem: snapshot.header.coordinateSystem, capabilities: snapshot.header.capabilities,
    },
    terrain: snapshot.terrain, environment: snapshot.environment, roads: snapshot.roads, sites: snapshot.sites,
    objects: snapshot.objects, anchors: snapshot.anchors, volumes: snapshot.volumes,
    places: snapshot.places, residents: snapshot.residents,
  });
  return { topologyDigest, snapshotDigest, revisions };
}

export function validateCityWorldSnapshot(value: unknown): Result<CityWorldSnapshotV4> {
  const checked = validateCityJsonSchema(value, CITY_WORLD_SNAPSHOT_V4_JSON_SCHEMA);
  if (!checked.ok) return checked;
  const normalized = canonicalizeCollections(normalizeWorld(checked.value) as CityWorldSnapshotV4);
  const semantic = validateWorldSemantics(normalized);
  if (!semantic.ok) return semantic;
  const expected = computeCityWorldDigests(normalized);
  if (normalized.header.topologyDigest !== expected.topologyDigest) return failure("city_topology_digest_mismatch", "header.topologyDigest", "Topology digest does not match normalized roads and anchors.");
  if (normalized.header.snapshotDigest !== expected.snapshotDigest) return failure("city_snapshot_digest_mismatch", "header.snapshotDigest", "Snapshot digest does not match the complete portable public content.");
  for (const key of ["worldRevision", "environmentRevision", "placeRevision", "residentRevision"] as const) {
    if (normalized.header.revisions[key] !== expected.revisions[key]) {
      return failure("city_revision_digest_mismatch", `header.revisions.${key}`, "Revision does not match its independent canonical content domain.");
    }
  }
  return { ok: true, value: deepFreeze(normalized), diagnostics: [] };
}
