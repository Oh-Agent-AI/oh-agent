import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { MechaPerformancePlayer } from "../src/render/mecha/animation.ts";
import { createRoundPerformance, type MechaPerformanceEvent } from "../src/game/mecha/performance.ts";
import { bossExecute, bossPrepare, createMatch, movementPath, pathDistance, validateAndApplyPlan, type ArenaPlan, type MatchState } from "../src/game/mecha/rules.ts";
import { createGunner } from "../src/render/mecha/models.ts";

const plan = (state: MatchState, items: ArenaPlan["items"]): ArenaPlan => ({ revision: state.revision, items });

test("status cues use bounded shared effects and clean them up on interruption", () => {
  const actor = createGunner(), root = new THREE.Group();
  const colors = { poison: "#8bd865", burn: "#ff804d", freeze: "#9ceaff", stun: "#f5d967" } as const;
  const statuses = ["poison", "burn", "freeze", "stun"] as const;
  const events: MechaPerformanceEvent[] = statuses.map(status => ({ kind: "status_cue", actor: "Gunner", source: "boss", status, change: "applied", remainingTurns: 1, cell: { x: 2, y: 3 }, duration: .4 }));
  const player = new MechaPerformancePlayer({ Gunner: actor }, events, cell => new THREE.Vector3(cell.x, 0, cell.y), root, () => {});
  for (const [index, status] of statuses.entries()) {
    player.update(index === 0 ? .2 : .4);
    const impact = root.children.find(child => child instanceof THREE.Mesh) as THREE.Mesh;
    assert.ok(impact.visible);
    assert.ok((impact.material as THREE.MeshBasicMaterial).color.equals(new THREE.Color(colors[status])));
    assert.deepEqual([impact.position.x, impact.position.z], [2, 3]);
  }
  player.dispose();
  assert.equal(root.children.length, 0);
});

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

test("performance overrides settle each event once, pause, and skip safely to completion", () => {
  const actor = createGunner(), effectRoot = new THREE.Group();
  const events: MechaPerformanceEvent[] = [
    { kind: "move", actor: "Gunner", path: [{ x: 0, y: 0 }, { x: 1, y: 0 }], duration: .5 },
    { kind: "attack", actor: "Gunner", attack: "shoot", from: { x: 1, y: 0 }, target: { x: 1, y: 2 }, targetIds: [], duration: .7 },
    { kind: "death", actor: "Gunner", at: { x: 1, y: 0 }, duration: .85 },
  ];
  const settled: number[] = [], played: Array<[number, number]> = [];
  let complete = 0;
  const override = { durations: [1, 2, 1], play: (index: number, elapsed: number) => { played.push([index, elapsed]); return elapsed / [1, 2, 1][index]!; }, settle: (index: number) => { settled.push(index); } };
  assert.throws(() => new MechaPerformancePlayer({ Gunner: actor }, events, () => new THREE.Vector3(), effectRoot, () => {}, { ...override, durations: [1] }), /durations/);
  const player = new MechaPerformancePlayer({ Gunner: actor }, events, (cell) => new THREE.Vector3(cell.x * 8, 0, cell.y * 8), effectRoot, () => { complete++; }, override);
  player.update(1.1); player.update(0); player.update(.1);
  assert.deepEqual(settled, [0]); assert.deepEqual(played.map((value) => value[0]), [1, 1, 1]);
  assert.equal(played[0]![1], played[1]![1]);
  player.update(Infinity); player.update(Infinity);
  assert.deepEqual(settled, [0, 1, 2]); assert.equal(complete, 1);
  assert.deepEqual(actor.position.toArray(), [8, 0, 0]);
  player.dispose(); assert.equal(effectRoot.children.length, 0);
});

