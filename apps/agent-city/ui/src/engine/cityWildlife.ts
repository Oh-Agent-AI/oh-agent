/**
 * 城市野生物组：V 字鸟群、夜间流星、远火山烟柱、黄昏萤火虫。
 * 手法参考 tinyskies/GlobeFly（作者授权参考其代码）：鸟群队形与扑翼节奏出自
 * BirdFlock，流星的对象池/拖尾节奏出自 MeteorShower，萤火虫的闪烁点阵出自
 * FireflyCluster；火山烟柱为自建上升烟团。全部廉价几何、数量固定、昼夜联动；
 * 确定性由 hashSeed 保证（流星夜按日期哈希，回放同一晚必现）。
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { hashSeed } from "../cityModel";
import { m, REAL, VISUAL_BOOST } from "./worldScale";

/** 鸟模型几何翼展 3.76（两翼尖 z=±1.88）；按真实翼展（军舰鸟/褐鹈鹕 ≈2.2 m）× 视觉放大 VISUAL_BOOST.bird。曾固定 ×2.2 = 8.3 m 翼展，是真鸟的近 4 倍、且没有登记。 */
const BIRD_SCALE = m(REAL.bird.wingspan * VISUAL_BOOST.bird) / 3.76;

type Mountain = { center: { x: number; z: number }; radius: number; height: number; seed: number };

/** V 字鸟群：低模身体含头/喙/尾羽，宽阔后掠翼独立扑动，远景仍保持鸟形剪影。 */
class BirdFlocks {
  private readonly bodyMesh: THREE.InstancedMesh;
  private readonly wingMesh: THREE.InstancedMesh;
  private readonly bodyMaterial: THREE.MeshLambertMaterial;
  private readonly wingMaterial: THREE.MeshLambertMaterial;
  private readonly flocks: Array<{ orbit: number; radius: number; altitude: number; speed: number; phase: number; bob: number }> = [];
  private readonly offsets: Array<[number, number]>;
  private readonly matrix = new THREE.Matrix4();
  private readonly wingMatrix = new THREE.Matrix4();
  private readonly birdQuaternion = new THREE.Quaternion();
  private readonly wingQuaternion = new THREE.Quaternion();
  private readonly flapQuaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly position = new THREE.Vector3();
  private readonly scaleVector = new THREE.Vector3();
  private readonly mirror = new THREE.Matrix4().makeScale(1, 1, -1);
  private readonly axisX = new THREE.Vector3(1, 0, 0);
  private readonly center: { x: number; z: number };
  readonly group = new THREE.Group();
  private daylight = 1;

