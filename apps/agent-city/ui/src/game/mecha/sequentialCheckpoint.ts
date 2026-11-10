/** Versioned local checkpoint adapter. No raw City data is persisted. */
import type { CityMechaSite } from "./citySite";
import type { DeployPlacement } from "./deployment";
import type { MatchState } from "./board";
import type { SequentialDurableStore } from "./sequentialDurable";
import type { SequentialRecord } from "./sequentialTurn";
import type { EnemyPolicy } from "./enemy/contracts";
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
const CHECKPOINT_KEY = "mecha-checkpoint:v1";
type StoredCheckpoint = { schemaVersion: 1; revision: number; raw: string | null };
async function stateRequest(method: "plugin.state.read" | "plugin.state.write", payload: object) {
  const { invokeHost } = await import("../../host");
  const instanceId = window.__AV_PLUGIN_INSTANCE__;
  if (!instanceId) return fail();
  const requestId = `city-checkpoint-${crypto.randomUUID()}`;
  const response = await invokeHost<import("@agent-vitals/app-sdk").PluginResponseV1<{ revision: number; value?: unknown }>>("plugin_request", { request: {
    version: 1, instanceId, requestId, method, payload,
  } });
  if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result) {
    throw new Error(response.error?.code ?? "checkpoint_unavailable");
  }
  return response.result;
}
function storedCheckpoint(value: unknown): Checkpoint | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const state = value as Record<string, unknown>;
  if (Object.keys(state).length !== 3 || state.schemaVersion !== 1 || !validRevision(state.revision)
      || !(state.raw === null || validRaw(state.raw))) return fail();
  return { revision: state.revision, raw: state.raw };
}
async function genericCheckpoint() {
  const state = await stateRequest("plugin.state.read", { key: CHECKPOINT_KEY });
  if (!validRevision(state.revision)) return fail();
  return { storageRevision: state.revision, checkpoint: storedCheckpoint(state.value) };
}
async function readLegacyCheckpoint(): Promise<Checkpoint> {
  const { invokeHost } = await import("../../host");
  const instanceId = window.__AV_PLUGIN_INSTANCE__;
  if (!instanceId) return fail();
  const requestId = `city-legacy-checkpoint-${crypto.randomUUID()}`;
  const response = await invokeHost<import("@agent-vitals/app-sdk").PluginResponseV1<{ revision: number; raw: string | null }>>("plugin_request", { request: {
    version: 1, instanceId, requestId, method: "plugin.state.read",
    payload: { key: "mecha-replays:v1", format: "sequential-checkpoint-v1", op: "read" },
  } });
  if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result) {
    throw new Error(response.error?.code ?? "checkpoint_unavailable");
  }
  return validate(response.result);
}
async function loadCheckpoint(): Promise<{ storageRevision: number; checkpoint: Checkpoint }> {
  let current = await genericCheckpoint();
  if (current.checkpoint) return current as { storageRevision: number; checkpoint: Checkpoint };
  const legacy = await readLegacyCheckpoint();
  try {
    const written = await stateRequest("plugin.state.write", { key: CHECKPOINT_KEY, revision: current.storageRevision,
      value: { schemaVersion: 1, revision: legacy.revision, raw: legacy.raw } });
    if (written.revision !== current.storageRevision + 1) return fail();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "revision_conflict") throw error;
  }
  current = await genericCheckpoint();
  if (!current.checkpoint) return fail();
  return current as { storageRevision: number; checkpoint: Checkpoint };
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
    async read() { return (await loadCheckpoint()).checkpoint; },
    async write(revision, raw) {
      if (!validRevision(revision) || revision >= Number.MAX_SAFE_INTEGER || !(raw === null || validRaw(raw))) return fail();
      const current = await loadCheckpoint();
      if (current.checkpoint.revision !== revision) throw new Error("revision_conflict");
      const written = await stateRequest("plugin.state.write", { key: CHECKPOINT_KEY, revision: current.storageRevision,
        value: { schemaVersion: 1, revision: revision + 1, raw } });
      if (written.revision !== current.storageRevision + 1) return fail();
      return revision + 1;
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
export async function writeSequentialCheckpoint(site: CityMechaSite, evidence: { initial: MatchState; placements: DeployPlacement[]; records: SequentialRecord[]; enemyPolicy?: EnemyPolicy }, backend: CheckpointBackend, version: number): Promise<number> {
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
export function checkpointStore(site: CityMechaSite, opening: { initial: MatchState; placements: DeployPlacement[] }, backend: CheckpointBackend, initialVersion: number, initialMatchRevision: number, enemyPolicy: EnemyPolicy = "baup"): SequentialDurableStore {
  let version = initialVersion, matchRevision = initialMatchRevision;
  const savedSite = structuredClone(site), savedOpening = structuredClone({ initial: opening.initial, placements: opening.placements });
  if (!validRevision(version) || !validRevision(matchRevision)) throw new Error("checkpoint_unavailable");
  return { async commit(expectedRevision, records: readonly SequentialRecord[]) {
    const last = records.at(-1);
    if (expectedRevision !== matchRevision || !last || last.command.revision !== expectedRevision || last.revision !== expectedRevision + 1 ||
        records.some((record, index) => record.command.id !== `c${index}`)) return fail();
    const next = await writeSequentialCheckpoint(savedSite, { ...savedOpening, records: [...records], enemyPolicy }, backend, version);
    version = next; matchRevision = expectedRevision + 1;
  } };
}
