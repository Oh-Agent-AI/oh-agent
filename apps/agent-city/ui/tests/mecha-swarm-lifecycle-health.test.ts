import assert from "node:assert/strict";
import test from "node:test";
import { presentationSnapshot, type MatchState, type PresentationStages, type PresentationUnit, type TurnEvent } from "../src/game/mecha/board.ts";
import { buildHealthTimeline } from "../src/game/mecha/healthTimeline.ts";
import type { PresentationChangeLogEvent } from "../src/game/mecha/presentationChanges.ts";
import { createMatch } from "../src/game/mecha/rules.ts";

const unit = (id: string, x: number, y: number, hp = 2): PresentationUnit => ({ id, pos: { x, y }, hp });
function battle(): MatchState {
  return createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 4 }, covers: [], buildings: [],
    raiders: [{ id: "r0", pos: { x: 8, y: 8 }, hp: 3 }], mechs: [
      { id: "Assault", pos: { x: 1, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 1, y: 9 } },
    ] });
}
function stages(before: MatchState, after: MatchState): PresentationStages {
  const a = presentationSnapshot(before), b = presentationSnapshot(after);
  return { before: structuredClone(a), afterMovement: structuredClone(a), afterPlayer: structuredClone(a),
    afterEnemy: structuredClone(b), afterPrepare: structuredClone(b) };
}
const spawn = (sequence: number, actor = unit("swarm:0", 3, 4)): PresentationChangeLogEvent => ({ type: "raider_spawn", sequence, unit: actor });
const remove = (sequence: number, actor: PresentationUnit, reason: "death" | "expired"): PresentationChangeLogEvent =>
  ({ type: "raider_remove", sequence, unit: actor, reason });
const damage = (sequence: number, order: number, id: string, before: number, after: number): TurnEvent => ({
  type: "act", mechId: "Assault", action: "melee", damage: before - after,
  effects: [{ kind: "raider", id, before, after, order, sequence }],
});

test("verified birth, damage and death produce only the actual ordered damage", () => {
  const before = battle(), after = structuredClone(before), child = unit("swarm:0", 3, 4);
  const log = [spawn(0, child), damage(1, 0, child.id, 2, 0), remove(2, { ...child, hp: 0 }, "death")];
  const evidence = stages(before, after), input = structuredClone({ before, after, log, evidence });
  const result = buildHealthTimeline(before, after, log, evidence);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.steps.map(s => [s.eventIndex, s.effect.id, s.effect.before, s.effect.after, s.effect.order, s.effect.sequence]),
    [[1, "swarm:0", 2, 0, 0, 1]]);
  assert.deepEqual({ before, after, log, evidence }, input);
});

test("spawn and expiry alone are not damage; a different lethal effect remains attributable", () => {
  const before = battle(), after = structuredClone(before), child = unit("swarm:0", 3, 4);
  after.raiders = [];
  const log = [spawn(0, child), damage(1, 0, "r0", 3, 0), remove(2, unit("r0", 8, 8, 0), "death"), remove(3, child, "expired")];
  const result = buildHealthTimeline(before, after, log, stages(before, after));
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.steps.map(s => [s.effect.id, s.effect.before, s.effect.after]), [["r0", 3, 0]]);
});

test("health order follows committed sequence even when a parent event is logged earlier", () => {
  const before = battle(), after = structuredClone(before), child = unit("swarm:0", 3, 4);
  const log = [damage(1, 0, child.id, 2, 0), spawn(0, child), remove(2, { ...child, hp: 0 }, "death")];
  const result = buildHealthTimeline(before, after, log, stages(before, after));
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.steps[0]!.eventIndex, 0);
  const bad = [damage(0, 0, child.id, 2, 0), spawn(1, child), remove(2, { ...child, hp: 0 }, "death")];
  assert.equal(buildHealthTimeline(before, after, bad, stages(before, after)).ok, false);
});

test("missing stages, fabricated lifecycle, sequence gaps and mismatched stage health fail closed", () => {
  const before = battle(), after = structuredClone(before), child = unit("swarm:0", 3, 4);
  after.raiders.push({ ...child, intent: null });
  const log = [spawn(0, child)];
  assert.equal(buildHealthTimeline(before, after, log).ok, false);
  assert.equal(buildHealthTimeline(before, after, [], stages(before, after)).ok, false);
  assert.equal(buildHealthTimeline(before, after, [spawn(1, child)], stages(before, after)).ok, false);
  const wrong = stages(before, after); wrong.afterMovement.raiders[0]!.hp--;
  assert.equal(buildHealthTimeline(before, after, log, wrong).ok, false);
  const extra = stages(before, after); extra.afterEnemy.raiders[0]!.hp--;
  assert.equal(buildHealthTimeline(before, after, log, extra).ok, false);
  const bad = [spawn(0, child), damage(1, 1, child.id, 2, 1)];
  after.raiders[1]!.hp = 1;
  assert.equal(buildHealthTimeline(before, after, bad, stages(before, after)).ok, false);
});

test("legacy health-only timeline remains unchanged", () => {
  const before = battle(), after = structuredClone(before); after.raiders[0]!.hp = 1;
  const event = damage(0, 0, "r0", 3, 1);
  const result = buildHealthTimeline(before, after, [event]);
  assert.deepEqual(result, { ok: true, steps: [{ eventIndex: 0, event, effect: event.effects![0] }] });
});

test("a hidden accessor event type cannot erase a transient lifecycle or invoke its getter", () => {
  const state = battle(); let reads = 0;
  const event = Object.defineProperty({}, "type", { get() { reads++; return "raider_spawn"; } });
  assert.equal(buildHealthTimeline(state, state, [event as PresentationChangeLogEvent]).ok, false);
  assert.equal(reads, 0);
});
