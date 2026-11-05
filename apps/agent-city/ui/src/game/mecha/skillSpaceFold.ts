/**
 * Standalone L10 rule core. This is not registered in a match, practice mode,
 * replay or remote protocol. The host owns the authoritative, independently
 * retained binding, ID allocation, board policy, revision checks and atomic
 * commit. A JSON binding is not an authentication mechanism.
 *
 * A fold is a bounded closed permutation of cells. Terrain is unchanged;
 * whole living footprints move simultaneously, while events follow canonical
 * source-cell order. An invalidated declaration voids rather than retargets.
 */
import {
  PHASE_FIELD_MAX_MAPPING, prepareSpaceFold, reprojectSpaceFold, resolveSpaceFold,
  type FoldEvent, type FoldMove, type FoldPair, type FoldProjection,
  type PhaseFieldCell, type SpaceFoldIntent, type SpaceFoldRequest, type SpaceFoldState,
} from "./skillPhaseField";

export type SpaceFoldBinding = SpaceFoldIntent;
export type SpaceFoldCorePrepare =
  | { status: "planned"; binding: SpaceFoldBinding; intent: SpaceFoldIntent }
  | SpaceFoldCoreVoid;
export type SpaceFoldCoreProjection = Extract<FoldProjection, { status: "reprojected" }>;
export type SpaceFoldCoreReprojection = SpaceFoldCoreProjection | SpaceFoldCoreVoid;
export type SpaceFoldCoreResolution =
  | { status: "resolved"; state: SpaceFoldState; events: FoldEvent[] }
  | SpaceFoldCoreVoid;
export type SpaceFoldCoreVoid = { status: "void"; reason: string };

export const SPACE_FOLD_MAX_CELLS = PHASE_FIELD_MAX_MAPPING;
export const SPACE_FOLD_MAX_UNITS = 256;
export const SPACE_FOLD_MAX_HISTORY = 256;
const fail = (reason: string): SpaceFoldCoreVoid => ({ status: "void", reason });
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= min && v <= max;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(v);

// Only plain, exact, enumerable data survives JSON without losing information.
// Reject extras, accessors, custom prototypes, sparse arrays, symbols and -0.
function object(v: unknown, fields: readonly string[]): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(v);
  return keys.length === fields.length && keys.every(k => typeof k === "string" && fields.includes(k)) && fields.every(k => {
    const d = Object.getOwnPropertyDescriptor(v, k);
    return !!d && d.enumerable && "value" in d;
  });
}
function array(v: unknown, min: number, max: number): v is unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length < min || v.length > max ||
      Reflect.ownKeys(v).length !== v.length + 1) return false;
  for (let n = 0; n < v.length; n++) {
    const d = Object.getOwnPropertyDescriptor(v, String(n));
    if (!d || !d.enumerable || !("value" in d)) return false;
  }
  return true;
}
function cell(v: unknown): v is PhaseFieldCell {
  if (!object(v, ["x", "y"])) return false;
  const c = v as PhaseFieldCell;
  return integer(c.x, 0, 127) && integer(c.y, 0, 127);
}
function pair(v: unknown): v is FoldPair {
  if (!object(v, ["from", "to"])) return false;
  const p = v as FoldPair;
  return cell(p.from) && cell(p.to);
}
function move(v: unknown): v is FoldMove {
  if (!object(v, ["unitId", "from", "to", "width", "height"])) return false;
  const m = v as FoldMove;
  return id(m.unitId) && cell(m.from) && cell(m.to) && integer(m.width, 1, 2) && integer(m.height, 1, 2);
}
function pairs(v: unknown): v is FoldPair[] { return array(v, 2, SPACE_FOLD_MAX_CELLS) && v.every(pair); }
function moves(v: unknown): v is FoldMove[] { return array(v, 0, SPACE_FOLD_MAX_UNITS) && v.every(move); }
function validState(v: SpaceFoldState): boolean {
  if (!object(v, ["version", "width", "height", "round", "active", "phaseId", "actorId", "blocked", "units", "resolvedFoldIds"]) ||
      v.version !== 1 || !integer(v.width, 1, 128) || !integer(v.height, 1, 128) || !integer(v.round, 0, 1000000) ||
      typeof v.active !== "boolean" || !id(v.phaseId) || !id(v.actorId) || !array(v.blocked, 0, 16384) || !v.blocked.every(cell) ||
      !array(v.units, 0, SPACE_FOLD_MAX_UNITS) || !array(v.resolvedFoldIds, 0, SPACE_FOLD_MAX_HISTORY) ||
      !v.resolvedFoldIds.every(id) || new Set(v.resolvedFoldIds).size !== v.resolvedFoldIds.length) return false;
  return v.units.every(u => object(u, ["id", "cell", "width", "height", "hp"]) && id(u.id) && cell(u.cell) &&
    integer(u.width, 1, 2) && integer(u.height, 1, 2) && integer(u.hp, 0, 1000000));
}
function validRequest(v: SpaceFoldRequest): boolean {
  return object(v, ["skillId", "actionId", "mapping"]) && v.skillId === "space_fold" && id(v.actionId) && pairs(v.mapping);
}
function validIntent(v: SpaceFoldIntent): boolean {
  return object(v, ["version", "skillId", "round", "actorId", "actorCell", "phaseId", "actionId", "mapping", "moves"]) &&
    v.version === 1 && v.skillId === "space_fold" && integer(v.round, 0, 1000000) && id(v.actorId) && cell(v.actorCell) &&
    id(v.phaseId) && id(v.actionId) && pairs(v.mapping) && moves(v.moves);
}
function validProjection(v: SpaceFoldCoreProjection): boolean {
  return object(v, ["status", "mapping", "moves"]) && v.status === "reprojected" && pairs(v.mapping) && moves(v.moves);
}
const sameCell = (a: PhaseFieldCell, b: PhaseFieldCell): boolean => a.x === b.x && a.y === b.y;
const samePairs = (a: FoldPair[], b: FoldPair[]): boolean => a.length === b.length &&
  a.every((p, n) => sameCell(p.from, b[n]!.from) && sameCell(p.to, b[n]!.to));
