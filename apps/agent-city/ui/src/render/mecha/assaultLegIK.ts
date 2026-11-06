import * as THREE from "three";

export type AssaultLegChain = { thigh: THREE.Object3D; shin: THREE.Object3D; foot: THREE.Object3D; upper: number; lower: number };

const position = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3());
const rotation = (object: THREE.Object3D) => object.getWorldQuaternion(new THREE.Quaternion());

export function setAssaultWorldRotation(root: THREE.Object3D, object: THREE.Object3D, quaternion: THREE.Quaternion): void {
  if (!object.parent) throw new Error("missing joint parent");
  const parentRotation = object.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  object.quaternion.copy(parentRotation.multiply(quaternion));
  root.updateMatrixWorld(true);
}

export function reachableAssaultDown(hip: THREE.Vector3, ankle: THREE.Vector3, upper: number, lower: number, requested: number, knee?: THREE.Vector3): number {
  if (![hip.x, hip.y, hip.z, ankle.x, ankle.y, ankle.z, upper, lower, requested, ...(knee ? [knee.x, knee.y, knee.z] : [])].every(Number.isFinite) || upper <= 0 || lower <= 0 || requested < 0) throw new Error("invalid leg reach parameters");
  const x = ankle.x - hip.x, y = ankle.y - hip.y, z = ankle.z - hip.z;
  const horizontal = x * x + z * z;
  const margin = Math.max(1e-5, (upper + lower) * 1e-6);
  let outer = upper + lower - margin;
  const inner = Math.abs(upper - lower) + margin;
  const distance = Math.hypot(x, y, z);
  if (distance >= outer || distance <= inner || horizontal >= outer * outer) return 0;
  if (knee) {
    if (Math.abs(knee.distanceTo(hip) - upper) > Math.max(1e-6, upper * 1e-5) || Math.abs(knee.distanceTo(ankle) - lower) > Math.max(1e-6, lower * 1e-5)) throw new Error("invalid leg reach knee");
    const direction = ankle.clone().sub(hip).divideScalar(distance);
    const bend = knee.clone().sub(hip);
    bend.addScaledVector(direction, -bend.dot(direction));
    const preserved = Math.min(upper, lower, bend.length() * .5);
    const bentReach = Math.sqrt(Math.max(0, upper * upper - preserved * preserved)) + Math.sqrt(Math.max(0, lower * lower - preserved * preserved));
    outer = Math.max(distance, Math.min(outer, bentReach));
  }
  let limit = y + Math.sqrt(Math.max(0, outer * outer - horizontal));
  if (y > 0 && horizontal < inner * inner) limit = Math.min(limit, y - Math.sqrt(inner * inner - horizontal));
  return Math.max(0, Math.min(requested, limit));
}

export function solveAssaultLeg(root: THREE.Object3D, leg: AssaultLegChain, target: THREE.Vector3, footRotation: THREE.Quaternion, kneeGuide?: { direction: THREE.Vector3; weight: number }): void {
  if (![target.x, target.y, target.z, footRotation.x, footRotation.y, footRotation.z, footRotation.w, leg.upper, leg.lower, ...(kneeGuide ? [kneeGuide.direction.x, kneeGuide.direction.y, kneeGuide.direction.z, kneeGuide.weight] : [])].every(Number.isFinite) || leg.upper <= 0 || leg.lower <= 0 || Math.abs(footRotation.lengthSq() - 1) > 1e-5 || leg.shin.parent !== leg.thigh || leg.foot.parent !== leg.shin || (kneeGuide && (kneeGuide.weight < 0 || kneeGuide.weight > 1))) throw new Error("invalid leg target or chain");
  const hip = position(leg.thigh), direction = target.clone().sub(hip), distance = direction.length();
  if (distance >= leg.upper + leg.lower - 1e-7 || distance <= Math.abs(leg.upper - leg.lower) + 1e-7) throw new Error("unreachable ankle target");
  direction.divideScalar(distance);
  const kneeHint = position(leg.shin).sub(hip);
  const bend = kneeHint.addScaledVector(direction, -kneeHint.dot(direction));
  if (bend.lengthSq() < 1e-12) throw new Error("ambiguous knee direction");
  bend.normalize();
  if (kneeGuide && kneeGuide.weight > 0) {
    const guide = kneeGuide.direction.clone().addScaledVector(direction, -kneeGuide.direction.dot(direction));
    if (guide.lengthSq() < 1e-12) throw new Error("ambiguous knee guide");
    bend.lerp(guide.normalize(), kneeGuide.weight);
    if (bend.lengthSq() < 1e-12) throw new Error("opposed knee guide");
    bend.normalize();
  }
  const along = (leg.upper ** 2 - leg.lower ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, leg.upper ** 2 - along ** 2));
  const knee = hip.clone().addScaledVector(direction, along).addScaledVector(bend, height);
  const rotateToward = (joint: THREE.Object3D, child: THREE.Object3D, desired: THREE.Vector3) => {
    const current = position(child).sub(position(joint)).normalize();
    const correction = new THREE.Quaternion().setFromUnitVectors(current, desired.clone().normalize());
    setAssaultWorldRotation(root, joint, correction.multiply(rotation(joint)));
  };
  rotateToward(leg.thigh, leg.shin, knee.clone().sub(hip));
  rotateToward(leg.shin, leg.foot, target.clone().sub(knee));
  setAssaultWorldRotation(root, leg.foot, footRotation);
}
