/**
 * 昼夜光照配方与插值（架构借鉴 tinyskies/GlobeFly 的 SkyPreset + DayNightCycle
 * 思路，自研实现并适配 Agent City 的 theme/engine 体系）：
 *
 *  · 一个 preset 描述"整套环境"：天穹三段渐变、雾、半球光、太阳（颜色/强度/
 *    方位高度角）、水面两色、云透明度、建筑自发光（夜晚亮窗）、星空强度；
 *  · 一天 24 小时映射为关键帧序列，实时插值——live 模式跟随真实本地时间，
 *    回放模式跟随时间轴游标：回放城市生长时昼夜随之流转；
 *  · apply() 把状态写进引擎各 uniform/光照对象，每帧成本为常数次颜色插值。
 */

import * as THREE from "three";
import type { CityTheme } from "./cityTheme";

export type CitySkyPreset = {
  /** 天穹三段渐变（顶/中/地平线）。 */
  top: string;
  middle: string;
  horizon: string;
  fog: string;
  fogNearFactor: number;
  fogFarFactor: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  sunColor: string;
  sunIntensity: number;
  /** 太阳方位角（弧度，绕城心）与高度角（弧度）。 */
  sunAzimuth: number;
  sunElevation: number;
  /** 三点布光的补光/轮廓光（参考 tinyskies 的 fill/back，颜色+强度）。 */
  fillColor: string;
  fillIntensity: number;
  backColor: string;
  backIntensity: number;
  waterShallow: string;
  waterDeep: string;
  cloudOpacity: number;
  /** 建筑立面自发光倍率（夜晚城市亮窗）。 */
  selfLit: number;
  /** 天穹程序星点强度 0..1。 */
  stars: number;
};

const DAY: CitySkyPreset = {
  top: "#a3cee6", middle: "#cfe6ea", horizon: "#eef6ee",
  fog: "#dfeef2", fogNearFactor: 2.1, fogFarFactor: 7.5,
  hemiSky: "#eaf6fa", hemiGround: "#cbbfa6", hemiIntensity: 0.95,
  sunColor: "#fff3de", sunIntensity: 1.55,
  sunAzimuth: 1.05, sunElevation: 0.95,
  fillColor: "#cfe8ef", fillIntensity: 0.35, backColor: "#ffffff", backIntensity: 0.15,
  waterShallow: "#a5d6da", waterDeep: "#57a3b4",
  cloudOpacity: 0.88, selfLit: 0.05, stars: 0,
};

const DUSK: CitySkyPreset = {
  top: "#7f8fb4", middle: "#e3b07e", horizon: "#f4d9a6",
  fog: "#e9d6bc", fogNearFactor: 1.9, fogFarFactor: 7.0,
  hemiSky: "#f0dcc2", hemiGround: "#8d7c66", hemiIntensity: 0.72,
  sunColor: "#ffcf96", sunIntensity: 1.05,
  sunAzimuth: 3.35, sunElevation: 0.18,
  fillColor: "#ffd2a0", fillIntensity: 0.55, backColor: "#ff9a5e", backIntensity: 0.5,
  waterShallow: "#d3bd93", waterDeep: "#5f7383",
  // 18:00 起城市灯光要明确亮起：黄昏档就把亮窗推高，入夜接满档。
  cloudOpacity: 0.8, selfLit: 0.8, stars: 0.15,
};

const NIGHT: CitySkyPreset = {
  top: "#141f3a", middle: "#223358", horizon: "#42598a",
  fog: "#1f3050", fogNearFactor: 1.7, fogFarFactor: 6.4,
  // 夜里的月光环境光：曾是 #2c3f66 × 0.52，远山/气球/地面几乎纯黑；抬到能看出轮廓与地面的程度。
  hemiSky: "#4d67a6", hemiGround: "#2b3652", hemiIntensity: 0.9,
  sunColor: "#a9bde0", sunIntensity: 0.32,
  sunAzimuth: 4.4, sunElevation: 0.7,
  fillColor: "#3d5688", fillIntensity: 0.42, backColor: "#6b86c0", backIntensity: 0.45,
  waterShallow: "#27415e", waterDeep: "#101f33",
  cloudOpacity: 0.55, selfLit: 1.0, stars: 1,
};

/** 一天的关键帧：小时 → 档位（相邻关键帧线性过渡，黎明/黄昏各 ~1.5h）。 */
/**
 * 分时主题注入（VICE B5）：theme 提供各时段覆盖端点——同一套主题色不再灌满
 * 全天（白天/黄昏/夜晚各有自己的天色/水色/灯光端点）。只覆盖主题声明的字段，
 * 未声明字段保持关键帧默认值。当前 Miami 皮肤覆盖：白天青蓝水、黄昏粉紫天 +
 * 青水（修「DUSK 水色偏灰黄」）、夜晚暖窗与道路可辨轮廓。
 */
type SkyOverrides = { day?: Partial<CitySkyPreset>; dusk?: Partial<CitySkyPreset>; night?: Partial<CitySkyPreset> };
const THEME_SKY: Partial<Record<string, SkyOverrides>> = {
  miami: {
    day: { waterShallow: "#52dbe0", waterDeep: "#1a86c4", hemiGround: "#d6c4a8" },
    dusk: { top: "#3d2a7a", middle: "#d84a94", horizon: "#ff9a6b", fog: "#e08a72",
            waterShallow: "#4ecfd6", waterDeep: "#15759f",
            sunColor: "#ffb072", fillColor: "#e8a0b8" },
    night: { top: "#1a1245", middle: "#2e1f5e", horizon: "#4a3570", fog: "#3a2a55",
             waterShallow: "#1a4a5e", waterDeep: "#0d2a3e" },
  },
};

