import type { AnchorCapability, AnchorFilterV1, AnchorKind, CityAnchorV1, CityAnchorLinkV1, CityGameMountV1, CityInstanceV1, CityLayoutSnapshotV1, CityLayoutSnapshotV2, CityLayoutV1, CityProjectAssetCatalogV1, CityProjectAssetEntryV1, CitySkinPackV1, CityWorldProfileV1, CoastalWorldParametersV1, ContentRef, DiagnosticV1, MiniGamePackV1, ModelAssetCatalogEntryV1, ModelAssetCatalogV1, ModelAssetFilterV1, ModelAssetRefV1, ResolvedModelAssetRefsV1, Result, SceneDraftV1, SceneObjectFilterV1, SceneObjectV1 } from "./types";
import { validateMiniGamePack } from "./content";
import { validateWorldPlanPatch } from "./worldPlanPatch";

const error = (code: string, path: string, message: string, objectId?: string): DiagnosticV1 => ({ code, severity: "error", path, message, ...(objectId ? { objectId } : {}) });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const hasOwn = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const ANCHOR_KINDS = new Set<AnchorKind>(["spawn", "route", "zone", "object"]);
const CAPABILITIES = new Set<AnchorCapability>(["drive", "walk"]);
const MAX_LAYOUT_ANCHORS = 20_000;
const MAX_LAYOUT_LINKS = 100_000;

/** Validate and detach the persisted City identity and its world recipe. */
export function validateCityInstance(value: unknown): Result<CityInstanceV1> {
  if (!isObject(value) || !exactKeys(value, ["schemaVersion", "cityId", "revision", "name", "seed", "profile", "planPatch"])) {
    return { ok: false, diagnostics: [error("city_instance_invalid_shape", "$", "City must contain only the version 1 instance fields.")] };
  }
  if (value.schemaVersion !== 1 || typeof value.cityId !== "string" || !identifier.test(value.cityId)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || typeof value.name !== "string" || value.name.trim() !== value.name || [...value.name].length < 1 || [...value.name].length > 120
    || /\p{Cc}/u.test(value.name)
    || !Number.isSafeInteger(value.seed) || (value.seed as number) < 0 || (value.seed as number) > 0xffffffff) {
    return { ok: false, diagnostics: [error("city_instance_invalid_identity", "$", "City identity, name, revision or seed is invalid.")] };
  }
  const profile = validateCityWorldProfile(value.profile);
  if (!profile.ok) return { ok: false, diagnostics: profile.diagnostics.map(item => ({ ...item, path: `profile.${item.path}` })) };
  let planPatch: Readonly<Record<string, unknown>> | undefined;
  if (value.planPatch !== undefined) {
    const version = isObject(value.planPatch) ? value.planPatch.generatorVersion ?? 1 : 0;
    const checked = validateWorldPlanPatch(value.planPatch, value.seed as number, version as number);
    if (!checked.ok) return checked;
    planPatch = checked.value;
  }
  return { ok: true, value: Object.freeze({ schemaVersion: 1, cityId: value.cityId, revision: value.revision as number,
    name: value.name, seed: value.seed as number, profile: profile.value, ...(planPatch ? { planPatch } : {}) }), diagnostics: [] };
}

