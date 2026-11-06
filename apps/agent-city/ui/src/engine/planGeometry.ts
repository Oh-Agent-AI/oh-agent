/**
 * 规划修复的底层几何/占用基础（纯函数）：被补丁层、道路规则、设施规则共用，不依赖补丁结构，
 * 所以不会与 planPatch 形成循环依赖。planPatch.ts 把这些原样再导出，外部引用路径不变。
 */
import type { CityBuilding } from "../cityModel";
import type { CityLayout, Parcel, RoadEdge, Vec2 } from "./cityLayout";
import { pointInPolygon, siteFootprint, worldOverhead } from "./planFootprint";

const distanceToSegment = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b.x - a.x; const dz = b.z - a.z; const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
};

export const quantize = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 });

/** 高架桥面宽与两端匝道长——与渲染层 render/shared.ts 的 EXPRESSWAY_DECK_WIDTH / EXPRESSWAY_RAMP 同值
 *  （那个模块带 three，规则层不引；verify-plan-bulldozer 断言两边相等）。 */
export { EXPRESSWAY_DECK_WIDTH as VIADUCT_DECK_WIDTH } from "./roadStandard";
import { EXPRESSWAY_DECK_WIDTH as VIADUCT_DECK_WIDTH } from "./roadStandard";
export const VIADUCT_RAMP = 90;

/** 锁定口径（放权后，SPEC §15）：只锁**桥面**——它的几何由桥梁模型（桥塔/桁架）绑定，单独擦或拖会留下悬空的桥。
 *  曾经连桥头引道、滨海路一起锁（M1 求稳），用户实测「很多东西都不能改」：滨海路占全城道路总长的大头，
 *  一锁就把最显眼的路全锁了。现在它们可编辑，改动的影响以提示呈现（擦掉引道桥会断开），不再拒绝。 */
export function edgeLocked(edge: RoadEdge): boolean {
  return edge.bridge === true || edge.structure === "deck";
}

const isDeck = (edge: RoadEdge) => edge.bridge === true || edge.structure === "deck";

/**
 * 整座桥（2026-10-21，用户：「玩家能不能用修复工具修掉坏桥头」）：从这段桥面沿「只连着桥面的路口」走出的整串桥面。
 * 桥面不能单独擦（会留下悬空的半座桥），但**整座**擦掉是合法的——生成器的坏桥头（斜接、陡岸）锁死后玩家
 * 只能绕开，删不掉也改不了；擦掉整座再用画路工具重画一座直桥，是修复工具里唯一能修桥头的路径。
 * 桥上没有路口（生成器与画路同口径），相邻桥面段只在两端都是桥面的节点相接，按节点走就是整座。
 */
export function bridgeChain(edges: readonly RoadEdge[], edge: RoadEdge): RoadEdge[] {
  if (!isDeck(edge)) return [edge];
  const incident = new Map<string, RoadEdge[]>();
  for (const candidate of edges) for (const id of [candidate.from, candidate.to]) (incident.get(id) ?? incident.set(id, []).get(id)!).push(candidate);
  const chain = new Set<RoadEdge>([edge]); const stack = [edge.from, edge.to]; const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const legs = incident.get(id) ?? [];
    if (!legs.every(isDeck)) continue; // 桥头：有地面路接着，桥到此为止
    for (const leg of legs) if (!chain.has(leg)) { chain.add(leg); stack.push(leg.from, leg.to); }
  }
  return edges.filter((candidate) => chain.has(candidate));
}

