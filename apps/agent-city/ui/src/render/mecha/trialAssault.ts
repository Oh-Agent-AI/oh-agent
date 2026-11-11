/** Isolated candidate adapter for local evaluation; not an approved asset contract. */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { MechaGlbError, type MechaGlbAsset } from "./glbModels";
import type { MechaGlbManifest } from "./animation";

export async function parseTrialAssault(data: ArrayBuffer, manifest: MechaGlbManifest): Promise<MechaGlbAsset> {
  await MeshoptDecoder.ready;
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(data, "");
  const skins: THREE.SkinnedMesh[] = [];
  gltf.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skins.push(o as THREE.SkinnedMesh); });
  if (skins.length < 1) throw new MechaGlbError("trial needs at least one skinned mesh");
  const names = new Set(skins[0]!.skeleton.bones.map((b) => b.name));
  for (const skin of skins) {
    if (skin.skeleton.bones.length !== skins[0]!.skeleton.bones.length || skin.skeleton.bones.some((b, i) => b !== skins[0]!.skeleton.bones[i])) throw new MechaGlbError("trial primitives must share one skeleton");
  }
  for (const name of ["pelvis", "chest", "head", "upper_armR", "upper_armL", "forearmR", "forearmL", "thighR", "thighL", "shinR", "shinL", "footR", "footL"]) {
    if (!names.has(name)) throw new MechaGlbError(`trial is missing bone ${name}`);
  }
  for (const [name, spec] of Object.entries(manifest.clips)) {
    const clips = gltf.animations.filter((c) => c.name === `ground_half_trial_${name}`);
    if (clips.length !== 1 || !(clips[0]!.duration > 0)) throw new MechaGlbError(`trial clip ${name} is missing or invalid`);
    const clip = clips[0]!;
    clip.name = name;
    for (const track of clip.tracks) { track.times = track.times.slice(); track.scale(spec.duration / clip.duration); }
    clip.resetDuration();
  }
  const visual = new THREE.Group(); visual.name = "visual"; visual.rotation.y = Math.PI; visual.add(gltf.scene);
  const scene = new THREE.Group(); scene.add(visual); scene.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(scene, true).getSize(new THREE.Vector3());
  const extent = manifest.maxExtentMeters;
  if (!extent || ![size.x, size.y, size.z].every((n) => Number.isFinite(n) && n > 0)) throw new MechaGlbError("trial has invalid bounds");
  const scale = Math.min(manifest.heightMeters / size.y, extent[0] * .98 / size.x, extent[1] * .98 / size.z);
  visual.scale.setScalar(scale); scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene, true);
  const scaled = box.getSize(new THREE.Vector3());
  if (Math.abs(scaled.y - manifest.heightMeters) > manifest.heightMeters * .1 || scaled.x > extent[0] || scaled.z > extent[1] || Math.abs(box.min.y) > .05) throw new MechaGlbError("trial does not meet declared dimensions and floor");
  return { manifest, scene, clips: gltf.animations, rearExtent: Math.max(0, box.max.z) };
}