const sameMoves = (a: FoldMove[], b: FoldMove[]): boolean => a.length === b.length && a.every((m, n) => {
  const other = b[n]!;
  return m.unitId === other.unitId && m.width === other.width && m.height === other.height &&
    sameCell(m.from, other.from) && sameCell(m.to, other.to);
});
function sameIntent(a: SpaceFoldIntent, b: SpaceFoldIntent): boolean {
  return a.version === b.version && a.skillId === b.skillId && a.round === b.round && a.actorId === b.actorId &&
    sameCell(a.actorCell, b.actorCell) && a.phaseId === b.phaseId && a.actionId === b.actionId &&
    samePairs(a.mapping, b.mapping) && sameMoves(a.moves, b.moves);
}
const copyCell = (c: PhaseFieldCell): PhaseFieldCell => ({ x: c.x, y: c.y });
const copyPair = (p: FoldPair): FoldPair => ({ from: copyCell(p.from), to: copyCell(p.to) });
const copyMove = (m: FoldMove): FoldMove => ({ unitId: m.unitId, from: copyCell(m.from), to: copyCell(m.to), width: m.width, height: m.height });
const copyIntent = (i: SpaceFoldIntent): SpaceFoldIntent => ({ version: i.version, skillId: i.skillId, round: i.round,
  actorId: i.actorId, actorCell: copyCell(i.actorCell), phaseId: i.phaseId, actionId: i.actionId,
  mapping: i.mapping.map(copyPair), moves: i.moves.map(copyMove) });

/** The caller supplies the complete mapping; this core never selects another. */
export function prepareSpaceFoldCore(state: SpaceFoldState, request: SpaceFoldRequest): SpaceFoldCorePrepare {
  if (!validState(state)) return fail("invalid_state");
  if (!validRequest(request)) return fail("invalid_request");
  const result = prepareSpaceFold(state, request);
  if (result.status === "void") return result;
  return { status: "planned", binding: copyIntent(result.intent), intent: copyIntent(result.intent) };
}

/** Recalculate only to validate the old participants and destinations, never to replace them. */
export function reprojectSpaceFoldCore(state: SpaceFoldState, binding: SpaceFoldBinding, intent: SpaceFoldIntent): SpaceFoldCoreReprojection {
  if (!validState(state)) return fail("invalid_state");
  if (!validIntent(binding)) return fail("invalid_binding");
  if (!validIntent(intent)) return fail("invalid_intent");
  if (!sameIntent(binding, intent)) return fail("intent_changed");
  return reprojectSpaceFold(state, binding);
}

