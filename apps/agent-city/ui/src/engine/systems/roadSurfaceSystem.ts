/**
 * 路面网格（渲染层；路网数据零改动）：沥青与路面标线从地面贴图里搬出来，画成贴地的独立网格。
 * 规格：docs/CITY_ROAD_SURFACE_RENDER_SPEC.md。
 *
 * 为什么不是「把地面贴图开大」：全城一张 2048² 图集铺 1600 单位，≈1.3 px/单位——5 宽的支路只有 6 个像素，
 * 0.22 宽的中线是 0.3 个像素。地面细节 shader 再按图集颜色「猜」哪里是沥青，阈值把双线性插值的模糊边
 * 硬化成一格一格的台阶（真机近景：路边锯齿、标线成团）。4096 图集 64 MiB、WebView 峰值 2.6 GB 已经否过。
 * 路面的边界与标线都是几何量（中线、路宽、停止线距离），在片元里按世界坐标解析计算，任何缩放都锐利，
 * 显存只多两个贴地网格（档 2 ≈ 1.6 MB、档 10 ≈ 8 MB；对比 2048² 图集本身 16 MB）。
 *
 * 构成：
 *  - 路段带（roadPaintPlan 的 run）：只在地形不平处自适应细分，顶点高度取渲染地形三角面（terrainSurfaceHeight），
 *    UV = (弧长 u, 横向 v)；标线在 shader 里由 (u, v) + 每端退让量算出。
 *  - 路口填充（圆角 / 路口中心圆盘 / 换宽圆盘 / 渐变梯形）：与地面贴图同一份几何（cityRoadJunctions），不画标线。
 *  - 人行道带（路宽 + 2.4，同贴图口径）与转角同心弧：人行道与草地 / 街区的分界也是几何边，不再是图集台阶。
 *  - 宽度分层：五个材质组（人行道 / 路口填充 / 宽 ≤5 / ≤8 / 更宽，分属 base 与带子两个 mesh），polygonOffset 逐层加大——宽路盖窄路，
 *    「主路直穿、小路收口」不用逐口裁剪；同层重叠只发生在同色、无标线的路口内部。
 */

import * as THREE from "three";
import type { CityLayout } from "../cityLayout";
import { LIGHT_BUDGET } from "../cityLightBudget";
import { CAR_STREET_LIGHT_GLSL, carLampsAdd, carStreetLightUniforms } from "../render/drivingStreetLights";
import { compileGroundRoadSurface, assertGroundRoadSurfaceMatches, ZEBRA_HALF, type CompiledGroundRoadSurface } from "../surface/groundRoadCompiler";
export { roadSurfaceGeometry, runEndMarkings, roadLayerOf, roadMarkingKindOf, ROAD_SURFACE_LIFT, ZEBRA_HALF } from "../surface/groundRoadCompiler";

export type { RunEnd } from "../surface/groundRoadCompiler";

export interface RoadSurfaceHost {
  readonly layout: CityLayout;
  /** Optional shared CPU compilation; supplying it avoids a second geometry pass. */
  readonly groundRoadSurface?: CompiledGroundRoadSurface;
  readonly group: THREE.Group;
  readonly disposables: Array<{ dispose: () => void }>;
  /** 与地形共用同一批 uniform 对象：沥青照片细节、夜间压暗、窗光外溢随地形一起更新。 */
  readonly terrainUniforms: Record<string, { value: unknown }> | null;
}

/** 路面标线色（sRGB）：白 = 车道 / 边线 / 斑马线 / 停止线，黄 = 次干 / 主干中线。 */
const MARK_WHITE = "#eceae2";
const MARK_YELLOW = "#e0c15c";

