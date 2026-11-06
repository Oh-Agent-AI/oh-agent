import * as THREE from "three";
import { poseMechaModel, setMechaRig } from "./animation";
import { createStrideProfile } from "./assaultGait";
import { instantiateMechaGlb, type MechaGlbAsset } from "./glbModels";
import { MECHA_METERS_PER_UNIT } from "./models";

type AssaultStride = { stride: number; profile: (phase: number) => number; toeStartZ: readonly [number, number] };
const cached = new WeakMap<MechaGlbAsset, AssaultStride>();

export function measureAssaultStride(asset: MechaGlbAsset): AssaultStride {
  const existing = cached.get(asset);
  if (existing) return existing;
  const move = asset.manifest.clips.move;
  if (asset.manifest.role !== "Assault" || !move?.loop || !Number.isFinite(move.duration) || move.duration <= 0) throw new Error("invalid Assault move clip");
  const instance = instantiateMechaGlb(asset, MECHA_METERS_PER_UNIT);
  const root = new THREE.Group();
  root.add(instance.wrapper);
  setMechaRig(root, instance.rig);
  try {
    const left = root.getObjectByName("toeL"), right = root.getObjectByName("toeR");
    if (!left || !right || !(left as THREE.Bone).isBone || !(right as THREE.Bone).isBone) throw new Error("missing Assault toe bones");
    const count = 800, distances = [0];
    let previous = [new THREE.Vector3(), new THREE.Vector3()];
    let toeStartZ: [number, number] = [0, 0];
    for (let i = 0; i <= count; i++) {
      poseMechaModel(root, "move", (i === count ? 0 : i / count) * move.duration);
      root.updateMatrixWorld(true);
      const current = [left.getWorldPosition(new THREE.Vector3()), right.getWorldPosition(new THREE.Vector3())];
      if (i === 0) toeStartZ = [current[0]!.z, current[1]!.z];
      if (i > 0) {
        const phase = (i - 0.5) / count;
        const foot = phase >= 0.125 && phase < 0.5 ? 0 : phase >= 0.5625 && phase < 0.875 ? 1 : -1;
        const distance = foot < 0 ? 0 : Math.max(0, current[foot]!.z - previous[foot]!.z);
        distances.push(distances[i - 1]! + distance);
      }
      previous = current;
    }
    const measured = { stride: distances[count]!, profile: createStrideProfile(distances), toeStartZ };
    cached.set(asset, measured);
    return measured;
  } finally {
    instance.dispose();
  }
}
