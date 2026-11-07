import type { DeployPlacement } from "./deployment";
import type { MatchState } from "./board";
import type { SequentialCommand, SequentialRecord } from "./sequentialTurn";

export type SequentialOpening = Readonly<{
  initial: MatchState;
  placements: DeployPlacement[];
  commands: SequentialCommand[];
}>;

/**
 * Handoff carries the opening plus accepted commands only. The receiver rebuilds
 * through SequentialTurn, so a stale revision or altered command cannot be hidden
 * inside a copied snapshot.
 */
export function buildSequentialOpening(evidence: { initial: MatchState; placements: DeployPlacement[]; records: readonly SequentialRecord[] }): SequentialOpening {
  return {
    initial: structuredClone(evidence.initial),
    placements: structuredClone(evidence.placements),
    commands: evidence.records.map(record => structuredClone(record.command)),
  };
}
