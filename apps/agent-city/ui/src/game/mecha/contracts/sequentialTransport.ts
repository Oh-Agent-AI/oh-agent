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
