/**
 * 模型物理声明契约（CITY_MODEL_PHYSICAL_INVARIANTS_SPEC §3，批 A）。纯类型 + 自洽工厂 + 共享谓词。
 * 无 three 依赖（L1 可用）；守卫经 city-kit 打包加载，规划器后续批次直接 import。
 *
 * 「结构进类型、自洽进工厂、关系留守卫」：这里只声明模型自身的局部几何事实——占地、基础、入口、运动包络；
 * 与地形、水域、道路、邻接实体的关系是场景守卫的职责，声明不携带「已可达/已支撑」这类可变结果（spec §2）。
 * 实例侧：局部 +y 向上、+z 为默认正面；实例位置与 yaw 由消费方施加，检查一律在局部坐标系做（批 A 约定）。
 *
 * 并集语义（spec §3.1）：占地是区域的扁平并集，空洞是合法的（凯旋门两墩之间是路面）；
 * 判定不得用整体凸包替代并集——quadInFootprint 按边覆盖精确判定，凸包误判有专门反例测试钉住。
 * 非均匀缩放批 A 不支持：圆变椭圆无保守表示，出现即拒绝（spec §3.1），待后续批给保守多边形。
 */
export type Vec2 = { x: number; z: number };
export type Vec3 = [number, number, number];

export const PHYSICAL_SCHEMA_VERSION = 1;
/** 部件数/顶点数上限（spec §3.1「限制部件数」）：并集判定成本随部件数线性增长，超限拒绝声明。 */
export const MAX_FOOTPRINT_PARTS = 6;
export const MAX_CONVEX_VERTICES = 12;
export const MAX_ENTRANCES = 8;
export const MAX_APPROACH_PARTS = 4;

export type LocalRegion =
  | { shape: "circle"; center: Vec2; radius: number }
  | { shape: "rect"; center: Vec2; width: number; depth: number }
  | { shape: "convex"; vertices: readonly Vec2[] };

/** 扁平并集（限制部件数）；矩形不携带旋转，斜置子部件先转成局部凸多边形。 */
export type LocalFootprint = { parts: readonly LocalRegion[] };

/** 批 A 物理分类：所有非 beam 件按实体对待（保守方向：多查不少查），beam 显式排除并记录。 */
export type PhysicalExclusions = { readonly roles: readonly string[] };

export type FoundationSpec =
  | { kind: "ground"; support: LocalFootprint; maxRelief: number;
      maxGap: number; maxEmbed: number; baseOffset: number }
  | { kind: "piles"; supports: readonly Vec2[]; maxLegLength: number;
      allowedMedium: "land" | "water" | "both" }
  | { kind: "floating"; waterlineOffset: number; requiredDepth: number };

export type EntranceSpec = {
  id: string;
  local: Vec2;
  outward: Vec2; // 非零、规范化的局部方向（+z 为正面）
  width: number;
  mode: "pedestrian" | "vehicle" | "service";
  required: boolean;
  approach: LocalFootprint; // 允许进入的入口通道，不是整个建筑占地
};

/** 运动包络（spec §3.1「部件最大运动范围」）；spin = 绕轴扫掠圆柱。数组 = 联合（如 cap 依赖的多个扫掠变体）。 */
export type MotionEnvelope = {
  kind: "spin";
  axis: "x" | "y" | "z";
  center: Vec3;
  outerRadius: number;
  halfDepth: number; // 沿轴向的半宽（spin 不改变轴向坐标）
};

export type PhysicalDeclaration = {
  readonly modelId: string;
  readonly schemaVersion: number;
  readonly modelRevision: string; // 显式版本（批 A 手写，如 "A1"），不依赖加载顺序
  readonly footprint: LocalFootprint;
  /** 上层悬挑包络（spec §3.1「各高度段实体包络分别建模」）：抬升件的 XY 外廓，如拱门横跨路面的拱券实体。
   *  缺省 = 无悬挑（抬升件必须落在 footprint ∪ 运动包络投影 + 余量内）。 */
  readonly overhang?: LocalFootprint;
  readonly foundation: FoundationSpec;
  readonly entrances: readonly EntranceSpec[];
  readonly motion?: readonly MotionEnvelope[];
  readonly exclusions?: PhysicalExclusions;
  readonly notes?: string;
};