test("performance post-pose hook sees override, standard reactions and the final settled pose", () => {
  const actor = createGunner(), effectRoot = new THREE.Group();
  const events: MechaPerformanceEvent[] = [
    { kind: "move", actor: "Gunner", path: [{ x: 0, y: 0 }, { x: 1, y: 0 }], duration: .5 },
    { kind: "attack", actor: "Gunner", attack: "shoot", from: { x: 1, y: 0 }, target: { x: 1, y: 2 }, targetIds: [], duration: .7 },
  ];
  const seen: Array<{ index: number | null; elapsed: number; x: number; cannonZ: number }> = [];
  const cannon = actor.getObjectByName("joint:cannon")!;
  const player = new MechaPerformancePlayer({ Gunner: actor }, events, (cell) => new THREE.Vector3(cell.x * 8, 0, cell.y * 8), effectRoot, () => {}, {
    durations: [1, 1],
    play: (index) => { if (index === 0) { actor.position.x = 3; return null; } return .5; },
    settle: () => {},
    afterPose: (index, elapsed) => { seen.push({ index, elapsed, x: actor.position.x, cannonZ: cannon.position.z }); },
  });
  try {
    player.update(.2);
    assert.equal(seen[0]!.index, 0); assert.equal(seen[0]!.x, 3);
    player.update(1.3);
    assert.equal(seen[1]!.index, 1); assert.equal(seen[1]!.x, 8);
    assert.notEqual(seen[1]!.cannonZ, seen[0]!.cannonZ);
    player.update(Infinity);
    assert.equal(seen[2]!.index, null); assert.equal(seen[2]!.x, 8);
    player.update(0);
    assert.equal(seen[3]!.index, null); assert.equal(seen[3]!.x, 8);
    player.reset(); assert.equal(seen.length, 4);
  } finally { player.dispose(); }
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
  const performing = controller.getState();
  controller.setDoctrine("peel");
  assert.equal(controller.getState(), performing, "doctrine changes are ignored during performance");
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

test("a defeated unit stays fallen when a later attack targets its former cell", () => {
  const fallen = createGunner(), attacker = new THREE.Group(), effectRoot = new THREE.Group();
  const visual = fallen.getObjectByName("mecha-visual")!;
  const events: MechaPerformanceEvent[] = [
    { kind: "death", actor: "Gunner", at: { x: 1, y: 0 }, duration: .85 },
    { kind: "attack", actor: "boss", attack: "smash", from: { x: 0, y: 0 }, target: { x: 1, y: 0 }, targetIds: ["Gunner"], duration: 1 },
  ];
  const settled: number[] = [];
  let completed = 0;
  const player = new MechaPerformancePlayer({ Gunner: fallen, boss: attacker }, events, cell => new THREE.Vector3(cell.x * 8, 0, cell.y * 8), effectRoot, () => completed++, undefined, [], index => settled.push(index));
  try {
    player.update(1.42); // Death completed; the later attack is in its hit window.
    assert.deepEqual(settled, [0]);
    assert.ok(Math.abs(visual.rotation.x - Math.PI / 2) < 1e-9);
    assert.deepEqual(fallen.position.toArray(), [8, 0, 0], "a fallen target is not displaced by hit reaction");
    player.update(0);
    assert.ok(Math.abs(visual.rotation.x - Math.PI / 2) < 1e-9);
    assert.deepEqual(fallen.position.toArray(), [8, 0, 0]);
    assert.deepEqual(settled, [0]);
    player.update(Infinity);
    player.update(Infinity);
    assert.deepEqual(settled, [0, 1]);
    assert.equal(completed, 1);
  } finally { player.dispose(); }
});


test("a hit pushes its target during impact without turning it into a walk", () => {
  const boss = createGunner(), victim = createGunner(), root = new THREE.Group();
  victim.position.set(0, 0, 0); victim.rotation.y = 0.7;
  const events: MechaPerformanceEvent[] = [
    { kind: "attack", actor: "boss", attack: "smash", from: { x: 0, y: -1 }, target: { x: 0, y: 0 }, targetIds: ["Gunner"], duration: 1 },
    { kind: "knockback", actor: "Gunner", path: [{ x: 0, y: 0 }, { x: 1, y: 0 }], duration: .32 },
  ];
  const settled: number[] = [];
  const player = new MechaPerformancePlayer({ boss, Gunner: victim }, events, c => new THREE.Vector3(c.x * 8, 0, c.y * 8), root, () => {}, undefined, [], i => settled.push(i));
  player.update(.25); assert.equal(victim.position.x, 0);
  player.update(.45); assert.ok(victim.position.x > 0 && victim.position.x < 8, "impact moves the victim before the attack finishes");
  assert.equal(victim.rotation.y, 0.7, "knockback does not turn the victim to walk toward the destination");
  player.update(.3); assert.equal(victim.position.x, 8, "no snap back between attack and knockback events");
  player.update(.32); assert.equal(victim.position.x, 8); assert.deepEqual(settled, [0, 1]);
  player.dispose();
});
