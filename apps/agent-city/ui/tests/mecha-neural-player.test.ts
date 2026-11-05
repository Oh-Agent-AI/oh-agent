import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { MechaPerformancePlayer } from "../src/render/mecha/animation.ts";
import type { MechaPerformanceEvent } from "../src/render/mecha/performance.ts";

const world = (cell: { x: number; y: number }, actor: string) =>
  new THREE.Vector3(cell.x * 10 + (actor === "boss" ? 5 : 0), 0, cell.y * 10 + (actor === "boss" ? 5 : 0));

test("neural creation and break draw only the evidence endpoints and settle without moving actors", () => {
  for (const change of ["created", "broken"] as const) {
    const root = new THREE.Group(), boss = new THREE.Group(), raider = new THREE.Group();
    const from = { x: 4, y: 4 }, target = { x: 3, y: 4 };
    boss.position.copy(world(from, "boss")); raider.position.copy(world(target, "a"));
    const events: MechaPerformanceEvent[] = [{ kind: "neural_link", actor: "boss", change, from, target, duration: 1 }];
    const settled: number[] = []; let completed = 0;
    const player = new MechaPerformancePlayer({ boss, a: raider }, events, world, root, () => { completed++; }, undefined, [], i => settled.push(i));
    try {
      player.update(.5);
      const beam = root.children.find(child => child instanceof THREE.Line) as THREE.Line;
      const flash = root.children.find(child => child instanceof THREE.Mesh) as THREE.Mesh;
      assert.ok(beam.visible && flash.visible);
      const points = beam.geometry.getAttribute("position");
      assert.deepEqual([points.getX(0), points.getY(0), points.getZ(0)], [45, 16, 45]);
      assert.deepEqual([points.getX(1), points.getY(1), points.getZ(1)], [30, 10, 40]);
      assert.deepEqual(flash.position.toArray(), [30, .8, 40]);
      assert.deepEqual(boss.position.toArray(), world(from, "boss").toArray());
      assert.deepEqual(raider.position.toArray(), world(target, "a").toArray());
      player.update(.5);
      assert.equal(beam.visible, false); assert.equal(flash.visible, false);
      assert.deepEqual(settled, [0]); assert.equal(completed, 1);
      assert.deepEqual(boss.position.toArray(), world(from, "boss").toArray());
      assert.deepEqual(raider.position.toArray(), world(target, "a").toArray());
    } finally { player.dispose(); }
    assert.equal(root.children.length, 0);
  }
});
