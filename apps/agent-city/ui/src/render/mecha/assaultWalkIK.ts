import * as THREE from "three";
import { solveAssaultLeg, type AssaultLegChain } from "./assaultLegIK";

// Retarget the clip's longitudinal foot travel, rather than moving the body faster
// than its feet. The phase-zero pose is unchanged, so turn-to-walk transitions remain continuous.
export class AssaultWalkIK {
  private readonly legs: [AssaultLegChain & { toe: THREE.Object3D }, AssaultLegChain & { toe: THREE.Object3D }];
  private readonly root: THREE.Object3D;
  private readonly toeStartZ: readonly [number, number];
  constructor(root: THREE.Object3D, toeStartZ: readonly [number, number]) {
    this.root = root; this.toeStartZ = toeStartZ;
    const bone = (name: string) => {
      const object = root.getObjectByName(name);
      if (!object || !(object as THREE.Bone).isBone) throw new Error(`missing walk bone ${name}`);
      return object;
    };
    this.legs = (["L", "R"] as const).map((side) => ({ thigh: bone(`thigh${side}`), shin: bone(`shin${side}`), foot: bone(`foot${side}`), toe: bone(`toe${side}`), upper: 0, lower: 0 })) as typeof this.legs;
  }

  sample(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) throw new Error("invalid walk stride factor");
    const root = this.root;
    root.updateWorldMatrix(true, true);
    for (const side of [0, 1] as const) {
      const leg = this.legs[side];
      const hip = leg.thigh.getWorldPosition(new THREE.Vector3());
      const knee = leg.shin.getWorldPosition(new THREE.Vector3());
      const ankle = leg.foot.getWorldPosition(new THREE.Vector3());
      const toe = root.worldToLocal(leg.toe.getWorldPosition(new THREE.Vector3()));
      const offset = (toe.z - this.toeStartZ[side]) * (factor - 1);
      leg.upper = hip.distanceTo(knee); leg.lower = knee.distanceTo(ankle);
      const displacement = root.localToWorld(new THREE.Vector3(0, 0, offset)).sub(root.getWorldPosition(new THREE.Vector3()));
      solveAssaultLeg(root, leg, ankle.add(displacement), leg.foot.getWorldQuaternion(new THREE.Quaternion()));
    }
  }
}