/** Validate a data-only, versioned world recipe. Generator execution stays in City. */
export function validateCityWorldProfile(value: unknown): Result<CityWorldProfileV1> {
  if (!isObject(value) || !exactKeys(value, ["schemaVersion", "id", "version", "biome", "geography", "visuals"])) {
    return { ok: false, diagnostics: [error("world_profile_invalid_shape", "$", "World profile must contain only the version 1 world fields.")] };
  }
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || !identifier.test(value.id)
    || !Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    return { ok: false, diagnostics: [error("world_profile_invalid_identity", "$", "World profile requires a stable ID and positive integer version.")] };
  }
  if (!isObject(value.geography) || !exactKeys(value.geography, ["generator", "parameters"]) || !isObject(value.geography.parameters)) {
    return { ok: false, diagnostics: [error("world_profile_invalid_geography", "geography", "Geography must declare a supported generator and its parameters.")] };
  }
  if (!isObject(value.visuals) || !exactKeys(value.visuals, ["themeId"]) || (value.visuals.themeId !== "miami" && value.visuals.themeId !== "desert")) {
    return { ok: false, diagnostics: [error("world_profile_invalid_visuals", "visuals", "World profile must reference a registered City visual theme.")] };
  }
  let profile: CityWorldProfileV1;
  if (value.geography.generator === "arid-dunes-v1") {
    const parameters = value.geography.parameters;
    if (value.biome !== "arid" || !exactKeys(parameters, ["dunes"]) || !isObject(parameters.dunes)
      || !exactKeys(parameters.dunes, ["duneScale", "duneAmplitude", "orientationDeg"])) {
      return { ok: false, diagnostics: [error("world_profile_invalid_parameters", "geography.parameters", "Arid dune profiles require only the version 1 dune parameters.")] };
    }
    const dunes = parameters.dunes;
    if (typeof dunes.duneScale !== "number" || !Number.isFinite(dunes.duneScale) || dunes.duneScale < 96 || dunes.duneScale > 600
      || typeof dunes.duneAmplitude !== "number" || !Number.isFinite(dunes.duneAmplitude) || dunes.duneAmplitude < 1 || dunes.duneAmplitude > 36
      || typeof dunes.orientationDeg !== "number" || !Number.isFinite(dunes.orientationDeg) || dunes.orientationDeg < -180 || dunes.orientationDeg > 180) {
      return { ok: false, diagnostics: [error("world_profile_parameter_out_of_range", "geography.parameters.dunes", "Dune parameters are outside the generator's supported bounds.")] };
    }
    profile = { schemaVersion: 1, id: value.id, version: value.version as number, biome: "arid",
      geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: dunes.duneScale, duneAmplitude: dunes.duneAmplitude, orientationDeg: dunes.orientationDeg } } },
      visuals: { themeId: value.visuals.themeId } };
  } else if (value.geography.generator === "coastal-islands-v1") {
    const parameters = value.geography.parameters;
    if (value.biome !== "tropical" || !exactKeys(parameters, ["coastal"]) || !isObject(parameters.coastal)) {
      return { ok: false, diagnostics: [error("world_profile_invalid_parameters", "geography.parameters", "Coastal island profiles require a coastal parameter object and tropical biome.")] };
    }
    const coastal = parameters.coastal;
    const coastalKeys = ["profile", "version", "biome", "preferredAzimuth", "azimuthTolerance", "segmentArc", "wetSandWidth", "drySandWidth", "promenadeOffset", "boulevardOffset", "hotelOffset", "bandOuter", "maxCoastalSlope", "maxCoastalHeight", "riverMargin", "siteMargin", "minValidRatio", "bayHalfWidth", "bayShift"];
    if (!exactKeys(coastal, coastalKeys) || coastal.profile !== "miami-coastal" || coastal.biome !== "tropical"
      || !Number.isSafeInteger(coastal.version) || (coastal.version as number) < 1) {
      return { ok: false, diagnostics: [error("world_profile_invalid_parameters", "geography.parameters.coastal", "Coastal profile identity or fields are invalid.")] };
    }
    const bounds: Record<string, readonly [number, number]> = {
      preferredAzimuth: [-Math.PI * 2, Math.PI * 2], azimuthTolerance: [0, Math.PI], segmentArc: [0.01, Math.PI * 2],
      wetSandWidth: [0, 500], drySandWidth: [0, 500], promenadeOffset: [0, 500], boulevardOffset: [0, 500],
      hotelOffset: [0, 500], bandOuter: [0, 500], maxCoastalSlope: [0, 10], maxCoastalHeight: [0, 100],
      riverMargin: [0, 500], siteMargin: [0, 500], minValidRatio: [0, 1], bayHalfWidth: [0, 0.5], bayShift: [-1, 1],
    };
    for (const [key, [minimum, maximum]] of Object.entries(bounds)) {
      const number = coastal[key];
      if (typeof number !== "number" || !Number.isFinite(number) || number < minimum || number > maximum) {
        return { ok: false, diagnostics: [error("world_profile_parameter_out_of_range", `geography.parameters.coastal.${key}`, "Coastal parameter is outside its supported bounds.")] };
      }
    }
    const number = (key: string) => coastal[key] as number;
    if (!(number("wetSandWidth") <= number("drySandWidth") && number("drySandWidth") <= number("promenadeOffset")
      && number("promenadeOffset") <= number("boulevardOffset") && number("boulevardOffset") <= number("hotelOffset")
      && number("hotelOffset") <= number("bandOuter"))) {
      return { ok: false, diagnostics: [error("world_profile_parameter_order_invalid", "geography.parameters.coastal", "Coastal offsets must progress from shoreline to inland in order.")] };
    }
    const coastalSnapshot = Object.freeze(Object.fromEntries(coastalKeys.map(key => [key, coastal[key]])) as unknown as CoastalWorldParametersV1);
    profile = { schemaVersion: 1, id: value.id, version: value.version as number, biome: "tropical",
      geography: { generator: "coastal-islands-v1", parameters: Object.freeze({ coastal: coastalSnapshot }) },
      visuals: { themeId: value.visuals.themeId } };
  } else {
    return { ok: false, diagnostics: [error("world_profile_generator_unsupported", "geography.generator", "The requested City geography generator is not registered.")] };
  }
  if (profile.geography.generator === "arid-dunes-v1") Object.freeze(profile.geography.parameters.dunes);
  Object.freeze(profile.geography.parameters);
  Object.freeze(profile.geography);
  Object.freeze(profile.visuals);
  return { ok: true, value: Object.freeze(profile), diagnostics: [] };
}

/** Validate a data-only appearance pack against the City renderer contract. */
export function validateCitySkinPack(value: unknown): Result<CitySkinPackV1> {
  if (!isObject(value) || !exactKeys(value, ["schemaVersion", "id", "renderContract", "compatibleGeographies", "visuals"])) {
    return { ok: false, diagnostics: [error("skin_invalid_shape", "$", "Skin must contain only version 1 appearance fields.")] };
  }
  if (value.schemaVersion !== 1 || value.renderContract !== "city-render-v1") return { ok: false, diagnostics: [error("schema_unsupported", "$", "Only city-render-v1 skin packs are supported.")] };
  if (typeof value.id !== "string" || !identifier.test(value.id)) return { ok: false, diagnostics: [error("skin_invalid_id", "id", "Skin ID must be a stable identifier.")] };
  const compatible = value.compatibleGeographies;
  if (!Array.isArray(compatible) || compatible.length < 1 || compatible.length > 2
    || compatible.some(item => item !== "coastal-islands-v1" && item !== "arid-dunes-v1")
    || new Set(compatible).size !== compatible.length) {
    return { ok: false, diagnostics: [error("skin_invalid_compatibility", "compatibleGeographies", "Skin must declare one or more unique supported geography generators.")] };
  }
  if (!isObject(value.visuals) || !exactKeys(value.visuals, ["themeId"])
    || (value.visuals.themeId !== "miami" && value.visuals.themeId !== "desert")) {
    return { ok: false, diagnostics: [error("skin_invalid_visuals", "visuals", "Skin must reference a registered City visual theme.")] };
  }
  const visuals = Object.freeze({ themeId: value.visuals.themeId });
  return { ok: true, value: Object.freeze({ schemaVersion: 1, id: value.id, renderContract: "city-render-v1",
    compatibleGeographies: Object.freeze([...compatible]) as unknown as CitySkinPackV1["compatibleGeographies"], visuals }), diagnostics: [] };
}

