import { MAX_TURNS, stakeBuildings, type MatchState, type Outcome, type TurnEvent } from "./board";
import type { HealthTimeline, HealthTimelineStep } from "./healthTimeline";

type FailureOutcome = Exclude<Outcome, "victory">;
export type FailureRecap = {
  outcome: FailureOutcome;
  /** The accepted turn, not the incremented post-timeout turn. */
  turn: number;
  decisive: HealthTimelineStep | null;
};

/** Explain only the final accepted turn; this is not a full-match causal analysis. */
export function buildFailureRecap(
  state: MatchState | null | undefined,
  log: readonly TurnEvent[],
  timeline?: HealthTimeline | null,
): FailureRecap | null {
  if (!state || state.phase !== "finished" || !state.outcome || state.outcome === "victory") return null;
  const outcome = state.outcome;
  const turn = outcome === "defeat_timeout" ? Math.min(state.turn, MAX_TURNS) : state.turn;
  const result: FailureRecap = { outcome, turn, decisive: null };
  if (outcome === "defeat_timeout" || !timeline?.ok) return result;
  const outcomeEvents = log.filter((event) => event.type === "outcome");
  if (outcomeEvents.length !== 1 || outcomeEvents[0]?.outcome !== outcome) return result;

  const victims = outcome === "defeat_wipe" ? state.mechs : stakeBuildings(state);
  if (!victims.length || victims.some((victim) => victim.hp > 0)) return result;
  const ids = new Set(victims.map((victim) => victim.id));
  const kind = outcome === "defeat_wipe" ? "mech" : "building";
  // The timeline is already reconciled by the controller. Reject a timeline from
  // another log rather than attributing a stale event to the current battle.
  if (timeline.steps.some((step) => log[step.eventIndex] !== step.event)) return result;
  for (const step of timeline.steps) {
    const e = step.effect;
    if (e.kind === kind && ids.has(e.id) && e.before > 0 && e.after <= 0) result.decisive = step;
  }
  return result;
}
