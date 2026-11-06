/**
 * 环境氛围组：海面水龙卷、城市上空的热气球、夜间水上浮灯。
 * 手法参考 tinyskies/GlobeFly（作者授权参考其代码）：水龙卷的 twisting/sway
 * 顶点注入来自 WaterSpouts，浮灯的"缓慢升空 + 暖光"来自 FloatingLanterns，
 * 热气球为低模自建。全部廉价几何，数量固定，昼夜联动。
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { hashSeed } from "../cityModel";

/** 海面水龙卷：半透明水柱（顶点扭转+摆动）+ 底部浪环，缓慢漂移、周期隐现。 */
class SeaSpout {
  private readonly material: THREE.MeshBasicMaterial;
  readonly mesh: THREE.Mesh;
  private readonly timeU = { value: 0 };
  private phase: number;
  private readonly drift: { x: number; z: number };
  private readonly radius: number;
  private readonly speed: number;
  /** 夜晚程度：水龙卷是被日光照亮的水雾，夜里曾照样是一根亮白的锥（审计夜景实测）。 */
  night = 0;

  constructor(private center: { x: number; z: number }, angle: number, seed: number, private terrainHeight: (x: number, z: number) => number) {
    this.phase = seed * Math.PI * 2;
    this.radius = 0.55 + seed * 0.45;
    this.speed = 0.1 + seed * 0.08;
    this.drift = { x: Math.cos(angle), z: Math.sin(angle) };
    const height = 60 + seed * 40;
    const geometry = new THREE.CylinderGeometry(11, 2.6, height, 20, 10, true).translate(0, height / 2, 0);
    this.material = new THREE.MeshBasicMaterial({
      color: 0xdcf6ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.material.defines = { USE_UV: "" };
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.time = this.timeU;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float time;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          // 扭转 + 摆动（参考 WaterSpouts 的顶点注入）
          float twist = uv.y * 5.0 + time * 0.6;
          float s = sin(twist);
          float c = cos(twist);
          transformed.xz = mat2(c, -s, s, c) * transformed.xz;
          transformed.x += sin(time * 1.7 + uv.y * 3.2) * 2.4 * uv.y;
          transformed.z += cos(time * 1.4 + uv.y * 3.9) * 2.4 * uv.y;`);
    };
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = "city-sea-spout";
    this.mesh.position.set(center.x, 0, center.z);
  }

  update(dt: number, elapsed: number): void {
    this.timeU.value += dt;
    // 缓慢绕锚点漂移 + 周期性隐现（~50s 一轮）。
    const cycle = (elapsed * this.speed + this.phase) % (Math.PI * 2);
    const presence = Math.max(0, Math.sin(cycle));
    this.material.opacity = 0.38 * presence * (1 - this.night * 0.8);
    this.mesh.visible = presence > 0.03;
    // 位置不论隐现都写：曾隐藏时提前返回，矩阵停在上一次可见的样子，两次导出不同。
    const orbit = elapsed * 0.03 + this.phase;
    const x = this.center.x + Math.cos(orbit) * 18 + this.drift.x * Math.sin(elapsed * 0.05 + this.phase) * 30;
    const z = this.center.z + Math.sin(orbit) * 18 + this.drift.z * Math.sin(elapsed * 0.05 + this.phase) * 30;
    this.mesh.position.set(x, this.terrainHeight(x, z), z);
    this.mesh.rotation.y = elapsed * 0.5 + this.phase;
  }

  reset(): void {
    this.timeU.value = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

/** 热气球：分片色带气囊、收口、细吊索和锥台篮筐；固定低模，缓慢漂移。 */
class HotAirBalloon {
  readonly group = new THREE.Group();
  private readonly envelope: THREE.Mesh;
  private readonly envelopeMaterial: THREE.MeshLambertMaterial;
  private readonly basketMaterial: THREE.MeshLambertMaterial;
  private readonly burnerMaterial: THREE.MeshLambertMaterial;
  private readonly envelopeLight: THREE.PointLight;
  private readonly basketLight: THREE.PointLight;
  private readonly baseY: number;
  private readonly rise: number;
  private readonly sway: number;
  private t: number;
  private readonly t0: number;
  private readonly spawn: { x: number; z: number };

  constructor(spawn: { x: number; z: number }, color: string, seed: number) {
    this.t = seed * 120;
    this.t0 = this.t;
    this.spawn = { ...spawn };
    this.rise = 1.6 + seed * 1.4;
    this.sway = 0.4 + seed * 0.6;
    // 尺度统一（G3）：曾整只 ~30 高、悬在 70–110，比楼还大（多视角评估）。整体缩到 0.55，高度随之下调。
    this.baseY = 48 + seed * 26;
    const envelopeGeometry = new THREE.LatheGeometry([
      new THREE.Vector2(0.12, 0), new THREE.Vector2(0.42, 0.7),
      new THREE.Vector2(1.5, 1.8), new THREE.Vector2(4.5, 3.6),
      new THREE.Vector2(7.5, 6.8), new THREE.Vector2(8.8, 10.5),
      new THREE.Vector2(8.7, 14), new THREE.Vector2(7.4, 17.2),
      new THREE.Vector2(5.2, 19.7), new THREE.Vector2(2.8, 21.2),
      new THREE.Vector2(0.3, 22),
    ], 16);
    const base = new THREE.Color(color);
    const light = base.clone().lerp(new THREE.Color("#fff2d5"), 0.58);
    const shadow = base.clone().lerp(new THREE.Color("#26374d"), 0.24);
    const positions = envelopeGeometry.getAttribute("position");
    const colors = new Float32Array(positions.count * 3);
    for (let vertex = 0; vertex < positions.count; vertex += 1) {
      const angle = Math.atan2(positions.getZ(vertex), positions.getX(vertex));
      const gore = Math.floor((((angle / (Math.PI * 2)) + 1) % 1) * 16);
      const panel = gore % 4 === 0 ? light : gore % 4 === 1 ? base : gore % 4 === 2 ? shadow : base;
      colors[vertex * 3] = panel.r; colors[vertex * 3 + 1] = panel.g; colors[vertex * 3 + 2] = panel.b;
    }
    envelopeGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.envelopeMaterial = new THREE.MeshLambertMaterial({ color: "#ffffff", vertexColors: true, flatShading: true, emissive: "#ff994d", emissiveIntensity: 0 });
    this.envelope = new THREE.Mesh(envelopeGeometry, this.envelopeMaterial);
    this.envelope.position.y = 8;
    this.envelope.castShadow = true;
    // 四根向气囊收口汇聚的细索代替原来像一整块柱体的粗“绳架”。
    const cableParts: THREE.BufferGeometry[] = [];
    for (const x of [-1, 1]) for (const z of [-1, 1]) {
      const lower = new THREE.Vector3(x * 1.05, 1.25, z * 1.05);
      const upper = new THREE.Vector3(x * 0.25, 8.65, z * 0.25);
      const direction = upper.clone().sub(lower);
      const cable = new THREE.CylinderGeometry(0.055, 0.08, direction.length(), 5);
      const pose = new THREE.Matrix4().compose(
        lower.clone().add(upper).multiplyScalar(0.5),
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()),
        new THREE.Vector3(1, 1, 1),
      );
      cable.applyMatrix4(pose);
      cableParts.push(cable);
    }
    const ropesGeometry = mergeGeometries(cableParts);
    cableParts.forEach((part) => part.dispose());
    const ropesMaterial = new THREE.MeshLambertMaterial({ color: "#665344" });
    const ropes = new THREE.Mesh(ropesGeometry, ropesMaterial);
    const basketGeometry = new THREE.CylinderGeometry(1.5, 1.18, 2.6, 4, 5).rotateY(Math.PI / 4);
    const basketColors = new Float32Array(basketGeometry.getAttribute("position").count * 3);
    const basketPosition = basketGeometry.getAttribute("position");
    for (let vertex = 0; vertex < basketPosition.count; vertex += 1) {
      const band = Math.floor((basketPosition.getY(vertex) + 1.3) * 2.8);
      const weave = band % 2 === 0 ? new THREE.Color("#9b704a") : new THREE.Color("#775337");
      basketColors[vertex * 3] = weave.r; basketColors[vertex * 3 + 1] = weave.g; basketColors[vertex * 3 + 2] = weave.b;
    }
    basketGeometry.setAttribute("color", new THREE.BufferAttribute(basketColors, 3));
    this.basketMaterial = new THREE.MeshLambertMaterial({ color: "#ffffff", vertexColors: true, flatShading: true, emissive: "#ffae63", emissiveIntensity: 0 });
    const basket = new THREE.Mesh(basketGeometry, this.basketMaterial);
    const burnerGeometry = new THREE.IcosahedronGeometry(0.3, 0);
    this.burnerMaterial = new THREE.MeshLambertMaterial({ color: "#e98936", emissive: "#ff8b36", emissiveIntensity: 0 });
    const burner = new THREE.Mesh(burnerGeometry, this.burnerMaterial);
    burner.position.set(0, 1.55, 0);
    this.envelopeLight = new THREE.PointLight("#ffb766", 0, 125, 2);
    this.envelopeLight.position.set(0, 17, 0);
    this.envelopeLight.castShadow = false;
    this.envelopeLight.visible = false;
    this.basketLight = new THREE.PointLight("#ffbd76", 0, 48, 2);
    this.basketLight.position.set(0, 4.2, 0);
    this.basketLight.castShadow = false;
    this.basketLight.visible = false;
    this.group.add(this.envelope, basket, ropes, burner, this.envelopeLight, this.basketLight);
    this.group.position.set(spawn.x, this.baseY, spawn.z);
    this.group.scale.setScalar(0.55);
    this.group.name = "city-hot-air-balloon";
    this.geometries = [envelopeGeometry, basketGeometry, ropesGeometry];
    this.geometries.push(burnerGeometry);
    this.materials = [this.envelopeMaterial, this.basketMaterial, ropesMaterial, this.burnerMaterial];
  }

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  /** 位置是逐帧积分的（x/z += sway），重置必须连位置一起放回出生点。 */
  reset(): void {
    this.t = this.t0;
    this.group.position.set(this.spawn.x, this.baseY, this.spawn.z);
    this.group.rotation.set(0, 0, 0);
  }

  update(dt: number): void {
    this.t += dt;
    this.group.position.y = this.baseY + Math.sin(this.t * 0.05 * this.rise) * 55;
    this.group.position.x += Math.sin(this.t * 0.03) * 0.16 * this.sway;
    this.group.position.z += Math.cos(this.t * 0.026) * 0.14 * this.sway;
    this.group.rotation.z = Math.sin(this.t * 0.11) * 0.05;
    this.group.rotation.x = Math.cos(this.t * 0.09) * 0.04;
  }

  setNight(night: number): void {
    this.envelopeMaterial.emissiveIntensity = night * 0.62;
    this.basketMaterial.emissiveIntensity = night * 0.28;
    this.burnerMaterial.emissiveIntensity = night * 1.7;
    this.envelopeLight.intensity = night * 24;
    this.envelopeLight.visible = night > 0.02;
    this.basketLight.intensity = night * 6;
    this.basketLight.visible = night > 0.02;
  }

  dispose(): void {
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.group.removeFromParent();
  }
}

/** 夜间水上浮灯：暖光小灯 instanced，随夜色淡入，缓慢升空漂移（参考 FloatingLanterns）。 */
class NightLanterns {
  readonly mesh: THREE.InstancedMesh;
  private readonly lanterns: Array<{ x: number; z: number; y: number; y0: number; rise: number; drift: number; phase: number }> = [];
  private night = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();

  constructor(center: { x: number; z: number }, radius: number, river: Array<{ x: number; z: number }> | null, count = 42) {
    const geometry = new THREE.SphereGeometry(1.1, 8, 6);
    const material = new THREE.MeshBasicMaterial({ color: "#ffca7a", transparent: true, opacity: 0, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.frustumCulled = false;
    this.mesh.name = "city-night-lanterns";
    this.mesh.visible = false;
    for (let index = 0; index < count; index += 1) {
      const seed = hashSeed(`lantern:${index}`);
      let x: number;
      let z: number;
      if (river && river.length > 4 && index % 2 === 0) {
        const point = river[Math.floor(seed * river.length)];
        x = point.x + (seed - 0.5) * 26;
        z = point.z + (hashSeed(`lz:${index}`) - 0.5) * 26;
      } else {
        const angle = seed * Math.PI * 2;
        const reach = radius * (0.9 + hashSeed(`lr:${index}`) * 0.5);
        x = center.x + Math.cos(angle) * reach;
        z = center.z + Math.sin(angle) * reach;
      }
      this.lanterns.push({ x, z, y: 3 + seed * 6, y0: 3 + seed * 6, rise: 0.5 + hashSeed(`lri:${index}`) * 0.9, drift: seed * Math.PI * 2, phase: seed * Math.PI * 2 });
    }
    this.geometry = geometry;
    this.material = material;
  }

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.Material & { opacity: number };

  setNight(night: number): void {
    this.night = night;
    this.material.opacity = 0.9 * night;
    this.mesh.visible = night > 0.03;
  }

  reset(): void {
    for (const lantern of this.lanterns) lantern.y = lantern.y0;
  }

  // 白天也推进与写矩阵（42 个实例，开销可忽略）：曾只在夜里写，矩阵留着上一个夜晚的样子。
  update(dt: number, elapsed: number): void {
    this.lanterns.forEach((lantern, index) => {
      lantern.y += lantern.rise * dt * 1.6;
      if (lantern.y > 90) lantern.y = 2.5;
      const bob = Math.sin(elapsed * 0.5 + lantern.phase) * 0.8;
      this.position.set(lantern.x + Math.sin(elapsed * 0.04 + lantern.drift) * 9, lantern.y + bob, lantern.z + Math.cos(elapsed * 0.05 + lantern.drift) * 9);
      const pulse = 0.8 + 0.25 * Math.sin(elapsed * 1.6 + lantern.phase);
      this.scale.setScalar(pulse);
      this.quaternion.identity();
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.mesh.setMatrixAt(index, this.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

/** 引擎侧的统一入口：创建/更新/昼夜联动/释放。 */
export class CityAmbient {
  private readonly spouts: SeaSpout[] = [];
  private readonly balloons: HotAirBalloon[] = [];
  private lanterns: NightLanterns | null = null;
  readonly group = new THREE.Group();

  constructor(center: { x: number; z: number }, radius: number, terrainHeight: (x: number, z: number) => number, river: Array<{ x: number; z: number }> | null) {
    // 两个水龙卷锚在城外海面（对角方向）。
    for (let index = 0; index < 2; index += 1) {
      const angle = index * 2.4 + 0.7;
      // 沿这个方向往外走，找到「锚点及其漂移范围（±50）内全是水」的第一个位置。
      // 曾固定 1.55×(0.6R) ≈ 0.93R：种子岛形状各异，水龙卷常落在山坡/陆地上（审计夜景实测）。
      let reach = radius * 1.55;
      const dry = (r: number) => {
        for (let k = 0; k < 8; k += 1) {
          const a = (k / 8) * Math.PI * 2;
          if (terrainHeight(center.x + Math.cos(angle) * r + Math.cos(a) * 50, center.z + Math.sin(angle) * r + Math.sin(a) * 50) > -0.5) return true;
        }
        return terrainHeight(center.x + Math.cos(angle) * r, center.z + Math.sin(angle) * r) > -0.5;
      };
      while (dry(reach) && reach < radius * 6) reach += 20;
      const spout = new SeaSpout({ x: center.x + Math.cos(angle) * reach, z: center.z + Math.sin(angle) * reach }, angle, hashSeed(`spout:${index}`), terrainHeight);
      this.spouts.push(spout);
      this.group.add(spout.mesh);
    }
    // 三只热气球从城边低空起。
    const palette = ["#d96a4e", "#4e96b8", "#d9a94e"];
    for (let index = 0; index < 3; index += 1) {
      const seed = hashSeed(`balloon:${index}`);
      // 三只按 120° 分开再加抖动：曾 angle = seed·2π，固定字符串的哈希恰好挤在一起，三个气球叠成一团。
      const angle = (index / 3) * Math.PI * 2 + seed * 0.9;
      const reach = radius * (0.5 + ((index * 0.37 + seed) % 1) * 0.45);
      const balloon = new HotAirBalloon({ x: center.x + Math.cos(angle) * reach, z: center.z + Math.sin(angle) * reach }, palette[index], seed);
      this.balloons.push(balloon);
      this.group.add(balloon.group);
    }
    this.lanterns = new NightLanterns(center, radius, river);
    this.group.add(this.lanterns.mesh);
  }

  setNight(night: number): void {
    this.lanterns?.setNight(night);
    this.balloons.forEach((balloon) => balloon.setNight(night));
    for (const spout of this.spouts) {
      spout.night = night;
      (spout.mesh.material as THREE.MeshBasicMaterial).color.setRGB(0.86, 0.96, 1).multiplyScalar(1 - night * 0.75);
    }
  }

  /** 所有随帧累加的状态回到构造时（胶片导出开拍前）。 */
  reset(): void {
    this.spouts.forEach((spout) => spout.reset());
    this.balloons.forEach((balloon) => balloon.reset());
    this.lanterns?.reset();
  }

  update(dt: number, elapsed: number): void {
    for (const spout of this.spouts) spout.update(dt, elapsed);
    for (const balloon of this.balloons) balloon.update(dt);
    this.lanterns?.update(dt, elapsed);
  }

  dispose(): void {
    this.spouts.forEach((spout) => spout.dispose());
    this.balloons.forEach((balloon) => balloon.dispose());
    this.lanterns?.dispose();
    this.group.removeFromParent();
  }
}
