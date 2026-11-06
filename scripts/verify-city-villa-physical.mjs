#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { THREE, buildVillaComplex, villaGeometryParameters, resolveVillaGroundPhysical, hashSeed, quadInFootprint,
  buildGeography, WATER_LEVEL } = await loadCity({
  "pkg:three": ["* as THREE"],
  "engine/cityLandmarkVilla.ts": ["buildVillaComplex"],
  "engine/models/villaGeometry.ts": ["villaGeometryParameters", "resolveVillaGroundPhysical"],
  "cityModel.ts": ["hashSeed"],
  "engine/models/physical.ts": ["quadInFootprint"],
  "engine/planner/geography.ts": ["buildGeography"],
  "engine/planner/footprint.ts": ["WATER_LEVEL"],
});
function touchingPatches(build) {
  build.group.updateMatrixWorld(true);
  const patches = [];
  build.group.traverse(object => {
    if (!object.isMesh) return;
    object.geometry.computeBoundingBox();
    const box = object.geometry.boundingBox;
    const bottom = object.localToWorld(new THREE.Vector3(0, box.min.y, 0));
    if (Math.abs(bottom.y - build.group.position.y) > 1e-6) return;
    assert.equal(object.geometry.type, "BoxGeometry", "actual villa ground contacts are rectangular boxes");
    const points = [[box.min.x, box.min.z], [box.max.x, box.min.z], [box.max.x, box.max.z], [box.min.x, box.max.z]]
      .map(([x, z]) => object.localToWorld(new THREE.Vector3(x, box.min.y, z)));
    patches.push({ object, box, points });
  });
  return patches;
}
for (const seed of [0, 0.5, 1, 42, hashSeed("landmark:villa-complex")]) for (const neon of [false, true]) {
  const resolution = resolveVillaGroundPhysical({ seed, radius: 34 });
  assert.equal(resolution.status, "partial");
  assert.ok(resolution.missing.includes("entrance-and-approach"));
  const declaration = resolution.declaration, foundation = declaration.foundation;
  assert.equal(foundation.kind, "ground"); assert.equal(foundation.baseOffset, 0);
  assert.equal(foundation.support.parts.length, 3);
  assert.deepEqual(declaration.footprint, foundation.support);
  assert.deepEqual(villaGeometryParameters(seed), resolution.parameters);
  assert.deepEqual(resolveVillaGroundPhysical({ seed, radius: 34 }), resolution);
  const build = buildVillaComplex(seed, neon), patches = touchingPatches(build);
  assert.equal(patches.length, 3, "real renderer has deck, second step and tower plinth at local y=0");
  for (const patch of patches) {
    const quad = patch.points.map(point => ({ x: point.x, z: point.z }));
    assert.ok(quadInFootprint(quad, foundation.support, 1e-5), "actual ground mesh corners/edges must be covered by the declared union");
    assert.ok(quadInFootprint(quad, { parts: [foundation.support.parts[patches.indexOf(patch)]] }, 1e-5),
      "each support must correspond to the actual mesh, not an oversized plot circle");
    assert.ok(patch.points.every(point => Math.abs(point.y) < 1e-6), "declared baseOffset=0 matches actual mesh contact height");
  }
  build.disposables.forEach(item => item.dispose());
}
for (const radius of [0, 11, 32, 46, Infinity, NaN]) assert.equal(resolveVillaGroundPhysical({ seed: 1, radius }).status, "unsupported",
  "a renderer that ignores plot radius cannot claim resized geometry");
assert.equal(resolveVillaGroundPhysical({ seed: NaN }).status, "unsupported");

// Frozen failing placement, not a requirement that a future repaired production
// planner keep emitting it. The actual terrain function and rendered meshes are
// used; no 16-point plot-circle measurement is used as physical evidence.
const seed = 1703310796, R = 579.2644041008882, random = key => hashSeed(`${seed}:${key}`);
const shape = {
  stretch: 0.78 + random("stretch") * 0.5, spin: random("spin") * Math.PI * 2,
  harmonics: [2, 3, 5].map(k => ({ k, a: 0.05 + random(`h${k}`) * (k === 2 ? 0.16 : 0.1), p: random(`hp${k}`) * Math.PI * 2 })),
  bays: Array.from({ length: 1 + Math.floor(random("bays") * 3) }, (_, i) => ({ at: random(`bay${i}`) * Math.PI * 2,
    depth: 0.14 + random(`bayd${i}`) * 0.18, width: 0.18 + random(`bayw${i}`) * 0.25 })),
};
const terrain = buildGeography(seed, R, shape).terrain;
const owner = { id: "landmark:villa-complex", x: 356.6787732260374, z: -295.7379451603026, yaw: 2.420430145796707, radius: 34 };
const build = buildVillaComplex(hashSeed(owner.id), false);
build.group.position.set(owner.x, Math.max(0.3, terrain.height(owner.x, owner.z)), owner.z);
build.group.rotation.y = owner.yaw;
const patches = touchingPatches(build), report = [];
for (const patch of patches) {
  const { object, box } = patch, nx = Math.ceil(box.max.x - box.min.x), nz = Math.ceil(box.max.z - box.min.z);
  const record = { samples: 0, belowPlanningDryLevel: 0, belowPointThree: 0, belowRealSeaLevel: 0, minTerrain: Infinity, maxSupportGap: -Infinity };
  for (let ix = 0; ix <= nx; ix += 1) for (let iz = 0; iz <= nz; iz += 1) {
    const point = object.localToWorld(new THREE.Vector3(box.min.x + (box.max.x - box.min.x) * ix / nx, box.min.y,
      box.min.z + (box.max.z - box.min.z) * iz / nz));
    const ground = terrain.height(point.x, point.z);
    record.samples += 1; record.belowPlanningDryLevel += Number(ground < WATER_LEVEL);
    record.belowPointThree += Number(ground < 0.3); record.belowRealSeaLevel += Number(ground < -0.55);
    record.minTerrain = Math.min(record.minTerrain, ground); record.maxSupportGap = Math.max(record.maxSupportGap, point.y - ground);
  }
  report.push(record);
}
assert.equal(report[0].samples, 1365); assert.equal(report[0].belowPointThree, 520);
assert.equal(report[1].samples, 27); assert.equal(report[1].belowPointThree, 7);
assert.equal(report[2].samples, 49); assert.equal(report[2].belowPointThree, 0);
assert.ok(report[0].belowRealSeaLevel > 0 && report[0].maxSupportGap > 6,
  "the real rendered ground deck is over sea/unsupported terrain, not just a plot-circle false positive");
assert.ok(report[0].maxSupportGap > resolveVillaGroundPhysical({ seed: hashSeed(owner.id), radius: 34 }).declaration.foundation.maxGap);
console.log(JSON.stringify({ fixture: "1703310796/t2 original failing support placement", radius: R, owner, planningDryLevel: WATER_LEVEL,
  rendererSeaLevel: -0.55, actualMeshSupportSamples: report }));
build.disposables.forEach(item => item.dispose());
console.log("City villa physical: shared seed parameters and three true ground contact patches match actual meshes; fixed-radius unsupported cases and real submerged/unsupported foundation witnesses pass. Entrances, scene admission and full model coverage remain pending.");