/** Validate and take an immutable SDK-owned snapshot of an untrusted layout DTO. */
export function validateCityLayout(value: unknown): Result<CityLayoutV1> {
  if (!isObject(value) || !exactKeys(value, ["schemaVersion", "id", "coordinateSystem", "anchors", "links"])) {
    return { ok: false, diagnostics: [error("layout_invalid_shape", "$", "Layout must contain only version 1 layout fields.")] };
  }
  if (value.schemaVersion !== 1) return { ok: false, diagnostics: [error("schema_unsupported", "schemaVersion", "Only City layout schema version 1 is supported.")] };
  if (typeof value.id !== "string" || !identifier.test(value.id)) return { ok: false, diagnostics: [error("layout_invalid_id", "id", "Layout ID must be a stable identifier.")] };
  if (value.coordinateSystem !== "city-local-m-v1") return { ok: false, diagnostics: [error("layout_coordinate_system_unsupported", "coordinateSystem", "Only city-local-m-v1 coordinates are supported.")] };
  if (!Array.isArray(value.anchors)) return { ok: false, diagnostics: [error("layout_invalid_anchors", "anchors", "Layout anchors must be an array.")] };
  if (value.anchors.length > MAX_LAYOUT_ANCHORS) return { ok: false, diagnostics: [error("layout_budget_exceeded", "anchors", `A layout may expose at most ${MAX_LAYOUT_ANCHORS} anchors.`)] };
  const diagnostics: DiagnosticV1[] = [];
  const seen = new Set<string>();
  const anchors: CityAnchorV1[] = [];
  for (const [index, raw] of value.anchors.entries()) {
    const path = `anchors[${index}]`;
    if (!isObject(raw) || !exactKeys(raw, ["id", "kind", "capabilities", "geometryRef"])) {
      diagnostics.push(error("layout_invalid_anchor", path, "Anchor must contain only id, kind, capabilities and geometryRef."));
      continue;
    }
    if (typeof raw.id !== "string" || !identifier.test(raw.id)) diagnostics.push(error("layout_invalid_anchor_id", `${path}.id`, "Anchor ID must be a stable identifier."));
    else if (seen.has(raw.id)) diagnostics.push(error("layout_duplicate_anchor_id", `${path}.id`, "Anchor IDs must be unique within a layout.", raw.id));
    else seen.add(raw.id);
    if (typeof raw.kind !== "string" || !ANCHOR_KINDS.has(raw.kind as AnchorKind)) diagnostics.push(error("layout_invalid_anchor_kind", `${path}.kind`, "Anchor kind is unsupported."));
    if (!Array.isArray(raw.capabilities) || raw.capabilities.length > CAPABILITIES.size || raw.capabilities.some(item => typeof item !== "string" || !CAPABILITIES.has(item as AnchorCapability)) || (Array.isArray(raw.capabilities) && new Set(raw.capabilities).size !== raw.capabilities.length)) {
      diagnostics.push(error("layout_invalid_anchor_capabilities", `${path}.capabilities`, "Capabilities must be unique drive/walk values."));
    }
    if (typeof raw.geometryRef !== "string" || !identifier.test(raw.geometryRef)) diagnostics.push(error("layout_invalid_geometry_ref", `${path}.geometryRef`, "Geometry reference must be a stable identifier."));
    if (typeof raw.id === "string" && identifier.test(raw.id) && typeof raw.kind === "string" && ANCHOR_KINDS.has(raw.kind as AnchorKind)
      && Array.isArray(raw.capabilities) && raw.capabilities.every(item => typeof item === "string" && CAPABILITIES.has(item as AnchorCapability))
      && typeof raw.geometryRef === "string" && identifier.test(raw.geometryRef)) {
      anchors.push({ id: raw.id, kind: raw.kind as AnchorKind, capabilities: [...raw.capabilities] as AnchorCapability[], geometryRef: raw.geometryRef });
    }
  }
  const links: CityAnchorLinkV1[] = [];
  if (value.links !== undefined) {
    if (!Array.isArray(value.links)) diagnostics.push(error("layout_invalid_links", "links", "Layout links must be an array when provided."));
    else if (value.links.length > MAX_LAYOUT_LINKS) diagnostics.push(error("layout_budget_exceeded", "links", `A layout may expose at most ${MAX_LAYOUT_LINKS} links.`));
    else {
      const linkIds = new Set<string>();
      const anchorsById = new Map(anchors.map(anchor => [anchor.id, anchor]));
      for (const [index, raw] of value.links.entries()) {
        const path = `links[${index}]`;
        if (!isObject(raw) || !exactKeys(raw, ["id", "fromAnchorId", "toAnchorId", "capabilities"])) {
          diagnostics.push(error("layout_invalid_link", path, "Link must contain only id, endpoint IDs and capabilities."));
          continue;
        }
        const idOk = typeof raw.id === "string" && identifier.test(raw.id);
        if (!idOk) diagnostics.push(error("layout_invalid_link_id", `${path}.id`, "Link ID must be a stable identifier."));
        else if (linkIds.has(raw.id as string)) diagnostics.push(error("layout_duplicate_link_id", `${path}.id`, "Link IDs must be unique within a layout.", raw.id as string));
        else linkIds.add(raw.id as string);
        const fromOk = typeof raw.fromAnchorId === "string" && identifier.test(raw.fromAnchorId);
        const toOk = typeof raw.toAnchorId === "string" && identifier.test(raw.toAnchorId);
        if (!fromOk || !toOk || raw.fromAnchorId === raw.toAnchorId) diagnostics.push(error("layout_invalid_link_endpoint", path, "Link endpoints must be distinct stable anchor IDs."));
        const from = fromOk ? anchorsById.get(raw.fromAnchorId as string) : undefined;
        const to = toOk ? anchorsById.get(raw.toAnchorId as string) : undefined;
        if (!from) diagnostics.push(error("layout_link_anchor_not_found", `${path}.fromAnchorId`, "Link source anchor does not exist.", fromOk ? raw.fromAnchorId as string : undefined));
        if (!to) diagnostics.push(error("layout_link_anchor_not_found", `${path}.toAnchorId`, "Link destination anchor does not exist.", toOk ? raw.toAnchorId as string : undefined));
        if (!Array.isArray(raw.capabilities) || raw.capabilities.length === 0 || raw.capabilities.length > CAPABILITIES.size
          || raw.capabilities.some(item => typeof item !== "string" || !CAPABILITIES.has(item as AnchorCapability))
          || (Array.isArray(raw.capabilities) && new Set(raw.capabilities).size !== raw.capabilities.length)) {
          diagnostics.push(error("layout_invalid_link_capabilities", `${path}.capabilities`, "Links require unique drive/walk traversal capabilities."));
          continue;
        }
        for (const capability of raw.capabilities as AnchorCapability[]) {
          if (from && !from.capabilities.includes(capability)) diagnostics.push(error("layout_link_capability_missing", `${path}.capabilities`, `Source anchor does not support ${capability}.`, from.id));
          if (to && !to.capabilities.includes(capability)) diagnostics.push(error("layout_link_capability_missing", `${path}.capabilities`, `Destination anchor does not support ${capability}.`, to.id));
        }
        if (idOk && from && to && Array.isArray(raw.capabilities) && raw.capabilities.length > 0
          && raw.capabilities.every(item => typeof item === "string" && CAPABILITIES.has(item as AnchorCapability))) {
          links.push({ id: raw.id as string, fromAnchorId: from.id, toAnchorId: to.id, capabilities: [...raw.capabilities] as AnchorCapability[] });
        }
      }
    }
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, value: Object.freeze({ schemaVersion: 1, id: value.id, coordinateSystem: "city-local-m-v1", anchors: Object.freeze(anchors.map(anchor => Object.freeze({ ...anchor, capabilities: Object.freeze([...anchor.capabilities]) as unknown as AnchorCapability[] }))) as unknown as CityAnchorV1[], ...(value.links === undefined ? {} : { links: Object.freeze(links.map(link => Object.freeze({ ...link, capabilities: Object.freeze([...link.capabilities]) as unknown as AnchorCapability[] }))) as unknown as CityAnchorLinkV1[] }) }), diagnostics: [] };
}

