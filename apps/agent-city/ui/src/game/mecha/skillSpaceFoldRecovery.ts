/**
 * Local L10 inverse-fold primitive, not a battle integration or a full undo.
 * Receipts are plain data, not proof of provenance: the host must retain them
 * with the authoritative action, reserve both globally unique IDs until the
 * receipt expires, validate its provenance, and commit state/events atomically.
 */
import {
  PHASE_FIELD_MAX_MAPPING, prepareSpaceFold, resolveSpaceFold,
  type FoldEvent, type FoldMove, type FoldPair, type FoldProjection,
  type PhaseFieldCell, type PhaseFieldPrepare, type PhaseFieldResolution,
  type SpaceFoldIntent, type SpaceFoldState,
} from "./skillPhaseField";

export type FoldRecoveryReceipt = {
  version: 1; sourceActionId: string; recoveryActionId: string;
  actorId: string; phaseId: string; round: number;
  mapping: FoldPair[]; moves: FoldMove[];
};
export type FoldWithReceiptResult =
  | { status: "resolved"; state: SpaceFoldState; events: FoldEvent[]; receipt: FoldRecoveryReceipt }
  | { status: "void"; reason: string; state: SpaceFoldState; events: [] };

const validId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(s);
const integer = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
const cell = (c: PhaseFieldCell): boolean => !!c && integer(c.x, 0, 127) && integer(c.y, 0, 127);
const sameCell = (a: PhaseFieldCell, b: PhaseFieldCell): boolean => cell(a) && cell(b) && a.x === b.x && a.y === b.y;
const copyCell = (c: PhaseFieldCell): PhaseFieldCell => ({ x: c.x, y: c.y });
const copyPair = (p: FoldPair): FoldPair => ({ from: copyCell(p.from), to: copyCell(p.to) });
const copyMove = (m: FoldMove): FoldMove => ({ unitId: m.unitId, from: copyCell(m.from), to: copyCell(m.to), width: m.width, height: m.height });
const key = (c: PhaseFieldCell): string => `${c.x},${c.y}`;
const voidResult = (reason: string): { status: "void"; reason: string } => ({ status: "void", reason });

function validReceipt(r: FoldRecoveryReceipt): boolean {
  if (!r || r.version !== 1 || !validId(r.sourceActionId) || !validId(r.recoveryActionId) ||
      r.sourceActionId === r.recoveryActionId || !validId(r.actorId) || !validId(r.phaseId) ||
      !integer(r.round, 0, 1000000) || !Array.isArray(r.mapping) || r.mapping.length < 2 ||
      r.mapping.length > PHASE_FIELD_MAX_MAPPING || !Array.isArray(r.moves) || r.moves.length > 256) return false;
  const map = new Map<string, PhaseFieldCell>(), destinations = new Set<string>();
  for (const pair of r.mapping) {
    if (!pair || !cell(pair.from) || !cell(pair.to) || map.has(key(pair.from)) || destinations.has(key(pair.to))) return false;
    map.set(key(pair.from), pair.to); destinations.add(key(pair.to));
  }
  if ([...map.keys()].some(k => !destinations.has(k))) return false;
  const ids = new Set<string>();
  for (const move of r.moves) {
    if (!move || !validId(move.unitId) || ids.has(move.unitId) || !cell(move.from) || !cell(move.to) ||
        !integer(move.width, 1, 2) || !integer(move.height, 1, 2)) return false;
    ids.add(move.unitId);
    // Verify the whole footprint follows the original mapping by translation.
    for (let y = 0; y < move.height; y++) for (let x = 0; x < move.width; x++) {
      const from = { x: move.from.x + x, y: move.from.y + y };
      const to = { x: move.to.x + x, y: move.to.y + y };
      const mapped = map.get(key(from));
      if (!mapped || !sameCell(mapped, to)) return false;
    }
  }
  return true;
}

