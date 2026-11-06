import { DetMath as Math } from "./detMath"; // 跨引擎确定性：见 detMath.ts
/**
 * 海滨带契约（CITY_VICE_THEME_TECHNICAL_DESIGN §1 / B1）：把「环岛一圈 waterfront」
 * 收敛为一段连续、朝向良好的海滨街面，并向下游输出沙带/步道/酒店排的空间数据。
 *
 * 纯函数模块：不 import three、不读主题/UI；对城市几何的判定全部经 SeasideWorld
 * 谓词注入（规划层传入 coastDistance/height/slope/river/reservations）。确定性由
 * hashSeed 保证——同 seed 同配置必得同一段；无有效段时整段降级（degraded 带
 * reason），不强行摆放（技术设计 §8 停止条件）。
 *
 * 偏移顺序（沿内向法线，世界单位）：水线 → 湿沙外缘 → 干沙外缘 → 步道中心 →
 * 酒店前排 → 带外缘。湿沙靠水、干沙靠内陆（修订设计纠正过的顺序）。
 */

import { hashSeed } from "../cityModel";
import type { Vec2 } from "./cityLayout";

export type CoastalConfig = {
  profile: "miami-coastal";
  version: number;
  biome: "tropical";
  /** 段选择：期望朝向（段外法线方向，弧度）与偏好衰减角。 */
  preferredAzimuth: number;
  azimuthTolerance: number;
  /** 目标段弧长（弧度）。 */
  segmentArc: number;
  /** 沿内向法线的偏移（世界单位）。 */
  wetSandWidth: number;
  drySandWidth: number;
  promenadeOffset: number;
  boulevardOffset: number;
  hotelOffset: number;
  bandOuter: number;
  /** 校验阈值。 */
  maxCoastalSlope: number;
  maxCoastalHeight: number;
  riverMargin: number;
  siteMargin: number;
  /** 有效采样占比低于该值 → 整段降级。 */
  minValidRatio: number;
  /** 中央海湾（Vice City 式「东岛海滩 + 西岛大陆」）：半宽占岛东西半宽的比例，0 = 不开湾、保持原来的窄河。
   *  湾是把南北向的河整体放宽：两岸成两座岛，跨湾靠主干道的桥（堤道）。 */
  bayHalfWidth: number;
  /** 海湾中线相对岛中心的东偏（占岛半宽的比例，正 = 东）：东岛窄（海滩城），西岛宽（大陆）。 */
  bayShift: number;
};

export const MIAMI_COASTAL: CoastalConfig = {
  profile: "miami-coastal",
  version: 3,
  biome: "tropical",
  // 海滩朝 +x：开湾后 +x 一侧是窄的东岛，海滩铺在它背向海湾的外岸（Ocean Beach 的位置）。
  // 曾朝 +z（π/2），海滩落在整岛的南端，与海湾、东西两岛的构图无关。
  preferredAzimuth: 0,
  azimuthTolerance: 1.2,
  segmentArc: (85 * Math.PI) / 180,
  // 海滨休闲带按 South Beach 的断面放宽（用户反馈「沙滩景观带不够宽」）：
  // 湿沙 0–8 → 干沙 8–40（遮阳伞/沙排场）→ 棕榈公园 40–62（草坪 + 三排错落棕榈，natureSystem 种）
  // → 步道 62 → 滨海大道 74 → 酒店线 92。曾是干沙到 20、步道紧贴在 24，沙滩和大道之间没有公园。
  wetSandWidth: 8,
  drySandWidth: 40,
  promenadeOffset: 62,
  boulevardOffset: 74,
  hotelOffset: 92,
  bandOuter: 108,
  maxCoastalSlope: 0.9,
  maxCoastalHeight: 6,
  riverMargin: 26,
  siteMargin: 14,
  minValidRatio: 0.6,
  // 比例照 Vice City 地图：西岛 ~45%、海湾 ~25%、东岛 ~20%（东岛最窄处约 0.4 个岛半宽）。
  bayHalfWidth: 0.22,
  bayShift: 0.33,
};

export type SeasideSample = {
  azimuth: number;
  waterline: Vec2;
  /** 单位内向法线（指向陆地）。 */
  inward: Vec2;
  wetOuter: Vec2;
  dryOuter: Vec2;
  promenade: Vec2;
  boulevard: Vec2;
  hotelLine: Vec2;
  outer: Vec2;
  /** 酒店线处地面高度。 */
  groundY: number;
  valid: boolean;
  reason?: string;
};