/** 整座桥按顺序连成一条折线（擦除预览画它）。链不是一条简单路径时（理论上没有）退回各段首尾相接。 */
export function bridgeChainPolyline(chain: readonly RoadEdge[]): Vec2[] {
  if (chain.length === 1) return [...chain[0].points];
  const degree = new Map<string, number>();
  for (const edge of chain) for (const id of [edge.from, edge.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
  let at = chain.find((edge) => degree.get(edge.from) === 1)?.from ?? chain.find((edge) => degree.get(edge.to) === 1)?.to;
  const left = new Set(chain); const out: Vec2[] = [];
  while (at !== undefined && left.size) {
    const next = [...left].find((edge) => edge.from === at || edge.to === at);
    if (!next) break;
    left.delete(next);
    const pts = next.from === at ? next.points : [...next.points].reverse();
    out.push(...(out.length ? pts.slice(1) : pts));
    at = next.from === at ? next.to : next.from;
  }
  return left.size ? chain.flatMap((edge) => edge.points) : out;
}

/** 悬索桥下的桥面：塔架与主缆是地标模型，桥面是它的一部分——整座擦掉时地标一起拆（不留悬在空中的塔与缆）。 */
export function deckUnderLandmark(layout: CityLayout, edge: RoadEdge): boolean {
  if (!isDeck(edge)) return false;
  const a = edge.points[0], b = edge.points[edge.points.length - 1];
  const midpoint = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  return (layout.landmarks ?? []).some((landmark) => landmark.kind === "suspension-bridge" && !!landmark.to
    && distanceToSegment(midpoint, landmark, landmark.to) < Math.max(2, edge.width / 2));
}

// ── 弧线路（游戏式曲线工具）──

/** 弧线的最小转弯半径：与拐角倒圆同一口径——路宽 3 倍，夹在 12–36（小路能拐急弯，主干道要缓弯）。 */
export const minCurveRadius = (width: number): number => Math.max(12, Math.min(36, width * 3));

/**
 * 弧线：起点 a、经过点 via、终点 b 的二次贝塞尔（控制点取 2·via − (a+b)/2，曲线在 t=0.5 正好过 via——
 * 用户点的是「路要经过的地方」，不是看不见的控制点）。按约 6 一段采样成折线，点已量化，首尾就是 a、b。
 * 校验与重放共用：两边铺出的折线逐点一致。
 */
export function curvePoints(a: Vec2, via: Vec2, b: Vec2): Vec2[] {
  const c = { x: 2 * via.x - (a.x + b.x) / 2, z: 2 * via.z - (a.z + b.z) / 2 };
  const rough = Math.hypot(c.x - a.x, c.z - a.z) + Math.hypot(b.x - c.x, b.z - c.z);
  // 段数取偶数：t=0.5 的采样点就是经过点本身——用户点下的位置路一定压过去（奇数段时中点落在两个采样之间，弦会抄近道）。
  const n = Math.max(4, Math.min(48, Math.ceil(rough / 6))) & ~1;
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n; const u = 1 - t;
    out.push(i === 0 ? { x: a.x, z: a.z } : i === n ? { x: b.x, z: b.z } : quantize({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, z: u * u * a.z + 2 * u * t * c.z + t * t * b.z }));
  }
  return out;
}

/** 折线最急处的转弯半径（相邻三点外接圆半径的最小值；直线返回 Infinity）。 */
export function polylineMinRadius(points: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 2; i < points.length; i += 1) {
    const [p, q, r] = [points[i - 2], points[i - 1], points[i]];
    const a = Math.hypot(q.x - p.x, q.z - p.z); const b = Math.hypot(r.x - q.x, r.z - q.z); const c = Math.hypot(r.x - p.x, r.z - p.z);
    const area2 = Math.abs((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
    if (area2 > 1e-9) best = Math.min(best, (a * b * c) / (2 * area2));
  }
  return best;
}

export const polylineLength = (points: readonly Vec2[]): number => points.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) : 0), 0);

// ── 地面桥（路线图 P1-5）──

/** 地面桥最长（与渲染层桁架装饰的上限、生成器跨河桥同量级）。 */
export const MAX_GROUND_BRIDGE = 160;
/** 桥台伸上岸的长度：桥面两端落在陆地上，不在水线上。 */
export const BRIDGE_ABUTMENT = 3;
/** 岸坡太陡时桥台最多伸到离水线这么远（P0-C）。 */
export const BRIDGE_ABUTMENT_MAX = 20;
/** 沿线采样水面的步长。 */
const WET_STEP = 1;

export type WetSpan =
  | { kind: "dry" }
  | { kind: "bridge"; from: Vec2; to: Vec2; length: number }
  | { kind: "invalid"; reason: "end-in-water" | "multi-water" | "bridge-too-long" };

/** 水面：地形高 ≤ 0.5（生成器连接器判桥跨的同一水位，connect.ts 的 `height <= 0.5`）。 */
export const WATER_LEVEL = 0.5;
export const isWater = (layout: CityLayout, x: number, z: number): boolean => layout.terrain.height(x, z) <= WATER_LEVEL;

