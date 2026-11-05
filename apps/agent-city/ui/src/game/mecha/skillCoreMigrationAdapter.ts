/**
 * Local L9 host adapter, NOT a MatchState integration or a remote/replay protocol.
 * The host supplies a complete, authoritative board snapshot and an approved
 * transition; neither a client-supplied snapshot nor a binding authenticates
 * itself. Store the pending binding separately from the public intent. The
 * host must persist both and advance revision atomically during preparation;
 * simply receiving the prepare result does not create a durable declaration.
 *
 * A real host must change revision on EVERY relevant mutation, never recycle
 * match/core IDs, preserve the one-shot ledger, and implement compareAndCommit
 * as one transaction which rechecks matchId, revision AND pending binding while
 * atomically writing ledger, revision and events. A plain JS callback cannot
 * provide those guarantees by itself. No board, combat or event sink is touched.
 */
import {
  prepareCoreMigration, reprojectCoreMigration, resolveCoreMigration,
  type MigrationBinding, type MigrationCell, type MigrationEvent, type MigrationIntent,
  type MigrationProjection, type MigrationRecord, type MigrationState,
} from "./skillCoreMigration";

export type L9Core = { id: string; offset: MigrationCell; alive: boolean };
export type L9Pending = { matchId: string; anchor: MigrationCell; binding: MigrationBinding };
export type L9Ledger = {
  version: 1; phaseId: string; currentCoreId: string; cores: L9Core[]; skills: string[];
  migrations: MigrationRecord[]; pending: L9Pending | null;
};
export type L9Terrain = "land" | "road" | "mountain" | "water";
export type L9Board = {
  terrain: L9Terrain[][]; covers: MigrationCell[]; obstacles: MigrationCell[];
  buildings: Array<{ id: string; cells: MigrationCell[] }>;
  mechs: Array<{ id: string; pos: MigrationCell; hp: number }>;
  raiders: Array<{ id: string; pos: MigrationCell; hp: number }>;
};
export type L9HostSnapshot = {
  version: 1; matchId: string; revision: number; turn: number;
  phase: "deployment" | "enemy_prepare" | "player_plan" | "resolving_boss" | "finished";
  outcome: null | "victory" | "defeat_wipe" | "defeat_timeout" | "defeat_buildings";
  boss: { anchor: MigrationCell; hp: number; maxHp: number }; board: L9Board; ledger: L9Ledger;
};
/** Minimal fields read from the current board MatchState, without importing or changing it. */
export type L9MatchSource = {
  revision: number; turn: number; phase: L9HostSnapshot["phase"]; outcome: L9HostSnapshot["outcome"];
  boss: { anchor: MigrationCell; hp: number };
  terrain: L9Terrain[][]; covers: MigrationCell[]; obstacles: MigrationCell[];
  buildings: Array<{ id: string; cells: MigrationCell[] }>;
  mechs: Array<{ id: string; pos: MigrationCell; hp: number }>;
  raiders: Array<{ id: string; pos: MigrationCell; hp: number }>;
};
/** Host-owned content definition, not a client-selected or self-authorizing policy. */
export type L9Transition = {
  phaseId: string; targetCoreId: string; nextPhaseId: string; threshold: number; nextSkills: string[];
};
export type L9Projection = {
  status: "reprojected"; matchId: string; revision: number; phase: L9HostSnapshot["phase"];
  footprint: MigrationCell[]; migration: MigrationProjection;
};
export type L9Void = { status: "void"; reason: string };
export type L9Proposal = {
  matchId: string; expectedRevision: number; nextRevision: number; expectedPending: L9Pending;
  nextLedger: L9Ledger; events: MigrationEvent[];
};
export type L9AtomicHost = {
  /** Must return the current authoritative snapshot; not an untrusted preview. */
  read: () => L9HostSnapshot;
  /** On false, write NOTHING. On true, atomically check match/revision/pending and write ledger/revision/events. */
  compareAndCommit: (proposal: Readonly<L9Proposal>) => boolean;
};

const SIZE = 10;
const MAX = 1_000_000;
const fail = (reason: string): L9Void => ({ status: "void", reason });
const num = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= lo && v <= hi;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(v);
const obj = (v: unknown, keys: string[]): boolean => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
const cell = (v: unknown, max = SIZE - 1): v is MigrationCell => obj(v, ["x", "y"]) &&
  num((v as MigrationCell).x, 0, max) && num((v as MigrationCell).y, 0, max);