export type SeasideBand = {
  id: string;
  azimuthFrom: number;
  azimuthTo: number;
  samples: SeasideSample[];
  validRatio: number;
  degraded: boolean;
  reason?: string;
};

/** Dense enough to read as a hotel frontage at aerial scale, with a hard cap to bound instances. */
export const seasideHotelCount = (validSampleCount: number): number => Math.min(18, Math.max(8, Math.floor(validSampleCount * 0.62)));

/** 海滨酒店地块（会话楼用）：酒店线上等距的宽地块，朝海。
 *  酒店曾是装饰——无论有没有数据都立着一排、点了没反应（用户：「为什么海滨酒店不能作为执行环境的会话楼？」）。
 *  现在它们是会话地块：所在城区的会话长到海边时才落楼，没被占用的地块什么都不画。
 *  位置/尺寸公式与旧装饰酒店一致（数量、采样间隔、宽 20–29、进深 11.2、朝向 atan2(inward.x, inward.z)）。 */
export function seasideHotelLots(band: SeasideBand | null): Array<{ id: string; x: number; z: number; yaw: number; width: number; depth: number }> {
  if (!band || band.degraded) return [];
  const valid = band.samples.filter((sample) => sample.valid);
  if (valid.length < 3) return [];
  const count = seasideHotelCount(valid.length);
  const lots: Array<{ id: string; x: number; z: number; yaw: number; width: number; depth: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const sample = valid[Math.floor(((i + 0.5) / count) * (valid.length - 1))];
    const seed = hashSeed(`seasidehotel:${i}:${sample.azimuth}`);
    // 酒店比普通会话楼大，但要和城市同一个比例尺：普通地块 7.2 × 8，酒店 11–15 × 9.6（约 1.5–2 倍）。
    // 曾是 19.5–28.6 × 11.2（约 3 倍宽），贴着 7 宽的窄楼像放错了比例尺（用户反馈）。
    const width = 11 + seed * 4;
    // 最小净距：两座酒店用地中心至少隔 max(两座宽度和的一半 + 4, 32)，防短岸
    // 段上相邻采样太近导致酒店体量互相交错（曾只按采样均匀分布，短岸时未查间距）。
    const minGap = Math.max(width * 0.5 + 12, 24);
    const tooClose = lots.some((lot) => Math.hypot(lot.x - sample.hotelLine.x, lot.z - sample.hotelLine.z) < minGap);
    if (tooClose) continue;
    lots.push({ id: `hotel:${i}`, x: sample.hotelLine.x, z: sample.hotelLine.z, yaw: Math.atan2(sample.inward.x, sample.inward.z),
      width, depth: 9.6 });
  }
  return lots;
}

/** 规划层注入的世界判定（全部为近似即可；coastDistance 是保守下界）。 */
export type SeasideWorld = {
  /** 带符号离岸距离近似：陆正海负。 */
  landSignedDistance: (x: number, z: number) => number;
  height: (x: number, z: number) => number;
  slope: (x: number, z: number) => number;
  /** 点到河带边缘的距离（无河返回 Infinity）。 */
  riverDistance: (x: number, z: number) => number;
  reservations: Array<{ x: number; z: number; radius: number }>;
  /** 排除朝向（港口/河口等），at 为方位角、halfWidth 为半宽。 */
  blockedAzimuths: Array<{ at: number; halfWidth: number; weight?: number }>;
  /** 可选：只在满足它的水线点上选段（开湾时 = 湾东侧，海滩只铺东岛外岸）。 */
  eligibleShore?: (p: Vec2) => boolean;
};

const normalizeAngle = (a: number): number => {
  let r = a % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r;
};
const angleDelta = (a: number, b: number): number => {
  const d = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(d, Math.PI * 2 - d);
};

/** 海岸点 i 处的单位内向法线：相邻点切向取垂直，朝向用「指向城心」定向。 */
export function coastInwardNormal(coast: Vec2[], center: Vec2, index: number): Vec2 {
  const n = coast.length;
  const prev = coast[(index - 1 + n) % n];
  const next = coast[(index + 1) % n];
  let tx = next.x - prev.x;
  let tz = next.z - prev.z;
  const len = Math.hypot(tx, tz) || 1;
  tx /= len; tz /= len;
  let nx = -tz;
  let nz = tx;
  const p = coast[index];
  if (nx * (center.x - p.x) + nz * (center.z - p.z) < 0) { nx = -nx; nz = -nz; }
  return { x: nx, z: nz };
}