/** Validates the identity envelope around a City adapter's immutable layout snapshot. */
export function validateCityLayoutSnapshot(value: unknown): Result<CityLayoutSnapshotV1> {
  if (!isObject(value) || !exactKeys(value, ["schemaVersion", "worldRevision", "seed", "layout"])) {
    return { ok: false, diagnostics: [error("layout_snapshot_invalid_shape", "$", "Layout snapshot must contain only version, revision, seed and layout.")] };
  }
  if (value.schemaVersion !== 1 || typeof value.worldRevision !== "string" || value.worldRevision.length === 0 || value.worldRevision.length > 256
    || !Number.isSafeInteger(value.seed) || (value.seed as number) < 0 || (value.seed as number) > 0xffff_ffff) {
    return { ok: false, diagnostics: [error("layout_snapshot_invalid_identity", "$", "Layout snapshot identity or seed is invalid.")] };
  }
  const layout = validateCityLayout(value.layout);
  if (!layout.ok) return layout;
  return { ok: true, value: Object.freeze({ schemaVersion: 1, worldRevision: value.worldRevision, seed: value.seed as number, layout: layout.value }), diagnostics: [] };
}

/** Validates a multi-City layout without treating legacy worldRevision as a global city identity. */
export function validateCityLayoutSnapshotV2(value: unknown): Result<CityLayoutSnapshotV2> {
  if (!isObject(value) || !exactKeys(value, ["schemaVersion", "cityId", "cityRevision", "worldRevision", "seed", "layout"])) {
    return { ok: false, diagnostics: [error("layout_snapshot_invalid_shape", "$", "Version 2 layout snapshot requires its City identity and revision.")] };
  }
  if (value.schemaVersion !== 2 || typeof value.cityId !== "string" || !identifier.test(value.cityId)
    || !Number.isSafeInteger(value.cityRevision) || (value.cityRevision as number) < 0) {
    return { ok: false, diagnostics: [error("layout_snapshot_invalid_city", "cityId", "Layout must identify a valid City and its revision.")] };
  }
  const legacy = validateCityLayoutSnapshot({ schemaVersion: 1, worldRevision: value.worldRevision, seed: value.seed, layout: value.layout });
  if (!legacy.ok) return legacy;
  return { ok: true, value: Object.freeze({ schemaVersion: 2, cityId: value.cityId, cityRevision: value.cityRevision as number,
    worldRevision: legacy.value.worldRevision, seed: legacy.value.seed, layout: legacy.value.layout }), diagnostics: [] };
}

/** Reject stale or cross-City bindings even when the seed or world revision matches. */
export function validateCityLayoutScope(value: unknown, city: Pick<CityInstanceV1, "cityId" | "revision" | "seed">): Result<CityLayoutSnapshotV2> {
  const snapshot = validateCityLayoutSnapshotV2(value);
  if (!snapshot.ok) return snapshot;
  if (snapshot.value.cityId !== city.cityId || snapshot.value.cityRevision !== city.revision || snapshot.value.seed !== city.seed) {
    return { ok: false, diagnostics: [error("layout_snapshot_city_mismatch", "cityId", "Layout belongs to a different City, revision or seed.")] };
  }
  return snapshot;
}

