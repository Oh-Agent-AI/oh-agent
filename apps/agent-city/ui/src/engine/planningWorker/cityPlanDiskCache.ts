/**
 * Persist a serialized CityPlan across plugin restarts.
 *
 * createCityPlan for Miami tier 10 is ~34s; the worker transport snapshot is
 * already the disk format (terrain functions are rebuilt by hydratePlanningPlan
 * via buildGeography, not by re-running roads/blocks/sites). plugin.state is
 * capped at 32 KiB, so this uses IndexedDB in the plugin webview (Linux now has
 * a persistent data directory) and an injectable store for Node tests.
 *
 * Cache key includes diskVersion + RADIUS_CALIBRATION_CONFIG.version +
 * planningRequestKey (protocol version, seed, tier, coastal params, work
 * limits). Bump CITY_PLAN_DISK_CACHE.version when the planner algorithm
 * changes without a protocol bump.
 */
import { RADIUS_CALIBRATION_CONFIG } from "../cityPlan";
import { PLANNING_PROTOCOL_VERSION, planningRequestKey, type PlanningParameters, type PlanningPlanSnapshot } from "./planningProtocol";

export const CITY_PLAN_DISK_CACHE = {
  version: 1,
  maxEntries: 8,
  dbName: "agent-city-plan-cache",
  storeName: "plans",
} as const;

export type CityPlanDiskRecord = { key: string; snapshot: PlanningPlanSnapshot; storedAt: number };
export type CityPlanDiskStore = {
  get(key: string): Promise<PlanningPlanSnapshot | null>;
  set(key: string, snapshot: PlanningPlanSnapshot): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
};

export function cityPlanDiskKey(input: PlanningParameters): string {
  return JSON.stringify([CITY_PLAN_DISK_CACHE.version, RADIUS_CALIBRATION_CONFIG.version, planningRequestKey(input)]);
}

export function createMemoryCityPlanStore(): CityPlanDiskStore {
  const entries = new Map<string, CityPlanDiskRecord>();
  const evict = () => {
    while (entries.size > CITY_PLAN_DISK_CACHE.maxEntries) {
      let oldestKey = "", oldestAt = Infinity;
      for (const [key, record] of entries) if (record.storedAt < oldestAt) { oldestKey = key; oldestAt = record.storedAt; }
      entries.delete(oldestKey);
    }
  };
  return {
    async get(key) { return entries.get(key)?.snapshot ?? null; },
    async set(key, snapshot) {
      entries.set(key, { key, snapshot: structuredClone(snapshot), storedAt: Date.now() });
      evict();
    },
    async delete(key) { entries.delete(key); },
    async clear() { entries.clear(); },
  };
}

const noopStore: CityPlanDiskStore = {
  async get() { return null; },
  async set() { /* persistence is optional */ },
  async delete() { /* persistence is optional */ },
  async clear() { /* persistence is optional */ },
};

function requestOf<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("plan-cache-request-failed"));
  });
}

function createIndexedDbStore(): CityPlanDiskStore | null {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) return null;
  const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const request = factory.open(CITY_PLAN_DISK_CACHE.dbName, CITY_PLAN_DISK_CACHE.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CITY_PLAN_DISK_CACHE.storeName))
        db.createObjectStore(CITY_PLAN_DISK_CACHE.storeName, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("plan-cache-open-failed"));
  });
  const withStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> => {
    const db = await open();
    try {
      const tx = db.transaction(CITY_PLAN_DISK_CACHE.storeName, mode);
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error("plan-cache-aborted"));
        tx.onerror = () => reject(tx.error ?? new Error("plan-cache-tx-failed"));
      });
      const value = await run(tx.objectStore(CITY_PLAN_DISK_CACHE.storeName));
      await done;
      return value;
    } finally { db.close(); }
  };
  return {
    async get(key) {
      const record = await withStore("readonly", store => requestOf(store.get(key))) as CityPlanDiskRecord | undefined;
      return record?.snapshot ?? null;
    },
    async set(key, snapshot) {
      await withStore("readwrite", async store => {
        store.put({ key, snapshot, storedAt: Date.now() } satisfies CityPlanDiskRecord);
        const records = await requestOf(store.getAll()) as CityPlanDiskRecord[];
        if (records.length > CITY_PLAN_DISK_CACHE.maxEntries) {
          records.sort((a, b) => a.storedAt - b.storedAt);
          for (const extra of records.slice(0, records.length - CITY_PLAN_DISK_CACHE.maxEntries)) store.delete(extra.key);
        }
      });
    },
    async delete(key) { await withStore("readwrite", store => requestOf(store.delete(key))); },
    async clear() { await withStore("readwrite", store => requestOf(store.clear())); },
  };
}

let installed: CityPlanDiskStore | null = null;
let indexed: CityPlanDiskStore | null | undefined;

function defaultStore(): CityPlanDiskStore {
  if (indexed === undefined) {
    try { indexed = createIndexedDbStore(); }
    catch { indexed = null; }
  }
  return indexed ?? noopStore;
}

function activeStore(): CityPlanDiskStore { return installed ?? defaultStore(); }

/** Tests inject a Map/file backend. `null` restores IndexedDB/no-op. */
export function setCityPlanDiskStore(store: CityPlanDiskStore | null): void { installed = store; }

export async function readCityPlanSnapshot(input: PlanningParameters): Promise<PlanningPlanSnapshot | null> {
  const key = cityPlanDiskKey(input);
  const snapshot = await activeStore().get(key);
  if (!snapshot) return null;
  if (snapshot.version !== PLANNING_PROTOCOL_VERSION || snapshot.requestKey !== planningRequestKey(input)) {
    await activeStore().delete(key).catch(() => { /* stale key is dropped on the next successful write */ });
    return null;
  }
  return snapshot;
}

export async function writeCityPlanSnapshot(input: PlanningParameters, snapshot: PlanningPlanSnapshot): Promise<void> {
  if (snapshot.version !== PLANNING_PROTOCOL_VERSION || snapshot.requestKey !== planningRequestKey(input)) return;
  await activeStore().set(cityPlanDiskKey(input), snapshot);
}

export async function deleteCityPlanSnapshot(input: PlanningParameters): Promise<void> {
  await activeStore().delete(cityPlanDiskKey(input));
}

export async function clearCityPlanDiskCache(): Promise<void> { await activeStore().clear(); }
