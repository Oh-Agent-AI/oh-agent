import { BUILDING_COLLISION_RULESET, MECH_IDS, emit, swapEventSink, type ArenaPlan, type Cell, type MatchState, type TurnEvent } from "./board";
import { beginEnemyPhase, validateAndApplyPlan } from "./combat";
import { resolveEnemyPhase } from "./execution/enemyPhase";
import { STATUS_ENCOUNTER_VERSION } from "./statusEncounter";
import { finishPlayerEncounterStatuses, removeDeadEncounterStatuses } from "./statusTurn";
import type { EnemyActorTrace } from "./enemy";

export type ThreatCancelReason = "" | "dead" | "frozen" | "stunned" | "no_target" | "battle_over";
export type ThreatStep = {
  actor: string;
  order: number;
  skill: string;
  cells: Cell[];
  position: Cell | null;
  cancel: ThreatCancelReason;
  /** Per-step HP deltas (after minus before); negative numbers are damage. */
  outcome: { hp: Record<string, number>; buildings: Record<string, number> };
};
export type EnemyPhasePreview = { ok: true; steps: ThreatStep[]; outcome: MatchState["outcome"] } | { ok: false; reason: string };

const copy = <T,>(value: T): T => structuredClone(value);
const emptyOutcome = () => ({ hp: {} as Record<string, number>, buildings: {} as Record<string, number> });
function healthDelta(before: MatchState, after: MatchState): ThreatStep["outcome"] {
  const outcome = emptyOutcome();
  for (const id of MECH_IDS) {
    const start = before.mechs.find(unit => unit.id === id)?.hp;
    const end = after.mechs.find(unit => unit.id === id)?.hp;
    if (start !== undefined && end !== undefined && start !== end) outcome.hp[id] = end - start;
  }
  for (const start of before.buildings) {
    const end = after.buildings.find(building => building.id === start.id);
    if (end && start.hp !== end.hp) outcome.buildings[start.id] = end.hp - start.hp;
  }
  return outcome;
}
function actorData(state: MatchState, actor: string): { alive: boolean; skill: string; cells: Cell[]; position: Cell | null } {
  if (actor === "boss") return { alive: state.boss.hp > 0, skill: state.boss.intent?.skillId ?? "skip", cells: copy(state.boss.intent?.projected ?? []), position: copy(state.boss.anchor) };
  const raider = state.raiders.find(unit => unit.id === actor);
  return raider ? { alive: raider.hp > 0, skill: raider.intent?.skillId ?? "skip", cells: copy(raider.intent?.projected ?? []), position: copy(raider.pos) }
    : { alive: false, skill: "skip", cells: [], position: null };
}
function actorCancel(before: MatchState, actor: string, events: TurnEvent[], after: MatchState): ThreatCancelReason {
  const data = actorData(before, actor);
  if (!data.alive) return "dead";
  if (after.outcome && !before.outcome) return "";
  if (events.some(event => event.type === "enemy" && event.actor === actor)) return "";
  // Special boss skills can resolve without a conventional enemy-attack event.
  if (events.some(event => event.type === "monster_status" || event.type === "status_effect")) return "";
  return "no_target";
}
function eventCells(events: TurnEvent[], actor: string, fallback: Cell[]): Cell[] {
  const event = events.find((entry): entry is Extract<TurnEvent, { type: "enemy" }> => entry.type === "enemy" && entry.actor === actor);
  return event ? copy(event.cells) : fallback;
}

/** Simulate the declared enemy phase on a clone, preserving actor and event order. */
export function previewEnemyPhase(input: MatchState, plan?: ArenaPlan): EnemyPhasePreview {
  const state = copy(input), events: TurnEvent[] = [], steps: ThreatStep[] = [];
  const actors = ["boss", ...state.raiders.map(raider => raider.id)];
  // swapEventSink is intentionally scoped to the clone; preview never appends to the live event stream.
  const outerEventSink = swapEventSink(events);
  let lastEventIndex = 0;
  let previousActorState = copy(state);
  let actorSourceState = copy(state);
  const pushStep = (actor: string, before: MatchState, after: MatchState, actorEvents: TurnEvent[]) => {
    const data = actorData(before, actor);
    steps.push({ actor, order: steps.length + 1, skill: data.skill, cells: eventCells(actorEvents, actor, data.cells), position: data.position,
      cancel: actorCancel(before, actor, actorEvents, after), outcome: healthDelta(before, after) });
  };
  try {
    if (plan) {
      if (state.phase !== "player_plan" || state.ruleset === BUILDING_COLLISION_RULESET) return { ok: false, reason: "invalid_classic_preview_state" };
      const applied = validateAndApplyPlan(state, plan);
      if (!("ok" in applied)) return { ok: false, reason: "invalid_plan" };
      previousActorState = copy(state);
      actorSourceState = copy(state);
      lastEventIndex = events.length;
    } else if (state.ruleset === BUILDING_COLLISION_RULESET && state.phase === "player_plan") {
      if (state.statusEncounter) {
        const before = copy(state), start = events.length;
        finishPlayerEncounterStatuses(state);
        emit({ type: "status_boundary", schema: "mecha-status-event:v1", phase: "player_end" });
        if (state.statusEncounter.schema === STATUS_ENCOUNTER_VERSION) {
          steps.push({ actor: "status", order: steps.length + 1, skill: "status_tick", cells: [], position: null, cancel: "", outcome: healthDelta(before, state) });
        }
        if (events.length > start) lastEventIndex = events.length;
      }
      if (!state.outcome) beginEnemyPhase(state);
      previousActorState = copy(state);
      actorSourceState = copy(state);
    } else if (state.phase !== "resolving_boss") return { ok: false, reason: "enemy_phase_not_ready" };

    resolveEnemyPhase(state, {
      capturePresentation: true,
      afterBoss: () => removeDeadEncounterStatuses(state),
      onActor: (trace: EnemyActorTrace) => {
        const actorEvents = events.slice(lastEventIndex);
        pushStep(trace.actor, trace.before, trace.after, actorEvents);
        lastEventIndex = events.length;
        previousActorState = copy(trace.after);
      },
    });
    // Corrosion and other round-boundary state changes follow the last actor.
    const environmentDelta = healthDelta(previousActorState, state);
    const actorTraces = steps.filter(step => step.actor !== "status");
    const boundaryEvents = events.slice(lastEventIndex);
    const showEnvironment = Object.keys(environmentDelta.hp).length || Object.keys(environmentDelta.buildings).length || boundaryEvents.some(event => event.type === "corrode_field" || event.type === "status_effect");
    // Include actors skipped because a prior step ended the match.
    const seen = new Set(actorTraces.map(step => step.actor));
    for (const actor of actors) if (!seen.has(actor)) {
      const data = actorData(actorSourceState, actor);
      steps.push({ actor, order: steps.length + 1, skill: data.skill, cells: data.cells, position: data.position,
        cancel: data.alive ? "battle_over" : "dead", outcome: emptyOutcome() });
    }
    if (showEnvironment) steps.push({ actor: "status", order: steps.length + 1, skill: "environment_tick", cells: [], position: null, cancel: "", outcome: environmentDelta });
    return { ok: true, steps, outcome: state.outcome };
  } catch {
    return { ok: false, reason: "enemy_phase_preview_failed" };
  } finally {
    swapEventSink(outerEventSink);
  }
}