/** Validate a bounded, data-only scene draft. Asset existence is checked separately with validateAssetRefs. */
export function validateSceneDraft(value: unknown): Result<SceneDraftV1> {
  if (!isObject(value) || !exactKeys(value, ["schemaVersion", "objects"]) || value.schemaVersion !== 1 || !Array.isArray(value.objects)) {
    return { ok: false, diagnostics: [error("scene_invalid_shape", "$", "Scene draft must be a version 1 object with an objects array.")] };
  }
  if (value.objects.length > 10_000) return { ok: false, diagnostics: [error("scene_budget_exceeded", "objects", "Scene draft may contain at most 10000 objects.")] };
  const diagnostics: DiagnosticV1[] = [];
  const objects: SceneObjectV1[] = [];
  const ids = new Set<string>();
  let colliderCount = 0;
  const validVector = (raw: unknown, bounds: readonly [number, number]): raw is { x: number; y: number; z: number } =>
    isObject(raw) && exactKeys(raw, ["x", "y", "z"]) && [raw.x, raw.y, raw.z].every(number => typeof number === "number" && Number.isFinite(number) && number >= bounds[0] && number <= bounds[1]);
  const validRef = (raw: unknown): raw is ModelAssetRefV1 => isObject(raw) && exactKeys(raw, ["package", "assetId", "digest"])
    && isObject(raw.package) && exactKeys(raw.package, ["kind", "id", "version", "digest"])
    && typeof raw.package.kind === "string" && ["city-layout", "city-skin", "city-minigame", "city-world"].includes(raw.package.kind)
    && typeof raw.package.id === "string" && identifier.test(raw.package.id)
    && typeof raw.package.version === "string" && raw.package.version.length > 0 && raw.package.version.length <= 64
    && typeof raw.package.digest === "string" && raw.package.digest.length > 0 && raw.package.digest.length <= 256
    && typeof raw.assetId === "string" && identifier.test(raw.assetId)
    && typeof raw.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(raw.digest);
  for (const [index, raw] of value.objects.entries()) {
    const path = `objects[${index}]`;
    if (!isObject(raw) || typeof raw.id !== "string" || !identifier.test(raw.id)) {
      diagnostics.push(error("scene_object_invalid", path, "Scene object must have a stable ID."));
      continue;
    }
    if (ids.has(raw.id)) diagnostics.push(error("scene_object_duplicate_id", `${path}.id`, "Scene object IDs must be unique.", raw.id));
    ids.add(raw.id);
    if (!isObject(raw.transform) || !exactKeys(raw.transform, ["positionMeters", "rotationRadians", "scale"])
      || !validVector(raw.transform.positionMeters, [-100_000, 100_000])
      || !validVector(raw.transform.rotationRadians, [-6_283, 6_283])
      || !validVector(raw.transform.scale, [0.001, 100])) {
      diagnostics.push(error("scene_transform_invalid", `${path}.transform`, "Transform must use bounded meter position, radian rotation and positive scale vectors.", raw.id));
      continue;
    }
    const transform = Object.freeze({ positionMeters: Object.freeze({ ...raw.transform.positionMeters }), rotationRadians: Object.freeze({ ...raw.transform.rotationRadians }), scale: Object.freeze({ ...raw.transform.scale }) });
    if (raw.kind === "model" && exactKeys(raw, ["id", "kind", "asset", "transform"])) {
      if (!validRef(raw.asset)) diagnostics.push(error("scene_asset_ref_invalid", `${path}.asset`, "Model asset reference is invalid.", raw.id));
      else objects.push(Object.freeze({ id: raw.id, kind: "model", asset: Object.freeze({ package: Object.freeze({ ...raw.asset.package }) as ContentRef, assetId: raw.asset.assetId, digest: raw.asset.digest }), transform }));
    } else if (raw.kind === "collider" && exactKeys(raw, ["id", "kind", "shape", "sizeMeters", "transform"])) {
      colliderCount += 1;
      if (colliderCount > 256) diagnostics.push(error("scene_collider_budget_exceeded", "objects", "A scene draft may contain at most 256 static box colliders.", raw.id));
      if (raw.shape !== "box" || !validVector(raw.sizeMeters, [0.1, 100])) {
        diagnostics.push(error("scene_collider_invalid", `${path}.shape`, "Static collider must be a bounded box with meter dimensions between 0.1 and 100.", raw.id));
      } else if (colliderCount <= 256) objects.push(Object.freeze({ id: raw.id, kind: "collider", shape: "box",
        sizeMeters: Object.freeze({ ...raw.sizeMeters }), transform }));
    } else if (raw.kind === "anchor" && exactKeys(raw, ["id", "kind", "anchor", "transform"])) {
      if (!isObject(raw.anchor) || raw.anchor.id !== raw.id) {
        diagnostics.push(error("scene_anchor_id_mismatch", `${path}.anchor.id`, "Scene anchor and object IDs must match.", raw.id));
        continue;
      }
      const layout = validateCityLayout({ schemaVersion: 1, id: "scene-anchor-check", coordinateSystem: "city-local-m-v1", anchors: [raw.anchor] });
      if (!layout.ok) diagnostics.push(...layout.diagnostics.map(item => ({ ...item, path: `${path}.anchor.${item.path.replace(/^anchors\[0\]\.*/, "")}`, objectId: raw.id as string })));
      else objects.push(Object.freeze({ id: raw.id, kind: "anchor", anchor: layout.value.anchors[0]!, transform }));
    } else diagnostics.push(error("scene_object_invalid", path, "Scene object kind or fields are unsupported.", raw.id));
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, value: Object.freeze({ schemaVersion: 1, objects: Object.freeze(objects) }), diagnostics: [] };
}

