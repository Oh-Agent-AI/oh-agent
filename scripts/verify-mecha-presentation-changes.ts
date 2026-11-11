import assert from "node:assert/strict";
import test from "node:test";
import { createMechaController } from "../apps/agent-city/ui/src/game/mecha/controller.ts";
import { buildPresentationChanges } from "../apps/agent-city/ui/src/game/mecha/presentationChanges.ts";
import type { PresentationSnapshot, PresentationStages, TurnEvent } from "../apps/agent-city/ui/src/game/mecha/board.ts";
// Keep the new rule-event and player regressions in the standard mecha verification gate.
import "../apps/agent-city/ui/tests/mecha-monster-new-presentation.test.ts";
import "../apps/agent-city/ui/tests/mecha-monster-new-player.test.ts";

const snapshot = (): PresentationSnapshot => ({
  boss: { anchor: { x: 4, y: 4 }, hp: 10 },
  mechs: [{ id: "Assault", pos: { x: 3, y: 4 }, hp: 10 }], raiders: [], buildings: [], outcome: null,
});
test("replays interleaved enemy health, shove, and later health in actual mutation order", () => {
  const start = snapshot();
  const end = structuredClone(start); end.mechs[0]!.pos.x = 2; end.mechs[0]!.hp = 6;
  const stages: PresentationStages = { before: start, afterMovement: start, afterPlayer: start, afterEnemy: end, afterPrepare: end };
  const log: TurnEvent[] = [
    { type: "enemy", actor: "boss", skill: "smash", cells: [], damage: 4, effects: [
      { kind: "mech", id: "Assault", before: 10, after: 8, order: 0, sequence: 0 },
      { kind: "mech", id: "Assault", before: 8, after: 6, order: 1, sequence: 2 },
    ] },
    { type: "shove", unit: "Assault", dir: { x: -1, y: 0 }, damage: 0, sequence: 1 },
  ];
  const result = buildPresentationChanges(stages, log);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.changes.map((c) => c.kind), ["health", "shove", "health"]);
  const bad = structuredClone(log); (bad[1] as Extract<TurnEvent, {type:"shove"}>).sequence = 2;
  assert.equal(buildPresentationChanges(stages, bad).ok, false);
  const missing = structuredClone(log); delete (missing[1] as Extract<TurnEvent, {type:"shove"}>).sequence;
  assert.equal(buildPresentationChanges(stages, missing).ok, false);
});

test("real automatic matches reconcile each accepted turn's changes", () => {
  let checked = 0;
  for (const script of ["siege", "cadence_ssw", "stationary_smash"] as const) for (const doctrine of ["tunnel", "peel"] as const) {
    const c = createMechaController({ script, doctrine });
    c.startAuto();
    for (let i = 0; i < 40 && c.getState().auto; i++) {
      const previous = c.getState().combat.id; c.tick();
      const combat = c.getState().combat;
      if (combat.id !== previous && !combat.reset) {
        assert.ok(combat.presentationChanges?.ok, JSON.stringify(combat.presentationChanges));
        checked++;
      }
    }
  }
  assert.ok(checked >= 10, `only ${checked} turns`);
});

test("collision preserves its marker after damage and never moves the actor", () => {
  const start = snapshot(), end = structuredClone(start); end.mechs[0]!.hp = 8;
  const stages: PresentationStages = { before: start, afterMovement: start, afterPlayer: start, afterEnemy: end, afterPrepare: end };
  const log: TurnEvent[] = [{ type: "shove", unit: "Assault", dir: { x: -1, y: 0 }, hit: "wall", damage: 2, sequence: 1, effects: [{ kind: "mech", id: "Assault", before: 10, after: 8, order: 0, sequence: 0 }] }];
  const result = buildPresentationChanges(stages, log);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.changes.map((c) => c.kind), ["health", "collision"]);
  end.mechs[0]!.pos.x -= 1;
  assert.equal(buildPresentationChanges(stages, log).ok, false);
});

test("boss movement is sequenced and reconciled before damage, rejecting false evidence", () => {
  const start = snapshot();
  const end = structuredClone(start);
  end.boss.anchor = { x: 4, y: 6 };
  end.mechs[0]!.hp = 8;
  const stages: PresentationStages = { before: start, afterMovement: start, afterPlayer: start, afterEnemy: end, afterPrepare: end };
  const log: TurnEvent[] = [
    { type: "boss_move", from: { x: 4, y: 4 }, to: { x: 4, y: 6 }, sequence: 0 },
    { type: "enemy", actor: "boss", skill: "spore_leap", cells: [{ x: 3, y: 4 }], damage: 2,
      effects: [{ kind: "mech", id: "Assault", before: 10, after: 8, order: 0, sequence: 1 }] },
  ];
  const result = buildPresentationChanges(stages, log);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.changes.map((c) => c.kind), ["boss_move", "health"]);
  const bad = structuredClone(log);
  const movement = bad[0] as Extract<TurnEvent, { type: "boss_move" }>;
  movement.from = { x: 2, y: 4 };
  assert.equal(buildPresentationChanges(stages, bad).ok, false);
  movement.from = { x: 4, y: 4 };
  movement.to = { x: 9, y: 4 };
  assert.equal(buildPresentationChanges(stages, bad).ok, false);
  delete movement.sequence;
  assert.equal(buildPresentationChanges(stages, bad).ok, false);
});

test("prism status transitions reconcile in order and reject fabricated shield evidence", () => {
  const start = snapshot(), end = structuredClone(start);
  const stages: PresentationStages = { before: start, afterMovement: start, afterPlayer: start, afterEnemy: end, afterPrepare: end };
  const log: TurnEvent[] = [
    { type: "monster_status", actor: "boss", status: "prism_guard", change: "applied", remaining: 1, sequence: 0 },
    { type: "monster_status", actor: "boss", status: "prism_guard", change: "absorbed", remaining: 0, sequence: 1 },
  ];
  const result = buildPresentationChanges(stages, log);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.changes.map(c => c.kind), ["monster_status", "monster_status"]);
  const missing = structuredClone(log);
  delete (missing[0] as Extract<TurnEvent, { type: "monster_status" }>).sequence;
  assert.equal(buildPresentationChanges(stages, missing).ok, false);
  assert.equal(buildPresentationChanges(stages, [log[1]!]).ok, false);
  const shielded = structuredClone(end); shielded.boss.shield = { kind: "prism_guard", hits: 1 };
  assert.equal(buildPresentationChanges({ ...stages, afterEnemy: shielded }, log).ok, false);
  const expiry = { ...log[1]!, change: "expired" } as TurnEvent;
  assert.equal(buildPresentationChanges(stages, [log[0]!, expiry]).ok, true);
});
