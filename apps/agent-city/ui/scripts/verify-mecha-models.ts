import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { METERS_PER_UNIT } from "../src/engine/worldScale.ts";
import { MECHA_CELL_METERS, MECHA_FACTION_COLORS, MECHA_METERS_PER_UNIT, createAssault, createBoss, createGunner, createRaider, createSupport, disposeMechaModel } from "../src/render/mecha/models.ts";

const CELL = 8;
const BOSS_FOOT = 16;

function bounds(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(root);
}

test("mechs and raiders stand in one cell and the boss fills two", () => {
  assert.equal(MECHA_METERS_PER_UNIT, METERS_PER_UNIT);
  assert.equal(MECHA_CELL_METERS / METERS_PER_UNIT, CELL);
  const figures = [
    ["assault", createAssault()],
    ["gunner", createGunner()],
    ["support", createSupport()],
    ["raider", createRaider()],
    ["boss", createBoss()],
  ] as const;
  const boxes = Object.fromEntries(figures.map(([name, root]) => [name, bounds(root)]));
  for (const name of ["assault", "gunner", "support", "raider"] as const) {
    const box = boxes[name];
    assert.ok(box.min.y >= -0.05 && box.min.y <= 0.05, `${name} feet ${box.min.y}`);
    assert.ok(box.max.x - box.min.x < CELL, `${name} width ${box.max.x - box.min.x}`);
    assert.ok(box.max.z - box.min.z < CELL, `${name} depth ${box.max.z - box.min.z}`);
    assert.ok(name === "raider" ? box.max.y < 4 && box.max.y > 2 : box.max.y > 4, `${name} height ${box.max.y}`);
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
  const face = figures[4][1].getObjectByName("front");
  assert.ok(face);
  const eye = new THREE.Vector3();
  face.getWorldPosition(eye);
  assert.ok(eye.z < -4, `boss head z ${eye.z}`);
  for (const [, root] of figures) disposeMechaModel(root);
});

test("the raider is a distinct light silhouette with independently rigged legs", () => {
  const assault = createAssault();
  const boss = createBoss();
  const raider = createRaider();
  assert.equal(raider.userData.role, "Raider");
  assert.equal(raider.scale.x, 1);
  assert.ok(raider.getObjectByName("joint:leg-left"));
  assert.ok(raider.getObjectByName("joint:rear-right"));
  assert.ok(bounds(raider).max.y < bounds(assault).max.y * 0.4);
  let meshes = 0;
  raider.traverse((node) => { if (node instanceof THREE.Mesh) meshes++; });
  assert.ok(meshes < 30, `rigged raider should batch armor within joints: ${meshes} draws`);
  for (const root of [assault, boss, raider]) disposeMechaModel(root);
});

test("the railgun extends the gunner silhouette beyond its torso", () => {
  const gunner = createGunner();
  gunner.updateMatrixWorld(true);
  const parts: THREE.Mesh[] = [];
  gunner.traverse((part) => { if (part instanceof THREE.Mesh && part.name === "railgun") parts.push(part); });
  assert.ok(parts.length >= 5, "the railgun has a body, rails, energy strip and muzzle");
  const box = new THREE.Box3();
  for (const part of parts) box.union(new THREE.Box3().setFromObject(part));
  assert.ok(box.max.z - box.min.z > 5, `railgun length ${box.max.z - box.min.z}`);
  assert.ok(box.min.z < -5, `railgun muzzle ${box.min.z}`);
  disposeMechaModel(gunner);
});

test("friendly and enemy models share their faction identification color", () => {
  const figures = [
    [createAssault(), MECHA_FACTION_COLORS.friendly],
    [createGunner(), MECHA_FACTION_COLORS.friendly],
    [createSupport(), MECHA_FACTION_COLORS.friendly],
    [createBoss(), MECHA_FACTION_COLORS.enemy],
    [createRaider(), MECHA_FACTION_COLORS.enemy],
  ] as const;
  const expected = new THREE.Color();
  for (const [root, color] of figures) {
    const markers: THREE.Mesh[] = [];
    root.traverse((part) => {
      if (part instanceof THREE.Mesh && part.name === "faction") markers.push(part);
    });
    assert.ok(markers.length > 0, `${root.name} has faction markings`);
    expected.set(color);
    for (const marker of markers) {
      const paint = marker.material as THREE.MeshStandardMaterial;
      assert.ok(paint.color.equals(expected), `${root.name} faction color ${paint.color.getHexString()}`);
      assert.ok(paint.emissive.equals(expected), `${root.name} faction emissive ${paint.emissive.getHexString()}`);
    }
    disposeMechaModel(root);
  }
});
