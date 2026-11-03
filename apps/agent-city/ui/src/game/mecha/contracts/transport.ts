import { MECHA_NET_PROTOCOL, type DeploymentResult, type MatchErrorCode, type MatchEvent, type MatchResult, type MatchSnapshot, type RevisionState, type TurnResolved } from "./match";

export type RemoteMethod = "match.snapshot" | "deployment.submit" | "plan.submit" | "match.concede" | "match.concede-v2" | "match.close";
export type RemoteRequest = {
  protocol: typeof MECHA_NET_PROTOCOL;
  type: "request";
  requestId: string;
  method: RemoteMethod;
  payload: unknown;
};
export type RemoteResponse = {
  protocol: typeof MECHA_NET_PROTOCOL;
  type: "response";
  requestId: string;
  result: MatchResult<unknown>;
};
export type RemoteNotification<S extends RevisionState> = {
  protocol: typeof MECHA_NET_PROTOCOL;
  type: "event";
  event: MatchEvent<S>;
};
export type RemoteMessage<S extends RevisionState> = RemoteResponse | RemoteNotification<S>;

const errorCodes = new Set<MatchErrorCode>([
  "unauthenticated", "forbidden", "not_your_turn", "stale_revision", "duplicate_command", "invalid_plan",
  "invalid_message", "message_too_large", "match_not_found", "match_finished", "room_closed", "host_offline",
  "ruleset_mismatch", "rate_limited", "unavailable",
]);
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const revision = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function errorResult(value: unknown): MatchResult<never> | null {
  const result = record(value);
  if (!result || result.ok !== false) return null;
  const error = record(result.error);
  return error && typeof error.code === "string" && errorCodes.has(error.code as MatchErrorCode)
    ? value as MatchResult<never> : null;
}

function validSnapshot(value: unknown): value is MatchSnapshot {
  const snapshot = record(value);
  if (!snapshot || snapshot.protocol !== MECHA_NET_PROTOCOL || typeof snapshot.matchId !== "string"
    || (snapshot.mode !== "pve" && snapshot.mode !== "pvp") || typeof snapshot.ruleset !== "string"
    || (snapshot.status !== "active" && snapshot.status !== "finished" && snapshot.status !== "closed") || !revision(snapshot.revision)
    || !Array.isArray(snapshot.players)) return false;
  const arena = record(snapshot.arena);
  const state = record(snapshot.state);
  return arena?.schema === "mecha-arena:v1" && state !== null && state.ruleset === snapshot.ruleset && revision(state.revision) && state.revision === snapshot.revision;
}

function validTurn(value: unknown): value is TurnResolved {
  const turn = record(value);
  if (!turn || turn.type !== "turn.resolved" || turn.protocol !== MECHA_NET_PROTOCOL || typeof turn.matchId !== "string"
    || typeof turn.playerId !== "string" || typeof turn.commandId !== "string" || !revision(turn.revision) || !Array.isArray(turn.log)) return false;
  const state = record(turn.state);
  return state !== null && typeof state.ruleset === "string" && revision(state.revision) && state.revision === turn.revision
    && (turn.presentationStages === null || record(turn.presentationStages) !== null);
}

export function parseRemoteMessage(value: unknown): RemoteMessage<RevisionState> | null {
  const message = record(value);
  if (!message || message.protocol !== MECHA_NET_PROTOCOL) return null;
  if (message.type === "response" && typeof message.requestId === "string" && record(message.result)) return message as RemoteResponse;
  if (message.type === "event") {
    const event = record(message.event);
    if (!event) return null;
    if (event.type === "turn.resolved" && validTurn(event.result)) return message as RemoteNotification<RevisionState>;
    if (event.type === "match.replaced" && validSnapshot(event.snapshot)) return message as RemoteNotification<RevisionState>;
    if (event.type === "match.closed" && typeof event.matchId === "string" && revision(event.revision)) return message as RemoteNotification<RevisionState>;
  }
  return null;
}

export function snapshotResult<S extends RevisionState = RevisionState>(value: unknown): MatchResult<MatchSnapshot<S>> | null {
  const failure = errorResult(value);
  if (failure) return failure;
  const result = record(value);
  return result?.ok === true && validSnapshot(result.value) ? value as MatchResult<MatchSnapshot<S>> : null;
}

export function turnResult<S extends RevisionState = RevisionState>(value: unknown): MatchResult<TurnResolved<S>> | null {
  const failure = errorResult(value);
  if (failure) return failure;
  const result = record(value);
  return result?.ok === true && validTurn(result.value) ? value as MatchResult<TurnResolved<S>> : null;
}

// Deployment failures use their own bounded fault vocabulary. Do not accept
// arbitrary error fields that could be rendered or forwarded to another device.
export function deploymentResult<S extends RevisionState = RevisionState>(value: unknown): DeploymentResult<S> | null {
  const result = record(value);
  if (!result || Object.keys(result).some(key => key !== "ok" && key !== "value" && key !== "error")) return null;
  if (result.ok === true) {
    if (Object.hasOwn(result, "error") || !validSnapshot(result.value)) return null;
    const snapshot = result.value as unknown as MatchSnapshot<S>;
    return snapshot.mode === "pve" ? { ok: true, value: snapshot } : null;
  }
  if (result.ok !== false || Object.hasOwn(result, "value")) return null;
  const error = record(result.error);
  if (!error || typeof error.code !== "string" || Object.keys(error).some(key => key !== "code" && key !== "fault")) return null;
  if (error.code !== "invalid_deployment") {
    return errorCodes.has(error.code as MatchErrorCode) && !Object.hasOwn(error, "fault")
      ? { ok: false, error: { code: error.code as MatchErrorCode } } : null;
  }
  const fault = record(error.fault);
  const faults = new Set(["phase", "revision", "incomplete", "duplicate_mech", "invalid_cell", "outside_zone", "terrain", "unsafe", "occupied", "reserved", "duplicate_cell", "insufficient_space"]);
  if (!fault || typeof fault.code !== "string" || !faults.has(fault.code)
    || Object.keys(fault).some(key => key !== "code" && key !== "mechId")
    || (Object.hasOwn(fault, "mechId") && !["Assault", "Gunner", "Support"].includes(fault.mechId as string))) return null;
  return value as DeploymentResult<S>;
}
