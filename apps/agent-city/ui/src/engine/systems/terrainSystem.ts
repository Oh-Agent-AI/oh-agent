/**
 * 地形系统：地面高度场 mesh + 地面细节 shader + 夜间光斑 + 海平线远山 + 水面。
 * 纯搬移自 CityParts（this → host），行为与场景图保持逐字节一致。
 */

import * as THREE from "three";
import { fbm } from "../cityNoise";
import type { CityLayout } from "../cityLayout";
import { MIAMI_COASTAL } from "../citySeaside";
import { activeTheme, skyYawOf } from "../cityTheme";
import { makeCityTexture } from "../cityTextures";
import { LIGHT_BUDGET, useOfZone } from "../cityLightBudget";
import { CAR_STREET_LIGHT_GLSL, carLampsAdd, carStreetLightUniforms } from "../render/drivingStreetLights";
import { createRenderCanvas } from "../renderCanvas";

/** terrainSystem 用到的 CityParts 成员（调用方以 `this as unknown as TerrainHost` 传入）。 */
export interface TerrainHost {
  readonly layout: CityLayout;
  readonly group: THREE.Group;
  readonly disposables: Array<{ dispose: () => void }>;
  /** buildGroundSpill 只读每栋楼的占地与已建比例。 */
  readonly runtimes: Array<{ slot: { x: number; z: number; width: number; depth: number; zone: Parameters<typeof useOfZone>[0] }; building: { height: number; builtFraction: number } }>;
  terrainUniforms: Record<string, { value: unknown }> | null;
  waterAssetUniforms: Record<string, { value: unknown }> | null;
  spillTexture: THREE.Texture | null;
}

/** 火山体：移植 tinyskies Volcano.ts::buildVolcanoGeometry。原版 S=0.35、H=1.25 的单位尺度换成
 *  「底半径 = radius、火山口高 = rimHeight」；原版的 3D simplex 噪声换成本仓库的 fbm（三轴投影组合）。 */
function volcanoGeometry(radius: number, rimHeight: number, seed: number): THREE.BufferGeometry {
  const S = radius / 1.39; // 原版底半径 (0.24 + 1.15)·S
  const yScale = rimHeight / S; // 原版火山口高 S·H；这里按目标高度换算
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.0 * S, 0.88 * S), new THREE.Vector2(0.06 * S, 0.88 * S), new THREE.Vector2(0.09 * S, 0.94 * S),
    new THREE.Vector2(0.12 * S, 0.98 * S), new THREE.Vector2(0.18 * S, 1.0 * S), new THREE.Vector2(0.24 * S, 0.98 * S),
  ];
  const steps = 24;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    profile.push(new THREE.Vector2(0.24 * S + Math.pow(t, 1.6) * 1.15 * S, (1 - t) * 0.98 * S));
  }
  // LatheGeometry 按点序决定面朝向：原版自上而下排点（配 DoubleSide 材质），这里翻成自下而上，单面材质下外侧朝外。
  const geometry = new THREE.LatheGeometry(profile.reverse(), 32);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  // fbm ≈ -1..1；原版 terrainNoise 是 0..1，换算过来（曾直接当 0..1 用，扭曲量翻三倍、山脚戳出黑色尖刺）。
  const noise3 = (x: number, y: number, z: number, octaves: number) => (fbm(x + z * 0.71, y + z * 1.37, seed + 77, octaves) + fbm(z + y * 0.53, x - y * 0.91, seed + 131, octaves)) * 0.25 + 0.5;
  const rimY = S;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i); const y = position.getY(i); const z = position.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 0.001) { position.setY(i, y * yScale); continue; }
    const t = y / rimY;
    const warp = (noise3((x / S) * 4, (y / S) * 4, (z / S) * 4, 4) - 0.5) * 2;
    const slopeBand = Math.sin(t * Math.PI);
    const radialScale = 1 + warp * 0.25 * Math.max(slopeBand, (1 - t) * 0.6);
    position.setX(i, x * radialScale);
    position.setZ(i, z * radialScale);
    position.setY(i, (y + warp * 0.08 * S * slopeBand) * yScale);
  }
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i); const y = position.getY(i) / yScale; const z = position.getZ(i);
    const r = Math.hypot(x, z);
    const t = Math.max(0, y / rimY);
    const cNoise = noise3((x / S) * 10, (y / S) * 10, (z / S) * 10, 3);
    const tMod = Math.max(0, Math.min(1, t + (cNoise - 0.5) * 0.25));
    let c: [number, number, number];
    if (tMod > 0.88 && r < 0.1 * S) c = [0.85, 0.25, 0.05]; // 岩浆芯
    else if (tMod > 0.82) c = [0.16, 0.1, 0.08]; // 焦黑火山口
    else if (tMod > 0.55) { const k = (tMod - 0.55) / 0.27; c = [0.38 + (0.16 - 0.38) * k, 0.24 + (0.1 - 0.24) * k, 0.18 + (0.08 - 0.18) * k]; }
    else { const k = Math.min(1, tMod / 0.55); c = [0.28 + 0.1 * k, 0.32 - 0.08 * k, 0.22 - 0.04 * k]; } // 青褐山脚
    const highlight = (cNoise - 0.5) * 0.1;
    colors[i * 3] = Math.max(0, Math.min(1, c[0] + highlight));
    colors[i * 3 + 1] = Math.max(0, Math.min(1, c[1] + highlight));
    colors[i * 3 + 2] = Math.max(0, Math.min(1, c[2] + highlight));
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// Compatibility exports: rendering and CPU surface compilation share this sampler.
export { TERRAIN_SEGMENTS, terrainSurfaceHeight } from "../surface/terrainSampling";
import { TERRAIN_SEGMENTS } from "../surface/terrainSampling";

