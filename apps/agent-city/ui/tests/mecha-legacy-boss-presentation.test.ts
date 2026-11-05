import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createMonsterSpeciesPresentation } from "../src/game/mecha/presentation/monsters/MonsterSpeciesPresentation.ts";
import { poseMechaModel } from "../src/render/mecha/animation.ts";
import { createBoss, createRaider, disposeMechaModel, installMechaGlbProvider, upgradeMechaModelToGlb } from "../src/render/mecha/models.ts";
import type { MechaGlbAsset } from "../src/render/mecha/glbModels.ts";

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const result: THREE.Mesh[] = []; root.traverse(node => { if (node instanceof THREE.Mesh) result.push(node); }); return result;
}
function asset(): MechaGlbAsset {
  const scene = new THREE.Group(), visual = new THREE.Group(); visual.name = "visual";
  visual.add(new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), new THREE.MeshBasicMaterial())); scene.add(visual);
  return { scene, rearExtent: 1, manifest: { id: "test", version: 1, role: "Boss", footprint: [2, 2], forward: "-Z", heightMeters: 4,
    clips: { idle: { duration: 1, loop: true }, defeat: { duration: 1, loop: false } } }, clips: [] };
}
function disposeAsset(value: MechaGlbAsset) {
  for (const mesh of meshes(value.scene)) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
}

test("legacy Boss geometry masks rig, remains pickable and follows placement and defeat", () => {
  for (const id of [undefined, "legacy_boss"] as const) {
    const scene = new THREE.Group(), rig = createBoss(); scene.add(rig);
    const originals = meshes(rig).map(mesh => [mesh, mesh.material] as const);
    rig.position.set(2, 3, 4); rig.rotation.y = 0.4; rig.scale.setScalar(2);
    const visual = createMonsterSpeciesPresentation(rig, id);
    assert.equal(visual.status, "legacy"); assert.equal(visual.pickRoot, visual.root);
    assert.equal(visual.root.parent, scene); assert.equal(visual.root.children[0]!.name, "legacy-boss-geometric-body");
    assert.ok(meshes(visual.root).length > 20);
    for (const [mesh, original] of originals) {
      assert.notEqual(mesh.material, original);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) assert.equal(material.visible, false);
    }
    visual.update(0); scene.updateMatrixWorld(true);
    assert.ok(visual.root.position.equals(rig.position)); assert.ok(visual.root.quaternion.equals(rig.quaternion)); assert.ok(visual.root.scale.equals(rig.scale));
    const center = new THREE.Box3().setFromObject(visual.root).getCenter(new THREE.Vector3());
    const ray = new THREE.Raycaster(center.clone().add(new THREE.Vector3(0, 0, 100)), new THREE.Vector3(0, 0, -1));
    assert.ok(ray.intersectObject(visual.pickRoot!, true).length > 0);
    poseMechaModel(rig, "defeat", 1); visual.update(0);
    const procedural = rig.userData.proceduralVisual as THREE.Object3D;
    assert.ok(visual.root.children[0]!.quaternion.angleTo(procedural.quaternion) < 1e-7);
    assert.ok(visual.root.children[0]!.position.distanceTo(procedural.position) < 1e-7);
    rig.visible = false; visual.update(0); assert.equal(visual.root.visible, false);
    rig.visible = true; poseMechaModel(rig, "idle", 0); visual.update(0);
    assert.ok(visual.root.children[0]!.quaternion.angleTo(new THREE.Quaternion()) < 1e-7);
    visual.setEnabled(false); assert.equal(visual.pickRoot, null);
    for (const [mesh, original] of originals) assert.equal(mesh.material, original);
    visual.setEnabled(true); assert.equal(visual.status, "legacy"); assert.equal(visual.pickRoot, visual.root);
    visual.dispose(); assert.equal(visual.status, "disposed"); assert.equal(rig.userData.disposed, undefined);
    for (const [mesh, original] of originals) assert.equal(mesh.material, original);
    disposeMechaModel(rig);
  }
});

test("legacy motion pauses, resets for reduced motion and releases each resource once", () => {
  const rig = createBoss(), scene = new THREE.Group(); scene.add(rig);
  const visual = createMonsterSpeciesPresentation(rig), frame = visual.root.getObjectByName("legacy-geometry-edge")!.parent!;
  const initial = frame.quaternion.clone(); visual.update(0.1); const moving = frame.quaternion.clone();
  assert.ok(moving.angleTo(initial) > 0.001); visual.update(0); assert.ok(frame.quaternion.angleTo(moving) < 1e-7);
  visual.update(NaN); assert.ok(frame.quaternion.angleTo(moving) < 1e-7);
  visual.update(1, true); assert.ok(frame.quaternion.angleTo(initial) < 1e-7);
  const resources = new Set<THREE.BufferGeometry | THREE.Material>();
  for (const mesh of meshes(visual.root)) { resources.add(mesh.geometry); for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) resources.add(material); }
  const counts = new Map<object, number>();
  for (const resource of resources) resource.addEventListener("dispose", () => counts.set(resource, (counts.get(resource) ?? 0) + 1));
  visual.dispose(); visual.dispose(); for (const resource of resources) assert.equal(counts.get(resource), 1);
  assert.equal(visual.root.parent, null); disposeMechaModel(rig);
});

