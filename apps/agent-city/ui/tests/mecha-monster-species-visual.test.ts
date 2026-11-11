import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { PLANNED_MONSTER_SPECIES_IDS } from "../src/game/mecha/monsters/contracts.ts";
import { createMonsterSpeciesCoreFactory, createMonsterSpeciesPresentation } from "../src/game/mecha/presentation/monsters/MonsterSpeciesPresentation.ts";
import { createMonsterVisual } from "../src/game/mecha/presentation/monsters/MonsterVisualAdapter.ts";
import { poseMechaModel } from "../src/render/mecha/animation.ts";
import { createBoss, createRaider, disposeMechaModel, installMechaGlbProvider, upgradeMechaModelToGlb } from "../src/render/mecha/models.ts";
import type { MechaGlbAsset } from "../src/render/mecha/glbModels.ts";

function meshSignature(root: THREE.Object3D) {
  const result: unknown[] = [];
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const material = node.material as THREE.MeshBasicMaterial | THREE.ShaderMaterial;
    const color = material instanceof THREE.ShaderMaterial ? material.uniforms.tint?.value : material.color;
    assert.ok(color instanceof THREE.Color, `mesh ${node.name} has a color`);
    result.push([node.name, node.geometry.type, color.getHex(),
      node.position.toArray(), node.scale.toArray(), node.rotation.toArray().slice(0, 3)]);
  });
  return result;
}
function resources(root: THREE.Object3D) {
  const geometry = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) && !(node instanceof THREE.Points) && !(node instanceof THREE.LineSegments)) return;
    geometry.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material);
  });
  return { geometry, materials };
}
function watchDispose(items: Iterable<THREE.EventDispatcher<{ dispose: {} }>>) {
  let count = 0;
  for (const item of items) item.addEventListener("dispose", () => count++);
  return () => count;
}
function boxEquals(a: THREE.Box3, b: THREE.Box3) {
  assert.ok(a.min.distanceTo(b.min) < 1e-7);
  assert.ok(a.max.distanceTo(b.max) < 1e-7);
}
function asset(): MechaGlbAsset {
  const scene = new THREE.Group();
  const visual = new THREE.Group(); visual.name = "visual";
  visual.add(new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), new THREE.MeshBasicMaterial()));
  scene.add(visual);
  return { scene, rearExtent: 1, manifest: { id: "test", version: 1, role: "Boss", footprint: [2, 2], forward: "-Z", heightMeters: 4,
    clips: { idle: { duration: 1, loop: true } } }, clips: [] };
}
function disposeAsset(value: MechaGlbAsset) {
  value.scene.traverse((node) => {
    if (node instanceof THREE.Mesh) { node.geometry.dispose(); (node.material as THREE.Material).dispose(); }
  });
}

test("ten species have deterministic, unique palettes and silhouettes on both rig roles", () => {
  const silhouettes = new Set<string>(), colors = new Set<number>();
  for (const id of PLANNED_MONSTER_SPECIES_IDS) {
    for (const make of [createBoss, createRaider]) {
      const a = make(), b = make();
      const av = createMonsterSpeciesPresentation(a, id), bv = createMonsterSpeciesPresentation(b, id);
      assert.equal(av.status, "active"); assert.equal(bv.status, "active");
      const first = meshSignature(av.root);
      assert.deepEqual(first, meshSignature(bv.root));
      assert.ok(first.length >= 3 && first.length <= 60);
      if (make === createBoss) {
        silhouettes.add(JSON.stringify(first.map((row) => { const v = row as unknown[]; return [v[0], v[3], v[4], v[5]]; })));
        colors.add((first[0] as unknown[])[2] as number);
      }
      for (const dt of [0.016, 0.033, 1, NaN, -1, 0.016]) { av.update(dt); bv.update(dt); }
      assert.deepEqual(av.root.children[0]!.scale.toArray(), bv.root.children[0]!.scale.toArray());
      av.update(0.1, true);
      assert.equal(av.root.children[0]!.scale.x, make === createBoss ? 1 : 0.5);
      av.dispose(); bv.dispose(); disposeMechaModel(a); disposeMechaModel(b);
    }
  }
  assert.equal(silhouettes.size, 10); assert.equal(colors.size, 10);
});

