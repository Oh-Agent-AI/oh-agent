/** Experimental local v1.5 command core. Not connected to product, replay or remote. */
import { BUILDING_COLLISION_RULESET, assertMonsterState, emit, eq, inb, mech, moveBudget, movementSnapshot, occupant, pathDistance, presentationSnapshot, swapEventSink, type Action, type Cell, type MatchState, type MechId, type PresentationSnapshot, type PresentationStages, type TurnEvent } from "./board";
import { applyAction, beginEnemyPhase } from "./combat";
import { resolveEnemyPhase } from "./execution/enemyPhase";
import { encounterStatusBlocks, STATUS_ENCOUNTER_VERSION } from "./statusEncounter";
import { finishPlayerEncounterStatuses, removeDeadEncounterStatuses } from "./statusTurn";

export type SequentialCommand =
  | { kind: "move"; id: string; revision: number; mech: MechId; to: Cell }
  | { kind: "undo"; id: string; revision: number }
  | { kind: "act"; id: string; revision: number; mech: MechId; action: Action }
  | { kind: "reset"; id: string; revision: number }
  | { kind: "end"; id: string; revision: number; confirmUnused: boolean };
type Rights = Record<MechId, { move: boolean; action: boolean }>;
type Undo = { mech: MechId; from: Cell; to: Cell };
/** Keep the serialized LIFO field stable; reversible moves use a reconstructed command-side index. */
type Snapshot = { match: MatchState; rights: Rights; undo: Undo[]; resetUsed: boolean };
/** Local command causality; kept separate from the v1.4 battle-event wire format. */
export type SequentialCausalEvent =
  | { schema: "mecha-sequential-event:v1"; ruleset: "mecha-v1.5"; kind: "undo_move"; commandId: string; baseRevision: number; revision: number; mech: MechId; from: Cell; to: Cell }
  | { schema: "mecha-sequential-event:v1"; ruleset: "mecha-v1.5"; kind: "reset_turn"; commandId: string; baseRevision: number; revision: number; checkpointRevision: number };
export type SequentialResult = { ok: true; snapshot: Snapshot; events: TurnEvent[]; causalEvent: SequentialCausalEvent | null; presentationStages: PresentationStages | null } | { ok: false; reason: string };
/** Local reconstruction evidence; this is not a remote or persisted schema. */
export type SequentialRecord = { command: SequentialCommand; revision: number; events: TurnEvent[]; causalEvent: SequentialCausalEvent | null; snapshot: Snapshot; presentationStages: PresentationStages | null };
const clone = <T,>(v: T): T => structuredClone(v);
const ids: MechId[] = ["Assault", "Gunner", "Support"];

/** Experimental status state must be explicitly present and valid; old games remain unchanged. */
function validateStatusLedger(state: MatchState): void {
  const ledger = state.statusEncounter;
  if (ledger === undefined) return;
  if (!plainFields(ledger, ["schema", "statuses"]) || ledger.schema !== STATUS_ENCOUNTER_VERSION || !Array.isArray(ledger.statuses) ||
      ledger.statuses.some(status => !plainFields(status, ["kind", "target", "source", "magnitude", "remainingTurns"]) ||
        !validMech(status.target) || !mech(state, status.target))) throw new Error("invalid_status_ledger");
  encounterStatusBlocks(ledger.statuses, "Assault");
}
function statusRestrictions(state: MatchState, id: MechId): { move: boolean; action: boolean } {
  return state.statusEncounter ? encounterStatusBlocks(state.statusEncounter.statuses, id) : { move: false, action: false };
}

