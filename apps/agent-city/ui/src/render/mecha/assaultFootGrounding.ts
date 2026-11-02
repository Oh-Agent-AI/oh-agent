import * as THREE from "three";
import { AssaultContactSampler } from "./assaultContact";
import type { GroundHeight } from "./assaultGround";
import { reachableAssaultDown, solveAssaultLeg, type AssaultLegChain } from "./assaultLegIK";
import type { MechaGlbAsset } from "./glbModels";

const position = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3());

export class AssaultFootGrounding {
  private readonly root: THREE.Object3D;
  private readonly contacts: AssaultContactSampler;
  private readonly legs: [AssaultLegChain, AssaultLegChain];

  constructor(root: THREE.Object3D, asset: MechaGlbAsset) {
    this.root = root;
    this.contacts = new AssaultContactSampler(root, asset);
    const bone = (name: string) => {
      const object = root.getObjectByName(name);
      if (!object || !(object as THREE.Bone).isBone) throw new Error(`missing grounding bone ${name}`);
      return object;
    };
    this.legs = (["L", "R"] as const).map((side) => {
      const thigh = bone(`thigh${side}`), shin = bone(`shin${side}`), foot = bone(`foot${side}`);
      if (shin.parent !== thigh || foot.parent !== shin) throw new Error(`invalid grounding chain ${side}`);
      return { thigh, shin, foot, upper: 0, lower: 0 };
    }) as [AssaultLegChain, AssaultLegChain];
  }

  sample(phase: number, height: GroundHeight, maxDrop: number): readonly [number, number] {
    if (!Number.isFinite(phase) || phase < 0 || phase >= 1 || !Number.isFinite(maxDrop) || maxDrop < 0) throw new Error("invalid grounding parameters");
    this.root.updateWorldMatrix(true, false);
    this.root.updateMatrixWorld(true);
    const rotations = this.legs.flatMap(({ thigh, shin, foot }) => [thigh, shin, foot].map((bone) => ({ bone, quaternion: bone.quaternion.clone() })));
    const corrections: [number, number] = [0, 0];
    try {
      for (const side of [0, 1] as const) {
        const leg = this.legs[side], [start, end] = side === 0 ? [.08, .6] : [.51, .98];
        const weight = Math.max(0, Math.min(1, (phase - start!) / .10, (end! - phase) / .16));
        for (let iteration = 0; iteration < 8; iteration++) {
          const clearance = this.contacts.clearance(side, height);
          let correction = clearance < -1e-6 ? -clearance : iteration === 0 && clearance > 0 ? -Math.min(clearance, maxDrop) * weight : 0;
          if (Math.abs(correction) <= 1e-6) break;
          const hip = position(leg.thigh), knee = position(leg.shin), ankle = position(leg.foot);
          leg.upper = hip.distanceTo(knee); leg.lower = knee.distanceTo(ankle);
          if (correction < 0) correction = -reachableAssaultDown(hip, ankle, leg.upper, leg.lower, -correction, knee);
          if (Math.abs(correction) <= 1e-6) break;
          corrections[side] += correction;
          const rotation = leg.foot.getWorldQuaternion(new THREE.Quaternion());
          const scale = this.root.getWorldScale(new THREE.Vector3()).x;
          const t = maxDrop > 0 ? Math.min(1, Math.abs(correction) / (.25 * scale)) : 0;
          const guide = t > 0 ? { direction: new THREE.Vector3(side === 0 ? -1 : 1, 0, .7).applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion())), weight: t * t * (3 - 2 * t) } : undefined;
          solveAssaultLeg(this.root, leg, ankle.add(new THREE.Vector3(0, correction, 0)), rotation, guide);
        }
        if (this.contacts.clearance(side, height) < -1e-5) throw new Error("Assault foot grounding did not converge");
      }
      return corrections;
    } catch (error) {
      for (const { bone, quaternion } of rotations) bone.quaternion.copy(quaternion);
      this.root.updateMatrixWorld(true);
      throw error;
    }
  }
}