const eq = (a: MigrationCell, b: MigrationCell) => a.x === b.x && a.y === b.y;
const key = (c: MigrationCell) => `${c.x},${c.y}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// Refuse accessors, extra properties on arrays, cycles and non-JSON values BEFORE
// reading snapshot fields. Bounded recursion also limits validation work.
function safeJson(root: unknown): boolean {
  const seen = new Set<object>();
  let count = 0;
  function visit(v: unknown, depth: number): boolean {
    if (++count > 12000 || depth > 16) return false;
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "string") return v.length <= 128;
    if (typeof v === "number") return Number.isSafeInteger(v) && !Object.is(v, -0);
    if (typeof v !== "object" || seen.has(v)) return false;
    seen.add(v);
    const isArray = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
    const keys = Reflect.ownKeys(v);
    if (isArray && (v.length > 1000 || keys.length !== v.length + 1)) return false;
    if (!isArray && keys.length > 32) return false;
    for (const k of keys) {
      if (isArray && k === "length") continue;
      if (typeof k !== "string" || (isArray && (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length))) return false;
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || !d.enumerable || !("value" in d) || !visit(d.value, depth + 1)) return false;
    }
    seen.delete(v);
    return true;
  }
  return visit(root, 0);
}
function cells(v: unknown, max = 100): v is MigrationCell[] {
  return list(v, max) && v.every(c => cell(c)) && new Set(v.map(c => key(c as MigrationCell))).size === v.length;
}
function units(v: unknown): boolean {
  if (!list(v, 100)) return false;
  const ids = new Set<string>(), alivePositions = new Set<string>();
  for (const u of v) {
    if (!obj(u, ["id", "pos", "hp"])) return false;
    const a = u as { id: string; pos: MigrationCell; hp: number };
    if (!id(a.id) || !cell(a.pos) || !num(a.hp, 0, MAX) || ids.has(a.id)) return false;
    if (a.hp > 0 && alivePositions.has(key(a.pos))) return false;
    ids.add(a.id); if (a.hp > 0) alivePositions.add(key(a.pos));
  }
  return true;
}
function validBoard(b: L9Board): boolean {
  if (!obj(b, ["terrain", "covers", "obstacles", "buildings", "mechs", "raiders"]) ||
      !list(b.terrain, SIZE) || b.terrain.length !== SIZE || !b.terrain.every(row =>
        list(row, SIZE) && row.length === SIZE && row.every(t => ["land", "road", "mountain", "water"].includes(t as string))) ||
      !cells(b.covers) || !cells(b.obstacles) || !list(b.buildings, 100) || !units(b.mechs) || !units(b.raiders)) return false;
  const ids = new Set<string>(), occupied = new Set<string>();
  for (const bld of b.buildings) {
    if (!obj(bld, ["id", "cells"]) || !id(bld.id) || ids.has(bld.id) || !cells(bld.cells) || bld.cells.length === 0) return false;
    ids.add(bld.id);
    for (const c of bld.cells) { if (occupied.has(key(c))) return false; occupied.add(key(c)); }
  }
  return true;
}
function validLedger(l: L9Ledger): boolean {
  if (!obj(l, ["version", "phaseId", "currentCoreId", "cores", "skills", "migrations", "pending"]) || l.version !== 1 ||
      !id(l.phaseId) || !id(l.currentCoreId) || !list(l.cores, 16) || l.cores.length < 2 ||
      !list(l.skills, 16) || !list(l.migrations, 256)) return false;
  for (const c of l.cores) if (!obj(c, ["id", "offset", "alive"]) || !id(c.id) || !cell(c.offset, 1) || typeof c.alive !== "boolean") return false;
  if (l.pending !== null && (!obj(l.pending, ["matchId", "anchor", "binding"]) || !id(l.pending.matchId) || !cell(l.pending.anchor))) return false;
  return true; // Core validates IDs, uniqueness, skills, history and binding.
}
function validSnapshot(s: L9HostSnapshot): boolean {
  return safeJson(s) && obj(s, ["version", "matchId", "revision", "turn", "phase", "outcome", "boss", "board", "ledger"]) &&
    s.version === 1 && id(s.matchId) && num(s.revision, 0, MAX) && num(s.turn, 0, MAX) &&
    ["deployment", "enemy_prepare", "player_plan", "resolving_boss", "finished"].includes(s.phase) &&
    (s.outcome === null || ["victory", "defeat_wipe", "defeat_timeout", "defeat_buildings"].includes(s.outcome)) &&
    obj(s.boss, ["anchor", "hp", "maxHp"]) && cell(s.boss.anchor, SIZE - 2) &&
    num(s.boss.maxHp, 2, MAX) && num(s.boss.hp, 0, s.boss.maxHp) && validBoard(s.board) && validLedger(s.ledger);
}
/**
 * Select only the board facts required by L9 from a local MatchState-compatible
 * object. matchId, maxHp and ledger are host-owned because MatchState has no L9
 * fields. Capture must run against one stable authoritative revision; it does not
 * authenticate that revision or make concurrent host reads atomic. Data must be
 * ordinary local objects, not hostile Proxies. Unrelated MatchState fields are
 * deliberately ignored, but every selected field must be an own enumerable data
 * property. No getter is called and no missing board fact is silently defaulted.
 */
export function captureL9MatchSnapshot(source: L9MatchSource, matchId: string, maxHp: number, ledger: L9Ledger):
  { status: "captured"; snapshot: L9HostSnapshot } | L9Void {
  const bad = new Error("invalid_match_source");
  function property(value: unknown, name: string): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw bad;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw bad;
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (!d || !d.enumerable || !("value" in d)) throw bad;
    return d.value;
  }
  function records(value: unknown, names: string[]): Record<string, unknown>[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 100 ||
        Reflect.ownKeys(value).length !== value.length + 1) throw bad;
    const result: Record<string, unknown>[] = [];
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !d.enumerable || !("value" in d)) throw bad;
      const item: Record<string, unknown> = {};
      for (const name of names) item[name] = property(d.value, name);
      result.push(item);
    }
    return result;
  }
  try {
    const boss = property(source, "boss");
    const result = {
      version: 1, matchId, revision: property(source, "revision"), turn: property(source, "turn"),
      phase: property(source, "phase"), outcome: property(source, "outcome"),
      boss: { anchor: property(boss, "anchor"), hp: property(boss, "hp"), maxHp },
      board: { terrain: property(source, "terrain"), covers: property(source, "covers"),
        obstacles: property(source, "obstacles"), buildings: records(property(source, "buildings"), ["id", "cells"]),
        mechs: records(property(source, "mechs"), ["id", "pos", "hp"]),
        raiders: records(property(source, "raiders"), ["id", "pos", "hp"]) },
      ledger,
    } as L9HostSnapshot;
    if (!validSnapshot(result)) return fail("invalid_snapshot");
    return { status: "captured", snapshot: clone(result) };
  } catch {
    return fail("invalid_snapshot");
  }
}

function footprint(anchor: MigrationCell): MigrationCell[] {
  return [{ ...anchor }, { x: anchor.x + 1, y: anchor.y }, { x: anchor.x, y: anchor.y + 1 }, { x: anchor.x + 1, y: anchor.y + 1 }];
}
function boardClear(s: L9HostSnapshot): boolean {
  const board = s.board, area = footprint(s.boss.anchor);
  return area.every(c => board.terrain[c.y]![c.x] !== "water" &&
    !board.covers.some(p => eq(p, c)) && !board.obstacles.some(p => eq(p, c)) &&
    !board.buildings.some(b => b.cells.some(p => eq(p, c))) &&
    !board.mechs.some(u => u.hp > 0 && eq(u.pos, c)) && !board.raiders.some(u => u.hp > 0 && eq(u.pos, c)));
}
function world(s: L9HostSnapshot): MigrationState {
  return { version: 1, round: s.turn, active: s.outcome === null && s.phase !== "deployment" && s.phase !== "finished",
    actorId: "boss", hp: s.boss.hp, maxHp: s.boss.maxHp, phaseId: s.ledger.phaseId, currentCoreId: s.ledger.currentCoreId,
    cores: s.ledger.cores.map(c => ({ id: c.id, alive: c.alive,
      cell: { x: s.boss.anchor.x + c.offset.x, y: s.boss.anchor.y + c.offset.y } })),
    skills: [...s.ledger.skills], migrations: s.ledger.migrations.map(m => ({ ...m })) };
}
function snapshotProblem(s: L9HostSnapshot): L9Void | null {
  if (!validSnapshot(s)) return fail("invalid_snapshot");
  if (s.phase === "deployment" || s.phase === "finished" || s.outcome !== null) return fail("inactive");
  if (!boardClear(s)) return fail("invalid_boss_footprint");
  return null;
}

/** Preparation returns a private pending binding AND an independent public intent. */
export function prepareL9Migration(s: L9HostSnapshot, transition: L9Transition, migrationId: string):
  { status: "planned"; pending: L9Pending; intent: MigrationIntent } | L9Void {
  const problem = snapshotProblem(s); if (problem) return problem;
  if (s.phase !== "enemy_prepare") return fail("wrong_phase");
  if (s.ledger.pending !== null) return fail("pending_exists");
  if (!safeJson(transition) || !obj(transition, ["phaseId", "targetCoreId", "nextPhaseId", "threshold", "nextSkills"]) ||
      transition.phaseId !== s.ledger.phaseId) return fail("invalid_transition");
  const result = prepareCoreMigration(world(s), { skillId: "core_migration", migrationId, threshold: transition.threshold,
    targetCoreId: transition.targetCoreId, nextPhaseId: transition.nextPhaseId, nextSkills: transition.nextSkills });
  if (result.status === "void") return result;
  return { status: "planned", pending: { matchId: s.matchId, anchor: { ...s.boss.anchor }, binding: result.binding }, intent: result.intent };
}

/** Reprojection verifies the original binding, immutable anchor and current board facts; never selects again. */
export function projectL9Migration(s: L9HostSnapshot, intent: MigrationIntent): L9Projection | L9Void {
  const problem = snapshotProblem(s); if (problem) return problem;
  const pending = s.ledger.pending;
  if (!pending) return fail("missing_binding");
  if (pending.matchId !== s.matchId) return fail("match_changed");
  if (!eq(pending.anchor, s.boss.anchor)) return fail("boss_moved");
  if (!safeJson(intent)) return fail("invalid_intent");
  const migration = reprojectCoreMigration(world(s), pending.binding, intent);
  if (migration.status === "void") return migration;
  return { status: "reprojected", matchId: s.matchId, revision: s.revision, phase: s.phase,
    footprint: footprint(s.boss.anchor), migration };
}

// Key ordering is not authority; equality accepts JSON round trips with reordered keys.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Build only a proposal; no host state or event journal is mutated here. */
export function proposeL9Migration(s: L9HostSnapshot, intent: MigrationIntent, expected: L9Projection):
  { status: "proposed"; proposal: L9Proposal } | L9Void {
  const actual = projectL9Migration(s, intent);
  if (actual.status === "void") return actual;
  if (s.phase !== "resolving_boss") return fail("wrong_phase");
  if (s.revision === MAX) return fail("revision_exhausted");
  if (!safeJson(expected) || canonical(expected) !== canonical(actual)) return fail("stale_projection");
  const pending = s.ledger.pending!;
  const result = resolveCoreMigration(world(s), pending.binding, intent, actual.migration);
  if (result.status === "void") return result;
  const nextLedger: L9Ledger = { ...clone(s.ledger), phaseId: result.state.phaseId, currentCoreId: result.state.currentCoreId,
    skills: [...result.state.skills], migrations: clone(result.state.migrations), pending: null };
  return { status: "proposed", proposal: { matchId: s.matchId, expectedRevision: s.revision, nextRevision: s.revision + 1,
    expectedPending: clone(pending), nextLedger, events: clone(result.events) } };
}

/** One CAS call only; on conflict the adapter emits nothing and never retries/reselects. */
export function commitL9Migration(host: L9AtomicHost, intent: MigrationIntent, expected: L9Projection):
  { status: "committed"; revision: number; events: MigrationEvent[] } | L9Void {
  const proposal = proposeL9Migration(host.read(), intent, expected);
  if (proposal.status === "void") return proposal;
  const receipt = { status: "committed" as const, revision: proposal.proposal.nextRevision, events: clone(proposal.proposal.events) };
  return host.compareAndCommit(clone(proposal.proposal)) ? receipt : fail("commit_conflict");
}
