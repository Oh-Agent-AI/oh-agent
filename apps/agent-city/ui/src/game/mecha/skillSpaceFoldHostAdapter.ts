/**
 * L10-only local host adapter, NOT registered in MatchState or battle flow.
 * A future host must authorize the species, retain the entire ledger as trusted
 * authority, supply the correct turn boundary, reserve action IDs, and perform
 * a real compare-and-swap/transaction for the returned state AND journal.
 * JSON snapshots and bindings are not signatures and cannot authenticate an
 * attacker who can replace the authoritative state or invent a ticket.
 *
 * Deliberately conservative: unknown host fields, missions, other monster
 * state, existing enemy intents and unsupported geometry fail closed. Unsafe
 * edge endpoints, mountain, water, covers, obstacles, all buildings (including
 * rubble), reserved deployment cells and unsafe cells are immovable. This is
 * an adapter policy for testing, not a claim that all host map rules are known.
 */
import { BOARD, GDD_RULESET, MECH_IDS, type Cell, type MatchState, type MechId } from "./board";
import {
  prepareSpaceFoldCore, reprojectSpaceFoldCore, resolveSpaceFoldCore,
  SPACE_FOLD_MAX_CELLS, SPACE_FOLD_MAX_HISTORY,
  type SpaceFoldBinding, type SpaceFoldCoreProjection,
} from "./skillSpaceFold";
import type { FoldEvent, FoldPair, SpaceFoldIntent, SpaceFoldState } from "./skillPhaseField";

export type FoldHostBatch = { actionId: string; events: FoldEvent[] };
export type FoldHostLedger = {
  version: 1; pending: { binding: SpaceFoldBinding; intent: SpaceFoldIntent } | null;
  committed: FoldHostBatch[];
};
export type FoldHostState = { version: 1; match: MatchState; ledger: FoldHostLedger };
export type FoldHostTicket = { version: 1; revision: number; snapshot: string };
export type FoldHostVoid = { status: "void"; reason: string };
export type FoldHostFacts = { status: "projected"; revision: number; phase: MatchState["phase"]; world: SpaceFoldState } | FoldHostVoid;
export type FoldHostPrepared = { status: "prepared"; state: FoldHostState; intent: SpaceFoldIntent } | FoldHostVoid;
export type FoldHostProjected = { status: "reprojected"; projection: SpaceFoldCoreProjection; world: SpaceFoldState } | FoldHostVoid;
export type FoldHostPreview = { status: "preview"; ticket: FoldHostTicket; state: FoldHostState; events: FoldEvent[] } | FoldHostVoid;
export type FoldHostCommit = { status: "committed"; state: FoldHostState; events: FoldEvent[] } | FoldHostVoid;

const MAX_REVISION = 999999999;
// Bounded above the worst-case 256 batches of 64 mapped cells and moves.
const MAX_JSON_NODES = 300000;
const fail = (reason: string): FoldHostVoid => ({ status: "void", reason });
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(v);
const uint = (v: unknown, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= 0 && v <= max;
const point = (v: unknown): v is Cell => obj(v, ["x", "y"]) && uint((v as Cell).x, BOARD - 1) && uint((v as Cell).y, BOARD - 1);
const k = (v: Cell): string => `${v.x},${v.y}`;
const cmp = (a: Cell, b: Cell): number => a.y - b.y || a.x - b.x;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function obj(v: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(v);
  return keys.every(x => typeof x === "string" && (required.includes(x) || optional.includes(x))) && required.every(x => keys.includes(x)) &&
    keys.every(x => { const d = Object.getOwnPropertyDescriptor(v, x); return !!d && d.enumerable && "value" in d; });
}
function list(v: unknown, max: number): v is unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length > max || Reflect.ownKeys(v).length !== v.length + 1) return false;
  for (let n = 0; n < v.length; n++) {
    const d = Object.getOwnPropertyDescriptor(v, String(n));
    if (!d || !d.enumerable || !("value" in d)) return false;
  }
  return true;
}
// Validate before cloning or serializing: no cycles, accessors, sparse arrays,
// non-finite numbers, undefined, BigInt, extra array properties or prototypes.
function json(v: unknown): boolean {
  const ancestors = new Set<object>(); let count = 0;
  function visit(x: unknown, depth: number): boolean {
    if (++count > MAX_JSON_NODES || depth > 32) return false;
    if (x === null || typeof x === "boolean") return true;
    if (typeof x === "string") return x.length <= 4096;
    if (typeof x === "number") return Number.isFinite(x) && !Object.is(x, -0);
    if (typeof x !== "object" || ancestors.has(x)) return false;
    ancestors.add(x);
    let ok: boolean;
    if (Array.isArray(x)) ok = list(x, 16640) && x.every(child => visit(child, depth + 1));
    else {
      const proto = Object.getPrototypeOf(x), keys = Reflect.ownKeys(x);
      ok = (proto === Object.prototype || proto === null) && keys.length <= 128 && keys.every(key => {
        if (typeof key !== "string" || key.length > 128) return false;
        const d = Object.getOwnPropertyDescriptor(x, key);
        return !!d && d.enumerable && "value" in d && visit(d.value, depth + 1);
      });
    }
    ancestors.delete(x); return ok;
  }
  return visit(v, 0);
}
const cells = (v: unknown): v is Cell[] => list(v, BOARD * BOARD) && v.every(point);
const equalCell = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y;

