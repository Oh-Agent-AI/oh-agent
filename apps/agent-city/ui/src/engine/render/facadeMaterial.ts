import * as THREE from "three";

/** Shared sky sampling for facade and civic glass. */
export const FACADE_SKY_GLSL = /* glsl */ `vec3 facadeSky(vec3 dir) {
  dir = normalize(dir);
  vec2 uv = vec2(atan(dir.z, dir.x) / 6.2831853 + 0.5 + uSkyYaw, asin(clamp(dir.y, 0.002, 1.0)) / 3.1415927 + 0.5);
  vec3 photo = texture2D(uEnv, uv).rgb;
  vec3 tint = mix(uGradeHorizon, uGradeTop, smoothstep(0.0, 0.6, max(dir.y, 0.0)));
  return mix(photo, photo * tint * 1.55, uGradeAmount);
}`;

/** 每块立面平铺里的窗格数（列 × 行）：与 makeFacadeTexture 画的窗格对齐，亮灯按窗格取 hash。 */
export const FACADE_GRIDS: Array<[number, number]> = [[5, 4], [1, 4], [4, 4], [1, 2]];

export type FacadeUniforms = {
  uRows: { value: number };
  uPhoto: { value: number };
  uPhotoTex: { value: THREE.Texture | null };
  uPhotoRows: { value: number };
  uTileWidth: { value: number };
  uSelfLit: { value: number };
  /** 夜里亮窗：0 = 全灭，≈1 = 夜档（每扇窗按 hash 决定亮不亮，只发光窗格、墙面不发光）。 */
  uWindowGlow: { value: number };
  /** 本地时段亮灯率：住宅 / 办公（cityLightBudget.windowRate）。 */
  uRateRes: { value: number };
  uRateOff: { value: number };
  uGrid: { value: THREE.Vector2 };
  /** 玻璃反射：天空全景（与天空球、水面同一张图、同一套调色），只作用在窗格上。 */
  uEnv: { value: THREE.Texture | null };
  uEnvStrength: { value: number };
  uGradeTop: { value: THREE.Color };
  uGradeHorizon: { value: THREE.Color };
  uGradeAmount: { value: number };
  uSkyYaw: { value: number };
};

/** 立面材质：程序化窗格贴图负责「看得出是窗」，照片（可选）只调制材质明暗——
 *  照片立面直接当窗格用时，城市尺度下玻璃幕墙读成瓷砖墙，窄楼读成条形码（两轮截图实测）。
 *  uSelfLit：按自身颜色补一点自发光，日落主题的粉/紫色光会把薄荷、青色楼中和成灰。 */
