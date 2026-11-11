import * as THREE from "three";
import type { SolidInput } from "../driving/CollisionIndex";

const COLOR = 0x72f0c4;

/** Visualizes the exact compiled collision inputs, never model-derived bounds. */
export class CreatorColliderDebugVisuals {
  readonly root = new THREE.Group();
  private readonly material = new THREE.LineBasicMaterial({ color: COLOR, transparent: true, opacity: 0.95, depthTest: false });

  constructor(solids: readonly SolidInput[]) {
    this.root.name = "creator-collider-debug-visuals";
    this.root.renderOrder = 10_000;
    for (const solid of solids) {
      if (solid.kind !== "box") continue;
      const points: number[] = [];
      const vertex = (bits: number): Readonly<{ x: number; y: number; z: number }> => {
        const sx = bits & 1 ? 1 : -1, sy = bits & 2 ? 1 : -1, sz = bits & 4 ? 1 : -1;
        return { x: solid.center.x + solid.halfAxes[0].x * sx + solid.halfAxes[1].x * sy + solid.halfAxes[2].x * sz,
          y: solid.center.y + solid.halfAxes[0].y * sx + solid.halfAxes[1].y * sy + solid.halfAxes[2].y * sz,
          z: solid.center.z + solid.halfAxes[0].z * sx + solid.halfAxes[1].z * sy + solid.halfAxes[2].z * sz };
      };
      for (let bits = 0; bits < 8; bits++) for (const axis of [1, 2, 4]) {
        if (bits & axis) continue;
        const a = vertex(bits), b = vertex(bits | axis);
        points.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      const lines = new THREE.LineSegments(geometry, this.material);
      lines.name = solid.id;
      lines.renderOrder = 10_001;
      this.root.add(lines);
    }
  }

  dispose(): void {
    this.root.traverse(object => { if (object instanceof THREE.LineSegments) object.geometry.dispose(); });
    this.material.dispose();
    this.root.clear();
  }
}
