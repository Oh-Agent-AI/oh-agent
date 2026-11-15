/**
 * 多核心可达性占地形状场（CITY_WORLD_DIVERSIFICATION_SDK_SPEC §3）。
 *
 * 占地 = 可达性势场的等值线：城市经济学上圆是交通各向同性的退化特例，
 * 多核心 + 走廊拉伸 + 水域切角产生哑铃/多瓣/海岸形。宏观形状由网格化的
 * 符号距离场承载（double-pass chamfer + 形态学闭运算 + 面积归一化），
 * 边界细节由解析 fBm（H≈0.7 分形谱）在查询时叠加。
 *
 * 纯函数模块：全部随机性经 seed 键控哈希，DetMath 保证跨引擎确定性；
 * 不依赖 SDK、Three 或 DOM。
 */
import { DetMath as Math } from "../detMath";
import { hashSeed } from "../../cityModel";
import { fbm } from "../cityNoise";

export type FootprintFamilyV1 = "lobed" | "dumbbell" | "coastal";
export type FootprintStatsV1 = { areaM2: number; perimeterM: number; polsbyPopper: number };
export type FootprintShapeV1 = {
  /** 米制符号距离：>0 在占地内，<0 在外。已含边界分形细节。 */
  signedDistance: (x: number, z: number) => number;
  footprintStats: FootprintStatsV1;
  gridCells: number;
};

export type FootprintShapeRequestV1 = {
  seed: number;
  /** 目标圆盘半径：面积归一化基准，使「换形状不改城市体量」。 */
  radiusMeters: number;
  family: FootprintFamilyV1;
  cores: number;
  aspectRatio: number;
  corridorPull: number;
  coastFractal: number;
};

type Core = { x: number; z: number; weight: number; lambda: number; axisDeg: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 核心布局：seed 键控；dumbbell 两极对置，lobed 中心+卫星，coastal 单核带湾。 */
function layoutCores(seed: number, radius: number, family: FootprintFamilyV1, cores: number): Core[] {
  const random = (key: string) => hashSeed(`${seed}:${key}`);
  const axisDeg = random("footprint-axis") * 360;
  const axis = { x: Math.cos(axisDeg * Math.PI / 180), z: Math.sin(axisDeg * Math.PI / 180) };
  const list: Core[] = [];
  const addCore = (x: number, z: number, weight: number) => list.push({
    x, z, weight,
    lambda: radius * (0.52 + 0.12 * random(`lambda:${list.length}`)),
    axisDeg,
  });
  if (family === "dumbbell") {
    const offset = radius * (0.42 + 0.16 * random("dumbbell-spread"));
    addCore(axis.x * offset, axis.z * offset, 0.55);
    addCore(-axis.x * offset, -axis.z * offset, 0.45);
    return list;
  }
  if (family === "lobed") {
    addCore(0, 0, 0.55);
    const spread = radius * (0.5 + 0.12 * random("lobed-spread"));
    for (let k = 1; k < cores; k += 1) {
      const angle = (axisDeg + (360 / (cores - 1)) * (k - 1)) * Math.PI / 180;
      addCore(Math.cos(angle) * spread, Math.sin(angle) * spread, 0.45 / Math.max(1, cores - 1));
    }
    return list;
  }
  addCore(0, 0, 1);
  return list;
}

/** 双通道 chamfer 距离变换（格单位）：二值掩码内每格到边界最近距离。 */
function chamfer(mask: Uint8Array, width: number, height: number): Float64Array {
  const INF = 1e9;
  const field = new Float64Array(width * height);
  for (let i = 0; i < field.length; i += 1) field[i] = mask[i] ? 0 : INF;
  const D1 = 1, D2 = 1.4142135623730951;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      let best = field[i];
      if (x > 0) best = Math.min(best, field[i - 1] + D1);
      if (y > 0) best = Math.min(best, field[i - width] + D1);
      if (x > 0 && y > 0) best = Math.min(best, field[i - width - 1] + D2);
      if (x < width - 1 && y > 0) best = Math.min(best, field[i - width + 1] + D2);
      field[i] = best;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      let best = field[i];
      if (x < width - 1) best = Math.min(best, field[i + 1] + D1);
      if (y < height - 1) best = Math.min(best, field[i + width] + D1);
      if (x < width - 1 && y < height - 1) best = Math.min(best, field[i + width + 1] + D2);
      if (x > 0 && y < height - 1) best = Math.min(best, field[i + width - 1] + D2);
      field[i] = best;
    }
  }
  return field;
}