const KEYFRAMES: Array<{ hour: number; preset: CitySkyPreset }> = [
  { hour: 0, preset: NIGHT },
  { hour: 5, preset: NIGHT },
  { hour: 6.5, preset: DUSK },
  { hour: 8, preset: DAY },
  { hour: 16.5, preset: DAY },
  // 城市灯光：18:00 起渐亮（day→dusk 过渡），19:00 起夜档全亮。
  { hour: 18.5, preset: DUSK },
  { hour: 19, preset: NIGHT },
  { hour: 24, preset: NIGHT },
];

type ColorSlot = "top" | "middle" | "horizon" | "fog" | "hemiSky" | "hemiGround" | "sunColor" | "fillColor" | "backColor" | "waterShallow" | "waterDeep";
const COLOR_SLOTS: ColorSlot[] = ["top", "middle", "horizon", "fog", "hemiSky", "hemiGround", "sunColor", "fillColor", "backColor", "waterShallow", "waterDeep"];

const colorA = new THREE.Color();
const colorB = new THREE.Color();
const scratch: CitySkyPreset = {
  top: "", middle: "", horizon: "", fog: "",
  fogNearFactor: 0, fogFarFactor: 0,
  hemiSky: "", hemiGround: "", hemiIntensity: 0,
  sunColor: "", sunIntensity: 0, sunAzimuth: 0, sunElevation: 0,
  fillColor: "", fillIntensity: 0, backColor: "", backIntensity: 0,
  waterShallow: "", waterDeep: "", cloudOpacity: 0, selfLit: 0, stars: 0,
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColorInto(target: THREE.Color, a: string, b: string, t: number): void {
  colorA.set(a);
  colorB.set(b);
  target.copy(colorA).lerp(colorB, t);
}

/** hour ∈ [0,24) → 插值出的环境状态（写入复用的 scratch 对象，避免每帧分配）。
 *  theme 时按分时覆盖端点（见 THEME_SKY）：仅覆盖声明字段，其余保持关键帧默认。 */
export function skyStateAt(hour: number, theme?: string): CitySkyPreset {
  const overrides = theme ? THEME_SKY[theme] : undefined;
  const clamped = ((hour % 24) + 24) % 24;
  let from = KEYFRAMES[0];
  let to = KEYFRAMES[KEYFRAMES.length - 1];
  let t = 0;
  for (let index = 1; index < KEYFRAMES.length; index += 1) {
    if (clamped >= KEYFRAMES[index - 1].hour && clamped <= KEYFRAMES[index].hour) {
      from = KEYFRAMES[index - 1];
      to = KEYFRAMES[index];
      const span = to.hour - from.hour || 1;
      t = (clamped - from.hour) / span;
      break;
    }
  }
  const phase = from === KEYFRAMES[0] || from === KEYFRAMES[1] ? "night"
    : from === KEYFRAMES[2] ? "dusk" : from === KEYFRAMES[4] ? "day" : from === KEYFRAMES[5] ? "dusk" : "night";
  const phaseTo = to === KEYFRAMES[3] ? "day" : to === KEYFRAMES[6] || to === KEYFRAMES[7] ? "night" : to === KEYFRAMES[2] || to === KEYFRAMES[5] ? "dusk" : phase;
  const a = { ...from.preset, ...(overrides?.[phase as keyof SkyOverrides] ?? {}) };
  const b = { ...to.preset, ...(overrides?.[phaseTo as keyof SkyOverrides] ?? {}) };
  // 颜色字段插值成 hex 字符串（保持 preset 类型简单）；数值字段线性。
  const writeColor = (slot: ColorSlot) => {
    colorA.set(a[slot]);
    colorB.set(b[slot]);
    colorA.lerp(colorB, t);
    scratch[slot] = `#${colorA.getHexString()}`;
  };
  COLOR_SLOTS.forEach(writeColor);
  scratch.fogNearFactor = lerp(a.fogNearFactor, b.fogNearFactor, t);
  scratch.fogFarFactor = lerp(a.fogFarFactor, b.fogFarFactor, t);
  scratch.hemiIntensity = lerp(a.hemiIntensity, b.hemiIntensity, t);
  scratch.sunIntensity = lerp(a.sunIntensity, b.sunIntensity, t);
  scratch.sunAzimuth = lerp(a.sunAzimuth, b.sunAzimuth, t);
  scratch.sunElevation = lerp(a.sunElevation, b.sunElevation, t);
  scratch.fillIntensity = lerp(a.fillIntensity, b.fillIntensity, t);
  scratch.backIntensity = lerp(a.backIntensity, b.backIntensity, t);
  scratch.cloudOpacity = lerp(a.cloudOpacity, b.cloudOpacity, t);
  scratch.selfLit = lerp(a.selfLit, b.selfLit, t);
  scratch.stars = lerp(a.stars, b.stars, t);
  return scratch;
}
