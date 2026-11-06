/**
 * 玩家土方（docs/CITY_REPAIR_TERRAIN_GRADING_SPEC.md，T0）：补丁里的平整操作叠在生成地形之上，得到生效地形。
 *
 * 和生成器土方（roadLandingGrading）分层：生成器土方跟着生成器的路自动做；这里只做玩家显式写进补丁的操作，
 * 画路校验、驾驶面、渲染、落地高度读的都是叠完之后的同一个高度场。曾经的教训（ceaa2cce → bdd27d80）：
 * 提交后再偷偷动土，就是事后改了校验通过的几何——所以玩家的土方只能是显式、可预览、可撤销的操作。
 *
 * 硬约束在这里强制（校验之外的第二道保险，§4.3）：
 * - 不改水陆：下层高度 ≤ 0 的点原样返回；陆地点的结果不低于 min(下层, 0.05)。`wetSpan`、桥的拆分、海岸线、
 *   水面渲染都按 height ≤ 0 判水——水陆不变，画路重放与桥的几何就不会因平整翻转。
 * - 单点改动幅度 |Δh| ≤ MAX_DELTA（相对下层）。
 * - 下层高度 > MOUNTAIN_FULL 的山体不动（MOUNTAIN_FADE→MOUNTAIN_FULL 之间平滑淡出，不在山脚留台阶）。
 * - 近水 0–SHORE_FADE 的岸线同样淡入（同 roadLandingGrading 的 smooth(raw/0.2)），水线处连续。
 */
import { DetMath as Math } from "../detMath";
import type { TerrainField, Vec2 } from "../cityLayout";

export const TERRAIN_OPS_VERSION = 1;

/** 平台：圆心 at、半径 radius 内拉到 height，外圈 falloff 内平滑过渡回下层地形。 */
export type TerrainPadOp = { t: "pad"; at: Vec2; radius: number; falloff: number; height: number };
/** 坡道：沿 from→to、宽 width 的带子拉成从 from.h 到 to.h 的直线坡，两侧与两端 falloff 内过渡。 */
export type TerrainRampOp = { t: "ramp"; from: Vec2 & { h: number }; to: Vec2 & { h: number }; width: number; falloff: number };
export type TerrainOp = TerrainPadOp | TerrainRampOp;

export const TERRAIN_OP_LIMITS = Object.freeze({
  maxOps: 64,
  maxDelta: 3,
  maxPadRadius: 40,
  minFalloff: 4,
  maxFalloff: 30,
  maxRampLength: 120,
  minRampLength: 4,
  maxRampWidth: 24,
  minRampWidth: 2,
  /** 坡道本身的坡比上限：低于车的爬坡上限 0.31，修出来的坡车一定开得上去。 */
  maxRampGrade: 0.25,
});
const MOUNTAIN_FADE = 11;
const MOUNTAIN_FULL = 12;
const SHORE_FADE = 0.2;
const LAND_FLOOR = 0.05;
const CELL = 32;

export type TerrainOpProblem = "terrain-invalid" | "terrain-too-large" | "terrain-ramp-too-short" | "terrain-ramp-too-steep";

const finite = (...values: number[]) => values.every((value) => typeof value === "number" && Number.isFinite(value));

/** 单个操作的形状问题（与地形无关的静态约束）；null = 合法。 */
export function terrainOpProblem(op: TerrainOp): TerrainOpProblem | null {
  const L = TERRAIN_OP_LIMITS;
  if (op.t === "pad") {
    if (!finite(op.at.x, op.at.z, op.radius, op.falloff, op.height) || op.radius < 0) return "terrain-invalid";
    if (op.radius > L.maxPadRadius || op.falloff < L.minFalloff || op.falloff > L.maxFalloff) return "terrain-too-large";
    return null;
  }
  if (!finite(op.from.x, op.from.z, op.from.h, op.to.x, op.to.z, op.to.h, op.width, op.falloff)) return "terrain-invalid";
  const length = Math.hypot(op.to.x - op.from.x, op.to.z - op.from.z);
  if (length < L.minRampLength) return "terrain-ramp-too-short";
  if (length > L.maxRampLength || op.width < L.minRampWidth || op.width > L.maxRampWidth || op.falloff < L.minFalloff || op.falloff > L.maxFalloff) return "terrain-too-large";
  if (Math.abs(op.to.h - op.from.h) / length > L.maxRampGrade + 1e-9) return "terrain-ramp-too-steep";
  return null;
}

/** 操作影响范围的外接矩形（含过渡带）。 */
export function terrainOpBounds(op: TerrainOp): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (op.t === "pad") {
    const r = op.radius + op.falloff;
    return { minX: op.at.x - r, maxX: op.at.x + r, minZ: op.at.z - r, maxZ: op.at.z + r };
  }
  const r = op.width / 2 + op.falloff;
  return { minX: Math.min(op.from.x, op.to.x) - r, maxX: Math.max(op.from.x, op.to.x) + r, minZ: Math.min(op.from.z, op.to.z) - r, maxZ: Math.max(op.from.z, op.to.z) + r };
}

