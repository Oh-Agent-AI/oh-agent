/**
 * 规划修复 M2：道路编辑的硬规则（docs/CITY_PLAN_MANUAL_REPAIR_SPEC.md §7.3 节点拖动/删路段）。
 *
 * 纯函数、无副作用，看的是**当前生效布局**（已套补丁）里的当前 id——与编辑器拾取到的 id 同一口径，
 * 道路日志（planPatch.RoadOp）直接引用这些 id，无需翻译。
 *
 * 原则（放权后，SPEC §15，参考 SimCity）：**只拒绝物理上做不到的**——桥面、修进水里、太短/退化、撞上已有路口、
 * 压到锁定设施。其余（擦主干道、孤立楼、锐角、交叉、压到楼）一律放行，后果作为 warnings 告诉用户并自动处理：
 * 交叉处自动生成路口（planPatch 重放），压到的非会话设施推平、会话楼由开发商就近安置（planBulldozer）。
 * 只评估「这次编辑新引入」的影响：生成器自己留下的残余（压路、锐角）不算到这一笔头上。
 *
 * 近似声明（如实）：楼的「接路」按最近路段的较近端点判定，不是地块 frontage 的精确证明——
 * 足以拦住「删掉这条路让楼断网/离路太远」，但不保证与规划器的 frontage 判定逐点一致。
 */
import { atLeast, roadWidthFor, kindOfWidth, isStandardRoadWidth, REPAIR_VIADUCT_EXTRA } from "./roadStandard";
import type { CityModel } from "../cityModel";
import type { CityLayout, RoadEdge, Vec2 } from "./cityLayout";
import { bridgeChain, buildingRect, deckUnderLandmark, edgeLocked, edgesNear, highwayHit, nearestOnPolyline, rectClearOfEdges, VIADUCT_DECK_WIDTH, VIADUCT_JOIN_RADIUS, VIADUCT_RAMP, type BuildingRect } from "./planPatch";
import { bridgeApproachProblem, curvePoints, polylineMaxGrade, ROAD_MAX_GRADE, ROAD_STEEP_GRADE, minCurveRadius, polylineLength, polylineMinRadius, wetSpan } from "./planGeometry";
import { polygonDistance, roadNodeId } from "./cityPlan";
import { CHANNEL_T_GAP } from "./cityRoadPaint";
import { listSites, siteBox } from "./planSites";
import { frontEntrance, segmentPolygonDistance, worldOverhead, type Polygon } from "./planFootprint";

export type RoadVerdict = { blockers: string[]; warnings: string[] };

/** 编辑造出的路口夹角下限（2026-10-21，用户拍板「拦」）：< 50° 的三岔口渲染层会做渠化喇叭口（cityRoadPaint.CHANNEL_T_GAP），
 *  导流岛尖伸进主路车道，车在口里拐不过来——玩家式编辑抽样里，锐角接路只有约四成试驾通过，正常接路九成以上。
 *  曾经只有 < 30°（planner/constraints.ts::acuteJunctions 的口径）给提示、30–50° 连提示都没有。 */
const SHARP_LIMIT = CHANNEL_T_GAP;
const MIN_EDGE_LENGTH = 6;
const NODE_CLEARANCE = 1;       // 目标点距任何别的路口 < 1 视为撞车
const FAR_MOVE = 80;
const FRONTAGE_LIMIT = 40;      // 楼离最近道路的上限（同体检 orphanedBlock）
const SAMPLE_STEP = 4;
const ARTERIAL_WIDTH = 12;      // 主干道：宽 ≥ 12（擦它只提示，不再拒绝）

const quantize = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 });

/** 点到折线的最近距离。 */
function distanceToPolyline(p: Vec2, points: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]; const b = points[i];
    const dx = b.x - a.x; const dz = b.z - a.z; const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
  }
  return best;
}

/** 某节点处是否存在 < SHARP_LIMIT 的相邻路夹角（≥3 路才算，同 channelizedTPlan 的测角）。 */
function hasAcuteAt(edges: readonly RoadEdge[], nodeId: string, at: Vec2): boolean {
  const incident = edges.filter((edge) => edge.from === nodeId || edge.to === nodeId);
  if (incident.length < 3) return false;
  const angles = incident.map((edge) => {
    const pts = edge.from === nodeId ? edge.points : [...edge.points].reverse();
    return Math.atan2(pts[1].z - at.z, pts[1].x - at.x);
  }).sort((a, b) => a - b);
  for (let k = 0; k < angles.length; k += 1) {
    const gap = (k + 1 < angles.length ? angles[k + 1] : angles[0] + Math.PI * 2) - angles[k];
    if (gap < SHARP_LIMIT) return true;
  }
  return false;
}

/** 路会压到的对象：会话楼（只能被安置，不能被拆）与设施（可推平；锁定的不能动）。 */
/** door：自由级设施的正门（模型占地 +z 面中点 + 朝外方向）。shape：有真实占地的自由级设施的俯视投影——rect 只是它的包围盒，
 *  摩天轮（平台 + 横着的转盘窄条）、凯旋门的包围盒四角是空地，路擦过空角不算压到。 */
export type Obstacle = { kind: "session" | "site"; id: string; rect: BuildingRect; locked: boolean; door?: { at: Vec2; outward: Vec2 }; shape?: Polygon[] };
const obstacleCache = new WeakMap<CityLayout, { model: CityModel; obstacles: Obstacle[] }>();

