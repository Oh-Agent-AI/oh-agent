import assert from "node:assert/strict";
import test from "node:test";
import type { PresentationSnapshot, PresentationStages, PresentationUnit, TurnEvent } from "../src/game/mecha/board.ts";
import { buildPresentationChanges, type PresentationChangeLogEvent, type RaiderLifecyclePresentationEvent } from "../src/game/mecha/presentationChanges.ts";

const unit = (id: string, x: number, y: number, hp = 2): PresentationUnit => ({ id, pos: { x, y }, hp });
function snapshot(): PresentationSnapshot {
  return { boss: { anchor: { x: 4, y: 4 }, hp: 10 },
    mechs: [{ id: "Assault", pos: { x: 1, y: 1 }, hp: 10 }],
    raiders: [unit("r0", 8, 8, 3)], buildings: [], outcome: null };
}
function stages(start: PresentationSnapshot, end: PresentationSnapshot): PresentationStages {
  return { before: structuredClone(start), afterMovement: structuredClone(start), afterPlayer: structuredClone(start),
    afterEnemy: structuredClone(end), afterPrepare: structuredClone(end) };
}
const spawn = (sequence: number, actor = unit("swarm:0", 3, 4)): RaiderLifecyclePresentationEvent => ({ type: "raider_spawn", sequence, unit: actor });
const remove = (sequence: number, actor: PresentationUnit, reason: "death" | "expired"): RaiderLifecyclePresentationEvent =>
  ({ type: "raider_remove", sequence, unit: actor, reason });
const damage = (sequence: number, id: string, before: number, after: number): TurnEvent => ({
  type: "enemy", actor: "boss", skill: "smash", cells: [], damage: before - after,
  effects: [{ kind: "raider", id, before, after, order: 0, sequence }],
});

function ok(start: PresentationSnapshot, end: PresentationSnapshot, events: PresentationChangeLogEvent[]) {
  const input = stages(start, end), before = structuredClone(input), log = structuredClone(events);
  const result = buildPresentationChanges(input, events);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(input, before); assert.deepEqual(events, log);
  return result.changes;
}
function rejected(start: PresentationSnapshot, end: PresentationSnapshot, events: unknown[]) {
  assert.equal(buildPresentationChanges(stages(start, end), events as PresentationChangeLogEvent[]).ok, false);
}

test("birth, health change and death replay in sequence with exact snapshots", () => {
  const start = snapshot(), end = structuredClone(start), child = unit("swarm:0", 3, 4);
  const events = [spawn(0, child), damage(1, child.id, 2, 0), remove(2, { ...child, hp: 0 }, "death")];
  const changes = ok(start, end, events);
  assert.deepEqual(changes.map(c => [c.kind, c.sequence, c.eventIndex]), [["raider_spawn", 0, 0], ["health", 1, 1], ["raider_remove", 2, 2]]);
  if (changes[0]!.kind !== "raider_spawn") throw new Error("expected birth");
  child.pos.x = 9;
  assert.deepEqual(changes[0]!.unit.pos, { x: 3, y: 4 });
  assert.deepEqual(changes[2], { kind: "raider_remove", sequence: 2, eventIndex: 2,
    unit: unit("swarm:0", 3, 4, 0), reason: "death" });
});

test("multiple births, death and expiry preserve raider order and both removal reasons", () => {
  const start = snapshot(), end = structuredClone(start);
  end.raiders = [unit("swarm:1", 3, 5)];
  const events = [spawn(0), spawn(1, unit("swarm:1", 3, 5)), damage(2, "r0", 3, 0),
    remove(3, unit("r0", 8, 8, 0), "death"), remove(4, unit("swarm:0", 3, 4), "expired")];
  const changes = ok(start, end, events);
  assert.deepEqual(changes.map(c => c.kind), ["raider_spawn", "raider_spawn", "health", "raider_remove", "raider_remove"]);
});

test("parent-event health may follow a birth by sequence, but cannot affect a not-yet-born actor", () => {
  const start = snapshot(), end = structuredClone(start);
  // Parent enemy events can be logged before their later, nested effects.
  const events = [damage(1, "swarm:0", 2, 0), spawn(0), remove(2, unit("swarm:0", 3, 4, 0), "death")];
  assert.deepEqual(ok(start, end, events).map(c => c.kind), ["raider_spawn", "health", "raider_remove"]);
  rejected(start, end, [damage(0, "swarm:0", 2, 0), spawn(1), remove(2, unit("swarm:0", 3, 4, 0), "death")]);
});

