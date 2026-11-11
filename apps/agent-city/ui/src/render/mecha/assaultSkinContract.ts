import * as THREE from "three";
import { MechaGlbError } from "./glbModels";

const BONE_PARENTS: Record<string, string | null> = {
  pelvis: null, chest: "pelvis", head: "chest",
  upper_armL: "chest", forearmL: "upper_armL", handL: "forearmL",
  upper_armR: "chest", forearmR: "upper_armR", handR: "forearmR",
  thighL: "pelvis", shinL: "thighL", footL: "shinL", toeL: "footL",
  thighR: "pelvis", shinR: "thighR", footR: "shinR", toeR: "footR",
};
const PROPERTIES = ["position", "quaternion", "scale"];

export function validateAssaultSkin(scene: THREE.Object3D, clips: THREE.AnimationClip[], expectedClips: Record<string, number>): void {
  const problems: string[] = [];
  const meshes: THREE.SkinnedMesh[] = [];
  const names = new Set<string>();
  scene.traverse((node) => {
    if (node.name) {
      if (names.has(node.name)) problems.push(`duplicate node ${node.name}`);
      names.add(node.name);
    }
    if ((node as THREE.Mesh).isMesh) {
      if (!(node as THREE.SkinnedMesh).isSkinnedMesh) problems.push(`unskinned mesh ${node.name}`);
      else meshes.push(node as THREE.SkinnedMesh);
    }
  });
  if (!meshes.length) problems.push("no skinned mesh");
  const skeleton = meshes[0]?.skeleton;
  if (skeleton) {
    const bones = new Map<string, THREE.Bone>();
    for (const bone of skeleton.bones) {
      if (bones.has(bone.name)) problems.push(`duplicate bone ${bone.name}`);
      bones.set(bone.name, bone);
    }
    for (const [name, parent] of Object.entries(BONE_PARENTS)) {
      const bone = bones.get(name);
      if (!bone) problems.push(`missing bone ${name}`);
      else if (parent && bone.parent !== bones.get(parent)) problems.push(`bone ${name} has wrong parent`);
    }
    for (const mesh of meshes) {
      if (mesh.skeleton.bones.length !== skeleton.bones.length || mesh.skeleton.bones.some((bone, index) => bone !== skeleton.bones[index])) {
        problems.push(`mesh ${mesh.name} has a different skeleton`);
        continue;
      }
      const geometry = mesh.geometry;
      const positions = geometry.getAttribute("position"), indices = geometry.getAttribute("skinIndex"), weights = geometry.getAttribute("skinWeight");
      if (!positions || !indices || !weights || indices.itemSize !== 4 || weights.itemSize !== 4 || indices.count !== positions.count || weights.count !== positions.count) {
        problems.push(`mesh ${mesh.name} has invalid skin attributes`);
        continue;
      }
      const assigned: Array<Set<number>> = [];
      const allowed = (indices: Set<number>) => {
        if (indices.size <= 1) return true;
        const names = [...indices].map((index) => skeleton.bones[index]!.name).sort().join(",");
        return names === "footL,toeL" || names === "footR,toeR";
      };
      for (let i = 0; i < positions.count; i++) {
        let sum = 0, invalid = false;
        const selected = new Set<number>();
        for (let j = 0; j < 4; j++) {
          const weight = weights.getComponent(i, j), index = indices.getComponent(i, j);
          if (!Number.isFinite(weight) || weight < 0 || !Number.isInteger(index) || index < 0 || index >= skeleton.bones.length) { problems.push(`mesh ${mesh.name} has invalid weight or bone index`); invalid = true; break; }
          sum += weight;
          if (weight > 1e-6) selected.add(index);
        }
        if (invalid) break;
        if (!selected.size || !allowed(selected) || Math.abs(sum - 1) > 1e-5) { problems.push(`mesh ${mesh.name} has an unsupported or unnormalised vertex`); break; }
        assigned.push(selected);
      }
      if (assigned.length !== positions.count) continue;
      const triangleCount = geometry.index ? geometry.index.count : positions.count;
      if (triangleCount % 3 !== 0) { problems.push(`mesh ${mesh.name} has incomplete triangles`); continue; }
      for (let i = 0; i < triangleCount; i += 3) {
        const a = geometry.index ? geometry.index.getX(i) : i;
        const b = geometry.index ? geometry.index.getX(i + 1) : i + 1;
        const c = geometry.index ? geometry.index.getX(i + 2) : i + 2;
        if (![a, b, c].every((v) => Number.isInteger(v) && v >= 0 && v < assigned.length) || !allowed(new Set([...assigned[a]!, ...assigned[b]!, ...assigned[c]!]))) {
          problems.push(`mesh ${mesh.name} has a cross-bone or invalid triangle`); break;
        }
      }
    }
  }
  for (const [name, duration] of Object.entries(expectedClips)) {
    const matches = clips.filter((clip) => clip.name === name);
    if (matches.length !== 1) { problems.push(`clip ${name} missing or duplicated`); continue; }
    const clip = matches[0]!;
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(clip.duration) || Math.abs(clip.duration - duration) > 1e-4) problems.push(`clip ${name} duration mismatch`);
    const tracks = new Map<string, THREE.KeyframeTrack>();
    for (const track of clip.tracks) {
      if (tracks.has(track.name)) problems.push(`clip ${name} duplicate track ${track.name}`);
      const separator = track.name.lastIndexOf(".");
      const target = track.name.slice(0, separator), property = track.name.slice(separator + 1);
      if (!(target in BONE_PARENTS) || !PROPERTIES.includes(property)) problems.push(`clip ${name} has unexpected track ${track.name}`);
      tracks.set(track.name, track);
      if (!track.times.length || Math.abs(track.times[0]!) > 1e-6 || (track.times.length > 1 && Math.abs(track.times[track.times.length - 1]! - clip.duration) > 1e-4) || !Array.from(track.times).every((v, i, a) => Number.isFinite(v) && (i === 0 || v > a[i - 1]!)) || !Array.from(track.values).every(Number.isFinite) || track.values.length !== track.times.length * (property === "quaternion" ? 4 : 3)) problems.push(`clip ${name} invalid track ${track.name}`);
    }
    for (const bone of Object.keys(BONE_PARENTS)) for (const property of PROPERTIES) {
      if (!tracks.has(`${bone}.${property}`)) problems.push(`clip ${name} missing track ${bone}.${property}`);
    }
  }
  if (problems.length) throw new MechaGlbError(`Assault skin breaks the contract: ${problems.join("; ")}`);
}
