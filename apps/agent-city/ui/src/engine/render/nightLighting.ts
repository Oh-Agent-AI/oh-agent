/**
 * 夜景照明系统（路灯 / 光斑 / 灯带 / 霓虹 / 昼夜亮度驱动）：自 cityParts.ts 原样搬出（纯搬迁，见 docs/CITY_ENGINE_SPLIT_SPEC.md）。
 * 函数体与原方法逐字一致，仅 `this.` → `host.`；host 是 CityParts 本身，下面的接口只列出这里实际用到的成员。
 */
import { m, REAL } from "../worldScale";
import * as THREE from "three";
import { battleClarityPresentation } from "../battleClarity";
import { LIGHT_BUDGET, lampTier, nightFactor, windowRate } from "../cityLightBudget";
import { CAR_LAMP_FADE_FAR, CAR_LAMP_FADE_NEAR, carPoolFadeUniforms } from "./drivingStreetLights";
import type { CityTheme } from "../cityTheme";
import { roadPaintPlan } from "../cityRoadPaint";
import { pavementIndex, renderRoadEdges } from "../cityRoadJunctions";
import { createRenderCanvas } from "../renderCanvas";
import type { CityLayout } from "../cityLayout";
import { culDeSacBulbRadius } from "../systems/roadSystem";
import { BOX, EXPRESSWAY_DECK_THICKNESS, EXPRESSWAY_DECK_WIDTH } from "./shared";
import { expresswayRun } from "../surface/structureCompiler";
import type { NightLights } from "./types";
import { streetLightPoolGeometry } from "./streetLightPools";

/** 立面 uniforms 里夜景用到的那几项（完整 FacadeUniforms 仍在 cityParts.ts，另一路搬迁中，这里只取结构子集）。 */
type NightFacadeUniforms = {
  uSelfLit: { value: number };
  uWindowGlow: { value: number };
  uRateRes: { value: number };
  uRateOff: { value: number };
  uGradeAmount: { value: number };
};

export interface NightHost {
  layout: CityLayout;
  theme: CityTheme;
  group: THREE.Group;
  disposables: Array<{ dispose: () => void }>;
  nightLights: NightLights | null;
  nightHour: number;
  nightGlow: number;
  battleClarity?: boolean;
  facadeUniforms: NightFacadeUniforms[];
  terrainUniforms: Record<string, { value: unknown }> | null;
  waterAssetUniforms: Record<string, { value: unknown }> | null;
  heroParts: { spire: THREE.Mesh; rings: THREE.Mesh[]; beam: THREE.Mesh | null } | null;
  landmarkWindows: Array<{ material: THREE.MeshLambertMaterial; day: THREE.Texture; lit: THREE.Texture; dayEmissive: THREE.Color }>;
  lifeguardGlowMaterial: THREE.MeshBasicMaterial | null;
  signageNeonMaterial: THREE.MeshBasicMaterial | null;
  matrix: THREE.Matrix4;
  color: THREE.Color;
  compose(x: number, y: number, z: number, rotationY: number, sx: number, sy: number, sz: number): void;
  makeInstanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh;
  applyNightOverlay(): void;
}

export function setNightHour(host: NightHost, hour: number): void {
  host.nightHour = hour;
  const res = windowRate(hour, "residential"); const off = windowRate(hour, "office");
  for (const uniforms of host.facadeUniforms) { uniforms.uRateRes.value = res; uniforms.uRateOff.value = off; }
  host.applyNightOverlay();
}

export function applyNightOverlay(host: NightHost): void {
  const night = nightFactor(host.nightGlow);
  const t = host.terrainUniforms;
  if (t) {
    t.uNightDim.value = night;
    t.uSpillGain.value = night * LIGHT_BUDGET.overlay.gain * (0.4 + 0.6 * Math.max(windowRate(host.nightHour, "residential"), windowRate(host.nightHour, "office")));
  }
  const w = host.waterAssetUniforms as unknown as Record<string, { value: unknown }> | null;
  if (w?.uSpillGain && t) w.uSpillGain.value = t.uSpillGain.value;
}

export function setNightWater(host: NightHost, night: number): void {
  if (host.waterAssetUniforms) host.waterAssetUniforms.uNight.value = night;
}

export function setSkyMix(host: NightHost, dayMix: number): void {
  const amount = host.theme.skyGrade.amount * (1 - dayMix);
  if (host.waterAssetUniforms) host.waterAssetUniforms.uGradeAmount.value = amount;
  for (const uniforms of host.facadeUniforms) uniforms.uGradeAmount.value = amount;
}

