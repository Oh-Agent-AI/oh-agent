import * as THREE from "three";

export type GroundHeight = (x: number, z: number) => number;

export function assaultGroundOrientation(
  x: number, z: number, yaw: number, height: GroundHeight, sampleRadius: number, maxGrade: number,
): THREE.Quaternion {
  if (![x, z, yaw, sampleRadius, maxGrade].every(Number.isFinite) || sampleRadius <= 0 || maxGrade < 0) throw new Error("invalid ground orientation parameters");
  const values = [height(x - sampleRadius, z), height(x + sampleRadius, z), height(x, z - sampleRadius), height(x, z + sampleRadius)];
  if (!values.every(Number.isFinite)) throw new Error("invalid ground height");
  const dx = (values[1]! - values[0]!) / (2 * sampleRadius), dz = (values[3]! - values[2]!) / (2 * sampleRadius);
  if (Math.hypot(dx, dz) > maxGrade) throw new Error("ground grade exceeds supported limit");
  const normal = new THREE.Vector3(-dx, 1, -dz).normalize();
  const align = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  return align.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
}