test("missing, duplicate and out-of-log-order lifecycle sequences fail closed", () => {
  const start = snapshot(), end = structuredClone(start); end.raiders.push(unit("swarm:0", 3, 4));
  rejected(start, end, [{ type: "raider_spawn", unit: unit("swarm:0", 3, 4) }]);
  rejected(start, end, [spawn(1)]);
  const unchanged = snapshot();
  rejected(start, unchanged, [spawn(0), remove(0, unit("swarm:0", 3, 4), "expired")]);
  rejected(start, unchanged, [remove(1, unit("swarm:0", 3, 4), "expired"), spawn(0)]);
  // Independently cued host events must also be ordered relative to other cues.
  const moved = structuredClone(end); moved.boss.anchor = { x: 4, y: 6 };
  rejected(start, moved, [{ type: "boss_move", from: { x: 4, y: 4 }, to: { x: 4, y: 6 }, sequence: 1 }, spawn(0)]);
});

test("spawn rejects duplicate or reused ids, occupied cells and malformed evidence", () => {
  const start = snapshot(), end = structuredClone(start);
  const cases: unknown[] = [
    spawn(0, unit("r0", 3, 4)), spawn(0, unit("boss", 3, 4)), spawn(0, unit("Assault", 3, 4)),
    spawn(0, unit("new", 4, 4)), spawn(0, unit("new", 1, 1)), spawn(0, unit("new", 8, 8)),
    spawn(0, unit("", 3, 4)), spawn(0, unit("new", -1, 4)), spawn(0, unit("new", 10, 4)),
    spawn(0, unit("new", 3.5, 4)), spawn(0, unit("new", 3, 4, 0)), spawn(0, unit("new", 3, 4, Infinity)),
    { type: "raider_spawn", sequence: 0, unit: null },
    { ...spawn(0), effects: [] },
    { ...spawn(0), unit: { ...unit("new", 3, 4), species: "unknown" } },
  ];
  for (const event of cases) rejected(start, end, [event]);
  const dead = unit("r0", 8, 8, 0), deadStart = structuredClone(start); deadStart.raiders[0] = dead;
  rejected(deadStart, end, [remove(0, dead, "death"), spawn(1, unit("r0", 3, 4))]);
  const dup = structuredClone(start); dup.raiders.push(unit("r0", 3, 4));
  rejected(dup, dup, [remove(0, unit("r0", 8, 8, 3), "expired")]);
  const getterUnit = unit("new", 3, 4);
  Object.defineProperty(getterUnit, "hp", { enumerable: true, get() { throw new Error("getter must not run"); } });
  rejected(start, end, [{ type: "raider_spawn", sequence: 0, unit: getterUnit }]);
  const getterType = { sequence: 0, unit: unit("new", 3, 4) };
  Object.defineProperty(getterType, "type", { enumerable: true, get() { throw new Error("getter must not run"); } });
  rejected(start, end, [getterType]);
});

test("a dead raider does not occupy its cell, but retains its identity until removed", () => {
  const start = snapshot(); start.raiders[0]!.hp = 0;
  const end = structuredClone(start); end.raiders.push(unit("swarm:0", 8, 8));
  ok(start, end, [spawn(0, unit("swarm:0", 8, 8))]);
});

test("removal requires exact identity, position, HP and reason against replayed state", () => {
  const start = snapshot(), end = structuredClone(start); end.raiders = [];
  const valid = remove(0, unit("r0", 8, 8, 3), "expired");
  assert.equal(ok(start, end, [valid])[0]!.kind, "raider_remove");
  const bad: unknown[] = [remove(0, unit("missing", 8, 8, 3), "expired"), remove(0, unit("r0", 8, 7, 3), "expired"),
    remove(0, unit("r0", 8, 8, 2), "expired"), remove(0, unit("r0", 8, 8, 3), "death"),
    remove(0, unit("r0", 8, 8, 0), "expired"), { ...valid, reason: "finished" }, { ...valid, reason: undefined }];
  for (const event of bad) rejected(start, end, [event]);
  // Health cannot be silently deleted by a fabricated death event.
  rejected(start, end, [remove(0, unit("r0", 8, 8, 0), "death")]);
});

test("unknown births, removals, health and order differences remain rejected", () => {
  const start = snapshot(), born = structuredClone(start), removed = structuredClone(start), changed = structuredClone(start);
  born.raiders.push(unit("swarm:0", 3, 4)); removed.raiders = []; changed.raiders[0]!.hp = 2;
  for (const end of [born, removed, changed]) rejected(start, end, []);
  const extra = structuredClone(born); extra.raiders.push(unit("swarm:1", 3, 5));
  rejected(start, extra, [spawn(0)]);
  extra.raiders.reverse();
  rejected(start, extra, [spawn(0), spawn(1, unit("swarm:1", 3, 5))]);
});
