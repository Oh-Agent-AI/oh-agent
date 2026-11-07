/** Local v1.5 replay envelope: deterministic opening inputs and verified commands only. */
import { BOARD, MECH_IDS, type Cell, type MatchState, type MechId } from "./board";
import { canonicalJson } from "./contracts/match";
import type { CityMechaSite } from "./citySite";
import { applyDeployPlan, type DeployPlacement } from "./deployment";
import { matchFromSite } from "./matchFromSite";
import { createSequentialArchive, replaySequentialArchive } from "./sequentialReplay";
import type { SequentialRecord, SequentialTurn } from "./sequentialTurn";

const SCHEMA = "mecha-sequential-bundle:v1";
const STATUS_SCHEMA = "mecha-sequential-bundle:v2";
const MAX_BYTES = 40_000;
import { isStatusSpecies, type StatusMonsterId } from "./monsters/catalog";
export type { StatusMonsterId };
type Opening = { preset: "covers_sparse_mid"; script: "siege"; placements: DeployPlacement[]; encounter?: { speciesId: StatusMonsterId; contentVersion: 1; statusRules: "mecha-status-encounter:v1" } };
type Bundle = { schema: typeof SCHEMA | typeof STATUS_SCHEMA; ruleset: "mecha-v1.5"; siteDigest: string; opening: Opening; replay: unknown };
const fail = (): never => { throw new Error("invalid_sequential_bundle"); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const cell = (v: unknown): v is Cell => object(v) && fields(v, ["x", "y"]) && Number.isInteger(v.x) && Number.isInteger(v.y) &&
  (v.x as number) >= 0 && (v.x as number) < BOARD && (v.y as number) >= 0 && (v.y as number) < BOARD;
function validOpening(v: unknown, status: boolean): v is Opening {
  if (!object(v) || !fields(v, status ? ["preset", "script", "placements", "encounter"] : ["preset", "script", "placements"]) || v.preset !== "covers_sparse_mid" || v.script !== "siege" ||
      !Array.isArray(v.placements) || v.placements.length !== MECH_IDS.length) return false;
  if (status && (!object(v.encounter) || !fields(v.encounter, ["speciesId", "contentVersion", "statusRules"]) ||
      typeof v.encounter.speciesId !== "string" || !isStatusSpecies(v.encounter.speciesId) ||
      v.encounter.contentVersion !== 1 || v.encounter.statusRules !== "mecha-status-encounter:v1")) return false;
  const ids = new Set<string>(), positions = new Set<string>();
  for (const p of v.placements) {
    if (!object(p) || !fields(p, ["mechId", "pos"]) || typeof p.mechId !== "string" || !MECH_IDS.includes(p.mechId as MechId) || !cell(p.pos)) return false;
    ids.add(p.mechId); positions.add(`${p.pos.x},${p.pos.y}`);
  }
  return ids.size === MECH_IDS.length && positions.size === MECH_IDS.length;
}
async function digest(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("sequential_archive_crypto_unavailable");
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, "0")).join("");
}
/** Explicit local status encounter; initialize before deployment prepares enemy intent. */
export function statusDeploymentFromSite(site: CityMechaSite, speciesId: StatusMonsterId): MatchState {
  if (!isStatusSpecies(speciesId)) return fail();
  const state = matchFromSite(site, { ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "siege", deployment: true, monsterContent: { speciesId, contentVersion: 1 } });
  state.statusEncounter = { schema: "mecha-status-encounter:v1", statuses: [] };
  return state;
}
function openingState(site: CityMechaSite, opening: Opening): MatchState {
  const pending = opening.encounter ? statusDeploymentFromSite(site, opening.encounter.speciesId) :
    matchFromSite(site, { ruleset: "mecha-v1.5", preset: opening.preset, script: opening.script, deployment: true });
  const deployed = applyDeployPlan(pending, { revision: pending.revision, placements: opening.placements });
  if (!deployed.ok || deployed.state.outcome || deployed.state.phase !== "player_plan") return fail();
  return deployed.state;
}

/** Create only from a verified opening and a detached committed command history. */
export async function createSequentialReplayBundle(site: CityMechaSite, evidence: { placements: DeployPlacement[]; initial: MatchState; records: SequentialRecord[]; enemyPolicy?: "scripted" | "baup" }): Promise<string> {
  const savedSite = structuredClone(site), status = evidence.initial.statusEncounter !== undefined;
  const opening: Opening = { preset: "covers_sparse_mid", script: "siege", placements: structuredClone(evidence.placements),
    ...(status ? { encounter: { speciesId: evidence.initial.monsterContent?.speciesId as StatusMonsterId, contentVersion: 1 as const, statusRules: "mecha-status-encounter:v1" as const } } : {}) };
  if (!validOpening(opening, status) || !Array.isArray(evidence.records)) return fail();
  const initial = openingState(savedSite, opening);
  if (canonicalJson(initial) !== canonicalJson(evidence.initial)) return fail();
  const replay = JSON.parse(await createSequentialArchive(initial, evidence.records, evidence.enemyPolicy ?? "scripted"));
  const bundle: Bundle = { schema: status ? STATUS_SCHEMA : SCHEMA, ruleset: "mecha-v1.5", siteDigest: await digest(savedSite), opening, replay };
  const raw = JSON.stringify(bundle);
  if (new TextEncoder().encode(raw).length > MAX_BYTES) return fail();
  return raw;
}

/** Reject an incompatible site or any unverified opening, command, event or final digest. */
export async function restoreSequentialReplayBundle(site: CityMechaSite, raw: string): Promise<{ initial: MatchState; placements: DeployPlacement[]; session: SequentialTurn }> {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > MAX_BYTES) return fail();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail(); }
  if (!object(value) || !fields(value, ["schema", "ruleset", "siteDigest", "opening", "replay"]) || (value.schema !== SCHEMA && value.schema !== STATUS_SCHEMA) ||
      value.ruleset !== "mecha-v1.5" || typeof value.siteDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.siteDigest) ||
      !validOpening(value.opening, value.schema === STATUS_SCHEMA) || !object(value.replay) || !Array.isArray(value.replay.entries)) return fail();
  const savedSite = structuredClone(site);
  if (await digest(savedSite) !== value.siteDigest) return fail();
  const initial = openingState(savedSite, value.opening);
  const session = await replaySequentialArchive(initial, JSON.stringify(value.replay));
  return { initial, placements: structuredClone(value.opening.placements), session };
}
