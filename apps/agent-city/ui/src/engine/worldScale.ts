/**
 * 世界比例尺（唯一来源）：1 世界单位 = 2 米。
 *
 * 为什么是 2 米：规划层的尺寸本来就是按这个比例长出来的——会话地块 7.2 × 8（= 14.4 × 16 m，中层楼占地）、
 * 支路/次干道/主干道 5 / 8 / 12（= 10 / 16 / 24 m）、高架 10.5（= 21 m）、街区 ~50 × 50（= 100 × 100 m）、
 * 岛直径 1600–2100（= 3.2–4.2 km）、海湾 300–450（= 600–900 m）。按 1 米读时它们全偏小一半（楼细如签、路窄、
 * 城像沙盘）；把定义改成 2 米，规划层一个数都不用动、基线不变，只有「按真实米建模」的小物件要换算。
 * 审计与对照表见 docs/CITY_SCALE_AUDIT.md。道路/桥面的标准宽度只从 roadStandard.ts 取；本文件中的数字只是比例尺说明。
 *
 * 用法：凡是有真实世界尺寸的东西（人、车、层高、树、路灯、船、沙滩小品、房子），一律写成 `m(真实米数)`，
 * 或直接用下面 REAL 表里的参考值——不要再手写世界单位的魔数。纯常量模块：不依赖 three，规划层与渲染层都可引用。
 */

/** 1 世界单位对应的米数。 */
export const METERS_PER_UNIT = 2;

/**
 * 会话地块模数，规划层与机甲战棋共用。沿街面宽 7.2、进深 8（14.4 × 16 m）。
 * 战棋的一格就是这一块，10×10 是从这套地块里开的一扇窗，不再另铺方格。
 */
export const LOT = { width: 7.2, depth: 8 } as const;

/** 米 → 世界单位。 */
export const m = (meters: number): number => meters / METERS_PER_UNIT;

/** 世界单位 → 米（标注、调试、测量报告用）。 */
export const toMeters = (units: number): number => units * METERS_PER_UNIT;

/** 按 1 单位 = 1 米建模的几何（老模型、外部素材）整体乘这个系数即可换算到当前比例尺。 */
export const METER_MODEL_SCALE = 1 / METERS_PER_UNIT;

/**
 * 真实世界参考尺寸（米）。新物体先在这里找参考值；没有的就按同样的口径补一行，带上依据。
 * 这张表是「看起来对不对」的唯一参照：截图里一个东西显大/显小，先对这张表。
 */
export const REAL = {
  person: { height: 1.75 },
  car: { length: 4.5, width: 1.8, height: 1.5 },
  /** 市区车速 30–50 km/h。 */
  carSpeed: { min: 8.5, max: 14 },
  /** 层高：住宅 3.0、商业/酒店 3.2–3.5；立面窗格与层数都按它算。 */
  floorHeight: 3.2,
  /** 首层/屋顶附加（门厅、女儿墙）。 */
  groundFloorExtra: 1.2,
  lamp: { height: 8, headReach: 0.9 },
  palm: { min: 8, max: 14 },
  broadleafTree: { min: 7, max: 14 },
  conifer: { min: 10, max: 18 },
  bush: { height: 1.5 },
  umbrella: { height: 2.4, diameter: 2.4 },
  lounger: { width: 0.7, length: 2.0, height: 0.35 },
  lifeguardTower: { legHeight: 2.0, hutWidth: 3.2, hutHeight: 2.4, hutDepth: 2.6 },
  /** 沙滩排球场 16 × 8，网高 2.43。 */
  volleyballCourt: { length: 16, width: 8, netHeight: 2.43 },
  /** 小型机动艇：水线以上（含驾驶舱）约 3.8 m。 */
  boat: { length: 12, beam: 3.6, height: 3.8 },
  /** 飞桥游艇（Vice 式比斯坎湾游艇）：水线以上到雷达拱约 9 m。 */
  yacht: { length: 28, beam: 6.5, height: 9 },
  /** 海鸟（军舰鸟 / 褐鹈鹕）翼展。 */
  bird: { wingspan: 2.2 },
  marinaBoat: { min: 7, max: 12, beam: 2.8 },
  pier: { width: 3 },
  /** 海湾豪宅：主楼约 22 × 12 m、两层；整块住宅台地约 34 × 26 m。 */
  mansion: { plotWidth: 34, plotDepth: 26 },
  /** 小区内部环路 8 m、支路 6 m。 */
  estateLoopRoad: 8,
  estateSpurRoad: 6,
} as const;

/**
 * 视觉放大（用户 2026-10-15：「有些物体，为了视觉效果可以调整大小」）。真实尺寸放进城市里有两类东西会读不出来：
 * 远看只剩一个像素的小东西（鸟），和要当天际线锚点的地标（灯塔、凯旋门、庄园）。它们允许按这里的倍数放大——
 * 但放大是**登记过的例外**，不是默认：没在这里的东西一律按 REAL 真实尺寸。
 */
