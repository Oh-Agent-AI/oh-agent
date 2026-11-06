/**
 * 城市天气（tinyskies RainOverlay/RainbowArch 手法，作者授权参考）：
 *  · 按日期哈希确定性生成——回放同一天必现同天气（流星夜同款纪律）；
 *  · 三态：clear 62% / overcast 20% / rain 18%，按**本地**日期定，首尾 1.5h 平滑过渡；
 *  · 雨天里阵雨一阵一阵（原版 getRainWeight 的两条慢正弦 + smoothstep 阈值，相位按当天播种）；
 *  · 雨后清晨出彩虹（昨日降雨 + 当日哈希，50%），日出后出现、上午渐隐；
 *  · 渲染层：离散雨线（原版 RainOverlay 的做法与参数）+ 光谱弧。原版的玻璃水珠折射与闪电未移植。
 *  天气是纯装饰（同气球/流星），不映射任何数据语义。
 */

import * as THREE from "three";

export { weatherAt } from "./environment/WeatherState";
export type { WeatherKind, WeatherState } from "./environment/WeatherState";

/** 雨丝：移植 tinyskies RainOverlay 的「离散雨线」做法（作者授权参考）。
 *  曾是整屏程序化 shader（固定列格 + 同速下落），读作一排排雪片/方块（用户截图两次）。
 *  原版：≤50 根独立雨线，每根各自的速度 1.8–3.2 屏/秒、长度 8–22% 屏高、宽 0.15–0.3% 屏宽、
 *  风偏 0.35 rad ± 0.09 抖动，加色混合，不透明度 0.35×雨强。这里一模一样，只把 Math.random
 *  换成按生成序号的确定性哈希（胶片导出可复现），并用一个 InstancedMesh + 裁剪空间顶点着色器
 *  画在屏幕上（不需要原版的第二个正交场景）。原版的「玻璃水珠折射」要拷贝帧缓冲，未移植。 */
const STREAK_COUNT = 50;
const WIND_ANGLE = 0.35;
const ANGLE_JITTER = 0.09;