test("unknown IDs and other roles never become a legacy or new species", () => {
  for (const id of ["unknown", "", "constructor", "__proto__"]) {
    const rig = createBoss(); let called = false;
    const visual = createMonsterSpeciesPresentation(rig, id, { legacyFactory: () => { called = true; throw new Error(); }, ornamentFactory: () => { called = true; throw new Error(); } });
    assert.equal(visual.status, "unavailable"); assert.equal(visual.pickRoot, null); assert.equal(called, false);
    visual.dispose(); disposeMechaModel(rig);
  }
  for (const id of [undefined, "legacy_boss"] as const) {
    const rig = createRaider(), visual = createMonsterSpeciesPresentation(rig, id);
    assert.equal(visual.status, "legacy"); assert.equal(visual.pickRoot, null); visual.dispose(); disposeMechaModel(rig);
  }
  const visual = createMonsterSpeciesPresentation(new THREE.Group()); assert.equal(visual.status, "unavailable"); visual.dispose();
});

test("legacy creation and animation failure restore rig and allow retry", () => {
  const rig = createBoss(), scene = new THREE.Group(); scene.add(rig);
  const original = meshes(rig)[0]!.material; let attempt = 0, released = 0;
  const visual = createMonsterSpeciesPresentation(rig, undefined, { legacyFactory: () => {
    if (++attempt === 1) throw new Error("construction failed");
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    return { root: mesh, update() { throw new Error("frame failed"); }, dispose() { released++; mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); } };
  } });
  assert.equal(visual.status, "unavailable"); assert.equal(meshes(rig)[0]!.material, original);
  visual.setEnabled(true); assert.equal(visual.status, "legacy"); visual.update(0);
  assert.equal(visual.status, "unavailable"); assert.equal(released, 1); assert.equal(meshes(rig)[0]!.material, original);
  visual.setEnabled(true); assert.equal(visual.status, "legacy"); visual.dispose(); assert.equal(released, 2); disposeMechaModel(rig);
});

test("legacy masks synchronous and asynchronous GLB upgrades and ignores a load after disposal", async () => {
  const glb = asset(), shared = meshes(glb.scene)[0]!, original = shared.material;
  const scene = new THREE.Group(), rig = createBoss(); scene.add(rig);
  const visual = createMonsterSpeciesPresentation(rig, "legacy_boss"), body = visual.root.children[0]!;
  assert.equal(upgradeMechaModelToGlb(rig, glb), true);
  const upgraded = meshes(rig)[0]!; assert.equal((upgraded.material as THREE.Material).visible, false);
  assert.equal((original as THREE.Material).visible, true);
  const glbPose = rig.getObjectByName("visual")!; glbPose.rotation.x = 0.7;
  visual.update(0); assert.equal(visual.root.children[0], body);
  assert.ok(body.quaternion.angleTo(glbPose.quaternion) < 1e-7); assert.deepEqual(body.scale.toArray(), [1, 1, 1]);
  visual.dispose(); assert.equal(upgraded.material, original); disposeMechaModel(rig); disposeAsset(glb);
  const late = asset(); let resolve!: (value: MechaGlbAsset) => void;
  const pending = new Promise<MechaGlbAsset>(done => { resolve = done; });
  installMechaGlbProvider({ has: role => role === "Boss", peek: () => null, load: () => pending });
  try {
    const live = createBoss(), gone = createBoss(), parent = new THREE.Group(); parent.add(live, gone);
    const liveVisual = createMonsterSpeciesPresentation(live), goneVisual = createMonsterSpeciesPresentation(gone);
    disposeMechaModel(gone); goneVisual.update(0); assert.equal(goneVisual.status, "disposed");
    resolve(late); await pending; await Promise.resolve();
    assert.equal((meshes(live)[0]!.material as THREE.Material).visible, false);
    assert.equal(gone.userData.glb, undefined); assert.equal(goneVisual.root.parent, null);
    liveVisual.update(0); assert.equal(liveVisual.status, "legacy");
    liveVisual.dispose(); goneVisual.dispose(); disposeMechaModel(live);
  } finally { installMechaGlbProvider(null); disposeAsset(late); }
});
