/** Padded per-mech picking for the airport apron, without claiming nearer objects. */
import * as THREE from "three";

export const PARKED_MECHA_PICK_PAD = 8;
const scratch = new THREE.Vector3();
const padded = new THREE.Box3();

export type MechaPickHit = { distance: number; point: THREE.Vector3; airportLandmark: boolean; protectedAirportStructure?: boolean };

export function parkedMechaPickBoxes(squad: THREE.Object3D): THREE.Box3[] {
  squad.updateWorldMatrix(true, true);
  const boxes: THREE.Box3[] = [];
  for (const child of squad.children) {
    const box = new THREE.Box3().setFromObject(child);
    if (!box.isEmpty() && box.min.toArray().concat(box.max.toArray()).every(Number.isFinite)) boxes.push(box);
  }
  return boxes;
}

function entryDistance(ray: THREE.Ray, box: THREE.Box3): number | null {
  const point = ray.intersectBox(box, scratch);
  return point ? ray.origin.distanceTo(point) : null;
}

export function claimParkedMechaClick({ boxes, ray, hit }: {
  boxes: readonly THREE.Box3[]; ray: THREE.Ray; hit: MechaPickHit | null;
}): boolean {
  if (!boxes.length || ray.direction.lengthSq() < 1e-12) return false;
  if (hit?.protectedAirportStructure) return false;
  for (const box of boxes) {
    padded.copy(box).expandByScalar(PARKED_MECHA_PICK_PAD);
    if (hit?.airportLandmark && padded.containsPoint(hit.point)) return true;
    const throughBody = entryDistance(ray, box);
    if (throughBody !== null && (!hit || throughBody <= hit.distance + 1e-2)) return true;
    if (!hit && entryDistance(ray, padded) !== null) return true;
  }
  return false;
}