/** 地形 mesh：高度场位移的 PlaneGeometry；UV 与区纹理的世界映射严格一致。 */
export function buildTerrain(host: TerrainHost): void {
  {
    const extent = host.layout.extent;
    const segments = TERRAIN_SEGMENTS;
    const geometry = new THREE.PlaneGeometry(extent, extent, segments, segments).rotateX(-Math.PI / 2);
    const position = geometry.attributes.position as THREE.BufferAttribute;
    for (let index = 0; index < position.count; index += 1) {
      const worldX = position.getX(index);
      const worldZ = position.getZ(index);
      position.setXYZ(index, worldX, host.layout.terrain.height(worldX, worldZ), worldZ);
    }
    geometry.computeVertexNormals();
    const texture = makeCityTexture(host.layout);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshLambertMaterial({ map: texture });
    installGroundDetail(host, material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    host.group.add(mesh);
    host.disposables.push(geometry, material, texture);
  }
}

/** 地面细节：全城图集（2048–4096²）只够画「哪里是路/沙/草」，近看糊成色块。
 *  在图集颜色上按材质类别叠加世界坐标平铺的照片细节（颜色比值 + 法线明暗），
 *  分类只看图集颜色与海拔：深灰低饱和=沥青，浅灰=人行道，绿=草，暖浅=沙，近水面的沙=滩涂。 */
export function installGroundDetail(host: TerrainHost, material: THREE.MeshLambertMaterial): void {
  const uniforms: Record<string, { value: unknown }> = { uDetail: { value: 0 }, uNightDim: { value: 0 }, uSpill: { value: null }, uSpillGain: { value: 0 }, uExtent: { value: host.layout.extent } };
  // 海滨沙滩不在 shader 里：画进地面贴图（makeCityTexture），道路才能压在它上面。
  for (const name of ["Asphalt", "Concrete", "Sand", "Mud", "Grass"]) {
    uniforms[`u${name}C`] = { value: null };
    uniforms[`u${name}N`] = { value: null };
    uniforms[`u${name}Mean`] = { value: new THREE.Vector3(0.5, 0.5, 0.5) };
  }
  host.terrainUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, carStreetLightUniforms());
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCityWorld;\nvarying vec3 vCityWNormal;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvCityWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvCityWNormal = normalize(mat3(modelMatrix) * objectNormal);");
    const samplers = ["Asphalt", "Concrete", "Sand", "Mud", "Grass"].map((n) => `uniform sampler2D u${n}C; uniform sampler2D u${n}N; uniform vec3 u${n}Mean;`).join("\n");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vCityWorld;\nvarying vec3 vCityWNormal;\nuniform float uDetail;\nuniform float uNightDim;\nuniform sampler2D uSpill;\nuniform float uSpillGain;\nuniform float uExtent;\n${samplers}\n${CAR_STREET_LIGHT_GLSL}`)
      // N5 开车模式解析街灯：光池按光度学分布在受光面上求值（几何法线——掠射角下扰动法线
      // 会让 N·L 摆动数倍，光池变噪点场）。uCarLampCount = 0 时注入块早退，其他模式零行为。
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>\n${carLampsAdd("vCityWorld", "vCityWNormal")}`)
      // N1/N3：夜里地面主题色压暗；楼的窗光外溢（uSpill）只加在地面上，亮度随亮灯率。
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\ndiffuseColor.rgb *= mix(1.0, ${LIGHT_BUDGET.ambient.groundDim.toFixed(2)}, uNightDim);\nif (uSpillGain > 0.001) { vec2 suv = vCityWorld.xz / uExtent + 0.5; totalEmissiveRadiance += texture2D(uSpill, suv).rgb * uSpillGain; }`)
      .replace("#include <map_fragment>", `#include <map_fragment>
