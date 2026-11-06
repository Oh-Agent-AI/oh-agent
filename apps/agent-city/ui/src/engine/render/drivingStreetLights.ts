/**
 * 开车模式解析街灯（CITY_NIGHT_LIGHTING_SPEC N5）：仅游戏相机（cameraOwner === "game"）激活。
 * 普通模式 / 飞行模式 / 导片 worker 的 uCarLampCount 恒为 0，所有受光材质的注入块早退，行为不变。
 *
 * 架构沿 night-street（MIT，github.com/StarKnightt/night-street）的「解析式光源」：灯不是
 * THREE.Light 对象，而是 uniform 数组里的数据（位置+坎德拉 / 发射轴+横路压缩 / 色度），
 * 由每个真正受光的材质在自己的 shader 里解析求值，加进 reflectedLight.directDiffuse——
 * 与 three 自身光照管线同构，天然吃材质反照率与法线，并与其他光照正确相加。
 *
 * 光度学分布是路灯的「蝙蝠翼」：平坦路面要均匀照度，强度须 ∝ 1/cos³（nadir 角）——
 * 余弦幂是收窄函数（灯下最亮、四周单调衰掉），恰好是贴纸圆片的病根；真反光器把光
 * 往远处扔，相邻光池才会搭接。横路方向用压缩因子 k 收紧（光投向车道而不是两侧），
 * 截止角之外 smoothstep 归零（光不进窗户、不照亮灯碗上方）。立方先取下限再倒数：
 * 截止区零乘无穷 = 沿路缘每帧一个黑 NaN 碎片（night-street 实测踩过）。
 *
 * 交叉淡化：解析光在 FADE_NEAR..FADE_FAR 带内随「相机到灯」的距离淡出，nightLighting 的
 * 贴纸光斑在同一距离带上淡入（vPoolWorld 片元距离），两边互补——总量近似守恒，无双重
 * 照亮；被换出 16 盏名单的灯在带外权重已为 0，无切换爆闪。
 *
 * 强度/色度全部取 LIGHT_BUDGET（N4）；每盏灯的 warm-up 进度由灯位种子确定性哈希，
 * 同一盏灯每帧同色，灯与灯之间按钠灯启辉曲线错开（颜色先于亮度稳定）。
 */
import * as THREE from "three";
import { LIGHT_BUDGET, lampWarmChroma, lampWarmOutput, lampWarmth } from "../cityLightBudget";
import type { StreetLampPlan } from "./nightLighting";

/** 每帧参与求值的灯数（相机最近者）。30m 间距双侧交错 ≈ 每 15m 一盏，16 盏覆盖前方两三百米。 */
export const CAR_LAMP_COUNT_MAX = 16;
/** 交叉淡化带（米）：解析光在此带内淡出、贴纸光斑淡入。两端常量同时注入两处 shader，必须同步。 */
export const CAR_LAMP_FADE_NEAR = 40;
export const CAR_LAMP_FADE_FAR = 70;

/* 蝙蝠翼形状参数（光度学形状，不是强度——强度走 LIGHT_BUDGET.street.analyticCd）：
 * k 横路压缩；峰值上限（倍天底）；截止的余弦带。取自 night-street 标定的半截止光学。 */
const LAMP_CROSS = 2.2;
const LAMP_PEAK = 2.4;
const LAMP_CUT0 = 0.18;
const LAMP_CUT1 = 0.32;

/* 模块级共享 uniform（night-street 的单例模式）：一份灯位数据，所有受光材质看同一组对象。 */
const ptP: THREE.Vector4[] = [];   // xyz 灯头光学中心，w = cd × night × fade × warm-up
const ptD: THREE.Vector4[] = [];   // xyz 发射轴（向下、朝路心），w = 横路压缩因子
const ptC: THREE.Vector3[] = [];   // 色度（峰值通道 1）
for (let i = 0; i < CAR_LAMP_COUNT_MAX; i++) {
  ptP.push(new THREE.Vector4(0, -1000, 0, 0));
  ptD.push(new THREE.Vector4(0, -1, 0, LAMP_CROSS));
  ptC.push(new THREE.Vector3(1, 1, 1));
}
const lampCount = { value: 0 };
const poolFadeCenter = { value: new THREE.Vector3(0, 0, 0) };
const poolFadeOn = { value: 0 };

/** 受光材质 onBeforeCompile 里合并这份 uniforms（同一对象引用，更新一处全体可见）。 */
export function carStreetLightUniforms(): Record<string, { value: unknown }> {
  return {
    uCarLampP: { value: ptP },
    uCarLampD: { value: ptD },
    uCarLampC: { value: ptC },
    uCarLampCount: lampCount,
  };
}

/** 贴纸光斑淡化 uniforms（nightLighting 的 pools 材质用，与本模块的解析淡入互补）。 */
export function carPoolFadeUniforms(): Record<string, { value: unknown }> {
  return { uPoolFadeCenter: poolFadeCenter, uPoolFadeOn: poolFadeOn };
}

