import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { markPreviewEntityObject, PreviewDecorRegistry, PreviewEntityRegistry } from "../src/engine/previewEntityRegistry.ts";

test("preview entity registry resolves exact nested hits and unregisters the whole scene", () => {
  const scene = new THREE.Group();
  const taxi = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  taxi.add(mesh);
  scene.add(taxi);
  markPreviewEntityObject(taxi, { entityId: "taxi-17", label: "黄色出租车", kind: "scene-model" });
  const registry = new PreviewEntityRegistry();
  registry.register(scene);
  assert.equal(registry.resolve(mesh), taxi);
  assert.equal(registry.get("taxi-17"), taxi);
  assert.equal(registry.get("taxi-18"), null);
  registry.unregister(scene);
  assert.equal(registry.resolve(mesh), null);
  assert.equal(registry.get("taxi-17"), null);
});

test("preview entity registry rejects duplicate ids without silently rebinding", () => {
  const first = new THREE.Group();
  const second = new THREE.Group();
  markPreviewEntityObject(first, { entityId: "same", label: "first", kind: "scene-model" });
  markPreviewEntityObject(second, { entityId: "same", label: "second", kind: "scene-model" });
  const registry = new PreviewEntityRegistry();
  const root = new THREE.Group();
  root.add(first);
  registry.register(root);
  const other = new THREE.Group();
  other.add(second);
  assert.throws(() => registry.register(other), /preview_entity_duplicate/);
  assert.equal(registry.get("same"), first);
  assert.deepEqual(registry.pickableRoots(), [root]);
});


test("decor entity poses survive hover changes and are bounded to the current City", () => {
  const registry = new PreviewDecorRegistry();
  const source = new THREE.Vector3(12, 3, -8);
  registry.remember("decor:site:civic", source);
  source.set(99, 99, 99);
  registry.remember("decor:site:harbor", new THREE.Vector3(4, 2, 6));
  assert.deepEqual(registry.get("decor:site:civic")?.toArray(), [12, 3, -8]);
  for (let index = 0; index < 256; index++) registry.remember(`decor:${index}`, new THREE.Vector3(index, 0, 0));
  assert.equal(registry.get("decor:site:civic"), null);
  registry.clear();
  assert.equal(registry.get("decor:site:harbor"), null);
});
