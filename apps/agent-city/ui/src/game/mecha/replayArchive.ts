/** Local PvE replay: inputs and hashes only, never a City site or battle snapshot.
 * Rebuild through authoritative rules and compare the complete result before playback. */
import { BOARD, GDD_RULESET, MAX_TURNS, MECH_IDS, type Action, type ArenaPlan, type BossScriptId, type BuildingStake, type Cell, type CoverPresetId, type MatchState, type MechId, type TurnEvent } from "./board";
import { canonicalJson } from "./contracts/match";
import type { CityMechaSite } from "./citySite";
import type { DeployPlacement } from "./deployment";
import { matchFromSite } from "./matchFromSite";
import type { PresentationStages } from "./presentationSnapshot";
import { bossPrepare } from "./rules";
import { pveRules } from "./rules/pve";

export type ReplaySourceRound = { before: MatchState; after: MatchState; plan: ArenaPlan; log: TurnEvent[]; presentationStages: PresentationStages | null };
export type ReplayArchiveSource = {
  site: CityMechaSite; preset: CoverPresetId; script: BossScriptId; stake: BuildingStake;
  deployment: boolean; rounds: ReplaySourceRound[];
};
export type ReplayArchiveErrorCode = "invalid" | "incompatible" | "unavailable" | "storage" | "full" | "changed";
export class ReplayArchiveError extends Error {
  readonly code: ReplayArchiveErrorCode;
  constructor(code: ReplayArchiveErrorCode) { super(code); this.code = code; }
}
type SavedAction = { kind: Action["kind"]; target?: string };
type SavedPlan = { revision: number; items: Array<{ mechId: MechId; moveTo: Cell | null; action: SavedAction }> };
type Archive = {
  schema: "mecha-local-replay:v1"; ruleset: string; siteDigest: string; resultDigest: string;
  preset: CoverPresetId; script: BossScriptId; stake: BuildingStake; deployment: boolean;
  placements: DeployPlacement[]; plans: SavedPlan[];
};
export const LOCAL_REPLAY_MAX_FILE_BYTES = 40_000;
const MAX_BYTES = LOCAL_REPLAY_MAX_FILE_BYTES;
const fail = (code: ReplayArchiveErrorCode): never => { throw new ReplayArchiveError(code); };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const mech = (v: unknown): v is MechId => typeof v === "string" && (MECH_IDS as string[]).includes(v);
const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const cell = (v: unknown): v is Cell => object(v) && keys(v, ["x", "y"]) && integer(v.x) && integer(v.y) && (v.x as number) < BOARD && (v.y as number) < BOARD;
const digestValid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

