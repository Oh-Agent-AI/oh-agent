import test from "node:test";
import assert from "node:assert/strict";
import { CITY_BUILDING_OBJECT_TYPE, commitCityBuildingObject, importLegacyBuildingOverride, listCityBuildingObjectsByStableRef,
  readCityBuildingObject, type CityBuildingObjectClient } from "../src/data/cityBuildingObjects.ts";
import { parseKitModel } from "../src/engine/sessionKitConstruction.ts";
import { createTypedObjectClient } from "../../../../packages/agent-vitals-app-sdk/src/object-data.ts";

const stableRef = `srp_${"a".repeat(32)}`;
const legacy = {
  asset_ref: `ca_${"b".repeat(32)}`,
  revision: 4,
  kit_version: "session-kit/v1",
  model: { kit_version: "session-kit/v1", parts: [{ kind: "box" as const, role: "wall" as const, at: [0, 1, 0] as [number, number, number], size: [1, 1, 1] as [number, number, number] }] },
  updated_at_ms: 1_800_000_000_000,
};

function memoryClient(): CityBuildingObjectClient & { objects: Map<string, any>; events: any[] } {
  const objects = new Map<string, any>();
  const events: any[] = [];
  return {
    objects,
    events,
    async readByAlias({ alias }) {
      const object = objects.get(alias);
      if (!object) throw new Error("object_unavailable");
      return structuredClone(object);
    },
    async list({ aliases }) {
      return { objects: aliases.flatMap((alias) => objects.has(alias) ? [structuredClone(objects.get(alias))] : []), nextCursor: null, hasMore: false };
    },
    async create(input) {
      if (objects.has(input.alias)) throw new Error("alias_conflict");
      const object = { handle: `ob_${"c".repeat(32)}`, alias: input.alias, schemaVersion: input.schemaVersion,
        revision: 1, body: structuredClone(input.body), deleted: false };
      objects.set(input.alias, object);
      return structuredClone(object);
    },
    async commit(input) {
      const object = [...objects.values()].find((candidate) => candidate.handle === input.handle);
      if (!object) throw new Error("object_unavailable");
      if (object.revision !== input.expectedRevision) throw new Error("revision_conflict");
      object.revision += 1;
      object.body = structuredClone(input.body);
      for (const event of input.events) events.push({ ...structuredClone(event), eventId: `ev_${String(events.length + 1).padStart(32, "0")}` });
      return { revision: object.revision, eventIds: input.events.map((_, index) => `ev_${String(events.length - input.events.length + index + 1).padStart(32, "0")}`) };
    },
  };
}

test("City legacy building override copies into the generic object store using only the stable alias", async () => {
  const client = memoryClient();
  const imported = await importLegacyBuildingOverride(client, stableRef, legacy);
  assert.equal(imported.state, "imported");
  assert.deepEqual(imported.model, parseKitModel(legacy.model));
  assert.equal(client.objects.size, 1);
  assert.deepEqual(client.objects.get(stableRef), {
    handle: `ob_${"c".repeat(32)}`, alias: stableRef, schemaVersion: 1, revision: 1,
    body: { schema: "city-building-kit:v1", kitVersion: "session-kit/v1", legacyRevision: 4,
      model: legacy.model, updatedAtMs: legacy.updated_at_ms }, deleted: false,
  });
  assert.equal(Object.hasOwn(client.objects.get(stableRef).body.model.parts[0], "id"), false,
    "internal undefined optional fields must not enter generic JSON storage");
  assert.equal(JSON.stringify([...client.objects.values()]).includes(legacy.asset_ref), false);
});

test("City building override import is idempotent and accepts an identical existing object", async () => {
  const client = memoryClient();
  assert.equal((await importLegacyBuildingOverride(client, stableRef, legacy)).state, "imported");
  assert.equal((await importLegacyBuildingOverride(client, stableRef, legacy)).state, "matched");
  assert.equal(client.objects.size, 1);
});

test("City building overrides resolve stable aliases in batches before importing legacy rows", async () => {
  const client = memoryClient();
  await importLegacyBuildingOverride(client, stableRef, legacy);
  let readCount = 0;
  const batchedClient = {
    ...client,
    async readByAlias(input: { objectType: string; alias: string }) {
      readCount += 1;
      return client.readByAlias(input);
    },
  };
  const resolved = await listCityBuildingObjectsByStableRef(batchedClient, [stableRef]);
  assert.equal(resolved.size, 1);
  assert.equal(readCount, 0);
  assert.equal((await importLegacyBuildingOverride(batchedClient, stableRef, legacy, resolved.get(stableRef))).state, "matched");
  assert.equal(readCount, 0);
  assert.deepEqual(await listCityBuildingObjectsByStableRef(batchedClient, []), new Map());
  await assert.rejects(() => listCityBuildingObjectsByStableRef(batchedClient, ["native-session-id"]), /city_building_stable_ref_invalid/);
});

test("City building override import refuses to overwrite a divergent generic object", async () => {
  const client = memoryClient();
  await importLegacyBuildingOverride(client, stableRef, legacy);
  const object = client.objects.get(stableRef);
  object.body.legacyRevision = 3;
  assert.equal((await importLegacyBuildingOverride(client, stableRef, legacy)).state, "conflict");
  assert.equal(client.objects.get(stableRef).body.legacyRevision, 3);
});

