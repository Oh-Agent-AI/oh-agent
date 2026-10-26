import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { METERS_PER_UNIT } from "../src/engine/worldScale.ts";
import { MECHA_CELL_METERS, MECHA_METERS_PER_UNIT, createAssault, createBoss, createGunner, createRaider, createSupport, disposeMechaModel } from "../src/game/mecha/models.ts";

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

test("raider has an independent low silhouette and fits a single cell", () => {
  const raider = createRaider();
  const boss = createBoss();
  try {
    const small = bounds(raider);
    const large = bounds(boss);
    assert.equal(raider.userData.role, "Raider");
    assert.equal(raider.scale.x, 1);
    assert.ok(Math.abs(small.min.y) < 0.05);
    assert.ok(small.max.x - small.min.x < CELL);
    assert.ok(small.max.z - small.min.z < CELL);
    assert.ok(small.max.y < large.max.y * 0.4);
    const face = new THREE.Vector3();
    raider.getObjectByName("front")!.getWorldPosition(face);
    assert.ok(face.z < -2);
    let meshes = 0;
    raider.traverse((node) => { if (node instanceof THREE.Mesh) meshes++; });
    // Rigged legs batch independently so they can move without splitting every plate.
    assert.ok(meshes < 24, `rigged raider should batch armor within joints: ${meshes} draws`);
  } finally {
    disposeMechaModel(raider);
    disposeMechaModel(boss);
  }
});
