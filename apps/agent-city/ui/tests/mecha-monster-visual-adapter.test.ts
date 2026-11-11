import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createMonsterVisual, wrapMonsterRig, type MonsterRigRole } from "../src/game/mecha/presentation/monsters/MonsterVisualAdapter.ts";
import { poseMechaModel, type MechaAction } from "../src/render/mecha/animation.ts";
import { createBoss, createRaider, disposeMechaModel, installMechaGlbProvider, upgradeMechaModelToGlb } from "../src/render/mecha/models.ts";
import type { MechaGlbAsset } from "../src/render/mecha/glbModels.ts";

function closeBox(actual: THREE.Box3, expected: THREE.Box3) {
  assert.ok(actual.min.distanceTo(expected.min) < 1e-6, `min ${actual.min.toArray()} != ${expected.min.toArray()}`);
  assert.ok(actual.max.distanceTo(expected.max) < 1e-6, `max ${actual.max.toArray()} != ${expected.max.toArray()}`);
}

function syntheticAsset(): MechaGlbAsset {
  const scene = new THREE.Group();
  const visual = new THREE.Group(); visual.name = "visual";
  visual.add(new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), new THREE.MeshBasicMaterial()));
  scene.add(visual);
  return {
    scene, rearExtent: 1,
    manifest: { id: "synthetic", version: 1, role: "Boss", footprint: [2, 2], forward: "-Z", heightMeters: 4,
      clips: { idle: { duration: 1, loop: true } } },
    clips: [new THREE.AnimationClip("idle", 1, [new THREE.VectorKeyframeTrack("visual.position", [0, 1], [0, 0, 0, 0, 2, 0])])],
  };
}

function assetMesh(asset: MechaGlbAsset): THREE.Mesh {
  return asset.scene.getObjectByName("visual")!.children[0] as THREE.Mesh;
}

test("wrapping preserves the original rig and matches existing sampled poses", () => {
  const actions: MechaAction[] = ["idle", "move", "attack", "repair", "hit", "defeat"];
  for (const [role, make, footprint] of [["Boss", createBoss, [2, 2]], ["Raider", createRaider, [1, 1]]] as const) {
    const rig = make();
    rig.position.set(2, 3, 4); rig.rotation.y = 0.25; rig.scale.setScalar(1.5);
    const original = make();
    original.position.copy(rig.position); original.rotation.copy(rig.rotation); original.scale.copy(rig.scale);
    const visual = wrapMonsterRig(rig);
    assert.equal(visual.rigRoot, rig);
    assert.equal(visual.pickRoot, rig);
    assert.equal(visual.role, role);
    assert.equal(visual.faction, "enemy");
    assert.deepEqual(visual.footprint, footprint);
    assert.equal(visual.quality, "rigged");
    assert.equal(visual.coreStatus, "inactive");
    assert.equal(visual.root.getObjectByName("monster-life-core"), undefined);
    assert.deepEqual(rig.position.toArray(), [2, 3, 4]);
    for (const reducedMotion of [false, true]) for (const action of actions) for (const timeSeconds of [0, 0.3, 0.85]) {
      visual.update({ action, timeSeconds, reducedMotion }, 1 / 60);
      poseMechaModel(original, action, timeSeconds, reducedMotion);
      closeBox(visual.getBounds(), new THREE.Box3().setFromObject(original));
      rig.traverse((node) => {
        if (!node.name.startsWith("joint:")) return;
        const expected = original.getObjectByName(node.name)!;
        assert.ok(node.position.distanceTo(expected.position) < 1e-6, node.name);
        assert.ok(node.quaternion.angleTo(expected.quaternion) < 1e-6, node.name);
      });
    }
    assert.deepEqual(rig.position.toArray(), [2, 3, 4]);
    visual.dispose(); disposeMechaModel(original);
  }
});

