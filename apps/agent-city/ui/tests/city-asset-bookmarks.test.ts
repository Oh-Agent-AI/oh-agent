import test from "node:test";
import assert from "node:assert/strict";
import {
  CITY_ASSET_OBJECT_TYPE,
  CITY_BOOKMARK_STATE_KEY,
  CITY_SAVE_SCOPE_TYPE,
  createCityAssetBookmarkAdapter,
  ensureCityAssetObject,
  reconcileLegacyCityAssetIdentity,
  type CityAssetBookmarkObjectClient,
  type CityBookmarkStateClient,
  type CityAssetObject,
} from "../src/data/cityAssetBookmarks.ts";

const assetRef = `ca_${"a".repeat(32)}`;
const stableRef = `srp_${"b".repeat(32)}`;

function memoryStore() {
  const objects = new Map<string, CityAssetObject>();
  const aliases = new Map<string, string>();
  const scopes = new Map<string, { handle: string; scopeType: string; revision: number; members: Array<{ objectType: string; handle: string; revision: number; deleted: boolean }> }>();
  const scopeCommits = new Map<string, { scopeHandle: string; revision: number; memberCount: number }>();
  let nextHandle = 0;
  const client: CityAssetBookmarkObjectClient = {
    async create(input) {
      if (aliases.has(input.alias)) throw new Error("alias_conflict");
      const handle = `ob_${String(++nextHandle).padStart(32, "0")}`;
      const object = { handle, alias: input.alias, schemaVersion: input.schemaVersion, revision: 1,
        body: structuredClone(input.body), deleted: false };
      objects.set(handle, object); aliases.set(input.alias, handle);
      return structuredClone(object);
    },
    async read({ handle }) {
      const object = objects.get(handle);
      if (!object) throw new Error("object_unavailable");
      return structuredClone(object);
    },
    async readByAlias({ alias }) {
      const handle = aliases.get(alias);
      const object = handle ? objects.get(handle) : undefined;
      if (!object) throw new Error("object_unavailable");
      return { ...structuredClone(object), alias };
    },
    async list({ handles }) {
      return { objects: handles.flatMap((handle) => objects.has(handle) ? [structuredClone(objects.get(handle)!)] : []),
        nextCursor: null, hasMore: false };
    },
    async attachAlias({ handle, alias }) {
      const current = aliases.get(alias);
      if (current && current !== handle) throw new Error("alias_conflict");
      if (!objects.has(handle)) throw new Error("object_unavailable");
      aliases.set(alias, handle);
      return { handle, alias };
    },
    async commit({ handle, expectedRevision, body }) {
      const object = objects.get(handle);
      if (!object) throw new Error("object_unavailable");
      if (object.revision !== expectedRevision) throw new Error("revision_conflict");
      object.revision += 1;
      object.body = structuredClone(body);
      objects.set(handle, object);
      return { revision: object.revision, eventIds: [] };
    },
    async readScope({ scopeType, scopeHandle }) {
      const scope = scopes.get(scopeHandle);
      if (!scope || scope.scopeType !== scopeType) throw new Error("scope_unavailable");
      return structuredClone(scope);
    },
    async commitScope(input) {
      const prior = scopeCommits.get(input.idempotencyKey);
      if (prior) return structuredClone(prior);
      let scope = input.scopeHandle ? scopes.get(input.scopeHandle) : undefined;
      if (input.scopeHandle && !scope) throw new Error("scope_unavailable");
      if (scope && scope.revision !== input.expectedRevision) throw new Error("revision_conflict");
      if (!scope) {
        scope = { handle: `sc_${"c".repeat(32)}`, scopeType: input.scopeType, revision: 0, members: [] };
      }
      for (const member of input.members) {
        if (!objects.has(member.handle)) throw new Error("member_unavailable");
      }
      scope.revision += 1;
      scope.members = input.members.map(({ objectType, handle }) => ({ objectType, handle,
        revision: objects.get(handle)!.revision, deleted: false }));
      scopes.set(scope.handle, scope);
      const result = { scopeHandle: scope.handle, revision: scope.revision, memberCount: scope.members.length };
      scopeCommits.set(input.idempotencyKey, result);
      return result;
    },
  };
  let stateRevision = 0;
  let stateValue: unknown = null;
  const state: CityBookmarkStateClient = {
    async read() { return { revision: stateRevision, value: structuredClone(stateValue) }; },
    async write(revision, value) {
      if (revision !== stateRevision) throw new Error("revision_conflict");
      stateRevision += 1; stateValue = structuredClone(value);
      return { revision: stateRevision };
    },
  };
  return { client, state, objects, aliases, scopes, get stateValue() { return stateValue; } };
}

test("asset object is opaque, idempotent and indexed by asset and stable source aliases", async () => {
  const store = memoryStore();
  const created = await ensureCityAssetObject(store.client, assetRef, stableRef);
  assert.equal(created.alias, assetRef);
  assert.equal(created.body.schema, "city-asset-ref:v1");
  assert.equal(created.body.assetRef, assetRef);
  assert.equal(created.body.sourceRef, stableRef);
  assert.equal(store.aliases.get(assetRef), created.handle);
  assert.equal(store.aliases.get(stableRef), created.handle);
  assert.equal((await ensureCityAssetObject(store.client, assetRef, stableRef)).handle, created.handle);
  assert.equal(store.objects.size, 1);
  assert.equal(CITY_ASSET_OBJECT_TYPE, "city.asset:v1");
});