export function validateMount(input: { layout: unknown; game: unknown; mount: unknown; resolvedRefs?: { layout: ContentRef<"city-layout">; game: ContentRef<"city-minigame"> } }): Result<{ layout: CityLayoutV1; game: MiniGamePackV1; mount: CityGameMountV1 }> {
  if (!isObject(input)) return { ok: false, diagnostics: [error("mount_invalid_shape", "$", "Mount validation input must be an object.")] };
  const layoutResult = validateCityLayout(input.layout);
  if (layoutResult.ok === false) return layoutResult;
  const layout: CityLayoutV1 = layoutResult.value;
  const gameResult = validateMiniGamePack(input.game);
  if (gameResult.ok === false) return gameResult;
  const game: MiniGamePackV1 = gameResult.value;
  const diagnostics: DiagnosticV1[] = [];
  const raw = input.mount;
  if (!isObject(raw) || !exactKeys(raw, ["schemaVersion", "mountId", "layout", "game", "entryAnchorId", "bindings", "parameterOverrides"])) {
    return { ok: false, diagnostics: [error("mount_invalid_shape", "mount", "Mount must be an object containing only the version 1 mount fields.")] };
  }
  const ref = (value: unknown, kind: string, path: string): boolean => isObject(value) && exactKeys(value, ["kind", "id", "version", "digest"]) && value.kind === kind && typeof value.id === "string" && identifier.test(value.id) && typeof value.version === "string" && value.version.length > 0 && value.version.length <= 64 && typeof value.digest === "string" && value.digest.length > 0 && value.digest.length <= 256;
  if (raw.schemaVersion !== 1 || typeof raw.mountId !== "string" || !identifier.test(raw.mountId) || !ref(raw.layout, "city-layout", "mount.layout") || !ref(raw.game, "city-minigame", "mount.game") || typeof raw.entryAnchorId !== "string" || !identifier.test(raw.entryAnchorId) || !isObject(raw.bindings) || !isObject(raw.parameterOverrides)) {
    return { ok: false, diagnostics: [error("mount_invalid_shape", "mount", "Mount fields, references or identifiers do not match version 1.")] };
  }
  const mount = raw as unknown as CityGameMountV1;
  if (Object.keys(mount.bindings).length > 32 || Object.keys(mount.parameterOverrides).length > 32) return { ok: false, diagnostics: [error("mount_budget_exceeded", "mount", "Mount has too many bindings or parameter overrides.")] };
  let bindingCount = 0;
  for (const [name, ids] of Object.entries(mount.bindings)) {
    if (!identifier.test(name) || !Array.isArray(ids) || ids.some(id => typeof id !== "string" || !identifier.test(id))) return { ok: false, diagnostics: [error("mount_invalid_binding", `mount.bindings.${name}`, "Binding names and anchor IDs must be stable identifiers.")] };
    bindingCount += ids.length;
  }
  if (bindingCount > 64) return { ok: false, diagnostics: [error("mount_budget_exceeded", "mount.bindings", "A mount may bind at most 64 anchors.")] };
  if (Object.entries(mount.parameterOverrides).some(([name, value]) => !identifier.test(name) || !Number.isSafeInteger(value))) return { ok: false, diagnostics: [error("mount_invalid_parameter", "mount.parameterOverrides", "Parameter overrides must use stable names and safe integers.")] };
  const resolvedMount: CityGameMountV1 = Object.freeze({ schemaVersion: 1, mountId: mount.mountId,
    layout: Object.freeze({ ...mount.layout }), game: Object.freeze({ ...mount.game }), entryAnchorId: mount.entryAnchorId,
    bindings: Object.freeze(Object.fromEntries(Object.entries(mount.bindings).map(([name, ids]) => [name, Object.freeze([...ids]) as unknown as string[]]))),
    parameterOverrides: Object.freeze({ ...mount.parameterOverrides }) });
  if (layout.schemaVersion !== 1 || game.schemaVersion !== 1 || game.rulesVersion !== 1 || mount.schemaVersion !== 1) {
    diagnostics.push(error("schema_unsupported", "$", "Only City SDK schema version 1 is supported."));
  }
  if (resolvedMount.layout.id !== layout.id) diagnostics.push(error("layout_ref_mismatch", "mount.layout", "Mount layout reference does not match the supplied layout."));
  if (resolvedMount.game.id !== game.id) diagnostics.push(error("game_ref_mismatch", "mount.game", "Mount game reference does not match the supplied game."));
  if (input.resolvedRefs) {
    const matches = (actual: unknown, expected: ContentRef, path: string) => {
      if (!isObject(actual) || actual.kind !== expected.kind || actual.id !== expected.id || actual.version !== expected.version || actual.digest !== expected.digest) {
        diagnostics.push(error("content_ref_mismatch", path, "Mount reference does not match the exact content version resolved by the package loader."));
      }
    };
    matches(raw.layout, input.resolvedRefs.layout, "mount.layout");
    matches(raw.game, input.resolvedRefs.game, "mount.game");
  }
  const anchors = new Map<string, CityAnchorV1>(layout.anchors.map((anchor: CityAnchorV1) => [anchor.id, anchor]));
  const entryAnchor = anchors.get(resolvedMount.entryAnchorId);
  if (!entryAnchor) diagnostics.push(error("anchor_not_found", "mount.entryAnchorId", "Entry anchor does not exist.", resolvedMount.entryAnchorId));
  else if (entryAnchor.kind !== "spawn") diagnostics.push(error("entry_anchor_kind_mismatch", "mount.entryAnchorId", "Game entry must reference a spawn anchor.", resolvedMount.entryAnchorId));
  for (const [slotName, spec] of Object.entries(game.slots)) {
    const ids = resolvedMount.bindings[slotName] ?? [];
    if (ids.length < spec.min || ids.length > spec.max) diagnostics.push(error("slot_binding_count", `mount.bindings.${slotName}`, `Expected ${spec.min} to ${spec.max} bindings.`));
    ids.forEach((id, index) => {
      const anchor = anchors.get(id);
      if (!anchor) diagnostics.push(error("anchor_not_found", `mount.bindings.${slotName}[${index}]`, "Bound anchor does not exist.", id));
      else {
        if (anchor.kind !== spec.kind) diagnostics.push(error("anchor_kind_mismatch", `mount.bindings.${slotName}[${index}]`, `Expected ${spec.kind} anchor.`, id));
        for (const capability of spec.requires ?? []) if (!anchor.capabilities.includes(capability)) diagnostics.push(error("anchor_capability_missing", `mount.bindings.${slotName}[${index}]`, `Anchor requires ${capability} capability.`, id));
      }
    });
  }
  if (layout.links && entryAnchor) {
    const graphByCapability = new Map<AnchorCapability, Map<string, string[]>>();
    for (const link of layout.links) for (const capability of link.capabilities) {
      const graph = graphByCapability.get(capability) ?? new Map<string, string[]>();
      graph.set(link.fromAnchorId, [...(graph.get(link.fromAnchorId) ?? []), link.toAnchorId]);
      graph.set(link.toAnchorId, [...(graph.get(link.toAnchorId) ?? []), link.fromAnchorId]);
      graphByCapability.set(capability, graph);
    }
    for (const [slotName, spec] of Object.entries(game.slots)) for (const capability of spec.requires ?? []) {
      if (!entryAnchor.capabilities.includes(capability)) {
        diagnostics.push(error("entry_capability_missing", "mount.entryAnchorId", `Entry anchor requires ${capability} capability for slot '${slotName}'.`, entryAnchor.id));
        continue;
      }
      const graph = graphByCapability.get(capability) ?? new Map<string, string[]>();
      const reached = new Set<string>([entryAnchor.id]);
      const queue = [entryAnchor.id];
      for (let head = 0; head < queue.length; head += 1) for (const next of graph.get(queue[head]!) ?? []) {
        if (!reached.has(next)) { reached.add(next); queue.push(next); }
      }
      for (const anchorId of resolvedMount.bindings[slotName] ?? []) if (!reached.has(anchorId)) {
        diagnostics.push(error("anchor_unreachable", `mount.bindings.${slotName}`, `Bound ${capability} anchor is not connected to the game entry.`, anchorId));
      }
    }
  }
  for (const name of Object.keys(resolvedMount.bindings)) if (!hasOwn(game.slots, name)) diagnostics.push(error("slot_not_found", `mount.bindings.${name}`, "Game does not declare this slot."));
  for (const [name, value] of Object.entries(resolvedMount.parameterOverrides)) {
    const parameter = game.integerParameters?.[name];
    if (!parameter) diagnostics.push(error("parameter_not_found", `mount.parameterOverrides.${name}`, "Game does not declare this parameter."));
    else if (!Number.isInteger(value) || value < parameter.min || value > parameter.max) diagnostics.push(error("parameter_out_of_range", `mount.parameterOverrides.${name}`, "Parameter value is outside its declared integer range."));
  }
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: { layout, game, mount: resolvedMount }, diagnostics };
}


