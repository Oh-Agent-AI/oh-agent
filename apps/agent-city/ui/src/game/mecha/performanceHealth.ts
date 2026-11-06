/** Map validated rule health changes to the end of their corresponding presentation cue.
 * This is a coarse projection, not a recording of animation frames or hit timing.
 */
import type { MechaPerformanceEvent } from "./performance";
import type { HealthTimeline } from "./healthTimeline";
import type { HealthEffect } from "./board";
import type { PresentationChanges } from "./presentationChanges";

export type PerformanceHealthSchedule = HealthEffect[][];
export const healthKey = (kind: HealthEffect["kind"], id: string) => `${kind}:${id}`;

export function performanceHealthSchedule(events: readonly MechaPerformanceEvent[], timeline?: HealthTimeline, changes?: PresentationChanges): PerformanceHealthSchedule | null {
  if (!timeline?.ok || !changes?.ok) return null;
  const sources: Array<{ index: number; logIndex: number }> = [];
  for (const [index, event] of events.entries()) {
    if (event.sourceLogIndex === undefined) continue;
    if (!Number.isInteger(event.sourceLogIndex) || event.sourceLogIndex < 0 || (sources.length && event.sourceLogIndex < sources[sources.length - 1]!.logIndex)) return null;
    sources.push({ index, logIndex: event.sourceLogIndex });
  }
  const schedule: PerformanceHealthSchedule = events.map(() => []);
  let lastCue = -1;
  let healthIndex = 0;
  for (const change of changes.changes) {
    // Status transitions have no animation cue yet. They still participate in
    // reconciliation, but must not prevent unrelated health scheduling.
    if (change.kind === "monster_status") continue;
    // Collision may have no cue. Both displacements and health changes advance
    // the cursor: later effects in the same enemy event must not appear before
    // an intervening shove, even though the parent event was logged first.
    const source = sources.filter((entry) => entry.logIndex <= change.eventIndex).at(-1);
    if (!source) return null;
    lastCue = Math.max(lastCue, source.index);
    if (change.kind !== "health") continue;
    const step = timeline.steps[healthIndex++];
    if (!step || step.eventIndex !== change.eventIndex) return null;
    const a = step.effect, b = change.effect;
    if (a.kind !== b.kind || a.id !== b.id || a.before !== b.before || a.after !== b.after || a.order !== b.order || a.sequence !== b.sequence) return null;
    schedule[lastCue]!.push({ ...a });
  }
  if (healthIndex !== timeline.steps.length) return null;
  return schedule;
}
