import assert from "node:assert/strict";
import test from "node:test";
import { createTypedObjectClient } from "../src/object-data.ts";

const HANDLE = `ob_${"a".repeat(32)}`;
const SCOPE_HANDLE = `sc_${"c".repeat(32)}`;
const EVENT_ID = `ev_${"b".repeat(32)}`;
const object = { handle: HANDLE, schemaVersion: 3, revision: 1, body: { city: { name: "梦境" }, rows: [1, true, null] }, deleted: false };
const sendWith = (result, onSend) => async request => {
  onSend?.(request);
  return { version: 1, requestId: request.requestId, ok: true, result: structuredClone(result), error: null };
};

test("create and read use the fixed generic object method and exact operation payloads", async () => {
  let sent;
  const client = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", object }, value => { sent = value; }));
  assert.deepEqual(await client.create({ objectType: "city.scene:v1", schemaVersion: 3, body: object.body, idempotencyKey: "create-city-1" }), object);
  assert.equal(sent.instanceId, "city-instance");
  assert.equal(sent.method, "typed-object.request");
  assert.deepEqual(sent.payload, { version: 1, operation: "create", objectType: "city.scene:v1", schemaVersion: 3,
    body: object.body, idempotencyKey: "create-city-1" });

  const readClient = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", object }, value => { sent = value; }));
  assert.deepEqual(await readClient.read({ objectType: "city.scene:v1", handle: HANDLE }), object);
  assert.deepEqual(sent.payload, { version: 1, operation: "read", objectType: "city.scene:v1", handle: HANDLE });
});

test("create optionally persists an opaque stable alias and readByAlias verifies the returned alias", async () => {
  const alias = "ca_01HF7C8M2X4R6T8V0Y3Z5A7B9C";
  const aliasedObject = { ...object, alias };
  let sent;
  const creator = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", object: aliasedObject }, value => { sent = value; }));
  assert.deepEqual(await creator.create({ objectType: "city.building-kit:v1", schemaVersion: 3, body: object.body,
    idempotencyKey: "import-ca-asset-1", alias }), aliasedObject);
  assert.deepEqual(sent.payload, { version: 1, operation: "create", objectType: "city.building-kit:v1", schemaVersion: 3,
    body: object.body, idempotencyKey: "import-ca-asset-1", alias });

  const reader = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", object: aliasedObject }, value => { sent = value; }));
  assert.deepEqual(await reader.readByAlias({ objectType: "city.building-kit:v1", alias }), aliasedObject);
  assert.deepEqual(sent.payload, { version: 1, operation: "readAlias", objectType: "city.building-kit:v1", alias });

  const mismatched = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", object: { ...aliasedObject, alias: "ca_other" } }));
  await assert.rejects(() => mismatched.readByAlias({ objectType: "city.building-kit:v1", alias }), /typed_object_response_invalid/);
});

test("attachAlias sends a versioned explicit operation and verifies its binding DTO", async () => {
  let sent;
  const binding = { handle: HANDLE, alias: "src_legacy-1" };
  const client = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", aliasBinding: binding }, value => { sent = value; }));
  assert.deepEqual(await client.attachAlias({ objectType: "city.building-kit:v1", handle: HANDLE,
    alias: binding.alias, idempotencyKey: "attach-src-1" }), binding);
  assert.deepEqual(sent.payload, { version: 1, operation: "attachAlias", objectType: "city.building-kit:v1",
    handle: HANDLE, alias: binding.alias, idempotencyKey: "attach-src-1" });

  const mismatched = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1",
    aliasBinding: { handle: `ob_${"d".repeat(32)}`, alias: binding.alias } }));
  await assert.rejects(() => mismatched.attachAlias({ objectType: "city.building-kit:v1", handle: HANDLE,
    alias: binding.alias, idempotencyKey: "attach-src-2" }), /typed_object_response_invalid/);
  await assert.rejects(() => client.attachAlias({ objectType: "city.building-kit:v1", handle: HANDLE,
    alias: "../bad", idempotencyKey: "attach-src-3" }), /typed_object_request_invalid/);
});

test("commit preserves generic event bodies and correlates revision and idempotency key", async () => {
  let sent;
  const commit = { revision: 2, eventIds: [EVENT_ID] };
  const client = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", commit }, value => { sent = value; }));
  const input = { objectType: "city.scene:v1", handle: HANDLE, expectedRevision: 1,
    body: { buildings: [{ id: "opaque-1", position: [2, 7] }] },
    events: [{ eventType: "city.building.moved", body: { from: [1, 7], to: [2, 7] } }], idempotencyKey: "move-1" };
  assert.deepEqual(await client.commit(input), commit);
  assert.deepEqual(sent.payload, { version: 1, operation: "commit", objectType: input.objectType, handle: HANDLE,
    expectedRevision: 1, body: input.body, events: input.events, idempotencyKey: "move-1" });
  const wrongRevision = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", commit: { revision: 1, eventIds: [EVENT_ID] } }));
  await assert.rejects(() => wrongRevision.commit(input), /typed_object_response_invalid/);
});

