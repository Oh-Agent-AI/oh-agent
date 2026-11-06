/** Desktop uses the City-authorized SQLite handler; preview uses origin IndexedDB.
 * Never silently fall back to memory. */
import { embedded, invokeHost } from "../../host";
import type { PluginResponseV1 } from "@agent-vitals/app-sdk";
import { LOCAL_REPLAY_LIBRARY_LIMIT, type ReplayLibraryStorage, ReplayArchiveError } from "./replayArchive";

export type ReplayRow = { key: string; raw: string };
export interface ReplayBackend {
  list(): Promise<ReplayRow[]>;
  insert(key: string, raw: string): Promise<void>;
  delete(key: string): Promise<void>;
}
/** A detached snapshot is not persistence and must never acknowledge a save. */
export class ReplaySnapshot implements ReplayLibraryStorage {
  private entries = new Map<string, string>();
  constructor(rows: ReplayRow[] = []) { for (const row of rows) this.entries.set(row.key, row.raw); }
  get length() { return this.entries.size; }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, value); }
  removeItem(key: string) { this.entries.delete(key); }
}
async function native(op: "list" | "insert" | "delete", payload: Record<string, unknown> = {}) {
  const requestId = `city-replay-${crypto.randomUUID()}`;
  const response = await invokeHost<PluginResponseV1<{ entries?: ReplayRow[] }>>("plugin_request", { request: {
    version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId,
    method: op === "list" ? "plugin.state.read" : "plugin.state.write",
    payload: { key: "mecha-replays:v1", op, ...payload },
  } });
  if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result) {
    throw new ReplayArchiveError(response.error?.code === "replay_full" ? "full" : "storage");
  }
  return response.result;
}
const nativeBackend: ReplayBackend = {
  async list() {
    const result = await native("list");
    if (!Array.isArray(result.entries) || result.entries.some(row => typeof row.key !== "string" || typeof row.raw !== "string")) throw new ReplayArchiveError("storage");
    return result.entries;
  },
  async insert(key, raw) { await native("insert", { id: key, raw }); },
  async delete(key) { await native("delete", { id: key }); },
};
function openPreviewDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("agent-city-mecha-replays", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("replays");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new ReplayArchiveError("storage"));
    request.onblocked = () => reject(new ReplayArchiveError("storage"));
  });
}
const previewBackend: ReplayBackend = {
  async list() {
    const db = await openPreviewDb();
    try {
      return await new Promise<ReplayRow[]>((resolve, reject) => {
        const tx = db.transaction("replays", "readonly");
        const request = tx.objectStore("replays").openCursor();
        const rows: ReplayRow[] = [];
        request.onsuccess = () => { const cursor = request.result; if (cursor) { rows.push({ key: String(cursor.key), raw: String(cursor.value) }); cursor.continue(); } };
        tx.oncomplete = () => resolve(rows);
        tx.onerror = tx.onabort = () => reject(new ReplayArchiveError("storage"));
      });
    } finally { db.close(); }
  },
  async insert(key, raw) {
    const db = await openPreviewDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("replays", "readwrite");
        const store = tx.objectStore("replays");
        let reason: "storage" | "full" = "storage";
        const existing = store.get(key);
        existing.onsuccess = () => {
          if (existing.result !== undefined) { if (existing.result !== raw) tx.abort(); return; }
          const count = store.count();
          count.onsuccess = () => { if (count.result >= LOCAL_REPLAY_LIBRARY_LIMIT) { reason = "full"; tx.abort(); } else store.add(raw, key); };
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new ReplayArchiveError(reason));
      });
    } finally { db.close(); }
  },
  async delete(key) {
    const db = await openPreviewDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("replays", "readwrite");
        tx.objectStore("replays").delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new ReplayArchiveError("storage"));
      });
    } finally { db.close(); }
  },
};
export function replayBackend(): ReplayBackend { return embedded() ? nativeBackend : previewBackend; }
export async function readReplaySnapshot(backend: ReplayBackend): Promise<ReplaySnapshot> { return new ReplaySnapshot(await backend.list()); }
/** Acknowledgment means the committed value was read back successfully. */
export async function commitReplay(backend: ReplayBackend, key: string, raw: string): Promise<ReplaySnapshot> {
  await backend.insert(key, raw);
  const snapshot = await readReplaySnapshot(backend);
  if (snapshot.getItem(key) !== raw) throw new ReplayArchiveError("storage");
  return snapshot;
}

/** Move valid old browser records only after database read-back; leave failures and
 * damaged data untouched. IDs make retries idempotent after a crash. */
export async function migrateLegacyReplays(backend: ReplayBackend, old: Storage): Promise<number> {
  const { listLocalReplays, readLocalReplayEntryArchive, saveLocalReplayEntry, LOCAL_REPLAY_KEY, LOCAL_REPLAY_LIBRARY_PREFIX } = await import("./replayArchive");
  let remaining = 0;
  let entries;
  try { entries = listLocalReplays(old); } catch { return 0; }
  for (const entry of entries) {
    try {
      const raw = old.getItem(entry.key);
      if (raw === null) continue;
      const archive = readLocalReplayEntryArchive(old, entry.key);
      if (!archive || entry.damaged) { remaining++; continue; }
      let key = entry.key;
      let record = raw;
      if (key === LOCAL_REPLAY_KEY) {
        const plans = JSON.parse(archive).plans;
        const temp = new ReplaySnapshot();
        const generated = saveLocalReplayEntry(temp, archive, plans.length);
        const converted = JSON.parse(temp.getItem(generated)!);
        converted.savedAt = "1970-01-01T00:00:00.000Z";
        record = JSON.stringify(converted);
        key = `${LOCAL_REPLAY_LIBRARY_PREFIX}00000000-0000-4000-8000-000000000001`;
      }
      await commitReplay(backend, key, record);
      // Never remove a record that changed during the asynchronous write.
      if (old.getItem(entry.key) === raw) old.removeItem(entry.key); else remaining++;
    } catch { remaining++; }
  }
  return remaining;
}