function installRoadShader(host: RoadSurfaceHost, material: THREE.MeshLambertMaterial, cacheKey: string): void {
  const shared = host.terrainUniforms ?? {};
  const own = { uMarkWhite: { value: new THREE.Color(MARK_WHITE) }, uMarkYellow: { value: new THREE.Color(MARK_YELLOW) } };
  material.onBeforeCompile = (shader) => {
    for (const name of ["uDetail", "uNightDim", "uSpill", "uSpillGain", "uExtent", "uAsphaltC", "uAsphaltN", "uAsphaltMean", "uConcreteC", "uConcreteN", "uConcreteMean"]) {
      shader.uniforms[name] = shared[name] ?? { value: name === "uDetail" || name === "uNightDim" || name === "uSpillGain" ? 0 : name === "uExtent" ? 1 : name.endsWith("Mean") ? new THREE.Vector3(0.5, 0.5, 0.5) : null };
    }
    Object.assign(shader.uniforms, own, carStreetLightUniforms());
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
attribute vec4 aRoadRun; varying vec4 vRoadRun; varying vec3 vRoadWorld; varying vec3 vRoadWNormal;
#ifndef ROAD_BASE
attribute vec2 aRoadUV; attribute vec4 aRoadEnds; attribute vec4 aRoadEdges; attribute vec2 aRoadZebra;
varying vec2 vRoadUV; varying vec4 vRoadEnds; varying vec4 vRoadEdges; varying vec2 vRoadZebra;
#endif`)
      .replace("#include <project_vertex>", `#include <project_vertex>
vRoadRun = aRoadRun; vRoadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vRoadWNormal = normalize(mat3(modelMatrix) * objectNormal);
#ifndef ROAD_BASE
vRoadUV = aRoadUV; vRoadEnds = aRoadEnds; vRoadEdges = aRoadEdges; vRoadZebra = aRoadZebra;
#endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec4 vRoadRun; varying vec3 vRoadWorld; varying vec3 vRoadWNormal;
#ifndef ROAD_BASE
varying vec2 vRoadUV; varying vec4 vRoadEnds; varying vec4 vRoadEdges; varying vec2 vRoadZebra;
#endif
uniform float uDetail; uniform float uNightDim; uniform sampler2D uSpill; uniform float uSpillGain; uniform float uExtent;
uniform sampler2D uAsphaltC; uniform sampler2D uAsphaltN; uniform vec3 uAsphaltMean; uniform vec3 uMarkWhite; uniform vec3 uMarkYellow;
uniform sampler2D uConcreteC; uniform sampler2D uConcreteN; uniform vec3 uConcreteMean;
${CAR_STREET_LIGHT_GLSL}
// 抗锯齿基元：全部用 fwidth 做一个像素宽的过渡，任何缩放下线宽都是真实世界宽度。
float roadLine(float d, float hw) { float fw = max(fwidth(d), 1e-4); return 1.0 - smoothstep(hw - fw, hw + fw, abs(d)); }
float roadRange(float x, float a, float b) { float fw = max(fwidth(x), 1e-4); return smoothstep(a - fw, a + fw, x) * (1.0 - smoothstep(b - fw, b + fw, x)); }
float roadDash(float u, float period, float duty) { float x = u / period; float f = fract(x); float fw = max(fwidth(x), 1e-4);
  // 远处一个像素覆盖多段虚线时退化成平均覆盖率（duty），不闪烁。
  float on = smoothstep(0.0, fw, f) * (1.0 - smoothstep(duty - fw, duty, f)); return mix(on, duty, smoothstep(0.25, 0.6, fw)); }`)
      // 注入在 color_fragment 之后：Lambert 里顶点色乘法（沥青底色）在 map_fragment 之后才做，
      // 注入在前面的话白色标线会被乘成沥青色、整条消失（第一版真机就是这样）。
      .replace("#include <color_fragment>", `#include <color_fragment>
{
  vec2 p = vRoadWorld.xz;
  // 照片细节与地面 shader 同一组贴图、同一世界尺度（沥青 /7、混凝土 /5.5）：路面与周边地面的颗粒感一致。
  float isWalk = step(1.5, vRoadRun.w);
  if (uDetail > 0.5) {
    vec3 ratio = mix(texture2D(uAsphaltC, p / 7.0).rgb / uAsphaltMean, texture2D(uConcreteC, p / 5.5).rgb / uConcreteMean, isWalk);
    vec3 nrm = mix(texture2D(uAsphaltN, p / 7.0).xyz, texture2D(uConcreteN, p / 5.5).xyz, isWalk) * 2.0 - 1.0;
    diffuseColor.rgb *= mix(vec3(1.0), clamp(ratio, 0.5, 1.6), 0.55);
    diffuseColor.rgb *= 1.0 + 0.3 * (nrm.x * 0.6 - nrm.y * 0.45);
  }
#ifndef ROAD_BASE
  float ribbon = 1.0 - step(0.5, vRoadRun.w);
  float u = vRoadUV.x; float v = vRoadUV.y; float hw = vRoadRun.x; float kind = vRoadRun.y; float len = vRoadRun.z;
  float back = len - u;
  float zebraBand = (vRoadZebra.x > 0.0 ? roadRange(u, vRoadZebra.x - ${ZEBRA_HALF.toFixed(2)}, vRoadZebra.x + ${ZEBRA_HALF.toFixed(2)}) : 0.0)
                  + (vRoadZebra.y > 0.0 ? roadRange(back, vRoadZebra.y - ${ZEBRA_HALF.toFixed(2)}, vRoadZebra.y + ${ZEBRA_HALF.toFixed(2)}) : 0.0);
  zebraBand = min(zebraBand, 1.0);
  // 条纹以路中线对称（v = 0, ±1, ±2 … 处各一条），两侧不留半条碎纹。
  float zebra = zebraBand * roadDash(v + 0.25, 1.0, 0.5) * roadRange(v, -hw + 0.35, hw - 0.35);
  float lines = 1.0 - zebraBand;
  float centerOn = roadRange(u, vRoadEnds.x, len - vRoadEnds.y) * lines;
  float leftOn = roadRange(u, vRoadEdges.x, len - vRoadEdges.z) * lines;
  float rightOn = roadRange(u, vRoadEdges.y, len - vRoadEdges.w) * lines;
  // 停止线：横跨驶入半幅（右侧通行）——起点端在 −v 侧，终点端在 +v 侧；宽 0.5。
  float stopLine = (vRoadEnds.z > 0.0 ? roadRange(u, vRoadEnds.z - 0.25, vRoadEnds.z + 0.25) * roadRange(v, -hw + 0.25, -0.15) : 0.0)
                 + (vRoadEnds.w > 0.0 ? roadRange(back, vRoadEnds.w - 0.25, vRoadEnds.w + 0.25) * roadRange(v, 0.15, hw - 0.25) : 0.0);
  float isLocal = 1.0 - step(0.5, kind); float isSecondary = step(0.5, kind) * (1.0 - step(1.5, kind)); float isMain = step(1.5, kind);
  float edgeLine = (isSecondary + isMain) * (roadLine(v - (hw - 0.45), 0.07) * leftOn + roadLine(v + (hw - 0.45), 0.07) * rightOn);
  float white = isLocal * roadLine(v, 0.07) * roadDash(u, 6.0, 0.5) * centerOn
              + isMain * roadLine(abs(v) - hw * 0.5, 0.065) * roadDash(u, 6.0, 0.5) * centerOn
              + edgeLine + zebra + stopLine;
  float yellow = isSecondary * roadLine(v, 0.08) * roadDash(u, 6.0, 0.5) * centerOn
               + isMain * roadLine(abs(v) - 0.2, 0.07) * centerOn;
  white = clamp(white, 0.0, 1.0) * ribbon * 0.92; yellow = clamp(yellow, 0.0, 1.0) * ribbon * 0.9;
  diffuseColor.rgb = mix(diffuseColor.rgb, uMarkWhite, white);
  diffuseColor.rgb = mix(diffuseColor.rgb, uMarkYellow, yellow);
#endif
}`)
      // 夜间与地面同口径：主题色压暗 + 楼窗光外溢（与 terrainSystem 同一组 uniform）。
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
diffuseColor.rgb *= mix(1.0, ${LIGHT_BUDGET.ambient.groundDim.toFixed(2)}, uNightDim);
if (uSpillGain > 0.001) { vec2 suv = vRoadWorld.xz / uExtent + 0.5; totalEmissiveRadiance += texture2D(uSpill, suv).rgb * uSpillGain; }`)
      // N5 开车模式解析街灯：路面是光池的主要受光面，与地形共用同一组 uniform 对象。
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
${carLampsAdd("vRoadWorld", "vRoadWNormal")}`);
  };
  material.customProgramCacheKey = () => cacheKey;
}