test("quality is explicitly opt-in; bounds, picking and placement exclude the core", () => {
  for (const role of ["Boss", "Raider"] as MonsterRigRole[]) {
    const visual = createMonsterVisual(role);
    const scene = new THREE.Group(); scene.position.set(13, 2, -7); scene.rotation.y = 0.4;
    scene.add(visual.root);
    visual.root.position.set(4, 1, 8); visual.root.scale.setScalar(2);
    const before = visual.getBounds();
    const reused = new THREE.Box3();
    assert.equal(visual.getBounds(reused), reused);
    const placement = visual.root.position.clone();
    visual.setQuality("core");
    assert.equal(visual.quality, "core"); assert.equal(visual.coreStatus, "active");
    const core = visual.root.getObjectByName("monster-life-core") as THREE.Mesh;
    assert.ok(core);
    const corePos = new THREE.Vector3(); core.getWorldPosition(corePos);
    const ray = new THREE.Raycaster(corePos.clone().add(new THREE.Vector3(0, 0, -10)), new THREE.Vector3(0, 0, 1));
    assert.equal(ray.intersectObject(core, true).length, 0);
    assert.equal(visual.pickRoot.getObjectByName("monster-life-core"), undefined);
    closeBox(visual.getBounds(), before);
    assert.ok(visual.root.position.equals(placement));
    visual.update({ action: "move", timeSeconds: 0.2, reducedMotion: true }, 0.1);
    assert.equal(core.scale.x, 1);
    visual.setQuality("rigged");
    assert.equal(visual.root.getObjectByName("monster-life-core"), undefined);
    assert.equal(visual.quality, "rigged"); assert.equal(visual.coreStatus, "inactive");
    visual.dispose();
  }
});

test("core follows model root transforms and reduced motion resets pulse", () => {
  const visual = createMonsterVisual("Boss");
  visual.setQuality("core");
  const core = visual.root.getObjectByName("monster-life-core")!;
  visual.rigRoot.position.set(2, 3, 4); visual.rigRoot.rotation.y = 1; visual.rigRoot.scale.setScalar(2);
  visual.update({ action: "idle", timeSeconds: 0 }, 0.1);
  const mount = visual.root.getObjectByName("monster-core-mount")!;
  assert.ok(mount.position.equals(visual.rigRoot.position));
  assert.ok(mount.quaternion.equals(visual.rigRoot.quaternion));
  assert.ok(mount.scale.equals(visual.rigRoot.scale));
  assert.notEqual(core.scale.x, 1);
  visual.update({ action: "idle", timeSeconds: 0, reducedMotion: true }, 0.1);
  assert.equal(core.scale.x, 1);
  visual.dispose();
});

test("factory and update failures explicitly fall back without disabling the rig", () => {
  let attempts = 0, releases = 0;
  const visual = createMonsterVisual("Raider", { coreFactory: () => {
    if (++attempts === 1) throw new Error("core unavailable");
    return { root: new THREE.Group(), update() { throw new Error("core failed"); }, dispose() { releases++; } };
  } });
  const before = visual.rigRoot;
  visual.setQuality("core");
  assert.equal(visual.quality, "rigged"); assert.equal(visual.coreStatus, "unavailable");
  visual.update({ action: "move", timeSeconds: 0.3 }, 0.1);
  visual.setQuality("core");
  assert.equal(visual.coreStatus, "active");
  visual.update({ action: "hit", timeSeconds: 0.2 }, 0.1);
  assert.equal(visual.coreStatus, "unavailable"); assert.equal(visual.quality, "rigged");
  assert.equal(releases, 1); assert.equal(visual.rigRoot, before);
  assert.notEqual(visual.rigRoot.getObjectByName("joint:body")!.rotation.x, 0);
  visual.dispose(); assert.equal(releases, 1);
});

test("core resources are released on downgrade and disposal exactly once", () => {
  const visual = createMonsterVisual("Boss");
  const scene = new THREE.Group(); scene.add(visual.root);
  visual.setQuality("core");
  const first = visual.root.getObjectByName("monster-life-core") as THREE.Mesh;
  let geometryDisposals = 0, materialDisposals = 0;
  first.geometry.addEventListener("dispose", () => geometryDisposals++);
  (first.material as THREE.Material).addEventListener("dispose", () => materialDisposals++);
  let rigDisposals = 0, rigGeometryDisposals = 0;
  let rigMesh: THREE.Mesh | undefined;
  visual.rigRoot.traverse((node) => { if (!rigMesh && node instanceof THREE.Mesh) rigMesh = node; });
  rigMesh!.geometry.addEventListener("dispose", () => rigGeometryDisposals++);
  const oldDispose = visual.rigRoot.userData.dispose as () => void;
  visual.rigRoot.userData.dispose = () => { rigDisposals++; oldDispose(); };
  visual.setQuality("rigged"); visual.setQuality("rigged");
  assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 1);
  visual.setQuality("core");
  const second = visual.root.getObjectByName("monster-life-core") as THREE.Mesh;
  second.geometry.addEventListener("dispose", () => geometryDisposals++);
  (second.material as THREE.Material).addEventListener("dispose", () => materialDisposals++);
  visual.dispose(); visual.dispose();
  assert.equal(geometryDisposals, 2); assert.equal(materialDisposals, 2); assert.equal(rigDisposals, 1); assert.equal(rigGeometryDisposals, 1);
  assert.equal(visual.rigRoot.userData.disposed, true); assert.equal(visual.root.parent, null);
  assert.throws(() => visual.getBounds(), /disposed/);
  assert.throws(() => visual.update({ action: "idle", timeSeconds: 0 }, 0), /disposed/);
  assert.throws(() => visual.setQuality("core"), /disposed/);
});