/** 悬停预览每次鼠标移动都要评估，障碍按（布局, 模型）缓存——布局不可变，缓存随布局对象一起回收。 */
function obstacles(layout: CityLayout, model: CityModel): Obstacle[] {
  const hit = obstacleCache.get(layout);
  if (hit && hit.model === model) return hit.obstacles;
  const out: Obstacle[] = [];
  const buildings = new Map(model.buildings.map((building) => [building.id, building]));
  for (const district of layout.districts) for (const [id, slot] of district.slots) {
    const building = buildings.get(id);
    if (building) out.push({ kind: "session", id, rect: buildingRect(building, slot), locked: false });
  }
  for (const site of listSites(layout)) out.push({ kind: "site", id: site.id, rect: siteBox(site), locked: !!site.locked,
    ...(site.footprint ? { door: frontEntrance(site.footprint, site, site.yaw) } : {}),
    ...(site.footprint?.exact ? { shape: worldOverhead(site.footprint, site, site.yaw) } : {}) });
  obstacleCache.set(layout, { model, obstacles: out });
  return out;
}

/** 路段压到哪些障碍（返回下标集合）。先按距离粗筛，再用精确的朝向矩形 × 路带判定。 */
function hitsBy(edge: RoadEdge, list: readonly Obstacle[]): Set<number> {
  const hit = new Set<number>();
  list.forEach((item, index) => {
    if (distanceToPolyline(item.rect, edge.points) > 60 + Math.hypot(item.rect.width, item.rect.depth) / 2) return;
    if (rectClearOfEdges(item.rect, [edge], 0.5)) return;
    if (item.shape && !touchesShape(edge, item.shape)) return;
    // 一端落在设施正门、另一端朝门外：这是接到门口的路（接入路），不是压到设施。曾把它算作压到——
    // 推土机会把接入路服务的那座设施自己推平（verify-plan-bulldozer (f) 抓到）。
    if (item.door && servesDoor(edge, item.door, item.rect)) return;
    hit.add(index);
  });
  return hit;
}

/** 路带（半宽 + 0.5，同 rectClearOfEdges 的余量）是否碰到俯视投影的某一块。 */
function touchesShape(edge: RoadEdge, shape: readonly Polygon[]): boolean {
  const reach = edge.width / 2 + 0.5;
  for (let i = 1; i < edge.points.length; i += 1) {
    if (shape.some((part) => segmentPolygonDistance(edge.points[i - 1], edge.points[i], part) < reach)) return true;
  }
  return edge.points.length === 1 && shape.some((part) => segmentPolygonDistance(edge.points[0], edge.points[0], part) < reach);
}

function servesDoor(edge: RoadEdge, door: { at: Vec2; outward: Vec2 }, rect: BuildingRect): boolean {
  const ends = [[edge.points[0], edge.points[edge.points.length - 1]], [edge.points[edge.points.length - 1], edge.points[0]]] as const;
  return ends.some(([near, far]) => Math.hypot(near.x - door.at.x, near.z - door.at.z) <= 0.6
    && (far.x - door.at.x) * door.outward.x + (far.z - door.at.z) * door.outward.z > 0
    && rectClearOfEdges(rect, [{ ...edge, width: 0, points: [far, far] }], 0));
}

/** 一组新几何的路段会压到什么：要安置的会话楼、要推平的设施、压到的锁定设施（后者拒绝）。 */
export type RoadImpact = { relocate: string[]; bulldoze: string[]; locked: string[] };
export function roadImpact(layout: CityLayout, model: CityModel, edges: readonly RoadEdge[], exclude: ReadonlySet<number> = new Set()): RoadImpact {
  const list = obstacles(layout, model);
  const indices = new Set<number>();
  for (const edge of edges) for (const index of hitsBy(edge, list)) if (!exclude.has(index)) indices.add(index);
  const impact: RoadImpact = { relocate: [], bulldoze: [], locked: [] };
  for (const index of [...indices].sort((x, y) => x - y)) {
    const item = list[index];
    if (item.kind === "session") impact.relocate.push(item.id);
    else if (item.locked) impact.locked.push(item.id);
    else impact.bulldoze.push(item.id);
  }
  return impact;
}

/** 影响 → verdict：锁定设施拒绝，其余计数作为 warnings（`relocate:N` / `bulldoze:N`，面板翻译成人话）。 */
function applyImpact(impact: RoadImpact, blockers: string[], warnings: string[]): void {
  if (impact.locked.length) blockers.push("hits-locked-site");
  if (impact.bulldoze.length) warnings.push(`bulldoze:${impact.bulldoze.length}`);
  if (impact.relocate.length) warnings.push(`relocate:${impact.relocate.length}`);
}

/** 非桥路段沿线采样，统计不可建/水面采样点数。 */
/** 坡度（修复升级 P0-B）：新铺的地面路坡比 > 车的爬坡上限 → 阻断 road-too-steep（物理上开不上去，§15 口径）；> 0.2 → 提示 road-steep。
 *  `before[i]` 给出时第 i 段只拦「改陡了」的（拖生成器本来就陡的路口不该被拦——体检的 roadSteep 已经列着它）。
 *  每段只和**自己**改前比：曾拿所有被拖路段改前的最大坡度当一个基准，路口一边连着一条本来就陡（0.5）的路时，
 *  另一边平路被拖到 0.33 也放行了——车开不上去的新陡路就这样画了出来。 */
function gradeCheck(layout: CityLayout, polylines: readonly (readonly Vec2[])[], blockers: string[], warnings: string[], before: readonly number[] = []): void {
  let tooSteep = false, steep = false;
  polylines.forEach((points, i) => {
    const grade = polylineMaxGrade(layout, points).grade;
    if (grade <= (before[i] ?? 0) + 1e-6) return;
    if (grade > ROAD_MAX_GRADE) tooSteep = true;
    else if (grade > ROAD_STEEP_GRADE) steep = true;
  });
  if (tooSteep) blockers.push("road-too-steep");
  else if (steep) warnings.push("road-steep");
}