export function listAnchors(layout: CityLayoutV1, filter: AnchorFilterV1 = {}): CityAnchorV1[] {
  return layout.anchors.filter(anchor =>
    (filter.kind === undefined || anchor.kind === filter.kind) &&
    (filter.requires === undefined || filter.requires.every(capability => anchor.capabilities.includes(capability)))
  );
}

/** Validate the portable metadata for a local project asset inventory; disk bytes are verified by the CLI. */
export function validateCityProjectAssetCatalog(value: unknown): Result<CityProjectAssetCatalogV1> {
  if (!isObject(value) || !exactKeys(value, ["schemaVersion", "entries"]) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    return { ok: false, diagnostics: [error("project_asset_catalog_invalid", "$", "Project asset catalog must be a version 1 object with an entries array.")] };
  }
  if (value.entries.length > 4_096) return { ok: false, diagnostics: [error("project_asset_catalog_budget_exceeded", "entries", "Project asset catalog may contain at most 4096 assets.")] };
  const entries: CityProjectAssetEntryV1[] = [];
  const ids = new Set<string>();
  let totalBytes = 0;
  const diagnostics: DiagnosticV1[] = [];
  for (const [index, raw] of value.entries.entries()) {
    const path = `entries[${index}]`;
    if (!isObject(raw) || !exactKeys(raw, ["assetId", "relativePath", "sha256", "byteLength", "format", "boundsMeters"])) {
      diagnostics.push(error("project_asset_entry_invalid", path, "Project asset entry contains unsupported or missing fields."));
      continue;
    }
    const validId = typeof raw.assetId === "string" && identifier.test(raw.assetId);
    const validDigest = typeof raw.sha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(raw.sha256);
    const expectedPath = validDigest && typeof raw.sha256 === "string" ? `assets/${raw.sha256.slice("sha256:".length)}.glb` : "";
    const validPath = raw.relativePath === expectedPath;
    const validSize = Number.isSafeInteger(raw.byteLength) && (raw.byteLength as number) >= 20 && (raw.byteLength as number) <= 64 * 1024 * 1024;
    const bounds = raw.boundsMeters;
    const validBounds = bounds === undefined || (isObject(bounds) && exactKeys(bounds, ["x", "y", "z"])
      && [bounds.x, bounds.y, bounds.z].every(number => typeof number === "number" && Number.isFinite(number) && number > 0 && number <= 10_000));
    if (!validId) diagnostics.push(error("project_asset_id_invalid", `${path}.assetId`, "Asset ID must be a stable identifier."));
    if (!validDigest) diagnostics.push(error("project_asset_digest_invalid", `${path}.sha256`, "Asset digest must be a lowercase SHA-256 value."));
    if (!validPath) diagnostics.push(error("project_asset_path_invalid", `${path}.relativePath`, "Project asset path must be derived from its SHA-256 digest."));
    if (!validSize) diagnostics.push(error("project_asset_size_invalid", `${path}.byteLength`, "GLB size must be between 20 bytes and 64 MiB."));
    if (raw.format !== "glb-v2") diagnostics.push(error("project_asset_format_unsupported", `${path}.format`, "Only inspected GLB v2 assets are supported."));
    if (!validBounds) diagnostics.push(error("project_asset_bounds_invalid", `${path}.boundsMeters`, "Bounds must contain finite positive meter dimensions no larger than 10000."));
    if (validId && ids.has(raw.assetId as string)) diagnostics.push(error("project_asset_id_duplicate", `${path}.assetId`, "Asset IDs must be unique."));
    if (validSize) totalBytes += raw.byteLength as number;
    if (validId && validDigest && validPath && validSize && validBounds && raw.format === "glb-v2"
      && !ids.has(raw.assetId as string)) {
      ids.add(raw.assetId as string);
      entries.push(Object.freeze({ assetId: raw.assetId as string, relativePath: expectedPath, sha256: raw.sha256 as string,
        byteLength: raw.byteLength as number, format: "glb-v2", ...(isObject(bounds) ? { boundsMeters: Object.freeze({ x: bounds.x as number, y: bounds.y as number, z: bounds.z as number }) } : {}) }));
    }
  }
  if (totalBytes > 2_147_483_648) diagnostics.push(error("project_asset_catalog_size_exceeded", "entries", "Project asset catalog may declare at most 2 GiB total."));
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, value: Object.freeze({ schemaVersion: 1, entries: Object.freeze(entries) }), diagnostics: [] };
}

/** Query an SDK scene draft without mutating it; results retain source order. */
export function listSceneObjects(scene: SceneDraftV1, filter: SceneObjectFilterV1 = {}): SceneObjectV1[] {
  if (!scene || scene.schemaVersion !== 1 || !Array.isArray(scene.objects) || scene.objects.length > 50_000) return [];
  return scene.objects.filter(object => {
    if (!object || (object.kind !== "model" && object.kind !== "anchor")) return false;
    if (filter.kind !== undefined && object.kind !== filter.kind) return false;
    if (filter.id !== undefined && object.id !== filter.id) return false;
    if (filter.assetId !== undefined && (object.kind !== "model" || object.asset.assetId !== filter.assetId)) return false;
    if (filter.anchorKind !== undefined && (object.kind !== "anchor" || object.anchor?.kind !== filter.anchorKind)) return false;
    return true;
  });
}

