import * as THREE from "three";
import { AssaultFootGrounding } from "./assaultFootGrounding";
import { AssaultContactSampler } from "./assaultContact";
import { assaultGroundOrientation, type GroundHeight } from "./assaultGround";
import type { MechaGlbAsset } from "./glbModels";

export type AssaultPreviewGround = { height: GroundHeight; terrain: GroundHeight; radius: number; maxGrade: number; maxDrop: number; asset: MechaGlbAsset };

export class AssaultGroundController {
  private readonly grounding: AssaultFootGrounding;
  private readonly contacts: AssaultContactSampler;
  private readonly root: THREE.Object3D;
  private readonly ground: AssaultPreviewGround;
  constructor(root: THREE.Object3D, ground: AssaultPreviewGround) {
    if (![ground.radius, ground.maxGrade, ground.maxDrop].every(Number.isFinite) || ground.radius <= 0 || ground.maxGrade < 0 || ground.maxDrop < 0) throw new Error("invalid Assault ground parameters");
    this.root = root;
    this.ground = ground;
    this.grounding = new AssaultFootGrounding(root, ground.asset);
    this.contacts = new AssaultContactSampler(root, ground.asset);
  }

  heading(): number {
    const { root, ground } = this;
    const slope = assaultGroundOrientation(root.position.x, root.position.z, 0, ground.terrain, ground.radius, ground.maxGrade);
    const yaw = slope.invert().multiply(root.quaternion);
    return Math.atan2(2 * (yaw.w * yaw.y + yaw.x * yaw.z), 1 - 2 * (yaw.y * yaw.y + yaw.z * yaw.z));
  }

  align(yaw: number, lift = 0, pitch = 0): void {
    const { root, ground } = this;
    if (root.parent) {
      root.parent.updateWorldMatrix(true, false);
      if (!root.parent.matrixWorld.equals(new THREE.Matrix4())) throw new Error("Assault ground requires an identity parent transform");
    }
    const y = ground.height(root.position.x, root.position.z);
    if (!Number.isFinite(y)) throw new Error("invalid Assault ground height");
    root.position.y = y + lift;
    root.quaternion.copy(assaultGroundOrientation(root.position.x, root.position.z, yaw, ground.terrain, ground.radius, ground.maxGrade));
    if (pitch) root.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
  }

  stand(): void {
    const { root, ground, contacts } = this;
    root.updateWorldMatrix(true, false);
    root.updateMatrixWorld(true);
    const drop = Math.max(0, Math.min(Math.max(ground.maxDrop, .4 * root.scale.x), Math.max(contacts.clearance(0, ground.height), contacts.clearance(1, ground.height))));
    const y = root.position.y;
    root.position.y -= drop;
    try { this.feet(0, 0); }
    catch (error) { root.position.y = y; root.updateMatrixWorld(true); throw error; }
  }

  support(): void {
    const { root, ground, contacts } = this;
    root.updateWorldMatrix(true, false);
    root.updateMatrixWorld(true);
    const drop = Math.max(0, Math.min(contacts.clearance(0, ground.height), contacts.clearance(1, ground.height)));
    if (drop <= 1e-6) return;
    const y = root.position.y;
    const rotations: { bone: THREE.Bone; quaternion: THREE.Quaternion }[] = [];
    root.traverse((object) => {
      if ((object as THREE.Bone).isBone) rotations.push({ bone: object as THREE.Bone, quaternion: object.quaternion.clone() });
    });
    root.position.y -= drop;
    try { this.feet(0, 0); }
    catch (error) {
      root.position.y = y;
      for (const { bone, quaternion } of rotations) bone.quaternion.copy(quaternion);
      root.updateMatrixWorld(true);
      throw error;
    }
  }

  feet(phase: number, maxDrop: number): void {
    this.grounding.sample(phase, this.ground.height, maxDrop);
  }
}
