#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import * as THREE from "../apps/agent-city/ui/node_modules/three/build/three.module.js";

const m = await loadCity({
  "game/driving/CollisionIndex.ts": ["buildVersionedCollisionIndex"],
  "game/driving/cameraCollisionQuery.ts": ["createCameraCollisionQuery"],
  "game/VehicleChaseCamera.ts": ["VehicleChaseCamera"],
});
const box = (id, minX, minY, minZ, maxX, maxY, maxZ) => ({
  id, role: "camera-test", kind: "box", center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
  halfAxes: [{ x: (maxX - minX) / 2, y: 0, z: 0 }, { x: 0, y: (maxY - minY) / 2, z: 0 }, { x: 0, y: 0, z: (maxZ - minZ) / 2 }],
});
const makeIndex = (solids, limits) => m.buildVersionedCollisionIndex("camera-fixture", solids, limits);

// A thin wall blocks the swept near-plane envelope even when neither endpoint
// lies inside it; a bridge slab only blocks the camera at its actual elevation.
{
  const wall = makeIndex([box("thin-wall", 2, 0, -4, 2.1, 8, 4)]);
  assert.equal(wall.status, "ready");
  const query = m.createCameraCollisionQuery(wall.index);
  const hit = query({ x: 0, y: 3, z: 0 }, { x: 5, y: 3, z: 0 }, 0.25);
  assert.equal(hit.status, "blocked");
  assert.ok(hit.safeFraction > 0 && hit.safeFraction < 1);
  const underBridge = makeIndex([box("bridge", -2, 8, -2, 2, 8.2, 2)]);
  assert.equal(m.createCameraCollisionQuery(underBridge.index)({ x: 0, y: 3, z: 0 }, { x: 0, y: 3, z: 5 }, 0.2).status, "clear");
  assert.equal(m.createCameraCollisionQuery(underBridge.index)({ x: 0, y: 7.5, z: 0 }, { x: 0, y: 9, z: 0 }, 0.2).status, "blocked");
  assert.deepEqual(m.createCameraCollisionQuery(wall.index)({ x: 2, y: 3, z: 0 }, { x: 5, y: 3, z: 0 }, 0.25),
    { status: "blocked", safeFraction: 0 }, "initial overlap must not be mislabeled clear");
}

// Candidate-budget exhaustion remains unresolved and the camera's actual
// damped movement segment is checked, not just its target arm.
{
  const crowded = makeIndex(Array.from({ length: 4097 }, (_, i) => box(`budget:${i}`, -2, -2, -2, 2, 2, 2)));
  assert.equal(crowded.status, "ready");
  assert.equal(m.createCameraCollisionQuery(crowded.index)({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.2).status, "unresolved");

  const camera = new THREE.PerspectiveCamera(48, 1, 0.2, 100);
  const core = new m.VehicleChaseCamera(camera, { positionDamping: 1, dragPositionDamping: 1, lookDamping: 1,
    baseBack: 8, baseHeight: 4, speedBackBoost: 0, lookAhead: 2, fovBase: 48, fovSpeedSpan: 10, groundMargin: 0.5 }, true);
  const sweeps = [];
  const sweep = (from, to) => {
    sweeps.push({ from: { ...from }, to: { ...to } });
    if (sweeps.length < 4 || sweeps.length === 3) return { status: "clear" };
    return { status: "blocked", safeFraction: 0.4 };
  };
  const firstTarget = { x: 0, y: 2, z: 0, heading: 0, speed: 20, speedRatio: 1 };
  assert.equal(core.update(1 / 60, firstTarget, { cameraSweep: sweep }), "clear");
  const beforeMove = camera.position.clone();
  const safety = core.update(1 / 60, { ...firstTarget, x: 1 }, { cameraSweep: sweep });
  assert.equal(safety, "shrunk");
  assert.deepEqual(sweeps[3].from, { x: beforeMove.x, y: beforeMove.y, z: beforeMove.z }, "movement sweep starts from the actual damped camera position");
  assert.ok(Math.hypot(camera.position.x - sweeps[3].from.x, camera.position.y - sweeps[3].from.y, camera.position.z - sweeps[3].from.z) > 0,
    "movement sweep starts from the camera's actual damped position");
  assert.equal(camera.fov, 48, "reduced-motion holds speed FOV");

  const previewCamera = new THREE.PerspectiveCamera(48, 1, 0.2, 100);
  const preview = new m.VehicleChaseCamera(previewCamera, { positionDamping: 15, dragPositionDamping: 20, lookDamping: 20,
    baseBack: 7, baseHeight: 4, speedBackBoost: 0, lookAhead: 2, fovBase: 48, fovSpeedSpan: 8, groundMargin: 0.5 }, false);
  const previewTarget = { x: 0, y: 2, z: 0, heading: 0, speed: 0, speedRatio: 0 };
  preview.update(1 / 60, previewTarget);
  const previous = previewCamera.position.clone();
  assert.equal(preview.update(1 / 60, { ...previewTarget, x: 1 }), "unresolved", "no query is never reported certified clear");
  assert.notDeepEqual(previewCamera.position.toArray(), previous.toArray(), "standalone camera keeps its visual motion fallback without geometry");
}
console.log("city camera collision query verification passed");
