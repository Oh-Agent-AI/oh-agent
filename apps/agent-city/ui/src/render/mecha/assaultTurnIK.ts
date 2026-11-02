import * as THREE from "three";
import { setAssaultWorldRotation, solveAssaultLeg, type AssaultLegChain } from "./assaultLegIK";

type Leg = AssaultLegChain & { ankle: THREE.Vector3; footRotation: THREE.Quaternion };
type Transform = { object: THREE.Object3D; position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };
const up = new THREE.Vector3(0, 1, 0);
const smooth = (t: number) => t * t * (3 - 2 * t);
const getPosition = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3());
const getRotation = (object: THREE.Object3D) => object.getWorldQuaternion(new THREE.Quaternion());

export class AssaultTurnIK {
  private readonly root: THREE.Object3D;
  private readonly pelvis: THREE.Object3D;
  private readonly rest: Transform[] = [];
  private readonly legs: [Leg, Leg];
  private readonly pivot: THREE.Vector3;
  private readonly up: THREE.Vector3;
  private readonly pelvisPosition: THREE.Vector3;
  private readonly pelvisRotation: THREE.Quaternion;
  private readonly crouch: number;
  private readonly lift: number;

  constructor(root: THREE.Object3D, crouch: number, lift: number) {
    if (![crouch, lift].every((n) => Number.isFinite(n) && n >= 0)) throw new Error("invalid turn dimensions");
    root.updateWorldMatrix(true, true);
    const elements = root.matrixWorld.elements;
    const axes = [0, 4, 8].map((i) => new THREE.Vector3(elements[i], elements[i + 1], elements[i + 2]));
    const scale = axes.map((axis) => axis.length());
    if (!elements.every(Number.isFinite) || scale.some((n) => n <= 0) || Math.max(...scale) - Math.min(...scale) > 1e-5 * scale[0]! || root.matrixWorld.determinant() <= 0 || Math.abs(axes[0]!.dot(axes[1]!)) > 1e-5 * scale[0]! * scale[1]! || Math.abs(axes[0]!.dot(axes[2]!)) > 1e-5 * scale[0]! * scale[2]! || Math.abs(axes[1]!.dot(axes[2]!)) > 1e-5 * scale[1]! * scale[2]!) {
      throw new Error("turn requires a non-sheared, uniformly scaled root");
    }
    this.root = root; this.crouch = crouch; this.lift = lift;
    this.up = up.clone().applyQuaternion(getRotation(root));
    const bone = (name: string) => { const object = root.getObjectByName(name); if (!object || !(object as THREE.Bone).isBone) throw new Error(`missing turn bone ${name}`); return object; };
    this.pelvis = bone("pelvis");
    this.pivot = getPosition(root); this.pelvisPosition = getPosition(this.pelvis); this.pelvisRotation = getRotation(this.pelvis);
    root.traverse((object) => { if ((object as THREE.Bone).isBone) this.rest.push({ object, position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() }); });
    this.legs = (["L", "R"] as const).map((side) => {
      const thigh = bone(`thigh${side}`), shin = bone(`shin${side}`), foot = bone(`foot${side}`);
      const hip = getPosition(thigh), knee = getPosition(shin), ankle = getPosition(foot);
      return { thigh, shin, foot, ankle, footRotation: getRotation(foot), upper: hip.distanceTo(knee), lower: knee.distanceTo(ankle) };
    }) as [Leg, Leg];
    if (this.legs.some((leg) => !Number.isFinite(leg.upper) || !Number.isFinite(leg.lower) || leg.upper <= 0 || leg.lower <= 0)) throw new Error("invalid leg lengths");
  }

  sample(delta: number, phase: number): void {
    if (!Number.isFinite(delta) || Math.abs(delta) > Math.PI + 1e-8 || !Number.isFinite(phase) || phase < 0 || phase > 1) throw new Error("invalid turn sample");
    for (const value of this.rest) { value.object.position.copy(value.position); value.object.quaternion.copy(value.quaternion); value.object.scale.copy(value.scale); }
    this.root.updateMatrixWorld(true);
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 12) - 1e-10));
    const progress = phase * (steps + 1), segment = Math.min(steps, Math.floor(progress)), t = phase === 1 ? 1 : progress - segment, u = smooth(t);
    const startYaw = delta * Math.min(segment, steps) / steps, endYaw = delta * Math.min(segment + 1, steps) / steps;
    const yaw = startYaw + (endYaw - startYaw) * u;
    const yawRotation = new THREE.Quaternion().setFromAxisAngle(this.up, yaw);
    const crouchPhase = Math.min(1, progress * 2, ((steps + 1) - progress) * 2);
    const currentPelvis = this.pelvisPosition.clone().addScaledVector(this.up, -this.crouch * smooth(crouchPhase));
    this.pelvis.position.copy(this.pelvis.parent!.worldToLocal(currentPelvis));
    setAssaultWorldRotation(this.root, this.pelvis, yawRotation.clone().multiply(this.pelvisRotation));
    const rotation = (angle: number) => new THREE.Quaternion().setFromAxisAngle(this.up, angle);
    const rotated = (leg: Leg, angle: number) => leg.ankle.clone().sub(this.pivot).applyQuaternion(rotation(angle)).add(this.pivot);
    for (let side = 0; side < 2; side++) {
      const leg = this.legs[side]!;
      const lastSwing = segment - 1 - ((segment - 1 - side + 2) % 2);
      const previousAngle = delta * Math.min(Math.max(lastSwing + 1, 0), steps) / steps;
      const start = rotated(leg, previousAngle), startRot = rotation(previousAngle).multiply(leg.footRotation);
      if (side === segment % 2) {
        const end = rotated(leg, endYaw), endRot = rotation(endYaw).multiply(leg.footRotation);
        start.lerp(end, u).addScaledVector(this.up, this.lift * Math.sin(Math.PI * u));
        solveAssaultLeg(this.root, leg, start, startRot.slerp(endRot, u));
      } else solveAssaultLeg(this.root, leg, start, startRot);
    }
  }
}