/**
 * 一段直路 a→b 跨不跨水：全程不碰水 → dry；中间恰好一段水、两端在陆地上、水面段（含两端桥台）≤ MAX_GROUND_BRIDGE
 * → bridge（桥面起止点，已量化）；其余（端点在水里、过两次水、太长）→ invalid。
 * 画路校验与补丁重放共用这一个判定——两边对「哪段是桥」必须一致。
 * 水按地形高判，**不按 buildable**（2026-10-21）：buildable 离岸 12 内恒假，生成器的桥头和岸边路都铺在这段前滩上——
 * 按 buildable 判，桥面会把整段前滩连同岸边路一起吞进「水面」（junction-on-bridge），落笔点也成了「在水里」，
 * 7/2 擦掉坏桥后在原址附近一笔也画不出来。地面路仍要求可建（badSamples），只有桥跨按水位。
 */
export function wetSpan(layout: CityLayout, a: Vec2, b: Vec2): WetSpan {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(len / WET_STEP));
  const wet: boolean[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    wet.push(isWater(layout, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t));
  }
  const first = wet.indexOf(true);
  if (first < 0) return { kind: "dry" };
  if (wet[0] || wet[steps]) return { kind: "invalid", reason: "end-in-water" };
  const last = wet.lastIndexOf(true);
  for (let i = first; i <= last; i += 1) if (!wet[i]) return { kind: "invalid", reason: "multi-water" };
  const at = (d: number) => quantize({ x: a.x + (b.x - a.x) * (d / len), z: a.z + (b.z - a.z) * (d / len) });
  let start = Math.max(0, (first / steps) * len - BRIDGE_ABUTMENT);
  let end = Math.min(len, (last / steps) * len + BRIDGE_ABUTMENT);
  // 桥台延伸到缓坡（修复升级 P0-C）：岸坡比车的爬坡能力陡时，桥面沿笔画往岸上多伸，直到桥端外 8 内的坡缓下来，
  // 离水线最多 BRIDGE_ABUTMENT_MAX——桥面是一块斜板，陡岸压在板下，车从缓坡上桥（生成器陡桥头 5 个的原地修法）。
  const steepBeyond = (d: number, toward: Vec2) => polylineMaxGrade(layout, [at(d), toward], 0, BRIDGE_APPROACH_GRADE_REACH).grade > BRIDGE_APPROACH_MAX_GRADE;
  const waterStart = (first / steps) * len, waterEnd = (last / steps) * len;
  while (start - 1 >= 0 && waterStart - (start - 1) <= BRIDGE_ABUTMENT_MAX && steepBeyond(start, a)) start -= 1;
  while (end + 1 <= len && (end + 1) - waterEnd <= BRIDGE_ABUTMENT_MAX && steepBeyond(end, b)) end += 1;
  const from = at(start); const to = at(end);
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  if (length > MAX_GROUND_BRIDGE) return { kind: "invalid", reason: "bridge-too-long" };
  return { kind: "bridge", from, to, length };
}

/** 桥头引道（2026-10-21，与生成器 7/2 桥头缺陷同源）：桥面是刚体，下桥后要先有一段同线的地面路再接路口或转弯——
 *  桥端直接压在路口上（斜接的路与桥面在一两米内对不上），窄桥下桥车身越出桥面侧边；岸坡比车的爬坡能力陡，车开不上桥。
 *  生成器 45 个规划的 431 个桥端里 43 个斜接、5 个过陡；画路工具不能再画出同样的桥头。
 *  最短长度 = 路口渠化喇叭口沿臂的伸出量 2.2 + 9 + 0.55·路宽（structureCompiler.channelizedGeometry，中间还有一座 4.4 起的
 *  导流岛）：曾取 6，7/2 重画的桥离自动路口正好 6，喇叭口与导流岛压在桥头上。小路 14、次干道 16、主干道 18。 */
export const bridgeApproachMin = (width: number): number => Math.ceil(2.2 + 9 + 0.55 * width);
/** 引道坡比检查范围（自桥端起）与上限：车的爬坡上限 tan(0.3 rad)。 */
export const BRIDGE_APPROACH_GRADE_REACH = 8;
export const BRIDGE_APPROACH_MAX_GRADE = 0.31;

/** 一笔直路 a→b 上的桥（wetSpan 的 bridge）两端引道是否合格：太短 → bridge-approach-short，太陡 → bridge-approach-steep。
 *  引道量到**最近的路口**：落笔点，或这一笔与现有路的交点（重放时自动开路口）——7/2 擦桥后重画，新笔画在桥端 6 处
 *  横穿旧桥的残路，自动路口连渠化岛正压在桥头，量到落笔点的 9.7 看着合格。 */