#ifdef USE_MAP
if (uDetail > 0.5) {
  vec3 base = diffuseColor.rgb;
  float lum = dot(base, vec3(0.2126, 0.7152, 0.0722));
  float mx = max(base.r, max(base.g, base.b));
  float sat = (mx - min(base.r, min(base.g, base.b))) / max(mx, 1e-3);
  float wA = (1.0 - smoothstep(0.12, 0.3, sat)) * (1.0 - smoothstep(0.05, 0.14, lum));
  float wC = (1.0 - smoothstep(0.08, 0.22, sat)) * smoothstep(0.16, 0.36, lum);
  float wG = smoothstep(0.005, 0.05, base.g - max(base.r, base.b));
  float wS = smoothstep(0.02, 0.09, base.r - base.b) * smoothstep(0.18, 0.4, lum) * (1.0 - wG);
  // 只在水线附近算滩涂：曾用 0.5–1.9，海拔低的整片沙滩都被染成泥色（真机：沙滩发褐、看不出是沙滩）。
  float wet = 1.0 - smoothstep(0.15, 0.6, vCityWorld.y);
  float wM = wS * wet;
  wS *= 1.0 - wet;
  float sum = wA + wC + wG + wS + wM;
  float strength = smoothstep(0.05, 0.45, sum);
  sum += 1e-4;
  vec2 p = vCityWorld.xz;
  vec3 ratio = (wA * texture2D(uAsphaltC, p / 7.0).rgb / uAsphaltMean
    + wC * texture2D(uConcreteC, p / 5.5).rgb / uConcreteMean
    + wS * texture2D(uSandC, p / 13.0).rgb / uSandMean
    + wM * texture2D(uMudC, p / 9.0).rgb / uMudMean
    + wG * mix(vec3(1.0), texture2D(uGrassC, p / 34.0).rgb / uGrassMean, 0.45)) / sum;
  vec3 nrm = (wA * (texture2D(uAsphaltN, p / 7.0).xyz * 2.0 - 1.0)
    + wC * (texture2D(uConcreteN, p / 5.5).xyz * 2.0 - 1.0)
    + wS * (texture2D(uSandN, p / 13.0).xyz * 2.0 - 1.0)
    + wM * (texture2D(uMudN, p / 9.0).xyz * 2.0 - 1.0)
    + wG * 0.4 * (texture2D(uGrassN, p / 34.0).xyz * 2.0 - 1.0)) / sum;
  diffuseColor.rgb *= mix(vec3(1.0), clamp(ratio, 0.35, 1.8), 0.8 * strength);
  // 法线贴图做「固定光向」的明暗起伏：地面近似水平，省掉切线空间，代价是凹凸不随太阳转。
  diffuseColor.rgb *= 1.0 + 0.55 * strength * (nrm.x * 0.6 - nrm.y * 0.45);
  // 滩涂：向泥色偏、压暗，像刚退潮的湿岸。
  vec3 mud = texture2D(uMudC, p / 9.0).rgb;
  diffuseColor.rgb = mix(diffuseColor.rgb, mud * 0.9, 0.3 * wM / sum * strength);
}
#endif`);
  };
  material.customProgramCacheKey = () => "city-terrain-detail";
}

/** N3 夜间光照叠层：把每栋亮窗的楼按其占地画成暖色径向光斑（低分辨率画布），在地面与水面 shader 里按
 *  uSpillGain 叠加——窗光「漏」到楼脚与岸边水面，而不是楼自己孤立地亮。静态建一次，亮度随时段在 setNightHour 里调。 */