export const VISUAL_BOOST = {
  /** 鸟群在 130–220 m 高空绕城：真实 2.2 m 翼展在常用机位下不到 2 像素，放大 2.5 倍（≈5.5 m）刚好读出 V 字队形。 */
  bird: 2.5,
  /**
   * 玩家车（开车模式，game/carDimensions.ts 的 CAR_DIMENSIONS 2.8 × 1.4 × 1.15）相对 REAL.car（4.5 × 1.8 × 1.5 m
   * = 2.25 × 0.9 × 0.75 单位）的倍数：长 ×1.24、宽 ×1.56、高 ×1.53。追尾视角下车身要读得清，所以比路上的背景车（按 REAL.car）大一圈。
   * **驾驶物理的阈值全以它为基准**（车身包络、可越障 0.144 = 轮半径 0.24 × 0.6、路宽两车道约束……）：不要「顺手修正」成真实尺寸，
   * 改它要整体重测驾驶、碰撞与试驾基线（docs/CITY_WORLD_PRECISION_AND_SIZE_STANDARD_SPEC.md V2/V3）。
   */
  playerCar: { length: 2.8 / 2.25, width: 1.4 / 0.9, height: 1.15 / 0.75 },
  /**
   * 飞行模式双翼机：翼展 = 4.2 × planeRadius，r = clamp(2.2, 5, 城区对角线 × 0.004)（game/FlightSimulation.ts），
   * 即 9.24–21 单位 = 18.5–42 m，对真实双翼机翼展 ~9 m 为 ×2.05–4.67。随地图放大是有意的：大城市全景里飞机要看得见；
   * 飞机的碰撞球半径就是 r，所以这个倍数同时是飞行碰撞的尺度。
   */
  plane: { realWingspan: 9, range: [2.05, 4.67] as const },
  /** 地标停车场里那辆可开的车（engine/render/playableVehicles.ts）：玩家车 ×0.9——玩家车长 2.8 比车位 2.7 略长，原尺寸停进去会压线。 */
  parkedCar: 0.9,
  /** 机坪上那架可开的飞机：游戏飞机 ×0.45（翼展约 4–9.5 单位 = 8–19 m）——原尺寸翼展比 22 宽的跑道还宽，停在机坪上会压住滑行道和航站楼。 */
  parkedPlane: 0.45,
  /**
   * 机坪上那三台可点的机甲（engine/render/playableVehicles.ts）。网格按 1 世界单位 = 2 米建，
   * 战棋一格是两块地，CityMechaWorld 用同一 2× 来画。停着的和开打以后是同一批模型。
   */
  parkedMecha: 2,
} as const;

/**
 * 模型尺寸政策：每个地标/大件模型的真实世界参考高度（米）+ 允许的比例区间 [min, max]（实测高 ÷ 参考高）。
 * 区间 = 1 附近是「按真实尺寸」；> 1 是登记过的视觉放大，< 1 是登记过的压低（比如不压过会话楼天际线）——
 * 两种偏离都必须写理由。scripts/verify-city-world-scale.mjs 在 Node 里构建每个模型（cap = 70 的基准城市）量高度，
 * 超出区间或缺条目即失败。参考值取同类真实建筑的常见高度，不对应任何单体。
 */
export const SIZE_POLICY: Record<string, { real: number; range: readonly [number, number]; why: string }> = {
  "tv-tower": { real: 200, range: [0.65, 1.1], why: "城市电视塔 150–350 m；塔高随会话楼天际线封顶（min(cap, 70)），不压过数据楼，所以允许略矮" },
  "twin-towers": { real: 180, range: [0.75, 1.1], why: "双子办公塔 150–250 m" },
  "twist-tower": { real: 180, range: [0.65, 1.1], why: "扭转住宅塔 150–250 m；与电视塔同样随天际线封顶" },
  "arch": { real: 50, range: [0.9, 1.7], why: "凯旋门式拱门 ~50 m；作为广场轴线端点放大，远景读出拱洞" },
  "sail-opera": { real: 60, range: [0.75, 1.2], why: "帆形歌剧院壳顶 ~65 m" },
  "lighthouse": { real: 35, range: [0.9, 2.3], why: "岬角灯塔 25–45 m；海岸线上唯一的竖向标记，放大以在全景里读出红白条纹" },
  "ferris-wheel": { real: 110, range: [0.75, 1.2], why: "滨海摩天轮 60–135 m" },
  "pagoda": { real: 60, range: [0.75, 1.4], why: "楼阁式塔 40–70 m" },
  "villa-complex": { real: 25, range: [0.9, 2.1], why: "地中海庄园钟塔 ~25 m（主楼两层 ~9 m）；岸线地标，按 1 单位≈1 米建模，等于放大近 2 倍。占地被规划半径 34 与地面物理声明钉住，不随比例尺缩" },
  "islet-mansion": { real: 9, range: [0.8, 1.3], why: "海湾两层豪宅 ~8–9 m" },
  "islet-grounds": { real: 12, range: [0.8, 1.4], why: "岛内场地：棕榈/旗杆/摄影棚 ~10–15 m" },
  "suspension-bridge": { real: 65, range: [0.8, 1.3], why: "悬索桥主塔高出桥面 ≈ 主跨 / 8–10：基准城市主跨 ~550 m → 55–70 m" },
  "airport": { real: 60, range: [0.75, 1.5], why: "机场塔台 40–90 m" },
};