/** Preview and commit must call this same function with the same retained binding. */
export function resolveSpaceFoldCore(
  state: SpaceFoldState, binding: SpaceFoldBinding, intent: SpaceFoldIntent, expected: SpaceFoldCoreProjection,
): SpaceFoldCoreResolution {
  const projection = reprojectSpaceFoldCore(state, binding, intent);
  if (projection.status === "void") return projection;
  if (!validProjection(expected) || !samePairs(projection.mapping, expected.mapping) || !sameMoves(projection.moves, expected.moves)) return fail("stale_projection");
  const result = resolveSpaceFold(state, binding, projection);
  if (result.status === "void") return fail(result.reason);
  return result;
}

// Validate the retained source's internal geometry even though only the host can
// attest which declaration was actually committed. The old board is unavailable.
function validRecoverySource(source: SpaceFoldBinding): boolean {
  const byCell = new Map<string, FoldPair>(), destinations = new Set<string>(), order = new Map<string, number>();
  const key = (c: PhaseFieldCell): string => `${c.x},${c.y}`;
  for (let n = 0; n < source.mapping.length; n++) {
    const p = source.mapping[n]!, from = key(p.from), to = key(p.to), previous = source.mapping[n - 1];
    if (byCell.has(from) || destinations.has(to) || (previous &&
        (previous.from.y > p.from.y || (previous.from.y === p.from.y && previous.from.x >= p.from.x)))) return false;
    byCell.set(from, p); destinations.add(to); order.set(from, n);
  }
  if ([...byCell.keys()].some(k => !destinations.has(k))) return false;
  const ids = new Set<string>(), occupied = new Set<string>();
  let previousOrder = -1;
  for (const m of source.moves) {
    if (ids.has(m.unitId)) return false;
    ids.add(m.unitId);
    let first = SPACE_FOLD_MAX_CELLS;
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
      const from = { x: m.from.x + x, y: m.from.y + y }, to = { x: m.to.x + x, y: m.to.y + y };
      const k = key(from), mapped = byCell.get(k);
      if (occupied.has(k) || !mapped || !sameCell(mapped.to, to)) return false;
      occupied.add(k); first = Math.min(first, order.get(k)!);
    }
    if (first <= previousOrder) return false;
    previousOrder = first;
  }
  return true;
}

/**
 * Declare an optional inverse in the original round/phase. Only the exact
 * original participants can be restored, without rolling back HP or terrain.
 * The source binding must be the host-retained binding of the committed action;
 * an ID in history alone cannot authenticate its contents. This creates a new
 * declaration, not an automatic follow-up action. Resolve it with the same
 * reprojectSpaceFoldCore/resolveSpaceFoldCore functions, never by preparing again.
 */
export function prepareSpaceFoldRecoveryCore(
  state: SpaceFoldState, source: SpaceFoldBinding, recoveryActionId: string,
): SpaceFoldCorePrepare {
  if (!validState(state)) return fail("invalid_state");
  if (!validIntent(source) || !validRecoverySource(source)) return fail("invalid_binding");
  if (!id(recoveryActionId) || recoveryActionId === source.actionId) return fail("invalid_recovery_id");
  if (!state.resolvedFoldIds.includes(source.actionId)) return fail("source_not_resolved");
  if (state.actorId !== source.actorId) return fail("actor_changed");
  if (state.phaseId !== source.phaseId) return fail("phase_changed");
  if (state.round !== source.round) return fail("round_changed");
  const old = new Map(source.moves.map(m => [m.unitId, m]));
  if (old.size !== source.moves.length) return fail("invalid_binding");
  const result = prepareSpaceFoldCore(state, { skillId: "space_fold", actionId: recoveryActionId,
    mapping: source.mapping.map(p => ({ from: copyCell(p.to), to: copyCell(p.from) })) });
  if (result.status === "void") return result;
  if (result.intent.moves.length !== old.size || result.intent.moves.some(m => {
    const original = old.get(m.unitId);
    return !original || m.width !== original.width || m.height !== original.height ||
      !sameCell(m.from, original.to) || !sameCell(m.to, original.from);
  })) return fail("occupancy_changed");
  return result;
}
