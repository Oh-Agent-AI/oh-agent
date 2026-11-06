/** Project-owned low-poly player car. +X forward, +Y up, +Z right.
 * No input, simulation, world queries or external assets. All resources are owned here.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { CAR_STREET_LIGHT_GLSL, carLampsAdd, carStreetLightUniforms } from "../engine/render/drivingStreetLights";
import { CAR_DIMENSIONS } from "./carDimensions";
export { CAR_DIMENSIONS } from "./carDimensions";

export type CarVisualState = {
  x: number; y: number; z: number;
  /** Planar heading: 0 = +X, positive points toward +Z. */
  heading: number;
  pitch: number; roll: number;
  steering: number;
  /** Signed total travel distance, supplied by the simulation; never integrated here. */
  distance: number;
  braking: boolean; reversing: boolean;
  bodyPitch?: number; bodyRoll?: number;
  /** VTOL 推进器强度 [0,1]（由上升速度驱动）：>0 时渲染底部冷气喷流。 */
  thruster?: number;
};

const limit = (n: number, bound: number) => Math.max(-bound, Math.min(bound, Number.isFinite(n) ? n : 0));

/** A tapered longitudinal shell, with flat normals and independently specified roof width. */
function shell(stations: Array<[number, number, number, number]>): THREE.BufferGeometry {
  const positions: number[] = [];
  const triangle = (a: number[], b: number[], c: number[]) => positions.push(...a, ...b, ...c);
  const rings = stations.map(([x, bottom, top, halfWidth]) => [
    [x, bottom, -halfWidth], [x, bottom, halfWidth],
    [x, top, halfWidth * 0.86], [x, top, -halfWidth * 0.86],
  ]);
  for (let i = 1; i < rings.length; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      const next = (j + 1) % 4;
      triangle(rings[i - 1][j], rings[i][j], rings[i][next]);
      triangle(rings[i - 1][j], rings[i][next], rings[i - 1][next]);
    }
  }
  triangle(rings[0][0], rings[0][2], rings[0][1]);
  triangle(rings[0][0], rings[0][3], rings[0][2]);
  const end = rings[rings.length - 1];
  triangle(end[0], end[1], end[2]); triangle(end[0], end[2], end[3]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Open wheel arches keep the tires visible through the body silhouette. */
function chassis(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-1.34, 0.49);
  shape.lineTo(-1.05, 0.57); shape.lineTo(0.4, 0.67);
  shape.lineTo(1.34, 0.46); shape.lineTo(1.34, 0.26);
  shape.lineTo(1.18, 0.26);
  shape.absarc(0.9, 0.26, 0.28, 0, Math.PI, false);
  shape.lineTo(-0.62, 0.26);
  shape.absarc(-0.9, 0.26, 0.28, 0, Math.PI, false);
  shape.lineTo(-1.34, 0.26); shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.14, bevelEnabled: true, bevelThickness: 0.02,
    bevelSize: 0.02, bevelSegments: 1, curveSegments: 8, steps: 1,
  }).translate(0, 0, 0.51);
  // ExtrudeGeometry already uses non-indexed vertices.
  return geometry;
}

function box(x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(sx, sy, sz).toNonIndexed().translate(x, y, z);
}

export class CarVisuals {
  readonly root = new THREE.Group();
  readonly bodyPivot = new THREE.Group();
  readonly wheels: ReadonlyArray<{ steer: THREE.Group; spin: THREE.Group }>;
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly brake: THREE.MeshStandardMaterial;
  private readonly reverse: THREE.MeshStandardMaterial;
  private disposed = false;