const offset = (p: Vec2, d: Vec2, amount: number): Vec2 => ({ x: p.x + d.x * amount, z: p.z + d.z * amount });

/** 单个海岸采样的带点计算与校验。 */
function buildSample(point: Vec2, inward: Vec2, azimuth: number, world: SeasideWorld, config: CoastalConfig): SeasideSample {
  const wetOuter = offset(point, inward, config.wetSandWidth);
  const dryOuter = offset(point, inward, config.drySandWidth);
  const promenade = offset(point, inward, config.promenadeOffset);
  const boulevard = offset(point, inward, config.boulevardOffset);
  const hotelLine = offset(point, inward, config.hotelOffset);
  const outer = offset(point, inward, config.bandOuter);
  const groundY = world.height(hotelLine.x, hotelLine.z);
  let valid = true;
  let reason: string | undefined;
  if (world.landSignedDistance(hotelLine.x, hotelLine.z) <= 2) { valid = false; reason = "hotel-line-off-land"; }
  else if (world.landSignedDistance(boulevard.x, boulevard.z) <= 4) { valid = false; reason = "boulevard-off-land"; }
  else if (world.slope(promenade.x, promenade.z) > config.maxCoastalSlope) { valid = false; reason = "steep-promenade"; }
  else if (world.slope(boulevard.x, boulevard.z) > config.maxCoastalSlope) { valid = false; reason = "steep-boulevard"; }
  else if (groundY > config.maxCoastalHeight) { valid = false; reason = "high-ground"; }
  else if (world.height(boulevard.x, boulevard.z) > config.maxCoastalHeight) { valid = false; reason = "boulevard-high-ground"; }
  else if (world.riverDistance(promenade.x, promenade.z) < config.riverMargin) { valid = false; reason = "river"; }
  else if (world.riverDistance(boulevard.x, boulevard.z) < config.riverMargin) { valid = false; reason = "river-boulevard"; }
  else if (world.reservations.some((site) => Math.hypot(hotelLine.x - site.x, hotelLine.z - site.z) < site.radius + config.siteMargin)) { valid = false; reason = "reservation"; }
  else if (world.reservations.some((site) => Math.hypot(boulevard.x - site.x, boulevard.z - site.z) < site.radius + config.siteMargin)) { valid = false; reason = "boulevard-reservation"; }
  return { azimuth, waterline: point, inward, wetOuter, dryOuter, promenade, boulevard, hotelLine, outer, groundY, valid, reason };
}

/**
 * 选段 + 建带。候选窗口按海岸索引滑动（步长 = 每窗至少移动 3 个海岸点），得分 =
 * 有效采样比例 + 朝向偏好 − 排除朝向惩罚 + 小幅种子抖动；最高分即选段。
 * 无任何窗口达到 minValidRatio → degraded 段（保留最佳窗口与诊断），不返回 null
 * 以便下游统一消费；彻底无候选海岸时返回 degraded 空带。
 */
