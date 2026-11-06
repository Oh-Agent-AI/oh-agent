import * as THREE from "three";
import { AssaultContactSampler } from "./assaultContact";
import { AssaultGroundController, type AssaultPreviewGround } from "./assaultGroundController";
import { solveAssaultLeg } from "./assaultLegIK";

type BonePose = { bone: THREE.Bone; position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };
export type AssaultPose = { root: THREE.Object3D; position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3; bones: BonePose[] };
type Endpoint = { pose: AssaultPose; ankles: [THREE.Vector3, THREE.Vector3]; rotations: [THREE.Quaternion, THREE.Quaternion]; gaps: [number, number] };
type Bridge = { side: number; target: THREE.Vector3; rotation: THREE.Quaternion; sag: number };

const smooth = (value: number) => value * value * (3 - 2 * value);
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const position = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3());
const rotation = (object: THREE.Object3D) => object.getWorldQuaternion(new THREE.Quaternion()).normalize();

function capturePose(root: THREE.Object3D, normalize: boolean): AssaultPose {
  const bones: BonePose[] = [];
  root.traverse((object) => {
    if ((object as THREE.Bone).isBone) {
      const quaternion = object.quaternion.clone(); if (normalize) quaternion.normalize();
      bones.push({ bone: object as THREE.Bone, position: object.position.clone(), quaternion, scale: object.scale.clone() });
    }
  });
  if (!bones.length) throw new Error("missing Assault pose bones");
  const quaternion = root.quaternion.clone(); if (normalize) quaternion.normalize();
  return { root, position: root.position.clone(), quaternion, scale: root.scale.clone(), bones };
}

export function captureAssaultPose(root: THREE.Object3D): AssaultPose {
  return capturePose(root, true);
}

function restore(pose: AssaultPose): void {
  pose.root.position.copy(pose.position); pose.root.quaternion.copy(pose.quaternion); pose.root.scale.copy(pose.scale);
  for (const value of pose.bones) { value.bone.position.copy(value.position); value.bone.quaternion.copy(value.quaternion); value.bone.scale.copy(value.scale); }
  pose.root.updateMatrixWorld(true);
}

export class AssaultPoseTransition {
  private readonly root: THREE.Object3D;
  private readonly ground: AssaultGroundController;
  private readonly legs: [THREE.Object3D[], THREE.Object3D[]];
  private readonly endpoints: [Endpoint, Endpoint];
  private readonly bridge?: Bridge;
  private readonly swingFirst: number;
  private readonly distances: [number, number];

  constructor(root: THREE.Object3D, from: AssaultPose, to: AssaultPose, ground: AssaultPreviewGround) {
    if (from.root !== root || to.root !== root || from.bones.length !== to.bones.length || from.bones.some((value, i) => value.bone !== to.bones[i]?.bone) || from.scale.distanceTo(to.scale) > 1e-8) throw new Error("incompatible Assault transition poses");
    this.root = root;
    this.ground = new AssaultGroundController(root, ground);
    const contact = new AssaultContactSampler(root, ground.asset);
    this.legs = (["L", "R"] as const).map((side) => ["thigh", "shin", "foot"].map((name) => {
      const bone = root.getObjectByName(`${name}${side}`);
      if (!bone || !(bone as THREE.Bone).isBone) throw new Error(`missing transition bone ${name}${side}`);
      return bone;
    })) as [THREE.Object3D[], THREE.Object3D[]];
    const saved = capturePose(root, false);
    try {
      this.endpoints = [from, to].map((pose) => {
        restore(pose);
        return { pose, ankles: this.legs.map((leg) => position(leg[2]!)) as [THREE.Vector3, THREE.Vector3], rotations: this.legs.map((leg) => rotation(leg[2]!)) as [THREE.Quaternion, THREE.Quaternion], gaps: [contact.clearance(0, ground.height), contact.clearance(1, ground.height)] as [number, number] };
      }) as [Endpoint, Endpoint];
      const [start, end] = this.endpoints;
      this.distances = [0, 1].map((side) => start.ankles[side]!.distanceTo(end.ankles[side]!)) as [number, number];
      this.swingFirst = start.gaps[0] > 1e-4 && start.gaps[1] <= 1e-4 ? 0 : start.gaps[1] > 1e-4 && start.gaps[0] <= 1e-4 ? 1 : this.distances[0] >= this.distances[1] ? 0 : 1;
      const airborne = [0, 1].find((side) => start.gaps[side]! > 1e-4 && end.gaps[side]! > 1e-4 && start.gaps[1 - side]! <= 1e-4 && end.gaps[1 - side]! <= 1e-4);
      if (airborne !== undefined) {
        const target = start.ankles[airborne]!.clone(); target.y -= start.gaps[airborne]!;
        this.bridge = { side: airborne, target, rotation: start.rotations[airborne]!.clone(), sag: Math.max(.12, start.gaps[airborne]! + end.gaps[airborne]! + .05) };
      }
    } finally { restore(saved); }
  }