/** 工厂入参（可变镜像；工厂验证后深冻结返回只读声明）。 */
export type PhysicalDeclarationInput = {
  modelId: string;
  modelRevision: string;
  footprint: LocalFootprint;
  overhang?: LocalFootprint;
  foundation: FoundationSpec;
  entrances: EntranceSpec[];
  motion?: MotionEnvelope[];
  exclusions?: PhysicalExclusions;
  notes?: string;
};

const MODEL_ID = /^[a-z][a-z0-9-]*$/;
const EPS = 1e-9;
const CONVEX_EPS = 1e-7;

function fail(field: string, why: string): never {
  throw new Error(`physical: ${field}: ${why}`);
}
const finite = (v: number) => Number.isFinite(v);

function validateRegion(region: LocalRegion, field: string): void {
  if (region.shape === "circle") {
    if (!finite(region.center.x) || !finite(region.center.z)) fail(`${field}.center`, "must be finite");
    if (!finite(region.radius) || region.radius <= 0) fail(`${field}.radius`, "must be finite and positive");
    return;
  }
  if (region.shape === "rect") {
    if (!finite(region.center.x) || !finite(region.center.z)) fail(`${field}.center`, "must be finite");
    if (!finite(region.width) || region.width <= 0) fail(`${field}.width`, "must be finite and positive");
    if (!finite(region.depth) || region.depth <= 0) fail(`${field}.depth`, "must be finite and positive");
    return;
  }
  if (region.shape === "convex") {
    const v = region.vertices;
    if (v.length < 3 || v.length > MAX_CONVEX_VERTICES) fail(`${field}.vertices`, `needs 3..${MAX_CONVEX_VERTICES} vertices`);
    for (const p of v) if (!finite(p.x) || !finite(p.z)) fail(`${field}.vertices`, "must be finite");
    // 凸性 + 一致绕序：相邻边叉积全同号（共线允许），任意负正混合 = 自交/凹 → 拒绝。
    let pos = false; let neg = false;
    for (let i = 0; i < v.length; i += 1) {
      const a = v[i]; const b = v[(i + 1) % v.length]; const c = v[(i + 2) % v.length];
      const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
      if (cross > CONVEX_EPS) pos = true; else if (cross < -CONVEX_EPS) neg = true;
      if (pos && neg) fail(`${field}.vertices`, "not convex or winding inconsistent (self-intersecting)");
    }
    if (!pos && !neg) fail(`${field}.vertices`, "degenerate polygon (zero area)");
    return;
  }
  fail(field, `unknown shape ${String((region as { shape?: string }).shape)}`);
}

/** 统一绕序并克隆：工厂把多边形规范化为 CCW（正面积），且输出不与入参共享引用（深冻结不穿透调用方）。 */
function normalizedRegion(region: LocalRegion): LocalRegion {
  if (region.shape === "circle") return { shape: "circle", center: { x: region.center.x, z: region.center.z }, radius: region.radius };
  if (region.shape === "rect") return { shape: "rect", center: { x: region.center.x, z: region.center.z }, width: region.width, depth: region.depth };
  const v = region.vertices;
  let area = 0;
  for (let i = 0; i < v.length; i += 1) {
    const a = v[i]; const b = v[(i + 1) % v.length];
    area += a.x * b.z - b.x * a.z;
  }
  const vertices = v.map((p) => ({ x: p.x, z: p.z }));
  return { shape: "convex", vertices: area < 0 ? vertices.reverse() : vertices };
}

function validateFootprint(fp: LocalFootprint, field: string, maxParts: number): LocalFootprint {
  if (!Array.isArray(fp.parts) || fp.parts.length < 1 || fp.parts.length > maxParts) fail(`${field}.parts`, `needs 1..${maxParts} regions`);
  const parts = fp.parts.map((p, i) => {
    validateRegion(p, `${field}.parts[${i}]`);
    return normalizedRegion(p);
  });
  return { parts };
}

