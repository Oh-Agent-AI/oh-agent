#!/usr/bin/env node
// Player model contract: envelope, axes/animation, rendering budget and owned-resource lifecycle.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
const require = createRequire(new URL("../apps/agent-city/ui/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const THREE = await import(new URL("./three.module.js", pathToFileURL(require.resolve("three"))).href);
const code = buildSync({ entryPoints: [new URL("../apps/agent-city/ui/src/game/CarVisuals.ts", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "cjs", external: ["three"] }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require: (id) => id === "three" ? THREE : require(id), console });
const { CarVisuals, CAR_DIMENSIONS } = mod.exports;
const car = new CarVisuals();
const bounds = new THREE.Box3().setFromObject(car.root);
assert.ok(bounds.min.y >= -1e-6, "wheels must not extend below the contact plane");
assert.ok(bounds.max.y <= CAR_DIMENSIONS.height + 1e-6);
assert.ok(bounds.max.x - bounds.min.x <= CAR_DIMENSIONS.length + 1e-6);
assert.ok(bounds.max.z - bounds.min.z <= CAR_DIMENSIONS.width + 1e-6);
assert.ok(car.root.getObjectByName("interior"), "convertible includes a visible cabin");
assert.equal(car.root.getObjectByName("windows").material.transparent, true);
let triangles = 0; let draws = 0; let releasedGeometry = 0; let releasedMaterial = 0;
const geometries = new Set(); const materials = new Set();
car.root.traverse((node) => {
  if (!node.isMesh) return;
  draws += 1;
  assert.ok(!Array.isArray(node.material), "one draw per model mesh");
  triangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3;
  geometries.add(node.geometry); materials.add(node.material);
  const positions = node.geometry.attributes.position.array;
  assert.ok(Array.from(positions).every(Number.isFinite));
});
assert.ok(draws <= 12); assert.ok(triangles <= 10000);
const state = { x: 3, y: 2, z: 1, heading: Math.PI / 2, pitch: 0, roll: 0, steering: 0.3, distance: 0.24, braking: true, reversing: true };
car.update(state); car.root.updateMatrixWorld(true);
const forward = new THREE.Vector3(1, 0, 0).transformDirection(car.root.matrixWorld);
assert.ok(forward.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-10, "positive heading faces +Z");
for (let i = 0; i < 4; i += 1) {
  assert.equal(car.wheels[i].steer.rotation.y, i < 2 ? -0.3 : 0);
  assert.ok(Math.abs(car.wheels[i].spin.rotation.z + 1) < 1e-10);
}
assert.equal(car.root.getObjectByName("brake-lights").material.emissiveIntensity, 2);
assert.equal(car.root.getObjectByName("reverse-lights").material.emissiveIntensity, 1.5);
car.update({ ...state, distance: -0.24, braking: false, reversing: false });
assert.ok(Math.abs(car.wheels[0].spin.rotation.z - 1) < 1e-10);
for (const geometry of geometries) geometry.addEventListener("dispose", () => releasedGeometry++);
for (const material of materials) material.addEventListener("dispose", () => releasedMaterial++);
const parent = new THREE.Group(); parent.add(car.root);
car.dispose(); car.dispose();
assert.equal(parent.children.length, 0);
assert.equal(releasedGeometry, geometries.size); assert.equal(releasedMaterial, materials.size);
console.log(`Car model verified: ${triangles} triangles, ${draws} draws; bounds, animation and disposal passed.`);