  constructor(center: { x: number; z: number }, radius: number) {
    this.center = { ...center };
    // +x 为前进方向：胸腹纺锤、独立头部和喙、扇开的三片尾羽合并为一个低模网格。
    const body = new THREE.SphereGeometry(0.31, 7, 5).scale(2.25, 0.88, 0.84);
    const head = new THREE.SphereGeometry(0.21, 6, 5).translate(0.58, 0.11, 0);
    const beak = new THREE.ConeGeometry(0.105, 0.42, 5).rotateZ(-Math.PI / 2).translate(0.88, 0.09, 0);
    const tailParts = [-0.22, 0, 0.22].map((spread) =>
      new THREE.ConeGeometry(0.16, 0.78, 4).rotateZ(Math.PI / 2).translate(-0.93, 0.03, spread).scale(1, 0.42, 0.7));
    const bodyGeometry = mergeGeometries([body, head, beak, ...tailParts]);
    [body, head, beak, ...tailParts].forEach((part) => part.dispose());
    bodyGeometry.computeVertexNormals();
    // 后掠翼有分明的初级飞羽轮廓，不再是两片光滑的平三角。
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0.08, 0.12);
    wingShape.lineTo(0.18, 0.62); wingShape.lineTo(-0.16, 1.22); wingShape.lineTo(-0.48, 1.88);
    wingShape.lineTo(-0.82, 1.62); wingShape.lineTo(-1.08, 1.82); wingShape.lineTo(-1.17, 1.43);
    wingShape.lineTo(-1.48, 1.58); wingShape.lineTo(-1.48, 1.18); wingShape.lineTo(-1.78, 1.28);
    wingShape.lineTo(-1.65, 0.88); wingShape.lineTo(-1.38, 0.42); wingShape.lineTo(-0.92, 0.08);
    wingShape.closePath();
    const wingGeometry = new THREE.ExtrudeGeometry(wingShape, { depth: 0.06, bevelEnabled: false }).rotateX(Math.PI / 2);
    this.bodyMaterial = new THREE.MeshLambertMaterial({ color: "#465362", transparent: true, flatShading: true });
    this.wingMaterial = new THREE.MeshLambertMaterial({ color: "#354353", transparent: true, side: THREE.DoubleSide, flatShading: true });
    // 头鸟在前，两翼逐级后撤；间距按翼展留白，避免远景各鸟融合成一团。
    this.offsets = [[0, 0], [0.13, -0.085], [0.13, 0.085], [0.26, -0.17], [0.26, 0.17], [0.39, -0.25], [0.39, 0.25]]
      // 队形间距随鸟体同比：×90 是按 2.2 倍鸟体定的，鸟缩到真实尺寸后间距一起缩（≈1.5 翼展）
      .map(([back, side]) => [back * 90 * BIRD_SCALE / 2.2, side * 90 * BIRD_SCALE / 2.2] as [number, number]);
    const total = this.offsets.length * 2;
    this.bodyMesh = new THREE.InstancedMesh(bodyGeometry, this.bodyMaterial, total);
    this.bodyMesh.name = "city-birds";
    this.wingMesh = new THREE.InstancedMesh(wingGeometry, this.wingMaterial, total * 2);
    this.wingMesh.name = "city-bird-wings";
    this.bodyMesh.frustumCulled = false;
    this.wingMesh.frustumCulled = false;
    this.wingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.bodyMesh, this.wingMesh);
    for (let index = 0; index < 2; index += 1) {
      const seed = hashSeed(`flock:${index}`);
      this.flocks.push({
        // String hashes are close for flock:0/1; index offsets explicitly separate routes and levels.
        orbit: seed * Math.PI * 2 + index * Math.PI,
        radius: radius * (0.36 + index * 0.23 + seed * 0.035),
        altitude: 64 + index * 42 + seed * 8,
        speed: (0.046 + index * 0.008 + seed * 0.012) * (index === 0 ? 1 : -1),
        phase: seed * 7 + index * 1.7,
        bob: 0.55 + seed * 0.4,
      });
    }
  }

  /** Smooth deterministic closed route: a broad loop with gentle crosswind bends, not a perfect orbit. */
  private pathAt(flock: { radius: number; altitude: number; phase: number }, angle: number) {
    const r = flock.radius;
    const a2 = angle * 2 + flock.phase;
    const a3 = angle * 3 - flock.phase * 0.73;
    const x = r * Math.cos(angle) + r * 0.11 * Math.sin(a2) + r * 0.035 * Math.sin(a3);
    const z = r * 0.84 * Math.sin(angle) + r * 0.09 * Math.cos(a2) - r * 0.025 * Math.cos(a3);
    const dx = -r * Math.sin(angle) + r * 0.22 * Math.cos(a2) + r * 0.105 * Math.cos(a3);
    const dz = r * 0.84 * Math.cos(angle) - r * 0.18 * Math.sin(a2) + r * 0.075 * Math.sin(a3);
    const ddx = -r * Math.cos(angle) - r * 0.44 * Math.sin(a2) - r * 0.315 * Math.sin(a3);
    const ddz = -r * 0.84 * Math.sin(angle) - r * 0.36 * Math.cos(a2) + r * 0.225 * Math.cos(a3);
    const y = flock.altitude + 7 * Math.sin(a2) + 2.5 * Math.sin(a3);
    const dy = 14 * Math.cos(a2) + 7.5 * Math.cos(a3);
    return { x, z, dx, dz, ddx, ddz, y, dy };
  }

  setDaylight(daylight: number): void {
    this.daylight = daylight;
    this.bodyMaterial.opacity = 0.92 * daylight;
    this.wingMaterial.opacity = 0.92 * daylight;
    this.group.visible = daylight > 0.05;
  }

  update(dt: number, elapsed: number): void {
    if (!this.group.visible) return;
    void dt;
    let index = 0;
    for (const flock of this.flocks) {
      const angle = flock.orbit + elapsed * flock.speed;
      const direction = Math.sign(flock.speed);
      // A shared slow envelope keeps both wings in rhythm; only the trailing rows lag slightly.
      const flapEnv = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(elapsed * 0.31 + flock.phase));
      for (const [back, side] of this.offsets) {
        // back 为正的队尾距离：顺/逆时针都沿飞行方向的反向退位，不会越过领鸟。
        const along = angle - direction * back / flock.radius;
        const path = this.pathAt(flock, along);
        const tangentLength = Math.hypot(path.dx, path.dz) || 1;
        const tangentX = path.dx * direction / tangentLength;
        const tangentZ = path.dz * direction / tangentLength;
        const flap = Math.sin(elapsed * 8.5 + flock.phase - back * 0.035 + side * 0.002);
        const flapAngle = 0.12 + (0.1 + 0.85 * flapEnv) * flap;
        const normalX = -tangentZ;
        const normalZ = tangentX;
        const velocity = tangentLength * Math.abs(flock.speed);
        const turn = (path.dx * path.ddz - path.dz * path.ddx) * direction;
        const curvature = turn / Math.max(1, tangentLength * tangentLength * tangentLength);
        const bank = Math.max(-0.38, Math.min(0.38, Math.atan(curvature * velocity * velocity / 9.81)));
        const pitch = Math.atan2(path.dy * flock.speed, velocity || 1);
        this.position.set(
          this.center.x + path.x + normalX * side,
          path.y + flap * flock.bob,
          this.center.z + path.z + normalZ * side,
        );
        this.euler.set(bank + flap * 0.018, Math.atan2(-tangentZ, tangentX), pitch, "YXZ");
        this.birdQuaternion.setFromEuler(this.euler);
        this.scaleVector.setScalar(BIRD_SCALE * (0.96 + flap * 0.04));
        this.matrix.compose(this.position, this.birdQuaternion, this.scaleVector);
        this.bodyMesh.setMatrixAt(index, this.matrix);
        // 左翼：绕前进轴 (+x) 抬/压；右翼反相 + z 镜像——两翼同起同落。
        this.flapQuaternion.setFromAxisAngle(this.axisX, flapAngle);
        this.wingQuaternion.copy(this.birdQuaternion).multiply(this.flapQuaternion);
        this.wingMatrix.compose(this.position, this.wingQuaternion, this.scaleVector);
        this.wingMesh.setMatrixAt(index * 2, this.wingMatrix);
        this.flapQuaternion.setFromAxisAngle(this.axisX, -flapAngle);
        this.wingQuaternion.copy(this.birdQuaternion).multiply(this.flapQuaternion);
        this.wingMatrix.compose(this.position, this.wingQuaternion, this.scaleVector);
        this.wingMatrix.multiply(this.mirror);
        this.wingMesh.setMatrixAt(index * 2 + 1, this.wingMatrix);
        index += 1;
      }
    }
    this.bodyMesh.instanceMatrix.needsUpdate = true;
    this.wingMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.bodyMesh.geometry.dispose();
    this.wingMesh.geometry.dispose();
    this.bodyMaterial.dispose();
    this.wingMaterial.dispose();
    this.group.removeFromParent();
  }
}

