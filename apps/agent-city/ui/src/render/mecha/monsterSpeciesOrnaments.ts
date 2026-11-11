/** Independent, bounded geometric lifeforms. Coordinates are model-local;
 * they are presentation only and carry no rule, footprint or picking data. */
import * as THREE from "three";
import { createOrganicLife } from "./organicLife";
import { createFlowCrystalForm } from "./flowCrystalForms";
import { createNetworkFieldLife } from "./networkFieldLife";
import { createPhaseInterference } from "./phaseInterference";
import { createGravityAccretion } from "./gravityAccretion";
import { samplePorousGyroid } from "./porousGyroid";

type SpeciesId = "spore_leaper" | "flux_lancer" | "porous_shaper" | "prism_warden" | "swarm_mantle" | "phase_stalker" | "gravity_core" | "neural_weaver" | "many_core" | "field_sovereign";
type OrnamentRole = "Boss" | "Raider";
type SpeciesOrnament = { readonly root: THREE.Group; update(dt: number, reducedMotion: boolean): void; dispose(): void };
type Palette = readonly [number, number, number];
const PALETTES: Readonly<Record<SpeciesId, Palette>> = {
  spore_leaper: [0x98e745, 0x257b67, 0xe0ffac],
  flux_lancer: [0xff803b, 0x8d3134, 0xffe5a0],
  porous_shaper: [0xd9b478, 0x76543d, 0xffe7b0],
  prism_warden: [0x48d5e8, 0x156578, 0xc9ffff],
  swarm_mantle: [0xf3d44c, 0x3f6678, 0xfff7ac],
  phase_stalker: [0xc37cf6, 0x412678, 0xf4c9ff],
  gravity_core: [0x6b98fa, 0x171f50, 0xc6dcff],
  neural_weaver: [0x52dcb8, 0x176f79, 0xe2ffb7],
  many_core: [0xfa7189, 0x853855, 0xffd7af],
  field_sovereign: [0xf18ad5, 0x803980, 0xffdd87],
};
export function isMonsterSpeciesDesign(id: unknown): id is SpeciesId {
  return typeof id === "string" && Object.hasOwn(PALETTES, id);
}

type Shape = "sphere" | "crystal" | "tetra" | "box" | "ring" | "rod" | "cone";
type Vec = readonly [number, number, number];

