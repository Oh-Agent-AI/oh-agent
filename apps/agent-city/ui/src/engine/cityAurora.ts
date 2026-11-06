/**
 * 夜空极光：环形分布的波动幕帘（additive）。
 * 参考并改编自 tinyskies/GlobeFly 的 Aurora（作者已授权参考其代码）：
 * 顶点波动（多重正弦 + 顶部摆动）与片元的幕帘条纹/三段配色/边顶渐隐沿用其
 * 思路，几何与尺度按 Agent City 的世界重设（高空环带，直径按城市半径缩放）。
 * 夜间随星空强度淡入；白昼 alpha=0 时整组隐藏（零绘制）。
 */

import * as THREE from "three";

const CURTAINS = 8;
const SEGMENTS_X = 48;
const SEGMENTS_Y = 16;

const auroraVert = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vWave;
varying float vHeight;
void main() {
  vUv = uv;
  vHeight = uv.y;
  vec3 pos = position;
  float wave1 = sin(pos.x * 0.6 + uTime * 0.3) * 0.4;
  float wave2 = sin(pos.x * 1.2 + uTime * 0.2 + 1.5) * 0.2;
  float wave3 = sin(pos.x * 0.3 + uTime * 0.15 + 3.0) * 0.6;
  float ripple = sin(pos.x * 3.0 + pos.y * 0.4 + uTime * 0.8) * 0.05;
  pos.z += (wave1 + wave2 + wave3 + ripple) * (0.3 + uv.y * 0.7);
  float sway = sin(pos.x * 0.25 + uTime * 0.1) * 0.3;
  pos.y += sway * uv.y;
  vWave = (wave1 + wave2) * 0.8;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const auroraFrag = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
varying vec2 vUv;
varying float vWave;
varying float vHeight;
void main() {
  float curtainX = sin(vUv.x * 12.0 + uTime * 0.5) * 0.5 + 0.5;
  curtainX = pow(curtainX, 2.0);
  float curtainX2 = sin(vUv.x * 8.0 - uTime * 0.3 + 2.0) * 0.5 + 0.5;
  curtainX2 = pow(curtainX2, 3.0);
  float curtain = max(curtainX * 0.8, curtainX2 * 0.5);
  float shimmer = sin(vUv.x * 30.0 + vUv.y * 8.0 + uTime * 2.0) * 0.5 + 0.5;
  shimmer = shimmer * 0.2 + 0.8;
  float bottomFade = smoothstep(0.0, 0.2, vHeight);
  float topFade = 1.0 - smoothstep(0.5, 1.0, vHeight);
  float vertFade = bottomFade * topFade;
  float edgeFade = smoothstep(0.0, 0.15, vUv.x) * (1.0 - smoothstep(0.85, 1.0, vUv.x));
  float t = vUv.y + vWave * 0.3;
  vec3 col;
  if (t < 0.4) {
    col = mix(uColor1, uColor2, t / 0.4);
  } else {
    col = mix(uColor2, uColor3, (t - 0.4) / 0.6);
  }
  col += vec3(0.1, 0.15, 0.1) * shimmer * curtain;
  float a = curtain * vertFade * edgeFade * shimmer * uAlpha;
  a *= 0.55;
  gl_FragColor = vec4(col, a);
}
`;

type CurtainDef = {
  color1: [number, number, number];
  color2: [number, number, number];
  color3: [number, number, number];
  alpha: number;
  tilt: number;
};

const PALETTE: CurtainDef[] = [
  { color1: [0.10, 0.90, 0.30], color2: [0.10, 0.70, 0.60], color3: [0.30, 0.30, 0.90], alpha: 1.0, tilt: 0.10 },
  { color1: [0.15, 0.80, 0.40], color2: [0.20, 0.50, 0.80], color3: [0.60, 0.20, 0.70], alpha: 0.8, tilt: 0.15 },
  { color1: [0.20, 0.60, 0.90], color2: [0.40, 0.30, 0.80], color3: [0.70, 0.15, 0.50], alpha: 0.6, tilt: -0.08 },
  { color1: [0.05, 0.95, 0.35], color2: [0.10, 0.85, 0.55], color3: [0.15, 0.50, 0.75], alpha: 0.7, tilt: 0.20 },
];

export class CityAurora {
  readonly group = new THREE.Group();
  private readonly timeUniforms: Array<{ value: number }> = [];
  private readonly alphaUniforms: Array<{ value: number }> = [];
  private readonly baseAlphas: number[] = [];
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly geometries: THREE.PlaneGeometry[] = [];
  private night = 0;

  constructor(center: { x: number; z: number }, cityRadius: number) {
    this.group.renderOrder = -5;
    // 环放到航拍/总览机位之外（曾 1.9×0.6R ≈ 1.14R，落在总览相机与城市之间）。
    const ringRadius = cityRadius * 3.4;
    const curtainHeight = cityRadius * 0.55;
    const curtainWidth = cityRadius * 0.5;
    for (let index = 0; index < CURTAINS; index += 1) {
      const def = PALETTE[index % PALETTE.length];
      const angle = (index / CURTAINS) * Math.PI * 2;
      const geometry = new THREE.PlaneGeometry(curtainWidth, curtainHeight, SEGMENTS_X, SEGMENTS_Y);
      const timeUniform = { value: index * 7.3 };
      const alphaUniform = { value: def.alpha };
      const material = new THREE.ShaderMaterial({
        vertexShader: auroraVert,
        fragmentShader: auroraFrag,
        uniforms: {
          uTime: timeUniform,
          uAlpha: alphaUniform,
          uColor1: { value: new THREE.Vector3(...def.color1) },
          uColor2: { value: new THREE.Vector3(...def.color2) },
          uColor3: { value: new THREE.Vector3(...def.color3) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(center.x + Math.cos(angle) * ringRadius, cityRadius * 1.05, center.z + Math.sin(angle) * ringRadius);
      // 幕面朝向城心：曾 rotation.y = -angle，平面法线沿切向，从城里看是侧边——一根竖直的光柱横穿画面。
      mesh.rotation.y = Math.PI / 2 - angle;
      mesh.rotation.z = def.tilt;
      this.group.add(mesh);
      this.timeUniforms.push(timeUniform);
      this.alphaUniforms.push(alphaUniform);
      this.baseAlphas.push(def.alpha);
      this.materials.push(material);
      this.geometries.push(geometry);
    }
    this.group.visible = false;
  }

  /** night ∈ [0,1]（星空强度）：整组随夜色淡入淡出。 */
  setNight(night: number): void {
    this.night = night;
    this.group.visible = night > 0.02;
  }

  /** 幕帘相位回零（胶片导出开拍前）。 */
  reset(): void {
    for (const uniform of this.timeUniforms) uniform.value = 0;
  }

  // 隐藏时也推进：状态只取决于累计时间，不取决于「之前是否可见」（导出可复现）。
  update(dt: number): void {
    for (let index = 0; index < this.timeUniforms.length; index += 1) {
      this.timeUniforms[index].value += dt;
      this.alphaUniforms[index].value = this.baseAlphas[index] * this.night * 0.8;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
  }
}