async function digest(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) return fail("unavailable");
  try {
    const bytes = new TextEncoder().encode(canonicalJson(value));
    const result = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, "0")).join("");
  } catch { return fail("unavailable"); }
}
function parse(raw: string): Archive {
  if (typeof raw !== "string" || raw.length > MAX_BYTES) return fail("invalid");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail("invalid"); }
  if (!object(value) || !keys(value, ["schema", "ruleset", "siteDigest", "resultDigest", "preset", "script", "stake", "deployment", "placements", "plans"])) return fail("invalid");
  if (value.schema !== "mecha-local-replay:v1" || value.ruleset !== GDD_RULESET) return fail("incompatible");
  if (!digestValid(value.siteDigest) || !digestValid(value.resultDigest)
    || typeof value.preset !== "string" || !["covers_sparse_mid", "covers_diag_corridor", "covers_twin_clusters"].includes(value.preset)
    || typeof value.script !== "string" || !["stationary_smash", "cadence_ssw", "raid_ssw", "siege"].includes(value.script)
    || (value.stake !== "all" && value.stake !== "frontage") || typeof value.deployment !== "boolean"
    || !Array.isArray(value.placements) || value.placements.length !== (value.deployment ? 3 : 0)
    || !Array.isArray(value.plans) || value.plans.length < 1 || value.plans.length > MAX_TURNS) return fail("invalid");
  const seen = new Set<string>();
  for (const p of value.placements) {
    if (!object(p) || !keys(p, ["mechId", "pos"]) || !mech(p.mechId) || seen.has(p.mechId) || !cell(p.pos)) return fail("invalid");
    seen.add(p.mechId);
  }
  for (const p of value.plans) {
    if (!object(p) || !keys(p, ["revision", "items"]) || !integer(p.revision) || !Array.isArray(p.items) || p.items.length > 3) return fail("invalid");
    const ids = new Set<string>();
    for (const item of p.items) {
      if (!object(item) || !keys(item, ["mechId", "moveTo", "action"]) || !mech(item.mechId) || ids.has(item.mechId) || (item.moveTo !== null && !cell(item.moveTo)) || !object(item.action)) return fail("invalid");
      ids.add(item.mechId);
      const action = item.action;
      if (typeof action.kind !== "string" || !["skip", "melee", "shoot", "charge", "pierce", "repair"].includes(action.kind)) return fail("invalid");
      if (!keys(action, Object.hasOwn(action, "target") ? ["kind", "target"] : ["kind"])) return fail("invalid");
      if (action.kind === "skip" && Object.hasOwn(action, "target")) return fail("invalid");
      if (action.kind === "repair" && !mech(action.target)) return fail("invalid");
      if (action.kind !== "repair" && Object.hasOwn(action, "target") && (typeof action.target !== "string" || !/^(boss|r(?:0|[1-9][0-9]?))$/.test(action.target))) return fail("invalid");
    }
  }
  return value as Archive;
}
/** Encode raider targets by index, not original site identifiers. */
function encodePlan(plan: ArenaPlan, state: MatchState): SavedPlan {
  return { revision: plan.revision, items: plan.items.map(item => {
    const action = item.action;
    if (action.kind === "skip") return { mechId: item.mechId, moveTo: item.moveTo, action: { kind: "skip" } };
    if (action.kind === "repair") return { mechId: item.mechId, moveTo: item.moveTo, action: { kind: "repair", target: action.target } };
    if (action.target === undefined) return { mechId: item.mechId, moveTo: item.moveTo, action: { kind: action.kind } };
    const index = state.raiders.findIndex(r => r.id === action.target);
    if (action.target !== "boss" && index < 0) return fail("incompatible");
    return { mechId: item.mechId, moveTo: item.moveTo, action: { kind: action.kind, target: action.target === "boss" ? "boss" : `r${index}` } };
  }) };
}
function decodePlan(plan: SavedPlan, state: MatchState): ArenaPlan {
  return { revision: plan.revision, items: plan.items.map(item => {
    const action = item.action;
    if (action.kind === "skip") return { ...item, action: { kind: "skip" } };
    if (action.kind === "repair") return { ...item, action: { kind: "repair", target: action.target as MechId } };
    const target = action.target === undefined || action.target === "boss" ? action.target : state.raiders[Number(action.target.slice(1))]?.id;
    if (action.target !== undefined && target === undefined) return fail("incompatible");
    return { ...item, action: target === undefined ? { kind: action.kind } : { kind: action.kind, target } } as ArenaPlan["items"][number];
  }) };
}
function reconstruct(site: CityMechaSite, archive: Archive): ReplaySourceRound[] {
  let state = matchFromSite(site, archive);
  if (archive.deployment) {
    const deployed = pveRules.deploy!(state, { revision: state.revision, placements: archive.placements });
    if (!deployed.ok) return fail("incompatible");
    state = deployed.state;
  } else if (state.phase === "enemy_prepare") bossPrepare(state);
  const rounds: ReplaySourceRound[] = [];
  for (const saved of archive.plans) {
    if (state.outcome) return fail("incompatible");
    const plan = decodePlan(saved, state);
    const result = pveRules.playTurn(state, plan);
    if (!result.ok) return fail("incompatible");
    rounds.push({ before: state, after: result.state, plan, log: result.log, presentationStages: result.presentationStages });
    state = result.state;
  }
  if (!state.outcome) return fail("incompatible");
  return rounds;
}
const evidence = (rounds: ReplaySourceRound[]) => rounds.map(({ before, after, log, presentationStages }) => ({ before, after, log, presentationStages }));

/** Create a strict archive only after checking the source against a fresh rule run. */
export async function createLocalReplayArchive(source: ReplayArchiveSource): Promise<string> {
  source = structuredClone(source);
  if (!source.site || source.rounds.length < 1 || source.rounds.length > MAX_TURNS || !source.rounds.at(-1)?.after.outcome) return fail("invalid");
  const first = source.rounds[0]!;
  const placements = source.deployment ? first.before.mechs.map(m => ({ mechId: m.id, pos: { ...m.pos } })) : [];
  const archive = parse(JSON.stringify({
    schema: "mecha-local-replay:v1", ruleset: GDD_RULESET, siteDigest: await digest(source.site), resultDigest: "0".repeat(64),
    preset: source.preset, script: source.script, stake: source.stake, deployment: source.deployment,
    placements, plans: source.rounds.map(r => encodePlan(r.plan, r.before)),
  }));
  const rebuilt = reconstruct(source.site, archive);
  const originalDigest = await digest(evidence(source.rounds));
  if (await digest(evidence(rebuilt)) !== originalDigest) return fail("incompatible");
  archive.resultDigest = originalDigest;
  return JSON.stringify(archive);
}
/** Verify site, inputs, outcomes and presentation stages before returning isolated rounds. */
export async function restoreLocalReplayArchive(raw: string, site: CityMechaSite): Promise<ReplaySourceRound[]> {
  site = structuredClone(site);
  const archive = parse(raw);
  if (await digest(site) !== archive.siteDigest) return fail("incompatible");
  const rounds = reconstruct(site, archive);
  if (await digest(evidence(rounds)) !== archive.resultDigest) return fail("incompatible");
  return structuredClone(rounds);
}