  sample(phase: number): void {
    if (!Number.isFinite(phase) || phase < 0 || phase > 1) throw new Error("invalid Assault transition phase");
    const saved = capturePose(this.root, false), [start, end] = this.endpoints, u = smooth(phase);
    try {
      this.root.position.lerpVectors(start.pose.position, end.pose.position, u);
      this.root.quaternion.slerpQuaternions(start.pose.quaternion, end.pose.quaternion, u);
      this.root.scale.copy(start.pose.scale);
      if (this.bridge) this.root.position.y -= this.bridge.sag * Math.sin(Math.PI * phase) ** 2;
      for (let i = 0; i < start.pose.bones.length; i++) {
        const a = start.pose.bones[i]!, b = end.pose.bones[i]!, bone = a.bone;
        bone.position.lerpVectors(a.position, b.position, u); bone.quaternion.slerpQuaternions(a.quaternion, b.quaternion, u); bone.scale.lerpVectors(a.scale, b.scale, u);
      }
      this.root.updateMatrixWorld(true);
      for (const side of [0, 1]) {
        const progress = clamp(side === this.swingFirst ? phase * 2 : phase * 2 - 1), eased = smooth(progress);
        let target = start.ankles[side]!.clone().lerp(end.ankles[side]!, eased);
        let footRotation = start.rotations[side]!.clone().slerp(end.rotations[side]!, eased).normalize();
        const lift = Math.min(.3, Math.max(.04, this.distances[side]! * .5));
        if (this.bridge) {
          const third = Math.min(2, Math.floor(phase * 3)), part = clamp(phase * 3 - third), k = smooth(part);
          if (side === this.bridge.side) {
            if (third === 0) { target = start.ankles[side]!.clone().lerp(this.bridge.target, k); footRotation = start.rotations[side]!.clone().slerp(this.bridge.rotation, k).normalize(); }
            else if (third === 1) { target = this.bridge.target.clone(); footRotation = this.bridge.rotation.clone(); }
            else { target = this.bridge.target.clone().lerp(end.ankles[side]!, k); footRotation = this.bridge.rotation.clone().slerp(end.rotations[side]!, k).normalize(); target.y += lift * Math.sin(Math.PI * k); }
          } else {
            const v = third === 0 ? 0 : third === 1 ? k : 1;
            target = start.ankles[side]!.clone().lerp(end.ankles[side]!, v); footRotation = start.rotations[side]!.clone().slerp(end.rotations[side]!, v).normalize();
            if (third === 1) target.y += lift * Math.sin(Math.PI * k);
          }
        } else target.y += lift * Math.sin(Math.PI * eased);
        const [thigh, shin, foot] = this.legs[side]!;
        const hip = position(thigh!), knee = position(shin!), ankle = position(foot!);
        solveAssaultLeg(this.root, { thigh: thigh!, shin: shin!, foot: foot!, upper: hip.distanceTo(knee), lower: knee.distanceTo(ankle) }, target, footRotation);
      }
      this.ground.feet(0, 0); this.ground.support(); this.root.updateMatrixWorld(true);
    } catch (error) { restore(saved); throw error; }
  }
}
