import { applyStatus, endStatusTurn, statusBlocks, type Status, type StatusEvent } from "./statusEffects";

/** Versioned local encounter effects. The authority supplies confirmed hits, never forecasts. */
export const STATUS_ENCOUNTER_VERSION = "mecha-status-encounter:v1" as const;
export type StatusEncounterSkill = "spore_leap" | "ring_pierce" | "prism_frost" | "gravity_collision";
export type StatusHit = { skill: StatusEncounterSkill; source: string; target: string; targetAlive: boolean; hit: boolean };
const skillStatuses = {
  spore_leap: { kind: "poison", magnitude: 1, remainingTurns: 2 },
  ring_pierce: { kind: "burn", magnitude: 1, remainingTurns: 2 },
  prism_frost: { kind: "freeze", magnitude: 0, remainingTurns: 1 },
  gravity_collision: { kind: "stun", magnitude: 0, remainingTurns: 1 },
} as const;

/** A miss or a dead target is a no-op; a caller must report each confirmed hit once. */
export function applyEncounterHit(statuses: readonly Status[], hit: StatusHit): { statuses: Status[]; events: StatusEvent[] } {
  if (!hit || !Object.hasOwn(skillStatuses, hit.skill) || typeof hit.hit !== "boolean" || typeof hit.targetAlive !== "boolean") throw new Error("invalid_status_hit");
  // Validate identifiers and the ledger even for misses, without adding an effect.
  const template = skillStatuses[hit.skill];
  const result = applyStatus(statuses, { ...template, source: hit.source, target: hit.target });
  if (!result.ok) throw new Error(result.reason);
  return hit.hit && hit.targetAlive ? result : { statuses: structuredClone(statuses) as Status[], events: [] };
}

/** Called once at the end of the affected side's player turn, before enemy actions. */
export function finishEncounterStatusTurn(statuses: readonly Status[], target: string): { statuses: Status[]; events: StatusEvent[] } {
  const result = endStatusTurn(statuses, target);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

export function encounterStatusBlocks(statuses: readonly Status[], target: string): { move: boolean; action: boolean } {
  const result = statusBlocks(statuses, target);
  if (!result) throw new Error("invalid_status");
  return result;
}