test("City-style bridge follows rig and changes neither pose, bounds, picking nor rig ownership", () => {
  for (const make of [createBoss, createRaider]) {
    const parent = new THREE.Group(); parent.position.set(9, 2, -7); parent.rotation.y = 0.3;
    const rig = make(), reference = make(); parent.add(rig, reference);
    rig.position.set(1, 2, 3); rig.rotation.y = 0.8; rig.scale.setScalar(1.3);
    reference.position.copy(rig.position); reference.rotation.copy(rig.rotation); reference.scale.copy(rig.scale);
    const bridge = createMonsterSpeciesPresentation(rig, "prism_warden");
    assert.equal(bridge.root.parent, parent); assert.equal(rig.parent, parent);
    assert.equal(rig.getObjectByName("monster-species-prism_warden"), undefined);
    for (const action of ["idle", "move", "attack", "hit", "defeat"] as const) {
      poseMechaModel(rig, action, 0.42, false); poseMechaModel(reference, action, 0.42, false);
      bridge.update(0.016);
      parent.updateMatrixWorld(true);
      boxEquals(new THREE.Box3().setFromObject(rig), new THREE.Box3().setFromObject(reference));
      assert.ok(bridge.root.position.equals(rig.position));
      assert.ok(bridge.root.quaternion.equals(rig.quaternion));
      assert.ok(bridge.root.scale.equals(rig.scale));
    }
    assert.equal(bridge.pickRoot, bridge.root);
    rig.visible = false; bridge.update(0); assert.equal(bridge.root.visible, false);
    const next = new THREE.Group(); next.add(rig); rig.visible = true; bridge.update(0);
    assert.equal(bridge.root.parent, next); assert.equal(bridge.root.visible, true);
    next.remove(rig); bridge.update(0); assert.equal(bridge.root.parent, null);
    parent.add(rig); bridge.update(0); assert.equal(bridge.root.parent, parent);
    bridge.dispose(); assert.equal(rig.parent, parent); assert.notEqual(rig.userData.disposed, true);
    disposeMechaModel(rig); disposeMechaModel(reference);
  }
});

test("invalid IDs never decorate the default rig, even after toggles", () => {
  for (const id of ["unknown", "__proto__", "constructor", ""] as const) {
    const rig = createBoss(); const scene = new THREE.Group(); scene.add(rig);
    const before = new THREE.Box3().setFromObject(rig);
    const bridge = createMonsterSpeciesPresentation(rig, id);
    assert.equal(bridge.status, "unavailable");
    assert.equal(bridge.root.parent, null); assert.equal(bridge.root.children.length, 0); assert.equal(bridge.pickRoot, null);
    bridge.update(10); bridge.setEnabled(false); bridge.setEnabled(true);
    assert.equal(bridge.root.parent, null); boxEquals(new THREE.Box3().setFromObject(rig), before);
    bridge.dispose(); disposeMechaModel(rig);
  }
  const unsupported = new THREE.Group();
  const bridge = createMonsterSpeciesPresentation(unsupported, "spore_leaper");
  assert.equal(bridge.status, "unavailable"); bridge.dispose();
});

test("toggle and teardown dispose each owned shared resource exactly once, without disposing rig", () => {
  const rig = createBoss(); const scene = new THREE.Group(); scene.add(rig);
  const bridge = createMonsterSpeciesPresentation(rig, "swarm_mantle");
  const first = resources(bridge.root); const g = watchDispose(first.geometry), m = watchDispose(first.materials);
  assert.ok(first.geometry.size >= 1); assert.ok(first.materials.size >= 1);
  bridge.setEnabled(false); bridge.setEnabled(false);
  assert.equal(bridge.status, "disabled"); assert.equal(bridge.root.parent, null);
  assert.equal(g(), first.geometry.size); assert.equal(m(), first.materials.size);
  bridge.setEnabled(true); assert.equal(bridge.status, "active");
  const second = resources(bridge.root); const g2 = watchDispose(second.geometry), m2 = watchDispose(second.materials);
  bridge.dispose(); bridge.dispose();
  assert.equal(g2(), second.geometry.size); assert.equal(m2(), second.materials.size);
  assert.equal(rig.userData.disposed, undefined); assert.equal(bridge.status, "disposed");
  assert.throws(() => bridge.update(0), /disposed/); assert.throws(() => bridge.setEnabled(true), /disposed/);
  disposeMechaModel(rig);
});

