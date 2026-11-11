import { embedded, invokeHost } from "../../host";
import type { PluginResponseV1 } from "@agent-vitals/app-sdk";
import { SEQUENTIAL_REPLAY_LIBRARY_LIMIT, ReplayStorageError } from "./replayStorage";

export type ReplayRow = { key: string; raw: string };
export interface ReplayBackend {
  list(): Promise<ReplayRow[]>;
  insert(key: string, raw: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export async function nativeReplayRequest(op: "list", payload: Record<string, unknown> = {}, format: "sequential-v1" = "sequential-v1") {
  const requestId = `city-replay-${crypto.randomUUID()}`;
  const response = await invokeHost<PluginResponseV1<{ entries?: ReplayRow[] }>>("plugin_request", { request: {
    version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId,
    method: op === "list" ? "plugin.state.read" : "plugin.state.write",
    payload: { key: "mecha-replays:v1", op, ...(format ? { format } : {}), ...payload },
  } });
  if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result) {
    throw new ReplayStorageError(response.error?.code === "replay_full" ? "full" : "storage");
  }
  return response.result;
}
function openPreviewDb(name = "agent-city-mecha-replays"): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("replays");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new ReplayStorageError("storage"));
    request.onblocked = () => reject(new ReplayStorageError("storage"));
  });
}
export function previewBackendFor(name: string): ReplayBackend { return {
  async list() {
    const db = await openPreviewDb(name);
    try {
      return await new Promise<ReplayRow[]>((resolve, reject) => {
        const tx = db.transaction("replays", "readonly");
        const request = tx.objectStore("replays").openCursor();
        const rows: ReplayRow[] = [];
        request.onsuccess = () => { const cursor = request.result; if (cursor) { rows.push({ key: String(cursor.key), raw: String(cursor.value) }); cursor.continue(); } };
        tx.oncomplete = () => resolve(rows);
        tx.onerror = tx.onabort = () => reject(new ReplayStorageError("storage"));
      });
    } finally { db.close(); }
  },
  async insert(key, raw) {
    const db = await openPreviewDb(name);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("replays", "readwrite");
        const store = tx.objectStore("replays");
        let reason: "storage" | "full" = "storage";
        const existing = store.get(key);
        existing.onsuccess = () => {
          if (existing.result !== undefined) { if (existing.result !== raw) tx.abort(); return; }
          const count = store.count();
          count.onsuccess = () => { if (count.result >= SEQUENTIAL_REPLAY_LIBRARY_LIMIT) { reason = "full"; tx.abort(); } else store.add(raw, key); };
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new ReplayStorageError(reason));
      });
    } finally { db.close(); }
  },
  async delete(key) {
    const db = await openPreviewDb(name);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("replays", "readwrite");
        tx.objectStore("replays").delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new ReplayStorageError("storage"));
      });
    } finally { db.close(); }
  },
}; }

const sequentialPreviewBackend = previewBackendFor("agent-city-mecha-sequential-replays");
const REPLAY_OBJECT = "city.mecha-replay:v1";
const REPLAY_SCOPE = "city.mecha-replay-library:v1";
const REPLAY_INDEX_KEY = "mecha-replay-library:v1";
const REPLAY_SCHEMA = "city-mecha-replay-entry:v1";
const REPLAY_PREFIX = "agent-city:mecha-sequential-replay-entry:v1:";
type ReplayPointer = { schemaVersion: 1 | 2; scopeHandle: string };
let nativeBackendCache: { instanceId: string; promise: Promise<ReplayBackend> } | null = null;

