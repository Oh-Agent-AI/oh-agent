import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { PLANNED_MONSTER_SPECIES_IDS } from "../src/game/mecha/monsters/contracts.ts";
import { createMonsterSpeciesPresentation } from "../src/game/mecha/presentation/monsters/MonsterSpeciesPresentation.ts";
import { createBoss, createRaider, disposeMechaModel } from "../src/render/mecha/models.ts";

type Renderable = THREE.Mesh | THREE.LineSegments | THREE.Points;
type PhotonFx = {
  core: THREE.Mesh;
  orbitals: THREE.LineSegments;
  particles: THREE.Points;
  rim: THREE.Object3D;
  light: THREE.Light;
  fieldMaterial: THREE.ShaderMaterial;
};

function one(root: THREE.Object3D, name: string): THREE.Object3D {
  const matches: THREE.Object3D[] = [];
  root.traverse((node) => { if (node.name === name) matches.push(node); });
  assert.equal(matches.length, 1, `${name} must exist exactly once`);
  return matches[0]!;
}

function materials(node: THREE.Object3D): THREE.Material[] {
  if (!(node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Points)) return [];
  return Array.isArray(node.material) ? node.material : [node.material];
}

function photonFx(root: THREE.Object3D): PhotonFx {
  const core = one(root, "monster-fx-core");
  const orbitals = one(root, "monster-fx-orbitals");
  const particles = one(root, "monster-fx-particles");
  const rim = one(root, "monster-fx-rim");
  const light = one(root, "monster-fx-light");
  assert.ok(core instanceof THREE.Mesh, "photon core must be a Mesh");
  assert.ok(orbitals instanceof THREE.LineSegments, "orbitals must be LineSegments");
  assert.ok(particles instanceof THREE.Points, "particles must be Points");
  assert.ok(light instanceof THREE.Light, "core illumination must be a Light");
  assert.ok(Number.isFinite(light.intensity) && light.intensity > 0, "core light must illuminate");
  // The field shader may be on the rim or on the glass shell.
  const shellMaterials: THREE.Material[] = [];
  root.traverse((node) => {
    if (node.name === "monster-fx-rim" || node.name === "monster-fx-glass") shellMaterials.push(...materials(node));
  });
  const fieldMaterial = shellMaterials.find((material): material is THREE.ShaderMaterial =>
    material instanceof THREE.ShaderMaterial && material.uniforms.fieldPulse !== undefined);
  assert.ok(fieldMaterial, "outer shell must expose a ShaderMaterial fieldPulse uniform");
  assert.ok(Number.isFinite(fieldMaterial.uniforms.fieldPulse!.value), "fieldPulse must be a finite number");
  return { core, orbitals, particles, rim, light, fieldMaterial };
}

/** Presentation-space coordinates, accounting for both vertex and ancestor motion. */
function vertices(root: THREE.Object3D, object: Renderable): number[][] {
  root.updateWorldMatrix(true, true);
  const attribute = object.geometry.getAttribute("position");
  assert.ok(attribute && attribute.itemSize >= 3, `${object.name} needs position vertices`);
  const transform = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(object.matrixWorld);
  const vector = new THREE.Vector3();
  return Array.from({ length: attribute.count }, (_, i) => {
    vector.fromBufferAttribute(attribute, i).applyMatrix4(transform);
    assert.ok(Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z));
    return vector.toArray();
  });
}

function snapshot(root: THREE.Object3D, fx: PhotonFx) {
  root.updateWorldMatrix(true, true);
  const relative = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(fx.core.matrixWorld).toArray();
  return {
    particles: vertices(root, fx.particles),
    orbitals: vertices(root, fx.orbitals),
    coreTransform: relative,
    coreScale: fx.core.scale.toArray(),
    coreColors: materials(fx.core).flatMap((material) => "color" in material && material.color instanceof THREE.Color ? material.color.toArray() : []),
    pulse: fx.fieldMaterial.uniforms.fieldPulse!.value as number,
    intensity: fx.light.intensity,
  };
}

