/** Explicit v1.5 local replay storage; no fallback to transient memory. */
import type { CityMechaSite } from "./citySite";
import type { ReplayBackend } from "./replayBackend";
import { restoreSequentialReplayBundle } from "./sequentialReplayBundle";

const PREFIX = "agent-city:mecha-sequential-replay-entry:v1:";
const SCHEMA = "mecha-sequential-replay-entry:v1";
const fail = (): never => { throw new Error("invalid_sequential_entry"); };
const isKey = (key: string) => /^agent-city:mecha-sequential-replay-entry:v1:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key);
export type SequentialReplayEntry = { key: string; savedAt: string; damaged: boolean };
function parse(raw: string): { schema: typeof SCHEMA; savedAt: string; archive: string } {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > 41_024) return fail();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== 3 || entry.schema !== SCHEMA || typeof entry.savedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.savedAt) || typeof entry.archive !== "string" ||
      new TextEncoder().encode(entry.archive).length > 40_000) return fail();
  return entry as { schema: typeof SCHEMA; savedAt: string; archive: string };
}
async function storage(backend?: ReplayBackend): Promise<ReplayBackend> {
  return backend ?? (await import("./replayBackend")).sequentialReplayBackend();
}
export async function listSequentialReplays(provided?: ReplayBackend): Promise<SequentialReplayEntry[]> {
  const backend = await storage(provided);
  const rows = await backend.list();
  // Foreign/legacy records are not actionable through this repository. Ignore
  // them instead of showing entries that cannot be loaded or deleted.
  return rows.filter(row => isKey(row.key)).map(row => {
    try { return { key: row.key, savedAt: parse(row.raw).savedAt, damaged: false }; }
    catch { return { key: row.key, savedAt: "", damaged: true }; }
  }).sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.key.localeCompare(b.key));
}
export async function saveSequentialReplay(site: CityMechaSite, archive: string, provided?: ReplayBackend): Promise<string> {
  // Verify against the actual site before making any storage request.
  await restoreSequentialReplayBundle(site, archive);
  const key = `${PREFIX}${crypto.randomUUID()}`;
  const raw = JSON.stringify({ schema: SCHEMA, savedAt: new Date().toISOString(), archive });
  parse(raw);
  const backend = await storage(provided);
  await backend.insert(key, raw);
  const rows = await backend.list();
  const saved = rows.filter(row => row.key === key);
  if (saved.length !== 1 || saved[0]!.raw !== raw) throw new Error("sequential_save_unverified");
  return key;
}
export async function loadSequentialReplay(site: CityMechaSite, key: string, provided?: ReplayBackend) {
  if (!isKey(key)) return fail();
  const backend = await storage(provided);
  const rows = await backend.list(), row = rows.find(item => item.key === key);
  if (!row || rows.filter(item => item.key === key).length !== 1) return fail();
  return restoreSequentialReplayBundle(site, parse(row.raw).archive);
}
export async function deleteSequentialReplay(key: string, provided?: ReplayBackend): Promise<void> {
  if (!isKey(key)) return fail();
  const backend = await storage(provided);
  await backend.delete(key);
  if ((await backend.list()).some(row => row.key === key)) throw new Error("sequential_delete_unverified");
}
