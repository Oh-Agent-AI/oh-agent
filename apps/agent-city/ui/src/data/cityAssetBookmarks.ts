export const CITY_ASSET_OBJECT_TYPE = "city.asset:v1";
export const CITY_SAVE_SCOPE_TYPE = "city.save:v1";
export const CITY_BOOKMARK_STATE_KEY = "city-bookmarks:v1";
const CITY_ASSET_SCHEMA = "city-asset-ref:v1";
const MAX_BOOKMARKS = 200;
const INITIAL_SCOPE_IDEMPOTENCY_KEY = "city-bookmarks-init-v1";

export type CityAssetObject = {
  handle: string; alias?: string; schemaVersion: number; revision: number; body: Record<string, unknown>; deleted: boolean;
};

export type CityAssetBookmarkObjectClient = {
  read(input: { objectType: string; handle: string }): Promise<CityAssetObject>;
  readByAlias(input: { objectType: string; alias: string }): Promise<CityAssetObject>;
  list(input: { objectType: string; schemaVersion: number; handles?: readonly string[]; aliases?: readonly string[] }): Promise<{
    objects: CityAssetObject[]; nextCursor: string | null; hasMore: boolean;
  }>;
  create(input: { objectType: string; schemaVersion: number; body: Record<string, unknown>; alias: string; idempotencyKey: string }): Promise<CityAssetObject>;
  commit(input: { objectType: string; handle: string; expectedRevision: number; body: Record<string, unknown>;
    events: readonly { eventType: string; body: Record<string, unknown> }[]; idempotencyKey: string }): Promise<{ revision: number; eventIds: string[] }>;
  attachAlias(input: { objectType: string; handle: string; alias: string; idempotencyKey: string }): Promise<{ handle: string; alias: string }>;
  readScope(input: { scopeType: string; scopeHandle: string }): Promise<{
    handle: string; scopeType: string; revision: number; members: Array<{ objectType: string; handle: string; revision: number; deleted: boolean }>;
  }>;
  commitScope(input: { scopeType: string; scopeHandle?: string; expectedRevision: number;
    members: readonly { objectType: string; handle: string }[]; idempotencyKey: string }): Promise<{ scopeHandle: string; revision: number; memberCount: number }>;
};

export type CityBookmarkStateClient = {
  read(): Promise<{ revision: number; value: unknown }>;
  write(revision: number, value: { schemaVersion: 1 | 2; scopeHandle: string }): Promise<{ revision: number }>;
};

function validAssetRef(value: string): boolean { return /^ca_[0-9a-f]{32}$/.test(value); }
function validStableRef(value: string): boolean { return /^srp_[a-f0-9]{32}$/.test(value); }
function validHandle(value: unknown): value is string { return typeof value === "string" && /^ob_[a-f0-9]{32}$/.test(value); }
function validScopeHandle(value: unknown): value is string { return typeof value === "string" && /^sc_[a-f0-9]{32}$/.test(value); }
function idempotencyKey(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }

function parseAssetObject(value: CityAssetObject, expectedAssetRef: string, expectedStableRef?: string): CityAssetObject | null {
  if (value.schemaVersion !== 1 || value.deleted || !validHandle(value.handle) || !validAssetRef(expectedAssetRef)
      || !value.body || typeof value.body !== "object" || Array.isArray(value.body)) return null;
  const body = value.body;
  const sourceRef = body.sourceRef;
  if (Object.keys(body).length !== 3 || body.schema !== CITY_ASSET_SCHEMA || body.assetRef !== expectedAssetRef
      || (sourceRef !== null && (typeof sourceRef !== "string" || !validStableRef(sourceRef)))
      || (expectedStableRef !== undefined && sourceRef !== null && sourceRef !== expectedStableRef)) return null;
  return value;
}

