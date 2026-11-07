import { bossPrepare, type MatchState } from "../rules";
export { pveRules } from "../rules/pve";
import {
  MECHA_NET_PROTOCOL, canonicalJson, parseSubmitDeployment,
  type MatchEvent, type MatchMode, type MatchPlayer, type MatchResult, type MatchRuleAdapter,
  type MatchSnapshot, type MatchStatus, type RevisionState, type SubmitPlanCommand, type TurnResolved,
  type SubmitDeploymentCommand, type DeploymentResult,
} from "../contracts/match";
import type { RemoteArenaV1 } from "../contracts/arena";
import type { PlanFault } from "../rules";

type Options<S extends RevisionState> = {
  matchId: string;
  mode: MatchMode;
  state: S;
  arena: RemoteArenaV1;
  players: MatchPlayer[];
  rules: MatchRuleAdapter<S>;
};

type JournalEntry<S extends RevisionState> =
  | { kind: "turn"; fingerprint: string; result: TurnResolved<S> }
  | { kind: "deployment"; fingerprint: string; result: MatchSnapshot<S> }
;
const clone = <T>(value: T): T => structuredClone(value);
const failure = <T>(code: "forbidden" | "not_your_turn" | "stale_revision" | "duplicate_command" | "invalid_plan" | "match_finished" | "room_closed" | "unavailable", fault?: PlanFault): MatchResult<T> => ({
  ok: false,
  error: {
    code: fault?.code === "STALE_REVISION" ? "stale_revision" : code,
    ...(fault ? { fault: { code: fault.code, ...(fault.mechId ? { mechId: fault.mechId } : {}), ...(fault.cause ? { cause: fault.cause } : {}) } } : {}),
  },
});

export class MatchSession<S extends RevisionState = MatchState> {
  private state: S;
  private status: MatchStatus;
  private readonly listeners = new Set<(event: MatchEvent<S>) => void>();
  private readonly journal = new Map<string, JournalEntry<S>>();
  private readonly options: Options<S>;

  constructor(options: Options<S>) {
    this.options = options;
    if (!options.players.some((player) => player.role === "host" && player.side === "A")) throw new Error("match_host_required");
    if (new Set(options.players.map((player) => player.playerId)).size !== options.players.length) throw new Error("match_players_not_unique");
    if (options.arena.ruleset !== options.rules.ruleset) throw new Error("ruleset_mismatch");
    // A versioned state must never be admitted under another adapter's identity.
    if ("ruleset" in options.state && options.state.ruleset !== options.rules.ruleset) throw new Error("ruleset_mismatch");
    this.state = clone(options.state);
    this.status = options.rules.isFinished(this.state) ? "finished" : "active";
  }

  snapshot(playerId: string): MatchResult<MatchSnapshot<S>> {
    if (!this.player(playerId)) return failure("forbidden");
    return {
      ok: true,
      value: clone({
        protocol: MECHA_NET_PROTOCOL,
        matchId: this.options.matchId,
        mode: this.options.mode,
        ruleset: this.options.rules.ruleset,
        status: this.status,
        revision: this.state.revision,
        players: this.options.players,
        arena: this.options.arena,
        state: this.state,
      }),
    };
  }

  submitPlan(playerId: string, command: SubmitPlanCommand): MatchResult<TurnResolved<S>> {
    const player = this.player(playerId);
    if (!player || command.matchId !== this.options.matchId || command.playerId !== playerId) return failure("forbidden");
    const journalKey = JSON.stringify([playerId, command.commandId]);
    const fingerprint = canonicalJson({ baseRevision: command.baseRevision, plan: command.plan });
    const previous = this.journal.get(journalKey);
    if (previous) return previous.kind === "turn" && previous.fingerprint === fingerprint ? { ok: true, value: clone(previous.result) } : failure("duplicate_command");
    if (this.status === "closed") return failure("room_closed");
    if (this.status === "finished") return failure("match_finished");
    if (command.baseRevision !== this.state.revision || command.plan.revision !== this.state.revision) return failure("stale_revision");
    if (this.options.rules.activeSide(this.state) !== player.side) return failure("not_your_turn");

    const result = this.options.rules.playTurn(this.state, command.plan);
    if (!result.ok) return failure("invalid_plan", result.fault);
    this.state = clone(result.state);
    this.status = this.options.rules.isFinished(this.state) ? "finished" : "active";
    const resolved: TurnResolved<S> = {
      type: "turn.resolved",
      protocol: MECHA_NET_PROTOCOL,
      matchId: this.options.matchId,
      playerId,
      commandId: command.commandId,
      revision: this.state.revision,
      state: clone(this.state),
      log: clone(result.log),
      presentationStages: clone(result.presentationStages),
    };
    this.remember(journalKey, { kind: "turn", fingerprint, result: resolved });
    this.publish({ type: "turn.resolved", result: resolved });
    return { ok: true, value: clone(resolved) };
  }

