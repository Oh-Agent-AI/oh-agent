/** Validated chronological state changes, without invented animation timings. */
import { verifyNeuralPresentation } from "./neuralPresentation";
import { BOARD, type CorrodeField, type HealthEffect, type PresentationSnapshot, type PresentationStages, type PresentationUnit, type TurnEvent } from "./board";

/** Lifecycle events emitted by the authoritative battle host.
 * `unit` is the exact presentation snapshot immediately after birth or before
 * removal. Death requires zero HP in the replayed state; expiry is alive.
 */
export type RaiderLifecyclePresentationEvent =
  | { type: "raider_spawn"; sequence: number; unit: PresentationUnit }
  | { type: "raider_remove"; sequence: number; unit: PresentationUnit; reason: "death" | "expired" };
export type PresentationChangeLogEvent = TurnEvent | RaiderLifecyclePresentationEvent;

type Change =
  | { sequence: number; eventIndex: number; kind: "raider_spawn"; unit: PresentationUnit }
  | { sequence: number; eventIndex: number; kind: "raider_remove"; unit: PresentationUnit; reason: "death" | "expired" }
  | { sequence: number; eventIndex: number; kind: "health"; effect: HealthEffect }
  | { sequence: number; eventIndex: number; kind: "shove"; unit: string; dir: { x: number; y: number } }
  | { sequence: number; eventIndex: number; kind: "collision"; unit: string; hit: string }
  | { sequence: number; eventIndex: number; kind: "monster_status"; change: "applied" | "absorbed" | "expired"; remaining: 0 | 1 }
  | { sequence: number; eventIndex: number; kind: "monster_displacement"; skill: "phase_swap" | "gravity_well"; moves: Array<{ unit: string; from: { x: number; y: number }; to: { x: number; y: number } }> }
  | { sequence: number; eventIndex: number; kind: "corrode_field"; change: "created" | "expired"; field: CorrodeField; reason?: "duration" | "finished" }
  | { sequence: number; eventIndex: number; kind: "boss_move"; from: { x: number; y: number }; to: { x: number; y: number } };
const sameCell = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x === b.x && a.y === b.y;
const sameField = (a: CorrodeField, b: CorrodeField) => a.id === b.id && a.sourceId === b.sourceId &&
  sameCell(a.cell, b.cell) && a.createdRound === b.createdRound && a.expiresAfterRound === b.expiresAfterRound;
// Lifecycle evidence is a bounded, plain-data contract; do not silently ignore
// unknown fields or getters, including an extra health-effects payload.
function exactDataObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value), own = Reflect.ownKeys(value);
  if ((proto !== Object.prototype && proto !== null) || own.length !== keys.length) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor?.enumerable && "value" in descriptor;
  });
}
function validRaiderEvidence(value: unknown): value is PresentationUnit {
  if (!exactDataObject(value, ["id", "pos", "hp"]) || !exactDataObject(value.pos, ["x", "y"])) return false;
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128 &&
    Number.isSafeInteger(value.hp) && (value.hp as number) >= 0 &&
    Number.isSafeInteger(value.pos.x) && Number.isSafeInteger(value.pos.y) &&
    (value.pos.x as number) >= 0 && (value.pos.x as number) < BOARD &&
    (value.pos.y as number) >= 0 && (value.pos.y as number) < BOARD;
}
const copyRaider = (unit: PresentationUnit): PresentationUnit => ({ id: unit.id, pos: { x: unit.pos.x, y: unit.pos.y }, hp: unit.hp });
export type PresentationChanges = { ok: true; changes: Change[]; neuralCues?: Array<{ eventIndex: number; change: "created" | "broken"; targetId: string }> } | { ok: false; reason: string };

