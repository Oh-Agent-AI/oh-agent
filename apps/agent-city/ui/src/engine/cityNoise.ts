import { DetMath as Math } from "./detMath"; // 跨引擎确定性：见 detMath.ts
/**
 * Seeded 确定性噪声：地形生成的唯一随机源。同一 district.id 永远生成同一片地理，
 * 刷新/增量加载不改变地貌（与楼位确定性同一条纪律）。
 */

export function hashInt(x: number, y: number, seed: number): number {
  let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 平滑值噪声，0..1。 */
export function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hashInt(ix, iy, seed);
  const b = hashInt(ix + 1, iy, seed);
  const c = hashInt(ix, iy + 1, seed);
  const d = hashInt(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** fBm，约 -1..1。 */
export function fbm(x: number, y: number, seed: number, octaves = 3): number {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;
  for (let index = 0; index < octaves; index += 1) {
    sum += (valueNoise(x * frequency, y * frequency, seed + index * 1013) - 0.5) * 2 * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  return sum / norm;
}

/** 脊线噪声（山脊感）：1..0，值越大越接近山脊。 */
export function ridged(x: number, y: number, seed: number, octaves = 3): number {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;
  for (let index = 0; index < octaves; index += 1) {
    const noise = valueNoise(x * frequency, y * frequency, seed + index * 733);
    sum += (1 - Math.abs(noise * 2 - 1)) * amplitude;
    norm += amplitude;
    amplitude *= 0.55;
    frequency *= 2.1;
  }
  return sum / norm;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