  /** Internal PvE authority only. No transport method exposes this yet. */
  submitDeployment(playerId: string, input: SubmitDeploymentCommand): DeploymentResult<S> {
    const parsed = parseSubmitDeployment(input);
    if (!parsed.ok) return parsed;
    const command = parsed.value;
    const player = this.player(playerId);
    if (!player || player.role !== "host" || player.side !== "A" || command.matchId !== this.options.matchId || command.playerId !== playerId) return { ok: false, error: { code: "forbidden" } };
    if (this.options.mode !== "pve" || !this.options.rules.deploy) return { ok: false, error: { code: "unavailable" } };
    const journalKey = JSON.stringify([playerId, command.commandId]);
    const fingerprint = canonicalJson({ baseRevision: command.baseRevision, plan: command.plan });
    const previous = this.journal.get(journalKey);
    if (previous) return previous.kind === "deployment" && previous.fingerprint === fingerprint
      ? { ok: true, value: clone(previous.result) } : { ok: false, error: { code: "duplicate_command" } };
    if (this.status === "closed") return { ok: false, error: { code: "room_closed" } };
    if (this.status === "finished") return { ok: false, error: { code: "match_finished" } };
    if (command.baseRevision !== this.state.revision) return { ok: false, error: { code: "stale_revision" } };
    // A buggy adapter must not partially mutate the authority on rejection.
    const result = this.options.rules.deploy(clone(this.state), command.plan);
    if (!result.ok) return { ok: false, error: { code: "invalid_deployment", fault: clone(result.fault) } };
    if (result.state.revision !== this.state.revision + 1 || !Number.isSafeInteger(result.state.revision)) return { ok: false, error: { code: "unavailable" } };
    this.state = clone(result.state);
    this.status = this.options.rules.isFinished(this.state) ? "finished" : "active";
    const snapshot = this.snapshot(playerId);
    if (!snapshot.ok) throw new Error("deployment_owner_missing");
    this.remember(journalKey, { kind: "deployment", fingerprint, result: snapshot.value });
    this.publish({ type: "match.replaced", snapshot: snapshot.value });
    return { ok: true, value: clone(snapshot.value) };
  }

  close(playerId: string): MatchResult<MatchSnapshot<S>> {
    const player = this.player(playerId);
    if (!player || player.role !== "host") return failure("forbidden");
    if (this.status !== "closed") {
      this.status = "closed";
      this.publish({ type: "match.closed", matchId: this.options.matchId, revision: this.state.revision });
    }
    return this.snapshot(playerId);
  }

  subscribe(listener: (event: MatchEvent<S>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private player(playerId: string): MatchPlayer | undefined {
    return this.options.players.find((player) => player.playerId === playerId);
  }

  private remember(key: string, entry: JournalEntry<S>) {
    this.journal.set(key, clone(entry));
    if (this.journal.size > 256) this.journal.delete(this.journal.keys().next().value!);
  }

  private publish(event: MatchEvent<S>) {
    for (const listener of [...this.listeners]) listener(clone(event));
  }
}

export function initialPveMatch(state: MatchState): MatchState {
  const next = clone(state);
  if (next.phase === "enemy_prepare") bossPrepare(next);
  return next;
}
