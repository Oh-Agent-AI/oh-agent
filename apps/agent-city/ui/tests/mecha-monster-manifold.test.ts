import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { PLANNED_MONSTER_SPECIES_IDS } from "../src/game/mecha/monsters/contracts.ts";
import { createMonsterSpeciesPresentation } from "../src/game/mecha/presentation/monsters/MonsterSpeciesPresentation.ts";
import { createBoss, createRaider, disposeMechaModel } from "../src/render/mecha/models.ts";

const species = [
  "spore_leaper", "flux_lancer", "porous_shaper", "prism_warden", "swarm_mantle",
  "phase_stalker", "gravity_core", "neural_weaver", "many_core", "field_sovereign",
] as const;

test("manifold coverage includes all ten planned species", () => {
  assert.deepEqual([...PLANNED_MONSTER_SPECIES_IDS].sort(), [...species].sort());
});

function pointClouds(root: THREE.Object3D): THREE.Points[] {
  const result: THREE.Points[] = [];
  root.traverse((node) => { if (node instanceof THREE.Points) result.push(node); });
  return result;
}

function cloud(root: THREE.Object3D, name: string): THREE.Points {
  const matches = pointClouds(root).filter((node) => node.name === name);
  assert.equal(matches.length, 1, `${name} must occur exactly once`);
  return matches[0]!;
}

function positions(points: THREE.Points, min: number, max: number): number[] {
  const position = points.geometry.getAttribute("position");
  assert.ok(position && position.itemSize === 3, `${points.name} needs xyz positions`);
  assert.ok(position.count >= min && position.count <= max, `${points.name} point count ${position.count} must be in [${min}, ${max}]`);
  const sphere = points.geometry.boundingSphere;
  assert.ok(sphere && Number.isFinite(sphere.radius) && sphere.radius > 0 && sphere.radius <= 7,
    `${points.name} needs a finite bounded sphere`);
  const data: number[] = [];
  const vertex = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i);
    assert.ok(Number.isFinite(vertex.x) && Number.isFinite(vertex.y) && Number.isFinite(vertex.z),
      `${points.name} vertex ${i} must be finite`);
    assert.ok(vertex.distanceTo(sphere.center) <= sphere.radius + 1e-5, `${points.name} vertex ${i} exceeds its bounding sphere`);
    data.push(vertex.x, vertex.y, vertex.z);
  }
  assert.ok(data.some((value, i) => i >= 3 && value !== data[i % 3]), `${points.name} must not collapse to a single point`);
  return data;
}

function phase(points: THREE.Points): number {
  assert.ok(points.material instanceof THREE.ShaderMaterial, `${points.name} must use a shader`);
  const value: unknown = points.material.uniforms.phase?.value;
  assert.ok(typeof value === "number" && Number.isFinite(value), `${points.name} needs a finite phase`);
  assert.ok((points.material.vertexShader.match(/\bphase\b/g) ?? []).length >= 2,
    `${points.name} vertex shader must use phase, not merely declare it`);
  return value;
}

/** A prototype raycast proves the ray actually hits before testing the override. */
function assertNonPickable(points: THREE.Points): void {
  points.updateWorldMatrix(true, false);
  const position = points.geometry.getAttribute("position");
  assert.ok(position && position.count > 0);
  const target = new THREE.Vector3().fromBufferAttribute(position, 0).applyMatrix4(points.matrixWorld);
  const direction = new THREE.Vector3(0, 0, -1);
  const ray = new THREE.Raycaster(target.clone().addScaledVector(direction, -10), direction);
  ray.params.Points!.threshold = .15;
  const control: THREE.Intersection[] = [];
  THREE.Points.prototype.raycast.call(points, ray, control);
  assert.ok(control.length > 0, `${points.name}: control ray must hit actual geometry`);
  assert.deepEqual(ray.intersectObject(points, false), [], `${points.name} must not intercept picking`);
}

type Resource = THREE.BufferGeometry | THREE.Material;
function trackCloudResources(root: THREE.Object3D): Map<Resource, number> {
  const resources = new Map<Resource, number>();
  for (const points of pointClouds(root)) {
    for (const resource of [points.geometry, ...(Array.isArray(points.material) ? points.material : [points.material])]) {
      if (resources.has(resource)) continue;
      resources.set(resource, 0);
      resource.addEventListener("dispose", () => resources.set(resource, resources.get(resource)! + 1));
    }
  }
  return resources;
}

function assertReleased(resources: Map<Resource, number>): void {
  assert.ok(resources.size > 0, "must track actual point-cloud resources");
  for (const count of resources.values()) assert.equal(count, 1, "each point-cloud geometry and material must be disposed exactly once");
}