export function buildSeasideBand(coast: Vec2[], center: Vec2, world: SeasideWorld, config: CoastalConfig, seed: number): SeasideBand {
  const n = coast.length;
  const azimuthOf = (p: Vec2) => normalizeAngle(Math.atan2(p.z - center.z, p.x - center.x));
  // 限定岸段（开湾 = 东岛外岸）时，窗口不长于该岸最长的连续段：东岛外岸常只有十几个海岸点，
  // 固定 85° 窗口（~23 点）放不下，整条海滨带退化成 no-coast（seed 1703318715/2 档实测）。
  let eligibleRun = n;
  if (world.eligibleShore) {
    const ok = coast.map((p) => world.eligibleShore!(p));
    let run = 0; eligibleRun = 0;
    for (let i = 0; i < 2 * n && eligibleRun < n; i += 1) { run = ok[i % n] ? run + 1 : 0; eligibleRun = Math.max(eligibleRun, Math.min(run, n)); }
  }
  const samplesPerWindow = Math.max(4, Math.min(eligibleRun, Math.round((config.segmentArc / (Math.PI * 2)) * n)));
  // 限定岸段时逐点滑窗：窗口与连续段等长，步长 3 会错过唯一能放下的起点。
  const step = world.eligibleShore ? 1 : Math.max(3, Math.round(samplesPerWindow / 6));
  let best: { from: number; score: number; samples: SeasideSample[] } | null = null;
  for (let start = 0; start < n; start += step) {
    const samples: SeasideSample[] = [];
    for (let k = 0; k < samplesPerWindow; k += 1) {
      const index = (start + Math.round((k * (samplesPerWindow - 1)) / Math.max(1, samplesPerWindow - 1))) % n;
      const point = coast[index];
      const inward = coastInwardNormal(coast, center, index);
      samples.push(buildSample(point, inward, azimuthOf(point), world, config));
    }
    if (world.eligibleShore && samples.some((sample) => !world.eligibleShore!(sample.waterline))) continue;
    const midAzimuth = azimuthOf(coast[(start + Math.round(samplesPerWindow / 2)) % n]);
    const outward = normalizeAngle(midAzimuth);
    const orientationBonus = Math.max(0, 1 - angleDelta(outward, config.preferredAzimuth) / Math.max(0.001, config.azimuthTolerance));
    // 任一采样点落进封锁方位就算压线（曾只看中点方位：海岸有海湾时一段可跨 100° 以上，
    // 港口夹在段内而中点仍离它 30° 开外——扩到 4000 栋的 2 档大岛 seed 1013904323 实测海滨段压港口）。
    // 压线惩罚取命中项的最大权重（港口 3 > 河口默认 2）：原版大小的 1 档小岛上，港口 ±30° 加两侧河口
    // 可能让每个窗口都压线，等权时会选中压港口的段（seed 4055617001 实测），此时宁可压河口。
    const blocked = world.blockedAzimuths.reduce((worst, b) => (angleDelta(outward, b.at) < b.halfWidth
      || samples.some((sample) => angleDelta(sample.azimuth, b.at) < b.halfWidth) ? Math.max(worst, b.weight ?? 2) : worst), 0);
    const validRatio = samples.filter((s) => s.valid).length / samples.length;
    const score = validRatio + orientationBonus * 0.5 - blocked + hashSeed(`seaside-score:${seed}:${start}`) * 0.05;
    if (!best || score > best.score) best = { from: start, score, samples };
  }
  const id = `seaside:${seed}`;
  if (!best) return { id, azimuthFrom: 0, azimuthTo: 0, samples: [], validRatio: 0, degraded: true, reason: "no-coast" };
  // 相邻合法采样之间的大道弦线若跨海（海湾），在此断开：采样数跟海岸点数走、不随岛半径增长，
  // 扩到 4000 栋的 2 档大岛上相邻采样相距 60–120，直弦会切过海湾（seed 1788458157 实测滨海大道穿海）。
  {
    let previous: SeasideSample | null = null;
    for (const sample of best.samples) {
      if (!sample.valid) { previous = null; continue; }
      if (previous) {
        const a = previous.boulevard; const b = sample.boulevard;
        let wet = false;
        for (let t = 0.1; t < 1 && !wet; t += 0.1) {
          const x = a.x + (b.x - a.x) * t; const z = a.z + (b.z - a.z) * t;
          if (world.landSignedDistance(x, z) <= 0 || world.height(x, z) <= 0.5) wet = true;
        }
        if (wet) { sample.valid = false; previous = null; continue; }
        // 凹岸处内偏 36 的大道折线会反折（偏移曲线自交）：大道这一步与水线这一步方向相反/几乎为零就断开。
        // 曾由恰好无效的采样切断；用地挪位后该采样变合法，大道沿自身折回、两条重叠（seed 1703326634 1 档实测）。
        const wx = sample.waterline.x - previous.waterline.x; const wz = sample.waterline.z - previous.waterline.z;
        const bx = b.x - a.x; const bz = b.z - a.z;
        if (bx * wx + bz * wz < 0.25 * Math.hypot(wx, wz) * Math.hypot(bx, bz) || Math.hypot(bx, bz) < 4) { sample.valid = false; previous = null; continue; }
      }
      previous = sample;
    }
    // 断开后孤立的单个合法采样连不成路段（offsetSegments 丢弃单点段），却会被当成
    // 「大道起点」——1 档小岛 seed 387277014 实测：首个合法采样不在任何车行路上。
    const s = best.samples;
    s.forEach((sample, i) => {
      if (sample.valid && !s[i - 1]?.valid && !s[i + 1]?.valid) sample.valid = false;
    });
  }
  const validRatio = best.samples.filter((s) => s.valid).length / best.samples.length;
  const azimuthFrom = azimuthOf(coast[best.from]);
  const azimuthTo = azimuthOf(coast[(best.from + samplesPerWindow - 1) % n]);
  return {
    id,
    azimuthFrom,
    azimuthTo,
    samples: best.samples,
    validRatio,
    degraded: validRatio < config.minValidRatio,
    reason: validRatio < config.minValidRatio ? `valid-ratio-${validRatio.toFixed(2)}` : undefined,
  };
}