function plainFields(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value), own = Reflect.ownKeys(value);
  return (proto === Object.prototype || proto === null) && own.length === names.length && names.every(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return Boolean(descriptor?.enumerable && "value" in descriptor);
  });
}
function validMech(value: unknown): value is MechId { return typeof value === "string" && ids.some(id => id === value); }
function validAction(value: unknown): value is Action {
  if (!value || typeof value !== "object") return false;
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  if (!kind?.enumerable || !("value" in kind) || typeof kind.value !== "string") return false;
  if (kind.value === "skip") return plainFields(value, ["kind"]);
  if (!["melee", "charge", "shoot", "pierce", "repair"].includes(kind.value)) return false;
  const hasTarget = Object.hasOwn(value, "target");
  if (!plainFields(value, hasTarget ? ["kind", "target"] : ["kind"])) return false;
  if (kind.value === "repair") return hasTarget && validMech(value.target);
  return !hasTarget || (typeof value.target === "string" && value.target.length > 0 && value.target.length <= 128);
}
/** Local command data is closed and bounded before fingerprinting or rule access. */
export function validSequentialCommand(value: unknown): value is SequentialCommand {
  if (!value || typeof value !== "object") return false;
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  if (!kind?.enumerable || !("value" in kind) || typeof kind.value !== "string") return false;
  const fields = kind.value === "move" ? ["kind", "id", "revision", "mech", "to"]
    : kind.value === "act" ? ["kind", "id", "revision", "mech", "action"]
    : kind.value === "end" ? ["kind", "id", "revision", "confirmUnused"]
    : kind.value === "undo" || kind.value === "reset" ? ["kind", "id", "revision"] : [];
  if (!fields.length || !plainFields(value, fields) || typeof value.id !== "string" || !value.id || value.id.length > 128 ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return false;
  if (kind.value === "move") return validMech(value.mech) && plainFields(value.to, ["x", "y"]) &&
    Number.isSafeInteger(value.to.x) && Number.isSafeInteger(value.to.y) && inb(value.to as Cell);
  if (kind.value === "act") return validMech(value.mech) && validAction(value.action);
  if (kind.value === "end") return typeof value.confirmUnused === "boolean";
  return true;
}

/** One synchronous local authority, with isolated immutable outputs and command deduplication. */
export class SequentialTurn {
  private current: Snapshot;
  private checkpoint: Snapshot;
  private pendingUndo: Undo[] = [];
  private checkpointPendingUndo: Undo[] = [];
  private readonly journal = new Map<string, { fingerprint: string; result: SequentialResult }>();
  private readonly history: SequentialRecord[] = [];
  constructor(state: MatchState) {
    if (state.ruleset !== BUILDING_COLLISION_RULESET || state.phase !== "player_plan" || state.outcome) throw new Error("invalid_sequential_start");
    assertMonsterState(state);
    validateStatusLedger(state);
    const rights = Object.fromEntries(ids.map(id => [id, { move: Boolean(mech(state, id)), action: Boolean(mech(state, id)) }])) as Rights;
    this.current = { match: clone(state), rights, undo: [], resetUsed: false };
    this.checkpoint = clone(this.current);
  }
  snapshot(): Snapshot { return clone(this.current); }
  undoMech(): MechId | null { return this.pendingUndo[this.findUndoIndex(this.current, this.pendingUndo)]?.mech ?? null; }
  canUndo(): boolean { return this.undoMech() !== null; }
  /** Committed player actions since the latest turn boundary or reset. */
  turnActivity(): { moved: MechId[]; acted: MechId[] } {
    const moved = new Set<MechId>(), acted = new Set<MechId>(), seenMovement = new Set<MechId>();
    for (let index = this.history.length - 1; index >= 0; index--) {
      const { command, causalEvent } = this.history[index]!;
      if (command.kind === "end" || command.kind === "reset") break;
      if (command.kind === "act") acted.add(command.mech);
      if (causalEvent?.kind === "undo_move") seenMovement.add(causalEvent.mech);
      if (command.kind === "move" && !seenMovement.has(command.mech)) {
        moved.add(command.mech);
        seenMovement.add(command.mech);
      }
    }
    return { moved: [...moved], acted: [...acted] };
  }
  records(): SequentialRecord[] { return clone(this.history); }
  recordCount(): number { return this.history.length; }
  /** Detached search branch: same authority state, rights, undo, reset and history count. */
  branch(): SequentialTurn {
    const fork = new SequentialTurn(this.current.match);
    fork.current = clone(this.current);
    fork.checkpoint = clone(this.checkpoint);
    fork.pendingUndo = clone(this.pendingUndo);
    fork.checkpointPendingUndo = clone(this.checkpointPendingUndo);
    // Preserve the history limit without copying the historical records.
    fork.history.length = this.history.length;
    return fork;
  }
  /** Evaluate one command against a detached branch. */
  trial(command: SequentialCommand): SequentialResult {
    return this.branch().execute(command);
  }
  private findUndoIndex(snapshot: Snapshot, candidates: readonly Undo[]): number {
    for (let index = candidates.length - 1; index >= 0; index--) {
      const move = candidates[index]!, unit = mech(snapshot.match, move.mech);
      if (unit && (unit.hp ?? 0) > 0 && snapshot.rights[move.mech]?.action && eq(unit.pos, move.to) &&
          occupant(snapshot.match, move.from) === "empty") return index;
    }
    return -1;
  }
  /** Re-run only committed commands; refuse unverified, duplicate or altered evidence. */
  static replay(initial: MatchState, records: readonly SequentialRecord[]): SequentialTurn {
    if (!Array.isArray(records) || records.length > 4096) throw new Error("invalid_sequential_replay");
    const session = new SequentialTurn(initial);
    const seen = new Set<string>();
    for (const record of records) {
      if (!record || !record.command || seen.has(record.command.id)) throw new Error("invalid_sequential_replay");
      seen.add(record.command.id);
      const result = session.execute(record.command);
      if (!result.ok || result.snapshot.match.revision !== record.revision || JSON.stringify(result.events) !== JSON.stringify(record.events) ||
          JSON.stringify(result.causalEvent) !== JSON.stringify(record.causalEvent) ||
          JSON.stringify(result.presentationStages) !== JSON.stringify(record.presentationStages) ||
          JSON.stringify(result.snapshot) !== JSON.stringify(record.snapshot)) throw new Error("invalid_sequential_replay");
    }
    return session;
  }
  execute(command: SequentialCommand): SequentialResult {
    if (!validSequentialCommand(command)) return { ok: false, reason: "invalid_command" };
    // Canonicalize object key order so an equivalent retry is idempotent.
    const fingerprint = JSON.stringify(command, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
    const prior = this.journal.get(command.id);
    if (prior) return prior.fingerprint === fingerprint ? clone(prior.result) : { ok: false, reason: "duplicate_command" };
    if (this.history.length >= 4096) return { ok: false, reason: "history_full" };
    if (command.revision !== this.current.match.revision) return { ok: false, reason: "stale_revision" };
    if (command.revision >= Number.MAX_SAFE_INTEGER) return { ok: false, reason: "revision_exhausted" };
    if (this.current.match.phase !== "player_plan" || this.current.match.outcome) return { ok: false, reason: "not_player_turn" };
    const next = clone(this.current), nextPendingUndo = clone(this.pendingUndo), events: TurnEvent[] = [], before = presentationSnapshot(this.current.match);
    const outer = swapEventSink(events);
    let failure: string | null = null;
    let advanceCheckpoint = false;
    let causalEvent: SequentialCausalEvent | null = null;
    let afterPlayer: PresentationSnapshot | null = null, afterEnemy: PresentationSnapshot | null = null;
    try {
      if (command.kind === "move") {
        const unit = mech(next.match, command.mech), target = command.to;
        if (statusRestrictions(next.match, command.mech).move) failure = "status_blocks_move";
        else if (!unit || !next.rights[command.mech]?.move || !target || !Number.isInteger(target.x) || !Number.isInteger(target.y) || !inb(target) || eq(unit.pos, target) || occupant(next.match, target) !== "empty") failure = "invalid_move";
        else {
          const distance = pathDistance(next.match, unit.pos, target, unit.id, { alliesPass: true });
          if (distance === null || distance > moveBudget(unit.id)) failure = "invalid_move";
          else {
            const from = { ...unit.pos };
            unit.pos = { ...target };
            next.rights[unit.id].move = false;
            next.undo.push({ mech: unit.id, from, to: { ...target } });
            for (let index = nextPendingUndo.length - 1; index >= 0; index--) if (nextPendingUndo[index]!.mech === unit.id) nextPendingUndo.splice(index, 1);
            nextPendingUndo.push({ mech: unit.id, from, to: { ...target } });
            emit({ type: "move", mechId: unit.id, from, to: { ...target } });
            // Rescue ends as soon as a committed move reaches its objective.
            if (next.match.mission?.kind === "rescue:v1" && eq(unit.pos, next.match.mission.target)) {
              next.match.outcome = "victory";
              next.match.phase = "finished";
              next.undo = [];
              nextPendingUndo.length = 0;
              emit({ type: "outcome", outcome: "victory" });
            }
          }
        }
      } else if (command.kind === "undo") {
        const undoIndex = this.findUndoIndex(next, nextPendingUndo), last = undoIndex >= 0 ? nextPendingUndo[undoIndex] : undefined;
        const unit = last && mech(next.match, last.mech);
        if (!last || !unit) failure = "cannot_undo";
        else {
          unit.pos = { ...last.from }; next.rights[last.mech].move = true; nextPendingUndo.splice(undoIndex, 1);
          const serializedUndoIndex = next.undo.findIndex(move => move.mech === last.mech && eq(move.from, last.from) && eq(move.to, last.to));
          if (serializedUndoIndex >= 0) next.undo.splice(serializedUndoIndex, 1);
          emit({ type: "move", mechId: last.mech, from: { ...last.to }, to: { ...last.from } });
          causalEvent = { schema: "mecha-sequential-event:v1", ruleset: "mecha-v1.5", kind: "undo_move", commandId: command.id, baseRevision: command.revision, revision: command.revision + 1, mech: last.mech, from: { ...last.to }, to: { ...last.from } };
        }
      } else if (command.kind === "act") {
        const unit = mech(next.match, command.mech);
        if (statusRestrictions(next.match, command.mech).action) failure = "status_blocks_action";
        else if (!unit || !next.rights[command.mech]?.action || !command.action || !["skip", "melee", "charge", "shoot", "pierce", "repair"].includes(command.action.kind)) failure = "invalid_action";
        else {
          failure = applyAction(next.match, command.mech, command.action);
          if (!failure) {
            if (command.action.kind === "skip") emit({ type: "act", mechId: command.mech, action: "skip", damage: 0 });
            next.rights[command.mech] = { move: false, action: false };
            for (let index = nextPendingUndo.length - 1; index >= 0; index--) if (nextPendingUndo[index]!.mech === command.mech) nextPendingUndo.splice(index, 1);
            next.undo = [];
            if (next.match.outcome) { nextPendingUndo.length = 0; emit({ type: "outcome", outcome: next.match.outcome }); }
          }
        }
      } else if (command.kind === "reset") {
        if (next.resetUsed) failure = "reset_used";
        else {
          const revision = next.match.revision, checkpointRevision = this.checkpoint.match.revision;
          Object.assign(next, clone(this.checkpoint)); next.match.revision = revision; next.resetUsed = true;
          nextPendingUndo.splice(0, nextPendingUndo.length, ...clone(this.checkpointPendingUndo));
          causalEvent = { schema: "mecha-sequential-event:v1", ruleset: "mecha-v1.5", kind: "reset_turn", commandId: command.id, baseRevision: revision, revision: revision + 1, checkpointRevision };
        }
      } else if (command.kind === "end") {
        if (typeof command.confirmUnused !== "boolean") failure = "invalid_command";
        else if (!command.confirmUnused && ids.some(id => mech(next.match, id) && next.rights[id].action && !statusRestrictions(next.match, id).action)) failure = "confirmation_required";
        else {
          finishPlayerEncounterStatuses(next.match);
          if (next.match.statusEncounter) emit({ type: "status_boundary", schema: "mecha-status-event:v1", phase: "player_end" });
          // Apply v1.4 cooldown semantics once per completed player phase.
          if (!next.match.outcome) beginEnemyPhase(next.match);
          afterPlayer = presentationSnapshot(next.match);
          const enemyPhase = resolveEnemyPhase(next.match, {
            capturePresentation: true,
            afterBoss: () => {
              // Enemy damage can kill a status-bearing unit; the post-enemy snapshot
              // must already reflect its removal before the next phase is prepared.
              removeDeadEncounterStatuses(next.match);
            },
          });
          afterEnemy = enemyPhase.afterEnemy ?? presentationSnapshot(next.match);
          if (next.match.outcome) emit({ type: "outcome", outcome: next.match.outcome });
          next.undo = [];
          nextPendingUndo.length = 0;
          for (const id of ids) {
            const alive = Boolean(mech(next.match, id)) && !next.match.outcome;
            next.rights[id] = { move: alive, action: alive };
          }
          advanceCheckpoint = !next.match.outcome && String(next.match.phase) === "player_plan";
        }
      } else failure = "invalid_command";
      if (!failure) {
        removeDeadEncounterStatuses(next.match);
        for (let index = nextPendingUndo.length - 1; index >= 0; index--) {
          const move = nextPendingUndo[index]!, unit = mech(next.match, move.mech);
          if (!unit || unit.hp <= 0 || !next.rights[move.mech]?.action || !eq(unit.pos, move.to)) nextPendingUndo.splice(index, 1);
        }
      }
    } catch { failure = "rule_error"; }
    finally { swapEventSink(outer); }
    if (failure) return { ok: false, reason: failure };
    for (const id of ids) if (!mech(next.match, id)) next.rights[id] = { move: false, action: false };
    // Enemy helpers increment internally; the command is one external revision.
    next.match.revision = this.current.match.revision + 1;
    this.current = next;
    this.pendingUndo = nextPendingUndo;
    if (advanceCheckpoint) { this.checkpoint = clone(next); this.checkpointPendingUndo = clone(nextPendingUndo); }
    const finalPresentation = presentationSnapshot(next.match);
    const afterMovement = command.kind === "reset" ? null : movementSnapshot(before, events);
    const presentationStages: PresentationStages | null = afterMovement ? {
      before, afterMovement, afterPlayer: afterPlayer ?? finalPresentation, afterEnemy: afterEnemy ?? finalPresentation, afterPrepare: finalPresentation,
      ...(next.match.neural ? { neuralLogIndices: events.flatMap((event, index) => event.type === "neural_event" ? [index] : []) } : {}),
    } : null;
    const result: SequentialResult = { ok: true, snapshot: clone(next), events: clone(events), causalEvent: clone(causalEvent), presentationStages: clone(presentationStages) };
    this.journal.set(command.id, { fingerprint, result: clone(result) });
    this.history.push({ command: clone(command), revision: next.match.revision, events: clone(events), causalEvent: clone(causalEvent), snapshot: clone(next), presentationStages: clone(presentationStages) });
    return result;
  }
}
