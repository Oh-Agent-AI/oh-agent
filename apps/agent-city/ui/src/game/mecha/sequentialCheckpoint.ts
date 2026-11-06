/** Versioned local checkpoint adapter. No raw City data is persisted. */
import type { CityMechaSite } from "./citySite";
import type { DeployPlacement } from "./deployment";
import type { MatchState } from "./board";
import type { SequentialDurableStore } from "./sequentialDurable";
import type { SequentialRecord } from "./sequentialTurn";
import { createSequentialReplayBundle, restoreSequentialReplayBundle } from "./sequentialReplayBundle";

export type Checkpoint = { revision: number; raw: string | null };
export type CheckpointBackend = { read(): Promise<Checkpoint>; write(revision: number, raw: string | null): Promise<number> };
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const fail = (): never => { throw new Error("checkpoint_unavailable"); };
function validRaw(raw: unknown): raw is string {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > 41_024) return false;
  try {
    const v = JSON.parse(raw);
    return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 3 && v.schema === "mecha-sequential-replay-entry:v1" &&
      typeof v.savedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.savedAt) &&
      typeof v.archive === "string" && new TextEncoder().encode(v.archive).length <= 40_000;
  } catch { return false; }
}
function validate(value: unknown): Checkpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (!validRevision(v.revision) || !(v.raw === null || validRaw(v.raw))) return fail();
  return { revision: v.revision, raw: v.raw } as Checkpoint;
}
async function native(op: "read" | "write", args: Record<string, unknown> = {}) {
  const { invokeHost } = await import("../../host");
  const requestId = `city-checkpoint-${crypto.randomUUID()}`;
  const response = await invokeHost<import("@agent-vitals/app-sdk").PluginResponseV1<{ revision?: number; raw?: string | null }>>("plugin_request", { request: {
    version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId,
    method: op === "read" ? "plugin.state.read" : "plugin.state.write",
    payload: { key: "mecha-replays:v1", format: "sequential-checkpoint-v1", op, ...args },
  } });
  if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result) return fail();
  return response.result;
}
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("agent-city-mecha-sequential-checkpoint", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("checkpoint");
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(new Error("checkpoint_unavailable"));
  });
}
const browserBackend: CheckpointBackend = {
  async read() {
    const db = await openDb();
    try { return await new Promise<Checkpoint>((resolve, reject) => {
      const tx = db.transaction("checkpoint", "readonly"), get = tx.objectStore("checkpoint").get("current");
      let value: Checkpoint;
      get.onsuccess = () => { try { value = validate(get.result ?? { revision: 0, raw: null }); } catch { tx.abort(); } };
      tx.oncomplete = () => resolve(value); tx.onerror = tx.onabort = () => reject(new Error("checkpoint_unavailable"));
    }); } finally { db.close(); }
  },
  async write(revision, raw) {
    if (!validRevision(revision) || revision >= Number.MAX_SAFE_INTEGER || !(raw === null || validRaw(raw))) return fail();
    const db = await openDb();
    try { return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction("checkpoint", "readwrite"), store = tx.objectStore("checkpoint"), get = store.get("current");
      get.onsuccess = () => {
        try {
          const current = validate(get.result ?? { revision: 0, raw: null });
          if (current.revision !== revision) { tx.abort(); return; }
          store.put({ revision: revision + 1, raw }, "current");
        } catch { tx.abort(); }
      };
      tx.oncomplete = () => resolve(revision + 1); tx.onerror = tx.onabort = () => reject(new Error("checkpoint_unavailable"));
    }); } finally { db.close(); }
  },
};
export async function checkpointBackend(): Promise<CheckpointBackend> {
  const { embedded } = await import("../../host");
  if (!embedded()) return browserBackend;
  return {
    async read() { return validate(await native("read")); },
    async write(revision, raw) {
      if (!validRevision(revision) || revision >= Number.MAX_SAFE_INTEGER || !(raw === null || validRaw(raw))) return fail();
      const result = await native("write", { revision, raw });
      if (result.revision !== revision + 1) return fail();
      return result.revision;
    },
  };
}
export async function readSequentialCheckpoint(site: CityMechaSite, backend: CheckpointBackend) {
  const checkpoint = validate(await backend.read());
  if (checkpoint.raw === null) return { checkpoint, restored: null };
  const entry = JSON.parse(checkpoint.raw) as { archive: string };
  const restored = await restoreSequentialReplayBundle(site, entry.archive);
  return { checkpoint, restored };
}
export async function writeSequentialCheckpoint(site: CityMechaSite, evidence: { initial: MatchState; placements: DeployPlacement[]; records: SequentialRecord[] }, backend: CheckpointBackend, version: number): Promise<number> {
  const archive = await createSequentialReplayBundle(site, evidence);
  const raw = JSON.stringify({ schema: "mecha-sequential-replay-entry:v1", savedAt: new Date().toISOString(), archive });
  if (!validRaw(raw)) return fail();
  const next = await backend.write(version, raw), readback = validate(await backend.read());
  if (next !== version + 1 || readback.revision !== next || readback.raw !== raw) return fail();
  return next;
}
export async function clearSequentialCheckpoint(backend: CheckpointBackend, version: number): Promise<number> {
  const next = await backend.write(version, null), readback = validate(await backend.read());
  if (next !== version + 1 || readback.revision !== next || readback.raw !== null) return fail();
  return next;
}
/** All writes are verified and CAS-protected. On any failure the durable authority freezes. */
export function checkpointStore(site: CityMechaSite, opening: { initial: MatchState; placements: DeployPlacement[] }, backend: CheckpointBackend, initialVersion: number, initialMatchRevision: number): SequentialDurableStore {
  let version = initialVersion, matchRevision = initialMatchRevision;
  const savedSite = structuredClone(site), savedOpening = structuredClone(opening);
  if (!validRevision(version) || !validRevision(matchRevision)) throw new Error("checkpoint_unavailable");
  return { async commit(expectedRevision, records: readonly SequentialRecord[]) {
    const last = records.at(-1);
    if (expectedRevision !== matchRevision || !last || last.command.revision !== expectedRevision || last.revision !== expectedRevision + 1 ||
        records.some((record, index) => record.command.id !== `c${index}`)) return fail();
    const next = await writeSequentialCheckpoint(savedSite, { ...savedOpening, records: [...records] }, backend, version);
    version = next; matchRevision = expectedRevision + 1;
  } };
}
