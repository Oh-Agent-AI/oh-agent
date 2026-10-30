/** Validated health events for a presentation timeline. Does not mutate game state. */
import { healthSnapshot, type HealthEffect, type MatchState, type TurnEvent } from "./board";

export type HealthTimelineStep = { eventIndex: number; event: TurnEvent; effect: HealthEffect };
export type HealthTimeline = { ok: true; steps: HealthTimelineStep[] } | { ok: false; reason: string };
const key = (kind: string, id: string) => `${kind}:${id}`;

export function buildHealthTimeline(before: MatchState, after: MatchState, log: TurnEvent[]): HealthTimeline {
  const values = new Map(healthSnapshot(before).map((v) => [key(v.kind, v.id), v.after]));
  const end = healthSnapshot(after);
  if (values.size !== end.length || end.some((v) => !values.has(key(v.kind, v.id)))) return { ok: false, reason: "health entity set changed" };
  const steps = log.flatMap((event, eventIndex) => "effects" in event
    ? (event.effects ?? []).map((effect) => ({ eventIndex, event, effect })) : []);
  steps.sort((a, b) => a.effect.order - b.effect.order);
  for (let i = 0; i < steps.length; i++) {
    const e = steps[i]!.effect;
    const id = key(e.kind, e.id);
    if (e.order !== i || !Number.isFinite(e.before) || !Number.isFinite(e.after) || e.before === e.after || values.get(id) !== e.before) {
      return { ok: false, reason: `health effect ${i} is inconsistent` };
    }
    values.set(id, e.after);
  }
  if (end.some((v) => values.get(key(v.kind, v.id)) !== v.after)) return { ok: false, reason: "health effects do not reconcile" };
  return { ok: true, steps };
}
