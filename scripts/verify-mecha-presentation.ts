import assert from "node:assert/strict";
import test from "node:test";
import { HealthPresentationQueue, timeHealthEffects, type PresentationBatch } from "../apps/agent-city/ui/src/game/mecha/presentationQueue.ts";
import type { HealthTimeline } from "../apps/agent-city/ui/src/game/mecha/healthTimeline.ts";

const impact = { kind: "boss" as const, id: "boss", before: 40, after: 35, order: 0 };
const timeline: HealthTimeline = { ok: true, steps: [{ eventIndex: 3, event: { type: "act", mechId: "Assault", action: "melee", target: "boss", damage: 5, effects: [impact] }, effect: impact }] };

test("explicit hit time required, and missing evidence is rejected", () => {
  assert.equal(timeHealthEffects(1, timeline, 1, new Map()).ok, false);
  assert.equal(timeHealthEffects(1, { ok: false, reason: "does not reconcile" }, 1, new Map([[0, 0.3]])).ok, false);
  assert.equal(timeHealthEffects(1, timeline, 1, new Map([[0, 1.1]])).ok, false);
  const valid = timeHealthEffects(1, timeline, 1, new Map([[0, 0.3]]));
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.batch.effects[0]!.at, 0.3);
});

test("hit is delivered only at its time; pause, queues and large frame deltas do not lose events", () => {
  const first = timeHealthEffects(1, timeline, 1, new Map([[0, 0.3]]));
  const second = timeHealthEffects(2, timeline, 1, new Map([[0, 0.3]]));
  if (!first.ok || !second.ok) throw new Error("fixture invalid");
  const queue = new HealthPresentationQueue(); queue.enqueue(first.batch); queue.enqueue(second.batch);
  assert.deepEqual(queue.advance(0.29), []);
  queue.setPaused(true); assert.deepEqual(queue.advance(5), []); assert.equal(queue.pending, 2);
  queue.setPaused(false); assert.deepEqual(queue.advance(0.02).map((x) => x.batchId), [1]);
  assert.deepEqual(queue.advance(2).map((x) => x.batchId), [2]); assert.equal(queue.pending, 0);
  assert.deepEqual(queue.advance(100), []);
});

test("events and queued batches are stable under 30 or 60 updates per second", () => {
  const batch = timeHealthEffects(1, timeline, 1, new Map([[0, 0.3]]));
  if (!batch.ok) throw new Error("fixture invalid");
  const run = (fps: number) => {
    const queue = new HealthPresentationQueue(); queue.enqueue(batch.batch);
    const delivered: number[] = [];
    for (let i = 0; i < fps + 1; i++) for (const hit of queue.advance(1 / fps)) delivered.push(hit.item.effect.after);
    return { delivered, pending: queue.pending };
  };
  assert.deepEqual(run(30), { delivered: [35], pending: 0 });
  assert.deepEqual(run(60), run(30));
});

test("invalid or duplicate batches fail without changing queued work", () => {
  const queue = new HealthPresentationQueue();
  const batch: PresentationBatch = { id: 1, duration: 1, effects: [{ at: 0.3, eventIndex: 3, effect: impact }] };
  queue.enqueue(batch);
  assert.throws(() => queue.enqueue(batch));
  assert.throws(() => queue.enqueue({ ...batch, id: 2, effects: [{ ...batch.effects[0]!, at: 2 }] }));
  assert.equal(queue.pending, 1);
  batch.effects[0]!.effect.after = 0;
  assert.equal(queue.advance(0.4)[0]!.item.effect.after, 35, "enqueued effects are copied");
  queue.clear(); assert.equal(queue.pending, 0);
  queue.enqueue({ id: 0, duration: 0, effects: [] }); queue.advance(0); assert.equal(queue.pending, 0);
});

test("accepted turn retains movement and pre-knockback target positions", async () => {
  const { bossPrepare, createMatch, playTurn } = await import("../apps/agent-city/ui/src/game/mecha/rules.ts");
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 4 }, mechs: [
    { id: "Assault", pos: { x: 5, y: 2 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } },
  ] });
  bossPrepare(state);
  const result = playTurn(state, { revision: state.revision, items: [
    { mechId: "Assault", moveTo: { x: 5, y: 3 }, action: { kind: "melee", target: "boss" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
    { mechId: "Support", moveTo: null, action: { kind: "skip" } },
  ] });
  assert.equal(result.ok, true);
  if (!result.ok || !result.presentationStages) throw new Error("missing presentation stages");
  const stages = result.presentationStages;
  assert.deepEqual(stages.before.mechs.find((m) => m.id === "Assault")!.pos, { x: 5, y: 2 });
  assert.deepEqual(stages.afterMovement.mechs.find((m) => m.id === "Assault")!.pos, { x: 5, y: 3 });
  assert.deepEqual(stages.afterMovement.boss.anchor, { x: 4, y: 4 }, "target is still at its pre-punch position");
  assert.deepEqual(stages.afterPlayer.boss.anchor, { x: 4, y: 5 }, "knockback belongs after the action");
  assert.ok(stages.afterPlayer.boss.hp < stages.afterMovement.boss.hp);
  assert.deepEqual(stages.afterPrepare.boss.anchor, result.state.boss.anchor);
  result.state.boss.anchor.x = 9;
  assert.deepEqual(stages.afterPrepare.boss.anchor, { x: 4, y: 5 }, "snapshots do not alias the rules state");
});

test("invalid movement history refuses a presentation snapshot", async () => {
  const { createMatch } = await import("../apps/agent-city/ui/src/game/mecha/rules.ts");
  const { movementSnapshot, presentationSnapshot } = await import("../apps/agent-city/ui/src/game/mecha/presentationSnapshot.ts");
  const initial = presentationSnapshot(createMatch({ preset: "covers_sparse_mid", script: "stationary_smash" }));
  assert.equal(movementSnapshot(initial, [{ type: "move", mechId: "Assault", from: { x: 99, y: 99 }, to: { x: 1, y: 1 } }]), null);
  assert.equal(movementSnapshot(initial, [
    { type: "act", mechId: "Assault", action: "skip", damage: 0 },
    { type: "move", mechId: "Assault", from: initial.mechs[0]!.pos, to: { x: 1, y: 1 } },
  ]), null);
});