for (const speciesId of species) {
  for (const [role, makeRig] of [["Boss", createBoss], ["Raider", createRaider]] as const) {
    test(`${speciesId} ${role}: bounded deterministic clouds and non-pickability`, () => {
      const scene = new THREE.Group(), rigA = makeRig(), rigB = makeRig(); scene.add(rigA, rigB);
      const a = createMonsterSpeciesPresentation(rigA, speciesId), b = createMonsterSpeciesPresentation(rigB, speciesId);
      try {
        assert.equal(a.status, "active"); assert.equal(b.status, "active");
        const manifold = cloud(a.root, "monster-fx-manifold"), other = cloud(b.root, "monster-fx-manifold");
        assert.deepEqual(positions(manifold, 512, 1200), positions(other, 512, 1200));
        phase(manifold);
        const organisms = pointClouds(a.root).filter((node) => node.name === "monster-fx-organism");
        assert.equal(organisms.length, speciesId === "porous_shaper" ? 1 : 0);
        if (speciesId === "porous_shaper") {
          const organism = cloud(a.root, "monster-fx-organism"), otherOrganism = cloud(b.root, "monster-fx-organism");
          assert.deepEqual(positions(organism, 1000, 2520), positions(otherOrganism, 1000, 2520));
          const uv = organism.geometry.getAttribute("surfaceUv"), otherUv = otherOrganism.geometry.getAttribute("surfaceUv");
          assert.ok(uv && otherUv && uv.itemSize === 2 && uv.count === organism.geometry.getAttribute("position").count);
          assert.equal(otherUv.itemSize, 2); assert.equal(otherUv.count, uv.count);
          const coordinates: number[] = [], otherCoordinates: number[] = [];
          for (let i = 0; i < uv.count; i++) {
            const u = uv.getX(i), v = uv.getY(i);
            assert.ok(Number.isFinite(u) && Number.isFinite(v), `surfaceUv ${i} must be finite`);
            coordinates.push(u, v); otherCoordinates.push(otherUv.getX(i), otherUv.getY(i));
          }
          assert.deepEqual(coordinates, otherCoordinates);
          phase(organism);
        } else {
          assert.equal(pointClouds(b.root).filter((node) => node.name === "monster-fx-organism").length, 0);
        }
        assert.ok(pointClouds(a.root).some((node) => node.name === "monster-fx-particles"), "photon particles must also be checked");
        for (const points of pointClouds(a.root)) assertNonPickable(points);
      } finally { a.dispose(); b.dispose(); disposeMechaModel(rigA); disposeMechaModel(rigB); }
    });

    test(`${speciesId} ${role}: phase advances deterministically and freezes during reduced motion`, () => {
      const scene = new THREE.Group(), rigA = makeRig(), rigB = makeRig(); scene.add(rigA, rigB);
      const a = createMonsterSpeciesPresentation(rigA, speciesId), b = createMonsterSpeciesPresentation(rigB, speciesId);
      try {
        assert.equal(a.status, "active"); assert.equal(b.status, "active");
        const names = speciesId === "porous_shaper" ? ["monster-fx-manifold", "monster-fx-organism"] : ["monster-fx-manifold"];
        const aClouds = names.map((name) => cloud(a.root, name)), bClouds = names.map((name) => cloud(b.root, name));
        const initialVertices = aClouds.map((points) => positions(points, 1, 2520));
        assert.deepEqual(aClouds.map(phase), names.map(() => 0));
        b.update(.1, true);
        assert.deepEqual(bClouds.map(phase), names.map(() => 0), "reduced motion must freeze from the first frame");
        for (const dt of [.07, .03, .1, .04]) { a.update(dt); b.update(dt); }
        const beforePause = aClouds.map(phase);
        assert.deepEqual(beforePause, bClouds.map(phase), "identical time steps must give identical phases");
        for (const value of beforePause) assert.ok(value > 0, "phase must advance");
        assert.deepEqual(aClouds.map((points) => positions(points, 1, 2520)), initialVertices,
          "shader animation must not rewrite the sampled coordinates");
        for (const dt of [0, -1, NaN, Infinity, -Infinity]) {
          a.update(dt);
          assert.deepEqual(aClouds.map(phase), beforePause, `invalid or zero dt (${dt}) must freeze phase`);
        }
        for (let i = 0; i < 5; i++) {
          a.update(.1, true);
          assert.deepEqual(aClouds.map(phase), beforePause, "reduced motion must freeze an already animated phase");
        }
        a.update(.05); b.update(.05);
        assert.deepEqual(aClouds.map(phase), bClouds.map(phase), "paused time must not advance the clock");
        for (let i = 0; i < aClouds.length; i++) assert.ok(phase(aClouds[i]!) > beforePause[i]!, "phase must resume");
      } finally { a.dispose(); b.dispose(); disposeMechaModel(rigA); disposeMechaModel(rigB); }
    });

    test(`${speciesId} ${role}: point-cloud resources are released on disable and dispose`, () => {
      const scene = new THREE.Group(), rig = makeRig(); scene.add(rig);
      const visual = createMonsterSpeciesPresentation(rig, speciesId);
      try {
        assert.equal(visual.status, "active");
        cloud(visual.root, "monster-fx-manifold");
        if (speciesId === "porous_shaper") cloud(visual.root, "monster-fx-organism");
        const first = trackCloudResources(visual.root);
        visual.setEnabled(false);
        assert.equal(visual.status, "disabled"); assert.equal(visual.root.parent, null);
        assert.equal(pointClouds(visual.root).length, 0);
        assertReleased(first);
        visual.setEnabled(true);
        assert.equal(visual.status, "active");
        cloud(visual.root, "monster-fx-manifold");
        if (speciesId === "porous_shaper") cloud(visual.root, "monster-fx-organism");
        const second = trackCloudResources(visual.root);
        visual.dispose(); visual.dispose();
        assert.equal(visual.status, "disposed"); assert.equal(visual.root.parent, null);
        assert.equal(pointClouds(visual.root).length, 0);
        assertReleased(first); assertReleased(second);
      } finally { visual.dispose(); disposeMechaModel(rig); }
    });
  }
}