/** Resolve stable source refs to preserved legacy asset refs, deriving only identities with no history. */
export async function resolveCityAssetRefsByStableRef(
  client: CityAssetBookmarkObjectClient,
  stableRefs: readonly string[],
): Promise<Map<string, string>> {
  if (!Array.isArray(stableRefs) || stableRefs.length > 4_000
      || stableRefs.some((stableRef) => !validStableRef(stableRef))
      || new Set(stableRefs).size !== stableRefs.length) throw new Error("city_asset_identity_invalid");
  const aliases = [...new Set(stableRefs.flatMap((stableRef) => [stableRef, `ca_${stableRef.slice(4)}`]))];
  const byStableRef = new Map<string, string>();
  const ownerByAssetRef = new Map<string, string | null>();
  for (let offset = 0; offset < aliases.length; offset += 200) {
    const slice = aliases.slice(offset, offset + 200);
    const page = await client.list({ objectType: CITY_ASSET_OBJECT_TYPE, schemaVersion: 1, aliases: slice });
    if (page.hasMore || page.nextCursor !== null || page.objects.length > slice.length) throw new Error("city_asset_identity_invalid");
    for (const object of page.objects) {
      if (object.schemaVersion !== 1 || object.deleted || !validHandle(object.handle) || !Number.isSafeInteger(object.revision)
          || object.revision < 1 || !object.body || typeof object.body !== "object" || Array.isArray(object.body)) {
        throw new Error("city_asset_identity_invalid");
      }
      const body = object.body;
      if (Object.keys(body).length !== 3 || body.schema !== CITY_ASSET_SCHEMA || !validAssetRef(String(body.assetRef))
          || (body.sourceRef !== null && (typeof body.sourceRef !== "string" || !validStableRef(body.sourceRef)))) {
        throw new Error("city_asset_identity_invalid");
      }
      const assetRef = body.assetRef as string;
      const sourceRef = body.sourceRef as string | null;
      const existingOwner = ownerByAssetRef.get(assetRef);
      if (ownerByAssetRef.has(assetRef) && existingOwner !== sourceRef) throw new Error("city_asset_identity_conflict");
      ownerByAssetRef.set(assetRef, sourceRef);
      if (sourceRef !== null) {
        if (!stableRefs.includes(sourceRef) || (byStableRef.has(sourceRef) && byStableRef.get(sourceRef) !== assetRef)) {
          throw new Error("city_asset_identity_conflict");
        }
        byStableRef.set(sourceRef, assetRef);
      }
    }
  }
  for (const stableRef of stableRefs) {
    if (byStableRef.has(stableRef)) continue;
    const candidate = `ca_${stableRef.slice(4)}`;
    if (ownerByAssetRef.has(candidate) && ownerByAssetRef.get(candidate) !== stableRef) throw new Error("city_asset_identity_conflict");
    byStableRef.set(stableRef, candidate);
  }
  return byStableRef;
}