export function bridgeApproachProblem(layout: CityLayout, a: Vec2, b: Vec2, span: { from: Vec2; to: Vec2 }, width: number, junctions: readonly Vec2[] = []): "bridge-approach-short" | "bridge-approach-steep" | null {
  const len = Math.hypot(b.x - a.x, b.z - a.z), ux0 = (b.x - a.x) / len, uz0 = (b.z - a.z) / len;
  const at = (p: Vec2) => (p.x - a.x) * ux0 + (p.z - a.z) * uz0;
  const sFrom = at(span.from), sTo = at(span.to);
  // 每侧最近的路口（沿笔画的弧长）：源侧取 < 桥头的最大者，对岸取 > 桥尾的最小者。
  const nearA = Math.max(0, ...junctions.map(at).filter((s) => s < sFrom)), nearB = Math.min(len, ...junctions.map(at).filter((s) => s > sTo));
  const point = (s: number) => ({ x: a.x + ux0 * s, z: a.z + uz0 * s });
  const ends: Array<[Vec2, Vec2]> = [[span.from, point(nearA)], [span.to, point(nearB)]];
  if (ends.some(([deck, end]) => Math.hypot(end.x - deck.x, end.z - deck.z) < bridgeApproachMin(width) - 1e-6)) return "bridge-approach-short";
  // 桥面本身是一块斜板（两端各接路面高）：桥台伸上高岸后，板的坡比也不能超过车的爬坡上限。
  const deckLength = Math.hypot(span.to.x - span.from.x, span.to.z - span.from.z);
  if (deckLength > 0 && Math.abs(layout.terrain.height(span.to.x, span.to.z) - layout.terrain.height(span.from.x, span.from.z)) / deckLength > BRIDGE_APPROACH_MAX_GRADE) return "bridge-approach-steep";
  for (const [deck, end] of ends) {
    const run = Math.hypot(end.x - deck.x, end.z - deck.z), ux = (end.x - deck.x) / run, uz = (end.z - deck.z) / run;
    const h = (s: number) => layout.terrain.height(deck.x + ux * s, deck.z + uz * s);
    for (let s = 0; s + 0.5 <= Math.min(BRIDGE_APPROACH_GRADE_REACH, run) + 1e-9; s += 0.5)
      if (Math.abs(h(s + 0.5) - h(s)) / 0.5 > BRIDGE_APPROACH_MAX_GRADE) return "bridge-approach-steep";
  }
  return null;
}

// ── 道路能不能开（修复升级 P0-A/B，docs/CITY_REPAIR_UPGRADE_PLAN.md）──

/** 车的爬坡上限 tan(0.3 rad)：坡比超过它的路车开不上去（与桥头引道同一个数）。 */
export const ROAD_MAX_GRADE = BRIDGE_APPROACH_MAX_GRADE;
/** 坡比超过它只提示「路很陡」：车开得上去，但已接近上限。 */
export const ROAD_STEEP_GRADE = 0.2;
const GRADE_STEP = 0.5;

/** 折线沿线最大坡比（0.5 一步）。`from`/`to` 是沿线弧长区间，缺省整条。 */
export function polylineMaxGrade(layout: CityLayout, points: readonly Vec2[], from = 0, to = Infinity): { grade: number; at: Vec2 | null } {
  let worst = 0; let at: Vec2 | null = null; let base = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1], b = points[i]; const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len > 0) {
      const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
      for (let s = Math.max(0, from - base); s + GRADE_STEP <= Math.min(len, to - base) + 1e-9; s += GRADE_STEP) {
        const p = { x: a.x + ux * s, z: a.z + uz * s };
        const grade = Math.abs(layout.terrain.height(p.x + ux * GRADE_STEP, p.z + uz * GRADE_STEP) - layout.terrain.height(p.x, p.z)) / GRADE_STEP;
        if (grade > worst) { worst = grade; at = p; }
      }
    }
    base += len;
  }
  return { grade: worst, at };
}

export type BridgeheadDefect = { kind: "oblique" | "steep"; at: Vec2; deckIds: string[]; width: number; grade: number; skewDeg: number };