function validBatch(v: FoldHostBatch): boolean {
  if (!obj(v, ["actionId", "events"]) || !id(v.actionId) || !list(v.events, SPACE_FOLD_MAX_CELLS + 1) || v.events.length < 1) return false;
  const first = v.events[0];
  if (!first || !obj(first, ["type", "actionId", "mapping"]) || first.type !== "space_fold_applied" || first.actionId !== v.actionId ||
      !list(first.mapping, SPACE_FOLD_MAX_CELLS) || first.mapping.length < 2) return false;
  const sources = new Map<string, { to: Cell; order: number }>(), destinations = new Set<string>();
  for (let n = 0; n < first.mapping.length; n++) {
    const pair = first.mapping[n]!, prev = first.mapping[n - 1];
    if (!obj(pair, ["from", "to"]) || !point(pair.from) || !point(pair.to) || sources.has(k(pair.from)) || destinations.has(k(pair.to)) ||
        (prev && cmp(prev.from, pair.from) >= 0)) return false;
    sources.set(k(pair.from), { to: pair.to, order: n }); destinations.add(k(pair.to));
  }
  if ([...sources.keys()].some(x => !destinations.has(x))) return false;
  const ids = new Set<string>(); let previous = -1;
  for (const event of v.events.slice(1)) {
    if (!event || !obj(event, ["type", "actionId", "unitId", "from", "to"]) || event.type !== "space_fold_move" ||
        event.actionId !== v.actionId || !id(event.unitId) || ids.has(event.unitId) || !point(event.from) || !point(event.to)) return false;
    const mapped = sources.get(k(event.from));
    if (!mapped || mapped.order <= previous || !equalCell(mapped.to, event.to) || equalCell(event.from, event.to)) return false;
    ids.add(event.unitId); previous = mapped.order;
  }
  return true;
}
function validLedger(ledger: FoldHostLedger): boolean {
  if (!obj(ledger, ["version", "pending", "committed"]) || ledger.version !== 1 || !list(ledger.committed, SPACE_FOLD_MAX_HISTORY) ||
      !ledger.committed.every(validBatch) || new Set(ledger.committed.map(b => b.actionId)).size !== ledger.committed.length) return false;
  return ledger.pending === null || obj(ledger.pending, ["binding", "intent"]);
}