test("factory and update failures degrade explicitly and can be retried", () => {
  const rig = createBoss(); const scene = new THREE.Group(); scene.add(rig);
  let attempts = 0, releases = 0;
  const bridge = createMonsterSpeciesPresentation(rig, "gravity_core", { ornamentFactory: () => {
    attempts++;
    if (attempts === 1) throw new Error("construction failed");
    const root = new THREE.Group(); const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); root.add(mesh);
    return { root, update() { throw new Error("update failed"); }, dispose() { releases++; mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); } };
  } });
  assert.equal(bridge.status, "unavailable"); assert.equal(bridge.root.parent, null);
  bridge.setEnabled(true); assert.equal(bridge.status, "active");
  bridge.update(0); assert.equal(bridge.status, "unavailable"); assert.equal(releases, 1);
  assert.equal(rig.parent, scene); assert.equal(rig.userData.disposed, undefined);
  bridge.setEnabled(true); assert.equal(bridge.status, "active"); bridge.dispose(); assert.equal(releases, 2);
  disposeMechaModel(rig);

  const otherRig = createRaider(), owner = new THREE.Group(), foreign = new THREE.Group(); owner.add(foreign);
  let disposed = 0;
  const bad = createMonsterSpeciesPresentation(otherRig, "spore_leaper", { ornamentFactory: () => ({ root: foreign, dispose() { disposed++; } }) });
  assert.equal(bad.status, "unavailable"); assert.equal(disposed, 1); assert.equal(foreign.parent, owner);
  bad.dispose(); disposeMechaModel(otherRig);
});

test("existing adapter's optional core path keeps picking, bounds and lifecycle intact", () => {
  const visual = createMonsterVisual("Boss", { coreFactory: createMonsterSpeciesCoreFactory("flux_lancer") });
  const before = visual.getBounds();
  visual.setQuality("core"); assert.equal(visual.coreStatus, "active");
  assert.ok(visual.root.getObjectByName("monster-species-flux_lancer"));
  assert.equal(visual.pickRoot.getObjectByName("monster-species-flux_lancer"), undefined);
  visual.update({ action: "idle", timeSeconds: 0, reducedMotion: true }, 0.1);
  boxEquals(visual.getBounds(), before);
  visual.setQuality("rigged"); assert.equal(visual.root.getObjectByName("monster-species-flux_lancer"), undefined);
  visual.dispose();
  const invalid = createMonsterVisual("Boss", { coreFactory: createMonsterSpeciesCoreFactory("legacy_boss") });
  invalid.setQuality("core"); assert.equal(invalid.coreStatus, "unavailable"); invalid.dispose();
});