/** Owns every geometry/material even if construction throws. The rig is never owned. */
export function createMonsterSpeciesOrnament(id: string, role: OrnamentRole): SpeciesOrnament {
  if (!isMonsterSpeciesDesign(id)) throw new Error("unknown monster species visual");
  if (role !== "Boss" && role !== "Raider") throw new Error("unknown monster rig role");
  const geometries = new Map<Shape, THREE.BufferGeometry>();
  const materials: THREE.Material[] = [];
  const extraGeometries: THREE.BufferGeometry[] = [];
  const root = new THREE.Group(); root.name = `monster-species-${id}`;
  // Raider uses the same independent design at half the Boss dimensions.
  const baseScale = role === "Boss" ? 1 : 0.5;
  root.scale.setScalar(baseScale);
  const body = new THREE.Group(); body.position.y = 4.5; root.add(body);
  const rotating: Array<{ group: THREE.Group; speed: number; x: number; y: number; z: number }> = [];
  let elapsed = 0, disposed = false;
  try {
    const [primary, dark, light] = PALETTES[id];
    const solid = new THREE.MeshPhysicalMaterial({ color: primary, emissive: primary, emissiveIntensity: 0.34, roughness: 0.22, metalness: 0.12, clearcoat: 0.8, clearcoatRoughness: 0.16, flatShading: true });
    const shade = new THREE.MeshPhysicalMaterial({ color: dark, emissive: id === "spore_leaper" || id === "many_core" ? primary : dark, emissiveIntensity: id === "spore_leaper" || id === "many_core" ? 0.42 : 0.3, roughness: 0.27, metalness: 0.08, clearcoat: 0.75, clearcoatRoughness: 0.2, flatShading: true });
    const glow = new THREE.MeshBasicMaterial({ color: light });
    materials.push(solid, shade, glow);
    const mats = [solid, shade, glow];
    function geometry(shape: Shape): THREE.BufferGeometry {
      let g = geometries.get(shape);
      if (g) return g;
      switch (shape) {
        case "sphere": g = new THREE.IcosahedronGeometry(1, 1); break;
        case "crystal": g = new THREE.OctahedronGeometry(1, 0); break;
        case "tetra": g = new THREE.TetrahedronGeometry(1, 0); break;
        case "box": g = new THREE.BoxGeometry(1, 1, 1); break;
        case "ring": g = new THREE.TorusGeometry(1, 0.012, 6, 32); break;
        case "rod": g = new THREE.CylinderGeometry(1, 1, 1, 5); break;
        case "cone": g = new THREE.ConeGeometry(1, 1, 5); break;
      }
      geometries.set(shape, g); return g;
    }
    function piece(parent: THREE.Object3D, shape: Shape, material: number, pos: Vec, scale: Vec, rotation: Vec = [0, 0, 0]): THREE.Mesh {
      const mesh = new THREE.Mesh(geometry(shape), mats[material]!);
      mesh.name = `species-${shape}`; mesh.position.set(...pos); mesh.scale.set(...scale); mesh.rotation.set(...rotation);
      parent.add(mesh); return mesh;
    }
    function rod(parent: THREE.Object3D, a: Vec, b: Vec, width: number, material: number) {
      const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), direction = end.clone().sub(start);
      const mesh = piece(parent, "rod", material, [0, 0, 0], [width, direction.length(), width]);
      mesh.position.copy(start.add(end).multiplyScalar(0.5));
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    }
    function orbit(speed: number, rotation: Vec = [0, 0, 0]) {
      const group = new THREE.Group(); group.rotation.set(...rotation); body.add(group);
      rotating.push({ group, speed, x: rotation[0], y: rotation[1], z: rotation[2] }); return group;
    }
    function ring(parent: THREE.Object3D, radius: number, material: number, rotation: Vec, pos: Vec = [0, 0, 0]) {
      return piece(parent, "ring", material, pos, [radius, radius, radius], rotation);
    }
    function boxFrame(parent: THREE.Object3D, size: number, material: number, width: number) {
      const h = size / 2;
      for (const x of [-h, h]) for (const y of [-h, h]) rod(parent, [x,y,-h], [x,y,h], width, material);
      for (const x of [-h, h]) for (const z of [-h, h]) rod(parent, [x,-h,z], [x,h,z], width, material);
      for (const y of [-h, h]) for (const z of [-h, h]) rod(parent, [-h,y,z], [h,y,z], width, material);
    }
    switch (id) {
      case "spore_leaper": {
        piece(body,"sphere",0,[0,0,0],[2.45,2.25,2.1]);
        for (const [x,y,z,r] of [[-3,0.7,0.2,1.55],[2.9,0.6,0.4,1.4],[-1.65,2.5,-0.2,1.15],[1.25,2.9,-0.35,1.05],[0,-2.05,0.6,1.1]] as const) {
          piece(body,"sphere",1,[x,y,z],[r,r,r]); piece(body,"sphere",2,[x,y,z-r*.68],[r*.3,r*.3,r*.3]);
        }
        ring(orbit(.22,[1.15,0,.15]),4.35,2,[0,0,0]); break;
      }
      case "flux_lancer": {
        piece(body,"crystal",0,[0,0,0],[1.65,3.35,1.45]);
        piece(body,"crystal",2,[0,0,-1.4],[.48,2.55,.48]);
        for (const x of [-1,1]) {
          piece(body,"crystal",1,[x*3.0,.4,0],[1.55,2.25,.8],[0,0,x*-.72]);
          piece(body,"crystal",0,[x*4.25,-.7,0],[.65,1.65,.55],[0,0,x*-.95]);
        }
        ring(orbit(-.28,[.75,0,0]),2.8,2,[0,0,0]); break;
      }
      case "porous_shaper": {
        // Stable, raycastable proxy; the luminous surface added below is
        // visual-only and does not change the 2x2 rule footprint.
        piece(body,"sphere",1,[0,0,0],[3.6,3.6,3.6]);
        break;
      }
      case "prism_warden": {
        const shell = orbit(.2,[0,.25,.15]);
        const top: Vec = [0,4,0], bottom: Vec = [0,-4,0];
        const eq: Vec[] = [[-3,0,0],[0,0,-3],[3,0,0],[0,0,3]];
        for (let i=0;i<4;i++) { rod(shell,top,eq[i]!, .13,0); rod(shell,bottom,eq[i]!, .13,0); rod(shell,eq[i]!,eq[(i+1)%4]!, .13,0); }
        piece(body,"crystal",2,[0,0,0],[1.25,2.05,1.25]);
        piece(body,"crystal",1,[0,0,.35],[1.7,2.6,1.7]);
        ring(body,3.6,2,[Math.PI/2,0,0]); break;
      }
      case "swarm_mantle": {
        piece(body,"sphere",1,[0,0,0],[1.55,1.55,1.55]);
        piece(body,"sphere",2,[0,0,-1.3],[.58,.58,.58]);
        const shell = orbit(-.19,[.15,.1,.2]);
        for (let i=0;i<8;i++) {
          const a=i*Math.PI/4, x=Math.cos(a)*3.45, y=Math.sin(a)*3.0;
          piece(shell,"tetra",i%2?0:2,[x,y,(i%2?-.7:.7)],[1.2,1.2,1.2],[.2,a,Math.PI/4+a]);
        }
        ring(body,2.35,0,[1.1,0,.2]); break;
      }
      case "phase_stalker": {
        piece(body,"crystal",2,[0,0,0],[.7,2.5,.7]);
        piece(body,"crystal",1,[0,0,.45],[1.25,3.05,1.0]);
        ring(orbit(.26,[.25,.45,.4]),3.65,0,[0,0,0]);
        ring(orbit(-.18,[1.05,-.45,-.35]),3.05,2,[0,0,0]);
        ring(orbit(.12,[-.65,.5,.8]),4.05,1,[0,0,0]);
        for (const x of [-1,1]) piece(body,"crystal",0,[x*3.35,0,0],[.48,1.45,.48],[0,0,x*.35]); break;
      }
      case "gravity_core": {
        piece(body,"sphere",1,[0,0,0],[2.15,2.15,2.15]);
        piece(body,"sphere",0,[0,0,-1.9],[.9,.9,.9]);
        piece(body,"sphere",2,[0,0,-2.6],[.34,.34,.34]);
        ring(orbit(.24,[1.18,0,.15]),3.6,0,[0,0,0]);
        ring(orbit(-.18,[.3,.55,-.4]),4.1,2,[0,0,0]);
        ring(orbit(.12,[-.6,.2,.8]),3.1,0,[0,0,0]); break;
      }
      case "neural_weaver": {
        const nodes: Vec[] = [[0,0,0],[-3,2,0],[3,2,0],[-3,-2,0],[3,-2,0],[0,3.8,.2],[0,-3.6,.2],[-1.8,0,-1.8],[1.8,0,-1.8]];
        for (const i of [1,2,3,4,5,6,7,8]) rod(body,nodes[0]!,nodes[i]!, .14,1);
        for (const [a,b] of [[1,5],[5,2],[3,6],[6,4],[1,3],[2,4]] as const) rod(body,nodes[a]!,nodes[b]!, .1,0);
        nodes.forEach((p,i)=>piece(body,"sphere",i===0?2:0,p,i===0?[1.2,1.2,1.2]:[.72,.72,.72]));
        break;
      }
      case "many_core": {
        for (const [x,y,z,r] of [[-2.8,0,0,1.65],[0,1.35,-.35,1.95],[2.8,0,0,1.65],[0,-2.15,.2,1.2]] as const) {
          piece(body,"sphere",1,[x,y,z],[r,r,r]); piece(body,"crystal",0,[x,y,z-r*.45],[r*.82,r*.82,r*.82]);
          piece(body,"sphere",2,[x,y,z-r*1.1],[r*.28,r*.28,r*.28]);
        }
        ring(orbit(.16,[.9,0,.2]),4.6,0,[0,0,0]); break;
      }
      case "field_sovereign": {
        const outer=orbit(.12,[.18,.45,.15]), inner=orbit(-.2,[.1,-.45,.2]);
        boxFrame(outer,6.3,0,.13); boxFrame(inner,3.0,2,.11);
        for (const x of [-1,1]) for (const y of [-1,1]) for (const z of [-1,1]) rod(body,[x*1.5,y*1.5,z*1.5],[x*3.15,y*3.15,z*3.15],.055,1);
        piece(body,"crystal",2,[0,0,0],[.7,.7,.7]); break;
      }
    }
    // Species-specific energy scaffolds: bounded, non-pickable line geometry
    // keeps their visual identities distinct without adding per-segment objects.
    const traces: number[] = [];
    const emit = (a: Vec, b: Vec) => traces.push(...a, ...b);
    const trace = (count: number, sample: (t: number) => Vec) => {
      for (let i = 0; i < count; i++) emit(sample(i / count), sample((i + 1) / count));
    };
    const loop = (radius: number, tilt: number, z: number, count = 48) => trace(count, t => {
      const a = Math.PI * 2 * t;
      return [radius * Math.cos(a), radius * Math.sin(a) * Math.cos(tilt) + z,
        radius * Math.sin(a) * Math.sin(tilt)];
    });
    switch (id) {
      case "spore_leaper":
        for (const y of [-1.8, 0, 1.8]) loop(3.45 - Math.abs(y) * .35, .32, y);
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4;
          emit([Math.cos(a) * 1.7, 0, Math.sin(a) * 1.7], [Math.cos(a) * 3.6, .9 * Math.sin(a * 2), Math.sin(a) * 3.6]); }
        break;
      case "flux_lancer":
        for (const side of [-1, 1]) for (let lane = 0; lane < 4; lane++) trace(30, t => {
          const x = side * (1 + 3.8 * t); return [x, (lane - 1.5) * .36 + Math.sin(Math.PI * t) * 1.6, Math.sin(Math.PI * t) * (lane - 1.5) * .55];
        }); break;
      case "porous_shaper":
        for (let i = 0; i < 4; i++) loop(2.75 + i * .2, .55 + i * .63, 0);
        break;
      case "prism_warden":
        for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2;
          const b = a + Math.PI / 2;
          emit([Math.cos(a) * 2.2, 0, Math.sin(a) * 2.2], [Math.cos(b) * 2.2, 0, Math.sin(b) * 2.2]);
          emit([Math.cos(a) * 2.2, 0, Math.sin(a) * 2.2], [0, 3.1, 0]);
          emit([Math.cos(a) * 2.2, 0, Math.sin(a) * 2.2], [0, -3.1, 0]); }
        break;
      case "swarm_mantle":
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, b = (i + 3) * Math.PI / 4;
          emit([Math.cos(a) * 3.35, Math.sin(a) * 3, i % 2 ? -.6 : .6], [Math.cos(b) * 3.35, Math.sin(b) * 3, i % 2 ? .6 : -.6]); }
        break;
      case "phase_stalker":
        for (let n = 0; n < 4; n++) trace(96, t => { const a = 4 * Math.PI * t + n * Math.PI / 2;
          return [2.35 * Math.cos(a), (t - .5) * 6.3, 2.35 * Math.sin(a)]; }); break;
      case "gravity_core":
        for (let n = 0; n < 4; n++) loop(2.7 + n * .22, .5 + n * .65, 0);
        break;
      case "neural_weaver":
        for (let n = 0; n < 3; n++) trace(72, t => { const a = 2 * Math.PI * t;
          return [3.2 * Math.cos(a), 2.9 * Math.sin(a), .9 * Math.sin(3 * a + n * Math.PI * 2 / 3)]; }); break;
      case "many_core":
        for (const x of [-2.8, 0, 2.8]) for (const tilt of [.4, 1.4]) trace(48, t => {
          const a = t * Math.PI * 2; return [x + 1.4 * Math.cos(a), 1.4 * Math.sin(a) * Math.cos(tilt), 1.4 * Math.sin(a) * Math.sin(tilt)]; }); break;
      case "field_sovereign":
        for (const axis of [-2, 0, 2]) for (const plane of [0, 1]) for (let i = -2; i <= 2; i++) {
          if (plane === 0) emit([-3, axis, i * 1.5], [3, axis, i * 1.5]);
          else emit([i * 1.5, -3, axis], [i * 1.5, 3, axis]);
        } break;
    }
    const traceGeometry = new THREE.BufferGeometry(); extraGeometries.push(traceGeometry);
    traceGeometry.setAttribute("position", new THREE.Float32BufferAttribute(traces, 3));
    const traceMaterial = new THREE.LineBasicMaterial({ color: light, transparent: true, opacity: .27,
      depthWrite: false, blending: THREE.AdditiveBlending });
    materials.push(traceMaterial);
    const traceMesh = new THREE.LineSegments(traceGeometry, traceMaterial);
    traceMesh.name = "monster-fx-traces"; traceMesh.raycast = () => {};
    traceMesh.visible = id !== "porous_shaper"; body.add(traceMesh);

    // Reveal the internal light through central volumes without making the
    // distinctive outer silhouette transparent or disabling depth testing.
    const translucent = new Map<THREE.Material, THREE.Material>();
    body.traverse(node => {
      if (!(node instanceof THREE.Mesh) || !["species-sphere", "species-crystal"].includes(node.name)
        || node.position.length() > 1.6 || Array.isArray(node.material)) return;
      const original = node.material as THREE.Material;
      let material = translucent.get(original);
      if (!material) {
        const copy = original.clone(); copy.transparent = true;
        copy.opacity = id === "porous_shaper" ? 0 : .23; copy.depthWrite = false;
        translucent.set(original, copy); materials.push(copy); material = copy;
      }
      node.material = material;
    });
    // Deterministic bounded parametric samples: one species-specific energy
    // manifold per draw call. This is visual-only, not an SDF or hitbox.
    const manifoldVertices: number[] = [];
    const manifoldCount = 1200;
    for (let i = 0; i < manifoldCount; i++) {
      const t = i / manifoldCount, u = t * Math.PI * 2;
      const v = ((i * 377) % manifoldCount) / manifoldCount * Math.PI * 2;
      let x = 0, y = 0, z = 0;
      switch (id) {
        case "spore_leaper": { const r = 2.8 + .55 * Math.sin(5 * u) * Math.sin(3 * v);
          x = r * Math.cos(u) * Math.sin(v); y = r * Math.cos(v); z = r * Math.sin(u) * Math.sin(v); break; }
        case "flux_lancer": { const side = i % 2 ? 1 : -1, f = ((i * 97) % manifoldCount) / manifoldCount;
          x = side * (1 + 3.5 * f); y = 2.3 * (t - .5) * (1 - .55 * f); z = .9 * Math.sin(u * 3) * (1 - f) + .4 * Math.sin(v); break; }
        case "porous_shaper": { const r = 2.9 + .35 * Math.sin(7 * u) * Math.cos(5 * v);
          x = r * Math.cos(u) * Math.sin(v); y = r * Math.cos(v); z = r * Math.sin(u) * Math.sin(v); break; }
        case "prism_warden": { const h = 2 * (t - .5), r = (1 - Math.abs(h)) * (2.1 + .8 * ((i % 5) / 4));
          x = r * Math.cos(v); y = h * 3.65; z = r * Math.sin(v); break; }
        case "swarm_mantle": { const a = Math.floor(i / 150) * Math.PI / 4, r = 3.3 + .38 * Math.cos(v);
          x = r * Math.cos(a) + .45 * Math.cos(u); y = r * Math.sin(a) + .45 * Math.sin(u); z = .6 * Math.sin(v); break; }
        case "phase_stalker": { const a = u * 5 + (i % 3) * Math.PI * 2 / 3, r = 1.8 + .35 * Math.sin(v);
          x = r * Math.cos(a); y = 6.3 * (t - .5); z = r * Math.sin(a); break; }
        case "gravity_core": { const r = 1.9 + 1.6 * ((i * 137 % manifoldCount) / manifoldCount);
          x = r * Math.cos(u * 7); z = r * Math.sin(u * 7); y = .38 * Math.sin(v) + .18 * x; break; }
        case "neural_weaver": { const arm = i % 8, a = arm * Math.PI / 4, r = 3.5 * t;
          x = r * Math.cos(a) + .2 * Math.sin(v); y = r * Math.sin(a) + .2 * Math.cos(v); z = .65 * Math.sin(10 * u + arm); break; }
        case "many_core": { const n = i % 4, cx = [-2.8, 0, 2.8, 0][n]!, cy = [0, 1.35, 0, -2.15][n]!;
          const r = .95 + .2 * Math.sin(5 * u); x = cx + r * Math.cos(u) * Math.sin(v);
          y = cy + r * Math.cos(v); z = r * Math.sin(u) * Math.sin(v); break; }
        case "field_sovereign": { const face = i % 3, a = 6 * (t - .5), b = 6 * (((i * 71) % manifoldCount) / manifoldCount - .5);
          x = face === 0 ? Math.sign(Math.sin(u * 9)) * 3 : a;
          y = face === 1 ? Math.sign(Math.sin(u * 9)) * 3 : b;
          z = face === 2 ? Math.sign(Math.sin(u * 9)) * 3 : (face === 0 ? b : a); break; }
      }
      manifoldVertices.push(x, y, z);
    }
    const manifoldGeometry = new THREE.BufferGeometry(); extraGeometries.push(manifoldGeometry);
    manifoldGeometry.setAttribute("position", new THREE.Float32BufferAttribute(manifoldVertices, 3));
    manifoldGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 7);
    const manifoldMaterial = new THREE.ShaderMaterial({
      uniforms: { tint: { value: new THREE.Color(light) }, phase: { value: 0 } },
      vertexShader: `uniform float phase; varying float brightness; varying float distanceFade;
        void main() { float wave = sin(position.x * 4.0 + position.y * 3.0 + phase);
          vec3 p = position * (1.0 + .025 * wave); brightness = .5 + .5 * wave;
          vec4 view = modelViewMatrix * vec4(p, 1.0);
          distanceFade = projectionMatrix[2][3] == 0.0 ? 1.0 : clamp(24.0 / max(1.0, -view.z), .12, 1.0);
          gl_Position = projectionMatrix * view; gl_PointSize = max(1.0, 3.0 * distanceFade); }`,
      fragmentShader: `uniform vec3 tint; varying float brightness; varying float distanceFade;
        void main() { float r = length(gl_PointCoord - vec2(.5));
          if (r > .5) discard; gl_FragColor = vec4(tint, (.18 + .25 * brightness) * (1.0 - r) * distanceFade); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    materials.push(manifoldMaterial);
    const manifold = new THREE.Points(manifoldGeometry, manifoldMaterial);
    manifold.name = "monster-fx-manifold"; manifold.raycast = () => {};
    body.add(manifold);
    // Φ-04-inspired superformula shell: bounded static samples, animated in
    // two bounded GPU point batches rather than sorting thousands of Canvas 2D
    // points on the CPU. This is a parametric surface, not a ray-marched SDF or a
    // simulation of a physical fractal. It remains independent of battle state.
    let organismMaterial: THREE.ShaderMaterial | undefined;
    let organismSurface: THREE.Points | undefined;
    if (id === "porous_shaper") {
      // Reuse the existing 1,200-point manifold budget as interleaved surface
      // samples. This yields a denser folded organism without another draw call
      // or increasing the pre-existing combined point count.
      const longitude = 75, latitude = 49;
      const vertices = new Float32Array(2400 * 3), parameters = new Float32Array(2400 * 2);
      const innerVertices = new Float32Array(1200 * 3), innerParameters = new Float32Array(1200 * 2);
      function superformula(angle: number, m: number, n1: number, n2: number, n3: number) {
        return Math.pow(Math.pow(Math.abs(Math.cos(m * angle / 4)), n2)
          + Math.pow(Math.abs(Math.sin(m * angle / 4)), n3), -1 / n1);
      }
      for (let j = 1, k = 0; j < latitude; j++) {
        const v = -Math.PI / 2 + Math.PI * j / latitude;
        const rv = superformula(v, 6, .75, 1.4, 1.4);
        for (let i = 0; i < longitude; i++, k++) {
          const u = Math.PI * 2 * i / longitude, ru = superformula(u, 7, .6, 1.7, 1.7);
          const isInner = k % 3 === 0, index = isInner ? k / 3 : k - Math.floor(k / 3) - 1;
          const positions = isInner ? innerVertices : vertices, uv = isInner ? innerParameters : parameters;
          positions[index * 3] = ru * Math.cos(u) * rv * Math.cos(v);
          positions[index * 3 + 1] = rv * Math.sin(v) * 1.3;
          positions[index * 3 + 2] = ru * Math.sin(u) * rv * Math.cos(v);
          uv[index * 2] = u; uv[index * 2 + 1] = v;
        }
      }
      const rawGyroid = samplePorousGyroid();
      const gyroid = new Float32Array(2400 * 3);
      for (let i = 0; i < 2400; i++) {
        const source = Math.floor(i * (rawGyroid.length / 3) / 2400) * 3;
        for (let axis = 0; axis < 3; axis++) gyroid[i * 3 + axis] = rawGyroid[source + axis]! / 2.9;
      }
      const gyroidUv = new Float32Array(gyroid.length / 3 * 2);
      for (let i = 0; i < gyroid.length / 3; i++) { gyroidUv[i * 2] = 10 + i * .001; gyroidUv[i * 2 + 1] = gyroid[i * 3 + 1]!; }
      const surfaceGeometry = new THREE.BufferGeometry(); extraGeometries.push(surfaceGeometry);
      surfaceGeometry.setAttribute("position", new THREE.BufferAttribute(gyroid, 3));
      surfaceGeometry.setAttribute("surfaceUv", new THREE.BufferAttribute(gyroidUv, 2));
      manifoldGeometry.setAttribute("position", new THREE.BufferAttribute(innerVertices, 3));
      manifoldGeometry.setAttribute("surfaceUv", new THREE.BufferAttribute(innerParameters, 2));
      manifoldGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5.5);
      // The bounding sphere includes the combined breath, gyroid and scale
      // multipliers in the shader and is independent of animation time.
      surfaceGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5.5);
      organismMaterial = new THREE.ShaderMaterial({
        uniforms: { tint: { value: new THREE.Color(0x9ddae6) }, accent: { value: new THREE.Color(0xeeab66) },
          phase: { value: 0 } },
        vertexShader: `attribute vec2 surfaceUv; uniform float phase; varying float vWave; varying float distanceFade; varying float channelMask;
          void main() {
            float u = surfaceUv.x, v = surfaceUv.y;
            float breath = 1.0 + .065 * sin(3.0 * u + phase * 1.1)
              + .04 * sin(8.0 * u + 5.0 * v - phase * .8);
            vec3 p = position * breath;
            float gy = sin(5.0 * p.x) * cos(5.0 * p.y)
              + sin(5.0 * p.y) * cos(5.0 * p.z) + sin(5.0 * p.z) * cos(5.0 * p.x);
            p *= (1.0 + .08 * gy) * 2.9;
            vWave = .5 + .5 * sin(u * 7.0 + v * 4.0 + phase);
            vec4 view = modelViewMatrix * vec4(p, 1.0);
            distanceFade = projectionMatrix[2][3] == 0.0 ? 1.0 : clamp(24.0 / max(1.0, -view.z), .12, 1.0);
            // Gradually simplify dense channels in the distant screen projection.
            vec3 center = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            vec2 q = view.xy - center.xy;
            float a = smoothstep(.85, 1.05, length((q - vec2(-1.0, .55)) * vec2(.85, 1.1)));
            float b = smoothstep(.85, 1.05, length((q - vec2(1.0, -.55)) * vec2(.85, 1.1)));
            float farWeight = projectionMatrix[2][3] == 0.0 ? 0.0 : smoothstep(25.0, 55.0, -center.z);
            channelMask = mix(1.0, a * b, farWeight);
            gl_Position = projectionMatrix * view;
            // Portraits use an orthographic camera and are often downsampled
            // into overview tiles. Widen only those points; perspective battle
            // views retain their original distance-limited size and brightness.
            gl_PointSize = projectionMatrix[2][3] == 0.0 ? 4.0 : max(2.5, 6.0 * sqrt(distanceFade));
          }`,
        fragmentShader: `uniform vec3 tint; uniform vec3 accent; varying float vWave; varying float distanceFade; varying float channelMask;
          void main() {
            float r = length(gl_PointCoord - vec2(.5)) * 2.0;
            float dotGlow = 1.0 - smoothstep(.25, 1.0, r);
            gl_FragColor = vec4(mix(tint, accent, smoothstep(.72, .96, vWave) * .8),
              dotGlow * (.58 + .3 * vWave) * mix(.65, 1.0, distanceFade) * channelMask);
            #include <colorspace_fragment>
          }`,
        transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      });
      materials.push(organismMaterial);
      manifold.material = organismMaterial;
      const surface = new THREE.Points(surfaceGeometry, organismMaterial);
      surface.name = "monster-fx-organism"; surface.raycast = () => {};
      // Look across the nested lobes rather than edge-on to the polar axis.
      surface.rotation.set(-1.15, 0, -.35); manifold.rotation.copy(surface.rotation);
      body.add(surface); organismSurface = surface;
      // A connected, thick channel scaffold keeps the porous silhouette legible
      // at board scale. Its open loops are a visual abstraction of the gyroid.
      const channelGeometry = new THREE.TorusKnotGeometry(2.05, .32, 96, 8, 2, 3);
      extraGeometries.push(channelGeometry);
      const channelMaterial = new THREE.MeshPhysicalMaterial({ color: 0x3b9eaa, emissive: 0x155660, emissiveIntensity: .55, roughness: .22, metalness: .12, clearcoat: .85, clearcoatRoughness: .18 });
      materials.push(channelMaterial);
      const channels = new THREE.Mesh(channelGeometry, channelMaterial);
      channels.name = "porous-channel-scaffold"; channels.raycast = () => {};
      channels.rotation.set(.45, .3, .25); body.add(channels);
    }
    // Each species keeps its own silhouette; the shell surrounds only its core.
    // This is stylized transparency, not expensive screen-space refraction.
    const shellShapes: Record<SpeciesId, { shape: Shape; scale: Vec }> = {
      spore_leaper: { shape: "sphere", scale: [2.8, 2.6, 2.45] },
      flux_lancer: { shape: "crystal", scale: [2.1, 3.9, 1.9] },
      porous_shaper: { shape: "sphere", scale: [1.35, 1.4, 1.3] },
      prism_warden: { shape: "crystal", scale: [2.75, 3.6, 2.75] },
      swarm_mantle: { shape: "sphere", scale: [1.9, 1.9, 1.9] },
      phase_stalker: { shape: "crystal", scale: [1.7, 3.5, 1.5] },
      gravity_core: { shape: "sphere", scale: [2.65, 2.65, 2.65] },
      neural_weaver: { shape: "crystal", scale: [1.65, 1.65, 1.65] },
      many_core: { shape: "sphere", scale: [2.25, 2.4, 2.25] },
      field_sovereign: { shape: "box", scale: [2.35, 2.35, 2.35] },
    };
    const glass = new THREE.MeshPhysicalMaterial({ color: primary, emissive: primary, emissiveIntensity: .17,
      metalness: .16, roughness: .2, transparent: true, opacity: .22, depthWrite: false, side: THREE.DoubleSide });
    const rim = new THREE.ShaderMaterial({
      uniforms: { tint: { value: new THREE.Color(light) }, fieldPulse: { value: 1 }, fieldPhase: { value: 0 } },
      vertexShader: `varying vec3 vNormal; varying vec3 vView; varying vec3 vLocal;
        void main() { vec4 p = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal); vView = normalize(-p.xyz); vLocal = position;
          gl_Position = projectionMatrix * p; }`,
      fragmentShader: `uniform vec3 tint; uniform float fieldPulse; uniform float fieldPhase;
        varying vec3 vNormal; varying vec3 vView; varying vec3 vLocal;
        void main() { float edge = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.4);
          float veins = pow(max(0.0, sin(vLocal.x * 13.0 + vLocal.y * 7.0 + fieldPhase)
            * sin(vLocal.z * 11.0 - vLocal.y * 9.0 - fieldPhase * .7)), 9.0);
          gl_FragColor = vec4(tint, (edge * .34 + veins * .12) * fieldPulse); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    materials.push(glass, rim);
    const shell = shellShapes[id];
    const glassMesh = new THREE.Mesh(geometry(shell.shape), glass);
    glassMesh.name = "monster-fx-glass"; glassMesh.scale.set(...shell.scale);
    glassMesh.raycast = () => {}; glassMesh.visible = id !== "porous_shaper"; body.add(glassMesh);
    const rimMesh = new THREE.Mesh(geometry(shell.shape), rim);
    rimMesh.name = "monster-fx-rim"; rimMesh.scale.set(...shell.scale);
    rimMesh.raycast = () => {}; rimMesh.visible = id !== "porous_shaper"; body.add(rimMesh);

    // A small inner emitter, not an eye or target; normal depth tests still
    // prevent it showing through unrelated foreground buildings or units.
    const coreWhite = new THREE.Color(0xffffff);
    const coreMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(light).lerp(coreWhite, .45) });
    materials.push(coreMaterial);
    const core = new THREE.Mesh(geometry("sphere"), coreMaterial);
    core.name = "monster-fx-core";
    core.scale.setScalar(.58); core.raycast = () => {}; core.visible = id !== "porous_shaper"; body.add(core);
    const haloMaterial = new THREE.ShaderMaterial({
      uniforms: { tint: { value: new THREE.Color(light) }, fieldPulse: { value: 1 } },
      vertexShader: `varying vec3 vNormal; varying vec3 vView;
        void main() { vec4 p = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal); vView = normalize(-p.xyz);
          gl_Position = projectionMatrix * p; }`,
      fragmentShader: `uniform vec3 tint; uniform float fieldPulse; varying vec3 vNormal; varying vec3 vView;
        void main() { float facing = abs(dot(normalize(vNormal), normalize(vView)));
          gl_FragColor = vec4(tint, (.08 + .13 * facing) * fieldPulse); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    materials.push(haloMaterial);
    const halo = new THREE.Mesh(geometry("sphere"), haloMaterial);
    halo.name = "monster-fx-halo"; halo.scale.setScalar(1.2); halo.raycast = () => {};
    halo.visible = id !== "porous_shaper"; body.add(halo);

    // Bounded soft emission, depth-tested against foreground objects.
    const glowGeometry = new THREE.BufferGeometry(); extraGeometries.push(glowGeometry);
    glowGeometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const glowMaterial = new THREE.ShaderMaterial({
      uniforms: { tint: { value: new THREE.Color(primary) }, pulse: { value: 1 } },
      vertexShader: `void main() { vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * p;
        gl_PointSize = projectionMatrix[2][3] == 0.0 ? 70.0 : clamp(1300.0 / max(1.0, -p.z), 14.0, 70.0); }`,
      fragmentShader: `uniform vec3 tint; uniform float pulse;
        void main() { float r = length(gl_PointCoord - vec2(.5)) * 2.0;
          if (r >= 1.0) discard;
          gl_FragColor = vec4(tint, pow(1.0 - r, 2.5) * .22 * pulse); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    materials.push(glowMaterial);
    const ambientGlow = new THREE.Points(glowGeometry, glowMaterial);
    ambientGlow.name = "monster-fx-emission"; ambientGlow.raycast = () => {}; body.add(ambientGlow);

    // Fixed tilted ellipses; particles on each lane have independent phase and
    // speed. Neither random values nor battle state enter this presentation.
    const lanes = Array.from({ length: 6 }, (_, i) => ({
      radius: 3.15 + i * .16, minor: .68 + (i % 3) * .09,
      orientation: new THREE.Quaternion().setFromEuler(new THREE.Euler(.35 + i * .43, i * 1.047, i * .31)),
    }));
    const sample = new THREE.Vector3();
    function orbitPoint(lane: number, angle: number): THREE.Vector3 {
      const path = lanes[lane]!;
      return sample.set(Math.cos(angle) * path.radius, Math.sin(angle) * path.radius * path.minor, 0)
        .applyQuaternion(path.orientation);
    }
    const segments = 48, pathPositions = new Float32Array(lanes.length * segments * 6);
    let offset = 0;
    for (let lane = 0; lane < lanes.length; lane++) for (let i = 0; i < segments; i++) {
      for (const t of [i, i + 1]) {
        const p = orbitPoint(lane, t * Math.PI * 2 / segments);
        pathPositions[offset++] = p.x; pathPositions[offset++] = p.y; pathPositions[offset++] = p.z;
      }
    }
    const orbitGeometry = new THREE.BufferGeometry(); extraGeometries.push(orbitGeometry);
    orbitGeometry.setAttribute("position", new THREE.BufferAttribute(pathPositions, 3));
    const orbitMaterial = new THREE.LineBasicMaterial({ color: light, transparent: true, opacity: .15,
      depthWrite: false, blending: THREE.AdditiveBlending });
    materials.push(orbitMaterial);
    const orbitals = new THREE.LineSegments(orbitGeometry, orbitMaterial);
    orbitals.name = "monster-fx-orbitals"; orbitals.raycast = () => {};
    orbitals.visible = id !== "porous_shaper"; body.add(orbitals);

    const count = role === "Boss" ? 36 : 18;
    const positions = new Float32Array(count * 3);
    const particleGeometry = new THREE.BufferGeometry(); extraGeometries.push(particleGeometry);
    const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
    particleGeometry.setAttribute("position", positionAttribute);
    particleGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4.1);
    function positionParticles(time: number) {
      for (let i = 0; i < count; i++) {
        const speed = (.28 + (i % 7) * .045) * (i % 2 ? -1 : 1);
        const p = orbitPoint(i % lanes.length, i * 2.399963229728653 + time * speed);
        positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z;
      }
      positionAttribute.needsUpdate = true;
    }
    positionParticles(0);
    const particleMaterial = new THREE.ShaderMaterial({
      uniforms: { tint: { value: new THREE.Color(light) } },
      vertexShader: `varying float distanceFade; void main() { vec4 p = modelViewMatrix * vec4(position, 1.0);
        distanceFade = projectionMatrix[2][3] == 0.0 ? 1.0 : clamp(24.0 / max(1.0, -p.z), .12, 1.0);
        gl_Position = projectionMatrix * p; gl_PointSize = max(1.0, 4.0 * distanceFade); }`,
      fragmentShader: `uniform vec3 tint; varying float distanceFade;
        void main() { float r = length(gl_PointCoord - vec2(.5)) * 2.0;
          float glow = exp(-r * r * 4.0); float core = 1.0 - smoothstep(.06, .20, r);
          gl_FragColor = vec4(mix(tint, vec3(1.0), core * .65), max(glow * .3, core * .5) * distanceFade); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    materials.push(particleMaterial);
    const particles = new THREE.Points(particleGeometry, particleMaterial);
    particles.name = "monster-fx-particles"; particles.raycast = () => {};
    particles.visible = id !== "porous_shaper"; body.add(particles);
    const coreLight = new THREE.PointLight(primary, role === "Boss" ? 22 : 6, role === "Boss" ? 22 : 11, 2);
    coreLight.name = "monster-fx-light"; coreLight.castShadow = false; body.add(coreLight);

    const organicEffect = id === "spore_leaper" || id === "many_core" ? createOrganicLife(id) : undefined;
    const flowEffect = id === "flux_lancer" || id === "prism_warden" ? createFlowCrystalForm(id) : undefined;
    const networkEffect = id === "swarm_mantle" || id === "neural_weaver" || id === "field_sovereign" ? createNetworkFieldLife(id) : undefined;
    if (organicEffect) body.add(organicEffect.root);
    if (flowEffect) body.add(flowEffect.root);
    if (networkEffect) body.add(networkEffect.root);
    const phaseEffect = id === "phase_stalker" ? createPhaseInterference() : undefined;
    const gravityEffect = id === "gravity_core" ? createGravityAccretion() : undefined;
    if (phaseEffect) body.add(phaseEffect.root);
    if (gravityEffect) body.add(gravityEffect.root);

    return {
      root,
      update(dt, reducedMotion) {
        const delta = reducedMotion ? 0 : Math.min(.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
        elapsed += delta;
        organicEffect?.update(elapsed, reducedMotion);
        flowEffect?.update(delta, reducedMotion);
        networkEffect?.update(elapsed, reducedMotion);
        phaseEffect?.update(elapsed, reducedMotion);
        gravityEffect?.update(delta, reducedMotion);
        for (const item of rotating) item.group.rotation.set(item.x, item.y + elapsed * item.speed, item.z);
        if (delta > 0) positionParticles(elapsed);
        const pulse = 1 + .12 * Math.sin(elapsed * 1.2);
        core.scale.setScalar(.58 * pulse);
        halo.scale.setScalar(1.2 * pulse);
        haloMaterial.uniforms.fieldPulse!.value = pulse;
        glowMaterial.uniforms.pulse!.value = pulse;
        coreMaterial.color.setHex(light).lerp(coreWhite, .45 + (pulse - 1));
        glass.emissiveIntensity = .17 * pulse;
        rim.uniforms.fieldPulse!.value = pulse;
        rim.uniforms.fieldPhase!.value = elapsed * .6;
        manifoldMaterial.uniforms.phase!.value = elapsed;
        if (organismMaterial) organismMaterial.uniforms.phase!.value = elapsed;
        if (organismSurface) {
          organismSurface.rotation.y = elapsed * .15;
          manifold.rotation.y = organismSurface.rotation.y;
        }
        coreLight.intensity = (role === "Boss" ? 22 : 6) * pulse;
      },
      dispose() {
        if (disposed) return;
        disposed = true; root.removeFromParent();
        organicEffect?.dispose();
        flowEffect?.dispose();
        networkEffect?.dispose();
        phaseEffect?.dispose();
        gravityEffect?.dispose();
        for (const g of geometries.values()) g.dispose();
        for (const g of extraGeometries) g.dispose();
        for (const material of materials) material.dispose();
      },
    };
  } catch (error) {
    for (const g of geometries.values()) g.dispose();
    for (const g of extraGeometries) g.dispose();
    for (const material of materials) material.dispose();
    throw error;
  }
}