/** One explicit local slot. Callers own consent and must not use this for remote matches. */
export const LOCAL_REPLAY_KEY = "agent-city:mecha-local-replay:v1";
export type ReplayStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export async function saveLocalReplay(storage: ReplayStorage, source: ReplayArchiveSource): Promise<void> {
  const archive = await createLocalReplayArchive(source);
  try { storage.setItem(LOCAL_REPLAY_KEY, archive); } catch { fail("storage"); }
}
export async function loadLocalReplay(storage: ReplayStorage, site: CityMechaSite): Promise<ReplaySourceRound[] | null> {
  let raw: string | null;
  try { raw = storage.getItem(LOCAL_REPLAY_KEY); } catch { return fail("storage"); }
  return raw === null ? null : restoreLocalReplayArchive(raw, site);
}
export function deleteLocalReplay(storage: ReplayStorage): void {
  try { storage.removeItem(LOCAL_REPLAY_KEY); } catch { fail("storage"); }
}

/** Separate keys prevent saving a new match from overwriting an older one. */
export const LOCAL_REPLAY_LIBRARY_PREFIX = "agent-city:mecha-local-replay-entry:v1:";
export const LOCAL_REPLAY_LIBRARY_LIMIT = 20;
export type ReplayLibraryStorage = ReplayStorage & Pick<Storage, "key" | "length">;
export type ReplayLibraryEntry = { key: string; savedAt: string | null; turns: number | null; legacy: boolean; damaged: boolean };
type LibraryRecord = { schema: "mecha-local-replay-entry:v1"; savedAt: string; turns: number; archive: string };
const libraryKey = (key: string) => key === LOCAL_REPLAY_KEY || /^agent-city:mecha-local-replay-entry:v1:[0-9a-f-]{36}$/.test(key);
function parseLibraryRecord(raw: string): LibraryRecord {
  if (raw.length > MAX_BYTES + 1024) return fail("invalid");
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return fail("invalid"); }
  if (!object(v) || !keys(v, ["schema", "savedAt", "turns", "archive"]) || v.schema !== "mecha-local-replay-entry:v1"
    || typeof v.savedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.savedAt)
    || !Number.isFinite(Date.parse(v.savedAt)) || !integer(v.turns) || (v.turns as number) < 1 || (v.turns as number) > MAX_TURNS
    || typeof v.archive !== "string" || v.archive.length > MAX_BYTES) return fail("invalid");
  return v as LibraryRecord;
}
export function listLocalReplays(storage: ReplayLibraryStorage): ReplayLibraryEntry[] {
  try {
    const entries: ReplayLibraryEntry[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !libraryKey(key)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      if (key === LOCAL_REPLAY_KEY) { entries.push({ key, savedAt: null, turns: null, legacy: true, damaged: false }); continue; }
      try {
        const record = parseLibraryRecord(raw);
        entries.push({ key, savedAt: record.savedAt, turns: record.turns, legacy: false, damaged: false });
      } catch { entries.push({ key, savedAt: null, turns: null, legacy: false, damaged: true }); }
    }
    return entries.sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? "") || a.key.localeCompare(b.key));
  } catch { return fail("storage"); }
}
/** Archive has already been reconstructed and verified by createLocalReplayArchive. */
export function saveLocalReplayEntry(storage: ReplayLibraryStorage, archive: string, turns: number): string {
  // Reject invalid input before touching storage. Never evict an old entry.
  const parsed = parse(archive);
  if (parsed.plans.length !== turns) return fail("invalid");
  if (listLocalReplays(storage).length >= LOCAL_REPLAY_LIBRARY_LIMIT) return fail("full");
  if (!globalThis.crypto?.randomUUID) return fail("unavailable");
  const key = LOCAL_REPLAY_LIBRARY_PREFIX + globalThis.crypto.randomUUID();
  try {
    if (storage.getItem(key) !== null) return fail("storage");
    const record: LibraryRecord = { schema: "mecha-local-replay-entry:v1", savedAt: new Date().toISOString(), turns, archive };
    storage.setItem(key, JSON.stringify(record));
  } catch (error) { if (error instanceof ReplayArchiveError) throw error; return fail("storage"); }
  return key;
}
/** Read only a structurally valid current-format archive for explicit export. */
export function readLocalReplayEntryArchive(storage: ReplayLibraryStorage, key: string): string | null {
  if (!libraryKey(key)) return fail("invalid");
  let raw: string | null;
  try { raw = storage.getItem(key); } catch { return fail("storage"); }
  if (raw === null) return null;
  const record = key === LOCAL_REPLAY_KEY ? null : parseLibraryRecord(raw);
  const archive = record ? record.archive : raw;
  const parsed = parse(archive);
  if (record && record.turns !== parsed.plans.length) return fail("invalid");
  return archive;
}