/** 开车模式解析街灯（N5）与 buildNightLights 共用的灯位描述：一份表、两个消费者
 *  （实例矩阵写入 / 解析光源选取），谁也不许再各算一套——night-street 的教训是
 *  三份「恰好一致」的字面量最终必然漂移。 */
export type StreetLampPlan = {
  /** 灯杆脚（flat 高架灯 = 桥面板顶）。 */
  x: number; z: number; base: number;
  /** 路面法向（从路中心指向灯杆侧）：灯头/光斑往 −n 侧探出，解析灯发射轴也朝 −n 下倾。 */
  nx: number; nz: number;
  /** 路段走向（灯头实例 yaw）。 */
  yaw: number;
  /** 光斑中心从灯杆往路心的偏移 / 档位缩放前的光斑半径（写实例时再乘档位）。 */
  poolReach: number; poolRadius: number;
  /** 道路等级（lampTier）：光斑半径与亮度同乘。 */
  tier: number;
  /** 高架灯：光斑平贴桥面，不采样桥下地面坡度。 */
  flat: boolean;
  /** warm-up 哈希种子（灯位拼接，确定性：同一盏灯每帧同色）。 */
  seed: number;
  /** 灯头光学中心：与灯头实例同一公式（臂长 0.45、高度 m(REAL.lamp.height)−0.05）。 */
  hx: number; hy: number; hz: number;
};

/** 全部灯位的纯函数（确定性：同一 layout 恒同序同值）。四段摆灯循环自 buildNightLights
 *  原样搬出，只把「写实例矩阵」换成「收集描述符」——scene-baseline golden 靠同源同序
 *  守住实例矩阵逐字节不变。 */
export function planStreetLamps(layout: CityLayout): StreetLampPlan[] {
  const plan: StreetLampPlan[] = [];
  const add = (x: number, z: number, nx: number, nz: number, base: number, yaw: number, poolReach: number, poolRadius: number, tier: number, flat: boolean) => {
    const height = m(REAL.lamp.height);
    plan.push({ x, z, base, nx, nz, yaw, poolReach, poolRadius, tier, flat, seed: x * 12.9898 + z * 78.233, hx: x - nx * 0.45, hy: base + height - 0.05, hz: z - nz * 0.45 });
  };
  const spacing = 30;
  // 沿合并后的整条路（roadPaintPlan 的 run）按弧长每 30 放一盏，间距跨路段累计。曾逐条路段放、
  // 且跳过 <18 的段：滨海大道细分成 ~15 的短段，整条一盏灯都没有（真机夜景：海滨道路漆黑）。
  const roadEdges = renderRoadEdges(layout.roadEdges);
  // 灯位落在别的路面上（路口内、折角外侧——灯沿本路偏移线走，过弯 / 进路口时会跑到相邻路面中间）就跳过这一盏，
  // 间距照常累计。真机：路口沥青正中立着灯杆。
  const pavement = pavementIndex(roadEdges);
  for (const run of roadPaintPlan(roadEdges).runs) {
    if (run.kind !== "arterial") continue;
    const tier = lampTier(run.width);
    let walked = 0; let next = spacing / 2; let index = 0;
    for (let i = 1; i < run.points.length; i += 1) {
      const a = run.points[i - 1]; const b = run.points[i];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-3) continue;
      const dx = (b.x - a.x) / length; const dz = (b.z - a.z) / length;
      const nx = -dz; const nz = dx;
      const yaw = -Math.atan2(dz, dx);
      while (next <= walked + length) {
        const t = next - walked;
        const side = index % 2 === 0 ? 1 : -1; // 两侧交错
        const x = a.x + dx * t + nx * side * (run.width / 2 + 0.9);
        const z = a.z + dz * t + nz * side * (run.width / 2 + 0.9);
        if (!pavement.covers({ x, z })) add(x, z, nx * side, nz * side, Math.max(0, layout.terrain.height(x, z)), yaw, 3.2, 9.5, tier, false);
        next += spacing * (tier >= 1 ? 1 : tier >= 0.6 ? 1.2 : 1.5); index += 1;
      }
      walked += length;
    }
  }
  // 公园：沿园路一圈路灯（外圈 8 盏），灯头朝内。
  for (const site of layout.publicSites) {
    if (site.kind !== "park") continue;
    const ring = Math.max(10, site.radius * 0.7);
    for (let i = 0; i < 8; i += 1) {
      const t = (i / 8) * Math.PI * 2;
      const ox = Math.cos(t); const oz = Math.sin(t);
      const x = site.x + ox * ring; const z = site.z + oz * ring;
      add(x, z, ox, oz, Math.max(0, layout.terrain.height(x, z)), -Math.atan2(ox, -oz) + Math.PI / 2, 3.2, 9.5, 1, false);
    }
  }
  // 尽端回车圈的守夜灯（形态批 §5-3）：挂最低档（lampTier 体系 0.45 档）——夜里回车圈微亮。
  // 灯杆立在圈边、垂直于来路方向，光斑落回圆心（nx/nz 指向圆心）。
  for (const end of layout.culDeSacEnds ?? []) {
    const id = `${end.x}:${end.z}`;
    const incident = layout.roadEdges.find((edge) => !edge.bridge && (edge.from === id || edge.to === id));
    if (!incident) continue;
    const other = incident.points[incident.from === id ? 1 : 0];
    const length = Math.hypot(end.x - other.x, end.z - other.z) || 1;
    const dx = (end.x - other.x) / length; const dz = (end.z - other.z) / length;
    const nx = -dz; const nz = dx;
    const radius = culDeSacBulbRadius(incident.width);
    const x = end.x + nx * (radius - 0.9); const z = end.z + nz * (radius - 0.9);
    add(x, z, nx, nz, Math.max(0, layout.terrain.height(x, z)), -Math.atan2(dz, dx), 3.2, 9.5, 0.45, false);
  }
  // 高架：桥面两侧交错路灯，灯头朝路中心。立在行车面（板顶）上；光斑圆心落到桥面中线、
  // 半径不超过半幅桥宽——地面路灯的 9.5 光斑在 10.5 宽桥面上大半悬空，看起来是灯光穿透到桥下。
  for (const highway of layout.highways ?? []) {
    const { points: run, heights } = expresswayRun(layout, highway);
    let carry = 0;
    for (let i = 1; i < run.length; i += 1) {
      const a = run[i - 1]; const b = run[i];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1) continue;
      const dx = (b.x - a.x) / length; const dz = (b.z - a.z) / length;
      const yaw = -Math.atan2(dz, dx);
      for (let t = 14 - carry; t < length; t += 34) {
        const side = Math.floor((t + length * 0.37 + a.x) / 34) % 2 === 0 ? 1 : -1;
        const deckTop = heights[i - 1] + (heights[i] - heights[i - 1]) * (t / length) + EXPRESSWAY_DECK_THICKNESS;
        add(a.x + dx * t - dz * side * 5.1, a.z + dz * t + dx * side * 5.1, -dz * side, dx * side, deckTop, yaw, 5.1, EXPRESSWAY_DECK_WIDTH / 2 - 0.3, 1, true);
      }
      carry = (length - (14 - carry)) % 34;
    }
  }
  return plan;
}