/** Strict facts projection. It does not attest that the caller owns the match. */
export function projectSpaceFoldHost(state: FoldHostState): FoldHostFacts {
  if (!json(state) || !obj(state, ["version", "match", "ledger"]) || state.version !== 1 || !validLedger(state.ledger)) return fail("invalid_adapter_state");
  const m = state.match;
  if (!obj(m, ["ruleset", "preset", "script", "covers", "obstacles", "terrain", "heights", "buildings", "stake", "raiders", "mechs", "boss", "turn", "phase", "revision", "outcome"],
      ["difficulty", "deployment", "assaultTerrainSafety", "mission", "monsterContent", "corrode", "swarm", "neural"]) || m.ruleset !== GDD_RULESET ||
      !uint(m.turn, 1000000) || m.turn < 1 || !uint(m.revision, MAX_REVISION) ||
      !["covers_sparse_mid", "covers_diag_corridor", "covers_twin_clusters"].includes(m.preset) ||
      !["stationary_smash", "cadence_ssw", "raid_ssw", "siege"].includes(m.script) ||
      !["all", "frontage"].includes(m.stake) ||
      (m.difficulty !== undefined && !["easy", "normal", "hard"].includes(m.difficulty)) ||
      !["deployment", "enemy_prepare", "player_plan", "resolving_boss", "finished"].includes(m.phase)) return fail("invalid_match");
  if (m.mission !== undefined || m.monsterContent !== undefined || m.corrode !== undefined || m.swarm !== undefined || m.neural !== undefined) return fail("unsupported_match_feature");
  if (m.phase === "deployment" || m.phase === "finished" || m.outcome !== null) return fail("inactive_match");
  if (!cells(m.covers) || !cells(m.obstacles) || !list(m.terrain, BOARD) || m.terrain.length !== BOARD ||
      !list(m.heights, BOARD) || m.heights.length !== BOARD || !list(m.buildings, 100) || !list(m.mechs, 3) || m.mechs.length !== 3 ||
      !list(m.raiders, 64) || !obj(m.boss, ["anchor", "hp", "cdSweep", "cadence", "intent"]) || !point(m.boss.anchor) ||
      !uint(m.boss.hp, 1000000) || !uint(m.boss.cdSweep, 1000000) || !uint(m.boss.cadence, 1000000)) return fail("invalid_board");
  if (m.boss.intent !== null || m.raiders.some(r => !obj(r, ["id", "pos", "hp", "intent"]) || r.intent !== null)) return fail("unsupported_enemy_state");
  const blocked = new Map<string, Cell>();
  const add = (c: Cell) => blocked.set(k(c), { x: c.x, y: c.y });
  for (let y = 0; y < BOARD; y++) {
    const row = m.terrain[y], heights = m.heights[y];
    if (!list(row, BOARD) || row.length !== BOARD || !list(heights, BOARD) || heights.length !== BOARD) return fail("invalid_board");
    for (let x = 0; x < BOARD; x++) {
      if (!["land", "road", "water", "mountain"].includes(row[x] as string) || typeof heights[x] !== "number" || !Number.isFinite(heights[x])) return fail("invalid_board");
      if (row[x] === "water" || row[x] === "mountain") add({ x, y });
    }
  }
  m.covers.forEach(add); m.obstacles.forEach(add);
  const buildingIds = new Set<string>();
  for (const b of m.buildings) {
    if (!obj(b, ["id", "cells", "hp", "maxHp"]) || !id(b.id) || buildingIds.has(b.id) || !cells(b.cells) || !uint(b.hp, 1000000) || !uint(b.maxHp, 1000000) || b.hp > b.maxHp) return fail("invalid_board");
    buildingIds.add(b.id); b.cells.forEach(add);
  }
  if (m.deployment !== undefined) {
    if (!obj(m.deployment, ["zone", "reservedCells"]) || !cells(m.deployment.zone) || !cells(m.deployment.reservedCells)) return fail("invalid_board");
    m.deployment.reservedCells.forEach(add);
  }
  if (m.assaultTerrainSafety !== undefined) {
    const s = m.assaultTerrainSafety;
    if (!obj(s, ["unsafeCells", "unsafeEdges"]) || !cells(s.unsafeCells) || !list(s.unsafeEdges, 400) ||
        !s.unsafeEdges.every(e => obj(e, ["from", "to"]) && point(e.from) && point(e.to))) return fail("invalid_board");
    s.unsafeCells.forEach(add); s.unsafeEdges.forEach(e => { add(e.from); add(e.to); });
  }
  const units: SpaceFoldState["units"] = [{ id: "boss", cell: { ...m.boss.anchor }, width: 2, height: 2, hp: m.boss.hp }];
  const mechIds = new Set<string>();
  for (const unit of m.mechs) {
    if (!obj(unit, ["id", "pos", "hp", "cd", "skillUsed"]) || !MECH_IDS.includes(unit.id) || mechIds.has(unit.id) ||
        !point(unit.pos) || !uint(unit.hp, 1000000) || !uint(unit.cd, 1000000) || typeof unit.skillUsed !== "boolean") return fail("invalid_board");
    mechIds.add(unit.id); units.push({ id: `mech:${unit.id}`, cell: { ...unit.pos }, width: 1, height: 1, hp: unit.hp });
  }
  const raiderIds = new Set<string>();
  for (const unit of m.raiders) {
    if (!id(unit.id) || unit.id.length > 121 || raiderIds.has(unit.id) || !point(unit.pos) || !uint(unit.hp, 1000000)) return fail("invalid_board");
    raiderIds.add(unit.id); units.push({ id: `raider:${unit.id}`, cell: { ...unit.pos }, width: 1, height: 1, hp: unit.hp });
  }
  if (m.boss.hp <= 0 || !m.mechs.some(u => u.hp > 0)) return fail("inactive_match");
  const occupied = new Set<string>();
  for (const u of units) for (let y = 0; y < u.height; y++) for (let x = 0; x < u.width; x++) {
    const cell = { x: u.cell.x + x, y: u.cell.y + y };
    if (!point(cell)) return fail("invalid_board");
    if (u.hp > 0) { const key = k(cell); if (blocked.has(key) || occupied.has(key)) return fail("unsafe_occupancy"); occupied.add(key); }
  }
  units.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { status: "projected", revision: m.revision, phase: m.phase, world: { version: 1, width: BOARD, height: BOARD,
    round: m.turn, active: true, phaseId: `turn:${m.turn}`, actorId: "boss", blocked: [...blocked.values()].sort(cmp), units,
    resolvedFoldIds: state.ledger.committed.map(b => b.actionId) } };
}