/** 片元声明 + 求值函数：注入受光材质 fragment 的 <common> 之后。 */
export const CAR_STREET_LIGHT_GLSL = /* glsl */ `
#define CAR_LAMP_MAX ${CAR_LAMP_COUNT_MAX}
uniform vec4 uCarLampP[CAR_LAMP_MAX];
uniform vec4 uCarLampD[CAR_LAMP_MAX];
uniform vec3 uCarLampC[CAR_LAMP_MAX];
uniform float uCarLampCount;

vec3 carStreetLight(vec3 P, vec3 N){
  vec3 E = vec3(0.0);
  int count = int(uCarLampCount + 0.5);
  for (int i = 0; i < CAR_LAMP_MAX; i++){
    if (i >= count) break;
    vec3 d = uCarLampP[i].xyz - P;
    // 平方反比在 200mm 处下限：灯具几何内部是奇点，唯一会触发的地方是灯杆自己脚下。
    float d2 = max(dot(d, d), 0.04);
    // 单比较距离剔除：w 已含 night 与 fade，零贡献的灯一次比较就走。
    if (uCarLampP[i].w * ${LAMP_PEAK.toFixed(2)} < 0.001 * d2) continue;
    vec3 L = d * inversesqrt(d2);
    float ndl = max(dot(N, L), 0.0);
    if (ndl <= 0.0) continue;
    vec3 A = uCarLampD[i].xyz;
    float ax = max(-dot(L, A), 0.0);
    // T：光源→受光点方向去掉轴向分量后的横向部分（A 近竖直 ⇒ T 近水平）。
    vec3 T = (-L) - ax * A;
    // 臂指向路心的水平方向 Ah：横路 = T 在 Ah 上的分量，沿路 = 其垂直分量。
    vec3 Ah = normalize(vec3(A.x, 0.0, A.z));
    float ts = dot(T, vec3(-Ah.z, 0.0, Ah.x));
    float tc = dot(T, Ah);
    // 压缩后的等效天底余弦：横路分量按 k 放大，光池沿路拉长、横路收紧。
    float cs = ax * inversesqrt(ax * ax + ts * ts + uCarLampD[i].w * uCarLampD[i].w * tc * tc + 1e-9);
    // 蝙蝠翼 1/cs^3 封顶 + 截止带；立方先取下限，截止区的 0×∞ 是 NaN。
    float lobe = min(1.0 / max(cs * cs * cs, 1.0 / ${LAMP_PEAK.toFixed(2)}), ${LAMP_PEAK.toFixed(2)})
               * smoothstep(${LAMP_CUT0.toFixed(3)}, ${LAMP_CUT1.toFixed(3)}, cs);
    E += uCarLampC[i].rgb * (uCarLampP[i].w * lobe * ndl / d2);
  }
  return E;
}
`;

/** 求值注入块：挂在 <lights_fragment_end> 之后（Lambert/Standard 通吃，BRDF_Lambert 两边都有）。 */
export function carLampsAdd(worldPos: string, worldNormal: string): string {
  return /* glsl */ `
{
  if (uCarLampCount > 0.5) {
    vec3 carLampE = carStreetLight(${worldPos}, normalize(${worldNormal}));
    reflectedLight.directDiffuse += carLampE * BRDF_Lambert(diffuseColor.rgb);
  }
}`;
}

const smoothstepRange = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** 每帧由开车模式调用：取离相机最近的灯写入 uniform 数组。夜量 night ∈ [0,1] 由调用方给。 */
export function updateCarStreetLamps(plan: readonly StreetLampPlan[], camX: number, camZ: number, night: number): void {
  if (night <= 0.03) { clearCarStreetLamps(); return; }
  // 最近 N 盏：小顶数组插入，全表一遍线性扫（4600 盏量级，一次比较为主）。
  const top: Array<{ d2: number; index: number }> = [];
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const dx = p.x - camX; const dz = p.z - camZ;
    const d2 = dx * dx + dz * dz;
    if (top.length < CAR_LAMP_COUNT_MAX) {
      top.push({ d2, index: i }); top.sort((a, b) => a.d2 - b.d2);
    } else if (d2 < top[CAR_LAMP_COUNT_MAX - 1].d2) {
      top[CAR_LAMP_COUNT_MAX - 1] = { d2, index: i };
      for (let k = top.length - 1; k > 0 && top[k].d2 < top[k - 1].d2; k--) {
        const swap = top[k]; top[k] = top[k - 1]; top[k - 1] = swap;
      }
    }
  }
  for (let slot = 0; slot < top.length; slot++) {
    const p = plan[top[slot].index];
    const d = Math.sqrt(top[slot].d2);
    // 交叉淡出：与贴纸光斑的片元淡入同带互补。
    const fade = 1 - smoothstepRange(CAR_LAMP_FADE_NEAR, CAR_LAMP_FADE_FAR, d);
    const warmth = lampWarmth(p.seed);
    const cd = LIGHT_BUDGET.street.analyticCd * (0.4 + 0.6 * p.tier) * lampWarmOutput(warmth) * night * fade;
    const chroma = lampWarmChroma(warmth);
    ptP[slot].set(p.hx, p.hy, p.hz, cd);
    const axis = new THREE.Vector3(-p.nx * 0.39, -1, -p.nz * 0.39).normalize();
    ptD[slot].set(axis.x, axis.y, axis.z, LAMP_CROSS);
    ptC[slot].set(chroma[0], chroma[1], chroma[2]);
  }
  lampCount.value = top.length;
  poolFadeCenter.value.set(camX, 0, camZ);
  poolFadeOn.value = 1;
}

/** 退出开车模式（或白天）：清零解析灯并放开贴纸光斑。 */
export function clearCarStreetLamps(): void {
  lampCount.value = 0;
  poolFadeOn.value = 0;
}