function validateFoundation(f: FoundationSpec): FoundationSpec {
  if (f.kind === "ground") {
    const support = validateFootprint(f.support, "foundation.support", MAX_FOOTPRINT_PARTS);
    for (const k of ["maxRelief", "maxGap", "maxEmbed"] as const) {
      const v = f[k];
      if (!finite(v) || v < 0) fail(`foundation.${k}`, "must be finite and non-negative");
    }
    if (!finite(f.baseOffset)) fail("foundation.baseOffset", "must be finite");
    return { ...f, support };
  }
  if (f.kind === "piles") {
    if (!Array.isArray(f.supports) || f.supports.length < 1) fail("foundation.supports", "needs at least one pile");
    for (const p of f.supports) if (!finite(p.x) || !finite(p.z)) fail("foundation.supports", "must be finite");
    if (!finite(f.maxLegLength) || f.maxLegLength <= 0) fail("foundation.maxLegLength", "must be finite and positive");
    if (!["land", "water", "both"].includes(f.allowedMedium)) fail("foundation.allowedMedium", "must be land|water|both");
    return { ...f, supports: f.supports.map((p) => ({ x: p.x, z: p.z })) };
  }
  if (f.kind === "floating") {
    if (!finite(f.waterlineOffset)) fail("foundation.waterlineOffset", "must be finite");
    if (!finite(f.requiredDepth) || f.requiredDepth <= 0) fail("foundation.requiredDepth", "must be finite and positive");
    return { ...f };
  }
  fail("foundation.kind", `unknown ${String((f as { kind?: string }).kind)}`);
}

function validateEntrance(e: EntranceSpec, index: number, seen: Set<string>): EntranceSpec {
  const where = `entrances[${index}]`;
  if (!e.id || typeof e.id !== "string") fail(`${where}.id`, "non-empty string required");
  if (seen.has(e.id)) fail(`${where}.id`, `duplicate entrance id ${e.id}`);
  seen.add(e.id);
  if (!finite(e.local.x) || !finite(e.local.z)) fail(`${where}.local`, "must be finite");
  const len = Math.hypot(e.outward.x, e.outward.z);
  if (!finite(len) || len <= EPS) fail(`${where}.outward`, "must be non-zero");
  if (Math.abs(len - 1) > 1e-6) fail(`${where}.outward`, `must be normalized (|v|=${len})`);
  if (!finite(e.width) || e.width <= 0) fail(`${where}.width`, "must be finite and positive");
  if (!["pedestrian", "vehicle", "service"].includes(e.mode)) fail(`${where}.mode`, "must be pedestrian|vehicle|service");
  const approach = validateFootprint(e.approach, `${where}.approach`, MAX_APPROACH_PARTS);
  return { ...e, approach };
}

