import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { cloneCityObjectView } from "../src/engine/cityObjectView.ts";

test("City object views keep independent scene parents and mapped meshes while sharing geometry", () => {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  root.add(mesh);
  const base = new THREE.Group();
  const preview = new THREE.Group();
  base.add(root);
  const view = cloneCityObjectView(root);
  preview.add(view.root);
  assert.equal(root.parent, base);
  assert.equal(view.root.parent, preview);
  assert.notEqual(view.resolve(mesh), mesh);
  assert.equal(view.resolve(mesh).geometry, mesh.geometry);
  assert.equal(view.resolve(mesh), view.resolve(mesh));
  preview.remove(view.root);
  assert.equal(root.parent, base);
  mesh.geometry.dispose();
  mesh.material.dispose();
});
