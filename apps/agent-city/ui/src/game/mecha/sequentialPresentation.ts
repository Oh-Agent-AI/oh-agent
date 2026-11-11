/** Build a presentation only from a complete, reconciled command interval. */
import { movementSnapshot, presentationSnapshot, type MatchState, type PresentationStages, type TurnEvent } from "./board";
import { canonicalJson } from "./contracts/match";
import { buildHealthTimeline } from "./healthTimeline";
import { performanceFromLog } from "./performance";
import { buildPresentationChanges } from "./presentationChanges";
import { verifyStatusLedger } from "./statusTimeline";
import { verifyStatusGeometry } from "./statusGeometry";
import { performanceHealthSchedule } from "./performanceHealth";

export function sequentialPresentation(before: MatchState, after: MatchState, events: TurnEvent[], stages: PresentationStages | null) {
  if (!stages) return { ok: false as const, reason: "missing_stages" };
  const start = presentationSnapshot(before), end = presentationSnapshot(after), moved = movementSnapshot(start, events);
  if (!moved || canonicalJson(stages.before) !== canonicalJson(start) || canonicalJson(stages.afterPrepare) !== canonicalJson(end) ||
      canonicalJson(stages.afterMovement) !== canonicalJson(moved)) return { ok: false as const, reason: "stage_boundary_mismatch" };
  const hasStatus = Boolean(before.statusEncounter || after.statusEncounter || events.some(event => event.type === "status_effect" || event.type === "status_hit" || event.type === "gravity_collision" || event.type === "status_boundary"));
  if (hasStatus) {
    const status = verifyStatusLedger(before, after, events, stages);
    if (!status.ok) return status;
    const geometry = verifyStatusGeometry(before, events);
    if (!geometry.ok) return geometry;
  }
  const changes = buildPresentationChanges(stages, events);
  if (!changes.ok) return { ok: false as const, reason: changes.reason };
  const health = buildHealthTimeline(before, after, events, stages);
  if (!health.ok) return { ok: false as const, reason: health.reason };
  const performance = performanceFromLog(before, after, events, { healthTimeline: health, presentationChanges: changes, statusVerified: hasStatus });
  if (hasStatus) {
    const expected = events.flatMap((event, index) => event.type === "status_effect" ? [index] : []);
    const actual = performance.flatMap(event => event.kind === "status_cue" ? [event.sourceLogIndex] : []);
    if (canonicalJson(expected) !== canonicalJson(actual) || !performanceHealthSchedule(performance, health, changes))
      return { ok: false as const, reason: "status_cue_evidence_incomplete" };
  }
  return { ok: true as const, health, changes, events: performance };
}
