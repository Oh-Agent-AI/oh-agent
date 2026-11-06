import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { MechaGlbManifest } from "./animation";
import { MechaGlbError, type MechaGlbAsset } from "./glbModels";
import { validateAssaultSkin } from "./assaultSkinContract";

const CLIPS = ["idle", "move", "attack", "hit", "defeat", "turn_left", "turn_right"];
const SOURCE_PREFIX = "ground_half_trial_";

export type AssaultSkinSpec = {
  scale: number;
  sourceForward: "+Z";
};

export async function parseAssaultSkinGlb(data: ArrayBuffer, manifest: MechaGlbManifest, spec: AssaultSkinSpec): Promise<MechaGlbAsset> {
  if (manifest.role !== "Assault" || spec.sourceForward !== "+Z" || !Number.isFinite(spec.scale) || spec.scale <= 0 || !manifest.maxExtentMeters) {
    throw new MechaGlbError("invalid Assault skin manifest or transform");
  }
  if (Object.keys(manifest.clips).length !== CLIPS.length || CLIPS.some((name) => !manifest.clips[name])) {
    throw new MechaGlbError("Assault skin manifest must declare all seven clips");
  }
  for (const name of CLIPS) {
    const clip = manifest.clips[name]!;
    if (!Number.isFinite(clip.duration) || clip.duration <= 0 || clip.loop !== (name === "idle" || name === "move")) {
      throw new MechaGlbError(`invalid Assault skin clip ${name}`);
    }
  }
  let gltf;
  try {
    gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(data, "");
  } catch (error) {
    throw new MechaGlbError(`cannot parse Assault skin GLB: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (gltf.animations.length !== CLIPS.length) throw new MechaGlbError("Assault skin GLB must contain exactly seven clips");
  const durations = Object.fromEntries(CLIPS.map((name) => [SOURCE_PREFIX + name, manifest.clips[name]!.duration]));
  validateAssaultSkin(gltf.scene, gltf.animations, durations);
  const clips = gltf.animations.map((clip) => {
    const copy = clip.clone();
    copy.name = clip.name.slice(SOURCE_PREFIX.length);
    return copy;
  });
  const visual = new THREE.Group();
  visual.name = "visual";
  visual.rotation.y = Math.PI;
  visual.scale.setScalar(spec.scale);
  visual.add(gltf.scene);
  const scene = new THREE.Group();
  scene.add(visual);
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(scene, true);
  const size = bounds.getSize(new THREE.Vector3());
  if (![...bounds.min.toArray(), ...bounds.max.toArray(), ...size.toArray()].every(Number.isFinite) || size.x <= 0 || size.y <= 0 || size.z <= 0 || Math.abs(bounds.min.y) > .05 || Math.abs(size.y - manifest.heightMeters) > manifest.heightMeters * .1 || size.x > manifest.maxExtentMeters[0] || size.z > manifest.maxExtentMeters[1]) {
    throw new MechaGlbError("Assault skin dimensions or floor do not match its manifest");
  }
  return { manifest, scene, clips, rearExtent: 0 };
}
