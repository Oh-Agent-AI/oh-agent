import * as THREE from "three";

/** Bounded presentation-only streamlines or asymmetric crystalline branches. */
export function createFlowCrystalForm(species: "flux_lancer" | "prism_warden") {
  const root = new THREE.Group(); root.name = `procedural-${species}`;
  const vertices: number[] = [];
  const segment = (a: number[], b: number[]) => vertices.push(...a, ...b);
  if (species === "flux_lancer") {
    for (const side of [-1, 1]) for (let lane = 0; lane < 9; lane++) {
      const sample = (t: number) => {
        const angle = t * Math.PI * 3.4 + lane * .47, radius = (1 - t) * (1.1 + lane * .12);
        return [side * (1 + 3.4 * t), radius * Math.cos(angle) + .6 * Math.sin(Math.PI * t), radius * Math.sin(angle)];
      };
      for (let i = 0; i < 56; i++) segment(sample(i / 56), sample((i + 1) / 56));
    }
  } else {
    const dirs: [number,number,number][] = [[1,.25,.15],[-.8,.4,.5],[.2,.9,-.35],[-.25,-.95,.2],[.65,-.35,-.65],[-.5,-.35,-.75],[.2,.3,.9]];
    dirs.forEach((direction, index) => {
      const axis = new THREE.Vector3(...direction).normalize();
      const side = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 0, 1)).normalize();
      const other = new THREE.Vector3().crossVectors(axis, side).normalize();
      const length = 2.2 + (index % 3) * .48, width = .3 + (index % 2) * .12;
      const base = axis.clone().multiplyScalar(.65), tip = axis.clone().multiplyScalar(length);
      const corners = [side, other, side.clone().negate(), other.clone().negate()].map(v => base.clone().addScaledVector(v, width));
      for (let i = 0; i < 4; i++) { segment(corners[i]!.toArray(), corners[(i + 1) % 4]!.toArray()); segment(corners[i]!.toArray(), tip.toArray()); }
    });
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  const material = new THREE.LineBasicMaterial({ color: species === "flux_lancer" ? 0xffa653 : 0x8afaff, transparent: true, opacity: .72, depthWrite: false, blending: THREE.AdditiveBlending });
  const lines = new THREE.LineSegments(geometry, material); lines.raycast = () => {}; root.add(lines);
  let disposed = false, elapsed = 0;
  return { root, update(dt: number, reducedMotion: boolean) {
    if (disposed || reducedMotion) return;
    elapsed += Math.max(0, Math.min(.1, Number.isFinite(dt) ? dt : 0));
    if (species === "flux_lancer") lines.rotation.x = .18 * Math.sin(elapsed * .7);
    material.opacity = .55 + .17 * (1 + Math.sin(elapsed * 1.2)) / 2;
  }, dispose() { if (disposed) return; disposed = true; root.removeFromParent(); geometry.dispose(); material.dispose(); root.clear(); } };
}
