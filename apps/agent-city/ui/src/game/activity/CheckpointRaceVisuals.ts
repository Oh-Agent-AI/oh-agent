import * as THREE from "three";
import { m as worldUnits } from "../../engine/worldScale";

export class CheckpointRaceVisuals {
  readonly root = new THREE.Group();
  private readonly rings: THREE.Mesh[] = [];
  private disposed = false;

  constructor(checkpoints: readonly Readonly<{ x: number; y: number; z: number; radius: number; facingRadians: number }>[]) {
    this.root.name = "city-sdk-checkpoint-race";
    checkpoints.forEach((checkpoint, index) => {
      const radius = Math.max(2.2, Math.min(5, worldUnits(checkpoint.radius) * 0.72));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.18, 8, 32), new THREE.MeshBasicMaterial({
        color: 0x4fd8ff, transparent: true, opacity: 0.8, depthWrite: false,
      }));
      ring.name = `city-sdk-checkpoint-${index + 1}`;
      ring.rotation.y = checkpoint.facingRadians;
      ring.position.set(worldUnits(checkpoint.x), worldUnits(checkpoint.y) + 1.8, worldUnits(checkpoint.z));
      ring.renderOrder = 6;
      this.root.add(ring);
      this.rings.push(ring);

      const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.2, 8), new THREE.MeshBasicMaterial({
        color: 0x4fd8ff, transparent: true, opacity: 0.45, depthWrite: false,
      }));
      beacon.position.set(ring.position.x, ring.position.y + 1.5, ring.position.z);
      beacon.renderOrder = 5;
      this.root.add(beacon);
    });
    this.setProgress(0);
  }

  setProgress(completed: number): void {
    if (this.disposed) return;
    this.rings.forEach((ring, index) => {
      const material = ring.material as THREE.MeshBasicMaterial;
      material.color.set(index < completed ? 0x72e5a0 : index === completed ? 0xffd166 : 0x4fd8ff);
      material.opacity = index < completed ? 0.62 : index === completed ? 1 : 0.48;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => material.dispose());
    });
    this.root.clear(); this.rings.length = 0;
  }
}