/** Replays after movement through enemy execution and rejects incomplete evidence. */
export function buildPresentationChanges(stages: PresentationStages, log: readonly PresentationChangeLogEvent[]): PresentationChanges {
  const neural = verifyNeuralPresentation(stages, log as readonly TurnEvent[]);
  if (!neural.ok) return { ok: false, reason: "neural journal evidence does not reconcile" };
  const changes: Change[] = [];
  for (let eventIndex = 0; eventIndex < log.length; eventIndex++) {
    const event = log[eventIndex]!;
    if (!event || typeof event !== "object") return { ok: false, reason: "invalid event type" };
    const typeDescriptor = Object.getOwnPropertyDescriptor(event, "type");
    if (!typeDescriptor || !("value" in typeDescriptor)) return { ok: false, reason: "invalid event type" };
    if (event.type === "raider_spawn" || event.type === "raider_remove") {
      const spawn = event.type === "raider_spawn";
      const keys = spawn ? ["type", "sequence", "unit"] : ["type", "sequence", "unit", "reason"];
      if (!exactDataObject(event, keys) || !Number.isSafeInteger(event.sequence) || event.sequence < 0 ||
          !validRaiderEvidence(event.unit) || (spawn ? event.unit.hp === 0 :
            (event.reason !== "death" && event.reason !== "expired") ||
            (event.reason === "death" ? event.unit.hp !== 0 : event.unit.hp === 0))) {
        return { ok: false, reason: "invalid raider lifecycle evidence" };
      }
      if (event.type === "raider_spawn") changes.push({ sequence: event.sequence, eventIndex, kind: "raider_spawn", unit: copyRaider(event.unit) });
      else changes.push({ sequence: event.sequence, eventIndex, kind: "raider_remove", unit: copyRaider(event.unit), reason: event.reason });
      continue;
    }
    if ("effects" in event) for (const effect of event.effects ?? []) {
      if (!Number.isInteger(effect.sequence)) return { ok: false, reason: "health change lacks sequence" };
      changes.push({ sequence: effect.sequence!, eventIndex, kind: "health", effect: { ...effect } });
    }
    if (event.type === "corrode_tick" && (event.effects?.length !== 1 || event.damage !== 1 ||
      event.effects[0]!.id !== event.unit || event.effects[0]!.before - event.effects[0]!.after !== event.damage)) {
      return { ok: false, reason: "invalid corrode tick evidence" };
    }
    if (event.type === "monster_displacement") {
      if (!Number.isInteger(event.sequence)) return { ok: false, reason: "monster displacement lacks sequence" };
      changes.push({ sequence: event.sequence!, eventIndex, kind: "monster_displacement", skill: event.skill, moves: structuredClone(event.moves) });
    }
    if (event.type === "corrode_field") {
      if (!Number.isInteger(event.sequence)) return { ok: false, reason: "corrode field lacks sequence" };
      changes.push({ sequence: event.sequence!, eventIndex, kind: "corrode_field", change: event.change,
        field: structuredClone(event.field), ...(event.reason ? { reason: event.reason } : {}) });
    }
    if (event.type === "monster_status") {
      if (!Number.isInteger(event.sequence)) return { ok: false, reason: "monster status lacks sequence" };
      changes.push({ sequence: event.sequence!, eventIndex, kind: "monster_status", change: event.change, remaining: event.remaining });
    }
    if (event.type === "boss_move") {
      if (!Number.isInteger(event.sequence)) return { ok: false, reason: "boss move lacks sequence" };
      changes.push({ sequence: event.sequence!, eventIndex, kind: "boss_move", from: { ...event.from }, to: { ...event.to } });
    }
    if (event.type === "shove") {
      if (!Number.isInteger(event.sequence)) return { ok: false, reason: "shove lacks sequence" };
      if (event.hit) changes.push({ sequence: event.sequence!, eventIndex, kind: "collision", unit: event.unit, hit: event.hit });
      else changes.push({ sequence: event.sequence!, eventIndex, kind: "shove", unit: event.unit, dir: { ...event.dir } });
    }
  }
  changes.sort((a, b) => a.sequence - b.sequence);
  const state: PresentationSnapshot = structuredClone(stages.afterMovement);
  let lastCueMutationIndex = -1;
  // Never recycle an identity during a replay, even after removing it. The host
  // must enforce non-reuse across turns, which this single interval cannot see.
  const seenRaiderIds = new Set(state.raiders.map(unit => unit.id));
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;
    if (change.sequence !== i) return { ok: false, reason: "change sequence is missing or duplicated" };
    // The player reads log entries in array order. Enemy health effects may be
    // attached to an earlier parent event, but independently cued mutations
    // (including corrode ticks) must agree with the committed sequence.
    const cuedMutation = change.kind === "monster_displacement" || change.kind === "corrode_field" ||
      change.kind === "boss_move" || change.kind === "shove" || change.kind === "collision" ||
      change.kind === "raider_spawn" || change.kind === "raider_remove" ||
      (change.kind === "health" && log[change.eventIndex]?.type === "corrode_tick");
    if (cuedMutation) {
      if (change.eventIndex < lastCueMutationIndex) return { ok: false, reason: "cued mutations are out of log order" };
      lastCueMutationIndex = change.eventIndex;
    }
    if (change.kind === "raider_spawn" || change.kind === "raider_remove") {
      const unit = change.unit;
      // Duplicate ids in the starting snapshot would make a removal ambiguous.
      if (new Set(state.raiders.map(r => r.id)).size !== state.raiders.length) return { ok: false, reason: "duplicate raider identity" };
      if (change.kind === "raider_spawn") {
        const occupied = state.raiders.some(r => r.hp > 0 && sameCell(r.pos, unit.pos)) ||
          state.mechs.some(m => m.hp > 0 && sameCell(m.pos, unit.pos)) ||
          (state.boss.hp > 0 && unit.pos.x >= state.boss.anchor.x && unit.pos.x <= state.boss.anchor.x + 1 &&
           unit.pos.y >= state.boss.anchor.y && unit.pos.y <= state.boss.anchor.y + 1);
        if (seenRaiderIds.has(unit.id) || unit.id === "boss" || state.mechs.some(m => m.id === unit.id) || occupied) {
          return { ok: false, reason: "invalid raider spawn" };
        }
        seenRaiderIds.add(unit.id);
        state.raiders.push(copyRaider(unit));
      } else {
        const index = state.raiders.findIndex(r => r.id === unit.id);
        const current = state.raiders[index];
        if (!current || current.hp !== unit.hp || !sameCell(current.pos, unit.pos)) return { ok: false, reason: "raider removal does not match prior state" };
        state.raiders.splice(index, 1);
      }
    } else if (change.kind === "collision") {
      if (!change.hit) return { ok: false, reason: "collision lacks an obstacle" };
    } else if (change.kind === "monster_status") {
      if (change.change === "applied") {
        if (change.remaining !== 1) return { ok: false, reason: "invalid shield application" };
        state.boss.shield = { kind: "prism_guard", hits: 1 };
      } else {
        if (change.remaining !== 0 || !state.boss.shield) return { ok: false, reason: "invalid shield removal" };
        delete state.boss.shield;
      }
    } else if (change.kind === "monster_displacement") {
      const moves = change.moves;
      if ((change.skill === "phase_swap" && moves.length !== 2) || (change.skill === "gravity_well" && moves.length !== 1)) return { ok: false, reason: "invalid displacement group" };
      const seen = new Set<string>();
      const targets: Array<{ pos: { x: number; y: number }; to: { x: number; y: number } }> = [];
      for (const move of moves) {
        if (move.unit !== "boss" && !move.unit.startsWith("mech:")) return { ok: false, reason: "invalid displacement actor" };
        const id = move.unit.startsWith("mech:") ? move.unit.slice(5) : move.unit;
        if (move.unit !== "boss" && id === "boss") return { ok: false, reason: "invalid displacement actor" };
        const unit = id === "boss" ? state.boss : state.mechs.find(m => m.id === id);
        const pos = unit && ("anchor" in unit ? unit.anchor : unit.pos);
        const limit = id === "boss" ? BOARD - 2 : BOARD - 1;
        if (!pos || unit.hp <= 0 || seen.has(id) || !sameCell(pos, move.from) || sameCell(move.from, move.to) ||
          !Number.isInteger(move.to.x) || !Number.isInteger(move.to.y) || move.to.x < 0 || move.to.y < 0 || move.to.x > limit || move.to.y > limit ||
          (change.skill === "gravity_well" && (id === "boss" || Math.abs(move.from.x - move.to.x) + Math.abs(move.from.y - move.to.y) !== 1))) return { ok: false, reason: "invalid monster displacement" };
        seen.add(id); targets.push({ pos, to: move.to });
      }
      if (change.skill === "phase_swap" && (!seen.has("boss") || !sameCell(moves[0]!.from, moves[1]!.to) || !sameCell(moves[1]!.from, moves[0]!.to))) return { ok: false, reason: "invalid atomic swap" };
      // Check movable occupants against the complete final group, not an intermediate swap state.
      const finalBoss = moves.find(m => m.unit === "boss")?.to ?? state.boss.anchor;
      const finalMechs = state.mechs.filter(m => m.hp > 0).map(m => ({ id: m.id, pos: moves.find(v => v.unit === `mech:${m.id}`)?.to ?? m.pos }));
      const occupants = [...finalMechs, ...state.raiders.filter(r => r.hp > 0).map(r => ({ id: r.id, pos: r.pos }))];
      for (const movement of moves) {
        const id = movement.unit.startsWith("mech:") ? movement.unit.slice(5) : movement.unit;
        const cells = id === "boss" ? [movement.to, { x: movement.to.x + 1, y: movement.to.y }, { x: movement.to.x, y: movement.to.y + 1 }, { x: movement.to.x + 1, y: movement.to.y + 1 }] : [movement.to];
        if (occupants.some(o => o.id !== id && cells.some(cell => sameCell(cell, o.pos))) ||
          (id !== "boss" && state.boss.hp > 0 && movement.to.x >= finalBoss.x && movement.to.x <= finalBoss.x + 1 && movement.to.y >= finalBoss.y && movement.to.y <= finalBoss.y + 1)) return { ok: false, reason: "displacement overlaps an occupant" };
      }
      // Validate the entire group before committing either destination.
      for (const target of targets) { target.pos.x = target.to.x; target.pos.y = target.to.y; }
    } else if (change.kind === "corrode_field") {
      const corrode = state.corrode, field = change.field;
      if (!corrode || !field || !field.id || !field.sourceId || !Number.isInteger(field.cell?.x) || !Number.isInteger(field.cell?.y) ||
        field.cell.x < 0 || field.cell.y < 0 || field.cell.x >= corrode.width || field.cell.y >= corrode.height ||
        !Number.isInteger(field.createdRound) || !Number.isInteger(field.expiresAfterRound) || field.createdRound > field.expiresAfterRound) return { ok: false, reason: "invalid corrode field" };
      const index = corrode.fields.findIndex(f => f.id === field.id);
      if (change.change === "created") {
        if (index !== -1 || change.reason || corrode.fields.some(f => sameCell(f.cell, field.cell))) return { ok: false, reason: "invalid corrode creation" };
        corrode.fields.push(structuredClone(field));
        corrode.fields.sort((a, b) => a.cell.y - b.cell.y || a.cell.x - b.cell.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      } else {
        if (index < 0 || !change.reason || !sameField(corrode.fields[index]!, field)) return { ok: false, reason: "invalid corrode expiration" };
        corrode.fields.splice(index, 1);
      }
    } else if (change.kind === "boss_move") {
      const from = change.from, to = change.to;
      if (state.boss.anchor.x !== from.x || state.boss.anchor.y !== from.y
        || !Number.isInteger(to.x) || !Number.isInteger(to.y)
        || to.x < 0 || to.y < 0 || to.x + 1 >= BOARD || to.y + 1 >= BOARD
        || (from.x === to.x && from.y === to.y)) return { ok: false, reason: "invalid boss move" };
      state.boss.anchor = { ...to };
    } else if (change.kind === "shove") {
      const pos = change.unit === "boss" ? state.boss.anchor : state.mechs.find((m) => m.id === change.unit)?.pos;
      if (!pos || Math.abs(change.dir.x) + Math.abs(change.dir.y) !== 1) return { ok: false, reason: "invalid displacement" };
      pos.x += change.dir.x; pos.y += change.dir.y;
    } else {
      const e = change.effect;
      const source = log[change.eventIndex];
      if (source?.type === "corrode_tick") {
        const field = state.corrode?.fields.find(f => f.id === source.fieldId);
        const pos = e.kind === "boss" ? state.boss.anchor : e.kind === "mech" ? state.mechs.find(m => m.id === e.id)?.pos : e.kind === "raider" ? state.raiders.find(r => r.id === e.id)?.pos : undefined;
        const onField = pos && field && (e.kind === "boss" ? field.cell.x >= pos.x && field.cell.x <= pos.x + 1 && field.cell.y >= pos.y && field.cell.y <= pos.y + 1 : sameCell(pos, field.cell));
        if (!onField) return { ok: false, reason: "corrode tick does not match field occupancy" };
      }
      const unit = e.kind === "boss" && e.id === "boss" ? state.boss : e.kind === "mech" ? state.mechs.find((m) => m.id === e.id) : e.kind === "raider" ? state.raiders.find((r) => r.id === e.id) : e.kind === "building" ? state.buildings.find((b) => b.id === e.id) : undefined;
      if (!unit || unit.hp !== e.before || !Number.isFinite(e.after) || e.after < 0 || e.after === e.before) return { ok: false, reason: "health change does not match prior state" };
      unit.hp = e.after;
    }
  }
  // nextRound advances without a separate event at the end of a live round.
  // Reconcile fields exactly; only accept the host's bounded clock advance.
  if (!!state.corrode !== !!stages.afterEnemy.corrode) return { ok: false, reason: "corrode state presence changed" };
  if (state.corrode && stages.afterEnemy.corrode) {
    const end = stages.afterEnemy.corrode;
    if (end.version !== state.corrode.version || end.width !== state.corrode.width || end.height !== state.corrode.height ||
      (end.nextRound !== state.corrode.nextRound && end.nextRound !== state.corrode.nextRound + 1) ||
      (end.fields.length !== state.corrode.fields.length || end.fields.some((f, i) => !sameField(f, state.corrode!.fields[i]!)))) return { ok: false, reason: "corrode state does not reconcile" };
  }
  const projection = (s: PresentationSnapshot) => JSON.stringify({ boss: s.boss, mechs: s.mechs, raiders: s.raiders, buildings: s.buildings });
  if (projection(state) !== projection(stages.afterEnemy)) return { ok: false, reason: "changes do not reconcile with post-enemy snapshot" };
  return { ok: true, changes, ...(Object.prototype.hasOwnProperty.call(stages.before, "neural") ? { neuralCues: neural.cues } : {}) };
}