function badSamples(layout: CityLayout, edge: RoadEdge): number {
  if (edge.bridge) return 0;
  let bad = 0;
  for (let i = 1; i < edge.points.length; i += 1) {
    const a = edge.points[i - 1]; const b = edge.points[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    for (let d = 0; d <= len; d += SAMPLE_STEP) {
      const t = len ? d / len : 0;
      if (!layout.terrain.buildable(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) bad += 1;
    }
  }
  return bad;
}

/** 拖动路口的校验。`nodeId` 是生效布局里的 id。 */
export function validateNodeMove(layout: CityLayout, model: CityModel, nodeId: string, to: Vec2): RoadVerdict {
  const blockers: string[] = []; const warnings: string[] = [];
  const node = layout.roadNodes.find((candidate) => candidate.id === nodeId);
  if (!node) return { blockers: ["missing-node"], warnings };
  const incident = layout.roadEdges.filter((edge) => edge.from === nodeId || edge.to === nodeId);
  if (incident.some(edgeLocked)) return { blockers: ["locked-edge"], warnings };
  const target = quantize(to);
  const freshId = roadNodeId(target);
  if (freshId === nodeId) return { blockers: ["unchanged"], warnings };
  if (layout.roadNodes.some((other) => other.id !== nodeId && Math.hypot(other.x - target.x, other.z - target.z) < NODE_CLEARANCE)) blockers.push("node-collision");

  // 新几何：关联边只有朝向本节点的那一端动。
  const moved = incident.map((edge) => {
    const points = [...edge.points];
    if (edge.from === nodeId) points[0] = target; else points[points.length - 1] = target;
    return { before: edge, after: { ...edge, points } as RoadEdge };
  });
  if (moved.some(({ after }) => Math.hypot(after.points[0].x - after.points[after.points.length - 1].x, after.points[0].z - after.points[after.points.length - 1].z) < MIN_EDGE_LENGTH)) blockers.push("edge-too-short");

  // 入水：只拦新增的不可建采样点（生成器自己沿岸的路不算）。
  const badBefore = moved.reduce((sum, { before }) => sum + badSamples(layout, before), 0);
  const badAfter = moved.reduce((sum, { after }) => sum + badSamples(layout, after), 0);
  if (badAfter > badBefore) blockers.push("road-in-water");
  gradeCheck(layout, moved.map(({ after }) => after.points), blockers, warnings, moved.map(({ before }) => polylineMaxGrade(layout, before.points).grade));

  // 压到的东西：只算这一拖**新**压到的（原来就压着的是生成器残余，不算这一笔的）。
  const list = obstacles(layout, model);
  const already = new Set<number>();
  for (const { before } of moved) for (const index of hitsBy(before, list)) already.add(index);
  applyImpact(roadImpact(layout, model, moved.map(({ after }) => after), already), blockers, warnings);

  // 锐角：本节点与各邻居端点，编辑前没有、编辑后有。
  const afterEdges = layout.roadEdges.map((edge) => moved.find(({ before }) => before === edge)?.after ?? edge);
  const nodes = new Map<string, Vec2>(layout.roadNodes.map((candidate) => [candidate.id, candidate]));
  const neighbours = new Set(incident.map((edge) => (edge.from === nodeId ? edge.to : edge.from)));
  // 锐角路口拦下（车拐不过来）；本来就锐角的路口不算新违例。
  let acute = hasAcuteAt(afterEdges, nodeId, target) && !hasAcuteAt(layout.roadEdges, nodeId, node);
  for (const id of neighbours) {
    const at = nodes.get(id);
    if (at && hasAcuteAt(afterEdges, id, at) && !hasAcuteAt(layout.roadEdges, id, at)) acute = true;
  }
  if (acute) blockers.push("junction-too-sharp");
  if (Math.hypot(target.x - node.x, target.z - node.z) > FAR_MOVE) warnings.push("far-move");
  return { blockers, warnings };
}

type Access = { node: string | null; distance: number; edge: RoadEdge | null };

/** 每栋会话楼的「接路端点」与离最近路的距离（近似：最近路段的较近端点）。 */
function accessOf(layout: CityLayout, edges: readonly RoadEdge[], rects: readonly Vec2[]): Access[] {
  const nodes = new Map<string, Vec2>(layout.roadNodes.map((node) => [node.id, node]));
  // 全路网时走网格逐圈扩大搜索（结果逐字相同）：最近者距离 ≤ 当前半径时，半径外不可能有更近或并列的路。
  if (edges === layout.roadEdges) return rects.map((p) => {
    for (let radius = 40; radius < 1e5; radius *= 2) {
      const access = accessAt(nodes, edgesNear(layout, p.x, p.z, radius), p);
      if (access.edge && access.distance <= radius) return access;
    }
    return accessAt(nodes, edges, p);
  });
  return rects.map((p) => accessAt(nodes, edges, p));
}
function accessAt(nodes: ReadonlyMap<string, Vec2>, edges: readonly RoadEdge[], p: Vec2): Access {
  let best: RoadEdge | null = null; let bestD = Infinity;
  for (const edge of edges) {
    if (edge.bridge) continue;
    const d = distanceToPolyline(p, edge.points);
    if (d < bestD) { bestD = d; best = edge; }
  }
  if (!best) return { node: null, distance: Infinity, edge: null };
  const from = nodes.get(best.from); const to = nodes.get(best.to);
  const near = from && to && Math.hypot(from.x - p.x, from.z - p.z) <= Math.hypot(to.x - p.x, to.z - p.z) ? best.from : best.to;
  return { node: near, distance: bestD, edge: best };
}

/** 擦路校验的「擦之前」部分只依赖布局与模型：按布局缓存（橡皮擦悬停时鼠标每动一下都要校验）。 */
const dropBaseCache = new WeakMap<CityLayout, { model: CityModel; edges: readonly RoadEdge[]; slots: Vec2[]; ids: string[]; before: Access[]; comp: Map<string, number>; main: number | undefined }>();
function dropBase(layout: CityLayout, model: CityModel) {
  const hit = dropBaseCache.get(layout);
  if (hit && hit.model === model && hit.edges === layout.roadEdges) return hit;
  const slots: Vec2[] = []; const ids: string[] = [];
  const buildings = new Set(model.buildings.map((building) => building.id));
  for (const district of layout.districts) for (const [id, slot] of district.slots) if (buildings.has(id)) { slots.push(slot); ids.push(id); }
  const comp = components(layout.roadEdges);
  const sizes = new Map<number, number>();
  for (const label of comp.values()) sizes.set(label, (sizes.get(label) ?? 0) + 1);
  const main = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0];
  const entry = { model, edges: layout.roadEdges, slots, ids, before: accessOf(layout, layout.roadEdges, slots), comp, main };
  dropBaseCache.set(layout, entry);
  return entry;
}

/** 连通分量标号（含桥——桥连着岛上两片路网）。 */
function components(edges: readonly RoadEdge[]): Map<string, number> {
  const adjacent = new Map<string, string[]>();
  for (const edge of edges) {
    (adjacent.get(edge.from) ?? adjacent.set(edge.from, []).get(edge.from)!).push(edge.to);
    (adjacent.get(edge.to) ?? adjacent.set(edge.to, []).get(edge.to)!).push(edge.from);
  }
  const label = new Map<string, number>(); let next = 0;
  for (const start of adjacent.keys()) {
    if (label.has(start)) continue;
    const stack = [start]; label.set(start, next);
    while (stack.length) {
      const id = stack.pop()!;
      for (const other of adjacent.get(id) ?? []) if (!label.has(other)) { label.set(other, next); stack.push(other); }
    }
    next += 1;
  }
  return label;
}

/** 删路段的校验。`edgeId` 是生效布局里的 id。 */
export function validateEdgeDrop(layout: CityLayout, model: CityModel, edgeId: string): RoadVerdict {
  const blockers: string[] = []; const warnings: string[] = [];
  const edge = layout.roadEdges.find((candidate) => candidate.id === edgeId);
  if (!edge) return { blockers: ["missing-edge"], warnings };
  // 擦桥面 = 擦整座桥（与重放同一个 bridgeChain）；影响按整座算。悬索桥下的桥也能擦（7/2 的坏桥头正是悬索桥），塔与缆一起拆。
  const chain = bridgeChain(layout.roadEdges, edge); const dropped = new Set(chain);
  if (edgeLocked(edge)) warnings.push(chain.some((piece) => deckUnderLandmark(layout, piece)) ? "erases-suspension-bridge" : "erases-bridge");
  if (edge.width >= ARTERIAL_WIDTH) warnings.push("erases-arterial");
  if (edge.structure === "ground-approach") warnings.push("cuts-bridge");
  if (edge.purpose === "waterfront") warnings.push("erases-waterfront");

  const remaining = layout.roadEdges.filter((candidate) => !dropped.has(candidate));
  const { slots, ids, before, comp: compBefore, main: mainBefore } = dropBase(layout, model);
  // 结果逐字不变：最近路段不是被擦的那条的楼，擦掉一条「更远或并列在后」的路不改变它的最近路段（取最小用严格 <，
  // 并列取先出现的）——只有最近路段恰是被擦那条的楼要重算。曾每次对全城楼 × 全城路重算两遍（4000 楼 0.7 秒/次悬停）。
  const nodes = new Map<string, Vec2>(layout.roadNodes.map((node) => [node.id, node]));
  const after = before.map((access, i) => (access.edge && dropped.has(access.edge) ? accessAt(nodes, remaining, slots[i]) : access));

  // 离路太远：原本在范围内、删后超出的楼。
  const stranded = ids.filter((_, i) => before[i].distance <= FRONTAGE_LIMIT && after[i].distance > FRONTAGE_LIMIT);
  if (stranded.length) warnings.push("strands-buildings");

  // 断网：原本接在主网上的楼，删后不再与其他「接主网的楼」同一连通分量。
  const compAfter = components(remaining);
  const served = ids.map((_, i) => i).filter((i) => before[i].node !== null && compBefore.get(before[i].node!) === mainBefore);
  const afterLabels = new Set(served.map((i) => (after[i].node === null ? -1 : (compAfter.get(after[i].node!) ?? -1))));
  if (afterLabels.size > 1 || afterLabels.has(-1)) warnings.push("disconnects-buildings");

  // 新断头：删后某端点度数落到 1（它连着别的路，只是少了一条）。
  const degree = new Map<string, number>();
  for (const other of remaining) if (!other.bridge) for (const id of [other.from, other.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
  if (chain.flatMap((dead) => [dead.from, dead.to]).some((id) => degree.get(id) === 1)) warnings.push("creates-dead-end");
  return { blockers, warnings };
}

export type RoadTarget = { kind: "node" | "edge"; id: string; locked: boolean };

/** 点击地面一点最近的路口/路段：6 以内取路口，否则取路面带（半宽 + 3）内最近的路段。 */
export function nearestRoadTarget(layout: CityLayout, x: number, z: number): RoadTarget | null {
  const p = { x, z };
  let node: { id: string; d: number } | null = null;
  for (const candidate of layout.roadNodes) {
    const d = Math.hypot(candidate.x - x, candidate.z - z);
    if (d <= 6 && (!node || d < node.d)) node = { id: candidate.id, d };
  }
  if (node) {
    const locked = layout.roadEdges.some((edge) => (edge.from === node!.id || edge.to === node!.id) && edgeLocked(edge));
    return { kind: "node", id: node.id, locked };
  }
  let edge: { edge: RoadEdge; d: number } | null = null;
  for (const candidate of layout.roadEdges) {
    const d = distanceToPolyline(p, candidate.points);
    if (d <= candidate.width / 2 + 3 && (!edge || d < edge.d)) edge = { edge: candidate, d };
  }
  return edge ? { kind: "edge", id: edge.edge.id, locked: edgeLocked(edge.edge) } : null;
}

// ── 画路 / 橡皮擦 ─────────────────────────────────────────────────────────────

const SNAP_NODE_UI = 8;   // 画路时鼠标离路口这么近就吸附到路口
const SNAP_EDGE_UI = 4;   // 离路段这么近就吸附到路段上（落笔时把该路段拆开）
const MAX_NEW_EDGE = 800;
const CROSS_EPS = 1;      // 与现有路的交点离新路端点 < 1 视为「接在端点上」，不算交叉

export type SnapPoint = { x: number; z: number; kind: "node" | "edge" | "free"; nodeId?: string; edgeId?: string; locked: boolean };

/** 画路的吸附：路口（8 内）→ 路段上最近点（4 内）→ 自由点。 */
export function snapPoint(layout: CityLayout, x: number, z: number): SnapPoint {
  let node: { id: string; x: number; z: number; d: number } | null = null;
  for (const candidate of layout.roadNodes) {
    const d = Math.hypot(candidate.x - x, candidate.z - z);
    if (d <= SNAP_NODE_UI && (!node || d < node.d)) node = { id: candidate.id, x: candidate.x, z: candidate.z, d };
  }
  if (node) {
    const locked = layout.roadEdges.some((edge) => (edge.from === node!.id || edge.to === node!.id) && edgeLocked(edge));
    return { x: node.x, z: node.z, kind: "node", nodeId: node.id, locked };
  }
  let host: { edge: RoadEdge; point: Vec2; d: number } | null = null;
  for (const edge of layout.roadEdges) {
    const hit = nearestOnPolyline({ x, z }, edge.points);
    if (hit.distance <= SNAP_EDGE_UI && (!host || hit.distance < host.d)) host = { edge, point: hit.point, d: hit.distance };
  }
  if (host) { const at = quantize(host.point); return { x: at.x, z: at.z, kind: "edge", edgeId: host.edge.id, locked: edgeLocked(host.edge) }; }
  const free = quantize({ x, z });
  return { x: free.x, z: free.z, kind: "free", locked: false };
}

/** 橡皮擦悬停：路面带（半宽 + 4）内最近的路段。 */
export function nearestEdgeAt(layout: CityLayout, x: number, z: number): RoadEdge | null {
  let best: { edge: RoadEdge; d: number } | null = null;
  for (const edge of layout.roadEdges) {
    const d = nearestOnPolyline({ x, z }, edge.points).distance;
    if (d <= edge.width / 2 + 4 && (!best || d < best.d)) best = { edge, d };
  }
  return best?.edge ?? null;
}

/** 新路 a→b 与现有地面路的交点（离 a/b 端点 1 以内的不算，那是「接在端点上」），按离 a 的距离排序。 */
export function crossingPoints(layout: CityLayout, a: Vec2, b: Vec2): Vec2[] {
  const out: Vec2[] = [];
  for (const edge of layout.roadEdges) {
    if (edge.bridge) continue;
    for (let i = 1; i < edge.points.length; i += 1) {
      const hit = segmentIntersection(a, b, edge.points[i - 1], edge.points[i]);
      if (hit && Math.hypot(hit.x - a.x, hit.z - a.z) > CROSS_EPS && Math.hypot(hit.x - b.x, hit.z - b.z) > CROSS_EPS) out.push(hit);
    }
  }
  return out.sort((p, q) => Math.hypot(p.x - a.x, p.z - a.z) - Math.hypot(q.x - a.x, q.z - a.z));
}

/** 两线段的真交点（参数都落在开区间内），无交点返回 null。 */
function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = { x: b.x - a.x, z: b.z - a.z }; const s = { x: d.x - c.x, z: d.z - c.z };
  const denom = r.x * s.z - r.z * s.x;
  if (Math.abs(denom) < 1e-9) return null; // 平行/共线
  const t = ((c.x - a.x) * s.z - (c.z - a.z) * s.x) / denom;
  const u = ((c.x - a.x) * r.z - (c.z - a.z) * r.x) / denom;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { x: a.x + r.x * t, z: a.z + r.z * t };
}

type Attach = { kind: "node"; id: string } | { kind: "edge"; edge: RoadEdge; point: Vec2; segment: number } | { kind: "free" };

/** 端点吸附后的接入对象：已有路口 / 路段中间（要拆）/ 自由点。与 planPatch.resolveEndpoint 同一口径（< 1 取路口，≤ 0.6 取路段）。 */
function attach(layout: CityLayout, p: Vec2): Attach {
  const at = quantize(p);
  const node = layout.roadNodes.find((candidate) => Math.hypot(candidate.x - at.x, candidate.z - at.z) < 1);
  if (node) return { kind: "node", id: node.id };
  let host: { edge: RoadEdge; hit: ReturnType<typeof nearestOnPolyline> } | null = null;
  for (const edge of layout.roadEdges) {
    const hit = nearestOnPolyline(at, edge.points);
    if (hit.distance <= 0.6 && (!host || hit.distance < host.hit.distance)) host = { edge, hit };
  }
  return host ? { kind: "edge", edge: host.edge, point: host.hit.point, segment: host.hit.segment } : { kind: "free" };
}

/** 端点处的相邻路方向（出发角）：已有路口 → 其关联边；路段中间 → 被拆出的两半。 */
function directionsAt(layout: CityLayout, end: Attach, at: Vec2): number[] {
  const toward = (from: Vec2, to: Vec2) => Math.atan2(to.z - from.z, to.x - from.x);
  if (end.kind === "node") {
    return layout.roadEdges.filter((edge) => edge.from === end.id || edge.to === end.id).map((edge) => {
      const pts = edge.from === end.id ? edge.points : [...edge.points].reverse();
      return toward(pts[0], pts[1]);
    });
  }
  if (end.kind === "edge") {
    const pts = end.edge.points;
    return [toward(at, pts[end.segment - 1]), toward(at, pts[end.segment])];
  }
  return [];
}

function minGap(angles: readonly number[]): number {
  const sorted = [...angles].sort((a, b) => a - b);
  let gap = Infinity;
  for (let k = 0; k < sorted.length; k += 1) gap = Math.min(gap, (k + 1 < sorted.length ? sorted[k + 1] : sorted[0] + Math.PI * 2) - sorted[k]);
  return gap;
}

/**
 * 画路的校验：from/to 是已吸附的坐标。硬阻止：太短/太长、锁定宿主、孤立（两端都没接上路网）、重复/退化、
 * 入水、穿过楼/配套/花园、与现有道路交叉（要在交叉点连接）、新引入的锐角路口。警告：新断头。
 */
export function validateRoadAdd(layout: CityLayout, model: CityModel, from: Vec2, to: Vec2, width: number, purpose?: "waterfront", ignoreSites: readonly string[] = [], via?: Vec2): RoadVerdict {
  if (!isStandardRoadWidth(width)) return { blockers: ["non-standard-width"], warnings: [] };
  if (via) return validateCurveAdd(layout, model, from, via, to, width, purpose);
  const blockers: string[] = []; const warnings: string[] = [];
  const a = quantize(from); const b = quantize(to);
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  if (length < MIN_EDGE_LENGTH) return { blockers: ["edge-too-short"], warnings };
  if (length > MAX_NEW_EDGE) blockers.push("edge-too-long");
  const ea = attach(layout, a); const eb = attach(layout, b);
  const lockedNode = (end: Attach) => end.kind === "node" && layout.roadEdges.some((edge) => (edge.from === end.id || edge.to === end.id) && edgeLocked(edge));
  // 宿主是桥/引道/滨海段，或从桥头/滨海路口接出：会改变它们的形态，同拖路口一样锁定。
  if ((ea.kind === "edge" && edgeLocked(ea.edge)) || (eb.kind === "edge" && edgeLocked(eb.edge)) || lockedNode(ea) || lockedNode(eb)) return { blockers: ["locked-edge"], warnings };
  if (ea.kind === "node" && eb.kind === "node") {
    if (ea.id === eb.id) return { blockers: ["degenerate"], warnings };
    if (layout.roadEdges.some((edge) => edge.id === [ea.id, eb.id].sort().join("/"))) return { blockers: ["edge-exists"], warnings };
  }
  // 两端都悬空、且路上没有交叉路口，才算孤立——交叉处会自动生成路口，那也是接上了路网。
  const junctions = crossingPoints(layout, a, b).length;
  if (ea.kind === "free" && eb.kind === "free" && junctions === 0) warnings.push("isolated-road");
  if (ea.kind === "free" || eb.kind === "free") warnings.push("creates-dead-end");

  const next: RoadEdge = { id: "new", from: "a", to: "b", width, kind: kindOfWidth(width), points: [a, b], structure: "ground-road" };
  // 地面桥（路线图 P1-5）：一笔恰好跨一段水、两端在陆地上、桥长 ≤ MAX_GROUND_BRIDGE → 水面段架成桥（重放时拆成 引道 + 桥面 + 引道，
  // 同一个 wetSpan 判定）；端点在水里、连跨两段水 → 仍是 road-in-water；水面太宽 → bridge-too-long（请用高架）。
  const span = wetSpan(layout, a, b);
  // 端点：过河的一笔只要求不落在水里（桥头在前滩上，生成器同口径）；不过河的一笔仍要求两端可建。
  if (span.kind === "invalid") blockers.push(span.reason === "bridge-too-long" ? "bridge-too-long" : "road-in-water");
  else if (span.kind === "dry" && (!layout.terrain.buildable(a.x, a.z) || !layout.terrain.buildable(b.x, b.z))) blockers.push("road-in-water");
  else if (span.kind === "bridge") {
    warnings.push(`bridge:${Math.round(span.length)}`);
    // 桥上不能有路口（生成器同口径）：交点落在桥面段内就拦。
    const crossings = crossingPoints(layout, a, b);
    if (crossings.some((p) => nearestOnPolyline(p, [span.from, span.to]).distance < 0.5)) blockers.push("junction-on-bridge");
    const approach = bridgeApproachProblem(layout, a, b, span, width, crossings);
    if (approach) blockers.push(approach);
    else gradeCheck(layout, [[a, span.from], [span.to, b]], blockers, warnings);
    // 桥上方有高架：本期不算净空，提示用户自己看。
    if ((layout.highways ?? []).some((run) => run.some((q, i) => i > 0 && !!segmentIntersection(run[i - 1], q, span.from, span.to)))) warnings.push("bridge-under-viaduct");
  } else if (badSamples(layout, next) > 0) blockers.push("road-in-water");
  else gradeCheck(layout, [[a, b]], blockers, warnings);
  // ignoreSites：接入路从设施自己的门口起笔，路带必然擦到它自己——不算「压到设施」。
  const ignored = new Set<number>();
  if (ignoreSites.length) obstacles(layout, model).forEach((item, index) => { if (item.kind === "site" && ignoreSites.includes(item.id)) ignored.add(index); });
  applyImpact(roadImpact(layout, model, [next], ignored), blockers, warnings);

  // 交叉：自动生成路口（planPatch 重放时在交点处把两条路都拆开），这里只数一下告诉用户。
  if (junctions) warnings.push(`auto-junction:${junctions}`);
  // 滨海大道离海太远：景观带仍会铺，但铺在离海近的一侧的陆地上——提示，不拦（SimCity 也不管你把海滨大道修在哪）。
  if (purpose === "waterfront" && layout.coast?.length && Math.abs(polygonDistance({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, layout.coast)) > FAR_FROM_COAST) warnings.push("far-from-coast");

  // 锐角（< 50°）：只拦新引入的（接到的路口本来就锐角的不算新违例）。
  const dirAB = Math.atan2(b.z - a.z, b.x - a.x); const dirBA = Math.atan2(a.z - b.z, a.x - b.x);
  for (const [end, at, dir] of [[ea, a, dirAB], [eb, b, dirBA]] as const) {
    const existing = directionsAt(layout, end, at);
    if (existing.length + 1 < 3) continue;
    if (minGap([...existing, dir]) < SHARP_LIMIT && !(existing.length >= 3 && minGap(existing) < SHARP_LIMIT)) { blockers.push("junction-too-sharp"); break; }
  }
  return { blockers, warnings };
}

/**
 * 弧线的校验（与 planPatch 重放同一条 curvePoints 折线）：长度、最小转弯半径（按路型，curve-too-tight）、
 * 不过水（过河用直线架桥）、压楼走推土机、交叉自动路口、两端的锐角按弧线端点切线算。
 */
function validateCurveAdd(layout: CityLayout, model: CityModel, from: Vec2, via: Vec2, to: Vec2, width: number, purpose?: "waterfront"): RoadVerdict {
  const blockers: string[] = []; const warnings: string[] = [];
  const a = quantize(from); const b = quantize(to);
  const pts = curvePoints(a, quantize(via), b);
  const length = polylineLength(pts);
  if (Math.hypot(b.x - a.x, b.z - a.z) < MIN_EDGE_LENGTH) return { blockers: ["edge-too-short"], warnings };
  if (length > MAX_NEW_EDGE) blockers.push("edge-too-long");
  if (polylineMinRadius(pts) < minCurveRadius(width) - 1e-6) blockers.push("curve-too-tight");
  const ea = attach(layout, a); const eb = attach(layout, b);
  const lockedNode = (end: Attach) => end.kind === "node" && layout.roadEdges.some((edge) => (edge.from === end.id || edge.to === end.id) && edgeLocked(edge));
  if ((ea.kind === "edge" && edgeLocked(ea.edge)) || (eb.kind === "edge" && edgeLocked(eb.edge)) || lockedNode(ea) || lockedNode(eb)) return { blockers: ["locked-edge"], warnings };
  if (ea.kind === "node" && eb.kind === "node" && ea.id === eb.id) return { blockers: ["degenerate"], warnings };
  let junctions = 0;
  for (let i = 1; i < pts.length; i += 1) {
    junctions += crossingPoints(layout, pts[i - 1], pts[i]).length;
    // 采样点正好落在现有路上（与重放同口径：交点检测看不见端点处的交叉，按「路上的点」补数）。
    if (i < pts.length - 1 && layout.roadEdges.some((edge) => !edge.bridge && nearestOnPolyline(pts[i], edge.points).distance < 1)) junctions += 1;
    if (wetSpan(layout, pts[i - 1], pts[i]).kind !== "dry" && !blockers.includes("curve-over-water")) blockers.push("curve-over-water");
  }
  if (ea.kind === "free" && eb.kind === "free" && junctions === 0) warnings.push("isolated-road");
  if (ea.kind === "free" || eb.kind === "free") warnings.push("creates-dead-end");
  if (!blockers.includes("curve-over-water")) gradeCheck(layout, [pts], blockers, warnings);
  const next: RoadEdge = { id: "new", from: "a", to: "b", width, kind: kindOfWidth(width), points: pts, structure: "ground-road" };
  applyImpact(roadImpact(layout, model, [next]), blockers, warnings);
  if (junctions) warnings.push(`auto-junction:${junctions}`);
  if (purpose === "waterfront" && layout.coast?.length && Math.abs(polygonDistance(pts[Math.floor(pts.length / 2)], layout.coast)) > FAR_FROM_COAST) warnings.push("far-from-coast");
  const dirA = Math.atan2(pts[1].z - a.z, pts[1].x - a.x); const n = pts.length;
  const dirB = Math.atan2(pts[n - 2].z - b.z, pts[n - 2].x - b.x);
  for (const [end, at, dir] of [[ea, a, dirA], [eb, b, dirB]] as const) {
    const existing = directionsAt(layout, end, at);
    if (existing.length + 1 < 3) continue;
    if (minGap([...existing, dir]) < SHARP_LIMIT && !(existing.length >= 3 && minGap(existing) < SHARP_LIMIT)) { blockers.push("junction-too-sharp"); break; }
  }
  return { blockers, warnings };
}

// ── 改路型（路线图 P1-4）──────────────────────────────────────────────────────

/** 一条路的「一整段」上限（防御：环形路沿度 2 路口能一直走下去）。 */
const MAX_RUN = 400;

/**
 * 从一段路出发，沿**度为 2** 的路口向两头走：下一段与它同宽、同用途、不是桥面就连上。走到岔路口、断头、换路型或桥为止。
 * 用户改路型说的是「这条街」，不是两个路口之间的一小截——画路时一笔经过的自动路口、倒圆的拐点都是度 2 路口，会把一条街切成很多段。
 * 返回路段 id，按沿路顺序；起点段不存在返回 []。
 */
export function roadRun(layout: CityLayout, edgeId: string): string[] {
  const start = layout.roadEdges.find((edge) => edge.id === edgeId);
  if (!start) return [];
  const incident = new Map<string, RoadEdge[]>();
  for (const edge of layout.roadEdges) for (const node of [edge.from, edge.to]) {
    const list = incident.get(node); if (list) list.push(edge); else incident.set(node, [edge]);
  }
  const same = (edge: RoadEdge) => !edgeLocked(edge) && edge.width === start.width && edge.purpose === start.purpose;
  const seen = new Set([start.id]);
  const walk = (node: string, from: RoadEdge): string[] => {
    const out: string[] = [];
    let at = node; let prev = from;
    while (out.length < MAX_RUN) {
      const around = incident.get(at) ?? [];
      if (around.length !== 2) break;
      const next = around[0] === prev ? around[1] : around[0];
      if (seen.has(next.id) || !same(next)) break;
      seen.add(next.id); out.push(next.id);
      at = next.from === at ? next.to : next.from; prev = next;
    }
    return out;
  };
  const back = walk(start.from, start); const ahead = walk(start.to, start);
  return [...back.reverse(), start.id, ...ahead];
}

/**
 * 改路型的校验：桥面拒绝；已经是这个路型拒绝（unchanged）；变宽压到的楼走推土机提示（与画路同一套）；
 * 滨海大道离海远提示；把滨海路/主干道改成普通路提示（景观带随之撤掉 / 骨架变窄）——提示不拦。
 */
export function validateRestyle(layout: CityLayout, model: CityModel, edgeIds: readonly string[], width: number, purpose?: "waterfront"): RoadVerdict {
  if (!isStandardRoadWidth(width)) return { blockers: ["non-standard-width"], warnings: [] };
  const blockers: string[] = []; const warnings: string[] = [];
  const byId = new Map(layout.roadEdges.map((edge) => [edge.id, edge]));
  const edges = edgeIds.map((id) => byId.get(id)).filter((edge): edge is RoadEdge => !!edge);
  if (!edges.length) return { blockers: ["missing-edge"], warnings };
  if (edges.some(edgeLocked)) return { blockers: ["locked-edge"], warnings };
  const changing = edges.filter((edge) => edge.width !== width || edge.purpose !== purpose);
  if (!changing.length) return { blockers: ["unchanged"], warnings };
  const wider = changing.filter((edge) => width > edge.width).map((edge) => ({ ...edge, width }));
  if (wider.length) applyImpact(roadImpact(layout, model, wider), blockers, warnings);
  if (changing.some((edge) => edge.purpose === "waterfront") && purpose !== "waterfront") warnings.push("drops-waterfront");
  if (changing.some((edge) => atLeast(edge, "collector")) && width < roadWidthFor("collector")) warnings.push("narrows-arterial");
  if (purpose === "waterfront" && layout.coast?.length) {
    const mids = changing.map((edge) => edge.points[Math.floor(edge.points.length / 2)]);
    if (mids.every((p) => Math.abs(polygonDistance(p, layout.coast!)) > FAR_FROM_COAST)) warnings.push("far-from-coast");
  }
  return { blockers, warnings };
}

// ── 高架（SPEC §17.2）────────────────────────────────────────────────────────

/** 滨海大道中点离海岸线超过这个距离就提示。 */
const FAR_FROM_COAST = 90;
/** 高架最短（再短就只是一个鼓包）。 */
const MIN_VIADUCT = 30;

/** 高架折线 → 「路段」形状（宽 = 桥面宽 + 1 的净空），给压到建筑的判定与推土机用。不进路网。 */
export function viaductEdges(points: readonly Vec2[]): RoadEdge[] {
  const out: RoadEdge[] = [];
  for (let i = 1; i < points.length; i += 1) out.push({ id: `viaduct:${i}`, from: "va", to: "vb", width: VIADUCT_DECK_WIDTH + REPAIR_VIADUCT_EXTRA, kind: "arterial", points: [points[i - 1], points[i]], structure: "ground-road" });
  return out;
}

/** 高架首/尾点是否落在已有高架的开口端（会接上去，那一端没有匝道）。 */
function viaductJoins(layout: CityLayout, end: Vec2): boolean {
  return (layout.highways ?? []).some((run) => run.length >= 2
    && !(run.length > 2 && Math.hypot(run[0].x - run[run.length - 1].x, run[0].z - run[run.length - 1].z) < 0.01)
    && [run[0], run[run.length - 1]].some((q) => Math.hypot(q.x - end.x, q.z - end.z) <= VIADUCT_JOIN_RADIUS));
}

/**
 * 画高架的校验。阻断只有物理上不成立的：少于两个不同的点、太短、单段超长、匝道落地点在水里（接到已有高架的那一端不落地，不查）。
 * 其余提示：太短升不到全高（两端各要 90 匝道）、接上已有高架、压到的建筑（推平/安置，同画路）。
 * 跨过地面路、河、海湾都可以——桥墩立在水里本来就是高架的画法。
 */
export function validateHighwayAdd(layout: CityLayout, model: CityModel, points: readonly Vec2[]): RoadVerdict {
  const blockers: string[] = []; const warnings: string[] = [];
  const q = points.map(quantize).filter((p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1].x, p.z - all[i - 1].z) >= 1);
  if (q.length < 2) return { blockers: ["degenerate"], warnings };
  let total = 0;
  for (let i = 1; i < q.length; i += 1) {
    const length = Math.hypot(q[i].x - q[i - 1].x, q[i].z - q[i - 1].z);
    total += length;
    if (length > MAX_NEW_EDGE) blockers.push("edge-too-long");
  }
  if (total < MIN_VIADUCT) return { blockers: ["viaduct-too-short"], warnings };
  const head = viaductJoins(layout, q[0]); const tail = viaductJoins(layout, q[q.length - 1]);
  if ((!head && !layout.terrain.buildable(q[0].x, q[0].z)) || (!tail && !layout.terrain.buildable(q[q.length - 1].x, q[q.length - 1].z))) blockers.push("viaduct-end-in-water");
  if (head || tail) warnings.push("joins-viaduct");
  else if (total < VIADUCT_RAMP * 2) warnings.push("short-viaduct");
  // 已经压在现有高架下的（生成器残余）不算这一笔的。
  const list = obstacles(layout, model);
  const already = new Set<number>();
  for (const run of layout.highways ?? []) for (const edge of viaductEdges(run)) for (const index of hitsBy(edge, list)) already.add(index);
  applyImpact(roadImpact(layout, model, viaductEdges(q), already), blockers, warnings);
  return { blockers: [...new Set(blockers)], warnings };
}

/** 橡皮擦切高架：这里有没有高架；有就提示「断成两条、断口各自落地」。 */
export function validateHighwayCut(layout: CityLayout, at: Vec2): RoadVerdict {
  return highwayHit(layout.highways ?? [], at) ? { blockers: [], warnings: ["cuts-viaduct"] } : { blockers: ["missing-highway"], warnings: [] };
}
