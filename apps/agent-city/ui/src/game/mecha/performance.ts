import { projectMovementEffect } from "./skillEffects";
import type { Action, ArenaPlan, Cell, MatchState, MechId } from "./rules";
import { living, movementPath } from "./rules";
import type { HealthTimeline } from "./healthTimeline";
import type { PresentationChanges } from "./presentationChanges";
import { performanceHealthSchedule } from "./performanceHealth";

import type { MechaPerformanceEvent, PerformanceAttack } from "../../render/mecha/performance";
export type { MechaPerformanceEvent } from "../../render/mecha/performance";

const same = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y;
const copy = (cell: Cell): Cell => ({ x: cell.x, y: cell.y });

function positions(state: MatchState): Map<string, Cell> {
  const out = new Map<string, Cell>();
  for (const mech of state.mechs) out.set(mech.id, copy(mech.pos));
  for (const raider of state.raiders) out.set(raider.id, copy(raider.pos));
  out.set("boss", copy(state.boss.anchor));
  return out;
}

function hp(state: MatchState, id: string): number {
  if (id === "boss") return state.boss.hp;
  return state.mechs.find((unit) => unit.id === id)?.hp ?? state.raiders.find((unit) => unit.id === id)?.hp ?? 0;
}

function hasActor(state: MatchState, id: string): boolean {
  return id === "boss" || state.mechs.some(unit => unit.id === id) || state.raiders.some(unit => unit.id === id);
}

function attackDuration(attack: PerformanceAttack): number {
  if (attack === "smash" || attack === "sweep") return 0.95;
  if (attack === "repair") return 0.9;
  if (attack === "pierce") return 0.85;
  if (attack === "charge") return 0.75;
  return attack === "shoot" ? 0.7 : 0.62;
}

function move(events: MechaPerformanceEvent[], actor: string, path: Cell[], knockback = false) {
  if (path.length < 2) return;
  events.push({
    kind: knockback ? "knockback" : "move",
    actor,
    path: path.map(copy),
    duration: knockback ? 0.32 : Math.max(0.3, Math.min(1.1, (path.length - 1) * 0.24)),
  });
}

function attack(events: MechaPerformanceEvent[], actor: string, kind: PerformanceAttack, from: Cell, target: Cell, targetIds: string[]) {
  events.push({ kind: "attack", actor, attack: kind, from: copy(from), target: copy(target), targetIds, duration: attackDuration(kind) });
}

function implicitTarget(state: MatchState, id: MechId, action: Action, from: Cell): string {
  if ("target" in action && action.target) return action.target;
  const candidates: string[] = [];
  if (state.boss.hp > 0) candidates.push("boss");
  for (const raider of state.raiders) if (raider.hp > 0) candidates.push(raider.id);
  const aligned = candidates.filter((target) => {
    const cells = target === "boss"
      ? [state.boss.anchor, { x: state.boss.anchor.x + 1, y: state.boss.anchor.y }, { x: state.boss.anchor.x, y: state.boss.anchor.y + 1 }, { x: state.boss.anchor.x + 1, y: state.boss.anchor.y + 1 }]
      : [state.raiders.find((raider) => raider.id === target)!.pos];
    if (action.kind === "melee" || action.kind === "charge") {
      return cells.some((cell) => Math.max(Math.abs(cell.x - from.x), Math.abs(cell.y - from.y)) <= (target === "boss" ? 2 : 1));
    }
    return cells.some((cell) => cell.x === from.x || cell.y === from.y);
  });
  return aligned[0] ?? candidates[0] ?? "boss";
}

function deaths(events: MechaPerformanceEvent[], before: MatchState, after: MatchState, at: Map<string, Cell>) {
  for (const id of at.keys()) {
    if (hasActor(after, id) && hp(before, id) > 0 && hp(after, id) <= 0) events.push({ kind: "death", actor: id, at: copy(at.get(id)!), duration: 0.85 });
  }
}

