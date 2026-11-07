/** Local v1.5 view adapter. No persistence, network, DOM or Three.js access. */
import { BUILDING_COLLISION_RULESET, eq, mech, swapEventSink, type Action, type Cell, type MatchState, type MechId, type PresentationStages, type TurnEvent } from "./board";
import { applyDeployPlan, deployableCells, deploymentCellFault, validateDeployPlan, type DeployPlacement } from "./deployment";
import { SequentialTurn, type SequentialRecord } from "./sequentialTurn";
import { canonicalJson } from "./contracts/match";
import { catalogSupports } from "./monsters/catalog";
import { nextCoordinatedCommand } from "./ai/coordinatedPolicy";
import { restoreSequentialSnapshot } from "./session/SequentialMatchSession";
import type { SequentialSnapshot } from "./contracts/sequentialTransport";
import { SequentialDurableAuthority, type SequentialDurableStore } from "./sequentialDurable";

export type CommandInput =
  | { kind: "move"; mech: MechId; to: Cell }
  | { kind: "undo"; mech: MechId }
  | { kind: "act"; mech: MechId; action: Action }
  | { kind: "reset" }
  | { kind: "end"; confirmUnused: boolean };
export type SequentialControllerView = {
  match: MatchState;
  selected: MechId;
  placements: DeployPlacement[] | null;
  deployable: Cell[];
  canConfirmDeployment: boolean;
  canUndoPlacement: boolean;
  rights: ReturnType<SequentialTurn["snapshot"]>["rights"] | null;
  activity: ReturnType<SequentialTurn["turnActivity"]> | null;
  openingPlacements: DeployPlacement[] | null;
  canUndo: boolean;
  undoMech: MechId | null;
  resetUsed: boolean;
  /** Recorded command effect; input remains locked until presentation acknowledges it. */
  presentation: { before: MatchState; events: TurnEvent[]; stages: PresentationStages | null } | null;
  error: string | null;
  persistence: "inactive" | "ready" | "saving" | "unconfirmed";
};
const copy = <T,>(value: T): T => structuredClone(value);