export function buildNightLights(host: NightHost): NightLights {
  const heads = new THREE.MeshBasicMaterial({ color: "#ffc773", toneMapped: false });
  // 光斑用径向渐变贴图（中心亮、边缘衰减到 0）：纯色圆片在夜里像一个个米色沙盘圆点，不像灯光。
  const glow = createRenderCanvas();
  glow.width = glow.height = 64;
  const gctx = glow.getContext("2d");
  if (gctx) {
    const gradient = gctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.45)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    gctx.fillStyle = gradient;
    gctx.fillRect(0, 0, 64, 64);
  }
  const glowTexture = new THREE.CanvasTexture(glow);
  const pools = new THREE.MeshBasicMaterial({ color: "#ff9e4d", map: glowTexture, transparent: true, depthWrite: false, depthTest: true, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12, vertexColors: true, blending: THREE.AdditiveBlending, toneMapped: false });
  // N5 开车模式交叉淡化：解析街灯在相机周边接管后，贴纸光斑在 FADE_NEAR..FADE_FAR 带内
  // 按片元到相机距离让位（与解析光的按灯距离淡入互补，总量近似守恒）。非开车模式
  // uPoolFadeOn 恒 0，材质行为与从前逐位一致。
  pools.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, carPoolFadeUniforms());
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vPoolWorld;")
      .replace("#include <project_vertex>", `#include <project_vertex>
#ifdef USE_INSTANCING
  vPoolWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vPoolWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vPoolWorld;
uniform vec3 uPoolFadeCenter;
uniform float uPoolFadeOn;`)
      .replace("#include <map_fragment>", `#include <map_fragment>
  if (uPoolFadeOn > 0.5) { diffuseColor.rgb *= smoothstep(${CAR_LAMP_FADE_NEAR.toFixed(1)}, ${CAR_LAMP_FADE_FAR.toFixed(1)}, distance(vPoolWorld.xz, uPoolFadeCenter.xz)); }`);
  };
  pools.customProgramCacheKey = () => "city-night-pools";
  host.disposables.push(glowTexture);
  pools.visible = false;
  const strips = new THREE.MeshBasicMaterial({ color: "#ffb366", toneMapped: false });
  const neon = new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false });
  const poles = host.makeInstanced(new THREE.CylinderGeometry(0.1, 0.14, 1, 5).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: "#59636a" }), 4600);
  const headMesh = host.makeInstanced(new THREE.BoxGeometry(0.5, 0.22, 0.9), heads, 4600);
  const stripMesh = host.makeInstanced(BOX, strips, 2200);
  // 灯位自纯函数表（与开车模式解析街灯同一份）；截到实例容量，多出的候选没有可见几何。
  const plan = planStreetLamps(host.layout).slice(0, 4600);
  let lamps = 0;
  const lamp = (p: StreetLampPlan) => {
    if (lamps >= 4600) return;
    headMesh.setColorAt(lamps, host.color.setScalar(0.5 + 0.5 * p.tier));
    // 杆高 8 m（REAL.lamp）：行车道路灯 6–10 m。灯头同步，光斑半径/落点不动。
    host.compose(p.x, p.base, p.z, 0, 1, m(REAL.lamp.height), 1);
    poles.setMatrixAt(lamps, host.matrix);
    // 灯头悬在路中心一侧（臂长 0.7），朝路面。
    host.compose(p.x - p.nx * 0.45, p.base + m(REAL.lamp.height) - 0.05, p.z - p.nz * 0.45, p.yaw, 1, 1, 1); // 灯头长 0.9：一端贴住灯杆，不再悬空
    headMesh.setMatrixAt(lamps, host.matrix);
    lamps += 1;
  };
  for (const p of plan) lamp(p);
  poles.count = lamps; headMesh.count = lamps;
  for (const mesh of [poles, headMesh]) { mesh.instanceMatrix.needsUpdate = true; mesh.frustumCulled = false; }
  for (const mesh of [headMesh]) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // One merged receiver mesh: exact terrain-triangle clipping prevents curved
  // ground/asphalt from cutting through a single planar decal. Depth testing
  // remains enabled so upper decks, curbs and buildings still occlude the pool.
  const poolData = streetLightPoolGeometry(host.layout, plan);
  const poolGeometry = new THREE.BufferGeometry();
  poolGeometry.setAttribute("position", new THREE.BufferAttribute(poolData.positions, 3));
  poolGeometry.setAttribute("uv", new THREE.BufferAttribute(poolData.uvs, 2));
  poolGeometry.setAttribute("color", new THREE.BufferAttribute(poolData.colors, 3));
  poolGeometry.setIndex(new THREE.BufferAttribute(poolData.indices, 1));
  const poolMesh = new THREE.Mesh(poolGeometry, pools);
  poolMesh.name = "street-light-pools";
  poolMesh.renderOrder = 2;
  // GTAO replaces transparent materials with an opaque normal/depth material.
  // A pool is emitted light, not a physical receiver/occluder: drawing its full
  // polygon there creates black discs (and it has no surface normals).
  // Like the plume's override guard, skip the draw and restore after each pass.
  // Reset on every normal draw too, so an interrupted override cannot hide it.
  poolMesh.onBeforeRender = (_renderer, scene) => {
    poolGeometry.setDrawRange(0, scene.overrideMaterial ? 0 : poolData.indices.length);
  };
  poolMesh.onAfterRender = () => poolGeometry.setDrawRange(0, poolData.indices.length);
  host.group.add(poolMesh);
  host.disposables.push(poolGeometry);
  // 高架灯带：沿环线两侧护栏上沿的发光细条（桥面高 8.2，护栏在 ±5.1）。
  let strip = 0;
  for (const highway of host.layout.highways ?? []) {
    const { points: run, heights } = expresswayRun(host.layout, highway);
    for (let i = 1; i < run.length && strip < 2190; i += 1) {
      const a = run[i - 1]; const b = run[i];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 6) continue;
      if (Math.abs(heights[i] - heights[i - 1]) > 0.15) continue; // 匝道坡段不挂水平灯带（会悬空/插进桥面）
      const yaw = -Math.atan2(b.z - a.z, b.x - a.x);
      const sx = Math.sin(yaw); const sz = Math.cos(yaw);
      for (const offset of [-5.1, 5.1]) {
        host.compose((a.x + b.x) / 2 + sx * offset, (heights[i] + heights[i - 1]) / 2 + EXPRESSWAY_DECK_THICKNESS + 0.35, (a.z + b.z) / 2 + sz * offset, yaw, length, 0.14, 0.14);
        stripMesh.setMatrixAt(strip, host.matrix);
        strip += 1;
      }
    }
  }
  stripMesh.count = strip;
  stripMesh.instanceMatrix.needsUpdate = true;
  stripMesh.frustumCulled = false;
  host.disposables.push(heads, pools, strips, neon);
  return { heads, pools, strips, neon, plan };
}