function enemyAttacks(events: MechaPerformanceEvent[], state: MatchState, at: Map<string, Cell>) {
  const targets = (cells: Cell[]) => living(state).filter((mech) => cells.some((cell) => same(cell, mech.pos))).map((mech) => mech.id);
  const intent = state.boss.intent;
  if (state.boss.hp > 0 && intent && intent.skillId !== "skip" && intent.status !== "void" &&
    !["corrode_cell", "phase_swap", "gravity_well", "split_swarm", "neural_link"].includes(intent.skillId)) {
    const target = intent.projected[0] ?? at.get("boss")!;
    attack(events, "boss", intent.skillId === "sweep" ? "sweep" : "smash", at.get("boss")!, target, targets(intent.projected));
  }
  for (const raider of state.raiders) {
    const intent = raider.intent;
    if (raider.hp <= 0 || !intent || intent.skillId === "skip" || intent.status === "void") continue;
    const from = at.get(raider.id);
    if (!from) continue; // A snapshot alone does not establish this actor's entrance.
    const target = intent.projected[0] ?? raider.pos;
    attack(events, raider.id, "melee", from, target, targets(intent.projected));
  }
}

export function createRoundPerformance(before: MatchState, plan: ArenaPlan, playerDone: MatchState, enemyDone: MatchState, finalState: MatchState): MechaPerformanceEvent[] {
  const events: MechaPerformanceEvent[] = [];
  const at = positions(before);
  for (const order of plan.items) {
    const actor = before.mechs.find((mech) => mech.id === order.mechId && mech.hp > 0);
    if (!actor) continue;
    const from = at.get(order.mechId)!;
    const to = order.moveTo ?? actor.pos;
    if (!same(from, to)) {
      const path = movementPath(before, from, to, order.mechId) ?? [from, to];
      move(events, order.mechId, path);
      at.set(order.mechId, copy(to));
    }
    if (order.action.kind === "skip") continue;
    const targetId = implicitTarget(before, order.mechId, order.action, to);
    const target = at.get(targetId) ?? positions(before).get(targetId) ?? to;
    attack(events, order.mechId, order.action.kind, to, target, [targetId]);
  }
  const bossBefore = at.get("boss")!;
  if (!same(bossBefore, playerDone.boss.anchor) && playerDone.boss.hp > 0) {
    move(events, "boss", [bossBefore, playerDone.boss.anchor], true);
    at.set("boss", copy(playerDone.boss.anchor));
  }
  deaths(events, before, playerDone, at);
  for (const raider of playerDone.raiders) {
    const after = enemyDone.raiders.find((unit) => unit.id === raider.id);
    const from = at.get(raider.id);
    if (from && after && after.hp > 0 && !same(from, after.pos)) {
      move(events, raider.id, [from, after.pos]);
      at.set(raider.id, copy(after.pos));
    }
  }
  enemyAttacks(events, playerDone, at);
  // The legacy snapshot-only path cannot prove the order or cause of these effects.
  const needsLog = ["corrode_cell", "phase_swap", "gravity_well", "split_swarm", "neural_link"].includes(playerDone.boss.intent?.skillId ?? "");
  for (const mech of playerDone.mechs) {
    const after = enemyDone.mechs.find((unit) => unit.id === mech.id)!;
    const from = at.get(mech.id)!;
    if (!needsLog && !same(from, after.pos)) {
      move(events, mech.id, [from, after.pos], true);
      at.set(mech.id, copy(after.pos));
    }
  }
  if (!needsLog) deaths(events, playerDone, enemyDone, at);
  const bossAfter = at.get("boss")!;
  if (!needsLog && finalState.boss.hp > 0 && !same(bossAfter, finalState.boss.anchor)) {
    move(events, "boss", [bossAfter, finalState.boss.anchor]);
    at.set("boss", copy(finalState.boss.anchor));
  }
  return events;
}

export function createPreparePerformance(before: MatchState, after: MatchState): MechaPerformanceEvent[] {
  const events: MechaPerformanceEvent[] = [];
  if (before.boss.hp > 0 && !same(before.boss.anchor, after.boss.anchor)) move(events, "boss", [before.boss.anchor, after.boss.anchor]);
  return events;
}

