import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { MechaPerformancePlayer } from "../src/render/mecha/animation.ts";
import type { MechaPerformanceEvent } from "../src/render/mecha/performance.ts";

const world = (cell: { x: number; y: number }, actor: string) => new THREE.Vector3(cell.x * 10 + (actor === "boss" ? 5 : 0), 0, cell.y * 10 + (actor === "boss" ? 5 : 0));

test("phase playback moves both actors in one cue and settles them simultaneously", () => {
  const boss = new THREE.Group(), mech = new THREE.Group(), root = new THREE.Group();
  const bossFrom = { x: 1, y: 1 }, mechFrom = { x: 5, y: 5 };
  boss.position.copy(world(bossFrom, "boss")); mech.position.copy(world(mechFrom, "Assault"));
  const events: MechaPerformanceEvent[] = [{ kind: "monster_displacement", actor: "boss", skill: "phase_swap", duration: 1,
    moves: [{ actor: "boss", from: bossFrom, to: mechFrom }, { actor: "Assault", from: mechFrom, to: bossFrom }] }];
  const settled: number[] = [];
  const player = new MechaPerformancePlayer({ boss, Assault: mech }, events, world, root, () => {}, undefined, [], i => settled.push(i));
  try {
    player.update(.5);
    assert.equal(boss.position.x, 35); assert.equal(mech.position.x, 30);
    assert.deepEqual(settled, []);
    player.update(.5);
    assert.deepEqual(boss.position.toArray(), world(mechFrom, "boss").toArray());
    assert.deepEqual(mech.position.toArray(), world(bossFrom, "Assault").toArray());
    assert.deepEqual(settled, [0]);
  } finally { player.dispose(); }
});

test("corrode cues flash the affected cell, not the boss footprint center", () => {
  const root = new THREE.Group(), boss = new THREE.Group();
  const events: MechaPerformanceEvent[] = [{ kind: "corrode_field", actor: "boss", change: "created", fieldId: "f", cell: { x: 3, y: 4 }, duration: 1 }];
  const player = new MechaPerformancePlayer({ boss }, events, world, root, () => {});
  try {
    player.update(.5);
    const ring = root.children.find(c => c instanceof THREE.Mesh)!;
    assert.ok(ring.visible); assert.equal(ring.position.x, 30); assert.equal(ring.position.z, 40);
    player.update(.5); assert.equal(ring.visible, false);
  } finally { player.dispose(); }
});

test("connected battle playback preserves the Assault half of the shared swap arc", async () => {
  const { createAssaultBattlePlayer } = await import("../src/render/mecha/assaultBattlePlayer.ts");
  const boss = new THREE.Group(), assault = new THREE.Group(), root = new THREE.Group();
  const a = { x: 1, y: 1 }, b = { x: 5, y: 5 };
  boss.position.copy(world(a, "boss")); assault.position.copy(world(b, "Assault"));
  const events: MechaPerformanceEvent[] = [{ kind: "monster_displacement", actor: "boss", skill: "phase_swap", duration: 1,
    moves: [{ actor: "boss", from: a, to: b }, { actor: "Assault", from: b, to: a }] }];
  const { player, release } = createAssaultBattlePlayer({ boss, Assault: assault }, events, world, root, () => {});
  try {
    player.update(.5);
    assert.ok(boss.position.y > 0); assert.ok(assault.position.y > 0);
    player.update(.5);
    assert.deepEqual(boss.position.toArray(), world(b, "boss").toArray());
    assert.deepEqual(assault.position.toArray(), world(a, "Assault").toArray());
  } finally { player.dispose(); release(); }
});