test("City building override import fails closed on invalid identity or body", async () => {
  const client = memoryClient();
  assert.equal((await importLegacyBuildingOverride(client, "native-session-id", legacy)).state, "invalid");
  assert.equal((await importLegacyBuildingOverride(client, stableRef, { ...legacy, asset_ref: "../raw" })).state, "invalid");
  assert.equal((await importLegacyBuildingOverride(client, stableRef, { ...legacy, model: { kit_version: "other", parts: [] } as never })).state, "invalid");
  assert.equal(client.objects.size, 0);
});

test("City building object type stays within the declared generic object namespace", () => {
  assert.equal(CITY_BUILDING_OBJECT_TYPE, "city.building-kit:v1");
});

test("legacy migration payload passes the actual SDK JSON and response contract", async () => {
  const sent: Array<{ operation: string; body?: Record<string, unknown> }> = [];
  const client = createTypedObjectClient("city-test", async (request) => {
    const payload = request.payload as Record<string, unknown>;
    const operation = String(payload.operation);
    sent.push({ operation, body: payload.body as Record<string, unknown> | undefined });
    if (operation === "readAlias") return { version: 1, requestId: request.requestId, ok: false, error: { code: "object_unavailable" } };
    const object = { handle: `ob_${"d".repeat(32)}`, alias: payload.alias as string, schemaVersion: payload.schemaVersion as number,
      revision: 1, body: payload.body as Record<string, unknown>, deleted: false };
    return { version: 1, requestId: request.requestId, ok: true, result: { schema: "plugin-object:v1", object } };
  });
  const result = await importLegacyBuildingOverride(client, stableRef, legacy);
  assert.equal(result.state, "imported");
  assert.deepEqual(sent.map((request) => request.operation), ["readAlias", "create"]);
  assert.equal(Object.hasOwn((sent[1]!.body!.model as any).parts[0], "id"), false);
});

test("generic City object write preserves a separate business revision and emits a typed change event", async () => {
  const client = memoryClient();
  const committed = await commitCityBuildingObject(client, stableRef, 0, legacy.model, "city-edit-1", 1_800_000_000_001);
  assert.deepEqual(committed, { domainRevision: 1, objectRevision: 2, eventId: `ev_${"0".repeat(31)}1` });
  assert.equal(client.objects.get(stableRef).body.domainRevision, 1);
  assert.deepEqual(client.objects.get(stableRef).body.model, JSON.parse(JSON.stringify(parseKitModel(legacy.model))));
  assert.equal(client.events[0].eventType, "city.building.changed");
  assert.equal((await readCityBuildingObject(client, stableRef))?.domainRevision, 1);
});

test("generic City object write migrates legacy domain revisions and preserves reset revisions", async () => {
  const client = memoryClient();
  assert.equal((await importLegacyBuildingOverride(client, stableRef, legacy)).state, "imported");
  const committed = await commitCityBuildingObject(client, stableRef, 4, null, "city-reset-5", 1_800_000_000_002);
  assert.deepEqual(committed, { domainRevision: 5, objectRevision: 2, eventId: `ev_${"0".repeat(31)}1` });
  assert.equal(client.objects.get(stableRef).body.model, null);
  assert.equal(client.objects.get(stableRef).body.domainRevision, 5);
  assert.equal(client.events[0].eventType, "city.building.reset");
  assert.equal((await readCityBuildingObject(client, stableRef))?.domainRevision, 5);
});

test("generic City object CAS rejects stale business revisions without committing", async () => {
  const client = memoryClient();
  await commitCityBuildingObject(client, stableRef, 0, legacy.model, "city-edit-1", 1_800_000_000_001);
  await assert.rejects(() => commitCityBuildingObject(client, stableRef, 0, null, "city-stale-reset", 1_800_000_000_002), /revision_conflict/);
  assert.equal(client.objects.get(stableRef).body.domainRevision, 1);
  assert.equal(client.events.length, 1);
});

test("generic City CAS write obeys the actual SDK operation and bounded event contract", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const sdkClient = createTypedObjectClient("city-test", async (request) => {
    const payload = request.payload as Record<string, unknown>;
    sent.push(payload);
    if (payload.operation === "readAlias") {
      return { version: 1, requestId: request.requestId, ok: false, error: { code: "object_unavailable" } };
    }
    if (payload.operation === "create") {
      return { version: 1, requestId: request.requestId, ok: true, result: { schema: "plugin-object:v1",
        object: { handle: `ob_${"e".repeat(32)}`, alias: payload.alias, schemaVersion: payload.schemaVersion,
          revision: 1, body: payload.body, deleted: false } } };
    }
    assert.equal(payload.operation, "commit");
    return { version: 1, requestId: request.requestId, ok: true,
      result: { schema: "plugin-object:v1", commit: { revision: 2, eventIds: [`ev_${"f".repeat(32)}`] } } };
  });
  const result = await commitCityBuildingObject(sdkClient, stableRef, 0, legacy.model, "city-sdk-edit-1", 1_800_000_000_003);
  assert.equal(result.objectRevision, 2);
  assert.deepEqual(sent.map((payload) => payload.operation), ["readAlias", "create", "commit"]);
  const commit = sent[2]!;
  const event = (commit.events as Array<Record<string, unknown>>)[0]!;
  assert.equal(event.eventType, "city.building.changed");
  assert.deepEqual(event.body, { domainRevision: 1, action: "set", updatedAtMs: 1_800_000_000_003 });
});