/** Place verified defeats at the cause cue, rather than at the end of the turn. */
function insertVerifiedDeaths(events: MechaPerformanceEvent[], before: MatchState, after: MatchState, evidence?: { healthTimeline?: HealthTimeline; presentationChanges?: PresentationChanges }): boolean {
  const schedule = performanceHealthSchedule(events, evidence?.healthTimeline, evidence?.presentationChanges);
  if (!schedule) return false;
  const at = positions(before);
  const expected = new Set([...at.keys()].filter(id => hasActor(after, id) && hp(before, id) > 0 && hp(after, id) <= 0));
  const seen = new Set<string>();
  const result: MechaPerformanceEvent[] = [];
  for (const [index, event] of events.entries()) {
    result.push(event);
    if (event.kind === "move" || event.kind === "knockback") at.set(event.actor, copy(event.path[event.path.length - 1]!));
    if (event.kind === "monster_displacement") for (const movement of event.moves) at.set(movement.actor, copy(movement.to));
    for (const effect of schedule[index]!) {
      if (effect.kind === "building" || effect.before <= 0 || effect.after > 0) continue;
      const id = effect.id;
      const matchesKind = effect.kind === "boss" ? id === "boss" : effect.kind === "mech" ? before.mechs.some(m => m.id === id) : before.raiders.some(r => r.id === id);
      const position = at.get(id);
      // An unknown actor, a revival, or duplicate death needs a safe end-of-turn fallback.
      if (!matchesKind || !position || !expected.has(id) || seen.has(id)) return false;
      seen.add(id);
      result.push({ kind: "death", actor: id, at: copy(position), duration: 0.85 });
    }
  }
  if (seen.size !== expected.size) return false;
  events.splice(0, events.length, ...result);
  return true;
}

