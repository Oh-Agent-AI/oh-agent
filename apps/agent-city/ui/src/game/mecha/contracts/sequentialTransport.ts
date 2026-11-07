import type { MatchState, PresentationStages, TurnEvent } from "../board";
import type { DeployPlacement } from "../deployment";
import type { SequentialCommand } from "../sequentialTurn";

/** v2 carries command-stream snapshots; it does not reinterpret v1 plan messages. */
export const SEQUENTIAL_NET_PROTOCOL = "mecha-net:v2" as const;
export type SequentialProtocol = typeof SEQUENTIAL_NET_PROTOCOL;

export type SequentialSnapshot = {
  protocol: SequentialProtocol;
  matchId: string;
  ruleset: "mecha-v1.5";
  revision: number;
  initial: MatchState;
  placements: DeployPlacement[];
  commands: SequentialCommand[];
};

export type SequentialCommandResult =
  | { ok: true; snapshot: SequentialSnapshot; events: TurnEvent[]; presentationStages: PresentationStages | null }
  | { ok: false; error: { code: "stale_revision" | "duplicate_command" | "invalid_command" | "match_finished" | "match_not_found" } };

export type SequentialSnapshotResult =
  | { ok: true; snapshot: SequentialSnapshot }
  | { ok: false; error: { code: "match_not_found" } };

export type SequentialMethod = "sequential.snapshot" | "sequential.command.submit";
export type SequentialRequest = {
  protocol: SequentialProtocol;
  type: "request";
  requestId: string;
  method: SequentialMethod;
  payload: { matchId: string; baseRevision?: number; command?: unknown };
};
export type SequentialResponse = {
  protocol: SequentialProtocol;
  type: "response";
  requestId: string;
  result: SequentialSnapshotResult | SequentialCommandResult;
};

const snapshotError = (value: unknown): value is { ok: false; error: { code: "match_not_found" } } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>, error = result.error as Record<string, unknown> | undefined;
  return result.ok === false && error?.code === "match_not_found";
};
const commandError = new Set(["stale_revision", "duplicate_command", "invalid_command", "match_finished", "match_not_found"]);

export function parseSequentialSnapshotResult(value: unknown): SequentialSnapshotResult | null {
  if (snapshotError(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.ok !== true || !result.snapshot || typeof result.snapshot !== "object") return null;
  const snapshot = result.snapshot as Record<string, unknown>;
  const initial = snapshot.initial as Record<string, unknown> | undefined;
  if (snapshot.protocol !== SEQUENTIAL_NET_PROTOCOL || snapshot.ruleset !== "mecha-v1.5" ||
      typeof snapshot.matchId !== "string" || !Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0 ||
      !Array.isArray(snapshot.placements) || !Array.isArray(snapshot.commands) || !initial ||
      initial.ruleset !== "mecha-v1.5") return null;
  return value as SequentialSnapshotResult;
}

export function parseSequentialCommandResult(value: unknown): SequentialCommandResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.ok === true) return parseSequentialSnapshotResult({ ok: true, snapshot: result.snapshot }) ? value as SequentialCommandResult : null;
  if (result.ok !== false) return null;
  const error = result.error as Record<string, unknown> | undefined;
  return error && typeof error.code === "string" && commandError.has(error.code) ? value as SequentialCommandResult : null;
}