/** List entries from a validated catalog snapshot; this does not scan storage. */
export function listAssets(catalog: ModelAssetCatalogV1, filter: ModelAssetFilterV1 = {}): ModelAssetCatalogEntryV1[] {
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries) || catalog.entries.length > 4_096) return [];
  return catalog.entries.filter(entry =>
    (filter.assetId === undefined || entry.ref.assetId === filter.assetId) &&
    (filter.packageId === undefined || entry.ref.package.id === filter.packageId) &&
    (filter.packageKind === undefined || entry.ref.package.kind === filter.packageKind) &&
    (filter.maxByteLength === undefined || entry.byteLength <= filter.maxByteLength)
  );
}

/** Resolve model references against a trusted, already-inspected catalog snapshot. */
export function validateAssetRefs(input: unknown): Result<ResolvedModelAssetRefsV1> {
  if (!isObject(input) || !exactKeys(input, ["refs", "catalog"])) return { ok: false, diagnostics: [error("asset_refs_invalid", "$", "Input must contain only refs and catalog.")] };
  const diagnostics: DiagnosticV1[] = [];
  const fail = (code: string, path: string, message: string, objectId?: string) => diagnostics.push(error(code, path, message, objectId));
  const validPackageRef = (value: unknown): value is ContentRef => isObject(value)
    && exactKeys(value, ["kind", "id", "version", "digest"])
    && typeof value.kind === "string" && ["city-layout", "city-skin", "city-minigame", "city-world"].includes(value.kind)
    && typeof value.id === "string" && identifier.test(value.id)
    && typeof value.version === "string" && value.version.length > 0 && value.version.length <= 64
    && typeof value.digest === "string" && value.digest.length > 0 && value.digest.length <= 256;
  const validAssetRef = (value: unknown): value is ModelAssetRefV1 => isObject(value)
    && exactKeys(value, ["package", "assetId", "digest"])
    && validPackageRef(value.package)
    && typeof value.assetId === "string" && identifier.test(value.assetId)
    && typeof value.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.digest);
  if (!Array.isArray(input.refs) || input.refs.length > 10_000) return { ok: false, diagnostics: [error("asset_refs_invalid", "refs", "Asset refs must be an array of at most 10000 entries.")] };
  if (!isObject(input.catalog) || !exactKeys(input.catalog, ["schemaVersion", "entries"]) || input.catalog.schemaVersion !== 1 || !Array.isArray(input.catalog.entries) || input.catalog.entries.length > 4_096) {
    return { ok: false, diagnostics: [error("asset_catalog_invalid", "catalog", "Asset catalog must be a version 1 catalog with at most 4096 entries.")] };
  }
  const byKey = new Map<string, ModelAssetCatalogEntryV1>();
  let totalBytes = 0;
  for (const [index, raw] of input.catalog.entries.entries()) {
    const path = `catalog.entries[${index}]`;
    if (!isObject(raw) || !exactKeys(raw, ["ref", "relativePath", "byteLength", "boundsMeters", "unit"]) || !validAssetRef(raw.ref)) {
      fail("asset_catalog_entry_invalid", path, "Catalog entry has an invalid asset ref or unsupported fields.");
      continue;
    }
    const relativePath = raw.relativePath;
    const safePath = typeof relativePath === "string" && relativePath.length <= 512 && !relativePath.startsWith("/")
      && !relativePath.includes("\\") && relativePath.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
    const bounds = raw.boundsMeters;
    const validBounds = isObject(bounds) && exactKeys(bounds, ["x", "y", "z"])
      && [bounds.x, bounds.y, bounds.z].every(value => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10_000);
    if (!safePath) fail("asset_path_invalid", `${path}.relativePath`, "Asset path must be a normalized package-relative path.");
    if (!Number.isSafeInteger(raw.byteLength) || (raw.byteLength as number) <= 0 || (raw.byteLength as number) > 1_073_741_824) fail("asset_size_invalid", `${path}.byteLength`, "Asset size must be a positive integer no larger than 1 GiB.");
    else totalBytes += raw.byteLength as number;
    if (!validBounds) fail("asset_bounds_invalid", `${path}.boundsMeters`, "Asset bounds must contain finite positive meter dimensions no larger than 10000.");
    if (raw.unit !== "meter") fail("asset_unit_unsupported", `${path}.unit`, "Only meter-normalized model assets are supported.");
    const key = `${raw.ref.package.kind}/${raw.ref.package.id}/${raw.ref.package.version}/${raw.ref.assetId}`;
    if (byKey.has(key)) fail("asset_catalog_duplicate", `${path}.ref.assetId`, "Catalog asset references must be unique.", raw.ref.assetId);
    else if (safePath && validBounds && raw.unit === "meter" && Number.isSafeInteger(raw.byteLength) && (raw.byteLength as number) > 0) {
      const entry = Object.freeze({ ref: Object.freeze({ package: Object.freeze({ ...raw.ref.package }), assetId: raw.ref.assetId, digest: raw.ref.digest }), relativePath, byteLength: raw.byteLength as number, boundsMeters: Object.freeze({ x: bounds.x as number, y: bounds.y as number, z: bounds.z as number }), unit: "meter" as const });
      byKey.set(key, entry);
    }
  }
  if (totalBytes > 2_147_483_648) fail("asset_catalog_budget_exceeded", "catalog.entries", "Catalog total declared asset size exceeds 2 GiB.");
  const refs: ModelAssetRefV1[] = [];
  const resolvedEntries: ModelAssetCatalogEntryV1[] = [];
  for (const [index, raw] of input.refs.entries()) {
    if (!validAssetRef(raw)) { fail("asset_ref_invalid", `refs[${index}]`, "Asset reference is invalid."); continue; }
    const key = `${raw.package.kind}/${raw.package.id}/${raw.package.version}/${raw.assetId}`;
    const entry = byKey.get(key);
    if (!entry) fail("asset_not_found", `refs[${index}]`, "Asset reference is not present in the supplied catalog.", raw.assetId);
    else if (entry.ref.digest !== raw.digest || entry.ref.package.digest !== raw.package.digest) fail("asset_digest_mismatch", `refs[${index}].digest`, "Asset reference digest does not match the catalog entry.", raw.assetId);
    else { refs.push(Object.freeze({ package: Object.freeze({ ...raw.package }), assetId: raw.assetId, digest: raw.digest })); resolvedEntries.push(entry); }
  }
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: Object.freeze({ refs: Object.freeze(refs), entries: Object.freeze(resolvedEntries) }), diagnostics };
}