export function setNightGlow(host: NightHost, selfLit: number): void {
  host.nightGlow = selfLit;
  // 电灯用自己的「夜」量：DAY 档 selfLit = 0.05（立面的白天余光），直接拿来点灯会让正午的光斑/霓虹
  // 越过 0.03/0.04 的开灯阈值、灯头也带着亮度（审计实测正午灯全开）。≤0.1 一律算白天 = 0。
  const night = nightFactor(selfLit);
  host.applyNightOverlay();
  const beamMaterial = host.heroParts?.beam?.material as THREE.MeshBasicMaterial | undefined;
  if (beamMaterial) {
    beamMaterial.visible = night > 0.05;
    beamMaterial.opacity = 0.22 * Math.min(1, night * 1.5);
  }
  const lights = host.nightLights;
  const presentation = battleClarityPresentation(Boolean(host.battleClarity));
  if (lights) {
    // 电灯白天完全熄灭（0），随 night 线性亮起：此前留的 0.12/0.1「白天底线」
    // 在 4600 盏灯的规模下肉眼可见，读作「灯没关」；灯杆由 Lambert 灰呈现，
    // 灯头不需要白天亮度。
    lights.heads.color.setRGB(1, 0.78, 0.45).multiplyScalar(night * LIGHT_BUDGET.street.head * presentation.streetBrightness);
    lights.pools.color.setRGB(1, 0.62, 0.3).multiplyScalar(night * LIGHT_BUDGET.street.pool);
    lights.pools.visible = night > 0.03 && presentation.showStreetPools;
    lights.strips.color.setRGB(1, 0.7, 0.4).multiplyScalar(night * LIGHT_BUDGET.street.strip * presentation.streetBrightness);
    // 霓虹/边缘光：实例色决定色相（青/洋红/暖白），这里只管亮度；白天熄灭。
    lights.neon.color.setRGB(1, 1, 1).multiplyScalar(night * LIGHT_BUDGET.neon.bridge * presentation.streetBrightness);
    // 白天整体关掉：近黑的实例色在日光下读作一块块深色方块（桥塔上的霓虹点实测）。
    lights.neon.visible = night > 0.04;
  }
  // 地标玻璃幕墙：夜里换亮窗贴图并加亮，白天回到立面贴图 + 少量托底自发光。
  for (const entry of host.landmarkWindows) {
    const lit = night > 0.05;
    if (lit) { entry.material.emissiveMap = entry.lit; entry.material.emissive.setRGB(1, 1, 1).multiplyScalar(LIGHT_BUDGET.landmark.base + night * LIGHT_BUDGET.landmark.gain); }
    else { entry.material.emissiveMap = entry.day; entry.material.emissive.copy(entry.dayEmissive); }
  }
  // 救生塔夜间指示灯（VICE S1）：独立 MeshBasic，不依赖路灯照亮。
  if (host.lifeguardGlowMaterial) {
    const parent = host.lifeguardGlowMaterial.opacity !== undefined;
    host.lifeguardGlowMaterial.transparent = true;
    host.lifeguardGlowMaterial.opacity = night;
    // 通过材质找到 mesh 并切可见性。
    host.group.traverse((child) => {
      if (child instanceof THREE.InstancedMesh && child.material === host.lifeguardGlowMaterial) {
        child.visible = night > 0.05;
      }
    });
  }
  // 酒店招牌霓虹（VICE S2）：白天完全熄灭，夜间亮起。
  if (host.signageNeonMaterial) {
    host.group.traverse((child) => {
      if (child instanceof THREE.InstancedMesh && child.material === host.signageNeonMaterial) {
        child.visible = night > 0.05;
      }
    });
  }
}

export function applySelfLit(host: NightHost, themeBase: number): void {
  for (const uniforms of host.facadeUniforms) {
    // 夜里不再抬升墙面自发光（只点亮窗格，见 uWindowGlow）；墙面保持主题基线。
    // N1：墙面按自身颜色发光是「塑料」感的来源——夜里把基线随夜色压到 ~10%，只有窗格是光源。
    const night = Math.max(0, (host.nightGlow - 0.1) / 0.9);
    uniforms.uSelfLit.value = themeBase * (1 - 0.9 * Math.min(1, night));
    uniforms.uWindowGlow.value = host.nightGlow;
  }
}