test("event paging validates cursor, page bounds and event DTO shape", async () => {
  let sent;
  const page = { events: [{ eventId: EVENT_ID, revision: 2, eventType: "city.building.moved",
    body: { to: [2, 7] }, createdAtMs: 1_700_000_000_000 }], nextCursor: EVENT_ID, hasMore: true };
  const client = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", page }, value => { sent = value; }));
  assert.deepEqual(await client.readEvents({ objectType: "city.scene:v1", handle: HANDLE, afterCursor: EVENT_ID, limit: 20 }), page);
  assert.deepEqual(sent.payload, { version: 1, operation: "eventPage", objectType: "city.scene:v1", handle: HANDLE,
    afterCursor: EVENT_ID, limit: 20 });
  const malformed = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", page: { ...page, nextCursor: null } }));
  await assert.rejects(() => malformed.readEvents({ objectType: "city.scene:v1", handle: HANDLE }), /typed_object_response_invalid/);
});

test("client rejects JS-only bodies, oversize values, invalid operation inputs and malformed correlated results", async () => {
  const ok = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", object }));
  await assert.rejects(() => ok.create({ objectType: "city.scene:v1", schemaVersion: 3, body: { bad: undefined }, idempotencyKey: "i1" }), /typed_object_request_invalid/);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(() => ok.create({ objectType: "city.scene:v1", schemaVersion: 3, body: cyclic, idempotencyKey: "i1" }), /typed_object_request_invalid/);
  await assert.rejects(() => ok.create({ objectType: "city.scene:v1", schemaVersion: 3, body: { text: "x".repeat(1024 * 1024) }, idempotencyKey: "i1" }), /typed_object_request_invalid/);
  await assert.rejects(() => ok.create({ objectType: "city.scene:v1", schemaVersion: 3, body: {}, idempotencyKey: "i1", alias: "../escape" }), /typed_object_request_invalid/);
  await assert.rejects(() => ok.create({ objectType: "city.scene:v1", schemaVersion: 3, body: {}, idempotencyKey: "i1", alias: "x".repeat(129) }), /typed_object_request_invalid/);
  await assert.rejects(() => ok.readByAlias({ objectType: "city.scene:v1", alias: "contains whitespace" }), /typed_object_request_invalid/);
  await assert.rejects(() => ok.read({ objectType: "../city", handle: HANDLE }), /typed_object_request_invalid/);
  await assert.rejects(() => ok.readEvents({ objectType: "city.scene:v1", handle: HANDLE, limit: 501 }), /typed_object_request_invalid/);
  const mismatch = createTypedObjectClient("city-instance", async request => ({ version: 1, requestId: "other", ok: true, result: { schema: "plugin-object:v1", object }, error: null }));
  await assert.rejects(() => mismatch.read({ objectType: "city.scene:v1", handle: HANDLE }), /plugin_response_invalid/);
  const extra = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", object: { ...object, native_id: "must-not-pass" } }));
  await assert.rejects(() => extra.read({ objectType: "city.scene:v1", handle: HANDLE }), /typed_object_response_invalid/);
  const malformedAlias = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", object: { ...object, alias: "../private" } }));
  await assert.rejects(() => malformedAlias.read({ objectType: "city.scene:v1", handle: HANDLE }), /typed_object_response_invalid/);
  const unexpectedAlias = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", object: { ...object, alias: "ca_unrequested" } }));
  await assert.rejects(() => unexpectedAlias.create({ objectType: "city.scene:v1", schemaVersion: 3, body: object.body, idempotencyKey: "unaliased" }), /typed_object_response_invalid/);
});

test("object list sends bounded filters and parses tombstones and continuation cursor", async () => {
  let sent;
  const second = { ...object, handle: `ob_${"d".repeat(32)}`, revision: 4, deleted: true };
  const page = { objects: [object, second], nextCursor: second.handle, hasMore: true };
  const client = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", page }, value => { sent = value; }));
  assert.deepEqual(await client.list({ objectType: "city.scene:v1", schemaVersion: 3, afterCursor: HANDLE, limit: 20 }), page);
  assert.deepEqual(sent.payload, { version: 1, operation: "list", objectType: "city.scene:v1", schemaVersion: 3, afterCursor: HANDLE, limit: 20 });
  const invalid = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", page: { ...page, objects: [object], nextCursor: null } }));
  await assert.rejects(() => invalid.list({ objectType: "city.scene:v1", schemaVersion: 3 }), /typed_object_response_invalid/);
});