export class SequentialController {
  private state: MatchState;
  private authority: SequentialTurn | null;
  private selected: MechId = "Assault";
  private placements: DeployPlacement[] = [];
  private deploymentHistory: DeployPlacement[][] = [];
  private openingPlacements: DeployPlacement[] | null = null;
  private presentation: SequentialControllerView["presentation"] = null;
  private error: string | null = null;
  private durable: SequentialDurableAuthority | null = null;
  private saving = false;
  private serial = 0;
  private readonly listeners = new Set<() => void>();
  private deploymentStart: MatchState | null;
  private view!: SequentialControllerView;
  constructor(initial: MatchState) {
    if (initial.ruleset !== BUILDING_COLLISION_RULESET || initial.outcome || !["deployment", "player_plan"].includes(initial.phase)) throw new Error("invalid_sequential_controller_start");
    if (initial.statusEncounter !== undefined && (initial.statusEncounter?.schema !== "mecha-status-encounter:v1" ||
        !Array.isArray(initial.statusEncounter.statuses) || initial.statusEncounter.statuses.length !== 0 ||
        !catalogSupports(initial.monsterContent?.speciesId, "mecha-v1.5") ||
        initial.monsterContent?.contentVersion !== 1 || initial.mission !== undefined)) throw new Error("status_encounter_not_available");
    this.state = copy(initial);
    this.deploymentStart = initial.phase === "deployment" ? copy(initial) : null;
    this.authority = initial.phase === "player_plan" ? new SequentialTurn(initial) : null;
    this.initial = this.authority ? copy(initial) : null;
    this.rebuild();
  }
  getState = (): SequentialControllerView => this.view;
  /** Replace the live authority with a verified handoff snapshot; used when remote stops. */
  replaceFromSnapshot(snapshot: SequentialSnapshot): void {
    const turn = restoreSequentialSnapshot(snapshot);
    this.state = copy(turn.snapshot().match);
    this.authority = turn;
    this.initial = copy(snapshot.initial);
    this.openingPlacements = copy(snapshot.placements);
    this.deploymentStart = copy(snapshot.initial);
    this.presentation = null;
    this.error = null;
    this.publish();
  }
  /** Deterministic one-step suggestion; never mutates the live authority. */
  suggest(): CommandInput | null {
    if (!this.authority || this.presentation || this.saving || this.durable?.needsReload() || this.state.outcome || this.state.phase !== "player_plan") return null;
    const intent = nextCoordinatedCommand(this.authority);
    return intent.kind === "end" ? { kind: "end", confirmUnused: true } : intent;
  }

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private rebuild(): void {
    const deployment = this.state.phase === "deployment", authority = this.authority?.snapshot();
    const undoMech = this.authority?.undoMech() ?? null;
    this.view = {
      match: copy(this.state), selected: this.selected, placements: deployment ? copy(this.placements) : null,
      deployable: deployment ? deployableCells(this.state) : [],
      canConfirmDeployment: deployment && validateDeployPlan(this.state, { revision: this.state.revision, placements: this.placements }).ok,
      canUndoPlacement: deployment && this.deploymentHistory.length > 0,
      rights: authority?.rights ?? null, canUndo: undoMech === this.selected, undoMech, resetUsed: authority?.resetUsed ?? false,
      activity: this.authority?.turnActivity() ?? null, openingPlacements: copy(this.openingPlacements),
      presentation: this.presentation ? copy(this.presentation) : null, error: this.error,
      persistence: this.saving ? "saving" : this.durable?.needsReload() ? "unconfirmed" : this.durable ? "ready" : "inactive",
    };
  }
  private publish(): void { this.rebuild(); for (const fn of [...this.listeners]) fn(); }
  select(id: MechId): void {
    if (this.presentation || this.saving || this.durable?.needsReload() || !mech(this.state, id)) return;
    this.selected = id; this.error = null; this.publish();
  }
  place(id: MechId, cell: Cell): void {
    if (this.state.phase !== "deployment" || this.presentation || !mech(this.state, id)) return;
    const fault = deploymentCellFault(this.state, cell);
    if (fault) { this.error = fault.code; this.publish(); return; }
    const next = copy(this.placements), current = next.find(p => p.mechId === id), occupant = next.find(p => p.mechId !== id && eq(p.pos, cell));
    if (current && eq(current.pos, cell)) { this.selected = id; this.error = null; this.publish(); return; }
    if (occupant && !current) { this.error = "duplicate_cell"; this.publish(); return; }
    if (occupant && current) occupant.pos = { ...current.pos };
    if (current) current.pos = { ...cell }; else next.push({ mechId: id, pos: { ...cell } });
    this.deploymentHistory.push(copy(this.placements)); this.placements = next; this.selected = id; this.error = null; this.publish();
  }
  undoPlacement(): void {
    if (this.state.phase !== "deployment" || !this.deploymentHistory.length || this.presentation) return;
    this.placements = this.deploymentHistory.pop()!; this.error = null; this.publish();
  }
  resetPlacement(): void {
    if (this.state.phase !== "deployment" || !this.placements.length || this.presentation || this.saving) return;
    this.deploymentHistory.push(copy(this.placements)); this.placements = []; this.error = null; this.publish();
  }
  confirmDeployment(): void {
    if (this.state.phase !== "deployment" || this.presentation) return;
    const result = applyDeployPlan(this.state, { revision: this.state.revision, placements: this.placements });
    if (!result.ok) { this.error = result.fault.code; this.publish(); return; }
    this.openingPlacements = copy(this.placements);
    this.state = result.state;
    this.authority = result.state.outcome ? null : new SequentialTurn(result.state);
    this.initial = this.authority ? copy(result.state) : null;
    this.placements = []; this.deploymentHistory = []; this.error = null; this.publish();
  }
  private commandInput(input: CommandInput) {
    if (input.kind !== "undo") return input;
    if (input.mech !== this.selected || input.mech !== this.authority?.undoMech()) return null;
    return { kind: "undo" } as const;
  }
  /** Validate against a detached trial fork; never change current state or event sink. */
  preview(input: CommandInput): ReturnType<SequentialTurn["execute"]> | null {
    if (!this.authority || this.presentation || this.saving || this.durable?.needsReload()) return null;
    const command = this.commandInput(input);
    return command ? this.authority.trial({ ...command, id: `preview-${this.serial}`, revision: this.state.revision }) : null;
  }
  private initial: MatchState | null = null;
  private authorityInitial(): MatchState {
    if (!this.initial) throw new Error("sequential_initial_unavailable");
    return this.initial;
  }
  execute(input: CommandInput): void {
    if (!this.authority || this.presentation || this.durable) return;
    const command = this.commandInput(input);
    if (!command) return;
    const before = copy(this.state);
    const result = this.authority.execute({ ...command, id: `local-${++this.serial}`, revision: this.state.revision });
    if (!result.ok) { this.error = result.reason; this.publish(); return; }
    this.state = result.snapshot.match;
    this.presentation = result.events.length ? { before, events: result.events, stages: result.presentationStages } : null;
    this.error = null; this.publish();
  }
  finishPresentation(): void { if (this.presentation) { this.presentation = null; this.publish(); } }
  /** Install write-ahead storage only after the opening or checkpoint is verified. */
  attachDurable(store: SequentialDurableStore): boolean {
    if (!this.authority || !this.initial || this.presentation || this.saving || this.durable) return false;
    try {
      const records = this.authority.records();
      // Persisted v1.5 IDs are deterministic, so replay preserves the IDs
      // that were actually committed rather than rewriting live identifiers.
      if (records.some((record, index) => record.command.id !== `c${index}`)) return false;
      this.durable = new SequentialDurableAuthority(this.initial, records, store); this.publish(); return true;
    }
    catch { return false; }
  }
  async executeDurable(input: CommandInput): Promise<void> {
    if (!this.durable || !this.authority || this.presentation || this.saving || this.durable.needsReload()) return;
    const command = this.commandInput(input);
    if (!command) return;
    const before = copy(this.state), revision = this.state.revision;
    this.saving = true; this.error = null; this.publish();
    try {
      const result = await this.durable.execute({ ...command, id: `c${this.durable.recordCount()}`, revision });
      if (!result.ok) { this.error = result.reason; return; }
      this.authority = SequentialTurn.replay(this.authorityInitial(), this.durable.records());
      this.state = result.snapshot.match;
      this.presentation = result.events.length ? { before, events: result.events, stages: result.presentationStages } : null;
    } catch {
      this.durable.invalidate(); this.error = "storage_unconfirmed";
    } finally { this.saving = false; this.publish(); }
  }
  records(): SequentialRecord[] { return this.authority?.records() ?? []; }
  hasReplayEvidence(): boolean { return Boolean(this.openingPlacements && this.initial && this.authority?.recordCount()); }
  restartDeployment(): boolean {
    if (!this.deploymentStart || this.saving) return false;
    this.state = copy(this.deploymentStart); this.authority = null; this.durable = null; this.initial = null;
    this.openingPlacements = null; this.placements = []; this.deploymentHistory = []; this.presentation = null;
    this.serial = 0; this.error = null; this.selected = "Assault"; this.publish(); return true;
  }
  /** Reconstruct the whole authority before replacing the live match. */
  canRestore(evidence: { placements: DeployPlacement[]; initial: MatchState; records: SequentialRecord[] }): boolean {
    if (!this.deploymentStart || this.presentation || this.saving) return false;
    try {
      const deployed = applyDeployPlan(this.deploymentStart, { revision: this.deploymentStart.revision, placements: evidence.placements });
      if (!deployed.ok || canonicalJson(deployed.state) !== canonicalJson(evidence.initial)) return false;
      const snapshot = SequentialTurn.replay(evidence.initial, evidence.records).snapshot();
      return !snapshot.match.outcome && snapshot.match.phase === "player_plan" && evidence.records.every(record => {
        const match = /^local-(\d+)$/.exec(record.command.id);
        return !match || (Number.isSafeInteger(Number(match[1])) && Number(match[1]) < Number.MAX_SAFE_INTEGER);
      });
    } catch { return false; }
  }
  restore(evidence: { placements: DeployPlacement[]; initial: MatchState; records: SequentialRecord[] }): boolean {
    if (!this.deploymentStart || this.presentation || this.saving) return false;
    try {
      const deployed = applyDeployPlan(this.deploymentStart, { revision: this.deploymentStart.revision, placements: evidence.placements });
      if (!deployed.ok || canonicalJson(deployed.state) !== canonicalJson(evidence.initial)) return false;
      const session = SequentialTurn.replay(evidence.initial, evidence.records);
      const snapshot = session.snapshot();
      if (snapshot.match.outcome || snapshot.match.phase !== "player_plan") return false;
      let serial = 0;
      for (const record of evidence.records) {
        const match = /^local-(\d+)$/.exec(record.command.id);
        if (!match) continue;
        const value = Number(match[1]);
        if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) return false;
        serial = Math.max(serial, value);
      }
      this.initial = copy(evidence.initial); this.openingPlacements = copy(evidence.placements);
      this.authority = session; this.durable = null; this.state = snapshot.match; this.serial = serial;
      this.placements = []; this.deploymentHistory = []; this.presentation = null; this.error = null;
      this.selected = this.state.mechs.find(unit => unit.hp > 0)?.id ?? "Assault";
      this.publish(); return true;
    } catch { return false; }
  }
  /** Return a detached opening and committed commands, never a mutable authority reference. */
  replayEvidence(): { placements: DeployPlacement[]; initial: MatchState; records: SequentialRecord[] } | null {
    if (!this.initial || !this.openingPlacements || !this.authority) return null;
    return { placements: copy(this.openingPlacements), initial: copy(this.initial), records: this.authority.records() };
  }
}
