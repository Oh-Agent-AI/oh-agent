import { parseKitModel, type KitModel } from "../engine/sessionKitConstruction";

export const CITY_BUILDING_OBJECT_TYPE = "city.building-kit:v1";
export const CITY_BUILDING_OBJECT_SCHEMA_VERSION = 1;

export type CityBuildingStoredObject = {
  handle: string; alias?: string; schemaVersion: number; revision: number; body: Record<string, unknown>; deleted: boolean;
};

export type CityBuildingObjectClient = {
  readByAlias(input: { objectType: string; alias: string }): Promise<CityBuildingStoredObject>;
  list(input: { objectType: string; schemaVersion: number; aliases: readonly string[] }): Promise<{
    objects: CityBuildingStoredObject[]; nextCursor: string | null; hasMore: boolean;
  }>;
  create(input: { objectType: string; schemaVersion: number; body: Record<string, unknown>; alias: string; idempotencyKey: string }): Promise<CityBuildingStoredObject>;
  commit(input: { objectType: string; handle: string; expectedRevision: number; body: Record<string, unknown>;
    events: readonly { eventType: string; body: Record<string, unknown> }[]; idempotencyKey: string }): Promise<{ revision: number; eventIds: string[] }>;
};

export type CityBuildingLegacyOverride = {
  asset_ref: string;
  revision: number;
  kit_version: string;
  model: KitModel;
  updated_at_ms?: number;
};

export type CityBuildingObjectState = "matched" | "imported" | "missing" | "conflict" | "invalid";
export type CityBuildingObjectResult = { state: CityBuildingObjectState; model?: KitModel; objectRevision?: number };
export type CityBuildingObjectSnapshot = { handle: string; objectRevision: number; domainRevision: number;
  authority: "legacy-shadow" | "generic-object"; model: KitModel | null; inheritance?: Record<string, unknown> | null; updatedAtMs?: number };

function validStableRef(value: string): boolean { return /^srp_[a-f0-9]{32}$/.test(value); }
function validAssetRef(value: string): boolean { return /^ca_[0-9a-f]{32}$/.test(value); }
function importKey(stableRef: string): string { return `city-kit-import-${stableRef}`; }

function parseBuildingObject(value: unknown, stableRef: string): { model: KitModel | null; domainRevision: number;
  authority: "legacy-shadow" | "generic-object"; inheritance?: Record<string, unknown> | null;
  updatedAtMs?: number; handle: string; objectRevision: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (object.schemaVersion !== CITY_BUILDING_OBJECT_SCHEMA_VERSION || object.deleted !== false
      || object.alias !== stableRef || !Number.isSafeInteger(object.revision) || Number(object.revision) < 1
      || !object.body || typeof object.body !== "object" || Array.isArray(object.body)) return null;
  const body = object.body as Record<string, unknown>;
  const revisionKey = Object.hasOwn(body, "domainRevision") ? "domainRevision" : "legacyRevision";
  const keys = ["schema", "kitVersion", revisionKey, "model",
    ...(body.updatedAtMs === undefined ? [] : ["updatedAtMs"]),
    ...(Object.hasOwn(body, "inheritance") ? ["inheritance"] : [])];
  if (Object.keys(body).length !== keys.length || keys.some((key) => !Object.hasOwn(body, key))
      || body.schema !== "city-building-kit:v1" || !Number.isSafeInteger(body[revisionKey]) || Number(body[revisionKey]) < 0) return null;
  if (Object.hasOwn(body, "inheritance") && body.inheritance !== null
      && (!body.inheritance || typeof body.inheritance !== "object" || Array.isArray(body.inheritance)
        || new TextEncoder().encode(JSON.stringify(body.inheritance)).byteLength > 16 * 1024)) return null;
  const model = body.model === null ? null : parseKitModel(body.model);
  if ((body.model !== null && !model) || (model && body.kitVersion !== model.kit_version)
      || (body.updatedAtMs !== undefined && (!Number.isSafeInteger(body.updatedAtMs) || Number(body.updatedAtMs) < 0))) return null;
  return { model, domainRevision: Number(body[revisionKey]), authority: revisionKey === "domainRevision" ? "generic-object" : "legacy-shadow",
    handle: object.handle as string, objectRevision: Number(object.revision),
    ...(Object.hasOwn(body, "inheritance") ? { inheritance: body.inheritance as Record<string, unknown> | null } : {}),
    ...(typeof body.updatedAtMs === "number" ? { updatedAtMs: body.updatedAtMs } : {}) };
}

