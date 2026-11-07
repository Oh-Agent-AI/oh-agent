import { embedded, invokeHost } from "../../host";
import type { PluginResponseV1 } from "@agent-vitals/app-sdk";
import { SEQUENTIAL_REPLAY_LIBRARY_LIMIT, ReplayStorageError } from "./replayStorage";

export type ReplayRow = { key: string; raw: string };
export interface ReplayBackend {
  list(): Promise<ReplayRow[]>;
  insert(key: string, raw: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export async function nativeReplayRequest(op: "list" | "insert" | "delete", payload: Record<string, unknown> = {}, format?: "sequential-v1") {
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
const sequentialNativeBackend: ReplayBackend = {
  async list() {
    const result = await nativeReplayRequest("list", {}, "sequential-v1");
    if (!Array.isArray(result.entries) || result.entries.some(row => typeof row.key !== "string" || typeof row.raw !== "string")) throw new ReplayStorageError("storage");
    return result.entries;
  },
  async insert(key, raw) { await nativeReplayRequest("insert", { id: key, raw }, "sequential-v1"); },
  async delete(key) { await nativeReplayRequest("delete", { id: key }, "sequential-v1"); },
};
export function sequentialReplayBackend(): ReplayBackend { return embedded() ? sequentialNativeBackend : sequentialPreviewBackend; }