/* ── 流星外观：直接移植 tinyskies MeteorShower.ts 的着色器（作者授权）──────────────────
 * 头：熔岩裂纹（噪声 → 暗岩/橙红/亮黄）；尾：沿锥体的流动噪声，前段火焰、后段淡成烟，普通 alpha 混合。
 * 原版的撞击（穹顶火球、冲击波环、火星）是「末日月亮」玩法，城市夜空里流星落地爆炸不合适，未移植。 */
const meteorNoiseGLSL = `
float hash3(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}
float noise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1.0,0.0,0.0)), f.x),
        mix(hash3(i + vec3(0.0,1.0,0.0)), hash3(i + vec3(1.0,1.0,0.0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0.0,0.0,1.0)), hash3(i + vec3(1.0,0.0,1.0)), f.x),
        mix(hash3(i + vec3(0.0,1.0,1.0)), hash3(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z);
}
`;
const meteorHeadFrag = `
uniform float uTime;
uniform float uOpacity;
varying vec3 vPos;
${meteorNoiseGLSL}
void main() {
  float n = noise3(vPos * 2.2 + uTime * 3.0);
  float crack = smoothstep(0.35, 0.6, n);
  vec3 rock = vec3(0.08, 0.03, 0.01);
  vec3 lava = mix(vec3(1.0, 0.2, 0.0), vec3(1.0, 0.9, 0.2), crack);
  gl_FragColor = vec4(mix(rock, lava, crack * 0.8 + 0.2), uOpacity);
}
`;
const meteorTrailFrag = `
uniform float uTime;
uniform float uOpacity;
varying vec2 vUv;
${meteorNoiseGLSL}
void main() {
  float fade = 1.0 - vUv.y;
  float n = noise3(vec3(vUv.x * 12.0, vUv.y * 6.0 - uTime * 15.0, uTime * 2.0));
  float core = smoothstep(0.2, 0.8, fade) * smoothstep(0.1, 0.9, n);
  vec3 fireCol = mix(vec3(1.0, 0.2, 0.0), vec3(1.0, 0.9, 0.3), core);
  vec3 smokeCol = vec3(0.08, 0.08, 0.08);
  float fireMix = smoothstep(0.3, 0.8, fade + n * 0.2);
  vec3 col = mix(smokeCol, fireCol, fireMix);
  float alpha = smoothstep(0.0, 0.2, fade) * n * uOpacity;
  alpha = clamp(mix(alpha * 1.5, alpha, fireMix), 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

/** 夜间流星：对象池 3 颗，按日期哈希决定「流星夜」（约三成夜晚），其余夜偶发孤星。外观见上。 */
class MeteorShower {
  private readonly pool: Array<{ mesh: THREE.Group; active: boolean; life: number; span: number; velocity: THREE.Vector3 }> = [];
  private readonly trailMaterial: THREE.ShaderMaterial;
  private readonly headMaterial: THREE.ShaderMaterial;
  private readonly glowMaterial: THREE.MeshBasicMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly timeU = { value: 0 };
  private countdown = 3;
  private interval = 1.2;
  private night = 0;
  private spawnCount = 0;
  readonly group = new THREE.Group();

  constructor(private radius: number, private readonly center: { x: number; z: number } = { x: 0, z: 0 }) {
    // 锥体：宽口（uv.y = 0，火焰最亮）在前、锥尖（uv.y = 1，淡成烟）在后。rotateX(-π/2) 把锥尖转到 -z，
    // 平移让宽口落在原点：lookAt 让 +z 指向速度方向后，头在前、尾拖在后。
    const trailGeometry = new THREE.ConeGeometry(2.4, 70, 16, 4, true).rotateX(-Math.PI / 2).translate(0, 0, -35);
    const headGeometry = new THREE.DodecahedronGeometry(2.2, 1);
    const position = headGeometry.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const r = 1 + (hashSeed(`meteor-rock:${i}`) - 0.5) * 0.1; // 原版 Math.random()：换成哈希，导出可复现
      position.setXYZ(i, position.getX(i) * r, position.getY(i) * r, position.getZ(i) * r);
    }
    headGeometry.computeVertexNormals();
    const glowGeometry = new THREE.SphereGeometry(5.5, 12, 8);
    this.geometries.push(trailGeometry, headGeometry, glowGeometry);
    this.trailMaterial = new THREE.ShaderMaterial({
      vertexShader: "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: meteorTrailFrag,
      uniforms: { uTime: this.timeU, uOpacity: { value: 1 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    this.headMaterial = new THREE.ShaderMaterial({
      vertexShader: "varying vec3 vPos;\nvoid main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: meteorHeadFrag,
      uniforms: { uTime: this.timeU, uOpacity: { value: 1 } },
      transparent: true, fog: false,
    });
    // 头部光晕（原版地面落点光环的空中版）：加色、进 bloom。
    this.glowMaterial = new THREE.MeshBasicMaterial({ color: "#ffba73", transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
    for (let index = 0; index < 3; index += 1) {
      const meteor = new THREE.Group();
      const trail = new THREE.Mesh(trailGeometry, this.trailMaterial);
      trail.renderOrder = 335;
      const head = new THREE.Mesh(headGeometry, this.headMaterial);
      head.renderOrder = 340;
      const glow = new THREE.Mesh(glowGeometry, this.glowMaterial);
      glow.renderOrder = 330;
      for (const part of [trail, head, glow]) part.frustumCulled = false;
      meteor.add(trail, glow, head);
      meteor.visible = false;
      this.group.add(meteor);
      this.pool.push({ mesh: meteor, active: false, life: 0, span: 2.6, velocity: new THREE.Vector3() });
    }
  }

  /** 发射序列与在飞流星回到初始（胶片导出开拍前）。 */
  reset(): void {
    this.countdown = 3;
    this.spawnCount = 0;
    this.timeU.value = 0;
    for (const meteor of this.pool) { meteor.active = false; meteor.life = 0; meteor.mesh.visible = false; }
  }

  setNight(night: number, nowMs: number): void {
    this.night = night;
    // 确定性流星夜：按「第几夜」哈希，约 30% 的夜晚有流星雨；回放同一晚必现。
    const nightIndex = Math.floor(nowMs / 86_400_000);
    const shower = hashSeed(`meteor-night:${nightIndex}`) < 0.3;
    this.interval = shower ? 1.35 : 7.5;
  }

  update(dt: number): void {
    this.timeU.value += dt;
    const active = this.night > 0.55;
    this.group.visible = active;
    if (!active) {
      for (const meteor of this.pool) meteor.mesh.visible = false;
      return;
    }
    this.countdown -= dt;
    if (this.countdown <= 0) {
      const free = this.pool.find((meteor) => !meteor.active);
      if (free) {
        // 发射参数走 seeded 序列（spawnCount 递增），同一次会话内可复现。
        const seed = hashSeed(`meteor-spawn:${this.spawnCount}`);
        this.spawnCount += 1;
        const reach = this.radius * (1.15 + seed * 0.5);
        const heading = seed * Math.PI * 2;
        // 绕城心（曾绕世界原点：城心偏离原点的岛，流星总在一侧）。
        free.mesh.position.set(this.center.x + Math.cos(heading) * reach, 560 + seed * 220, this.center.z + Math.sin(heading) * reach);
        free.velocity.set(-Math.cos(heading) * 150 - 60, -95 - seed * 45, -Math.sin(heading) * 150 + 40).normalize().multiplyScalar(230 + seed * 70);
        free.span = 2.2 + seed * 1.1;
        free.life = 0;
        free.active = true;
        free.mesh.visible = true;
      }
      this.countdown = this.interval * (0.7 + hashSeed(`meteor-gap:${this.spawnCount}`) * 0.6);
    }
    for (const meteor of this.pool) {
      if (!meteor.active) continue;
      meteor.life += dt;
      const age = meteor.life / meteor.span;
      if (age >= 1) { meteor.active = false; meteor.mesh.visible = false; continue; }
      meteor.mesh.position.addScaledVector(meteor.velocity, dt);
      const fade = Math.sin(age * Math.PI);
      meteor.mesh.scale.setScalar(0.5 + fade * 0.8);
      meteor.mesh.lookAt(meteor.mesh.position.clone().add(meteor.velocity));
    }
  }

  dispose(): void {
    this.geometries.forEach((geometry) => geometry.dispose());
    this.trailMaterial.dispose();
    this.headMaterial.dispose();
    this.glowMaterial.dispose();
    this.group.removeFromParent();
  }
}

/** 远火山：海平线远山中最高的那座冒烟——上升烟团缓慢膨胀漂移，夜里山口微光。 */
class VolcanoPlume {
  private readonly puffs: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly lifeAttr: THREE.InstancedBufferAttribute;
  private readonly nightU = { value: 0 };
  private readonly glow: THREE.Mesh;
  private readonly glowMaterial: THREE.MeshBasicMaterial;
  private readonly crater: THREE.Vector3;
  private readonly wind = new THREE.Vector3(4.2, 0, 2.6);
  private readonly ages: number[] = [];
  private readonly spans: number[] = [];
  readonly group = new THREE.Group();

  constructor(mountain: Mountain) {
    // buildSeaMountains 的锥中心在 y=0，峰值在 height/2。
    this.crater = new THREE.Vector3(mountain.center.x, mountain.height / 2, mountain.center.z);
    // 烟团：移植 tinyskies Volcano.ts 的公告板烟（作者授权）——始终正对相机的方片，径向软边，
    // 按寿命淡入（前 15%）淡出（后 50%）。曾是半透明球，怎么调都读作一串实心雪球（拍照实测）。
    // 颜色：原版是熔岩映红的暗红烟；这里白天是灰烟，夜里内圈带一点山口的红光。
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.lifeAttr = new THREE.InstancedBufferAttribute(new Float32Array(11), 1);
    geometry.setAttribute("aLife", this.lifeAttr);
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uOpacity: { value: 1 }, uNight: this.nightU },
      vertexShader: /* glsl */ `
        attribute float aLife;
        varying vec2 vUv;
        varying float vLife;
        void main() {
          vUv = uv;
          vLife = aLife;
          vec4 instancePos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec4 mvPos = modelViewMatrix * instancePos;
          float scaleX = length(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2]));
          float scaleY = length(vec3(instanceMatrix[1][0], instanceMatrix[1][1], instanceMatrix[1][2]));
          mvPos.xy += position.xy * vec2(scaleX, scaleY);
          gl_Position = projectionMatrix * mvPos;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform float uNight;
        varying vec2 vUv;
        varying float vLife;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          vec3 inner = mix(vec3(0.42, 0.43, 0.45), vec3(0.6, 0.12, 0.03), uNight * (1.0 - vLife));
          vec3 outer = mix(vec3(0.33, 0.34, 0.37), vec3(0.18, 0.12, 0.12), uNight);
          vec3 col = mix(inner, outer, smoothstep(0.0, 0.8, d));
          float lifeFade = smoothstep(0.0, 0.15, vLife) * (1.0 - smoothstep(0.5, 1.0, vLife));
          float alpha = (1.0 - smoothstep(0.3, 1.0, d)) * uOpacity * lifeFade;
          gl_FragColor = vec4(col * 1.2, alpha * 0.7); // 原版 0.45 是暗夜背景；白天浅色天空上要更实一点
        }`,
    });
    this.puffs = new THREE.InstancedMesh(geometry, this.material, 11);
    this.puffs.frustumCulled = false;
    // GTAO 的法线/深度预渲染用覆盖材质（scene.overrideMaterial）重画整个场景，只替点/线隐身：
    // 公告板的朝向在我们自己的顶点着色器里，覆盖材质下它们是没转向的方片——画面里一条条深色竖条（实测）。
    // 覆盖材质期间把实例数临时置 0 跳过绘制，画完恢复。
    this.puffs.onBeforeRender = (_renderer, scene) => { if (scene.overrideMaterial) this.puffs.count = 0; };
    this.puffs.onAfterRender = () => { this.puffs.count = 11; };
    this.puffs.name = "city-volcano-plume";
    for (let index = 0; index < 11; index += 1) {
      // 相位按序号均分（再加小抖动）：曾全用 hashSeed(`puff:${i}`)——末位数字不同的字符串哈希几乎相同，
      // 11 团同龄同寿命、永远叠成一个灰球。
      const span = 8 + (index % 4) * 1.3 + hashSeed(`puffspan:${index}`) * 0.6;
      this.spans.push(span);
      this.ages.push(((index / 11) + hashSeed(`puff:${index}`) * 0.04) * span);
    }
    this.glowMaterial = new THREE.MeshBasicMaterial({ color: "#ff5a2e", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
    this.glow = new THREE.Mesh(new THREE.SphereGeometry(4.5, 8, 6), this.glowMaterial);
    this.glow.position.copy(this.crater);
    this.group.add(this.puffs, this.glow);
  }

  setNight(night: number): void {
    this.glowMaterial.opacity = night * 0.3;
    this.nightU.value = night;
  }

  reset(): void {
    for (let index = 0; index < this.ages.length; index += 1) this.ages[index] = ((index / 11) + hashSeed(`puff:${index}`) * 0.04) * this.spans[index];
  }

  update(dt: number): void {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let index = 0; index < this.ages.length; index += 1) {
      // 取模而不是归零：一次长帧（后台标签页/首帧）会让所有烟团同时越过寿命、一起归零，
      // 之后 11 团永远叠成一个灰球（实测 10 团位置几乎重合）。取模保留各自的相位。
      this.ages[index] = (this.ages[index] + Math.min(dt, 0.5)) % this.spans[index];
      const age = this.ages[index] / this.spans[index];
      const rise = age * 58;
      position.copy(this.crater).addScaledVector(this.wind, age * this.spans[index]);
      position.y += rise;
      // 每团各自的侧向漂移（不再沿同一条直线叠成一串），越往上越大、越散。
      const drift = Math.sin(index * 2.399) * age * 14;
      position.x += drift * 0.8;
      position.z += Math.cos(index * 2.399) * age * 14 * 0.8;
      const size = 9 + age * 34; // 方片带软边，有效面积比球小，放大一些
      scale.set(size, size, 1);
      this.lifeAttr.setX(index, age);
      matrix.compose(position, new THREE.Quaternion(), scale);
      this.puffs.setMatrixAt(index, matrix);
    }
    this.puffs.instanceMatrix.needsUpdate = true;
    this.lifeAttr.needsUpdate = true;
  }

  dispose(): void {
    this.puffs.geometry.dispose();
    this.material.dispose();
    this.glow.geometry.dispose();
    this.glowMaterial.dispose();
    this.group.removeFromParent();
  }
}

/** 黄昏萤火虫：绿地/林区的闪烁点阵，暮色起亮、深夜渐弱。单 Points batch。 */
class Fireflies {
  private readonly material: THREE.ShaderMaterial;
  private readonly timeU = { value: 0 };
  private readonly nightU = { value: 0 };
  readonly points: THREE.Points;

  constructor(spots: Array<{ x: number; z: number; y: number }>, count = 130) {
    const picked: Array<{ x: number; z: number; y: number; seed: number }> = [];
    for (let index = 0; index < count && index < spots.length; index += 1) {
      // 按顺序取：调用方把公园/花园的落点排在最前。曾按哈希随机抽，公园只分到 ~19%、稀疏得看不见。
      const spot = spots[index % spots.length];
      picked.push({ ...spot, seed: hashSeed(`fireflyphase:${index}`) });
    }
    const positions = new Float32Array(picked.length * 3);
    const phases = new Float32Array(picked.length);
    picked.forEach((spot, index) => {
      positions[index * 3] = spot.x + (spot.seed - 0.5) * 6;
      positions[index * 3 + 1] = spot.y + 1.4 + spot.seed * 2.2;
      positions[index * 3 + 2] = spot.z + (hashSeed(`fireflyz:${index}`) - 0.5) * 6;
      phases[index] = spot.seed * Math.PI * 2;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.timeU, uNight: this.nightU },
      vertexShader: /* glsl */ `
        attribute float aPhase;
        uniform float uTime;
        varying float vGlow;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float blink = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(uTime * (1.4 + aPhase * 0.22) + aPhase * 6.28), 3.0);
          float drift = sin(uTime * 0.6 + aPhase * 4.0) * 0.5;
          mvPosition.y += drift;
          vGlow = blink;
          // ×4：50 单位外原来只有 ~2px，等于看不见（审计夜景公园里一只都找不到）；近处封顶 28px。
          gl_PointSize = min(28.0, (240.0 + blink * 184.0) / max(1.0, -mvPosition.z));
          gl_Position = projectionMatrix * mvPosition;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        varying float vGlow;
        void main() {
          float falloff = 1.0 - smoothstep(0.15, 0.5, length(gl_PointCoord - vec2(0.5)));
          vec3 warm = mix(vec3(0.82, 0.95, 0.45), vec3(1.0, 0.92, 0.5), vGlow);
          gl_FragColor = vec4(warm, vGlow * falloff * uNight);
        }`,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.name = "city-fireflies";
    this.points.frustumCulled = false;
  }

  setNight(night: number): void {
    // 暮色（stars~0.2-0.4）最盛，深夜稍弱但仍在——真实萤火虫的作息。
    this.nightU.value = Math.max(0, Math.min(1, (night - 0.06) / 0.2)) * (1 - night * 0.35);
  }

  update(dt: number, elapsed: number): void {
    this.timeU.value = elapsed;
    void dt;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
    this.points.removeFromParent();
  }
}

// 街区行人已退役：它们沿车行路网环线走（看着像在公路上走），且是刻意超比例的人偶（比楼还显眼）。
// 行人改成沙滩上的静态人物（cityParts.buildBeachLife），比例与躺椅一致。

export class CityWildlife {
  private readonly birds: BirdFlocks;
  private readonly meteors: MeteorShower;
  private readonly volcano: VolcanoPlume | null;
  private readonly fireflies: Fireflies | null;
  readonly group = new THREE.Group();

  constructor(center: { x: number; z: number }, radius: number, parkTrees: Array<{ x: number; z: number; y: number }>, seaMountains: Mountain[], carPaths: Array<Array<{ x: number; z: number }>>, ground: (x: number, z: number) => number) {
    this.birds = new BirdFlocks(center, radius);
    this.group.add(this.birds.group);
    this.meteors = new MeteorShower(radius, center);
    this.group.add(this.meteors.group);
    const volcanoMountain = [...seaMountains].sort((a, b) => b.height - a.height)[0];
    this.volcano = volcanoMountain ? new VolcanoPlume(volcanoMountain) : null;
    if (this.volcano) this.group.add(this.volcano.group);
    this.fireflies = parkTrees.length ? new Fireflies(parkTrees) : null;
    if (this.fireflies) this.group.add(this.fireflies.points);
  }

  setNight(night: number, nowMs: number): void {
    this.birds.setDaylight(1 - night);
    this.meteors.setNight(night, nowMs);
    this.volcano?.setNight(night);
    this.fireflies?.setNight(night);
  }

  /** 随帧累加的状态（流星发射序列、火山烟团年龄）回到构造时：胶片导出从同一状态开拍。
   *  鸟群与萤火虫只由 elapsed 决定，不需要重置。 */
  reset(): void {
    this.meteors.reset();
    this.volcano?.reset();
  }

  update(dt: number, elapsed: number): void {
    this.birds.update(dt, elapsed);
    this.meteors.update(dt);
    this.volcano?.update(dt);
    this.fireflies?.update(dt, elapsed);
  }

  dispose(): void {
    this.birds.dispose();
    this.meteors.dispose();
    this.volcano?.dispose();
    this.fireflies?.dispose();
    this.group.removeFromParent();
  }
}
