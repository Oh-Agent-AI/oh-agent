import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { captureRenderedSolids } from "../src/engine/surface/renderedSolids";

test("reports the registered role and deformation type without exposing object names", () => {
  const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  skinned.name = "private-object-name";
  assert.throws(() => captureRenderedSolids([{ object: skinned, role: "landmark" }]), { message: "unsupported-rendered-solid-deformation:landmark:skinned" });
  const morphed = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  morphed.morphTargetInfluences = [0.5];
  assert.throws(() => captureRenderedSolids([{ object: morphed, role: "building" }]), { message: "unsupported-rendered-solid-deformation:building:morph" });
  morphed.morphTargetInfluences = [0];
  assert.equal(captureRenderedSolids([{ object: morphed, role: "building" }]).solids.length, 1);
});

test("captures a trusted parked skin in its current pose and detects bone movement", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0,0,0,0, 0,0,0,0, 0,0,0,0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1,0,0,0, 1,0,0,0, 1,0,0,0], 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  const bone = new THREE.Bone(); mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
  const parked = new THREE.Group(); parked.userData.cityDrivingStaticPose = true; parked.add(mesh);
  parked.updateMatrixWorld(true);
  const captured = captureRenderedSolids([{ object: parked, role: "landmark" }]);
  assert.equal(captured.solids.length, 1);
  assert.deepEqual([...captured.solids[0].positions], [0,0,0, 1,0,0, 0,1,0]);
  assert.equal(captured.isCurrent(), true);
  bone.position.x = 2;
  assert.equal(captured.isCurrent(), false);
});
