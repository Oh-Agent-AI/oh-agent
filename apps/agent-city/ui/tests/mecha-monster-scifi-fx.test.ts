import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { PLANNED_MONSTER_SPECIES_IDS } from "../src/game/mecha/monsters/contracts.ts";
import { createMonsterSpeciesPresentation } from "../src/game/mecha/presentation/monsters/MonsterSpeciesPresentation.ts";
import { createBoss, createRaider, disposeMechaModel } from "../src/render/mecha/models.ts";

type Fx = { particles: THREE.Points; glass: THREE.Mesh; light: THREE.PointLight };

function requireFx(root: THREE.Object3D): Fx {
  const found: Record<string, THREE.Object3D[]> = {
    "monster-fx-particles": [], "monster-fx-glass": [], "monster-fx-light": [],
  };
  root.traverse((node) => { if (found[node.name]) found[node.name]!.push(node); });
  for (const [name, nodes] of Object.entries(found)) assert.equal(nodes.length, 1, `${name} must occur exactly once`);
  const [particles] = found["monster-fx-particles"]!;
  const [glass] = found["monster-fx-glass"]!;
  const [light] = found["monster-fx-light"]!;
  assert.ok(particles instanceof THREE.Points, "particles must be THREE.Points");
  assert.ok(glass instanceof THREE.Mesh, "glass must be a THREE.Mesh");
  assert.ok(light instanceof THREE.PointLight, "light must be a THREE.PointLight");
  return { particles, glass, light };
}

/** Snapshot particle vertices in the visual root's coordinates, including ancestor animation. */
function particlePositions(root: THREE.Object3D, points: THREE.Points): number[] {
  root.updateWorldMatrix(true, true);
  const position = points.geometry.getAttribute("position");
  assert.ok(position && position.itemSize >= 3 && position.count > 0, "particles need position vertices");
  const relative = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(points.matrixWorld);
  const p = new THREE.Vector3();
  const result: number[] = [];
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i).applyMatrix4(relative);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), "particle coordinates must be finite");
    result.push(p.x, p.y, p.z);
  }
  return result;
}

function samePositions(actual: number[], expected: number[], message: string): void {
  assert.ok(actual.length === expected.length && actual.every((value, i) => value === expected[i]), message);
}

function materials(object: THREE.Mesh | THREE.Points): THREE.Material[] {
  return Array.isArray(object.material) ? object.material : [object.material];
}

/** Aim a ray at an actual face, so a no-hit result cannot pass merely by missing the glass. */
function rayThroughGlass(mesh: THREE.Mesh): THREE.Raycaster {
  mesh.updateWorldMatrix(true, false);
  const pos = mesh.geometry.getAttribute("position");
  assert.ok(pos && pos.count >= 3, "glass needs triangles");
  const index = mesh.geometry.getIndex();
  const count = index ? index.count : pos.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i + 2 < count; i += 3) {
    a.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, index ? index.getX(i + 1) : i + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, index ? index.getX(i + 2) : i + 2).applyMatrix4(mesh.matrixWorld);
    const normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
    if (normal.lengthSq() < 1e-12) continue;
    normal.normalize();
    const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    const ray = new THREE.Raycaster(center.clone().addScaledVector(normal, 10), normal.clone().negate());
    const control: THREE.Intersection[] = [];
    THREE.Mesh.prototype.raycast.call(mesh, ray, control);
    if (control.length) return ray;
  }
  assert.fail("could not construct a control ray hitting the glass geometry");
}