function sameModel(left: KitModel, right: KitModel): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Copy a legacy City building override into the descriptor-scoped object store.
 * Such imported documents remain shadows; only documents later committed with
 * `domainRevision` become generic-object authority for the runtime reader.
 */
export async function importLegacyBuildingOverride(
  client: CityBuildingObjectClient,
  stableRef: string,
  legacy: CityBuildingLegacyOverride,
  prefetched?: CityBuildingStoredObject | null,
): Promise<CityBuildingObjectResult> {
  if (!validStableRef(stableRef) || !validAssetRef(legacy.asset_ref)
      || !Number.isSafeInteger(legacy.revision) || legacy.revision < 0
      || legacy.kit_version !== "session-kit/v1" || !parseKitModel(legacy.model)
      || (legacy.updated_at_ms !== undefined && (!Number.isSafeInteger(legacy.updated_at_ms) || legacy.updated_at_ms < 0))) {
    return { state: "invalid" };
  }

  // parseKitModel uses optional `undefined` values internally; the IPC object
  // contract accepts JSON only, so remove those keys before crossing the host.
  const canonicalModel = JSON.parse(JSON.stringify(parseKitModel(legacy.model))) as KitModel;
  const expectedBody = {
    schema: "city-building-kit:v1",
    kitVersion: legacy.kit_version,
    legacyRevision: legacy.revision,
    model: canonicalModel,
    ...(legacy.updated_at_ms === undefined ? {} : { updatedAtMs: legacy.updated_at_ms }),
  };
  let object: CityBuildingStoredObject | null = prefetched ?? null;
  let created = false;
  if (prefetched === undefined) {
    try {
      object = await client.readByAlias({ objectType: CITY_BUILDING_OBJECT_TYPE, alias: stableRef });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "object_unavailable") return { state: "missing" };
    }
  }
  if (!object) {
    try {
      object = await client.create({ objectType: CITY_BUILDING_OBJECT_TYPE, schemaVersion: CITY_BUILDING_OBJECT_SCHEMA_VERSION,
        alias: stableRef, body: expectedBody, idempotencyKey: importKey(stableRef) });
      created = true;
    } catch (error) {
      // A concurrent page may have won the alias binding. Re-read that binding;
      // never choose another alias or overwrite a different object.
      if (!(error instanceof Error) || !["alias_conflict", "idempotency_conflict"].includes(error.message)) return { state: "missing" };
      try { object = await client.readByAlias({ objectType: CITY_BUILDING_OBJECT_TYPE, alias: stableRef }); }
      catch { return { state: "missing" }; }
    }
  }
  const parsed = parseBuildingObject(object, stableRef);
  if (!parsed) return { state: "invalid" };
  if (parsed.domainRevision !== legacy.revision || !parsed.model || !sameModel(parsed.model, legacy.model)
      || parsed.updatedAtMs !== legacy.updated_at_ms) return { state: "conflict" };
  return { state: created ? "imported" : "matched", model: parsed.model, objectRevision: object.revision };
}

/** Resolve the requested stable references in bounded batches through the generic object API. */
export async function listCityBuildingObjectsByStableRef(
  client: CityBuildingObjectClient,
  stableRefs: readonly string[],
): Promise<Map<string, CityBuildingStoredObject>> {
  const refs = [...new Set(stableRefs)];
  if (refs.some((stableRef) => !validStableRef(stableRef))) throw new Error("city_building_stable_ref_invalid");
  const objects = new Map<string, CityBuildingStoredObject>();
  for (let offset = 0; offset < refs.length; offset += 200) {
    const aliases = refs.slice(offset, offset + 200);
    const page = await client.list({ objectType: CITY_BUILDING_OBJECT_TYPE, schemaVersion: CITY_BUILDING_OBJECT_SCHEMA_VERSION, aliases });
    if (page.hasMore || page.nextCursor !== null || page.objects.length > aliases.length) throw new Error("city_building_list_invalid");
    const requested = new Set(aliases);
    for (const object of page.objects) {
      if (!object.alias || !requested.has(object.alias) || objects.has(object.alias)) throw new Error("city_building_list_invalid");
      objects.set(object.alias, object);
    }
  }
  return objects;
}