export function facadeMaterial(map: THREE.Texture, uniforms: FacadeUniforms, key: string): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ map });
  // 楼层按实例属性拉伸立面纹理的 v 轴：一根 InstancedMesh 搞定所有高度。
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aFloors;\nattribute vec2 aLight;\nvarying vec2 vLight;\nuniform float uRows;\nuniform float uPhotoRows;\nuniform float uTileWidth;\nvarying vec2 vPhotoUv;\nvarying vec3 vFacadeWorld;\nvarying vec3 vFacadeNormal;\nvarying float vBuildSeed;")
      .replace("#include <project_vertex>", `#include <project_vertex>
vFacadeWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
vBuildSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
vLight = aLight;
// 盒子的面法线是轴向的：经实例矩阵（只有 yaw + 缩放）变换后归一化即为世界法线。
vFacadeNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);`)
      // 照片 UV 横向按「这个面的真实宽度 / 一块照片的宽度」平铺。宽度从实例矩阵读：
      // ±x 面的宽是 z 轴缩放，±z 面是 x 轴缩放。
      .replace("#include <uv_vertex>", `#include <uv_vertex>
#ifdef USE_MAP
vec2 baseUv = vMapUv;
vMapUv.y *= aFloors / uRows;
float faceWidth = abs(normal.x) > 0.5 ? length(instanceMatrix[2].xyz) : length(instanceMatrix[0].xyz);
vPhotoUv = vec2(baseUv.x * faceWidth / max(uTileWidth, 1.0), baseUv.y * aFloors / max(uPhotoRows, 1.0));
#endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
uniform float uPhoto;
uniform sampler2D uPhotoTex;
uniform float uSelfLit;
uniform sampler2D uEnv;
uniform float uEnvStrength;
uniform vec3 uGradeTop;
uniform vec3 uGradeHorizon;
uniform float uGradeAmount;
uniform float uSkyYaw;
varying vec2 vPhotoUv;
varying vec3 vFacadeWorld;
varying vec3 vFacadeNormal;
varying float vBuildSeed;
varying vec2 vLight;
uniform float uRateRes;
uniform float uRateOff;
uniform float uWindowGlow;
uniform vec2 uGrid;
float facadeWindow = 0.0;
float cellHash(vec2 c, float s) { return fract(sin(dot(c, vec2(127.1, 311.7)) + s * 91.7) * 43758.5453); }
${FACADE_SKY_GLSL}`)
      .replace("#include <map_fragment>", `#ifdef USE_MAP
  vec4 facadeTexel = texture2D( map, vMapUv );
  // 窗格遮罩：程序化立面里窗是暗格、墙是亮底。只让窗反光——整面反光的楼像一面镜子。
  facadeWindow = 1.0 - smoothstep(0.22, 0.5, dot(facadeTexel.rgb, vec3(0.2126, 0.7152, 0.0722)));
  diffuseColor *= facadeTexel;
  if (uPhoto > 0.5) {
    float l = dot(texture2D(uPhotoTex, vPhotoUv).rgb, vec3(0.2126, 0.7152, 0.0722));
    diffuseColor.rgb *= mix(0.8 + 0.45 * smoothstep(0.03, 0.5, l), 1.0, facadeWindow);
  }
#endif`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * uSelfLit;
// 夜里亮窗：只有窗格发光，每扇窗按 (楼, 窗格) hash 决定亮不亮，暖黄/冷白两种灯色；墙面保持暗。
// 曾把 uSelfLit 抬到 0.58 作用在整个立面颜色上——墙和窗一起发光，整栋楼是一块奶白色的纸盒。
if (uWindowGlow > 0.02) {
  vec2 cell = floor(vec2(vMapUv.x * uGrid.x, vMapUv.y * uGrid.y));
  // N2：亮灯与亮度/色温都有分布——多数窗暗、少数很亮（平方分布），色温 2400K 暖黄到 5000K 冷白连续；
  // 亮灯率随本地时段（uRateRes/uRateOff）与用途变化：办公楼整层同亮同灭（按楼层 hash），住宅零星；
  // 活跃会话（vLight.y）夜里更亮（cityLightBudget.activeBoost 的 GLSL 镜像）。
  float office = vLight.x;
  float rate = mix(uRateRes, uRateOff, office);
  rate = mix(rate, min(1.0, max(0.45, rate + 0.25)), vLight.y);
  float perWindow = cellHash(cell, vBuildSeed);
  float perFloor = cellHash(vec2(0.0, cell.y), vBuildSeed + 7.0);
  float pick = mix(perWindow, perFloor, 0.75 * office);
  float on = step(pick, rate * (0.55 + 0.9 * vBuildSeed) * smoothstep(0.1, 0.95, uWindowGlow));
  float h2 = cellHash(cell + 31.0, vBuildSeed);
  float temp = cellHash(cell + 17.0, vBuildSeed);
  vec3 lamp = mix(vec3(1.0, 0.62, 0.28), vec3(0.78, 0.88, 1.0), smoothstep(0.55, 1.0, temp));
  totalEmissiveRadiance += lamp * facadeWindow * on * uWindowGlow * (0.3 + 1.7 * h2 * h2);
  // 窗下漏光：亮窗正下方的墙面极弱地被照亮（强度 ×0.12），窗不再是孤立的亮块。
  float below = smoothstep(0.38, 0.0, fract(vMapUv.y * uGrid.y));
  totalEmissiveRadiance += lamp * (1.0 - facadeWindow) * on * uWindowGlow * 0.12 * below * (0.3 + 1.7 * h2 * h2) * 0.5;
}`)
      // 光照算完之后再混反射：玻璃的颜色主要来自它映出的天空，不受漫反射光的明暗支配。
      .replace("#include <opaque_fragment>", `if (uEnvStrength > 0.0) {
  vec3 viewDir = normalize(vFacadeWorld - cameraPosition);
  vec3 n = normalize(vFacadeNormal);
  vec3 reflected = reflect(viewDir, n);
  // 反射向下看到的是地面/邻楼（环境图里没有）：压暗而不是映天空。
  float skyward = smoothstep(-0.15, 0.25, reflected.y);
  float fresnel = 0.06 + 0.94 * pow(1.0 - max(dot(-viewDir, n), 0.0), 4.0);
  // 俯视时反射多朝下（映地面），只轻压：压太狠玻璃发黑，航拍视角下大部分时间都是这个角度。
  vec3 reflection = facadeSky(reflected) * mix(0.68, 1.0, skyward);
  outgoingLight = mix(outgoingLight, reflection, clamp(facadeWindow * uEnvStrength * (0.35 + 0.65 * fresnel), 0.0, 0.92));
}
#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => `city-facade-${key}`;
  return material;
}