function potentialAt(cores: readonly Core[], x: number, z: number, family: FootprintFamilyV1,
  corridorPull: number, aspectRatio: number, bay: { angle: number; depth: number; width: number }): number {
  // z 向拉伸：以 z/ar 采样势场 → 足迹 z 向延展 ar 倍。
  const sz = z / aspectRatio;
  let potential = 0;
  for (const core of cores) {
    const dx = x - core.x, dz = sz - core.z;
    let distance = Math.hypot(dx, dz);
    if (corridorPull > 0) {
      // 走廊各向异性：沿核心连线方向（Hoyt 扇形）距离打折。
      const along = Math.abs((dx * Math.cos(core.axisDeg * Math.PI / 180)) + (dz * Math.sin(core.axisDeg * Math.PI / 180)));
      const cosAlong = distance > 1e-6 ? along / distance : 1;
      distance *= 1 - corridorPull * cosAlong * cosAlong;
    }
    potential = Math.max(potential, core.weight * Math.exp(-distance / core.lambda));
  }
  if (family === "coastal") {
    // 单核海湾：扇形窗内可达性削减，切出一段凹岸。
    const angle = Math.atan2(sz, x);
    const delta = Math.abs(((angle - bay.angle) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    if (delta < bay.width) potential *= 1 - bay.depth * Math.pow(Math.cos((delta / bay.width) * Math.PI / 2), 2);
  }
  return potential;
}

export function buildFootprintShape(request: FootprintShapeRequestV1): FootprintShapeV1 {
  const { seed, radiusMeters: R, family, cores, aspectRatio, corridorPull, coastFractal } = request;
  const random = (key: string) => hashSeed(`${seed}:${key}`);
  const bay = { angle: random("footprint-bay") * Math.PI * 2, depth: 0.6 + 0.25 * random("footprint-bay-depth"), width: 0.9 + 0.5 * random("footprint-bay-width") };
  const coreLayout = layoutCores(seed, R, family, cores);

  // 网格覆盖足迹可能达到的范围（z 向按 aspectRatio 放大），格距约 8 m。
  const cell = Math.max(4, (2.08 * R) / 256);
  const halfX = 1.04 * R;
  const halfZ = 1.04 * R * aspectRatio;
  const width = Math.max(96, Math.ceil((2 * halfX) / cell));
  const height = Math.max(96, Math.ceil((2 * halfZ) / cell));
  const potential = new Float64Array(width * height);
  let min = Infinity, max = -Infinity;
  for (let gy = 0; gy < height; gy += 1) {
    const z = -halfZ + (gy + 0.5) * cell;
    for (let gx = 0; gx < width; gx += 1) {
      const x = -halfX + (gx + 0.5) * cell;
      const value = potentialAt(coreLayout, x, z, family, corridorPull, aspectRatio, bay);
      potential[gy * width + gx] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  // 面积归一化：取分位阈值使占地 ≈ 目标圆盘面积（保持城市体量）。
  const sorted = Float64Array.from(potential).sort();
  const targetCells = clamp(Math.round((Math.PI * R * R) / (cell * cell)), 1, sorted.length - 1);
  const threshold = sorted[sorted.length - targetCells];

  const rawMask = new Uint8Array(width * height);
  for (let i = 0; i < rawMask.length; i += 1) rawMask[i] = potential[i] >= threshold ? 1 : 0;
  // 形态学闭运算：膨胀 ρ 再腐蚀 ρ，平滑阈值锯齿与孤立触须。
  const closingRadius = clamp(Math.round(24 / cell), 2, 8);
  const dilate = chamfer(rawMask, width, height);
  const grown = new Uint8Array(width * height);
  for (let i = 0; i < grown.length; i += 1) grown[i] = rawMask[i] || dilate[i] <= closingRadius ? 1 : 0;
  const grownInside = chamfer(invert(grown), width, height);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) mask[i] = grown[i] && grownInside[i] >= closingRadius ? 1 : 0;

  const inside = chamfer(invert(mask), width, height);   // 界内到边界距离
  const outside = chamfer(mask, width, height);          // 界外到边界距离
  const sdf = new Float64Array(width * height);
  let areaCells = 0, perimeterEdges = 0;
  for (let gy = 0; gy < height; gy += 1) {
    for (let gx = 0; gx < width; gx += 1) {
      const i = gy * width + gx;
      if (mask[i]) {
        sdf[i] = inside[i] * cell;
        areaCells += 1;
        // 周长按暴露边计（每条界边一次）：边界格计数会漏掉锯齿的多暴露边，PQ 会虚高超过 1。
        if (gx === 0 || !mask[i - 1]) perimeterEdges += 1;
        if (gx === width - 1 || !mask[i + 1]) perimeterEdges += 1;
        if (gy === 0 || !mask[i - width]) perimeterEdges += 1;
        if (gy === height - 1 || !mask[i + width]) perimeterEdges += 1;
      } else {
        sdf[i] = -Math.min(outside[i], (width + height)) * cell;
      }
    }
  }
  const areaM2 = areaCells * cell * cell;
  const perimeterM = perimeterEdges * cell;
  const polsbyPopper = perimeterM > 0 ? (4 * Math.PI * areaM2) / (perimeterM * perimeterM) : 1;
  const detailScale = coastFractal * R;

  const sample = (x: number, z: number): number => {
    // 越界钳制到边缘（边缘恒为界外远距）；双线性插值 + 解析分形细节。
    const fx = clamp((x + halfX) / cell - 0.5, 0, width - 1);
    const fz = clamp((z + halfZ) / cell - 0.5, 0, height - 1);
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const x1 = Math.min(x0 + 1, width - 1), z1 = Math.min(z0 + 1, height - 1);
    const tx = fx - x0, tz = fz - z0;
    const s00 = sdf[z0 * width + x0], s10 = sdf[z0 * width + x1];
    const s01 = sdf[z1 * width + x0], s11 = sdf[z1 * width + x1];
    const base = (s00 * (1 - tx) + s10 * tx) * (1 - tz) + (s01 * (1 - tx) + s11 * tx) * tz;
    const detail = detailScale * fbm((x * 6) / R, (z * 6) / R, seed + 311, 3);
    return (base + detail) * 0.94;
  };
  return {
    signedDistance: sample,
    footprintStats: { areaM2, perimeterM, polsbyPopper },
    gridCells: width * height,
  };
}

function invert(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) out[i] = mask[i] ? 0 : 1;
  return out;
}