function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

function meshControlRay(mesh: THREE.Mesh): THREE.Raycaster {
  mesh.updateWorldMatrix(true, false);
  const positions = mesh.geometry.getAttribute("position");
  assert.ok(positions && positions.count >= 3, `${mesh.name} needs triangle geometry`);
  const index = mesh.geometry.index;
  const count = index ? index.count : positions.count;
  for (let i = 0; i + 2 < count; i += 3) {
    const p = [0, 1, 2].map((offset) => new THREE.Vector3()
      .fromBufferAttribute(positions, index ? index.getX(i + offset) : i + offset).applyMatrix4(mesh.matrixWorld));
    const normal = new THREE.Vector3().crossVectors(p[1]!.clone().sub(p[0]!), p[2]!.clone().sub(p[0]!));
    if (normal.lengthSq() < 1e-12) continue;
    normal.normalize();
    const center = p[0]!.clone().add(p[1]!).add(p[2]!).multiplyScalar(1 / 3);
    for (const sign of [1, -1]) {
      const ray = new THREE.Raycaster(center.clone().addScaledVector(normal, 10 * sign), normal.clone().multiplyScalar(-sign));
      const hits: THREE.Intersection[] = [];
      THREE.Mesh.prototype.raycast.call(mesh, ray, hits);
      if (hits.length) return ray;
    }
  }
  assert.fail(`could not find a control ray hitting ${mesh.name}`);
}

function assertNonPickable(object: Renderable): void {
  object.updateWorldMatrix(true, false);
  let ray: THREE.Raycaster;
  const hits: THREE.Intersection[] = [];
  if (object instanceof THREE.Mesh) {
    ray = meshControlRay(object);
    THREE.Mesh.prototype.raycast.call(object, ray, hits);
  } else {
    const positions = object.geometry.getAttribute("position");
    assert.ok(positions && positions.count >= (object instanceof THREE.LineSegments ? 2 : 1));
    const index = object.geometry.index;
    const a = new THREE.Vector3().fromBufferAttribute(positions, index ? index.getX(0) : 0).applyMatrix4(object.matrixWorld);
    const b = object instanceof THREE.LineSegments
      ? new THREE.Vector3().fromBufferAttribute(positions, index ? index.getX(1) : 1).applyMatrix4(object.matrixWorld)
      : a.clone();
    const target = a.clone().add(b).multiplyScalar(0.5);
    const segment = b.clone().sub(a).normalize();
    let direction = new THREE.Vector3(0, 0, 1);
    if (Math.abs(segment.dot(direction)) > .9) direction = new THREE.Vector3(0, 1, 0);
    ray = new THREE.Raycaster(target.clone().addScaledVector(direction, 10), direction.clone().negate());
    ray.params.Points!.threshold = .15;
    ray.params.Line!.threshold = .15;
    if (object instanceof THREE.Points) THREE.Points.prototype.raycast.call(object, ray, hits);
    else THREE.LineSegments.prototype.raycast.call(object, ray, hits);
  }
  assert.ok(hits.length > 0, `${object.name}: control ray must intersect actual geometry`);
  assert.deepEqual(ray.intersectObject(object, false), [], `${object.name} must not intercept picking`);
}

type Resource = THREE.BufferGeometry | THREE.Material | THREE.Texture;
function effectResources(root: THREE.Object3D): Set<Resource> {
  const result = new Set<Resource>();
  const collectMaterial = (material: THREE.Material) => {
    result.add(material);
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) result.add(value);
    if (material instanceof THREE.ShaderMaterial) {
      for (const uniform of Object.values(material.uniforms)) {
        const values = Array.isArray(uniform.value) ? uniform.value : [uniform.value];
        for (const value of values) if (value instanceof THREE.Texture) result.add(value);
      }
    }
  };
  const collect = (node: THREE.Object3D) => {
    if (node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Points) {
      result.add(node.geometry);
      for (const material of materials(node)) collectMaterial(material);
    }
  };
  root.traverse((node) => { if (node.name.startsWith("monster-fx-")) node.traverse(collect); });
  return result;
}