/** Attacks come exclusively from committed events, never from planned actions. */
export function performanceFromLog(before: MatchState, after: MatchState, log: import("./rules").TurnEvent[], evidence?: { healthTimeline?: HealthTimeline; presentationChanges?: PresentationChanges; statusVerified?: boolean }): MechaPerformanceEvent[] {
  const events: MechaPerformanceEvent[] = [];
  const at = positions(before);
  const fields = new Map((before.corrode?.fields ?? []).map(field => [field.id, field]));
  const verified = evidence?.presentationChanges?.ok === true;
  // With missing special-event evidence, a snapshot difference cannot identify
  // which units were displaced or damaged by the skill; do not invent cues.
  const specialSkill = ["corrode_cell", "phase_swap", "gravity_well"].includes(before.boss.intent?.skillId ?? "") ||
    Boolean(before.corrode?.fields.length) || log.some(event => event.type === "monster_displacement" || event.type === "corrode_field" || event.type === "corrode_tick" ||
      (event.type === "enemy" && ["phase_swap", "gravity_well"].includes(event.skill)));
  const unverifiedSpecial = !verified && specialSkill;
  for (const [sourceLogIndex, event] of log.entries()) {
    const start = events.length;
    if (event.type === "move") {
      move(events, event.mechId, movementPath(before, event.from, event.to, event.mechId, { alliesPass: true }) ?? [event.from, event.to]);
      at.set(event.mechId, copy(event.to));
    } else if (event.type === "act" && !event.fizzled && event.action !== "skip" && event.target) {
      const from = at.get(event.mechId);
      if (from) attack(events, event.mechId, event.action, from, at.get(event.target) ?? from, [event.target]);
    } else if (event.type === "boss_move") {
      move(events, "boss", [event.from, event.to]);
      at.set("boss", copy(event.to));
    } else if (event.type === "shove") {
      const result = projectMovementEffect(event, at.get(event.unit)).moves[0]!;
      if (result.status === "moved" && result.from && result.to) {
        move(events, event.unit, [result.from, result.to], true);
        at.set(event.unit, result.to);
      }
    } else if ((event.type === "raider_spawn" || event.type === "raider_remove") && verified) {
      // A roster difference alone is never sufficient proof of a lifecycle.
      const changes = evidence?.presentationChanges;
      const change = changes?.ok && changes.changes.find(item =>
        item.eventIndex === sourceLogIndex && item.kind === event.type);
      if (!change || (change.kind !== "raider_spawn" && change.kind !== "raider_remove")) continue;
      if (change.kind === "raider_spawn") {
        events.push({ kind: "raider_spawn", actor: change.unit.id, at: copy(change.unit.pos), hp: change.unit.hp, duration: 0.45 });
        at.set(change.unit.id, copy(change.unit.pos));
      } else {
        events.push({ kind: "raider_remove", actor: change.unit.id, at: copy(change.unit.pos), hp: change.unit.hp, reason: change.reason, duration: 0.45 });
        at.delete(change.unit.id);
      }
    } else if (event.type === "neural_event" && verified) {
      const evidenceCue = evidence?.presentationChanges?.ok ? evidence.presentationChanges.neuralCues?.find(cue => cue.eventIndex === sourceLogIndex) : undefined;
      const targetId = evidenceCue?.targetId.slice("raider:".length);
      // Ambiguous actor identities and missing positions cannot support a cue.
      const target = targetId && !["boss", "Assault", "Gunner", "Support"].includes(targetId) ? at.get(targetId) : undefined;
      const from = at.get("boss");
      if (evidenceCue && target && from) events.push({ kind: "neural_link", actor: "boss", change: evidenceCue.change,
        from: copy(from), target: copy(target), duration: 0.5 });
    } else if (event.type === "monster_displacement" && verified) {
      const projected = projectMovementEffect(event);
      // Only validated special events reach this branch; their cells are explicit.
      const moves = projected.moves.flatMap(movement => movement.from && movement.to
        ? [{ actor: movement.actor, from: movement.from, to: movement.to }] : []);
      events.push({ kind: "monster_displacement", actor: "boss", skill: event.skill, moves, duration: event.skill === "phase_swap" ? 0.55 : 0.4 });
      for (const movement of moves) at.set(movement.actor, copy(movement.to));
    } else if (event.type === "corrode_field" && verified) {
      events.push({ kind: "corrode_field", actor: "boss", change: event.change, fieldId: event.field.id, cell: copy(event.field.cell), duration: 0.4 });
      if (event.change === "created") fields.set(event.field.id, event.field); else fields.delete(event.field.id);
    } else if (event.type === "corrode_tick" && verified) {
      const field = fields.get(event.fieldId);
      if (field) events.push({ kind: "corrode_tick", actor: event.unit, fieldId: event.fieldId, cell: copy(field.cell), damage: event.damage, duration: 0.4 });
    } else if (event.type === "status_effect" && verified && evidence?.statusVerified === true) {
      const status = event.event, target = status.type === "status_damage" ? status.target : status.status.target;
      const cell = at.get(target);
      if (cell) {
        const kind = status.type === "status_damage" ? status.kind : status.status.kind;
        const change = status.type === "status_damage" ? "damage" : status.type === "status_applied" ? "applied" :
          status.type === "status_refreshed" ? "refreshed" : status.type === "status_advanced" ? "advanced" : status.type === "status_expired" ? "expired" : "removed";
        const source = status.type === "status_damage" ? status.source : status.status.source;
        const remainingTurns = status.type !== "status_damage" && (change === "applied" || change === "refreshed" || change === "advanced") ? status.status.remainingTurns : undefined;
        events.push({ kind: "status_cue", actor: target, source, status: kind, change, ...(remainingTurns === undefined ? {} : { remainingTurns }), cell: copy(cell), duration: change === "advanced" ? 0.001 : 0.4 });
      }
    } else if (event.type === "enemy") {
      // Linking and summoning are not direct attacks; do not invent a smash.
      if (event.skill === "neural_link" || event.skill === "split_swarm") continue;
      // Without verified displacement evidence, the attack origin is unknown.
      if (!verified && (event.skill === "phase_swap" || event.skill === "gravity_well")) continue;
      const from = at.get(event.actor);
      if (!from) continue;
      const piercing = ["phase_swap", "gravity_well", "ring_pierce", "prism_frost"].includes(event.skill);
      const targets = piercing
        ? (event.effects ?? []).filter(effect => effect.kind !== "building" && effect.after < effect.before).map(effect => effect.id)
        : [...at].filter(([id, cell]) => id !== event.actor && event.cells.some((c) => same(c, cell))).map(([id]) => id);
      attack(events, event.actor, event.skill === "sweep" ? "sweep" : piercing ? "pierce" : "smash", from, (piercing ? event.cells.at(-1) : event.cells[0]) ?? from, targets);
    }
    for (let i = start; i < events.length; i++) events[i]!.sourceLogIndex = sourceLogIndex;
  }
  if (!insertVerifiedDeaths(events, before, after, evidence) && !unverifiedSpecial) deaths(events, before, after, at);
  for (const [id, to] of positions(after)) {
    const from = at.get(id);
    if (from && hp(after, id) > 0 && !same(from, to) && !unverifiedSpecial) move(events, id, [from, to]);
  }
  return events;
}
