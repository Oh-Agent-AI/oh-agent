import type { Action, ArenaPlan, Cell, MatchState, MechId } from "./rules";
import { living, movementPath } from "./rules";

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
    if (hp(before, id) > 0 && hp(after, id) <= 0) events.push({ kind: "death", actor: id, at: copy(at.get(id)!), duration: 0.85 });
  }
}

function enemyAttacks(events: MechaPerformanceEvent[], state: MatchState, at: Map<string, Cell>) {
  const targets = (cells: Cell[]) => living(state).filter((mech) => cells.some((cell) => same(cell, mech.pos))).map((mech) => mech.id);
  const intent = state.boss.intent;
  if (state.boss.hp > 0 && intent && intent.skillId !== "skip" && intent.status !== "void") {
    const target = intent.projected[0] ?? at.get("boss")!;
    attack(events, "boss", intent.skillId, at.get("boss")!, target, targets(intent.projected));
  }
  for (const raider of state.raiders) {
    const intent = raider.intent;
    if (raider.hp <= 0 || !intent || intent.skillId === "skip" || intent.status === "void") continue;
    const target = intent.projected[0] ?? raider.pos;
    attack(events, raider.id, "melee", at.get(raider.id)!, target, targets(intent.projected));
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
    const from = at.get(raider.id)!;
    if (after && after.hp > 0 && !same(from, after.pos)) {
      move(events, raider.id, [from, after.pos]);
      at.set(raider.id, copy(after.pos));
    }
  }
  enemyAttacks(events, playerDone, at);
  for (const mech of playerDone.mechs) {
    const after = enemyDone.mechs.find((unit) => unit.id === mech.id)!;
    const from = at.get(mech.id)!;
    if (!same(from, after.pos)) {
      move(events, mech.id, [from, after.pos], true);
      at.set(mech.id, copy(after.pos));
    }
  }
  deaths(events, playerDone, enemyDone, at);
  const bossAfter = at.get("boss")!;
  if (finalState.boss.hp > 0 && !same(bossAfter, finalState.boss.anchor)) {
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

/** Attacks come exclusively from committed events, never from planned actions. */
export function performanceFromLog(before: MatchState, after: MatchState, log: import("./rules").TurnEvent[]): MechaPerformanceEvent[] {
  const events: MechaPerformanceEvent[] = [];
  const at = positions(before);
  for (const event of log) {
    if (event.type === "move") {
      move(events, event.mechId, movementPath(before, event.from, event.to, event.mechId, { alliesPass: true }) ?? [event.from, event.to]);
      at.set(event.mechId, copy(event.to));
    } else if (event.type === "act" && !event.fizzled && event.action !== "skip" && event.target) {
      const from = at.get(event.mechId)!;
      attack(events, event.mechId, event.action, from, at.get(event.target) ?? from, [event.target]);
    } else if (event.type === "shove" && !event.hit) {
      const from = at.get(event.unit)!;
      const to = { x: from.x + event.dir.x, y: from.y + event.dir.y };
      move(events, event.unit, [from, to], true);
      at.set(event.unit, to);
    } else if (event.type === "enemy") {
      const from = at.get(event.actor)!;
      const targets = [...at].filter(([id, cell]) => id !== event.actor && event.cells.some((c) => same(c, cell))).map(([id]) => id);
      attack(events, event.actor, event.skill === "sweep" ? "sweep" : "smash", from, event.cells[0] ?? from, targets);
    }
  }
  deaths(events, before, after, at);
  for (const [id, to] of positions(after)) {
    const from = at.get(id)!;
    if (hp(after, id) > 0 && !same(from, to)) move(events, id, [from, to]);
  }
  return events;
}