/** Persist a durable legacy asset reference before, or after, its session crosswalk is known. */
export async function ensureCityAssetObject(
  client: CityAssetBookmarkObjectClient,
  assetRef: string,
  stableRef?: string,
): Promise<CityAssetObject> {
  if (!validAssetRef(assetRef) || (stableRef !== undefined && !validStableRef(stableRef))) throw new Error("city_asset_identity_invalid");
  let object: CityAssetObject | null = null;
  try { object = await client.readByAlias({ objectType: CITY_ASSET_OBJECT_TYPE, alias: assetRef }); }
  catch (error) { if (!(error instanceof Error) || error.message !== "object_unavailable") throw error; }
  if (object && !parseAssetObject(object, assetRef, stableRef)) throw new Error("city_asset_identity_conflict");
  if (!object && stableRef) {
    try { object = await client.readByAlias({ objectType: CITY_ASSET_OBJECT_TYPE, alias: stableRef }); }
    catch (error) { if (!(error instanceof Error) || error.message !== "object_unavailable") throw error; }
    if (object && !parseAssetObject(object, assetRef, stableRef)) throw new Error("city_asset_identity_conflict");
  }
  if (!object) {
    try {
      object = await client.create({ objectType: CITY_ASSET_OBJECT_TYPE, schemaVersion: 1,
        alias: assetRef, body: { schema: CITY_ASSET_SCHEMA, assetRef, sourceRef: stableRef ?? null },
        idempotencyKey: `city-asset-create-${assetRef}` });
    } catch (createError) {
      if (!(createError instanceof Error) || !["alias_conflict", "idempotency_conflict"].includes(createError.message)) throw createError;
      object = await client.readByAlias({ objectType: CITY_ASSET_OBJECT_TYPE, alias: assetRef });
      if (!parseAssetObject(object, assetRef, stableRef)) throw new Error("city_asset_identity_conflict");
    }
  }
  if (!object || !parseAssetObject(object, assetRef, stableRef)) throw new Error("city_asset_object_invalid");
  if (stableRef) {
    try {
      await client.attachAlias({ objectType: CITY_ASSET_OBJECT_TYPE, handle: object.handle, alias: stableRef,
        idempotencyKey: `city-asset-source-${assetRef}` });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "alias_conflict") throw error;
      const bound = await client.readByAlias({ objectType: CITY_ASSET_OBJECT_TYPE, alias: stableRef });
      if (bound.handle !== object.handle || !parseAssetObject(bound, assetRef, stableRef)) throw new Error("city_asset_identity_conflict");
    }
    if (object.body.sourceRef === null) {
      const commit = await client.commit({ objectType: CITY_ASSET_OBJECT_TYPE, handle: object.handle, expectedRevision: object.revision,
        body: { schema: CITY_ASSET_SCHEMA, assetRef, sourceRef: stableRef }, events: [],
        idempotencyKey: `city-asset-crosswalk-${assetRef}-${stableRef}` });
      if (commit.revision !== object.revision + 1 || commit.eventIds.length !== 0) throw new Error("city_asset_object_invalid");
      object = await client.read({ objectType: CITY_ASSET_OBJECT_TYPE, handle: object.handle });
      if (!parseAssetObject(object, assetRef, stableRef) || object.body.sourceRef !== stableRef) throw new Error("city_asset_identity_conflict");
    }
  }
  return object;
}

/** Preserve an observed pre-generic asset id when the v3 migration bridge
 * supplies its session mapping. Existing scopes point at the object handle, so
 * changing the object's identity body keeps their membership intact. */
export async function reconcileLegacyCityAssetIdentity(
  client: CityAssetBookmarkObjectClient,
  legacyAssetRef: string,
  stableRef: string,
  known?: { byStable: CityAssetObject | null; byLegacy: CityAssetObject | null },
): Promise<boolean> {
  if (!validAssetRef(legacyAssetRef) || !validStableRef(stableRef)) throw new Error("city_asset_identity_invalid");
  let byStable: CityAssetObject | null = known?.byStable ?? null;
  let byLegacy: CityAssetObject | null = known?.byLegacy ?? null;
  if (!known) {
    try { byStable = await client.readByAlias({ objectType: CITY_ASSET_OBJECT_TYPE, alias: stableRef }); }
    catch (error) { if (!(error instanceof Error) || error.message !== "object_unavailable") throw error; }
    try { byLegacy = await client.readByAlias({ objectType: CITY_ASSET_OBJECT_TYPE, alias: legacyAssetRef }); }
    catch (error) { if (!(error instanceof Error) || error.message !== "object_unavailable") throw error; }
  }
  if (!byStable && !byLegacy) return false;
  if (byStable && byLegacy && byStable.handle !== byLegacy.handle) throw new Error("city_asset_identity_conflict");
  let object = byStable ?? byLegacy!;
  if (object.schemaVersion !== 1 || object.deleted || !validHandle(object.handle)
      || !Number.isSafeInteger(object.revision) || object.revision < 1
      || !object.body || typeof object.body !== "object" || Array.isArray(object.body)) throw new Error("city_asset_identity_conflict");
  const body = object.body;
  if (Object.keys(body).length !== 3 || body.schema !== CITY_ASSET_SCHEMA
      || typeof body.assetRef !== "string" || !validAssetRef(body.assetRef)
      || (body.sourceRef !== null && (typeof body.sourceRef !== "string" || !validStableRef(body.sourceRef)))) {
    throw new Error("city_asset_identity_conflict");
  }
  if (body.sourceRef !== null && body.sourceRef !== stableRef) throw new Error("city_asset_identity_conflict");
  if (body.assetRef !== legacyAssetRef && body.assetRef !== `ca_${stableRef.slice(4)}`) throw new Error("city_asset_identity_conflict");
  if (byLegacy && byLegacy.handle !== object.handle) throw new Error("city_asset_identity_conflict");
  if (body.assetRef !== legacyAssetRef || body.sourceRef !== stableRef) {
    const committed = await client.commit({ objectType: CITY_ASSET_OBJECT_TYPE, handle: object.handle,
      expectedRevision: object.revision,
      body: { schema: CITY_ASSET_SCHEMA, assetRef: legacyAssetRef, sourceRef: stableRef }, events: [],
      idempotencyKey: `city-asset-legacy-crosswalk-${legacyAssetRef}-${stableRef}` });
    if (committed.revision !== object.revision + 1 || committed.eventIds.length !== 0) throw new Error("city_asset_identity_invalid");
    object = await client.read({ objectType: CITY_ASSET_OBJECT_TYPE, handle: object.handle });
  }
  if (!parseAssetObject(object, legacyAssetRef, stableRef) || object.body.sourceRef !== stableRef) throw new Error("city_asset_identity_conflict");
  for (const [alias, present, suffix] of [[legacyAssetRef, byLegacy, "legacy"], [stableRef, byStable, "stable"]] as const) {
    if (present) continue;
    try {
      await client.attachAlias({ objectType: CITY_ASSET_OBJECT_TYPE, handle: object.handle, alias,
        idempotencyKey: `city-asset-${suffix}-alias-${legacyAssetRef}-${stableRef}` });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "alias_conflict") throw error;
      const bound = await client.readByAlias({ objectType: CITY_ASSET_OBJECT_TYPE, alias });
      if (bound.handle !== object.handle || !parseAssetObject(bound, legacyAssetRef, stableRef)) throw new Error("city_asset_identity_conflict");
    }
  }
  return true;
}

