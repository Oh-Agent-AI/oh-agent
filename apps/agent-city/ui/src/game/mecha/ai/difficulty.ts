import { nextCommand } from "./commandPolicy";
import { nextCoordinatedCommand } from "./coordinatedPolicy";
import { nextBeamCommand } from "./beamPolicy";
import type { SequentialPolicy } from "./policy";

export type AiDifficulty = "greedy" | "coordinated" | "beam";
export const AI_DIFFICULTIES: readonly AiDifficulty[] = ["greedy", "coordinated", "beam"];

export function policyFor(difficulty: AiDifficulty): SequentialPolicy {
  if (difficulty === "greedy") return nextCommand;
  if (difficulty === "coordinated") return nextCoordinatedCommand;
  return nextBeamCommand;
}