function assertNoFxPicking(fx: Fx): void {
  const glassRay = rayThroughGlass(fx.glass);
  assert.deepEqual(glassRay.intersectObject(fx.glass, false), [], "glass must not intercept picking");

  fx.particles.updateWorldMatrix(true, false);
  const positions = fx.particles.geometry.getAttribute("position");
  const target = new THREE.Vector3().fromBufferAttribute(positions, 0).applyMatrix4(fx.particles.matrixWorld);
  const ray = new THREE.Raycaster(target.clone().add(new THREE.Vector3(0, 0, 10)), new THREE.Vector3(0, 0, -1));
  ray.params.Points!.threshold = 0.1;
  const control: THREE.Intersection[] = [];
  THREE.Points.prototype.raycast.call(fx.particles, ray, control);
  assert.ok(control.length > 0, "control ray must hit at least one particle");
  assert.deepEqual(ray.intersectObject(fx.particles, false), [], "particles must not intercept picking");
}

for (const speciesId of PLANNED_MONSTER_SPECIES_IDS) {
  for (const [role, makeRig] of [["Boss", createBoss], ["Raider", createRaider]] as const) {
    test(`${speciesId} ${role}: deterministic science-fiction effects, motion and non-picking`, () => {
      const rigA = makeRig(), rigB = makeRig();
      const a = createMonsterSpeciesPresentation(rigA, speciesId);
      const b = createMonsterSpeciesPresentation(rigB, speciesId);
      try {
        assert.equal(a.status, "active"); assert.equal(b.status, "active");
        const fx = requireFx(a.root), otherFx = requireFx(b.root);
        assert.ok(materials(fx.glass).some((m) => m.transparent && m.opacity > 0 && m.opacity < 1), "glass must be visibly translucent");
        assert.equal(fx.light.castShadow, false, "effect light must not cast shadows");
        assert.ok(fx.light.intensity > 0, "effect light should illuminate");
        const initial = particlePositions(a.root, fx.particles);
        samePositions(initial, particlePositions(b.root, otherFx.particles), "initial positions must be deterministic");
        assertNoFxPicking(fx);
        b.update(0.05, true);
        samePositions(particlePositions(b.root, otherFx.particles), initial, "reduced motion must also stay still from the first frame");

        a.update(0.05); b.update(0.05);
        const animated = particlePositions(a.root, fx.particles);
        assert.ok(animated.some((value, i) => value !== initial[i]), "positive elapsed time must move particles");
        samePositions(animated, particlePositions(b.root, otherFx.particles), "equal elapsed time must be deterministic");

        for (const dt of [0, -1, NaN, Infinity, -Infinity]) {
          a.update(dt);
          samePositions(particlePositions(a.root, fx.particles), animated, `paused/invalid dt ${dt} must not move particles`);
        }
        a.update(0.05, true);
        samePositions(particlePositions(a.root, fx.particles), animated, "reduced motion must freeze particle positions without a jump");
        a.update(0.05); b.update(0.05);
        samePositions(particlePositions(a.root, fx.particles), particlePositions(b.root, otherFx.particles), "paused time must not advance the particle clock");
      } finally {
        a.dispose(); b.dispose(); disposeMechaModel(rigA); disposeMechaModel(rigB);
      }
    });

    test(`${speciesId} ${role}: FX geometry and materials are released once`, () => {
      const rig = makeRig();
      const presentation = createMonsterSpeciesPresentation(rig, speciesId);
      try {
        assert.equal(presentation.status, "active");
        const fx = requireFx(presentation.root);
        const resources = new Set<THREE.BufferGeometry | THREE.Material>([
          fx.particles.geometry, fx.glass.geometry, ...materials(fx.particles), ...materials(fx.glass),
        ]);
        const releases = new Map<THREE.BufferGeometry | THREE.Material, number>();
        for (const resource of resources) {
          releases.set(resource, 0);
          resource.addEventListener("dispose", () => releases.set(resource, releases.get(resource)! + 1));
        }
        presentation.dispose();
        presentation.dispose();
        for (const count of releases.values()) assert.equal(count, 1, "every FX resource must be disposed exactly once");
        assert.equal(presentation.status, "disposed");
      } finally {
        presentation.dispose(); disposeMechaModel(rig);
      }
    });
  }
}