test("asset identity refuses to bind one City asset or stable source to a different object", async () => {
  const store = memoryStore();
  await ensureCityAssetObject(store.client, assetRef, stableRef);
  await assert.rejects(() => ensureCityAssetObject(store.client, assetRef, `srp_${"d".repeat(32)}`), /city_asset_identity_conflict/);
  await assert.rejects(() => ensureCityAssetObject(store.client, `ca_${"e".repeat(32)}`, stableRef), /city_asset_identity_conflict/);
  assert.equal(store.objects.size, 1);
});

test("bookmark scope pointer and membership use the generic state, object and scope APIs", async () => {
  const store = memoryStore();
  const bookmarks = createCityAssetBookmarkAdapter(store.client, store.state);
  assert.deepEqual(await bookmarks.read(), []);
  assert.equal((store.stateValue as Record<string, unknown>).schemaVersion, 1);
  assert.equal(CITY_BOOKMARK_STATE_KEY, "city-bookmarks:v1");
  assert.equal((await bookmarks.setBookmarked(assetRef, stableRef, true)).length, 1);
  assert.deepEqual(await bookmarks.read(), [assetRef]);
  assert.deepEqual(await bookmarks.readSources(), [{ assetRef, sourceRef: stableRef }]);
  assert.equal([...store.scopes.values()][0]?.scopeType, CITY_SAVE_SCOPE_TYPE);
  assert.deepEqual(await bookmarks.setBookmarked(assetRef, stableRef, false), []);
  assert.deepEqual(await bookmarks.read(), []);
  assert.equal(store.objects.size, 1, "removing a bookmark unlinks the scope without deleting a reusable asset identity");
});

test("concurrent first reads share one idempotently-created bookmark scope", async () => {
  const store = memoryStore();
  const bookmarks = createCityAssetBookmarkAdapter(store.client, store.state);
  const [first, second] = await Promise.all([bookmarks.read(), bookmarks.read()]);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.equal(store.scopes.size, 1, "racing readers must not orphan a duplicate scope");
});

test("scope CAS preserves unrelated bookmark members", async () => {
  const store = memoryStore();
  const bookmarks = createCityAssetBookmarkAdapter(store.client, store.state);
  await bookmarks.setBookmarked(assetRef, stableRef, true);
  const secondAsset = `ca_${"f".repeat(32)}`;
  const secondStable = `srp_${"e".repeat(32)}`;
  await bookmarks.setBookmarked(secondAsset, secondStable, true);
  assert.deepEqual(new Set(await bookmarks.read()), new Set([assetRef, secondAsset]));
  await bookmarks.setBookmarked(assetRef, stableRef, false);
  assert.deepEqual(await bookmarks.read(), [secondAsset]);
});

test("legacy bookmark migration batches stable-source objects into one generic scope", async () => {
  const store = memoryStore();
  const bookmarks = createCityAssetBookmarkAdapter(store.client, store.state);
  const secondAsset = `ca_${"f".repeat(32)}`;
  const secondStable = `srp_${"e".repeat(32)}`;
  assert.deepEqual(await bookmarks.syncBookmarkedSources([
    { assetRef, stableRef }, { assetRef: secondAsset, stableRef: secondStable },
  ]), [assetRef, secondAsset]);
  assert.deepEqual(await bookmarks.readSources(), [
    { assetRef, sourceRef: stableRef }, { assetRef: secondAsset, sourceRef: secondStable },
  ]);
  assert.equal(store.scopes.size, 1, "the batch creates one save scope for all imported bookmarks");
  await assert.rejects(() => bookmarks.syncBookmarkedSources([
    { assetRef, stableRef }, { assetRef, stableRef: secondStable },
  ]), /city_bookmark_identity_invalid/);
});

test("legacy bookmark scope remains readable after ca to stable-ref crosswalk", async () => {
  const store = memoryStore();
  const bookmarks = createCityAssetBookmarkAdapter(store.client, store.state);
  await bookmarks.setBookmarked(assetRef, undefined, true);
  const before = [...store.scopes.values()][0]!.members[0]!.handle;
  const object = await store.client.readByAlias({ objectType: CITY_ASSET_OBJECT_TYPE, alias: assetRef });
  assert.equal(await reconcileLegacyCityAssetIdentity(store.client, assetRef, stableRef), true);
  await ensureCityAssetObject(store.client, assetRef, stableRef);
  assert.equal(store.aliases.get(stableRef), before);
  assert.equal((await bookmarks.readSources())[0]?.sourceRef, stableRef);
  assert.deepEqual(await bookmarks.read(), [assetRef]);
  assert.equal((await store.client.read({ objectType: CITY_ASSET_OBJECT_TYPE, handle: object.handle })).body.sourceRef, stableRef);
});