export function buildGroundSpill(host: TerrainHost): void {
  const uniforms = host.terrainUniforms;
  if (!uniforms) return;
  const size = 1024;
  const canvas = createRenderCanvas();
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = "lighter";
  const extent = host.layout.extent;
  for (const runtime of host.runtimes) {
    const s = runtime.slot;
    const reach = (Math.hypot(s.width, s.depth) / 2 + LIGHT_BUDGET.overlay.radius) / extent * size;
    const px = (s.x / extent + 0.5) * size; const pz = (s.z / extent + 0.5) * size;
    const power = Math.min(1, runtime.building.height / 70) * (useOfZone(s.zone) === "office" ? 1 : 0.6) * runtime.building.builtFraction;
    if (power < 0.04) continue;
    const g = ctx.createRadialGradient(px, pz, 0, px, pz, reach);
    g.addColorStop(0, `rgba(255,170,90,${(0.5 * power).toFixed(3)})`);
    g.addColorStop(1, "rgba(255,170,90,0)");
    ctx.fillStyle = g; ctx.fillRect(px - reach, pz - reach, reach * 2, reach * 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  (uniforms.uSpill.value as THREE.Texture | null)?.dispose();
  uniforms.uSpill.value = texture;
  if (host.waterAssetUniforms?.uSpill) host.waterAssetUniforms.uSpill.value = texture;
  host.spillTexture = texture;
}

/** 海平线远山：低模锥形剪影 + fbm 顶点扰动，两侧海域各一座。 */
export function buildSeaMountains(host: TerrainHost): void {
  const mountains = host.layout.seaMountains ?? [];
  if (!mountains.length) return;
  const volcano = [...mountains].sort((a, b) => b.height - a.height)[0];
  for (const mountain of mountains) {
    if (mountain === volcano) {
      // 冒烟的那座（CityWildlife 选最高的）是火山：火山体直接移植 tinyskies Volcano.ts 的 buildVolcanoGeometry
      // （作者授权）——带火山口的车削轮廓、噪声扭曲成不规则岩体、顶点色从青褐山脚→灰烬→焦黑火山口→岩浆芯。
      // 曾是一个光秃的浅色圆锥，读作「海上一顶帽子」（拍照实测）。烟柱从 height/2 的火山口冒出。
      const mesh = new THREE.Mesh(volcanoGeometry(mountain.radius, mountain.height / 2, host.layout.seed), new THREE.MeshLambertMaterial({ vertexColors: true })); // 吃雾：远海处与海面一同淡入天色，曾 fog:false 在雾化的海平线上悬浮成飞碟（真机截图）
      mesh.position.set(mountain.center.x, -2, mountain.center.z);
      mesh.name = "city-sea-volcano";
      host.group.add(mesh);
      host.disposables.push(mesh.geometry, mesh.material as THREE.Material);
      continue;
    }
    const geometry = new THREE.ConeGeometry(mountain.radius, mountain.height, 11, 4);
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(position.count * 3);
    const rock = new THREE.Color("#a9a496");
    const high = new THREE.Color("#d6d0c2");
    const tint = new THREE.Color();
    for (let index = 0; index < position.count; index += 1) {
      const x = position.getX(index);
      const y = position.getY(index);
      const z = position.getZ(index);
      const wobble = 1 + fbm(x * 0.03 + mountain.seed, z * 0.03 - mountain.seed, mountain.seed, 3) * 0.22;
      position.setX(index, x * wobble);
      position.setZ(index, z * wobble);
      tint.copy(rock).lerp(high, Math.max(0, (y + mountain.height / 2) / mountain.height));
      colors[index * 3] = tint.r;
      colors[index * 3 + 1] = tint.g;
      colors[index * 3 + 2] = tint.b;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, fog: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(mountain.center.x, 0, mountain.center.z);
    mesh.name = "city-sea-mountain";
    host.group.add(mesh);
    host.disposables.push(geometry, material);
  }
}

export function buildWater(host: TerrainHost): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(9000, 9000, 1, 1).rotateX(-Math.PI / 2);
  // 岸线深度图（tinyskies Globe 的 oceanDepth 等价物）：构建期把 -height/16 采样
  // 进单通道纹理（384²，随静态城缓存一次性烘焙）。水面是 1×1 段平面没有顶点
  // 可烘，纹理方案逐像素平滑；河床 height<0 同样被采到，河岸也起涟漪。
  const DEPTH_TEX = 384;
  const DEPTH_WORLD = 1500;
  const depthData = new Uint8Array(DEPTH_TEX * DEPTH_TEX);
  for (let y = 0; y < DEPTH_TEX; y += 1) {
    for (let x = 0; x < DEPTH_TEX; x += 1) {
      const worldX = (x / (DEPTH_TEX - 1) - 0.5) * DEPTH_WORLD * 2;
      const worldZ = (y / (DEPTH_TEX - 1) - 0.5) * DEPTH_WORLD * 2;
      const h = host.layout.terrain.height(worldX, worldZ);
      depthData[y * DEPTH_TEX + x] = Math.max(0, Math.min(255, Math.round((-h / 16) * 255)));
    }
  }
  const depthTexture = new THREE.DataTexture(depthData, DEPTH_TEX, DEPTH_TEX, THREE.RedFormat, THREE.UnsignedByteType);
  depthTexture.minFilter = THREE.LinearFilter;
  depthTexture.magFilter = THREE.LinearFilter;
  depthTexture.wrapS = THREE.ClampToEdgeWrapping;
  depthTexture.wrapT = THREE.ClampToEdgeWrapping;
  depthTexture.needsUpdate = true;
  host.disposables.push(depthTexture);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSun: { value: new THREE.Vector3(0.55, 0.75, 0.36).normalize() },
      uDeep: { value: new THREE.Color(activeTheme().water.deep) },
      uShallow: { value: new THREE.Color(activeTheme().water.shallow) },
      uSky: { value: new THREE.Color(activeTheme().water.sky) },
      uDepth: { value: depthTexture },
      uDepthWorld: { value: DEPTH_WORLD },
      // 与 scene.background 同色：ShaderMaterial 不吃 scene.fog，水面远处要自己淡出到天空色，
      // 否则 2600 见方的水面直边会像「世界边缘」露在天空下。
      uFog: { value: new THREE.Color(activeTheme().skyHorizon) },
      uFogRange: { value: new THREE.Vector2(...activeTheme().waterFog) },
      uNormal: { value: null as THREE.Texture | null },
      // 平面镜反射（引擎每帧把镜像相机看到的场景渲染进来）：岸边的楼、山、桥倒映在水里。
      uMirror: { value: null as THREE.Texture | null },
      uMirrorMatrix: { value: new THREE.Matrix4() },
      uHasMirror: { value: 0 },
      uNight: { value: 0 },
      uSpill: { value: null as THREE.Texture | null },
      uSpillGain: { value: 0 },
      uExtent: { value: host.layout.extent },
      uSkyTex: { value: null as THREE.Texture | null },
      uHasAssets: { value: 0 },
      uGradeTop: { value: new THREE.Color(activeTheme().skyGrade.top) },
      uGradeHorizon: { value: new THREE.Color(activeTheme().skyGrade.horizon) },
      uGradeAmount: { value: activeTheme().skyGrade.amount },
      uSkyYaw: { value: skyYawOf(activeTheme()) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSun;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      uniform vec3 uSky;
      uniform vec3 uFog;
      uniform vec2 uFogRange;
      uniform sampler2D uNormal;
      uniform sampler2D uMirror;
      uniform mat4 uMirrorMatrix;
      uniform float uHasMirror;
      uniform float uNight;
      uniform sampler2D uSpill;
      uniform float uSpillGain;
      uniform float uExtent;
      uniform sampler2D uSkyTex;
      uniform float uHasAssets;
      uniform vec3 uGradeTop;
      uniform vec3 uGradeHorizon;
      uniform float uGradeAmount;
      uniform float uSkyYaw;
      uniform sampler2D uDepth;
      uniform float uDepthWorld;
      varying vec3 vWorld;
      // 与天空球同一套采样 + 调色：反射和远处淡出都要与天空完全一致，否则地平线出现接缝。
      vec3 skyAt(vec3 dir) {
        dir = normalize(dir);
        vec2 uv = vec2(atan(dir.z, dir.x) / 6.2831853 + 0.5 + uSkyYaw, asin(clamp(dir.y, 0.002, 1.0)) / 3.1415927 + 0.5);
        vec3 photo = texture2D(uSkyTex, uv).rgb;
        vec3 tint = mix(uGradeHorizon, uGradeTop, smoothstep(0.0, 0.6, max(dir.y, 0.0)));
        return mix(photo, photo * tint * 1.55, uGradeAmount);
      }
      // 水面法线贴图（512²）在该 uv 处的 mip 级：0 = 1 texel/像素，每 +1 = 降采样一倍。
      float waterMip(vec2 uv) {
        vec2 d = fwidth(uv) * 512.0;
        return log2(max(max(d.x, d.y), 1e-4));
      }
      float rHash(vec2 c) { return fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453); }
      vec2 rHash2(vec2 c) { return fract(sin(vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)))) * 43758.5453); }
      // 平滑值噪声（格点哈希 + smoothstep 插值）：没有周期，等值线不成点阵。
      float valueNoise(vec2 q) {
        vec2 i = floor(q);
        vec2 f = fract(q);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = rHash(i);
        float b = rHash(i + vec2(1.0, 0.0));
        float c = rHash(i + vec2(0.0, 1.0));
        float e = rHash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, e, u.x), u.y);
      }
      // 一层涟漪：格距 cell；查 3×3 邻格（中心在格内 0.15–0.85、半径 ≤ 0.85 格，跨格的环也能画到）。
      float rippleLayer(vec2 p, float cell, float t, float seed) {
        vec2 g = floor(p / cell);
        float acc = 0.0;
        for (int i = -1; i <= 1; i++) {
          for (int j = -1; j <= 1; j++) {
            vec2 c = g + vec2(float(i), float(j));
            float period = 3.0 + rHash(c + seed) * 5.0;              // 时间：每格自己的周期
            float phase = t / period + rHash(c + seed + 7.1);        // …且错相
            float cycle = floor(phase);
            float age = fract(phase);
            float alive = step(0.45, rHash(c + cycle * 3.3 + seed + 1.7)); // 约一半轮次不出现
            vec2 center = (c + 0.15 + rHash2(c + cycle * 13.7 + seed) * 0.7) * cell; // 位置：每轮重抽
            float maxR = cell * (0.3 + 0.55 * rHash(c + cycle * 5.9 + seed + 4.2)); // 大小：每轮随机
            float r = age * maxR;
            float width = 0.7 + r * 0.06;
            float ring = 1.0 - smoothstep(0.0, width, abs(length(p - center) - r));
            acc += ring * (1.0 - age) * (1.0 - age) * alive;
          }
        }
        return acc;
      }
      // 离岸深度（构建期烘焙）：0 = 水线，1 = 深水；纹理外一律深水。
      float shoreDepth(vec2 p) {
        vec2 uv = p / (uDepthWorld * 2.0) + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
        return texture2D(uDepth, uv).r;
      }
      void main() {
        vec2 p = vWorld.xz;
        // 不再用解析波（几组平面波之和）做法线：平面波相加本身是二维干涉点阵，波峰周期性对齐，
        // 镜面高光 pow(·,64) 在每个波峰上点出一颗一模一样的白椭圆，满海排成格子（拍照实测：
        // 关掉碎光、法线贴图、镜面倒影、尾迹之后椭圆都还在）。法线只来自下面旋转错开的法线贴图层，
        // 起伏的随机感交给随机涟漪。
        vec3 n = vec3(0.0, 1.0, 0.0);
        if (uHasAssets > 0.5) {
          // 两层反向滚动的法线贴图：细碎波纹不再是规则的正弦格。
          // 曾是 p/46、p/19 两层轴对齐平铺：同一块贴图每 46 单位原样复制，掠射角下菲涅尔
          // 反射把每块的法线偏转放大成一颗暗椭圆，全海排成规则点阵。现在三层各自旋转到
          // 非轴向、尺度互不整除（重复周期错开），再用低频场混合权重，平铺不再对齐成格。
          vec2 pa = mat2(0.857, 0.515, -0.515, 0.857) * p;   // 31°
          vec2 pb = mat2(0.682, -0.731, 0.731, 0.682) * p;   // -47°
          vec2 pc = mat2(0.276, 0.961, -0.961, 0.276) * p;   // 74°
          vec2 uvA = pa / 41.3 + vec2(uTime * 0.010, uTime * 0.006);
          vec2 uvB = pb / 15.7 - vec2(uTime * 0.007, -uTime * 0.011);
          vec2 uvC = pc / 113.0 + vec2(uTime * 0.004, -uTime * 0.003);
          vec3 a = texture2D(uNormal, uvA).xyz * 2.0 - 1.0;
          vec3 b = texture2D(uNormal, uvB).xyz * 2.0 - 1.0;
          vec3 c = texture2D(uNormal, uvC).xyz * 2.0 - 1.0;
          // 旋转只把点阵转斜，不消除周期（上一版修复的错）。真正成格的原因：一层平铺在屏幕上
          // 只有几十像素时，512² 贴图被 mip 降采样 ~3 级，细节滤光、只剩「以平铺尺寸为周期」的
          // 低频分量——一张干净的正弦格，再被掠射菲涅尔放大。按各层自己的 mip 级淡出：细节一旦
          // 被滤掉就不再贡献法线，留下的起伏由下面 wave() 的解析法线（非格点平面波）接管。
          float wA = 1.0 - smoothstep(1.0, 2.5, waterMip(uvA));
          float wB = 1.0 - smoothstep(1.0, 2.5, waterMip(uvB));
          float wC = 1.0 - smoothstep(1.0, 2.5, waterMip(uvC));
          float mixW = 0.5 + 0.5 * sin(p.x * 0.013 + p.y * 0.017) * sin(p.y * 0.011 - p.x * 0.007);
          vec3 t = a * wA * (0.6 + 0.4 * mixW) + b * wB * (1.0 - 0.4 * mixW) + c * wC * 0.7;
          float strength = 0.28;
          n = normalize(vec3(t.x * strength + n.x * 0.5, 1.0, t.y * strength + n.z * 0.5));
        }
        vec3 view = normalize(cameraPosition - vWorld);
        float fresnel = pow(1.0 - max(dot(n, view), 0.0), 2.4);
        vec3 base = mix(uShallow, uDeep, clamp(length(p) / 420.0, 0.0, 1.0));
        vec3 skyColor = uHasAssets > 0.5 ? mix(skyAt(reflect(-view, n)), uSky, uNight) : uSky; // 夜里不再倒映晚霞照片
        if (uHasMirror > 0.5) {
          // 镜像贴图按投影坐标采样，再用波纹法线扰动：倒影随水波轻晃而不是一面硬镜子。
          vec4 projected = uMirrorMatrix * vec4(vWorld, 1.0);
          vec2 mirrorUv = projected.xy / projected.w + n.xz * 0.035;
          skyColor = texture2D(uMirror, mirrorUv).rgb;
        }
        // 有镜面倒影时反射占比更高：平静海面在斜视角下几乎就是一面镜子。
        float reflectance = uHasMirror > 0.5 ? 0.04 + fresnel * 0.9 : (uHasAssets > 0.5 ? 0.12 + fresnel * 0.78 : fresnel * 0.6);
        vec3 color = mix(base, skyColor, reflectance);
        float specular = pow(max(dot(reflect(-normalize(uSun), n), view), 0.0), 64.0);
        color += vec3(1.0, 0.97, 0.88) * specular * 1.05;
        // ── 随机涟漪 ─────────────────────────────────────────────────────
        // 曾是 sin×sin×sin 的「碎光」乘积场 × 正弦掩码 × 波峰门控：正弦的乘积本身是周期点阵，
        // 满海排成规则的白椭圆（拍照实测，关掉法线贴图/镜面/尾迹都还在）。现在是真正的涟漪：
        // 海面按格子划分，每格每一轮——中心在格内随机重抽（位置随机）、周期 3–8 秒且各自错相
        // 并有约一半轮次不出现（时间随机）、最大半径随机（大小随机）；两层不同格距（22/47，
        // 第二层旋转）混出大小涟漪。全部由 uTime 与哈希决定：导出仍可复现。
        float dist = distance(cameraPosition, vWorld);
        float sunPath = smoothstep(0.55, 0.95, dot(reflect(-normalize(uSun), n), view));
        float ripples = rippleLayer(p, 22.0, uTime, 0.0)
          + rippleLayer(mat2(0.6, 0.8, -0.8, 0.6) * p, 47.0, uTime * 0.8, 31.0) * 0.75;
        // 环宽 ~1 单位：屏幕上一像素已经大于环宽时淡出（远处不闪成噪点），再进雾前柔和收尾。
        float footprint = length(fwidth(p));
        ripples *= (1.0 - smoothstep(0.5, 1.6, footprint)) * (1.0 - smoothstep(650.0, 1100.0, dist));
        color += vec3(0.88, 0.95, 1.0) * ripples * 0.16 * (1.0 - uNight * 0.75);
        // N3 水面窗光倒影：岸边亮窗的楼把暖光洒在近岸水面，随涟漪碎成亮带（只在有光斑的地方）。
        if (uSpillGain > 0.001) { vec3 spill = texture2D(uSpill, vWorld.xz / uExtent + 0.5).rgb; color += spill * uSpillGain * (0.55 + 0.9 * ripples); }
        // 太阳反射带里的涟漪更亮（碎金）：只在日间。
        color += vec3(1.0, 0.98, 0.9) * ripples * sunPath * 0.55 * (1.0 - uNight);
        // ── 岸线涟漪（tinyskies Globe 手法，作者授权移植）──────────────────
        // 只此一件：fract(深度×频率−时间) 生成向岸滚动的白色波纹带，sin 噪声让
        // 条带不规则、深度衰减离岸消失。深度驱动、空间上低频（条带宽 ~10-30 单
        // 位），远处（700–1400）柔和淡出防混叠；不动碎光、不加开阔海面浪花。
        float d = shoreDepth(p);
        if (d < 0.8) {
          float dayFade = 1.0 - uNight * 0.6;
          // 条带的不规则来自哈希值噪声（非周期），不再是两个正弦之和——深度在大片浅滩/陆下近乎常数时，
          // 条带退化成噪声的等值线，正弦和的等值线是一张规则的椭圆点阵，满海一圈圈白椭圆（拍照实测）。
          float nz = (valueNoise(p * 0.035 + vec2(uTime * 0.05, -uTime * 0.03)) - 0.5) * 0.09
            + (valueNoise(p * 0.09 - vec2(uTime * 0.04, uTime * 0.06)) - 0.5) * 0.04;
          float contour = fract((d + nz) * 4.0 - uTime * 0.42);
          // 只在深度真的在变的地方画（靠近真实岸线）：用 2 单位差分估深度梯度，平坦处不画条带。
          float grad = length(vec2(shoreDepth(p + vec2(2.0, 0.0)) - d, shoreDepth(p + vec2(0.0, 2.0)) - d)) * 0.5;
          float band = smoothstep(0.45, 0.7, contour) * (1.0 - smoothstep(0.75, 1.0, contour));
          // 只留最靠岸的一窄条：窄河里深度处处都浅，曾整条河铺满白色条带、读作结冰（拍照实测）。
          float depthFade = 1.0 - smoothstep(0.03, 0.3, d);
          float bandFade = 1.0 - smoothstep(700.0, 1400.0, dist);
          float slopeFade = smoothstep(0.0012, 0.004, grad);
          color = mix(color, vec3(0.9, 0.97, 0.98), band * depthFade * bandFade * slopeFade * 0.45 * dayFade);
        }
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        // 雾混在色调映射之后：scene.background 不经色调映射，先混再映射会让远水发灰、与天空出现色带。
        vec3 fogColor = uFog;
        if (uHasAssets > 0.5) {
          // 远处淡出到「这个方向地平线上的天空」，而不是一个常数色。
          vec3 horizonDir = normalize(vec3(vWorld.x - cameraPosition.x, 0.0, vWorld.z - cameraPosition.z));
          fogColor = skyAt(horizonDir + vec3(0.0, 0.01, 0.0));
        }
        // 夜里远海淡出到夜雾色：skyAt 采样的是黄昏照片，天穹入夜后换成渐变，水面却一直淡出到照片里的
        // 晚霞——23 点远海一整条粉红光带（用户截图「光照污染」）。
        fogColor = mix(fogColor, uSky, uNight); // uSky 每个 tick 按当前档位的雾色更新；uFog 是主题常量（迈阿密的晚霞橙），夜里不能用
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(uFogRange.x, uFogRange.y, dist));
        #include <colorspace_fragment>
      }
    `,
  });
  host.waterAssetUniforms = material.uniforms as Record<string, { value: unknown }>;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = -0.55;
  host.disposables.push(geometry, material);
  return mesh;
}
