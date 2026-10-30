import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { MechaPerformancePlayer } from "../src/render/mecha/animation.ts";
import { createRoundPerformance, type MechaPerformanceEvent } from "../src/game/mecha/performance.ts";
import { bossExecute, bossPrepare, createMatch, movementPath, pathDistance, validateAndApplyPlan, type ArenaPlan, type MatchState } from "../src/game/mecha/rules.ts";
import { createGunner } from "../src/render/mecha/models.ts";

const plan = (state: MatchState, items: ArenaPlan["items"]): ArenaPlan => ({ revision: state.revision, items });

function resolve(state: MatchState, orders: ArenaPlan) {
  const playerDone = structuredClone(state);
  const result = validateAndApplyPlan(playerDone, orders);
  assert.ok("ok" in result, JSON.stringify(result));
  const enemyDone = structuredClone(playerDone);
  if (enemyDone.phase === "resolving_boss") bossExecute(enemyDone);
  const finalState = structuredClone(enemyDone);
  if (finalState.phase === "enemy_prepare") bossPrepare(finalState);
  return { playerDone, enemyDone, finalState };
}

test("movement paths preserve route cost and avoid blocked cells", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "siege" });
  state.terrain[9][3] = "water";
  const path = movementPath(state, { x: 2, y: 9 }, { x: 6, y: 9 }, "Assault");
  assert.ok(path);
  assert.equal(pathDistance(state, path[0], path[path.length - 1], "Assault"), pathDistance(state, { x: 2, y: 9 }, { x: 6, y: 9 }, "Assault"));
  assert.ok(path.every((cell) => state.terrain[cell.y][cell.x] !== "water"));
  assert.ok(path.every((cell, index) => index === 0 || Math.max(Math.abs(cell.x - path[index - 1].x), Math.abs(cell.y - path[index - 1].y)) === 1));
});

test("a lethal melee plays attack before death and never resurrects the boss attack", () => {
  const before = createMatch({ preset: "covers_sparse_mid", script: "cadence_ssw" });
  before.boss.anchor = { x: 2, y: 7 };
  before.boss.hp = 1;
  bossPrepare(before);
  const orders = plan(before, [
    { mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
    { mechId: "Support", moveTo: null, action: { kind: "skip" } },
  ]);
  const snapshot = JSON.stringify(before);
  const { playerDone, enemyDone, finalState } = resolve(before, orders);
  const events = createRoundPerformance(before, orders, playerDone, enemyDone, finalState);
  const attack = events.findIndex((event) => event.kind === "attack" && event.actor === "Assault");
  const death = events.findIndex((event) => event.kind === "death" && event.actor === "boss");
  assert.ok(attack >= 0 && death > attack);
  assert.ok(!events.some((event) => event.kind === "attack" && event.actor === "boss"));
  assert.equal(JSON.stringify(before), snapshot);
});

test("shoot, repair, enemy impact and knockback all have explicit beats", () => {
  const before = createMatch({ preset: "covers_sparse_mid", script: "cadence_ssw" });
  before.boss.anchor = { x: 5, y: 4 };
  before.mechs.find((mech) => mech.id === "Gunner")!.pos = { x: 5, y: 8 };
  before.mechs.find((mech) => mech.id === "Support")!.pos = { x: 6, y: 8 };
  bossPrepare(before);
  const orders = plan(before, [
    { mechId: "Assault", moveTo: null, action: { kind: "skip" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "shoot", target: "boss" } },
    { mechId: "Support", moveTo: null, action: { kind: "repair", target: "Gunner" } },
  ]);
  const { playerDone, enemyDone, finalState } = resolve(before, orders);
  playerDone.boss.intent = { skillId: "smash", local: [{ x: 0, y: 4 }], projected: [{ x: 5, y: 8 }], cdSweep: 0, status: "planned" };
  const damaged = structuredClone(playerDone);
  bossExecute(damaged);
  const events = createRoundPerformance(before, orders, playerDone, damaged, finalState);
  assert.ok(events.some((event) => event.kind === "attack" && event.attack === "shoot"));
  assert.ok(events.some((event) => event.kind === "attack" && event.attack === "repair"));
  assert.ok(events.some((event) => event.kind === "attack" && event.actor === "boss" && event.targetIds.includes("Gunner")));
  assert.ok(events.some((event) => event.kind === "knockback" && event.actor === "Gunner"));
});

test("the player freezes at zero dt, completes once and restores joints", () => {
  const actor = createGunner();
  const effectRoot = new THREE.Group();
  const cannon = actor.getObjectByName("joint:cannon")!;
  const rest = cannon.position.clone();
  let completed = 0;
  const events: MechaPerformanceEvent[] = [
    { kind: "move", actor: "Gunner", path: [{ x: 0, y: 0 }, { x: 1, y: 0 }], duration: 0.5 },
    { kind: "attack", actor: "Gunner", attack: "shoot", from: { x: 1, y: 0 }, target: { x: 1, y: 2 }, targetIds: ["boss"], duration: 0.7 },
    { kind: "death", actor: "Gunner", at: { x: 1, y: 0 }, duration: 0.85 },
  ];
  const player = new MechaPerformancePlayer({ Gunner: actor }, events, (cell) => new THREE.Vector3(cell.x * 8, 0, cell.y * 8), effectRoot, () => { completed += 1; });
  player.update(0.2);
  const paused = actor.position.clone();
  player.update(0);
  assert.deepEqual(actor.position, paused);
  player.update(0.5);
  assert.notEqual(cannon.position.z, rest.z);
  player.update(100);
  player.update(100);
  assert.equal(completed, 1);
  player.dispose();
  assert.deepEqual(cannon.position, rest);
  assert.equal(actor.rotation.x, 0);
  assert.equal(effectRoot.children.length, 0);
});

test("committed logs suppress fizzled attacks and retain simultaneous ally paths", async () => {
  const { performanceFromLog } = await import("../src/game/mecha/performance.ts");
  const before = createMatch({ preset: "covers_sparse_mid", script: "siege" });
  const events = performanceFromLog(before, structuredClone(before), [
    { type: "act", mechId: "Gunner", action: "pierce", target: "boss", damage: 0, fizzled: true },
  ]);
  assert.ok(!events.some((event) => event.kind === "attack"));
  before.mechs[1]!.pos = { x: 3, y: 9 };
  assert.equal(movementPath(before, { x: 2, y: 9 }, { x: 3, y: 9 }, "Assault"), null);
  assert.deepEqual(movementPath(before, { x: 2, y: 9 }, { x: 3, y: 9 }, "Assault", { alliesPass: true }), [{ x: 2, y: 9 }, { x: 3, y: 9 }]);
});

test("animated controller blocks editing and auto ticks until completion; restart cancels", async () => {
  const { createMechaController } = await import("../src/game/mecha/controller.ts");
  const controller = createMechaController({ animate: true });
  controller.submit();
  assert.ok(controller.getState().performance);
  assert.equal(controller.getState().interactive, false);
  const match = controller.getState().match;
  controller.submit();
  controller.startAuto();
  controller.tick();
  assert.equal(controller.getState().match, match);
  controller.pause();
  assert.equal(controller.getState().paused, true);
  controller.resume();
  controller.finishPerformance();
  assert.equal(controller.getState().performance, null);
  assert.equal(controller.getState().match, match);
  controller.finishPerformance();
  controller.stopAuto();
  controller.applyDoctrine();
  controller.submit();
  assert.ok(controller.getState().performance);
  controller.restart();
  assert.equal(controller.getState().performance, null);
  assert.equal(controller.getState().interactive, true);
});