/**
 * 生成城市里的坏桥头（体检 bridgeheadOblique / bridgeheadSteep）。口径同桥头统计（45 规划 431 个地面桥端：43 斜接、5 过陡）：
 * - 斜接：桥端的地面去路里没有一条与桥轴夹角 ≤ 45°（车下桥就得急转，窄桥车身越出桥面——7/2 悬索桥）；
 * - 过陡：任一去路自桥端起 8 内坡比 > 车的爬坡上限。
 * 桥端没有地面路（通往水中设施的桥尾）不算桥头缺陷。
 */
export function bridgeheadDefects(layout: CityLayout): BridgeheadDefect[] {
  const decks = layout.roadEdges.filter(isDeck);
  const ground = new Map<string, RoadEdge[]>();
  for (const edge of layout.roadEdges) if (!isDeck(edge)) for (const id of [edge.from, edge.to]) (ground.get(id) ?? ground.set(id, []).get(id)!).push(edge);
  const out: BridgeheadDefect[] = []; const seen = new Set<RoadEdge>();
  for (const deck of decks) {
    if (seen.has(deck)) continue;
    const chain = bridgeChain(layout.roadEdges, deck); for (const piece of chain) seen.add(piece);
    const degree = new Map<string, number>();
    for (const piece of chain) for (const id of [piece.from, piece.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
    for (const piece of chain) for (const [id, point, inner] of [[piece.from, piece.points[0], piece.points[1]], [piece.to, piece.points[piece.points.length - 1], piece.points[piece.points.length - 2]]] as Array<[string, Vec2, Vec2]>) {
      if (degree.get(id) !== 1) continue; // 桥中间的节点
      const legs = ground.get(id) ?? [];
      if (!legs.length) continue;
      const len = Math.hypot(point.x - inner.x, point.z - inner.z) || 1; const ux = (point.x - inner.x) / len, uz = (point.z - inner.z) / len;
      let minSkew = 180; let grade = 0;
      for (const leg of legs) {
        const pts = leg.from === id ? leg.points : [...leg.points].reverse();
        const d = Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z) || 1;
        minSkew = Math.min(minSkew, Math.acos(Math.max(-1, Math.min(1, ((pts[1].x - pts[0].x) * ux + (pts[1].z - pts[0].z) * uz) / d))) * 180 / Math.PI);
        grade = Math.max(grade, polylineMaxGrade(layout, pts, 0, BRIDGE_APPROACH_GRADE_REACH).grade);
      }
      const deckIds = chain.map((piece) => piece.id);
      if (minSkew > 45) out.push({ kind: "oblique", at: point, deckIds, width: piece.width, grade, skewDeg: minSkew });
      if (grade > BRIDGE_APPROACH_MAX_GRADE) out.push({ kind: "steep", at: point, deckIds, width: piece.width, grade, skewDeg: minSkew });
    }
  }
  return out;
}

/** 楼的净空要避开的路：地面路（非桥）。体检与编辑校验共用这一个口径——
 *  曾经校验查全部路段、体检只查地面路，编辑器会拦下体检根本不报的落位（「三者同源」被破坏）。 */
export function clearanceRoads(layout: CityLayout): RoadEdge[] {
  return cached(layout, "clearanceRoads", layoutDeps(layout), () => layout.roadEdges.filter((edge) => !edge.bridge));
}

/**
 * 布局对象不可变（补丁每次产出新布局），按布局缓存派生结果（路线图 SPEC P0-1）。曾在每次 validateBuildingMove 里
 * 重建全城地块索引与占用集合——推土机安置一栋楼要校验上百块地，4000 楼时一笔路的试算 8.9 秒。
 * 测试会改合成布局的字段，所以缓存命中还要核对来源数组仍是同一个引用、以及各集合的元素数（就地 push 也能察觉）。
 */
const derivedCache = new WeakMap<CityLayout, { deps: readonly unknown[]; values: Map<string, unknown> }>();
function cached<T>(layout: CityLayout, key: string, deps: readonly unknown[], build: () => T): T {
  let entry = derivedCache.get(layout);
  if (!entry || entry.deps.length !== deps.length || entry.deps.some((dep, i) => dep !== deps[i])) { entry = { deps, values: new Map() }; derivedCache.set(layout, entry); }
  if (!entry.values.has(key)) entry.values.set(key, build());
  return entry.values.get(key) as T;
}
// 计数也进依赖：测试会往已用过的合成布局里就地 push 地块（verify-plan-patch (g) 占地重叠），只核对数组引用会读到旧索引。
const layoutDeps = (layout: CityLayout): unknown[] => [layout.blocks, layout.districts, layout.civics, layout.gardens, layout.districtLandmarks, layout.landmarks, layout.publicSites, layout.contextBuildings, layout.roadEdges,
  layout.blocks.reduce((n, block) => n + block.parcels.length, 0), layout.districts.reduce((n, district) => n + district.slots.size, 0), layout.contextBuildings.length, layout.roadEdges.length];

/** 全城地块索引：街区地块 + 已落楼地块（酒店地块不进 layout.blocks，只存在于 slots 里）。按布局缓存，调用方不得修改返回值。 */
export function parcelIndex(layout: CityLayout): Map<string, Parcel> {
  return cached(layout, "parcelIndex", layoutDeps(layout), () => buildParcelIndex(layout));
}
function buildParcelIndex(layout: CityLayout): Map<string, Parcel> {
  const index = new Map<string, Parcel>();
  for (const block of layout.blocks) for (const parcel of block.parcels) index.set(parcel.id, parcel);
  for (const district of layout.districts) for (const parcel of district.slots.values()) if (!index.has(parcel.id)) index.set(parcel.id, parcel);
  return index;
}

/** 被占用/预留的地块：会话楼、配套整街区、小区花园街区、城区地标整街区、致敬地标与市政用地圆内、未压制的背景楼。
 *  编辑校验与套用共用——套用曾只看会话楼，刷新后目标地块冒出背景楼时照套不误，两楼叠在一起。 */
export function reservedParcelIds(layout: CityLayout, suppressedContext: Iterable<string> = []): Set<string> {
  // 返回副本：调用方（applyPlanPatch 的移楼循环）会就地增删占用。只读的调用方用 reservedParcelIdsShared。
  return new Set(reservedParcelIdsShared(layout, suppressedContext));
}

/** 同 reservedParcelIds，返回按布局缓存的同一个集合——只读，不得修改。 */
export function reservedParcelIdsShared(layout: CityLayout, suppressedContext: Iterable<string> = []): ReadonlySet<string> {
  const suppressedList = [...suppressedContext];
  return cached(layout, `reserved|${[...suppressedList].sort().join(",")}`, layoutDeps(layout), () => buildReserved(layout, suppressedList));
}

/** 全城会话楼落位（id → 地块）的扁平表与「街区 → 第一个在其中落楼的城区」（validateBuildingMove 每次都要扫）。 */
export function slotIndex(layout: CityLayout): { slots: ReadonlyArray<readonly [string, Parcel]>; districtOfBlock: ReadonlyMap<string, string>; homeOf: ReadonlyMap<string, string> } {
  return cached(layout, "slotIndex", layoutDeps(layout), () => {
    const slots: Array<readonly [string, Parcel]> = []; const districtOfBlock = new Map<string, string>(); const homeOf = new Map<string, string>();
    for (const district of layout.districts) for (const [id, slot] of district.slots) {
      slots.push([id, slot]);
      if (!homeOf.has(id)) homeOf.set(id, district.id);
      if (!districtOfBlock.has(slot.blockId)) districtOfBlock.set(slot.blockId, district.id);
    }
    return { slots, districtOfBlock, homeOf };
  });
}
function buildReserved(layout: CityLayout, suppressedContext: readonly string[]): Set<string> {
  const parcels = parcelIndex(layout);
  const blockOf = new Map<string, string[]>();
  for (const block of layout.blocks) for (const parcel of block.parcels) {
    const list = blockOf.get(parcel.blockId); if (list) list.push(parcel.id); else blockOf.set(parcel.blockId, [parcel.id]);
  }
  const reserved = new Set<string>();
  for (const district of layout.districts) for (const parcel of district.slots.values()) reserved.add(parcel.id);
  for (const civic of layout.civics) for (const parcelId of blockOf.get(civic.parcelId) ?? [civic.parcelId]) reserved.add(parcelId);
  for (const garden of layout.gardens) for (const parcelId of blockOf.get(garden.blockId) ?? []) reserved.add(parcelId);
  // 城区地标的 17 m 裙房比一个地址大：生成器把它所在的**整个街区**都预留了（cityLayout 注释：保住相邻地址）。
  // 编辑器曾只预留它那一个地块（注册表 SPEC D1）——会话楼可能被搬进地标旁边、压到裙房。与生成器对齐。
  for (const landmark of layout.districtLandmarks ?? []) {
    const parcel = parcels.get(landmark.parcelId);
    for (const parcelId of (parcel && blockOf.get(parcel.blockId)) || [landmark.parcelId]) reserved.add(parcelId);
  }
  // 致敬地标与市政用地按圆形占地：生成器先于街区为它们留地，所以底图里圆内本无地块；
  // 但它们现在可以被搬家（§15），搬到有地块的地方后，圆内的地块必须算占用，否则会话楼会被搬进去。
  // 按模型真实占地（planFootprint）判：地块中心落在占地外扩 4 以内即占用；只认得出预留圆的模型照旧按圆 + 4。
  const roundSites = [...(layout.landmarks ?? []).map((site) => ({ site, id: site.id })), ...(layout.publicSites ?? []).map((site) => ({ site, id: `public:${site.id}` }))].filter(({ site }) => site.radius);
  const shapes = roundSites.map(({ site, id }) => {
    const footprint = siteFootprint(site.kind, id, site.radius, "shore" in site && !!site.shore);
    return { site, footprint, parts: footprint.exact ? worldOverhead(footprint, site, site.yaw) : [] };
  });
  if (shapes.length) for (const parcel of parcels.values()) {
    if (shapes.some(({ site, footprint, parts }) => (footprint.exact
      ? parts.some((part) => pointInPolygon(parcel, part) || part.some((v, i) => distanceToSegment(parcel, v, part[(i + 1) % part.length]) < 4))
      : Math.hypot(parcel.x - site.x, parcel.z - site.z) < site.radius + 4))) reserved.add(parcel.id);
  }
  const suppressed = new Set(suppressedContext);
  for (const context of layout.contextBuildings) {
    const parcelId = context.id.replace(/^context:/, "");
    if (parcels.has(parcelId) && !suppressed.has(context.id)) reserved.add(parcelId);
  }
  return reserved;
}

/** 地面路网格索引的格子边长。 */
const GRID = 40;

/**
 * 地面路（clearanceRoads）的网格索引：每个线段按包围盒登记到格子里。按布局缓存。
 * edgesNear 返回「可能离 (x,z) 不超过 radius 的路段」，**按 clearanceRoads 的原顺序**、不重复——
 * 调用方的「取最小、并列取先出现」口径因此不变（路线图 SPEC P0-1：结果逐字不变的提速）。
 */
function edgeGrid(layout: CityLayout): { cells: Map<string, number[]>; edges: RoadEdge[]; maxHalf: number } {
  return cached(layout, "edgeGrid", layoutDeps(layout), () => {
    const edges = clearanceRoads(layout); const cells = new Map<string, number[]>(); let maxHalf = 0;
    edges.forEach((edge, index) => {
      maxHalf = Math.max(maxHalf, edge.width / 2);
      const seen = new Set<string>();
      for (let i = 1; i < edge.points.length; i += 1) {
        const a = edge.points[i - 1]; const b = edge.points[i];
        for (let gx = Math.floor(Math.min(a.x, b.x) / GRID); gx <= Math.floor(Math.max(a.x, b.x) / GRID); gx += 1)
          for (let gz = Math.floor(Math.min(a.z, b.z) / GRID); gz <= Math.floor(Math.max(a.z, b.z) / GRID); gz += 1) {
            const key = `${gx}:${gz}`;
            if (seen.has(key)) continue; seen.add(key);
            const list = cells.get(key); if (list) list.push(index); else cells.set(key, [index]);
          }
      }
    });
    return { cells, edges, maxHalf };
  });
}

/** 中心线离 (x,z) 可能 ≤ radius 的地面路段（原顺序、不重复）。任何一点在半径内的线段，其包围盒必与查询方框共用格子。 */
export function edgesNear(layout: CityLayout, x: number, z: number, radius: number): RoadEdge[] {
  const { cells, edges } = edgeGrid(layout);
  const hits = new Set<number>();
  for (let gx = Math.floor((x - radius) / GRID); gx <= Math.floor((x + radius) / GRID); gx += 1)
    for (let gz = Math.floor((z - radius) / GRID); gz <= Math.floor((z + radius) / GRID); gz += 1)
      for (const index of cells.get(`${gx}:${gz}`) ?? []) hits.add(index);
  return [...hits].sort((a, b) => a - b).map((index) => edges[index]);
}

/** 同 rectClearOfEdges(rect, clearanceRoads(layout), pad)，只查附近的路（结果相同）。 */
export function rectClearOfRoads(layout: CityLayout, rect: { x: number; z: number; yaw: number; width: number; depth: number }, pad = 0.5): boolean {
  const half = edgeGrid(layout).maxHalf + pad; // 与 rectClearOfEdges 粗筛同一个可达半径（取最宽的路），再留 1 的余量
  const reach = Math.hypot(rect.width / 2 + half, rect.depth / 2 + half) + 1;
  return rectClearOfEdges(rect, edgesNear(layout, rect.x, rect.z, reach), pad);
}

/** 朝向矩形与路段带是否相交（口径同 cityLayout 的 lotClearOfRoads：局部轴投影 + 路幅半宽外扩）。 */
export function rectClearOfEdges(rect: { x: number; z: number; yaw: number; width: number; depth: number }, edges: readonly RoadEdge[], pad = 0.5): boolean {
  const ax = Math.sin(rect.yaw); const az = Math.cos(rect.yaw); // 局部 z 轴（进深）
  const bx = az; const bz = -ax;                                // 局部 x 轴（面宽）
  for (const edge of edges) {
    const half = edge.width / 2 + pad;
    // 粗筛（结果逐字不变）：采样点要命中，离矩形中心不能超过 hypot(半面宽+half, 半进深+half)；
    // 线段外扩这个半径的包围盒不含中心，整段都不可能命中。曾逐段按 1.5 步长采样全城路——体检 3.6 秒的 90%。
    const reach = Math.hypot(rect.width / 2 + half, rect.depth / 2 + half);
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1]; const b = edge.points[i];
      if (rect.x < Math.min(a.x, b.x) - reach || rect.x > Math.max(a.x, b.x) + reach || rect.z < Math.min(a.z, b.z) - reach || rect.z > Math.max(a.z, b.z) + reach) continue;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      for (let d = 0; d <= len; d += 1.5) {
        const t = len ? d / len : 0;
        const dx = a.x + (b.x - a.x) * t - rect.x; const dz = a.z + (b.z - a.z) * t - rect.z;
        if (Math.abs(dx * bx + dz * bz) < rect.width / 2 + half && Math.abs(dx * ax + dz * az) < rect.depth / 2 + half) return false;
      }
    }
  }
  return true;
}