async function createNativeReplayBackend(): Promise<ReplayBackend> {
  const instanceId = window.__AV_PLUGIN_INSTANCE__;
  if (!instanceId) throw new ReplayStorageError("storage");
  const [{ createTypedObjectClient }] = await Promise.all([import("@agent-vitals/app-sdk")]);
  const objects = createTypedObjectClient(instanceId, request =>
    invokeHost<PluginResponseV1<import("@agent-vitals/app-sdk").TypedObjectResultV1>>("plugin_request", { request }));
  const requestState = async <T,>(method: "plugin.state.read" | "plugin.state.write", payload: object): Promise<T> => {
    const requestId = `city-replay-index-${crypto.randomUUID()}`;
    const response = await invokeHost<PluginResponseV1<T>>("plugin_request", { request: {
      version: 1, instanceId, requestId, method, payload,
    } });
    if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result) {
      throw new ReplayStorageError("storage");
    }
    return response.result;
  };
  const readPointer = async () => {
    const state = await requestState<{ revision: number; value: unknown }>("plugin.state.read", { key: REPLAY_INDEX_KEY });
    if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new ReplayStorageError("storage");
    if (state.value === null) return { revision: state.revision, value: null as ReplayPointer | null };
    const value = state.value as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
        || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
        || typeof value.scopeHandle !== "string" || !/^sc_[a-f0-9]{32}$/.test(value.scopeHandle)) throw new ReplayStorageError("storage");
    return { revision: state.revision, value: value as ReplayPointer };
  };
  const writePointer = async (revision: number, value: ReplayPointer) => {
    const result = await requestState<{ revision: number }>("plugin.state.write", { key: REPLAY_INDEX_KEY, revision, value });
    if (result.revision !== revision + 1) throw new ReplayStorageError("storage");
  };
  const legacyRows = async (): Promise<ReplayRow[]> => {
    const result = await nativeReplayRequest("list", {}, "sequential-v1");
    if (!Array.isArray(result.entries) || result.entries.length > SEQUENTIAL_REPLAY_LIBRARY_LIMIT
        || result.entries.some(row => !row || typeof row.key !== "string" || typeof row.raw !== "string")) throw new ReplayStorageError("storage");
    return result.entries.filter(row => /^agent-city:mecha-sequential-replay-entry:v1:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.key));
  };
  const ensureEntry = async ({ key, raw }: ReplayRow) => {
    if (new TextEncoder().encode(raw).length > 49_152) throw new ReplayStorageError("storage");
    let existing: Awaited<ReturnType<typeof objects.readByAlias>> | null = null;
    try { existing = await objects.readByAlias({ objectType: REPLAY_OBJECT, alias: key }); }
    catch (error) { if (!(error instanceof Error) || error.message !== "object_unavailable") throw error; }
    if (!existing) {
      return objects.create({ objectType: REPLAY_OBJECT, schemaVersion: 1, alias: key,
        body: { schema: REPLAY_SCHEMA, key, raw }, idempotencyKey: `city-replay-create-${key.slice(REPLAY_PREFIX.length)}` });
    }
    if (existing.schemaVersion !== 1 || existing.deleted || existing.alias !== key || existing.body.schema !== REPLAY_SCHEMA
        || existing.body.key !== key || typeof existing.body.raw !== "string") throw new ReplayStorageError("storage");
    if (existing.body.raw !== raw) {
      await objects.commit({ objectType: REPLAY_OBJECT, handle: existing.handle, expectedRevision: existing.revision,
        body: { schema: REPLAY_SCHEMA, key, raw }, events: [],
        idempotencyKey: `city-replay-update-${key.slice(REPLAY_PREFIX.length)}-${existing.revision + 1}` });
      return objects.read({ objectType: REPLAY_OBJECT, handle: existing.handle });
    }
    return existing;
  };
  const loadLibrary = async () => {
    let pointer = await readPointer();
    if (!pointer.value) {
      const legacy = await legacyRows();
      const created = await objects.commitScope({ scopeType: REPLAY_SCOPE, expectedRevision: 0, members: [],
        idempotencyKey: "city-mecha-replay-library-init-v1" });
      try {
        await writePointer(pointer.revision, { schemaVersion: 1, scopeHandle: created.scopeHandle });
      } catch (error) {
        if (!(error instanceof ReplayStorageError)) throw error;
        pointer = await readPointer();
        if (!pointer.value) throw error;
      }
      if (pointer.value?.schemaVersion === 1) legacy.length && await Promise.all(legacy.map(ensureEntry));
      else if (pointer.value?.schemaVersion === 2) return pointer.value;
      pointer = await readPointer();
    }
    if (!pointer.value) throw new ReplayStorageError("storage");
    if (pointer.value.schemaVersion === 1) {
      // Resume an interrupted copy-forward from the immutable local legacy read path.
      const legacy = await legacyRows();
      const imported = await Promise.all(legacy.map(ensureEntry));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const scope = await objects.readScope({ scopeType: REPLAY_SCOPE, scopeHandle: pointer.value.scopeHandle });
        try {
          await objects.commitScope({ scopeType: REPLAY_SCOPE, scopeHandle: scope.handle, expectedRevision: scope.revision,
            members: imported.map(object => ({ objectType: REPLAY_OBJECT, handle: object.handle })),
            idempotencyKey: `city-mecha-replay-copy-${scope.revision}-${legacy.length}` });
        } catch (error) {
          if (error instanceof Error && error.message === "revision_conflict" && attempt < 2) continue;
          throw error;
        }
        const confirmed = await legacyRows();
        if (confirmed.length !== legacy.length || confirmed.some(row => !legacy.some(item => item.key === row.key && item.raw === row.raw))) {
          throw new ReplayStorageError("storage");
        }
        const latest = await readPointer();
        if (!latest.value) throw new ReplayStorageError("storage");
        if (latest.value.schemaVersion === 2) return latest.value;
        try {
          await writePointer(latest.revision, { schemaVersion: 2, scopeHandle: latest.value.scopeHandle });
          return { schemaVersion: 2 as const, scopeHandle: latest.value.scopeHandle };
        } catch (error) {
          if (attempt === 2 || !(error instanceof ReplayStorageError)) throw error;
        }
      }
      throw new ReplayStorageError("storage");
    }
    return pointer.value;
  };
  const readRows = async (scopeHandle: string) => {
    const scope = await objects.readScope({ scopeType: REPLAY_SCOPE, scopeHandle });
    const members = scope.members.filter(member => member.objectType === REPLAY_OBJECT && !member.deleted);
    if (members.length > SEQUENTIAL_REPLAY_LIBRARY_LIMIT) throw new ReplayStorageError("storage");
    const page = members.length ? await objects.list({ objectType: REPLAY_OBJECT, schemaVersion: 1,
      handles: members.map(member => member.handle), limit: members.length }) : { objects: [], nextCursor: null, hasMore: false };
    if (page.hasMore || page.nextCursor !== null || page.objects.length !== members.length) throw new ReplayStorageError("storage");
    return { scope, rows: page.objects.map(object => {
      if (object.deleted || object.body.schema !== REPLAY_SCHEMA || typeof object.body.key !== "string"
          || typeof object.body.raw !== "string" || object.alias !== object.body.key) throw new ReplayStorageError("storage");
      return { key: object.body.key, raw: object.body.raw };
    }) };
  };
  const removeDetachedEntry = async (key: string) => {
    let object: Awaited<ReturnType<typeof objects.readByAlias>> | null = null;
    try { object = await objects.readByAlias({ objectType: REPLAY_OBJECT, alias: key }); }
    catch (error) { if (error instanceof Error && error.message === "object_unavailable") return; throw error; }
    if (object.schemaVersion !== 1 || object.deleted || object.alias !== key || object.body.schema !== REPLAY_SCHEMA
        || object.body.key !== key || typeof object.body.raw !== "string") throw new ReplayStorageError("storage");
    await objects.delete({ objectType: REPLAY_OBJECT, handle: object.handle, expectedRevision: object.revision,
      idempotencyKey: `city-mecha-replay-delete-${key.slice(REPLAY_PREFIX.length)}-${object.revision + 1}` });
  };
  return {
    async list() { const pointer = await loadLibrary(); return (await readRows(pointer.scopeHandle)).rows; },
    async insert(key, raw) {
      const pointer = await loadLibrary();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { scope, rows } = await readRows(pointer.scopeHandle);
        if (rows.some(row => row.key === key)) return;
        if (rows.length >= SEQUENTIAL_REPLAY_LIBRARY_LIMIT) throw new ReplayStorageError("full");
        const object = await ensureEntry({ key, raw });
        const members = scope.members.filter(member => !member.deleted).map(({ objectType, handle }) => ({ objectType, handle }));
        members.push({ objectType: REPLAY_OBJECT, handle: object.handle });
        try {
          await objects.commitScope({ scopeType: REPLAY_SCOPE, scopeHandle: scope.handle, expectedRevision: scope.revision,
            members, idempotencyKey: `city-mecha-replay-add-${crypto.randomUUID()}` });
          return;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "revision_conflict" || attempt === 2) throw error;
          if (attempt < 2) {
            const latest = await readRows(pointer.scopeHandle);
            if (latest.rows.length >= SEQUENTIAL_REPLAY_LIBRARY_LIMIT && !latest.rows.some(row => row.key === key)) {
              try {
                await objects.delete({ objectType: REPLAY_OBJECT, handle: object.handle, expectedRevision: object.revision,
                  idempotencyKey: `city-mecha-replay-abandon-${key.slice(REPLAY_PREFIX.length)}-${object.revision + 1}` });
              } catch { /* Orphan cleanup is best-effort; scope membership remains authoritative. */ }
              throw new ReplayStorageError("full");
            }
          }
        }
      }
      throw new ReplayStorageError("storage");
    },
    async delete(key) {
      const pointer = await loadLibrary();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { scope, rows } = await readRows(pointer.scopeHandle);
        if (!rows.some(row => row.key === key)) {
          // A previous call may have committed scope removal before object cleanup failed.
          await removeDetachedEntry(key);
          return;
        }
        const object = await objects.readByAlias({ objectType: REPLAY_OBJECT, alias: key });
        const members = scope.members.filter(member => !member.deleted && !(member.objectType === REPLAY_OBJECT && member.handle === object.handle))
          .map(({ objectType, handle }) => ({ objectType, handle }));
        try {
          await objects.commitScope({ scopeType: REPLAY_SCOPE, scopeHandle: scope.handle, expectedRevision: scope.revision,
            members, idempotencyKey: `city-mecha-replay-remove-${crypto.randomUUID()}` });
          try {
            await objects.delete({ objectType: REPLAY_OBJECT, handle: object.handle, expectedRevision: object.revision,
              idempotencyKey: `city-mecha-replay-delete-${key.slice(REPLAY_PREFIX.length)}-${object.revision + 1}` });
          } catch {
            // Scope membership is authoritative. Retry cleanup once; a detached object
            // must not make the UI report that the already-committed deletion failed.
            try { await removeDetachedEntry(key); } catch { /* A later delete retries bounded orphan cleanup. */ }
          }
          return;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "revision_conflict" || attempt === 2) throw error;
        }
      }
      throw new ReplayStorageError("storage");
    },
  };
}
export function sequentialReplayBackend(): ReplayBackend {
  if (!embedded()) return sequentialPreviewBackend;
  const instanceId = window.__AV_PLUGIN_INSTANCE__;
  if (!instanceId) throw new ReplayStorageError("storage");
  if (!nativeBackendCache || nativeBackendCache.instanceId !== instanceId) {
    nativeBackendCache = { instanceId, promise: createNativeReplayBackend() };
  }
  return { list: async () => (await nativeBackendCache!.promise).list(),
    insert: async (key, raw) => (await nativeBackendCache!.promise).insert(key, raw),
    delete: async key => (await nativeBackendCache!.promise).delete(key) };
}