/** 建路面网格：两个 Mesh——
 *  - city-road-surface-base：人行道 + 路口填充（第 0/1 层），只带位置 / 法线 / 颜色 / 片类，不画标线；
 *  - city-road-surface：路段带（第 2–4 层），带标线所需的每端参数。
 *  拆开是为了体量：填充与人行道占顶点的九成，却用不上那 10 个标线属性（档 10 城每顶点 100 B → 52 B 量级）。
 *  每个材质组一个 polygonOffset 层级，逐层加大。 */
/** 逐个追加：`push(...arr)` 把整层当实参展开，超大城市（5000/42）一层的 run 属性就超出调用栈上限。 */
function append(out: number[], values: ArrayLike<number>): void {
  for (let i = 0; i < values.length; i++) out.push(values[i]);
}

export function buildRoadSurface(host: RoadSurfaceHost): void {
  const compiled = host.groundRoadSurface ?? compileGroundRoadSurface(host.layout);
  assertGroundRoadSurfaceMatches(compiled, host.layout);
  const layers = compiled.layers;
  const build = (layerIndices: number[], full: boolean, name: string) => {
    const positions: number[] = []; const normals: number[] = []; const colors: number[] = []; const uv: number[] = [];
    const run: number[] = []; const ends: number[] = []; const edges: number[] = []; const zebra: number[] = []; const index: number[] = [];
    const geometry = new THREE.BufferGeometry();
    for (const layerIndex of layerIndices) {
      const layer = layers[layerIndex];
      const base = positions.length / 3; const first = index.length;
      append(positions, layer.positions); append(normals, layer.normals); append(colors, layer.colors); append(run, layer.run);
      if (full) { append(uv, layer.uv); append(ends, layer.ends); append(edges, layer.edges); append(zebra, layer.zebra); }
      for (const i of layer.index) index.push(base + i);
      if (index.length > first) geometry.addGroup(first, index.length - first, layerIndex);
    }
    if (!index.length) { geometry.dispose(); return; }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute("aRoadRun", new THREE.Float32BufferAttribute(run, 4));
    if (full) {
      geometry.setAttribute("aRoadUV", new THREE.Float32BufferAttribute(uv, 2));
      geometry.setAttribute("aRoadEnds", new THREE.Float32BufferAttribute(ends, 4));
      geometry.setAttribute("aRoadEdges", new THREE.Float32BufferAttribute(edges, 4));
      geometry.setAttribute("aRoadZebra", new THREE.Float32BufferAttribute(zebra, 2));
    }
    geometry.setIndex(positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
    geometry.computeBoundingSphere();
    // materialIndex 用全局层号：材质数组按层号排，未用到的层占位（同一套 polygonOffset 阶梯跨两个 mesh 连续）。
    const materials = layers.map((_, layer) => {
      const material = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1 - layer, polygonOffsetUnits: -2 - 2 * layer });
      if (!full) material.defines = { ROAD_BASE: "" };
      installRoadShader(host, material, full ? "city-road-surface" : "city-road-surface-base");
      return material;
    });
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.name = name;
    mesh.receiveShadow = true;
    host.group.add(mesh);
    host.disposables.push(geometry, ...materials.filter((_, layer) => layerIndices.includes(layer)));
    for (const [layer, material] of materials.entries()) if (!layerIndices.includes(layer)) material.dispose();
  };
  build([0, 1], false, "city-road-surface-base");
  build([2, 3, 4], true, "city-road-surface");
}