  constructor(color = "#ed7596") {
    this.root.name = "carRoot";
    this.bodyPivot.name = "bodyPivot";
    this.root.add(this.bodyPivot);
    const material = (options: THREE.MeshStandardMaterialParameters) => {
      const result = new THREE.MeshStandardMaterial(options);
      // N5 开车模式解析街灯：车身也受路灯照（车顶/引擎盖接住头顶的暖光，低角度相机下
      // 可信度增益最大）。uCarLampCount = 0（非开车模式 / 白天）时注入块早退，零行为。
      result.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, carStreetLightUniforms());
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vCarWPos;\nvarying vec3 vCarWNormal;")
          .replace("#include <project_vertex>", "#include <project_vertex>\nvCarWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvCarWNormal = normalize(mat3(modelMatrix) * objectNormal);");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", `#include <common>\nvarying vec3 vCarWPos;\nvarying vec3 vCarWNormal;\n${CAR_STREET_LIGHT_GLSL}`)
          .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>\n${carLampsAdd("vCarWPos", "vCarWNormal")}`);
      };
      this.materials.add(result); return result;
    };
    const paint = material({ color, roughness: 0.38, metalness: 0.22, flatShading: true });
    const dark = material({ color: "#202b32", roughness: 0.8 });
    const glass = material({ color: "#73b8c0", roughness: 0.16, metalness: 0.2, transparent: true, opacity: 0.48, depthWrite: false, side: THREE.DoubleSide });
    const trim = material({ color: "#f2dfbb", roughness: 0.65, metalness: 0.05 });
    const head = material({ color: "#fff1ce", emissive: "#ffe4ab", emissiveIntensity: 1.0 });
    this.brake = material({ color: "#ad2825", emissive: "#ff2921", emissiveIntensity: 0.12 });
    this.reverse = material({ color: "#c8d1c5", emissive: "#edfff6", emissiveIntensity: 0 });
    const add = (name: string, pieces: THREE.BufferGeometry[], mat: THREE.Material, parent: THREE.Object3D = this.bodyPivot) => {
      // These untextured parts share position/normal (and optional vertex color) only.
      pieces.forEach((piece) => piece.deleteAttribute("uv"));
      const geometry = mergeGeometries(pieces);
      pieces.forEach((piece) => piece.dispose());
      if (!geometry) throw new Error(`Cannot merge car part: ${name}`);
      this.geometries.add(geometry);
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true;
      parent.add(mesh); return mesh;
    };

    const windshieldPart = (z: number, width: number, thickness: number) =>
      new THREE.BoxGeometry(thickness, 0.43, width).toNonIndexed()
        .rotateZ(0.64).translate(0.3, 0.78, z);
    add("paint", [
      chassis(), chassis().translate(0, 0, -1.18),
      // Separate hood and rear deck leave a real open cockpit between them.
      shell([[0.47, 0.28, 0.655, 0.65], [1.34, 0.28, 0.46, 0.64]]),
      shell([[-1.34, 0.28, 0.49, 0.65], [-0.75, 0.28, 0.57, 0.65]]),
      box(-0.71, 0.58, 0, 0.09, 0.08, 1.18),
      windshieldPart(-0.53, 0.035, 0.035), windshieldPart(0.53, 0.035, 0.035),
      box(0.17, 0.95, 0, 0.04, 0.04, 1.08),
      ...[-1, 1].flatMap((side) => [
        box(-0.09, 0.56, side * 0.59, 1.17, 0.045, 0.08),
        box(0.38, 0.63, side * 0.65, 0.16, 0.075, 0.08),
        box(0.98, 0.64, side * 0.42, 0.25, 0.14, 0.28),
      ]),
    ], paint);
    add("windows", [windshieldPart(0, 1.02, 0.018)], glass);
    add("rubber-and-grille", [
      box(0, 0.27, 0, 2.3, 0.08, 1.1),
      box(0.42, 0.57, 0, 0.16, 0.11, 1.03),
      box(-0.09, 0.43, 0, 0.75, 0.14, 0.12),
      box(1.365, 0.315, 0, 0.025, 0.09, 1.05),
      box(-1.365, 0.315, 0, 0.025, 0.09, 1.06),
      new THREE.TorusGeometry(0.105, 0.017, 6, 16).rotateY(Math.PI / 2).rotateZ(0.3).toNonIndexed().translate(0.12, 0.67, -0.29),
      ...[-1, 1].flatMap((side) => [
        box(-0.19, 0.49, side * 0.672, 0.17, 0.022, 0.016),
        ...[0, 1, 2, 3].map((i) => box(-0.98 + i * 0.055, 0.585, side * 0.39, 0.02, 0.015, 0.27)),
      ]),
    ], dark);
    add("interior", [
      ...[-1, 1].flatMap((side) => [
        box(-0.3, 0.4, side * 0.29, 0.43, 0.13, 0.4),
        new THREE.BoxGeometry(0.12, 0.34, 0.4).toNonIndexed().rotateZ(-0.13).translate(-0.53, 0.59, side * 0.29),
        box(-0.55, 0.81, side * 0.29, 0.12, 0.12, 0.24),
        box(-0.09, 0.48, side * 0.505, 0.95, 0.12, 0.035),
      ]),
    ], trim);
    add("headlights", [-1, 1].map((side) => box(1.112, 0.65, side * 0.42, 0.018, 0.09, 0.22)), head);
    add("brake-lights", [-1, 1].map((side) => box(-1.366, 0.425, side * 0.4, 0.025, 0.075, 0.39)), this.brake);
    add("reverse-lights", [-1, 1].map((side) => box(-1.367, 0.425, side * 0.13, 0.026, 0.06, 0.1)), this.reverse);
    // 真前灯：灯罩贴片只自发光、照不亮路面（夜间前方全黑的根因）。两个聚光灯随
    // 车身姿态（root 子对象）指向正前偏下，常亮——白天被环境光淹没，夜里打出光池。
    for (const side of [-1, 1]) {
      const beam = new THREE.SpotLight("#ffe9c4", 36, 18, 0.42, 0.5, 1.35);
      beam.position.set(1.0, 0.6, side * 0.42);
      const beamTarget = new THREE.Object3D();
      beamTarget.position.set(9, -0.3, side * 0.5);
      beamTarget.name = "headlightTarget";
      this.root.add(beam, beamTarget);
      beam.target = beamTarget;
    }

    const wheelMaterial = material({ vertexColors: true, roughness: 0.72, metalness: 0.12 });
    const colored = (geometry: THREE.BufferGeometry, color: string) => {
      const c = new THREE.Color(color);
      const count = geometry.getAttribute("position").count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) c.toArray(colors, i * 3);
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      return geometry;
    };
    this.wheels = [1, -1].flatMap((axle) => [-1, 1].map((side) => {
      const steer = new THREE.Group(); const spin = new THREE.Group();
      steer.name = `wheelSteerPivot-${axle === 1 ? "front" : "rear"}-${side === 1 ? "right" : "left"}`;
      spin.name = "wheelSpinPivot";
      steer.position.set(axle * CAR_DIMENSIONS.wheelbase / 2, CAR_DIMENSIONS.wheelRadius, side * CAR_DIMENSIONS.track / 2);
      steer.add(spin); this.root.add(steer);
      const tire = new THREE.CylinderGeometry(CAR_DIMENSIONS.wheelRadius, CAR_DIMENSIONS.wheelRadius, CAR_DIMENSIONS.wheelWidth, 16).rotateX(Math.PI / 2).toNonIndexed();
      const hub = new THREE.CylinderGeometry(0.135, 0.135, 0.184, 12).rotateX(Math.PI / 2).toNonIndexed();
      const spokes = Array.from({ length: 5 }, (_, i) =>
        new THREE.BoxGeometry(0.025, 0.22, 0.012).toNonIndexed()
          .rotateZ(i * Math.PI / 5).translate(0, 0, side * 0.095));
      add("wheel", [colored(tire, "#192125"), colored(hub, "#aeb9b8"), ...spokes.map((spoke) => colored(spoke, "#35444a"))], wheelMaterial, spin);
      return { steer, spin };
    }));
  }

  update(state: CarVisualState): void {
    if (this.disposed) return;
    this.root.position.set(state.x, state.y, state.z);
    // Three's positive Y rotation turns +X toward -Z.
    this.root.rotation.set(0, -state.heading, 0);
    this.root.rotateZ(limit(state.pitch, 0.65));
    this.root.rotateX(limit(state.roll, 0.65));
    this.bodyPivot.rotation.set(limit(state.bodyRoll ?? 0, 0.1), 0, limit(state.bodyPitch ?? 0, 0.08));
    this.wheels.forEach(({ steer, spin }, index) => {
      steer.rotation.y = index < 2 ? -limit(state.steering, 0.55) : 0;
      spin.rotation.z = -(state.distance / CAR_DIMENSIONS.wheelRadius) % (Math.PI * 2);
    });
    this.brake.emissiveIntensity = state.braking ? 2 : 0.12;
    this.reverse.emissiveIntensity = state.reversing ? 1.5 : 0;
    if (this.impactLight) {
      this.impactLight.intensity = Math.max(0, this.impactLight.intensity - 0.12);
    }
    this.updateThruster(limit(state.thruster ?? 0, 1));
  }

  /** 底部冷气喷流：4 喷口锥焰 + 车底冷光。强度平滑跟随（点按不频闪），
   *  焰长带每喷口相位差的高频颤动（纯表现层噪声，不参与任何模拟）。 */
  private updateThruster(target: number): void {
    const now = typeof performance !== "undefined" ? performance.now() / 1000 : 0;
    this.thrusterLevel += (target - this.thrusterLevel) * 0.35;
    const level = this.thrusterLevel;
    if (level < 0.02) {
      if (this.thrusterJets) this.thrusterJets.forEach((jet) => { jet.visible = false; });
      if (this.thrusterLight) this.thrusterLight.intensity = 0;
      return;
    }
    if (!this.thrusterJets) {
      const jetMaterial = new THREE.MeshBasicMaterial({ color: "#d9f2ff", transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      this.materials.add(jetMaterial);
      this.thrusterJets = [[0.72, 0.34], [0.72, -0.34], [-0.72, 0.34], [-0.72, -0.34]].map(([x, z]) => {
        // 默认锥顶朝 +Y；翻转后尖端向下，scale.y 控制焰长。
        const jet = new THREE.Mesh(new THREE.ConeGeometry(0.09, 1, 10, 1, true).rotateX(Math.PI), jetMaterial);
        jet.name = "thrusterJet";
        jet.position.set(x, 0.3, z);
        jet.visible = false;
        this.root.add(jet);
        return jet;
      });
      this.thrusterLight = new THREE.PointLight("#9fd8ff", 0, 6, 2);
      this.thrusterLight.position.set(0, 0.15, 0);
      this.root.add(this.thrusterLight);
    }
    this.thrusterJets.forEach((jet, index) => {
      jet.visible = true;
      const flicker = 0.85 + 0.3 * Math.sin(now * 47 + index * 2.1);
      const length = (0.45 + level * 1.05) * flicker;
      jet.scale.set(0.8 + level * 0.5, length, 0.8 + level * 0.5);
      (jet.material as THREE.MeshBasicMaterial).opacity = 0.35 + level * 0.55;
    });
    this.thrusterLight!.intensity = level * 5;
  }

  /** Collision feedback: brief warm light pulse from the impact point. */
  pulseImpact(): void {
    if (!this.impactLight) {
      this.impactLight = new THREE.PointLight("#ffb257", 0, 8, 2);
      this.impactLight.position.set(0, 0.6, 0);
      this.root.add(this.impactLight);
    }
    this.impactLight.intensity = 6;
  }

  private impactLight: THREE.PointLight | null = null;
  private thrusterJets: THREE.Mesh[] | null = null;
  private thrusterLight: THREE.PointLight | null = null;
  private thrusterLevel = 0;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.root.clear();
  }
}