/** Execute the original declared fold and capture its inverse evidence together. */
export function resolveFoldWithRecovery(
  state: SpaceFoldState, intent: SpaceFoldIntent, recoveryActionId: string, expected?: FoldProjection,
): FoldWithReceiptResult {
  if (!validId(recoveryActionId) || !intent || recoveryActionId === intent.actionId) {
    return { ...voidResult("invalid_recovery_id"), state, events: [] };
  }
  // Resolve first to validate the state and intent; the result is not committed on failure.
  const result = resolveSpaceFold(state, intent, expected);
  if (result.status === "void") return result;
  if (state.resolvedFoldIds.includes(recoveryActionId)) {
    return { ...voidResult("recovery_id_used"), state, events: [] };
  }
  return { ...result, receipt: {
    version: 1, sourceActionId: intent.actionId, recoveryActionId, actorId: intent.actorId,
    phaseId: intent.phaseId, round: intent.round, mapping: intent.mapping.map(copyPair), moves: intent.moves.map(copyMove),
  } };
}

/**
 * Declare the inverse in the same round and phase. Refuse any additional,
 * missing, moved, dead or resized participant rather than changing the plan.
 * Unaffected cells and HP are never rolled back.
 */
export function prepareFoldRecovery(state: SpaceFoldState, receipt: FoldRecoveryReceipt): PhaseFieldPrepare<SpaceFoldIntent> {
  if (!validReceipt(receipt)) return voidResult("invalid_receipt");
  const plan = prepareSpaceFold(state, { skillId: "space_fold", actionId: receipt.recoveryActionId,
    mapping: receipt.mapping.map(pair => ({ from: copyCell(pair.to), to: copyCell(pair.from) })) });
  if (plan.status === "void") return plan;
  if (!state.resolvedFoldIds.includes(receipt.sourceActionId)) return voidResult("source_not_resolved");
  if (state.actorId !== receipt.actorId) return voidResult("actor_changed");
  if (state.phaseId !== receipt.phaseId) return voidResult("phase_changed");
  if (state.round !== receipt.round) return voidResult("round_changed");
  const original = new Map(receipt.moves.map(move => [move.unitId, move]));
  if (plan.intent.moves.length !== original.size || plan.intent.moves.some(move => {
    const old = original.get(move.unitId);
    return !old || move.width !== old.width || move.height !== old.height ||
      !sameCell(move.from, old.to) || !sameCell(move.to, old.from);
  })) return voidResult("occupancy_changed");
  return plan;
}

function sameIntent(a: SpaceFoldIntent, b: SpaceFoldIntent): boolean {
  if (!b || b.version !== a.version || b.skillId !== a.skillId || b.round !== a.round || b.actorId !== a.actorId ||
      !sameCell(b.actorCell, a.actorCell) || b.phaseId !== a.phaseId || b.actionId !== a.actionId ||
      !Array.isArray(b.mapping) || b.mapping.length !== a.mapping.length || !Array.isArray(b.moves) || b.moves.length !== a.moves.length) return false;
  return a.mapping.every((p, n) => !!b.mapping[n] && sameCell(p.from, b.mapping[n]!.from) && sameCell(p.to, b.mapping[n]!.to)) &&
    a.moves.every((m, n) => { const other = b.moves[n]; return !!other && m.unitId === other.unitId && m.width === other.width &&
      m.height === other.height && sameCell(m.from, other.from) && sameCell(m.to, other.to); });
}

/** Resolve exactly the earlier recovery intent, using the same resolver as preview. */
export function resolveFoldRecovery(
  state: SpaceFoldState, receipt: FoldRecoveryReceipt, intent: SpaceFoldIntent, expected?: FoldProjection,
): PhaseFieldResolution<SpaceFoldState, FoldEvent> {
  const plan = prepareFoldRecovery(state, receipt);
  if (plan.status === "void") return { ...plan, state, events: [] };
  if (!sameIntent(plan.intent, intent)) return { ...voidResult("stale_recovery_intent"), state, events: [] };
  return resolveSpaceFold(state, intent, expected);
}
