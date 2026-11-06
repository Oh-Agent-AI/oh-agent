/**
 * 城市视觉主题：写实日光（day）与 80 年代迈阿密日落（vice）。
 * 主题只改「观感」——天空/光色/水色/地面色/植被/执行环境配色；楼位、高度、数据含义一律不变。
 * 执行环境配色在两个主题里都必须互相可分辨（色相不同），因为楼的颜色承载「哪个执行环境」。
 */

export type CityThemeName = "miami";

export type HarnessPaletteEntry = { wall: string; roof: string; accent: string; park: string };

export type CityTheme = {
  name: CityThemeName;
  /** 天空穹顶：天顶 / 中段 / 地平线三色渐变，地平线色同时是水面远处淡出色与 scene.background。 */
  skyTop: string;
  skyMid: string;
  skyHorizon: string;
  fog: string;
  hemiSky: string;
  hemiGround: string;
  /** 环境光（半球光）。影子里只缺太阳那一项，环境光一强影子就浅到看不见——曾 0.6/1.0，影子被地面纹理淹没。 */
  hemiIntensity: number;
  sunColor: string;
  sunIntensity: number;
  /** 太阳方位与高度角（度）。方位与天空全景里太阳的位置对齐（等距柱状 u = atan(z,x)/2π + 0.5），
   *  地上的影子方向才和天上的亮处一致。高度角越低影子越长。 */
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  /** 天空全景图里太阳所在的方位（度）。全景按 sunAzimuthDeg − 这个值旋转，天上亮处与地上影子同向。 */
  skySunAzimuthDeg: number;
  exposure: number;
  water: { deep: string; shallow: string; sky: string };
  /** 水面距离淡出区间（相机距离）：日落主题拉远，免得整片海都被橙雾吃掉。 */
  waterFog: [number, number];
  /** 天空球素材（HDR 转出的全景图）；加载前/失败时用 skyTop/skyMid/skyHorizon 渐变。 */
  skyImage: "dusk";
  /** 天空调色：天顶色、地平线色、强度（0 = 原图）。日落主题靠它把黄昏图染成粉紫。 */
  skyGrade: { top: string; horizon: string; amount: number };
  /** 地面着色（RGB 0-255）：水下 / 沙滩 / 低草 / 高草 / 岩石。 */
  ground: { sea: [number, number, number]; sand: [number, number, number]; lawn: [number, number, number]; grass: [number, number, number]; rock: [number, number, number] };
  /** 霓虹屋顶描边 + bloom 后处理（仅日落主题；低画质档自动关闭 bloom）。 */
  neon: boolean;
  vegetation: "round" | "palm";
  trunk: string;
  foliage: string;
  /** 沿街行道树间距（0 = 不种）。 */
  streetTreeSpacing: number;
  harnesses: Record<string, HarnessPaletteEntry>;
  fallback: HarnessPaletteEntry;
};

/** 唯一的皮肤：迈阿密风（Miami Vice）——珊瑚/青/薄荷/紫的粉彩执行环境色、棕榈行道树、屋顶霓虹与 bloom。
 *  曾有「日光」「日落霓虹」两个主题可切换；24 小时昼夜（citySky）上线后，白天/黄昏/夜晚由光照负责，
 *  主题开关只剩「同一座城两种配色」的重复，且日光版明显粗糙，于是只保留这一套。 */
const MIAMI: CityTheme = {
  name: "miami",
  skyTop: "#2b1f6b",
  skyMid: "#e0529c",
  skyHorizon: "#ffb072",
  fog: "#ffa98a",
  hemiSky: "#ffc9e6",
  hemiGround: "#9a80d6",
  hemiIntensity: 0.55,
  sunColor: "#ffd9bd",
  sunIntensity: 2.4,
  sunAzimuthDeg: -60,
  sunElevationDeg: 16,
  skySunAzimuthDeg: 43,
  exposure: 1.18,
  water: { deep: "#1a86c4", shallow: "#52dbe0", sky: "#ff9ccf" },
  waterFog: [1500, 4200],
  skyImage: "dusk",
  skyGrade: { top: "#6b3fb0", horizon: "#ff9a6b", amount: 0.62 },
  ground: { sea: [28, 110, 150], sand: [250, 232, 200], lawn: [118, 208, 156], grass: [84, 180, 132], rock: [190, 150, 170] },
  neon: true,
  vegetation: "palm",
  trunk: "#a98462",
  foliage: "#2fbf77",
  streetTreeSpacing: 17,
  // 每个执行环境一个色相（珊瑚/青/薄荷/靛/紫/粉），粉彩楼身 + 饱和屋顶，保证一眼可分。
  // manifest 安装的宿主一律按 `harness:<slug>` 键；`plugin:` 是迁移期旧前缀，查表时折算。
  harnesses: {
    "claude-code": { wall: "#ffd2c4", roof: "#ff6f9f", accent: "#ff6f6f", park: "#7fd6a4" },
    codex: { wall: "#c4f4f6", roof: "#3cc3d2", accent: "#27c4d6", park: "#7fd6a4" },
    dsh: { wall: "#c8f7e0", roof: "#45d0a2", accent: "#34d29c", park: "#7fd6a4" },
    workbuddy: { wall: "#c9d8ff", roof: "#5a7bff", accent: "#4d7cff", park: "#7fd6a4" },
    "harness:zcode": { wall: "#e3d2ff", roof: "#9a6cf5", accent: "#9a6bff", park: "#7fd6a4" },
    "harness:minimax-code": { wall: "#ffc9ea", roof: "#ea58ac", accent: "#ff5cb8", park: "#7fd6a4" },
  },
  fallback: { wall: "#f6e6cf", roof: "#d9a98c", accent: "#e8a07a", park: "#86d6a6" },
};


