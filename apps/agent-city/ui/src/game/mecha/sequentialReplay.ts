/** Versioned local command replay prototype. No site, match snapshot or raw events are stored. */
import type { MatchState } from "./board";
import { canonicalJson } from "./contracts/match";
import { SequentialTurn, validSequentialCommand, type SequentialCommand, type SequentialRecord } from "./sequentialTurn";
import { enemyPlannerFor } from "./enemy/policy";
import type { EnemyPolicy } from "./enemy/contracts";

const SCHEMA = "mecha-sequential-replay:v1";
const STATUS_SCHEMA = "mecha-sequential-replay:v2";
const MAX_BYTES = 40_000;
const MAX_COMMANDS = 512;
type SavedEntry = { command: SequentialCommand; eventDigest: string };
type Archive = { schema: typeof SCHEMA | typeof STATUS_SCHEMA; ruleset: "mecha-v1.5"; enemyPolicy: EnemyPolicy; initialDigest: string; finalDigest: string; entries: SavedEntry[]; statusRules?: "mecha-status-encounter:v1" };
const fail = (): never => { throw new Error("invalid_sequential_archive"); };
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const hash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
async function digest(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("sequential_archive_crypto_unavailable");
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hashBytes = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBytes), b => b.toString(16).padStart(2, "0")).join("");
}
function archiveVersion(initial: MatchState): "v1" | "v2" {
  if (initial.statusEncounter === undefined) return "v1";
  if (initial.ruleset !== "mecha-v1.5" || initial.statusEncounter.schema !== "mecha-status-encounter:v1" ||
      !Array.isArray(initial.statusEncounter.statuses) || initial.statusEncounter.statuses.length !== 0 ||
      !["spore_leaper", "flux_lancer", "prism_warden", "gravity_core"].includes(initial.monsterContent?.speciesId ?? "") ||
      initial.monsterContent?.contentVersion !== 1) return fail();
  return "v2";
}

/** Replace local enemy identifiers with per-state ranks; never archive City identifiers. */
function mapTarget(command: SequentialCommand, state: MatchState, direction: "encode" | "decode"): SequentialCommand {
  const copy = structuredClone(command);
  if (copy.kind !== "act" || copy.action.kind === "skip" || copy.action.kind === "repair" || copy.action.target === undefined || copy.action.target === "boss") return copy;
  const target = copy.action.target;
  if (direction === "encode") {
    const index = state.raiders.findIndex(raider => raider.id === target);
    if (index < 0 || index > 1023) return fail();
    copy.action.target = `r${index}`;
  } else {
    if (!/^r(?:0|[1-9][0-9]{0,3})$/.test(target)) return fail();
    const raider = state.raiders[Number(target.slice(1))];
    if (!raider) return fail();
    copy.action.target = raider.id;
  }
  return copy;
}

/** The initial state must be independently reconstructed from the same local site and deployment. */
export async function createSequentialArchive(initial: MatchState, records: readonly SequentialRecord[], enemyPolicy: EnemyPolicy = "scripted"): Promise<string> {
  if (!Array.isArray(records) || records.length > MAX_COMMANDS) return fail();
  const version = archiveVersion(initial);
  const session = new SequentialTurn(initial, { enemyPlanner: enemyPlannerFor(enemyPolicy) }), entries: SavedEntry[] = [], seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (!record || !validSequentialCommand(record.command) || seen.has(record.command.id)) return fail();
    seen.add(record.command.id);
    const saved = mapTarget(record.command, session.snapshot().match, "encode");
    saved.id = `c${index}`;
    const result = session.execute(record.command);
    if (!result.ok || result.snapshot.match.revision !== record.revision ||
        canonicalJson(result.events) !== canonicalJson(record.events) || canonicalJson(result.snapshot) !== canonicalJson(record.snapshot) ||
        canonicalJson(result.causalEvent) !== canonicalJson(record.causalEvent) ||
        canonicalJson(result.presentationStages) !== canonicalJson(record.presentationStages)) return fail();
    entries.push({ command: saved, eventDigest: await digest(result.events) });
  }
  const archive: Archive = { schema: version === "v2" ? STATUS_SCHEMA : SCHEMA, ruleset: "mecha-v1.5", enemyPolicy, initialDigest: await digest(initial), finalDigest: await digest(session.snapshot()), entries,
    ...(version === "v2" ? { statusRules: "mecha-status-encounter:v1" as const } : {}) };
  const raw = JSON.stringify(archive);
  if (new TextEncoder().encode(raw).length > MAX_BYTES) return fail();
  return raw;
}

/** Re-execute and check every step; no unverified snapshot is ever loaded. */
export async function replaySequentialArchive(initial: MatchState, raw: string): Promise<SequentialTurn> {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > MAX_BYTES) return fail();
  const version = archiveVersion(initial);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail(); }
  if (!obj(value) || !fields(value, version === "v2" ? ["schema", "ruleset", "enemyPolicy", "initialDigest", "finalDigest", "entries", "statusRules"] : ["schema", "ruleset", "enemyPolicy", "initialDigest", "finalDigest", "entries"]) ||
      value.schema !== (version === "v2" ? STATUS_SCHEMA : SCHEMA) || (version === "v2" && value.statusRules !== "mecha-status-encounter:v1") ||
      value.ruleset !== "mecha-v1.5" || (value.enemyPolicy !== "scripted" && value.enemyPolicy !== "baup") || !hash(value.initialDigest) || !hash(value.finalDigest) ||
      !Array.isArray(value.entries) || value.entries.length > MAX_COMMANDS || await digest(initial) !== value.initialDigest) return fail();
  const session = new SequentialTurn(initial, { enemyPlanner: enemyPlannerFor(value.enemyPolicy as EnemyPolicy) });
  for (const [index, entry] of value.entries.entries()) {
    if (!obj(entry) || !fields(entry, ["command", "eventDigest"]) || !validSequentialCommand(entry.command) ||
        entry.command.id !== `c${index}` || !hash(entry.eventDigest)) return fail();
    const command = mapTarget(entry.command as SequentialCommand, session.snapshot().match, "decode");
    const result = session.execute(command);
    if (!result.ok || await digest(result.events) !== entry.eventDigest) return fail();
  }
  if (await digest(session.snapshot()) !== value.finalDigest) return fail();
  return session;
}