function validateMotion(m: MotionEnvelope, index: number): MotionEnvelope {
  const where = `motion[${index}]`;
  if (m.kind !== "spin") fail(`${where}.kind`, `unknown ${String((m as { kind?: string }).kind)}`);
  if (!["x", "y", "z"].includes(m.axis)) fail(`${where}.axis`, "must be x|y|z");
  if (!m.center.every(finite)) fail(`${where}.center`, "must be finite");
  if (!finite(m.outerRadius) || m.outerRadius <= 0) fail(`${where}.outerRadius`, "must be finite and positive");
  if (!finite(m.halfDepth) || m.halfDepth <= 0) fail(`${where}.halfDepth`, "must be finite and positive");
  return { ...m, center: [...m.center] as Vec3 };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * 声明工厂（spec §4「工厂仅作轻量自洽验证」）：有效数值、形状、绕序规范化、入口引用、
 * 基础规则、参数域。返回深只读数据（Object.freeze 是浅冻结，这里覆盖嵌套对象与数组）。
 * 纯函数：同一输入两次构造深度相等，不依赖 Date / 随机 / 注册顺序。
 * 工厂不做的事：不查锚点在图中存在、不查不落水/不压路——那些是场景关系（spec §1）。
 */
export function declarePhysical(raw: PhysicalDeclarationInput): PhysicalDeclaration {
  if (!MODEL_ID.test(raw.modelId ?? "")) fail("modelId", `must match ${MODEL_ID.source}`);
  if (typeof raw.modelRevision !== "string" || !raw.modelRevision || raw.modelRevision.length > 16) fail("modelRevision", "non-empty string, at most 16 chars");
  const footprint = validateFootprint(raw.footprint, "footprint", MAX_FOOTPRINT_PARTS);
  const overhang = raw.overhang ? validateFootprint(raw.overhang, "overhang", MAX_FOOTPRINT_PARTS) : undefined;
  const foundation = validateFoundation(raw.foundation);
  if (!Array.isArray(raw.entrances) || raw.entrances.length > MAX_ENTRANCES) fail("entrances", `at most ${MAX_ENTRANCES}`);
  const seen = new Set<string>();
  const entrances = raw.entrances.map((e, i) => validateEntrance(e, i, seen));
  const motion = raw.motion?.map((m, i) => validateMotion(m, i));
  const exclusions = raw.exclusions
    ? { roles: [...raw.exclusions.roles].map((r) => { if (typeof r !== "string" || !r) fail("exclusions.roles", "non-empty strings"); return r; }) }
    : undefined;
  if (raw.notes !== undefined && (typeof raw.notes !== "string" || raw.notes.length > 200)) fail("notes", "optional string, at most 200 chars");
  return deepFreeze({
    modelId: raw.modelId, schemaVersion: PHYSICAL_SCHEMA_VERSION, modelRevision: raw.modelRevision,
    footprint, ...(overhang ? { overhang } : {}), foundation, entrances, ...(motion ? { motion } : {}), ...(exclusions ? { exclusions } : {}),
    ...(raw.notes !== undefined ? { notes: raw.notes } : {}),
  });
}

// ———— 共享谓词（spec §2：生成、修复和终筛调用同一份；守卫与规划器不得各写采样循环） ————

/** 区域带外扩余量的点包含（margin ≥ 0；凸多边形按叉积/边长外扩）。 */
export function pointInRegion(p: Vec2, region: LocalRegion, margin = 0): boolean {
  if (region.shape === "circle") return Math.hypot(p.x - region.center.x, p.z - region.center.z) <= region.radius + margin;
  if (region.shape === "rect") {
    return Math.abs(p.x - region.center.x) <= region.width / 2 + margin && Math.abs(p.z - region.center.z) <= region.depth / 2 + margin;
  }
  const v = region.vertices; // CCW：内部点在每条有向边左侧
  for (let i = 0; i < v.length; i += 1) {
    const a = v[i]; const b = v[(i + 1) % v.length];
    const edgeX = b.x - a.x; const edgeZ = b.z - a.z;
    const cross = edgeX * (p.z - a.z) - edgeZ * (p.x - a.x);
    if (cross < -margin * Math.hypot(edgeX, edgeZ)) return false;
  }
  return true;
}

/** 线段在单个（凸）区域内的参数区间 [t0,t1] ⊆ [0,1]；无交返回 null。区间算术精确（无采样）。 */
function clipSegment(a: Vec2, b: Vec2, region: LocalRegion, margin: number): [number, number] | null {
  const dx = b.x - a.x; const dz = b.z - a.z;
  let lo = 0; let hi = 1;
  const clipLinear = (f0: number, f1: number, limit: number, keepPositive: boolean): boolean => {
    // keepPositive：保留 f(t) ≤ limit；否则保留 f(t) ≥ −limit（f 在 t 上线性）
    const d = f1 - f0;
    if (Math.abs(d) < EPS) return keepPositive ? f0 <= limit : f0 >= -limit;
    const t = keepPositive ? (limit - f0) / d : (-limit - f0) / d;
    // 上界约束在 d>0 时收紧 hi；下界约束（≥）在 d<0 时经不等式翻转同样收紧 hi；其余收紧 lo
    if (keepPositive ? d > 0 : d < 0) hi = Math.min(hi, t); else lo = Math.max(lo, t);
    return lo <= hi;
  };
  if (region.shape === "circle") {
    // |a + t·d − c|² ≤ (r+m)² 的二次不等式
    const r = region.radius + margin;
    const ox = a.x - region.center.x; const oz = a.z - region.center.z;
    const A = dx * dx + dz * dz;
    if (A < EPS) return Math.hypot(ox, oz) <= r ? [0, 1] : null;
    const B = 2 * (ox * dx + oz * dz);
    const C = ox * ox + oz * oz - r * r;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    return [Math.max(0, (-B - s) / (2 * A)), Math.min(1, (-B + s) / (2 * A))] as [number, number];
  }
  if (region.shape === "rect") {
    const ok = clipLinear(a.x - region.center.x, b.x - region.center.x, region.width / 2 + margin, true)
      && clipLinear(region.center.x - a.x, region.center.x - b.x, region.width / 2 + margin, true)
      && clipLinear(a.z - region.center.z, b.z - region.center.z, region.depth / 2 + margin, true)
      && clipLinear(region.center.z - a.z, region.center.z - b.z, region.depth / 2 + margin, true);
    return ok && lo <= hi ? [lo, hi] : null;
  }
  const v = region.vertices; // CCW：内侧 = 每条有向边左侧（cross ≥ −margin·len）
  for (let i = 0; i < v.length; i += 1) {
    const p = v[i]; const q = v[(i + 1) % v.length];
    const ex = q.x - p.x; const ez = q.z - p.z;
    const len = Math.hypot(ex, ez);
    const f0 = ex * (a.z - p.z) - ez * (a.x - p.x); // t=0
    const f1 = ex * (b.z - p.z) - ez * (b.x - p.x); // t=1
    if (!clipLinear(f0, f1, margin * len, false)) return null;
  }
  return lo <= hi ? [lo, hi] : null;
}

/** 凸四边形（按序四顶点）是否完全落在并集内：四条边被区域并集覆盖 + 中心点在并集内。
 *  边覆盖精确（区间并覆盖 [0,1]），无采样空洞；并集自身的环形空洞由中心点检查兜底（批 A 声明无环形并集，守卫有反例钉住）。 */
export function quadInFootprint(quad: readonly Vec2[], fp: LocalFootprint, margin = 0): boolean {
  if (quad.length !== 4) throw new Error("physical: quad needs exactly 4 vertices");
  for (let e = 0; e < 4; e += 1) {
    const a = quad[e]; const b = quad[(e + 1) % 4];
    const spans: Array<[number, number]> = [];
    for (const region of fp.parts) {
      const span = clipSegment(a, b, region, margin);
      if (span) spans.push(span);
    }
    spans.sort((u, v) => u[0] - v[0]);
    let reach = 0;
    for (const [t0, t1] of spans) {
      if (t0 > reach + 1e-9) break;
      reach = Math.max(reach, t1);
      if (reach >= 1 - 1e-9) break;
    }
    if (reach < 1 - 1e-9) return false;
  }
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cz = (quad[0].z + quad[1].z + quad[2].z + quad[3].z) / 4;
  return fp.parts.some((region) => pointInRegion({ x: cx, z: cz }, region, margin));
}

/** 区域面积（并集总面积的保守上界 = 各区域面积和；仅用于过量声明的粗筛比例）。 */
export function regionArea(region: LocalRegion): number {
  if (region.shape === "circle") return Math.PI * region.radius * region.radius;
  if (region.shape === "rect") return region.width * region.depth;
  const v = region.vertices;
  let area = 0;
  for (let i = 0; i < v.length; i += 1) {
    const a = v[i]; const b = v[(i + 1) % v.length];
    area += a.x * b.z - b.x * a.z;
  }
  return Math.abs(area) / 2;
}

export function footprintAreaSum(fp: LocalFootprint): number {
  return fp.parts.reduce((sum, region) => sum + regionArea(region), 0);
}

/** 区域 AABB（守卫报告用）。 */
export function regionBounds(region: LocalRegion): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (region.shape === "circle") return { minX: region.center.x - region.radius, maxX: region.center.x + region.radius, minZ: region.center.z - region.radius, maxZ: region.center.z + region.radius };
  if (region.shape === "rect") return { minX: region.center.x - region.width / 2, maxX: region.center.x + region.width / 2, minZ: region.center.z - region.depth / 2, maxZ: region.center.z + region.depth / 2 };
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const p of region.vertices) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  return { minX, maxX, minZ, maxZ };
}