/** 点是否落在海滨保留带内（水线→带外缘的条带，含内侧小缓冲）：街区/地块避让用。 */
export function seasideStripContains(band: SeasideBand, p: Vec2, buffer = 0): boolean {
  if (band.degraded) return false;
  for (let lateralIndex = 0; lateralIndex < band.samples.length; lateralIndex += 1) {
    const sample = band.samples[lateralIndex];
    if (!sample.valid) continue;
    const dx = p.x - sample.waterline.x;
    const dz = p.z - sample.waterline.z;
    const along = dx * sample.inward.x + dz * sample.inward.z;
    const lateral = Math.abs(-dx * sample.inward.z + dz * sample.inward.x);
    if (along >= -buffer && along <= bandOuterOf(sample) + buffer && lateral <= lateralHalfOf(band, lateralIndex, sample)) return true;
  }
  return false;
}
const bandOuterOf = (sample: SeasideSample): number => Math.hypot(sample.outer.x - sample.waterline.x, sample.outer.z - sample.waterline.z);
/** 该采样单元的横向半径：与相邻水线采样距离的一半（采样近似等距）。 */
const lateralHalfOf = (band: SeasideBand, index: number, sample: SeasideSample): number => {
  const n = band.samples.length;
  let nearest = Infinity;
  for (const step of [-1, 1]) {
    const other = band.samples[(index + step + n) % n];
    if (other === sample) continue;
    nearest = Math.min(nearest, Math.hypot(other.waterline.x - sample.waterline.x, other.waterline.z - sample.waterline.z));
  }
  return (Number.isFinite(nearest) ? nearest : 28) / 2 + 1;
};

/**
 * 步道合法连续段（棕榈列/铺装消费）：按无效采样切分为多段——**不做跨缺口搭桥**。
 * 曾把两侧有效点直接连线补点，等于穿河/穿坡/穿设施铺装，把净空校验的结论倒
 * 回去了。段内按 ~15 单位细分（地形高度查询在消费端逐点做）。返回 ≥0 段折线。
 */
function offsetSegments(band: SeasideBand, pointOf: (sample: SeasideSample) => Vec2): Vec2[][] {
  if (band.degraded) return [];
  const segments: Vec2[][] = [];
  let current: Vec2[] = [];
  const pushSegment = () => { if (current.length >= 2) segments.push(current); current = []; };
  for (const sample of band.samples) {
    if (!sample.valid) { pushSegment(); continue; }
    const p = pointOf(sample);
    if (current.length) {
      const a = current[current.length - 1];
      const gap = Math.hypot(p.x - a.x, p.z - a.z);
      if (gap > 15) {
        // 当前点与前一点之间没有无效采样，合法海岸采样本身可相距 >30；
        // 在连续有效段内细分地形点，不把稀疏采样误判成净空缺口。
        const fill = Math.ceil(gap / 15) - 1;
        for (let k = 1; k <= fill; k += 1) current.push({ x: a.x + (p.x - a.x) * (k / (fill + 1)), z: a.z + (p.z - a.z) * (k / (fill + 1)) });
      }
    }
    current.push(p);
  }
  pushSegment();
  return segments;
}

/** 连续合法采样段（≥2 个）：沙滩多边形与沙滩设施沿它铺，无效采样处断开。 */
export function validRuns(band: SeasideBand): SeasideSample[][] {
  const runs: SeasideSample[][] = [];
  let current: SeasideSample[] = [];
  for (const sample of band.samples) {
    if (sample.valid) current.push(sample);
    else { if (current.length >= 2) runs.push(current); current = []; }
  }
  if (current.length >= 2) runs.push(current);
  return runs;
}

export const promenadeSegments = (band: SeasideBand): Vec2[][] => offsetSegments(band, (sample) => sample.promenade);
/** 离水线 d 处的平行折线（棕榈公园的树行用；无效采样处同样断开）。 */
export const bandSegmentsAt = (band: SeasideBand, d: number): Vec2[][] => offsetSegments(band, (sample) => offset(sample.waterline, sample.inward, d));
/** Valid vehicle-road centerlines; invalid river/terrain/reservation samples split the route. */
export const boulevardSegments = (band: SeasideBand): Vec2[][] => offsetSegments(band, (sample) => sample.boulevard);