/** 天空全景的 u 偏移（0–1）：着色器里 u = atan(z,x)/2π + 0.5 + skyYaw。 */
export function skyYawOf(theme: CityTheme): number {
  return (theme.skySunAzimuthDeg - theme.sunAzimuthDeg) / 360;
}

/** 当前皮肤（唯一）：纹理/配色/植被在构建期读取。 */
export function activeTheme(): CityTheme {
  return MIAMI;
}

/** 生态带调色（CITY_PLANNING_SPEC §4.1）：只改观感、不改数据语义；与主题叠加而非替换，
 *  所以日光/日落霓虹两个主题下五种生态带仍然各不相同、又保持各自的整体色调。
 *  ground 值为目标色（0–255），按 groundAmount 向目标混合；water 为水面两色的目标色。
 *  地面混合量取适中：地面细节着色器按颜色把像素分类成沥青/沙/草（见 installGroundDetail），混得太满会分类错。 */
export type BiomeGrade = {
  ground: Partial<Record<"sand" | "lawn" | "grass" | "rock", [number, number, number]>>;
  groundAmount: number;
  water: { shallow: string; deep: string } | null;
  waterAmount: number;
};

export const BIOME_GRADES: Record<"tropical" | "temperate" | "boreal" | "savanna" | "eastasian", BiomeGrade> = {
  tropical: { ground: { sand: [255, 241, 208], lawn: [104, 204, 138], grass: [74, 178, 118] }, groundAmount: 0.75, water: { shallow: "#5fe0d0", deep: "#0f8fb8" }, waterAmount: 0.65 },
  temperate: { ground: {}, groundAmount: 0, water: null, waterAmount: 0 },
  boreal: { ground: { sand: [170, 162, 146], lawn: [84, 118, 92], grass: [62, 96, 74], rock: [128, 128, 126] }, groundAmount: 0.8, water: { shallow: "#7da4b4", deep: "#1c4258" }, waterAmount: 0.65 },
  savanna: { ground: { sand: [228, 192, 128], lawn: [186, 172, 98], grass: [164, 150, 84], rock: [168, 128, 96] }, groundAmount: 0.8, water: { shallow: "#7cc7b0", deep: "#2f7f78" }, waterAmount: 0.6 },
  eastasian: { ground: { lawn: [118, 176, 108], grass: [92, 150, 96] }, groundAmount: 0.7, water: { shallow: "#8fd6bf", deep: "#2c8a86" }, waterAmount: 0.65 },
};

/** 主题地面色 + 生态带调色。 */
export function groundFor(theme: CityTheme, biome: keyof typeof BIOME_GRADES): CityTheme["ground"] {
  const grade = BIOME_GRADES[biome];
  if (!grade || !grade.groundAmount) return theme.ground;
  const mix = (a: [number, number, number], b?: [number, number, number]): [number, number, number] =>
    b ? [a[0] + (b[0] - a[0]) * grade.groundAmount, a[1] + (b[1] - a[1]) * grade.groundAmount, a[2] + (b[2] - a[2]) * grade.groundAmount] : a;
  return { sea: theme.ground.sea, sand: mix(theme.ground.sand, grade.ground.sand), lawn: mix(theme.ground.lawn, grade.ground.lawn), grass: mix(theme.ground.grass, grade.ground.grass), rock: mix(theme.ground.rock, grade.ground.rock) };
}