const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/** 这一笔在 (x, z) 的目标高度与权重（0 = 不影响，1 = 完全拉到目标）。 */
function opAt(op: TerrainOp, x: number, z: number): { target: number; weight: number } {
  if (op.t === "pad") {
    const d = Math.hypot(x - op.at.x, z - op.at.z);
    const weight = d <= op.radius ? 1 : 1 - smooth((d - op.radius) / op.falloff);
    return { target: op.height, weight };
  }
  const dx = op.to.x - op.from.x, dz = op.to.z - op.from.z; const l2 = dx * dx + dz * dz;
  const t = Math.max(0, Math.min(1, ((x - op.from.x) * dx + (z - op.from.z) * dz) / l2));
  const d = Math.hypot(x - (op.from.x + dx * t), z - (op.from.z + dz * t));
  const core = op.width / 2;
  const weight = d <= core ? 1 : 1 - smooth((d - core) / op.falloff);
  return { target: op.from.h + (op.to.h - op.from.h) * t, weight };
}

const layered = new WeakMap<TerrainField, Array<{ key: string; terrain: TerrainField }>>();
const below = new WeakMap<TerrainField, TerrainField>();

/** 叠出这些操作的那一层下面的地形（没叠过就是它自己）。 */
export function terrainBeneathOps(terrain: TerrainField): TerrainField {
  return below.get(terrain) ?? terrain;
}

/**
 * 把补丁里的平整操作按顺序叠到 `base` 上（后一笔看到前一笔的结果）。不合法的操作（`terrainOpProblem`）跳过——
 * 补丁重放把它们报进失效清单，这里只保证坏操作不会改地形。没有（合法）操作时返回 `base` 本身，
 * 空补丁的地形对象不变（地形网格、坡度缓存都按对象缓存）。
 */
export function applyTerrainOps(base: TerrainField, ops: readonly TerrainOp[]): TerrainField {
  const valid = ops.slice(0, TERRAIN_OP_LIMITS.maxOps).filter((op) => terrainOpProblem(op) === null);
  if (!valid.length) return base;
  const key = JSON.stringify(valid);
  const cached = layered.get(base)?.find((entry) => entry.key === key);
  if (cached) return cached.terrain;

  // 网格桶：一次取高只看所在格子里的操作，范围外直接返回下层（地形网格 15 万次、驾驶面几十万次取高）。
  const buckets = new Map<string, number[]>();
  valid.forEach((op, index) => {
    const b = terrainOpBounds(op);
    for (let ix = Math.floor(b.minX / CELL); ix <= Math.floor(b.maxX / CELL); ix += 1) {
      for (let iz = Math.floor(b.minZ / CELL); iz <= Math.floor(b.maxZ / CELL); iz += 1) {
        const k = `${ix}:${iz}`; const list = buckets.get(k);
        if (list) list.push(index); else buckets.set(k, [index]);
      }
    }
  });
  const height = (x: number, z: number): number => {
    const raw = base.height(x, z);
    if (!(raw > 0) || raw >= MOUNTAIN_FULL) return raw; // 水（含 NaN 原样）与山体不动
    const list = buckets.get(`${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`);
    if (!list) return raw;
    let h = raw;
    for (const index of list) {
      const { target, weight } = opAt(valid[index], x, z);
      if (weight > 0) h += (target - h) * weight;
    }
    const fade = smooth(raw / SHORE_FADE) * (1 - smooth((raw - MOUNTAIN_FADE) / (MOUNTAIN_FULL - MOUNTAIN_FADE)));
    const delta = Math.max(-TERRAIN_OP_LIMITS.maxDelta, Math.min(TERRAIN_OP_LIMITS.maxDelta, h - raw)) * fade;
    return Math.max(raw + delta, Math.min(raw, LAND_FLOOR));
  };
  const terrain: TerrainField = { ...base, height,
    slope: (x: number, z: number) => Math.hypot(height(x + 1, z) - height(x - 1, z), height(x, z + 1) - height(x, z - 1)) / 2 };
  below.set(terrain, base);
  const entries = layered.get(base) ?? [];
  entries.unshift({ key, terrain });
  if (entries.length > 8) entries.length = 8; // 悬停预览会连着产生几份，只留最近几份
  layered.set(base, entries);
  return terrain;
}

/** 点 (x, z) 是否在任一合法操作的影响范围内（派生重算只刷新范围内的落地高度）。 */
export function terrainOpsTouch(ops: readonly TerrainOp[], x: number, z: number): boolean {
  return ops.some((op) => { if (terrainOpProblem(op)) return false; const b = terrainOpBounds(op); return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ; });
}
