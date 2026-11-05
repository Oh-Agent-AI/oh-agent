/** Default legacy Boss body. Purely visual: this is not a monster species. */
import * as THREE from "three";

export function createLegacyBossOrnament() {
  const root = new THREE.Group();
  root.name = "legacy-boss-geometric-body";
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    // A listener on one resource must not prevent the other resources being freed.
    for (const resource of [...geometries, ...materials]) {
      try { resource.dispose(); } catch { /* Continue releasing owned resources. */ }
    }
  };
  try {
    const rodGeometry = new THREE.CylinderGeometry(1, 1, 1, 6); geometries.push(rodGeometry);
    const nodeGeometry = new THREE.OctahedronGeometry(1, 0); geometries.push(nodeGeometry);
    const ringGeometry = new THREE.TorusGeometry(1, 0.035, 6, 48); geometries.push(ringGeometry);
    const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x44cfcf, emissive: 0x087c91, emissiveIntensity: 0.65, metalness: 0.3, roughness: 0.38 }); materials.push(frameMaterial);
    const coreMaterial = new THREE.MeshStandardMaterial({ color: 0x9b77ed, emissive: 0x3a1c87, emissiveIntensity: 0.8, metalness: 0.18, roughness: 0.35, flatShading: true }); materials.push(coreMaterial);
    const lightMaterial = new THREE.MeshBasicMaterial({ color: 0xc5ffef }); materials.push(lightMaterial);
    const body = new THREE.Group(); body.position.y = 4.5; root.add(body);
    const frame = new THREE.Group(); frame.rotation.set(0.3, 0.35, 0.2); body.add(frame);
    const vertices: THREE.Vector3[][] = [];
    // Nested cubes and their correspondences evoke a 4D hypercube projection,
    // without implying a species, collision volume or rule footprint.
    for (const size of [3.15, 1.65]) {
      const cube: THREE.Vector3[] = [];
      for (let i = 0; i < 8; i++) {
        const point = new THREE.Vector3(i & 1 ? size : -size, i & 2 ? size : -size, i & 4 ? size : -size);
        cube.push(point);
        const node = new THREE.Mesh(nodeGeometry, lightMaterial); node.name = "legacy-geometry-node";
        node.position.copy(point); node.scale.setScalar(size > 2 ? 0.23 : 0.16); frame.add(node);
      }
      vertices.push(cube);
    }
    const rod = (a: THREE.Vector3, b: THREE.Vector3, width: number) => {
      const direction = b.clone().sub(a);
      const mesh = new THREE.Mesh(rodGeometry, frameMaterial); mesh.name = "legacy-geometry-edge";
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
      mesh.scale.set(width, direction.length(), width); frame.add(mesh);
    };
    for (const cube of vertices) for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) {
      if (!(i & bit)) rod(cube[i]!, cube[i | bit]!, 0.075);
    }
    for (let i = 0; i < 8; i++) rod(vertices[0]![i]!, vertices[1]![i]!, 0.055);
    const core = new THREE.Mesh(nodeGeometry, coreMaterial); core.name = "legacy-geometry-core";
    core.scale.set(1.2, 1.7, 1.2); body.add(core);
    const ring = new THREE.Mesh(ringGeometry, lightMaterial); ring.name = "legacy-geometry-orbit";
    ring.rotation.set(1.15, 0.25, 0); ring.scale.setScalar(4.35); body.add(ring);
    let elapsed = 0;
    return {
      root,
      update(dt: number, reducedMotion = false) {
        if (disposed) return;
        if (reducedMotion) elapsed = 0;
        else if (Number.isFinite(dt) && dt > 0) elapsed += Math.min(dt, 0.1);
        frame.rotation.set(0.3 + elapsed * 0.12, 0.35 + elapsed * 0.2, 0.2);
        ring.rotation.set(1.15, 0.25, -elapsed * 0.13);
      },
      dispose: cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