/** Reconcile only crosswalks for which a generic asset object already exists. */
export async function reconcileLegacyCityAssetIdentities(
  client: CityAssetBookmarkObjectClient,
  pairs: readonly { legacyAssetRef: string; stableRef: string }[],
): Promise<number> {
  if (!Array.isArray(pairs) || pairs.length > 4_000) throw new Error("city_asset_identity_invalid");
  const unique = new Map<string, { legacyAssetRef: string; stableRef: string }>();
  const stableByLegacy = new Map<string, string>();
  const legacyByStable = new Map<string, string>();
  for (const pair of pairs) {
    if (!pair || !validAssetRef(pair.legacyAssetRef) || !validStableRef(pair.stableRef)) throw new Error("city_asset_identity_invalid");
    if ((stableByLegacy.has(pair.legacyAssetRef) && stableByLegacy.get(pair.legacyAssetRef) !== pair.stableRef)
        || (legacyByStable.has(pair.stableRef) && legacyByStable.get(pair.stableRef) !== pair.legacyAssetRef)) {
      throw new Error("city_asset_identity_conflict");
    }
    stableByLegacy.set(pair.legacyAssetRef, pair.stableRef);
    legacyByStable.set(pair.stableRef, pair.legacyAssetRef);
    const key = `${pair.legacyAssetRef}\0${pair.stableRef}`;
    unique.set(key, pair);
  }
  const values = [...unique.values()];
  let reconciled = 0;
  for (let offset = 0; offset < values.length; offset += 60) {
    const slice = values.slice(offset, offset + 60);
    const assetAliasOwner = new Map<string, string>();
    for (const pair of slice) {
      for (const alias of [pair.legacyAssetRef, `ca_${pair.stableRef.slice(4)}`]) {
        const owner = assetAliasOwner.get(alias);
        if (owner && owner !== pair.stableRef) throw new Error("city_asset_identity_conflict");
        assetAliasOwner.set(alias, pair.stableRef);
      }
    }
    const aliases = [...new Set(slice.flatMap((pair) => [pair.legacyAssetRef, pair.stableRef, `ca_${pair.stableRef.slice(4)}`]))];
    const page = await client.list({ objectType: CITY_ASSET_OBJECT_TYPE, schemaVersion: 1, aliases });
    if (page.hasMore || page.nextCursor !== null || page.objects.length > aliases.length) throw new Error("city_asset_identity_invalid");
    const assetAliases = new Set(slice.map((pair) => pair.legacyAssetRef));
    const candidateAliases = new Set(slice.map((pair) => `ca_${pair.stableRef.slice(4)}`));
    const stableAliases = new Set(slice.map((pair) => pair.stableRef));
    const derivedStableByAsset = new Map(slice.map((pair) => [`ca_${pair.stableRef.slice(4)}`, pair.stableRef]));
    const byAssetRef = new Map<string, CityAssetObject>();
    const byStableRef = new Map<string, CityAssetObject>();
    for (const object of page.objects) {
      const assetRef = object.body?.assetRef;
      const sourceRef = object.body?.sourceRef;
      if (object.schemaVersion !== 1 || object.deleted || !validHandle(object.handle)
          || !Number.isSafeInteger(object.revision) || object.revision < 1
          || object.body?.schema !== CITY_ASSET_SCHEMA || typeof assetRef !== "string" || !validAssetRef(assetRef)
          || (sourceRef !== null && (typeof sourceRef !== "string" || !validStableRef(sourceRef)))
          || (!assetAliases.has(assetRef) && !candidateAliases.has(assetRef)
            && !(typeof sourceRef === "string" && stableAliases.has(sourceRef)))) {
        throw new Error("city_asset_identity_invalid");
      }
      if (assetAliases.has(assetRef)) {
        if (byAssetRef.has(assetRef)) throw new Error("city_asset_identity_invalid");
        byAssetRef.set(assetRef, object);
      }
      if (typeof sourceRef === "string" && stableAliases.has(sourceRef)) {
        if (byStableRef.has(sourceRef)) throw new Error("city_asset_identity_invalid");
        byStableRef.set(sourceRef, object);
      } else if (sourceRef === null && derivedStableByAsset.has(assetRef)) {
        const stableRef = derivedStableByAsset.get(assetRef)!;
        if (byStableRef.has(stableRef)) throw new Error("city_asset_identity_invalid");
        byStableRef.set(stableRef, object);
      }
    }
    for (const pair of slice) {
      const byStable = byStableRef.get(pair.stableRef) ?? null;
      const byLegacy = byAssetRef.get(pair.legacyAssetRef) ?? null;
      if (byStable || byLegacy) {
        if (await reconcileLegacyCityAssetIdentity(client, pair.legacyAssetRef, pair.stableRef, { byStable, byLegacy })) reconciled += 1;
      }
    }
  }
  return reconciled;
}