export type BuildingRect = { x: number; z: number; yaw: number; width: number; depth: number };

/**
 * 楼的实际占地矩形（朝向随地块）：非塔楼取地块面宽/进深的 0.92/0.9（同 FlightWorld 的 long 口径），
 * 塔楼/地标取 footprint 方形。**不能**用 FlightWorld 的保守 AABB（地块对角线方形，半宽 ≈ 4.7）：
 * 同街区地块间距 ≈ 7.2，相邻两楼必然「相交」——真实城市 380 楼报 253 条、1600 楼报 1111 条
 * buildingOverlap error，体检被噪声淹没。碰撞要保守，重叠判定要贴身，两件事不能共用一个包络。
 */
export function buildingRect(building: Pick<CityBuilding, "footprint" | "archetype">, slot: Parcel): BuildingRect {
  if (building.archetype === "tower" || building.archetype === "landmark") {
    return { x: slot.x, z: slot.z, yaw: slot.yaw, width: building.footprint, depth: building.footprint };
  }
  return { x: slot.x, z: slot.z, yaw: slot.yaw, width: slot.width * 0.92, depth: slot.depth * 0.9 };
}

/** 两个朝向矩形是否相交（分离轴定理，四根轴）。贴边（间隙 ≤ 1e-6）不算相交。 */
export function rectsOverlap(a: BuildingRect, b: BuildingRect): boolean {
  const axesOf = (r: BuildingRect) => [{ x: Math.cos(r.yaw), z: -Math.sin(r.yaw) }, { x: Math.sin(r.yaw), z: Math.cos(r.yaw) }];
  const extent = (r: BuildingRect, axis: Vec2) => {
    const [u, v] = axesOf(r);
    return Math.abs(u.x * axis.x + u.z * axis.z) * r.width / 2 + Math.abs(v.x * axis.x + v.z * axis.z) * r.depth / 2;
  };
  for (const axis of [...axesOf(a), ...axesOf(b)]) {
    const gap = Math.abs((b.x - a.x) * axis.x + (b.z - a.z) * axis.z);
    if (gap >= extent(a, axis) + extent(b, axis) - 1e-6) return false;
  }
  return true;
}