function rainHash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class RainOverlay {
  readonly mesh: THREE.InstancedMesh;
  private readonly uniforms: { uOpacity: { value: number }; uAspect: { value: number } };
  private readonly streaks = Array.from({ length: STREAK_COUNT }, () => ({ x: 0, y: 0, speed: 0, length: 0, width: 0, angle: 0, active: false }));
  private amount = 0;
  private spawnCount = 0;
  private frame = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly zAxis = new THREE.Vector3(0, 0, 1);

  constructor() {
    this.uniforms = { uOpacity: { value: 0 }, uAspect: { value: 1 } };
    const material = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          // 实例矩阵直接给出 NDC（-1..1）里的位置/朝向/尺寸：雨线贴屏幕，不随相机透视。
          gl_Position = vec4((instanceMatrix * vec4(position, 1.0)).xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          float along = vUv.y;
          float taper = smoothstep(0.0, 0.15, along) * smoothstep(1.0, 0.7, along);
          float across = abs(vUv.x - 0.5) * 2.0;
          float shape = (1.0 - smoothstep(0.0, 1.0, across)) * taper;
          gl_FragColor = vec4(0.75, 0.8, 0.88, shape * uOpacity);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, STREAK_COUNT);
    this.mesh.name = "city-rain";
    this.mesh.renderOrder = 90;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.count = 0;
  }

  setAspect(width: number, height: number): void {
    this.uniforms.uAspect.value = Math.max(0.2, width / Math.max(1, height));
  }

  setAmount(amount: number): void {
    this.amount = amount;
    this.uniforms.uOpacity.value = amount * 0.35;
    this.mesh.visible = amount > 0.02;
    if (!this.mesh.visible) for (const streak of this.streaks) streak.active = false;
  }

  /** 生成序列回到起点（胶片导出开拍前）。 */
  reset(): void {
    this.spawnCount = 0;
    this.frame = 0;
    for (const streak of this.streaks) streak.active = false;
  }

  private spawn(streak: (typeof this.streaks)[number]): void {
    const n = this.spawnCount * 6;
    this.spawnCount += 1;
    streak.angle = -WIND_ANGLE + (rainHash(n) - 0.5) * 2 * ANGLE_JITTER;
    streak.length = 0.08 + rainHash(n + 1) * 0.14;
    streak.width = 0.0015 + rainHash(n + 2) * 0.0015;
    streak.speed = 1.8 + rainHash(n + 3) * 1.4;
    streak.x = (rainHash(n + 4) - 0.5) * 2.6;
    streak.y = 1.15 + rainHash(n + 5) * 0.3;
    streak.active = true;
  }

  update(dt: number, elapsed: number, camera: THREE.PerspectiveCamera): void {
    void elapsed;
    void camera;
    if (!this.mesh.visible) return;
    const step = Math.min(dt, 0.1);
    this.frame += 1;
    let visible = 0;
    for (let index = 0; index < STREAK_COUNT; index += 1) {
      const streak = this.streaks[index];
      if (!streak.active) {
        // 原版：每秒按 雨强×0.85×30 的机会补生；同样只用前 25%…这里 50 根即原版普通雨的 activeLimit。
        if (rainHash(this.frame * 53.7 + index * 1.31 + 0.5) < this.amount * 0.85 * step * 30) this.spawn(streak);
        else continue;
      }
      streak.x += Math.sin(streak.angle) * streak.speed * step;
      streak.y -= Math.cos(streak.angle) * streak.speed * step;
      if (streak.y < -1.3) { streak.active = false; continue; }
      this.position.set(streak.x, streak.y, 0);
      this.quaternion.setFromAxisAngle(this.zAxis, streak.angle);
      // 宽度按屏幕宽高比折算：NDC 的 x 跨度在宽屏上更长，原版这里没校正，16:9 下雨线横向被拉粗。
      this.scale.set(streak.width / this.uniforms.uAspect.value, streak.length, 1);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.mesh.setMatrixAt(visible, this.matrix);
      visible += 1;
    }
    this.mesh.count = visible;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

/** 雨后彩虹：海平面上空的半圆光谱弧，反太阳方位，强度随上午渐隐（weatherAt 给出）。 */
export class RainbowArch {
  readonly mesh: THREE.Mesh;
  private readonly uniforms: { uOpacity: { value: number }; uInner: { value: number }; uOuter: { value: number } };

  constructor(radius: number) {
    this.uniforms = { uOpacity: { value: 0 }, uInner: { value: radius * 0.78 }, uOuter: { value: radius } } as RainbowArch["uniforms"];
    // 普通 alpha 混合 + 饱和光谱：加色混合下粉彩色在亮白的雾天空上叠成一道白环（审计照片：没有颜色）。
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying float vRadius;
        varying float vArc;
        void main() {
          vRadius = length(position.xy);
          vArc = atan(position.y, position.x) / 3.14159265; // 0 = 右脚, 1 = 左脚
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform float uInner;
        uniform float uOuter;
        varying float vRadius;
        varying float vArc;
        vec3 band(float t) {
          // t = 0 → 紫，1 → 红。
          vec3 spectrum[6] = vec3[6](
            vec3(0.5, 0.2, 0.85), vec3(0.15, 0.35, 0.95), vec3(0.1, 0.75, 0.9),
            vec3(0.2, 0.85, 0.3), vec3(1.0, 0.85, 0.1), vec3(1.0, 0.25, 0.15)
          );
          float f = clamp(t, 0.0, 1.0) * 5.0;
          int i = int(f);
          return mix(spectrum[i], spectrum[min(i + 1, 5)], fract(f));
        }
        void main() {
          // 光谱沿半径展开（真实主虹：内缘紫 → 外缘红）。曾用 RingGeometry 的 uv.y——那是包围盒上的平面坐标、
          // 自下而上贯穿整道弧，不是环带宽度方向：颜色被拉满整个弧高，环带内几乎是同一种色。
          float t = clamp((vRadius - uInner) / (uOuter - uInner), 0.0, 1.0);
          float edge = smoothstep(0.0, 0.18, t) * smoothstep(1.0, 0.82, t);
          // 两脚淡出（原版 groundFade = sin(u·π)）：曾在海平面处硬切。不透明度只在 set() 里乘一次 0.55
          // ——曾在这里再乘一次，峰值只有原版的一半。
          float groundFade = sin(clamp(vArc, 0.0, 1.0) * 3.14159265);
          gl_FragColor = vec4(band(t), edge * groundFade * uOpacity);
        }`,
    });
    const geometry = new THREE.RingGeometry(radius * 0.78, radius, 48, 1, 0, Math.PI);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "city-rainbow";
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** 摆到反太阳方位的海平面上空。 */
  set(amount: number, sunAzimuth: number, center: { x: number; z: number }, distance: number): void {
    this.uniforms.uOpacity.value = amount * 0.55;
    this.mesh.visible = amount > 0.02;
    if (!this.mesh.visible) return;
    const opposite = sunAzimuth + Math.PI;
    this.mesh.position.set(center.x + Math.cos(opposite) * distance, -18, center.z + Math.sin(opposite) * distance);
    this.mesh.lookAt(center.x, this.mesh.position.y, center.z);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}