test("core cleanup failure still releases the rig and detaches the wrapper", () => {
  const visual = createMonsterVisual("Boss", { coreFactory: () => ({ root: new THREE.Group(), dispose() { throw new Error("cleanup"); } }) });
  const scene = new THREE.Group(); scene.add(visual.root);
  visual.setQuality("core");
  assert.throws(() => visual.dispose(), /cleanup/);
  assert.equal(visual.rigRoot.userData.disposed, true);
  assert.equal(visual.root.parent, null);
  visual.dispose();
});

test("in-place GLB upgrade keeps animation key and core; shared asset survives instance disposal", () => {
  const asset = syntheticAsset();
  const mesh = assetMesh(asset);
  let geometryDisposals = 0, materialDisposals = 0, coreDisposals = 0;
  mesh.geometry.addEventListener("dispose", () => geometryDisposals++);
  (mesh.material as THREE.Material).addEventListener("dispose", () => materialDisposals++);
  const visual = createMonsterVisual("Boss");
  visual.setQuality("core");
  const core = visual.root.getObjectByName("monster-life-core") as THREE.Mesh;
  core.geometry.addEventListener("dispose", () => coreDisposals++);
  const original = visual.rigRoot;
  assert.equal(upgradeMechaModelToGlb(original, asset), true);
  assert.equal(visual.rigRoot, original); assert.equal(visual.pickRoot, original);
  assert.equal(visual.root.getObjectByName("monster-life-core"), core);
  assert.equal(coreDisposals, 0);
  visual.update({ action: "idle", timeSeconds: 0.5 }, 0.1);
  assert.ok(original.userData.glb);
  assert.equal(original.getObjectByName("visual")!.position.y, 1);
  visual.dispose();
  assert.equal(coreDisposals, 1); assert.equal(geometryDisposals, 0); assert.equal(materialDisposals, 0);
  mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
});

test("late GLB load cannot upgrade a disposed wrapped rig", async () => {
  const asset = syntheticAsset();
  let resolve!: (asset: MechaGlbAsset) => void;
  const pending = new Promise<MechaGlbAsset>((done) => { resolve = done; });
  installMechaGlbProvider({ has: (role) => role === "Boss", peek: () => null, load: () => pending });
  try {
    const visual = createMonsterVisual("Boss");
    visual.dispose();
    resolve(asset); await pending; await Promise.resolve();
    assert.equal(visual.rigRoot.userData.glb, undefined);
    assert.equal(visual.rigRoot.userData.disposed, true);
  } finally {
    installMechaGlbProvider(null);
    const mesh = assetMesh(asset); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
  }
});

test("rejects unsupported or already parented rigs without taking ownership", () => {
  const rig = createBoss(); const parent = new THREE.Group(); parent.add(rig);
  assert.throws(() => wrapMonsterRig(rig), /unparented/);
  assert.equal(rig.parent, parent); assert.equal(rig.userData.disposed, undefined);
  const bad = new THREE.Group();
  assert.throws(() => wrapMonsterRig(bad), /Boss or Raider/);
  parent.remove(rig); disposeMechaModel(rig);
  assert.throws(() => wrapMonsterRig(rig), /disposed/);
});


test("custom core meshes cannot intercept recursive picking and bad factories degrade", () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial();
  let disposed = 0;
  const visual = createMonsterVisual("Raider", { coreFactory: () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material));
    return { root, dispose() { disposed++; geometry.dispose(); material.dispose(); } };
  } });
  visual.setQuality("core");
  visual.root.updateMatrixWorld(true);
  const mount = visual.root.getObjectByName("monster-core-mount")!;
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
  assert.equal(ray.intersectObject(mount, true).length, 0);
  visual.dispose(); assert.equal(disposed, 1);

  let invalidDisposed = 0;
  const parent = new THREE.Group();
  const invalid = new THREE.Group(); parent.add(invalid);
  const fallback = createMonsterVisual("Boss", { coreFactory: () => ({ root: invalid, dispose() { invalidDisposed++; } }) });
  fallback.setQuality("core");
  assert.equal(fallback.coreStatus, "unavailable"); assert.equal(fallback.quality, "rigged");
  assert.equal(invalidDisposed, 1); assert.equal(invalid.parent, parent);
  fallback.update({ action: "idle", timeSeconds: 0 }, 0);
  fallback.dispose();
});
