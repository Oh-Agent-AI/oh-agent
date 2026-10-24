import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { METERS_PER_UNIT } from "../src/engine/worldScale.ts";
import { MECHA_CELL_METERS, MECHA_METERS_PER_UNIT, createAssault, createBoss, createGunner, createSupport, disposeMechaModel } from "../src/game/mecha/models.ts";

const CELL = 8;
const BOSS_FOOT = 16;

function bounds(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(root);
}

test("mechs stand in one 16 m cell and the alien fills two", () => {
  assert.equal(MECHA_METERS_PER_UNIT, METERS_PER_UNIT);
  assert.equal(MECHA_CELL_METERS / METERS_PER_UNIT, CELL);
  const figures = [
    ["assault", createAssault()],
    ["gunner", createGunner()],
    ["support", createSupport()],
    ["boss", createBoss()],
  ] as const;
  const boxes = Object.fromEntries(figures.map(([name, root]) => [name, bounds(root)]));
  for (const name of ["assault", "gunner", "support"] as const) {
    const box = boxes[name];
    assert.ok(box.min.y >= -0.05 && box.min.y <= 0.05, `${name} feet ${box.min.y}`);
    assert.ok(box.max.x - box.min.x < CELL, `${name} width ${box.max.x - box.min.x}`);
    assert.ok(box.max.z - box.min.z < CELL, `${name} depth ${box.max.z - box.min.z}`);
    assert.ok(box.max.y > 8, `${name} height ${box.max.y}`);
    const front = figures.find(([id]) => id === name)?.[1].getObjectByName("front");
    assert.ok(front);
    const spot = new THREE.Vector3();
    front.getWorldPosition(spot);
    assert.ok(spot.z < -0.2, `${name} faces -Z, got ${spot.z}`);
  }
  const boss = boxes.boss;
  assert.ok(boss.min.y >= -0.05 && boss.min.y <= 0.05, `boss feet ${boss.min.y}`);
  assert.ok(boss.max.x - boss.min.x < BOSS_FOOT, `boss width ${boss.max.x - boss.min.x}`);
  assert.ok(boss.max.z - boss.min.z < BOSS_FOOT, `boss depth ${boss.max.z - boss.min.z}`);
  assert.ok(boss.max.y > boxes.assault.max.y, "the alien stands over the assault mech");
  const face = figures[3][1].getObjectByName("front");
  assert.ok(face);
  const eye = new THREE.Vector3();
  face.getWorldPosition(eye);
  assert.ok(eye.z < -4, `boss head z ${eye.z}`);
  for (const [, root] of figures) disposeMechaModel(root);
});
