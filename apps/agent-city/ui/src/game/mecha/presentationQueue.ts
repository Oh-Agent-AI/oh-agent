/** Playback of accepted, validated effects. The rules state remains authoritative. */
import type { HealthEffect } from "./board";
import type { HealthTimeline } from "./healthTimeline";

export type TimedHealthEffect = { at: number; effect: HealthEffect; eventIndex: number };
export type PresentationBatch = { id: number; duration: number; effects: TimedHealthEffect[] };
export type BatchResult = { ok: true; batch: PresentationBatch } | { ok: false; reason: string };

/** All timings are supplied by the actual choreography; no clip hit time is guessed here. */
export function timeHealthEffects(id: number, timeline: HealthTimeline, duration: number, effectImpact: ReadonlyMap<number, number>): BatchResult {
  if (!timeline.ok) return { ok: false, reason: timeline.reason };
  if (!Number.isInteger(id) || id < 0 || !Number.isFinite(duration) || duration < 0) return { ok: false, reason: "invalid batch identity or duration" };
  const effects: TimedHealthEffect[] = [];
  let previous = 0;
  for (const step of timeline.steps) {
    const at = effectImpact.get(step.effect.order);
    if (at === undefined || !Number.isFinite(at) || at < previous || at < 0 || at > duration) {
      return { ok: false, reason: `missing or inconsistent impact time for effect ${step.effect.order}` };
    }
    effects.push({ at, eventIndex: step.eventIndex, effect: { ...step.effect } });
    previous = at;
  }
  return { ok: true, batch: { id, duration, effects } };
}

/** FIFO; a long frame advances through all due events and never discards the next turn. */
export class HealthPresentationQueue {
  private batches: PresentationBatch[] = [];
  private elapsed = 0;
  private next = 0;
  private paused = false;
  private lastId = -1;

  enqueue(batch: PresentationBatch): void {
    if (!Number.isInteger(batch.id) || batch.id <= this.lastId || !Number.isFinite(batch.duration) || batch.duration < 0) throw new Error("invalid or out-of-order presentation batch");
    let previous = 0;
    for (const item of batch.effects) {
      if (!Number.isFinite(item.at) || item.at < previous || item.at < 0 || item.at > batch.duration) throw new Error("invalid presentation event time");
      previous = item.at;
    }
    this.batches.push({ ...batch, effects: batch.effects.map((item) => ({ ...item, effect: { ...item.effect } })) });
    this.lastId = batch.id;
  }
  setPaused(paused: boolean): void { this.paused = paused; }
  get pending(): number { return this.batches.length; }
  /** Returns effects crossed in this update; caller applies them to presentation state only. */
  advance(dt: number): Array<{ batchId: number; item: TimedHealthEffect }> {
    if (this.paused || !Number.isFinite(dt) || dt < 0) return [];
    const due: Array<{ batchId: number; item: TimedHealthEffect }> = [];
    let remaining = dt;
    while (this.batches.length) {
      const batch = this.batches[0]!;
      const step = Math.min(remaining, batch.duration - this.elapsed);
      this.elapsed += step;
      remaining -= step;
      while (this.next < batch.effects.length && batch.effects[this.next]!.at <= this.elapsed) {
        due.push({ batchId: batch.id, item: batch.effects[this.next++]! });
      }
      if (this.elapsed < batch.duration) break;
      this.batches.shift(); this.elapsed = 0; this.next = 0;
      if (remaining <= 0) break;
    }
    return due;
  }
  clear(): void { this.batches = []; this.elapsed = 0; this.next = 0; this.lastId = -1; }
}