test("object list can resolve a bounded stable-alias batch without exposing storage selectors", async () => {
  let sent;
  const aliases = ["srp_0123456789abcdef0123456789abcdef", "srp_fedcba9876543210fedcba9876543210"];
  const objects = aliases.map((alias, index) => ({ ...object, handle: `ob_${String(index + 1).repeat(32)}`, alias,
    revision: 1, deleted: false }));
  const page = { objects, nextCursor: null, hasMore: false };
  const client = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", page }, value => { sent = value; }));
  assert.deepEqual(await client.list({ objectType: "city.building-kit:v1", schemaVersion: 3, aliases }), page);
  assert.deepEqual(sent.payload, { version: 1, operation: "list", objectType: "city.building-kit:v1", schemaVersion: 3,
    limit: aliases.length, aliases });
  await assert.rejects(() => client.list({ objectType: "city.building-kit:v1", schemaVersion: 3,
    aliases: [aliases[0], aliases[0]] }), /typed_object_request_invalid/);
  await assert.rejects(() => client.list({ objectType: "city.building-kit:v1", schemaVersion: 3,
    aliases: ["../raw"] }), /typed_object_request_invalid/);
});

test("object list can read a bounded opaque-handle batch without accepting ambiguous filters", async () => {
  let sent;
  const handles = [`ob_${"1".repeat(32)}`, `ob_${"2".repeat(32)}`];
  const objects = handles.map((handle, index) => ({ ...object, handle, schemaVersion: 1, revision: index + 1, deleted: false }));
  const page = { objects, nextCursor: null, hasMore: false };
  const client = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", page }, value => { sent = value; }));
  assert.deepEqual(await client.list({ objectType: "city.asset:v1", schemaVersion: 1, handles }), page);
  assert.deepEqual(sent.payload, { version: 1, operation: "list", objectType: "city.asset:v1", schemaVersion: 1,
    limit: handles.length, handles });
  await assert.rejects(() => client.list({ objectType: "city.asset:v1", schemaVersion: 1,
    handles: [handles[0], handles[0]] }), /typed_object_request_invalid/);
  await assert.rejects(() => client.list({ objectType: "city.asset:v1", schemaVersion: 1,
    aliases: ["ca_abc"], handles }), /typed_object_request_invalid/);
});

test("delete uses compare-and-swap and strict tombstone response", async () => {
  let sent;
  const commit = { revision: 8, deleted: true };
  const client = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", commit }, value => { sent = value; }));
  const input = { objectType: "city.scene:v1", handle: HANDLE, expectedRevision: 7, idempotencyKey: "delete-1" };
  assert.deepEqual(await client.delete(input), commit);
  assert.deepEqual(sent.payload, { version: 1, operation: "delete", ...input });
  const invalid = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", commit: { revision: 8, deleted: false } }));
  await assert.rejects(() => invalid.delete(input), /typed_object_response_invalid/);
});

test("scope read and commit preserve descriptor-neutral membership and revisions", async () => {
  const member = { objectType: "city.scene:v1", handle: HANDLE, revision: 4, deleted: true };
  const scope = { handle: SCOPE_HANDLE, scopeType: "city.workspace:v1", revision: 2, members: [member] };
  let sent;
  const reader = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", scope }, value => { sent = value; }));
  assert.deepEqual(await reader.readScope({ scopeType: scope.scopeType, scopeHandle: SCOPE_HANDLE }), scope);
  assert.deepEqual(sent.payload, { version: 1, operation: "scopeRead", scopeType: scope.scopeType, scopeHandle: SCOPE_HANDLE });

  const commit = { scopeHandle: SCOPE_HANDLE, revision: 3, memberCount: 1 };
  const writer = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", commit }, value => { sent = value; }));
  const input = { scopeType: scope.scopeType, scopeHandle: SCOPE_HANDLE, expectedRevision: 2,
    members: [{ objectType: "city.scene:v1", handle: HANDLE }], idempotencyKey: "scope-save-1" };
  assert.deepEqual(await writer.commitScope(input), commit);
  assert.deepEqual(sent.payload, { version: 1, operation: "scopeCommit", ...input });

  const newScope = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", commit: { scopeHandle: SCOPE_HANDLE, revision: 1, memberCount: 0 } }));
  assert.deepEqual(await newScope.commitScope({ scopeType: scope.scopeType, expectedRevision: 0, members: [], idempotencyKey: "scope-create-1" }),
    { scopeHandle: SCOPE_HANDLE, revision: 1, memberCount: 0 });

  const duplicate = createTypedObjectClient("city-instance", sendWith({ schema: "plugin-object:v1", scope: { ...scope, members: [member, member] } }));
  await assert.rejects(() => duplicate.readScope({ scopeType: scope.scopeType, scopeHandle: SCOPE_HANDLE }), /typed_object_response_invalid/);
  await assert.rejects(() => writer.commitScope({ ...input, members: [input.members[0], input.members[0]] }), /typed_object_request_invalid/);
});
