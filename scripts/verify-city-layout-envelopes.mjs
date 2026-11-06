#!/usr/bin/env node
// Inspect actual renderer vertices and shader wind extrema, not copied layout boxes.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { THREE, buildCivics, buildGardens, buildFlags, GARDEN_MINIMUM_SIZE, CIVIC_RENDER_ENVELOPES,
  civicMinimumSize, civicEnvelopeSize, gardenFlagPosition, DISTRICT_LANDMARK_ENVELOPE, DISTRICT_LANDMARK_RENDER_GEOMETRY } = await loadCity({
  "pkg:three": ["* as THREE"],
  "engine/systems/civicSystem.ts": ["buildCivics", "buildGardens", "buildFlags"],
  "engine/models/layoutPlacementGeometry.ts": ["GARDEN_MINIMUM_SIZE", "CIVIC_RENDER_ENVELOPES", "civicMinimumSize", "civicEnvelopeSize", "gardenFlagPosition", "DISTRICT_LANDMARK_ENVELOPE", "DISTRICT_LANDMARK_RENDER_GEOMETRY"],
});
function host(layout) {
  const h = { layout, group: new THREE.Group(), water: { material: new THREE.MeshBasicMaterial() }, disposables: [],
    nightLights: null, flagTime: { value: 0 }, civicPieces: [], civicMeshes: [], civicProgress: [], civicTarget: [],
    matrix: new THREE.Matrix4(), quaternion: new THREE.Quaternion(), euler: new THREE.Euler(),
    scaleVector: new THREE.Vector3(), positionVector: new THREE.Vector3(), color: new THREE.Color(),
    makeInstanced: (geometry, material, capacity) => new THREE.InstancedMesh(geometry, material, capacity), writeCivic: () => {} };
  h.compose = (x, y, z, yaw, sx, sy, sz) => {
    h.positionVector.set(x, y, z); h.quaternion.setFromEuler(h.euler.set(0, yaw, 0)); h.scaleVector.set(sx, sy, sz);
    h.matrix.compose(h.positionVector, h.quaternion, h.scaleVector);
  };
  return h;
}
function inside(point, site, width, depth, message) {
  const dx = point.x - site.x, dz = point.z - site.z, c = Math.cos(site.yaw), s = Math.sin(site.yaw);
  const x = c * dx - s * dz, z = s * dx + c * dz;
  assert.ok(Math.abs(x) <= width / 2 + 1e-5 && Math.abs(z) <= depth / 2 + 1e-5, `${message}: ${x}:${z} outside ${width}:${depth}`);
}
for (const kind of Object.keys(CIVIC_RENDER_ENVELOPES)) for (const yaw of [0, Math.PI / 2, Math.PI / 4, -1.17]) {
  const minimum = civicMinimumSize(kind);
  for (const dimensions of [minimum, { width: 48, depth: 40 }, { width: 120, depth: 80 }]) {
    const civic = { id: "civic", kind, x: 23, z: -17, yaw, y: 1.2, ...dimensions };
    const h = host({ civics: [civic] }); buildCivics(h);
    const envelope = civicEnvelopeSize(kind, civic.width, civic.depth);
    for (const piece of h.civicPieces) {
      const positions = h.civicMeshes[piece.mesh].geometry.attributes.position;
      h.compose(piece.x, piece.y, piece.z, piece.yaw, piece.sx, piece.sy, piece.sz);
      for (let i = 0; i < positions.count; i++) inside(new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(h.matrix),
        civic, envelope.width, envelope.depth, `${kind} actual vertex`);
    }
  }
}
for (const yaw of [0, Math.PI / 2, Math.PI / 4, -1.17]) for (const dimensions of [GARDEN_MINIMUM_SIZE, { width: 120, depth: 80 }]) {
  const garden = { id: "garden:fixture", districtId: "codex", x: 23, z: -17, yaw, y: 1.2, seed: 0.63, ...dimensions };
  const h = host({ gardens: [garden], publicSites: [] }); buildGardens(h); buildFlags(h); h.group.updateMatrixWorld(true);
  const expected = gardenFlagPosition(garden), pole = h.group.children.find((mesh) => mesh.isInstancedMesh && mesh.geometry.type === "CylinderGeometry");
  pole.getMatrixAt(0, h.matrix);
  const centre = new THREE.Vector3().setFromMatrixPosition(h.matrix);
  assert.ok(Math.hypot(centre.x - expected.x, centre.z - expected.z) < 1e-5, "flag uses the same rotationY transform as its garden");
  for (const mesh of h.group.children) if (mesh.geometry?.attributes.position) {
    const positions = mesh.geometry.attributes.position, count = mesh.isInstancedMesh ? mesh.count : 1;
    for (let index = 0; index < count; index++) {
      if (mesh.isInstancedMesh) mesh.getMatrixAt(index, h.matrix); else h.matrix.copy(mesh.matrixWorld);
      const winds = mesh.name === "city-flags" ? [-0.53, 0.53] : [0];
      for (const wind of winds) for (let i = 0; i < positions.count; i++) {
        const point = new THREE.Vector3().fromBufferAttribute(positions, i); point.z += wind;
        inside(point.applyMatrix4(h.matrix), garden, garden.width, garden.depth, "actual garden/flag envelope");
      }
    }
  }
}
assert.equal(DISTRICT_LANDMARK_ENVELOPE.width, DISTRICT_LANDMARK_RENDER_GEOMETRY.skirtWidth + 0.02);
assert.equal(DISTRICT_LANDMARK_ENVELOPE.depth, DISTRICT_LANDMARK_RENDER_GEOMETRY.skirtDepth + 0.02);
assert.equal(civicMinimumSize("unregistered-model"), null);
console.log("City layout envelopes: actual civic/garden vertices, wind extrema, flag rotationY and shared 17m district skirt are covered; model-door/foundation proof remains separate.");