for (const speciesId of PLANNED_MONSTER_SPECIES_IDS) {
  for (const [role, makeRig] of [["Boss", createBoss], ["Raider", createRaider]] as const) {
    test(`${speciesId} ${role}: three photon layers, independent orbitals and synchronous pulse`, () => {
      const scene = new THREE.Group(), rig = makeRig(); scene.add(rig);
      const visual = createMonsterSpeciesPresentation(rig, speciesId);
      try {
        assert.equal(visual.status, "active");
        const fx = photonFx(visual.root);
        const initial = snapshot(visual.root, fx);
        const count = role === "Boss" ? 36 : 18;
        assert.equal(initial.particles.length, count, `${role} needs ${count} individually moving particles`);
        assert.ok(initial.orbitals.length >= 2, "orbital layer must contain segments");
        visual.update(0);
        const samples = [snapshot(visual.root, fx)];
        for (let i = 0; i < 60; i++) { visual.update(.1); samples.push(snapshot(visual.root, fx)); }
        for (let i = 0; i < count; i++) {
          assert.ok(samples.some((sample) => distance(sample.particles[i]!, initial.particles[i]!) > 1e-5), `particle ${i} must move`);
        }
        // A single rigid point cloud keeps every pairwise distance fixed.
        let independentlyMoving = false;
        for (let i = 0; i < count && !independentlyMoving; i++) for (let j = i + 1; j < count && !independentlyMoving; j++) {
          const start = distance(initial.particles[i]!, initial.particles[j]!);
          independentlyMoving = samples.some((sample) => Math.abs(distance(sample.particles[i]!, sample.particles[j]!) - start) > 1e-4);
        }
        assert.ok(independentlyMoving, "particles must follow different orbits, not one rigid cloud");
        let changes = 0;
        for (let i = 1; i < samples.length; i++) {
          const deltaPulse = samples[i]!.pulse - samples[i - 1]!.pulse;
          const deltaLight = samples[i]!.intensity - samples[i - 1]!.intensity;
          const deltaCore = samples[i]!.coreScale[0]! - samples[i - 1]!.coreScale[0]!;
          if (Math.abs(deltaPulse) < 1e-7 && Math.abs(deltaLight) < 1e-7) continue;
          assert.ok(deltaPulse * deltaLight > 0, "shell field and core light must brighten/dim together");
          assert.ok(deltaPulse * deltaCore > 0, "core size and field must pulse together");
          const previous = samples[i - 1]!, current = samples[i]!;
          const scaleDelta = current.coreScale[0]! - previous.coreScale[0]!;
          const colorDelta = current.coreColors.reduce((sum, channel, j) => sum + channel - previous.coreColors[j]!, 0);
          assert.ok(deltaPulse * scaleDelta > 0 || deltaPulse * colorDelta > 0,
            "the visible core must pulse in step with the field through scale or color");
          changes++;
        }
        assert.ok(changes >= 2, "field pulse and core light must change over time");
      } finally { visual.dispose(); disposeMechaModel(rig); }
    });

    test(`${speciesId} ${role}: deterministic time, pause and reduced-motion freeze`, () => {
      const scene = new THREE.Group(), rigA = makeRig(), rigB = makeRig(); scene.add(rigA, rigB);
      const a = createMonsterSpeciesPresentation(rigA, speciesId), b = createMonsterSpeciesPresentation(rigB, speciesId);
      try {
        assert.equal(a.status, "active"); assert.equal(b.status, "active");
        const fxA = photonFx(a.root), fxB = photonFx(b.root);
        const initial = snapshot(a.root, fxA);
        assert.deepEqual(initial, snapshot(b.root, fxB), "initial state must be deterministic");
        a.update(0);
        assert.deepEqual(snapshot(a.root, fxA), initial, "zero dt must freeze even on the first update");
        b.update(.1, true);
        assert.deepEqual(snapshot(b.root, fxB), initial, "reduced motion must freeze from the first update");
        for (const dt of [.07, .03, .1, .04]) { a.update(dt); b.update(dt); }
        const beforePause = snapshot(a.root, fxA);
        assert.deepEqual(beforePause, snapshot(b.root, fxB), "equal time steps must produce equal state");
        for (const dt of [0, -1, NaN, Infinity, -Infinity]) {
          a.update(dt);
          assert.deepEqual(snapshot(a.root, fxA), beforePause, `invalid or zero dt (${dt}) must freeze state`);
        }
        for (let i = 0; i < 5; i++) {
          a.update(.1, true);
          assert.deepEqual(snapshot(a.root, fxA), beforePause, "reduced motion must freeze without a jump");
        }
        a.update(.05); b.update(.05);
        assert.deepEqual(snapshot(a.root, fxA), snapshot(b.root, fxB), "paused time must not advance the clock");
      } finally { a.dispose(); b.dispose(); disposeMechaModel(rigA); disposeMechaModel(rigB); }
    });

    test(`${speciesId} ${role}: effect picking and release on switch and disposal`, () => {
      const scene = new THREE.Group(), rig = makeRig(); scene.add(rig);
      const visual = createMonsterSpeciesPresentation(rig, speciesId);
      let nextVisual: ReturnType<typeof createMonsterSpeciesPresentation> | undefined;
      try {
        assert.equal(visual.status, "active");
        photonFx(visual.root);
        const effectRenderables = new Set<Renderable>();
        visual.root.traverse((effect) => {
          if (!effect.name.startsWith("monster-fx-")) return;
          effect.traverse((node) => {
            if (node instanceof THREE.Mesh || node instanceof THREE.LineSegments || node instanceof THREE.Points) effectRenderables.add(node);
          });
        });
        for (const node of effectRenderables) assertNonPickable(node);
        const track = (resources: Set<Resource>) => {
          const released = new Map<Resource, number>();
          for (const resource of resources) {
            released.set(resource, 0);
            resource.addEventListener("dispose", () => released.set(resource, released.get(resource)! + 1));
          }
          return released;
        };
        const firstRelease = track(effectResources(visual.root));
        assert.ok(firstRelease.size >= 4, "core, orbital, particle and shell resources must be accounted for");
        visual.setEnabled(false);
        assert.equal(visual.status, "disabled");
        for (const count of firstRelease.values()) assert.equal(count, 1, "each FX resource must be released exactly once on switch");
        assert.equal(visual.root.getObjectByName("monster-fx-core"), undefined);
        visual.setEnabled(true);
        assert.equal(visual.status, "active");
        photonFx(visual.root);
        const secondRelease = track(effectResources(visual.root));
        visual.dispose(); visual.dispose();
        for (const count of secondRelease.values()) assert.equal(count, 1, "each FX resource must be released exactly once on disposal");
        for (const count of firstRelease.values()) assert.equal(count, 1, "old resources must not be released again");
        assert.equal(visual.status, "disposed");
        assert.equal(visual.root.parent, null);
        // The world replaces the old presentation when it changes species.
        const index = PLANNED_MONSTER_SPECIES_IDS.indexOf(speciesId);
        const nextId = PLANNED_MONSTER_SPECIES_IDS[(index + 1) % PLANNED_MONSTER_SPECIES_IDS.length]!;
        nextVisual = createMonsterSpeciesPresentation(rig, nextId);
        assert.equal(nextVisual.status, "active");
        photonFx(nextVisual.root);
        const nextRelease = track(effectResources(nextVisual.root));
        nextVisual.dispose();
        for (const count of nextRelease.values()) assert.equal(count, 1, "the replacement species must release its resources");
        for (const count of firstRelease.values()) assert.equal(count, 1, "switching species must not release old resources twice");
      } finally { nextVisual?.dispose(); visual.dispose(); disposeMechaModel(rig); }
    });
  }
}