test("GLB upgrade and a late GLB load keep or clean up the sibling without disposing shared GLB resources", async () => {
  const glb = asset();
  const rig = createBoss(); const scene = new THREE.Group(); scene.add(rig);
  const bridge = createMonsterSpeciesPresentation(rig, "many_core");
  const identity = bridge.root.children[0];
  const shared = resources(glb.scene); const g = watchDispose(shared.geometry), m = watchDispose(shared.materials);
  assert.equal(upgradeMechaModelToGlb(rig, glb), true);
  // Root childadded must mask a synchronous GLB replacement before any frame.
  const glbMesh = rig.getObjectByProperty("isMesh", true) as THREE.Mesh;
  assert.ok(glbMesh); assert.equal((glbMesh.material as THREE.Material).visible, false);
  assert.ok([...shared.materials].every(material => material.visible));
  bridge.update(0.1); assert.equal(bridge.root.children[0], identity); assert.equal(bridge.root.parent, scene);
  bridge.dispose(); assert.ok(shared.materials.has(glbMesh.material as THREE.Material));
  disposeMechaModel(rig); assert.equal(g(), 0); assert.equal(m(), 0);
  disposeAsset(glb);

  const late = asset(); let resolve!: (a: MechaGlbAsset) => void;
  const pending = new Promise<MechaGlbAsset>((done) => { resolve = done; });
  installMechaGlbProvider({ has: (role) => role === "Boss", peek: () => null, load: () => pending });
  try {
    const other = createBoss(); const anotherScene = new THREE.Group(); anotherScene.add(other);
    const b = createMonsterSpeciesPresentation(other, "spore_leaper");
    const owned = resources(b.root); const disposedGeometry = watchDispose(owned.geometry);
    disposeMechaModel(other); b.update(0); assert.equal(b.status, "disposed");
    resolve(late); await pending; await Promise.resolve();
    assert.equal(other.userData.glb, undefined); assert.equal(disposedGeometry(), owned.geometry.size);
    assert.equal(b.root.parent, null); b.dispose();
  } finally { installMechaGlbProvider(null); disposeAsset(late); }
});

test("broken optional cleanup cannot prevent detaching or affect rig teardown", () => {
  const rig = createBoss(); const scene = new THREE.Group(); scene.add(rig);
  let disposed = 0;
  const bridge = createMonsterSpeciesPresentation(rig, "many_core", { ornamentFactory: () => ({
    root: new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()), dispose() { disposed++; this.root.geometry.dispose(); (this.root.material as THREE.Material).dispose(); throw new Error("cleanup failed"); },
  }) });
  bridge.setEnabled(false); assert.equal(bridge.status, "disabled"); assert.equal(bridge.root.parent, null);
  bridge.setEnabled(true); assert.equal(bridge.status, "active");
  bridge.dispose(); assert.equal(bridge.status, "disposed"); assert.equal(disposed, 2);
  assert.equal(bridge.root.parent, null); assert.equal(rig.parent, scene); assert.equal(rig.userData.disposed, undefined);
  disposeMechaModel(rig);
});


test("masked rig stays visible and raycastable without mutating shared materials, then restores them", () => {
  const rig = createBoss(), scene = new THREE.Group(); scene.add(rig);
  const first = rig.getObjectByProperty("isMesh", true) as THREE.Mesh;
  const original = first.material as THREE.Material;
  const observer = new THREE.Mesh(first.geometry, original); scene.add(observer);
  const nodes: THREE.Mesh[] = []; rig.traverse(n => { if (n instanceof THREE.Mesh) nodes.push(n); });
  const snapshots = nodes.map(n => ({ n, material: n.material, visible: n.visible }));
  scene.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(first).getCenter(new THREE.Vector3());
  const ray = new THREE.Raycaster(center.clone().add(new THREE.Vector3(0, 0, 100)), new THREE.Vector3(0, 0, -1));
  const before = ray.intersectObject(rig, true).map(h => [h.object.uuid, h.distance]);
  assert.ok(before.length > 0);
  const bridge = createMonsterSpeciesPresentation(rig, "field_sovereign"); scene.updateMatrixWorld(true);
  assert.equal(rig.visible, true);
  for (const { n, material, visible } of snapshots) {
    assert.equal(n.visible, visible); assert.notEqual(n.material, material);
    for (const m of Array.isArray(n.material) ? n.material : [n.material]) assert.equal(m.visible, false);
  }
  assert.equal(observer.material, original); assert.equal(original.visible, true);
  assert.deepEqual(ray.intersectObject(rig, true).map(h => [h.object.uuid, h.distance]), before);
  assert.equal(bridge.pickRoot, bridge.root);
  bridge.setEnabled(false);
  assert.equal(bridge.pickRoot, null);
  for (const {n, material} of snapshots) assert.equal(n.material, material);
  assert.deepEqual(ray.intersectObject(rig, true).map(h => [h.object.uuid, h.distance]), before);
  bridge.dispose(); disposeMechaModel(rig);
});

