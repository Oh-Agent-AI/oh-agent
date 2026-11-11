import * as THREE from "three";

/** Stylized accretion flow; local presentation only. */
export function createGravityAccretion(): { root: THREE.Group; update(dt: number, reducedMotion: boolean): void; dispose(): void } {
  const root = new THREE.Group();
  root.name = "gravity-accretion";
  const count = 1800;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = ((i * 719) % count) / count;
    const v = ((i * 389) % count) / count;
    const radius = 1.8 + 2.5 * Math.sqrt(u);
    const angle = Math.PI * 2 * v + 1.7 * Math.log(radius);
    positions[i * 3] = radius * Math.cos(angle);
    positions[i * 3 + 1] = .12 * Math.sin(angle * 3 + radius * 4);
    positions[i * 3 + 2] = radius * Math.sin(angle);
    const hot = 1 - u;
    colors[i * 3] = .35 + .65 * hot;
    colors[i * 3 + 1] = .55 + .32 * hot;
    colors[i * 3 + 2] = 1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({ size: .065, vertexColors: true, transparent: true, opacity: .48, depthWrite: false, blending: THREE.NormalBlending });
  const disk = new THREE.Points(geometry, material);
  disk.raycast = () => {};
  disk.rotation.x = .38;
  root.add(disk);
  let disposed = false;
  return {
    root,
    update(dt, reducedMotion) { if (!disposed && !reducedMotion) disk.rotation.y += Math.min(Math.max(dt, 0), .1) * .18; },
    dispose() { if (disposed) return; disposed = true; geometry.dispose(); material.dispose(); root.clear(); },
  };
}