export function createCityAssetBookmarkAdapter(
  objects: CityAssetBookmarkObjectClient,
  state: CityBookmarkStateClient,
) {
  async function loadScope() {
    const pointer = await state.read();
    if (!Number.isSafeInteger(pointer.revision) || pointer.revision < 0) throw new Error("city_bookmark_state_invalid");
    if (pointer.value !== null && pointer.value !== undefined) {
      const value = pointer.value as Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
          || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || !validScopeHandle(value.scopeHandle)) throw new Error("city_bookmark_state_invalid");
      return { pointerRevision: pointer.revision, authoritative: value.schemaVersion === 2,
        scope: await objects.readScope({ scopeType: CITY_SAVE_SCOPE_TYPE, scopeHandle: value.scopeHandle }) };
    }
    const created = await objects.commitScope({ scopeType: CITY_SAVE_SCOPE_TYPE, expectedRevision: 0, members: [],
      idempotencyKey: INITIAL_SCOPE_IDEMPOTENCY_KEY });
    try {
      const written = await state.write(pointer.revision, { schemaVersion: 1, scopeHandle: created.scopeHandle });
      if (written.revision !== pointer.revision + 1) throw new Error("city_bookmark_state_invalid");
      return { pointerRevision: written.revision, authoritative: false,
        scope: await objects.readScope({ scopeType: CITY_SAVE_SCOPE_TYPE, scopeHandle: created.scopeHandle }) };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "revision_conflict") throw error;
      const winner = await state.read();
      const value = winner.value as Record<string, unknown> | null;
      if (!value || typeof value !== "object" || Array.isArray(value)
          || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || !validScopeHandle(value.scopeHandle)) throw new Error("city_bookmark_state_invalid");
      return { pointerRevision: winner.revision, authoritative: value.schemaVersion === 2,
        scope: await objects.readScope({ scopeType: CITY_SAVE_SCOPE_TYPE, scopeHandle: value.scopeHandle }) };
    }
  }

  async function readAssets(scope: Awaited<ReturnType<typeof loadScope>>["scope"]) {
    const members = scope.members.filter((member) => member.objectType === CITY_ASSET_OBJECT_TYPE && !member.deleted);
    if (members.length > MAX_BOOKMARKS) throw new Error("city_bookmark_scope_invalid");
    const page = members.length ? await objects.list({ objectType: CITY_ASSET_OBJECT_TYPE, schemaVersion: 1,
      handles: members.map((member) => member.handle) }) : { objects: [], nextCursor: null, hasMore: false };
    if (page.hasMore || page.nextCursor !== null || page.objects.length !== members.length) throw new Error("city_bookmark_scope_invalid");
    const byHandle = new Map(page.objects.map((object) => [object.handle, object]));
    const assets: Array<{ handle: string; assetRef: string; sourceRef: string | null }> = [];
    for (const member of members) {
      const object = byHandle.get(member.handle);
      if (!object) throw new Error("city_bookmark_scope_invalid");
      const assetRef = object.body?.assetRef;
      const sourceRef = object.body?.sourceRef;
      if (object.schemaVersion !== 1 || object.deleted || object.body?.schema !== CITY_ASSET_SCHEMA
          || typeof assetRef !== "string" || !validAssetRef(assetRef)
          || (sourceRef !== null && (typeof sourceRef !== "string" || !validStableRef(sourceRef)))) {
        throw new Error("city_bookmark_asset_invalid");
      }
      assets.push({ handle: member.handle, assetRef, sourceRef });
    }
    if (new Set(assets.map((asset) => asset.assetRef)).size !== assets.length) throw new Error("city_bookmark_scope_invalid");
    return assets;
  }

  async function readRefs(scope: Awaited<ReturnType<typeof loadScope>>["scope"]): Promise<string[]> {
    return (await readAssets(scope)).map((asset) => asset.assetRef);
  }

  async function snapshot(): Promise<{ refs: string[]; authoritative: boolean }> {
    const loaded = await loadScope();
    return { refs: await readRefs(loaded.scope), authoritative: loaded.authoritative };
  }

  async function read(): Promise<string[]> { return (await snapshot()).refs; }

  async function markAuthoritative(): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pointer = await state.read();
      if (!Number.isSafeInteger(pointer.revision) || pointer.revision < 0) throw new Error("city_bookmark_state_invalid");
      const value = pointer.value as Record<string, unknown> | null;
      if (!value || typeof value !== "object" || Array.isArray(value)
          || !validScopeHandle(value.scopeHandle) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) return false;
      if (value.schemaVersion === 2) return true;
      try {
        const written = await state.write(pointer.revision, { schemaVersion: 2, scopeHandle: value.scopeHandle });
        if (written.revision !== pointer.revision + 1) throw new Error("city_bookmark_state_invalid");
        return true;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "revision_conflict" || attempt === 2) throw error;
      }
    }
    return false;
  }

  async function readSources(): Promise<Array<{ assetRef: string; sourceRef: string }>> {
    const { scope } = await loadScope();
    return (await readAssets(scope)).flatMap(({ assetRef, sourceRef }) => sourceRef ? [{ assetRef, sourceRef }] : []);
  }

  async function setBookmarked(assetRef: string, stableRef: string | undefined, bookmarked: boolean): Promise<string[]> {
    if (!validAssetRef(assetRef) || (stableRef !== undefined && !validStableRef(stableRef))) throw new Error("city_bookmark_identity_invalid");
    const object = bookmarked ? await ensureCityAssetObject(objects, assetRef, stableRef) : null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { scope } = await loadScope();
      const currentAssets = await readAssets(scope);
      const currentRefs = currentAssets.map((asset) => asset.assetRef);
      const byHandle = new Map(currentAssets.map((asset) => [asset.handle, asset.assetRef]));
      if (bookmarked && currentRefs.includes(assetRef)) return currentRefs;
      if (!bookmarked && !currentRefs.includes(assetRef)) return currentRefs;
      const members = scope.members.filter((member) => member.objectType !== CITY_ASSET_OBJECT_TYPE || member.deleted
        || byHandle.get(member.handle) !== assetRef)
        .map(({ objectType, handle }) => ({ objectType, handle }));
      if (bookmarked && object) members.push({ objectType: CITY_ASSET_OBJECT_TYPE, handle: object.handle });
      if (members.length > MAX_BOOKMARKS) throw new Error("city_bookmark_limit");
      try {
        await objects.commitScope({ scopeType: CITY_SAVE_SCOPE_TYPE, scopeHandle: scope.handle, expectedRevision: scope.revision,
          members, idempotencyKey: idempotencyKey("city-bookmarks-commit") });
        return bookmarked ? [...currentRefs, assetRef] : currentRefs.filter((ref) => ref !== assetRef);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "revision_conflict" || attempt === 2) throw error;
      }
    }
    throw new Error("city_bookmark_conflict");
  }

  async function syncBookmarkedSources(items: readonly { assetRef: string; stableRef?: string }[]): Promise<string[]> {
    if (!Array.isArray(items) || items.length > MAX_BOOKMARKS
        || items.some((item) => !item || !validAssetRef(item.assetRef) || (item.stableRef !== undefined && !validStableRef(item.stableRef)))
        || new Set(items.map((item) => item.assetRef)).size !== items.length
        || new Set(items.flatMap((item) => item.stableRef ? [item.stableRef] : [])).size !== items.filter((item) => item.stableRef).length) throw new Error("city_bookmark_identity_invalid");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { scope } = await loadScope();
      const currentAssets = await readAssets(scope);
      const currentRefs = currentAssets.map((asset) => asset.assetRef);
      const currentByAsset = new Map(currentAssets.map((asset) => [asset.assetRef, asset]));
      const needsObject = items.filter((item) => {
        const current = currentByAsset.get(item.assetRef);
        return !current || (item.stableRef !== undefined && current.sourceRef !== item.stableRef);
      });
      const ensured: CityAssetObject[] = [];
      for (let offset = 0; offset < needsObject.length; offset += 8) {
        const batch = await Promise.all(needsObject.slice(offset, offset + 8).map(({ assetRef, stableRef }) =>
          ensureCityAssetObject(objects, assetRef, stableRef)));
        ensured.push(...batch);
      }
      const handleByAsset = new Map(currentAssets.map((asset) => [asset.assetRef, asset.handle]));
      for (let index = 0; index < needsObject.length; index += 1) {
        handleByAsset.set(needsObject[index]!.assetRef, ensured[index]!.handle);
      }
      const wantedHandles = new Set(ensured.map((object) => object.handle));
      for (const item of items) {
        const handle = handleByAsset.get(item.assetRef);
        if (!handle) throw new Error("city_bookmark_asset_invalid");
        wantedHandles.add(handle);
      }
      const currentHandles = new Set(currentAssets.map((asset) => asset.handle));
      if (wantedHandles.size === currentHandles.size && [...wantedHandles].every((handle) => currentHandles.has(handle))) return currentRefs;
      const members = scope.members.filter((member) => member.objectType !== CITY_ASSET_OBJECT_TYPE || member.deleted)
        .map(({ objectType, handle }) => ({ objectType, handle }));
      members.push(...ensured.map((object) => ({ objectType: CITY_ASSET_OBJECT_TYPE, handle: object.handle })));
      if (members.length > MAX_BOOKMARKS) throw new Error("city_bookmark_limit");
      try {
        await objects.commitScope({ scopeType: CITY_SAVE_SCOPE_TYPE, scopeHandle: scope.handle, expectedRevision: scope.revision,
          members, idempotencyKey: idempotencyKey("city-bookmarks-import") });
        return items.map((item) => item.assetRef);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "revision_conflict" || attempt === 2) throw error;
      }
    }
    throw new Error("city_bookmark_conflict");
  }

  return { read, snapshot, markAuthoritative, readSources, setBookmarked, syncBookmarkedSources };
}
