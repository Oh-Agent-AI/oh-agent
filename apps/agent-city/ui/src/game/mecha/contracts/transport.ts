import { MECHA_NET_PROTOCOL, type MatchErrorCode, type MatchEvent, type MatchResult, type MatchSnapshot, type RevisionState, type TurnResolved } from "./match";

export type RemoteMethod = "match.snapshot" | "plan.submit" | "match.concede" | "match.close";
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
  return arena?.schema === "mecha-arena:v1" && state !== null && revision(state.revision) && state.revision === snapshot.revision;
}

function validTurn(value: unknown): value is TurnResolved {
  const turn = record(value);
  if (!turn || turn.type !== "turn.resolved" || turn.protocol !== MECHA_NET_PROTOCOL || typeof turn.matchId !== "string"
    || typeof turn.playerId !== "string" || typeof turn.commandId !== "string" || !revision(turn.revision) || !Array.isArray(turn.log)) return false;
  const state = record(turn.state);
  return state !== null && revision(state.revision) && state.revision === turn.revision
    && (turn.presentationStages === null || record(turn.presentationStages) !== null);
}

export function parseRemoteMessage(value: unknown): RemoteMessage<RevisionState> | null {
  const message = record(value);
  if (!message || message.protocol !== MECHA_NET_PROTOCOL) return null;
  if (message.type === "response" && typeof message.requestId === "string" && record(message.result)) return message as RemoteResponse;
  if (message.type === "event" && record(message.event)) return message as RemoteNotification<RevisionState>;
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