/** Read the City-owned building document by its durable source reference. */
export async function readCityBuildingObject(client: CityBuildingObjectClient, stableRef: string,
  prefetched?: CityBuildingStoredObject | null): Promise<CityBuildingObjectSnapshot | null> {
  if (!validStableRef(stableRef)) throw new Error("city_building_stable_ref_invalid");
  let object: CityBuildingStoredObject;
  if (prefetched === null) return null;
  if (prefetched !== undefined) object = prefetched;
  else {
    try { object = await client.readByAlias({ objectType: CITY_BUILDING_OBJECT_TYPE, alias: stableRef }); }
    catch (error) {
      if (error instanceof Error && error.message === "object_unavailable") return null;
      throw error;
    }
  }
  const parsed = parseBuildingObject(object, stableRef);
  if (!parsed) throw new Error("city_building_object_invalid");
  return { handle: parsed.handle, objectRevision: parsed.objectRevision, domainRevision: parsed.domainRevision,
    authority: parsed.authority, model: parsed.model,
    ...(parsed.inheritance === undefined ? {} : { inheritance: parsed.inheritance }),
    ...(parsed.updatedAtMs === undefined ? {} : { updatedAtMs: parsed.updatedAtMs }) };
}

/**
 * Generic CAS write for the City adapter. Domain revision is stored separately
 * from the object-store revision because imported legacy revisions can start
 * at any value. Reset is a durable default-model document, not a tombstone.
 */
export async function commitCityBuildingObject(
  client: CityBuildingObjectClient,
  stableRef: string,
  expectedDomainRevision: number,
  model: KitModel | null,
  idempotencyKey: string,
  updatedAtMs = Date.now(),
  inheritance: Record<string, unknown> | null = null,
): Promise<{ domainRevision: number; objectRevision: number; eventId: string }> {
  if (!validStableRef(stableRef) || !Number.isSafeInteger(expectedDomainRevision) || expectedDomainRevision < 0
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey) || !Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0
      || (model !== null && !parseKitModel(model))
      || (inheritance !== null && new TextEncoder().encode(JSON.stringify(inheritance)).byteLength > 16 * 1024)) throw new Error("city_building_write_invalid");
  const canonicalModel = model === null ? null : JSON.parse(JSON.stringify(parseKitModel(model))) as KitModel;
  let current = await readCityBuildingObject(client, stableRef);
  if (!current) {
    // Keep the initializing document in the migration-shadow form. A crash
    // before the following CAS commit must not make an empty baseline override
    // an existing legacy row.
    const baseline = { schema: "city-building-kit:v1", kitVersion: "session-kit/v1", legacyRevision: expectedDomainRevision,
      model: null, updatedAtMs };
    try {
      const created = await client.create({ objectType: CITY_BUILDING_OBJECT_TYPE, schemaVersion: CITY_BUILDING_OBJECT_SCHEMA_VERSION,
        alias: stableRef, body: baseline, idempotencyKey: `city-kit-init-${stableRef}` });
      const parsed = parseBuildingObject(created, stableRef);
      if (!parsed) throw new Error("city_building_object_invalid");
      current = { handle: parsed.handle, objectRevision: parsed.objectRevision, domainRevision: parsed.domainRevision,
        authority: parsed.authority, model: parsed.model, ...(parsed.updatedAtMs === undefined ? {} : { updatedAtMs: parsed.updatedAtMs }) };
    } catch (error) {
      if (!(error instanceof Error) || !["alias_conflict", "idempotency_conflict"].includes(error.message)) throw error;
      current = await readCityBuildingObject(client, stableRef);
      if (!current) throw new Error("city_building_object_unavailable");
    }
  }
  if (current.domainRevision !== expectedDomainRevision) throw new Error("revision_conflict");
  const domainRevision = expectedDomainRevision + 1;
  const eventType = canonicalModel ? "city.building.changed" : "city.building.reset";
  const body = { schema: "city-building-kit:v1", kitVersion: canonicalModel?.kit_version ?? "session-kit/v1",
    domainRevision, model: canonicalModel, updatedAtMs, inheritance };
  const commit = await client.commit({ objectType: CITY_BUILDING_OBJECT_TYPE, handle: current.handle,
    expectedRevision: current.objectRevision, body, idempotencyKey,
    events: [{ eventType, body: { domainRevision, action: canonicalModel ? "set" : "reset", updatedAtMs } }] });
  if (commit.eventIds.length !== 1) throw new Error("city_building_commit_invalid");
  return { domainRevision, objectRevision: commit.revision, eventId: commit.eventIds[0]! };
}