/** Caller must retain the returned state and original binding as authoritative. */
export function prepareSpaceFoldHost(state: FoldHostState, actionId: string, mapping: FoldPair[]): FoldHostPrepared {
  const facts = projectSpaceFoldHost(state);
  if (facts.status === "void") return facts;
  if (facts.phase !== "enemy_prepare") return fail("wrong_phase");
  if (state.ledger.pending !== null) return fail("pending_intent");
  if (state.ledger.committed.length >= SPACE_FOLD_MAX_HISTORY) return fail("history_full");
  const plan = prepareSpaceFoldCore(facts.world, { skillId: "space_fold", actionId, mapping });
  if (plan.status === "void") return plan;
  const next = copy(state);
  next.ledger.pending = { binding: copy(plan.binding), intent: copy(plan.intent) };
  return { status: "prepared", state: next, intent: copy(plan.intent) };
}

export function reprojectSpaceFoldHost(state: FoldHostState, intent: SpaceFoldIntent): FoldHostProjected {
  const facts = projectSpaceFoldHost(state);
  if (facts.status === "void") return facts;
  const pending = state.ledger.pending;
  if (!pending) return fail("no_intent");
  const stored = reprojectSpaceFoldCore(facts.world, pending.binding, pending.intent);
  if (stored.status === "void") return stored;
  const projection = reprojectSpaceFoldCore(facts.world, pending.binding, intent);
  if (projection.status === "void") return projection;
  return { status: "reprojected", projection, world: facts.world };
}

// Canonical key order avoids treating harmless object-property order as a change.
function snapshot(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(snapshot).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${snapshot((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function candidate(state: FoldHostState, intent: SpaceFoldIntent): FoldHostCommit {
  const p = reprojectSpaceFoldHost(state, intent);
  if (p.status === "void") return p;
  if (state.match.phase !== "resolving_boss") return fail("wrong_phase");
  if (state.match.revision >= MAX_REVISION) return fail("revision_exhausted");
  if (state.ledger.committed.length >= SPACE_FOLD_MAX_HISTORY) return fail("history_full");
  const pending = state.ledger.pending!;
  const result = resolveSpaceFoldCore(p.world, pending.binding, intent, p.projection);
  if (result.status === "void") return result;
  const next = copy(state), byId = new Map(result.state.units.map(u => [u.id, u]));
  next.match.boss.anchor = copy(byId.get("boss")!.cell);
  for (const unit of next.match.mechs) unit.pos = copy(byId.get(`mech:${unit.id as MechId}`)!.cell);
  for (const unit of next.match.raiders) unit.pos = copy(byId.get(`raider:${unit.id}`)!.cell);
  next.match.revision++;
  next.ledger.pending = null;
  next.ledger.committed.push({ actionId: pending.binding.actionId, events: copy(result.events) });
  const checked = projectSpaceFoldHost(next);
  if (checked.status === "void" || snapshot(checked.world) !== snapshot(result.state)) return fail("commit_invariant_failed");
  return { status: "committed", state: next, events: copy(result.events) };
}

/** Preview is the same pure candidate calculation as commit; no host mutation. */
export function previewSpaceFoldHost(state: FoldHostState, intent: SpaceFoldIntent): FoldHostPreview {
  const result = candidate(state, intent);
  if (result.status === "void") return result;
  return { status: "preview", ticket: { version: 1, revision: state.match.revision, snapshot: snapshot(state) }, state: result.state, events: result.events };
}

/** Returns a complete replacement bundle; the host must atomically CAS and persist it. */
export function commitSpaceFoldHost(state: FoldHostState, intent: SpaceFoldIntent, ticket: FoldHostTicket): FoldHostCommit {
  const facts = projectSpaceFoldHost(state);
  if (facts.status === "void") return facts;
  if (!obj(ticket, ["version", "revision", "snapshot"]) || ticket.version !== 1 || !uint(ticket.revision, MAX_REVISION) ||
      typeof ticket.snapshot !== "string" || ticket.revision !== facts.revision || ticket.snapshot !== snapshot(state)) return fail("stale_ticket");
  return candidate(state, intent);
}