/** B2 数据纹理的有符号距离编码/解码（RGBA8 的 R 通道）。 */
export const encodeDistance = (d: number, range: number): number => Math.max(0, Math.min(1, (d / range + 1) / 2));
export const decodeDistance = (v: number, range: number): number => (v * 2 - 1) * range;
/** 量化误差上界：8bit 通道 → range/127.5。用于「误差 < 过渡宽度」的预算断言。 */
export const distanceQuantizationError = (range: number): number => range / 127.5;

/**
 * Ocean Drive 分段线：海滨带合法采样按水线 z 排序，取 55% 分位。z 低于它的南段是 Ocean Beach / Washington Beach
 * （Art Deco 街墙，背景楼），以北留给会话酒店（Vice Point 的中高层）。南北口径与湾内岛一致（+z = 北）。
 */
export function oceanDriveSplitZ(band: SeasideBand | null): number {
  const zs = (band && !band.degraded ? band.samples.filter((s) => s.valid).map((s) => s.waterline.z) : []).sort((a, b) => a - b);
  return zs.length ? zs[Math.floor(zs.length * 0.55)] : -Infinity;
}

export type OceanDriveBuilding = Vec2 & { id: string; yaw: number; width: number; depth: number; floors: number; seed: number; sign: boolean };

/**
 * Ocean Drive Art Deco 街墙（用户：「东岛南段 Ocean Beach / Washington Beach：2–6 层连续的 Art Deco 酒店街墙」）。
 * 沿酒店线（hotelOffset）连续排楼：面宽 9–13、楼缝 0.8–2、进深 9–11、2–6 层（与普通会话地块 7.2 × 8 同一比例尺）；约一半正面带竖向霓虹招牌。
 * 是背景楼（街景），不占会话、不进统计——楼高由数据决定的原则不动，会话楼排在它们后面的街区里。
 * accept 由调用方判路网/用地净空（压路口处自然断开，读作横街）。
 */
export function oceanDriveWall(band: SeasideBand | null, config: CoastalConfig, seed: number,
  accept: (lot: { x: number; z: number; yaw: number; width: number; depth: number }) => boolean): OceanDriveBuilding[] {
  if (!band || band.degraded) return [];
  const split = oceanDriveSplitZ(band);
  const out: OceanDriveBuilding[] = [];
  const rand = (salt: string) => hashSeed(`ocean-drive:${seed}:${salt}`);
  bandSegmentsAt(band, config.hotelOffset).forEach((segment, si) => {
    let carry = 0;
    for (let i = 1; i < segment.length; i += 1) {
      const a = segment[i - 1]; const b = segment[i];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-3) continue;
      const tx = (b.x - a.x) / length; const tz = (b.z - a.z) / length;
      let s = carry;
      while (s < length) {
        const k = out.length;
        // 面宽 9–13、进深 9–11：普通会话地块 7.2 × 8，街墙略宽一点（1.25–1.8 倍）才读得出「一栋酒店」。
        // 曾是 12–21 × 14–18（约 5 倍占地），和会话楼不是同一个比例尺（用户反馈）。
        const width = 9 + rand(`w${si}:${i}:${k}`) * 4;
        const centre = s + width / 2;
        const x = a.x + tx * centre; const z = a.z + tz * centre;
        const depth = 9 + rand(`d${si}:${i}:${k}`) * 2;
        // 正面（局部 −z）朝海：折线走向不定，按最近海滨采样的内向法线校正（招牌挂在正面，朝滨海大道）
        let yaw = Math.atan2(-tz, tx);
        let nearest: SeasideSample | null = null; let nd = Infinity;
        for (const sample of band.samples) { const d = Math.hypot(sample.hotelLine.x - x, sample.hotelLine.z - z); if (sample.valid && d < nd) { nd = d; nearest = sample; } }
        if (nearest && (-Math.sin(yaw)) * nearest.inward.x + (-Math.cos(yaw)) * nearest.inward.z > 0) yaw += Math.PI;
        if (z < split && centre <= length + width * 0.3 && accept({ x, z, yaw, width, depth })) {
          out.push({ id: `ocean-drive:${si}:${i}:${k}`, x, z, yaw, width, depth, floors: 2 + Math.floor(rand(`f${si}:${i}:${k}`) * 5),
            seed: rand(`s${si}:${i}:${k}`), sign: rand(`g${si}:${i}:${k}`) < 0.5 });
        }
        s += width + 0.8 + rand(`gap${si}:${i}:${k}`) * 1.2;
      }
      carry = s - length;
    }
  });
  return out;
}