test("mask preserves material arrays and cleanup survives material dispose throwing", () => {
  const rig = createBoss(), mesh = rig.getObjectByProperty("isMesh", true) as THREE.Mesh;
  const original = mesh.material as THREE.Material;
  const materials = [original, original]; mesh.material = materials;
  const bridge = createMonsterSpeciesPresentation(rig, "spore_leaper");
  const replacement = mesh.material as THREE.Material[];
  assert.ok(Array.isArray(replacement)); assert.equal(replacement[0]!.side, original.side);
  replacement[0]!.addEventListener("dispose", () => { throw new Error("listener failure"); });
  bridge.setEnabled(false);
  assert.equal(mesh.material, materials); assert.equal(bridge.root.parent, null);
  assert.equal(bridge.status, "disabled"); bridge.dispose(); mesh.material = original; disposeMechaModel(rig);
});


test("each species exposes visible geometry raycasts including silhouette beyond old rig", () => {
  for (const id of PLANNED_MONSTER_SPECIES_IDS) {
    const scene = new THREE.Group(), rig = createBoss(); scene.add(rig);
    const visual = createMonsterSpeciesPresentation(rig, id); visual.update(0, true);
    scene.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(), dir = new THREE.Vector3(0, 0, -1);
    let hits = 0, outer = 0;
    for (let x = -5; x <= 5; x += .25) for (let y = 0; y <= 10; y += .25) {
      ray.set(new THREE.Vector3(x, y, 30), dir);
      if (!ray.intersectObject(visual.pickRoot!, true).length) continue;
      hits++;
      if (!ray.intersectObject(rig, true).length) outer++;
    }
    assert.ok(hits > 0, `${id} has raycastable body`);
    assert.ok(outer > 0, `${id} has pickable geometry beyond the rig`);
    visual.dispose(); assert.equal(visual.pickRoot, null); disposeMechaModel(rig);
  }
});


test("reduced motion and zero delta freeze orbital rotations", () => {
  const rig = createBoss(), scene = new THREE.Group(); scene.add(rig);
  const visual = createMonsterSpeciesPresentation(rig, "phase_stalker");
  const rotations = () => { const values: number[][] = []; visual.root.traverse(n => { if (n instanceof THREE.Group) values.push(n.rotation.toArray().slice(0, 3) as number[]); }); return values; };
  const initial = rotations(); visual.update(.1); const moving = rotations();
  assert.notDeepEqual(moving, initial);
  visual.update(0); assert.deepEqual(rotations(), moving);
  visual.update(.1, true); assert.deepEqual(rotations(), moving);
  visual.update(.1, true); assert.deepEqual(rotations(), moving);
  visual.dispose(); disposeMechaModel(rig);
});

test("displayed health dims the monster light without accumulating or guessing missing health", () => {
  const rig = createBoss();
  const scene = new THREE.Group(); scene.add(rig);
  const visual = createMonsterSpeciesPresentation(rig, "gravity_core");
  const light = visual.root.getObjectByName("monster-fx-light") as THREE.PointLight;
  visual.update(0, false, { hp: 100, maxHp: 100 });
  const full = light.intensity;
  visual.update(0, false, { hp: 0, maxHp: 100 });
  assert.ok(Math.abs(light.intensity - full * .35) < 1e-8);
  visual.update(0, false, { hp: 0, maxHp: 100 });
  assert.ok(Math.abs(light.intensity - full * .35) < 1e-8);
  visual.update(0, false, { hp: NaN, maxHp: 100 });
  assert.equal(light.intensity, full);
  visual.dispose(); disposeMechaModel(rig);
});

test("species body follows the rig defeat pose", () => {
  const scene = new THREE.Scene();
  const rig = createBoss(); scene.add(rig);
  const visual = createMonsterSpeciesPresentation(rig, "prism_warden");
  poseMechaModel(rig, "idle", 0); visual.update(0);
  const body = visual.root.children[0]!;
  const initial = body.quaternion.clone();
  poseMechaModel(rig, "defeat", 1); visual.update(0);
  assert.ok(initial.angleTo(body.quaternion) > 0.1, "defeat rotates the visible species body");
  visual.dispose(); disposeMechaModel(rig);
});
