/** Validated health events for a presentation timeline. Does not mutate game state. */
import { healthSnapshot, type HealthEffect, type MatchState, type PresentationSnapshot, type PresentationStages, type TurnEvent } from "./board";
import { buildPresentationChanges, type PresentationChangeLogEvent } from "./presentationChanges";

export type HealthTimelineStep = { eventIndex: number; event: TurnEvent; effect: HealthEffect };
export type HealthTimeline = { ok: true; steps: HealthTimelineStep[] } | { ok: false; reason: string };
const key = (kind: string, id: string) => `${kind}:${id}`;

function snapshotHealth(snapshot: PresentationSnapshot): Map<string, number> | null {
  const entries: Array<[string, number]> = [
    [key("boss", "boss"), snapshot.boss.hp],
    ...snapshot.mechs.map((m): [string, number] => [key("mech", m.id), m.hp]),
    ...snapshot.raiders.map((r): [string, number] => [key("raider", r.id), r.hp]),
    ...snapshot.buildings.map((b): [string, number] => [key("building", b.id), b.hp]),
  ];
  const result = new Map(entries);
  return result.size === entries.length ? result : null;
}
function sameHealth(a: Map<string, number>, b: Map<string, number> | null): boolean {
  return b !== null && a.size === b.size && [...a].every(([id, hp]) => b.get(id) === hp);
}

/**
 * Lifecycle evidence is presentation-only until the rules emit it. Require the
 * complete, validated movement-to-enemy interval; a roster diff alone never
 * proves a birth, death or expiry. Health-only logs retain the legacy path.
 */
export function buildHealthTimeline(before: MatchState, after: MatchState, log: readonly PresentationChangeLogEvent[], stages?: PresentationStages | null): HealthTimeline {
  const values = new Map(healthSnapshot(before).map((v) => [key(v.kind, v.id), v.after]));
  const end = healthSnapshot(after);
  let hasLifecycle = false;
  for (const event of log) {
    if (!event || typeof event !== "object") return { ok: false, reason: "invalid event type" };
    const type = Object.getOwnPropertyDescriptor(event, "type");
    if (!type || !("value" in type)) return { ok: false, reason: "invalid event type" };
    if (type.value === "raider_spawn" || type.value === "raider_remove") hasLifecycle = true;
  }
  if (hasLifecycle) {
    if (!stages) return { ok: false, reason: "raider lifecycle requires presentation stages" };
    const start = healthSnapshot(before), finalValues = new Map(end.map(v => [key(v.kind, v.id), v.after]));
    if (values.size !== start.length || finalValues.size !== end.length ||
        !sameHealth(values, snapshotHealth(stages.afterMovement)) || !sameHealth(finalValues, snapshotHealth(stages.afterEnemy))) {
      return { ok: false, reason: "lifecycle health snapshots do not match" };
    }
    const verified = buildPresentationChanges(stages, log);
    if (!verified.ok) return { ok: false, reason: verified.reason };
    const steps: HealthTimelineStep[] = [];
    for (const change of verified.changes) {
      if (change.kind === "raider_spawn") {
        const id = key("raider", change.unit.id);
        if (values.has(id)) return { ok: false, reason: "duplicate health entity" };
        values.set(id, change.unit.hp);
      } else if (change.kind === "raider_remove") {
        const id = key("raider", change.unit.id);
        if (values.get(id) !== change.unit.hp) return { ok: false, reason: "raider removal health mismatch" };
        values.delete(id);
      } else if (change.kind === "health") {
        const e = change.effect, id = key(e.kind, e.id), event = log[change.eventIndex];
        if (!event || event.type === "raider_spawn" || event.type === "raider_remove" ||
            e.order !== steps.length || !Number.isFinite(e.before) || !Number.isFinite(e.after) ||
            e.before === e.after || values.get(id) !== e.before) {
          return { ok: false, reason: `health effect ${steps.length} is inconsistent` };
        }
        values.set(id, e.after);
        steps.push({ eventIndex: change.eventIndex, event, effect: e });
      }
    }
    if (!sameHealth(values, finalValues)) return { ok: false, reason: "health effects do not reconcile" };
    return { ok: true, steps };
  }
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
