/** Validated chronological state changes, without invented animation timings. */
import type { HealthEffect, PresentationSnapshot, PresentationStages, TurnEvent } from "./board";

type Change =
  | { sequence: number; eventIndex: number; kind: "health"; effect: HealthEffect }
  | { sequence: number; eventIndex: number; kind: "shove"; unit: string; dir: { x: number; y: number } }
  | { sequence: number; eventIndex: number; kind: "collision"; unit: string; hit: string };
export type PresentationChanges = { ok: true; changes: Change[] } | { ok: false; reason: string };

/** Replays after movement through enemy execution and rejects incomplete evidence. */
export function buildPresentationChanges(stages: PresentationStages, log: TurnEvent[]): PresentationChanges {
  const changes: Change[] = [];
  for (let eventIndex = 0; eventIndex < log.length; eventIndex++) {
    const event = log[eventIndex]!;
    if ("effects" in event) for (const effect of event.effects ?? []) {
      if (!Number.isInteger(effect.sequence)) return { ok: false, reason: "health change lacks sequence" };
      changes.push({ sequence: effect.sequence!, eventIndex, kind: "health", effect: { ...effect } });
    }
    if (event.type === "shove") {
      if (!Number.isInteger(event.sequence)) return { ok: false, reason: "shove lacks sequence" };
      if (event.hit) changes.push({ sequence: event.sequence!, eventIndex, kind: "collision", unit: event.unit, hit: event.hit });
      else changes.push({ sequence: event.sequence!, eventIndex, kind: "shove", unit: event.unit, dir: { ...event.dir } });
    }
  }
  changes.sort((a, b) => a.sequence - b.sequence);
  const state: PresentationSnapshot = structuredClone(stages.afterMovement);
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;
    if (change.sequence !== i) return { ok: false, reason: "change sequence is missing or duplicated" };
    if (change.kind === "collision") {
      if (!change.hit) return { ok: false, reason: "collision lacks an obstacle" };
    } else if (change.kind === "shove") {
      const pos = change.unit === "boss" ? state.boss.anchor : state.mechs.find((m) => m.id === change.unit)?.pos;
      if (!pos || Math.abs(change.dir.x) + Math.abs(change.dir.y) !== 1) return { ok: false, reason: "invalid displacement" };
      pos.x += change.dir.x; pos.y += change.dir.y;
    } else {
      const e = change.effect;
      const unit = e.kind === "boss" && e.id === "boss" ? state.boss : e.kind === "mech" ? state.mechs.find((m) => m.id === e.id) : e.kind === "raider" ? state.raiders.find((r) => r.id === e.id) : e.kind === "building" ? state.buildings.find((b) => b.id === e.id) : undefined;
      if (!unit || unit.hp !== e.before || !Number.isFinite(e.after) || e.after < 0 || e.after === e.before) return { ok: false, reason: "health change does not match prior state" };
      unit.hp = e.after;
    }
  }
  const projection = (s: PresentationSnapshot) => JSON.stringify({ boss: s.boss, mechs: s.mechs, raiders: s.raiders, buildings: s.buildings });
  if (projection(state) !== projection(stages.afterEnemy)) return { ok: false, reason: "changes do not reconcile with post-enemy snapshot" };
  return { ok: true, changes };
}
