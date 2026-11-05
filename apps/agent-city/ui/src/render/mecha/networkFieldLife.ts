import * as THREE from "three";

/** Bounded presentation-only network, independent of tactical links. */
export function createNetworkFieldLife(id: "swarm_mantle" | "neural_weaver" | "field_sovereign") {
  const root = new THREE.Group(); root.name = `life-field-${id}`;
  const nodes: THREE.Vector3[] = [], edges: number[] = [];
  const add = (a: THREE.Vector3, b: THREE.Vector3) => edges.push(...a.toArray(), ...b.toArray());
  if (id === "field_sovereign") {
    for (let i = 0; i < 16; i++) {
      const x = i & 1 ? 1 : -1, y = i & 2 ? 1 : -1, z = i & 4 ? 1 : -1, w = i & 8 ? 1 : -1;
      const q = 3.8 / (3.4 - w * .65 - x * .28);
      nodes.push(new THREE.Vector3(x*q, y*q, z*q));
    }
    for (let i = 0; i < 16; i++) for (let b = 1; b <= 8; b *= 2) if (!(i & b)) add(nodes[i]!, nodes[i | b]!);
  } else {
    if (id === "neural_weaver") nodes.push(new THREE.Vector3());
    for (let i = 0; i < 24; i++) {
      const a = i * 2.399963, y = (i / 23 - .5) * 4.8;
      const r = id === "swarm_mantle" ? 3.1 * Math.sqrt(Math.max(.12, 1 - y*y/9)) : 1.2 + (i % 4) * .65;
      nodes.push(new THREE.Vector3(r*Math.cos(a), id === "swarm_mantle" ? y : r*Math.sin(a), id === "swarm_mantle" ? r*Math.sin(a) : Math.sin(i*2.1)*1.4));
    }
    if (id === "neural_weaver") for (let i = 1; i < nodes.length; i++) add(nodes[i]!, nodes[i < 6 ? 0 : 1 + Math.floor((i-6)/2)]!);
    else for (let i = 0; i < nodes.length; i++) {
      const nearest = nodes.map((p,j) => ({j, d:p.distanceToSquared(nodes[i]!)})).filter(x => x.j !== i).sort((a,b) => a.d-b.d).slice(0,3);
      for (const n of nearest) if (i < n.j) add(nodes[i]!, nodes[n.j]!);
    }
  }
  const color = id === "swarm_mantle" ? 0xffe46a : id === "neural_weaver" ? 0x67f4d0 : 0xf5a4eb;
  const lineGeometry = new THREE.BufferGeometry(); lineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edges, 3));
  const lineMaterial = new THREE.LineBasicMaterial({color, transparent:true, opacity:.32, depthWrite:false});
  const wire = new THREE.LineSegments(lineGeometry,lineMaterial); wire.raycast = () => {}; root.add(wire);
  const pointGeometry = new THREE.BufferGeometry(); pointGeometry.setAttribute("position", new THREE.Float32BufferAttribute(nodes.flatMap(p => p.toArray()), 3));
  const pointMaterial = new THREE.PointsMaterial({color, size:.22, transparent:true, opacity:.85, depthWrite:false, blending:THREE.AdditiveBlending});
  const points = new THREE.Points(pointGeometry,pointMaterial); points.raycast = () => {}; root.add(points);
  // Signals travel along the network instead of flashing all nodes together.
  const signalPositions = new Float32Array(edges.length / 2);
  const signalGeometry = new THREE.BufferGeometry();
  signalGeometry.setAttribute("position", new THREE.BufferAttribute(signalPositions, 3));
  const signalMaterial = new THREE.PointsMaterial({ color, size: .38, transparent: true, opacity: .85, depthWrite: false });
  const signals = new THREE.Points(signalGeometry, signalMaterial); signals.raycast = () => {}; root.add(signals);
  function updateSignals(t: number) {
    for (let i = 0; i < edges.length / 6; i++) {
      const f = (t * .22 + i * .381966) % 1;
      for (let axis = 0; axis < 3; axis++) signalPositions[i * 3 + axis] = edges[i * 6 + axis]! * (1 - f) + edges[i * 6 + 3 + axis]! * f;
    }
    signalGeometry.attributes.position!.needsUpdate = true;
  }
  updateSignals(0);
  let disposed = false;
  return {root, update(elapsed:number, reducedMotion:boolean) {
    if (disposed || reducedMotion) return;
    const t = elapsed; wire.rotation.y = t * (id === "field_sovereign" ? .13 : .06); points.rotation.y = wire.rotation.y; signals.rotation.y = wire.rotation.y; updateSignals(t);
    if (id === "swarm_mantle") { const s = 1 + .08*Math.sin(t*.8); wire.scale.setScalar(s); points.scale.setScalar(s); signals.scale.setScalar(s); }
    pointMaterial.opacity = .65 + .2*Math.sin(t*1.6);
  }, dispose() { if (disposed) return; disposed = true; root.removeFromParent(); lineGeometry.dispose(); pointGeometry.dispose(); signalGeometry.dispose(); lineMaterial.dispose(); pointMaterial.dispose(); signalMaterial.dispose(); }};
}
