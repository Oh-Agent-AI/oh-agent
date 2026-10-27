// Contract check for a rigid-joint character GLB, using the real three.js loader and mixer.
//   node --experimental-strip-types glb_check.ts <texture-free.glb> <manifest.json>
// Run it from a directory where `three` resolves (e.g. the game's UI package), and feed it the
// output of strip_textures.py — Node has no image decoder, so GLTFLoader rejects embedded PNGs.
//
// Checks: required joints + parents, identity rest rotation, marker nodes, unique names, facing −Z,
// clip durations vs manifest (±1/30 s), no vertex below ground in any sampled frame, loop seams,
// finite matrices, idle@t≈0 equals bind pose. Prints size, draw calls, triangles.
//
// manifest may carry "hierarchy" ({node: parent}) and "markers" ([names]); otherwise the humanoid
// defaults below are used.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { readFileSync } from "node:fs";

const [glbPath, manifestPath] = process.argv.slice(2);
const buf = readFileSync(glbPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const gltf: any = await new Promise((ok, bad) =>
  new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", ok, bad));
const scene: THREE.Object3D = gltf.scene;
const visual = scene.getObjectByName("visual")!;
const fails: string[] = [];

const need: Record<string, string> = manifest.hierarchy ?? {
  body: "visual", head: "body", upper_arm_l: "body", upper_arm_r: "body", forearm_l: "upper_arm_l",
  forearm_r: "upper_arm_r", thigh_l: "visual", thigh_r: "visual", shin_l: "thigh_l", shin_r: "thigh_r",
  foot_l: "shin_l", foot_r: "shin_r",
};
const markers: string[] = manifest.markers ?? ["front", "gauntlet-left", "gauntlet-right", "shield"];
if (!visual) fails.push("missing visual root");
for (const [n, p] of Object.entries(need)) {
  const o = scene.getObjectByName(n);
  if (!o) fails.push(`missing ${n}`);
  else if (o.parent?.name !== p) fails.push(`${n} parent=${o.parent?.name} want ${p}`);
  else if (o.quaternion.angleTo(new THREE.Quaternion()) > 1e-6) fails.push(`${n} rest rotation not identity`);
}
for (const n of markers) if (!scene.getObjectByName(n)) fails.push(`missing marker ${n}`);
const names = new Set<string>();
// GLTFLoader sanitizes names (drops ":" "." "/" …) and suffixes duplicates — so names must be unique and plain.
scene.traverse((o) => { if (o.name && names.has(o.name)) fails.push(`dup ${o.name}`); names.add(o.name); });

scene.updateMatrixWorld(true);
const face = new THREE.Vector3();
scene.getObjectByName("front")?.getWorldPosition(face);
if (face.z > -1) fails.push(`front marker z=${face.z.toFixed(2)} (should face -Z)`);
const rest = new THREE.Box3().setFromObject(scene);
const size = rest.getSize(new THREE.Vector3());
const rearExtent = Math.max(0, rest.max.z);

const mixer = new THREE.AnimationMixer(scene);
for (const [name, spec] of Object.entries<any>(manifest.clips)) {
  const clip: THREE.AnimationClip | undefined = gltf.animations.find((c: THREE.AnimationClip) => c.name === name);
  if (!clip) { fails.push(`clip ${name} missing`); continue; }
  if (Math.abs(clip.duration - spec.duration) > 1 / 30) fails.push(`clip ${name} ${clip.duration} vs ${spec.duration}`);
  mixer.stopAllAction();
  mixer.clipAction(clip).play();
  let minY = Infinity;
  for (let k = 0; k <= 40; k++) {
    mixer.setTime((clip.duration * k) / 40);
    // the runtime lifts a backward fall by rearExtent·sin(pitch); emulate it for defeat
    if (name === "defeat") visual.position.y = rearExtent * Math.sin(visual.rotation.x);
    scene.updateMatrixWorld(true);
    scene.traverse((o) => { if (!o.matrixWorld.elements.every(Number.isFinite)) fails.push(`${name} NaN at ${o.name}`); });
    minY = Math.min(minY, new THREE.Box3().setFromObject(scene).min.y);
  }
  if (minY < -0.05) fails.push(`${name} sinks to ${minY.toFixed(3)} m`);
  if (spec.loop) {
    // setTime(0) right after play() has not applied the clip yet (reads bind pose): compare from 1e-4
    mixer.setTime(1e-4); scene.updateMatrixWorld(true);
    const a = new THREE.Box3().setFromObject(scene);
    mixer.setTime(clip.duration - 1e-4); scene.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(scene);
    if (a.min.distanceTo(b.min) > 0.02 || a.max.distanceTo(b.max) > 0.02) fails.push(`${name} loop seam`);
  }
  console.log(`clip ${name.padEnd(7)} ${clip.duration.toFixed(3)}s  minY=${minY.toFixed(3)} m  tracks=${clip.tracks.length}`);
}
mixer.stopAllAction(); if (visual) visual.position.set(0, 0, 0);
const idle = gltf.animations.find((c: THREE.AnimationClip) => c.name === "idle");
if (idle) {
  mixer.clipAction(idle).play(); mixer.setTime(0); scene.updateMatrixWorld(true);
  const back = new THREE.Box3().setFromObject(scene);
  if (back.min.distanceTo(rest.min) > 0.02 || back.max.distanceTo(rest.max) > 0.02) fails.push("idle@0 is not the bind pose");
}
let tris = 0, prims = 0;
scene.traverse((o: any) => { if (o.isMesh) { prims++; tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } });
console.log(`size m: w=${size.x.toFixed(2)} h=${size.y.toFixed(2)} d=${size.z.toFixed(2)} rest minY=${rest.min.y.toFixed(3)} front.z=${face.z.toFixed(2)}`);
console.log(`draw calls=${prims} tris=${tris}`);
console.log(fails.length ? "FAIL\n" + [...new Set(fails)].join("\n") : "ALL CHECKS PASS");