/** Avoid accidentally importing the exact same archive twice. Corrupt entries
 * are ignored here, but inaccessible storage remains an explicit error. */
export function findLocalReplayArchive(storage: ReplayLibraryStorage, archive: string): string | null {
  parse(archive);
  for (const entry of listLocalReplays(storage)) {
    try { if (readLocalReplayEntryArchive(storage, entry.key) === archive) return entry.key; }
    catch (error) {
      if (!(error instanceof ReplayArchiveError) || error.code === "storage") throw error;
    }
  }
  return null;
}

/** Import is validated against available sites and the rules before this
 * synchronous write. Existing archives are never overwritten. */
export function saveImportedLocalReplay(storage: ReplayLibraryStorage, archive: string, turns: number): { key: string; existing: boolean } {
  const key = findLocalReplayArchive(storage, archive);
  if (key) return { key, existing: true };
  return { key: saveLocalReplayEntry(storage, archive, turns), existing: false };
}

export async function loadLocalReplayEntry(storage: ReplayLibraryStorage, key: string, site: CityMechaSite): Promise<ReplaySourceRound[] | null> {
  if (!libraryKey(key)) return fail("invalid");
  let raw: string | null;
  try { raw = storage.getItem(key); } catch { return fail("storage"); }
  if (raw === null) return null;
  const archive = key === LOCAL_REPLAY_KEY ? raw : parseLibraryRecord(raw).archive;
  const rounds = await restoreLocalReplayArchive(archive, site);
  // Do not start playback if another tab changed or deleted the selected entry.
  try { if (storage.getItem(key) !== raw) return fail("changed"); } catch (error) { if (error instanceof ReplayArchiveError) throw error; return fail("storage"); }
  return rounds;
}
/** Locate a compatible site without changing the live battle. Candidates are
 * snapshotted before hashing so async verification cannot mix city versions. */
export async function loadLocalReplayEntryForSites<T>(
  storage: ReplayLibraryStorage, key: string, candidates: Array<{ id: T; site: CityMechaSite }>,
): Promise<{ id: T; site: CityMechaSite; rounds: ReplaySourceRound[] } | null> {
  if (!libraryKey(key)) return fail("invalid");
  let raw: string | null;
  try { raw = storage.getItem(key); } catch { return fail("storage"); }
  if (raw === null) return null;
  const archive = key === LOCAL_REPLAY_KEY ? raw : parseLibraryRecord(raw).archive;
  const result = await restoreLocalReplayArchiveForSites(archive, candidates);
  // A different tab may delete or replace the selected entry during verification.
  try { if (storage.getItem(key) !== raw) return fail("changed"); } catch (error) { if (error instanceof ReplayArchiveError) throw error; return fail("storage"); }
  return result;
}

/** The same strict verification is used for untrusted imported files. */
export async function restoreLocalReplayArchiveForSites<T>(
  archive: string, candidates: Array<{ id: T; site: CityMechaSite }>,
): Promise<{ id: T; site: CityMechaSite; rounds: ReplaySourceRound[] }> {
  const parsed = parse(archive);
  const snapshots = candidates.map(candidate => ({ id: candidate.id, site: structuredClone(candidate.site) }));
  let matched: typeof snapshots[number] | undefined;
  for (const candidate of snapshots) {
    if (await digest(candidate.site) === parsed.siteDigest) { matched = candidate; break; }
  }
  if (!matched) return fail("incompatible");
  const rounds = await restoreLocalReplayArchive(archive, matched.site);
  return { id: matched.id, site: matched.site, rounds };
}
export function deleteLocalReplayEntry(storage: ReplayLibraryStorage, key: string): void {
  if (!libraryKey(key)) return fail("invalid");
  try { storage.removeItem(key); } catch { fail("storage"); }
}
