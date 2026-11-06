/**
 * 机场岛选址与平台几何（纯 CPU，无 THREE）：L-4 机场岛 + L-5 堤道（CITY_LANDMARK_BACKLOG）。
 * 2026-10-22 起在布局期规划（cityLayout → layout.airport），不再在渲染期临时算：堤道成为路网里的一段桥面，
 * 机场平台成为可行驶的地标平台（surface/landmarkPlatforms），渲染、驾驶面、碰撞读同一份规划。
 * 曾经只在 cityParts 渲染期调 planAirport：堤道是一排水平箱体拼的台阶（顶面 2.9→4.2、起点高出岸上路面近 2），
 * 平台顶面 0.4 而跑道 / 航站楼底在 1.4（整组悬空 1），驾驶面里根本没有它——看得见的桥，车开不上去。
 */
import { roadWidthFor, kindOfWidth } from "./roadStandard";
import { DetMath as Math } from "./detMath"; // 布局期：跨引擎确定性（detMath.ts）
import type { Vec2 } from "./cityLayout";

/** 填海平台：长边沿海岸（本地 x），短边朝外（本地 z）。顶面 = 跑道、航站楼、驾驶面落地的那一层。 */
export const AIRPORT_PLATFORM = Object.freeze({ length: 240, width: 110, top: 1.4 });
/** 堤道桥面最窄宽度（路网桥段宽度；渲染护栏/桥墩由普通桥梁渲染器按它画）。实际取起桥路口上最宽那条路的宽度：
 *  桥面比来路宽（曾固定 10，岸上支路 5），桥头拐角处路面口门接不上，试驾在岸端就 no-surface。 */
export const AIRPORT_CAUSEWAY_WIDTH = roadWidthFor("local");
/** 堤道落在平台内侧这么深（端头必须在平台里，才算落到平台上）。 */
export const AIRPORT_CAUSEWAY_INSET = 4;

/** `causeway`：从岸上路口（路网节点）到平台落点的桥段两端；没有能接上的路口时缺省（岛照画，车上不去）。 */
export type AirportPlan = { shore: Vec2; centre: Vec2; yaw: number; outward: Vec2; causeway?: { from: Vec2; fromNode: string; to: Vec2 } };
/** 给定候选岸点与平台落点，返回能起桥的路口（null = 接不上）。布局期由 cityLayout 提供（看路网）。 */
export type AirportCausewayConnector = (shorePoint: Vec2, end: Vec2) => { at: Vec2; nodeId: string } | null;

/** 在海岸上挑一个点：离核心最远方向里、离港口与海滨景观段都远的岸点。 */
/** 把非桥路段按 ~20 采样成点集，供选址判断「岸点离路多远」。 */
export function roadSamples(edges: Array<{ points: Vec2[]; bridge?: boolean }>): Vec2[] {
  const out: Vec2[] = [];
  for (const e of edges) {
    if (e.bridge) continue;
    const a = e.points[0]; const b = e.points[e.points.length - 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 20));
    for (let k = 0; k <= n; k += 1) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

export function planAirport(coast: Vec2[], core: Vec2, avoid: Vec2[], roads: Vec2[] = [], isWater?: (x: number, z: number) => boolean, connect?: AirportCausewayConnector): AirportPlan | null {
  if (coast.length < 8) return null;
  // 堤道陆地端必须落在路网上（用户截图：堤道接到没有路的山岬上）：岸点 30 内有路的优先，其次才是纯按远近。
  // 整个平台（240×110 + 护岸，沿海岸平行铺开）必须全在水里（用户截图：机场压在陆地上——海岸弯曲时长边的一头会伸到岸上）：
  // 按得分从高到低试岸点，每个岸点试 140/170/200/240 四个离岸距离，平台范围按 20 间距采样全部入水才通过。
  const ranked: Array<{ p: Vec2; score: number }> = [];
  for (const p of coast) {
    const far = Math.hypot(p.x - core.x, p.z - core.z);
    const clear = Math.min(...avoid.map((a) => Math.hypot(a.x - p.x, a.z - p.z)), 999);
    if (clear < 160) continue;
    let road = Infinity; for (const r of roads) road = Math.min(road, Math.hypot(r.x - p.x, r.z - p.z));
    ranked.push({ p, score: far + clear * 0.5 + (roads.length ? (road <= 30 ? 1000 : -road) : 0) });
  }
  ranked.sort((a, b) => b.score - a.score);
  let fallback: AirportPlan | null = null;
  const L = 240 + 12; const W = 110 + 12;
  const footprintWet = (centre: Vec2, yaw: number): boolean => {
    if (!isWater) return true;
    const c = Math.cos(yaw); const sn = Math.sin(yaw);
    for (let lx = -L / 2; lx <= L / 2 + 0.1; lx += 20) for (let lz = -W / 2; lz <= W / 2 + 0.1; lz += 20) {
      // three 的 rotation.y = θ：本地 (lx, lz) → 世界 (lx·cosθ + lz·sinθ, −lx·sinθ + lz·cosθ)
      if (!isWater(centre.x + lx * c + lz * sn, centre.z - lx * sn + lz * c)) return false;
    }
    return true;
  };
  for (const cand of ranked) {
    const len = Math.hypot(cand.p.x - core.x, cand.p.z - core.z) || 1;
    const outward = { x: (cand.p.x - core.x) / len, z: (cand.p.z - core.z) / len };
    let shore = cand.p;
    if (roads.length) { // 起点吸附到最近路点（≤40），堤道从路上起步
      let nearest = roads[0]; let nd = Infinity;
      for (const r of roads) { const d = Math.hypot(r.x - cand.p.x, r.z - cand.p.z); if (d < nd) { nd = d; nearest = r; } }
      if (nd <= 40) shore = { x: nearest.x, z: nearest.z };
    }
    for (const dist of [140, 170, 200, 240]) {
      const centre = { x: cand.p.x + outward.x * dist, z: cand.p.z + outward.z * dist };
      const yaw = Math.atan2(outward.x, outward.z);
      if (!footprintWet(centre, yaw)) continue;
      const plan: AirportPlan = { shore, centre, outward, yaw };
      if (!connect) return plan;
      fallback ??= plan;
      // 堤道必须从路口起、一路不压别的路（cityLayout 的 connect 判）：接不上就试下一个离岸距离 / 岸点。
      const end = airportCausewayEnd(plan);
      const node = connect(cand.p, end);
      if (node) return { ...plan, shore: node.at, causeway: { from: node.at, fromNode: node.nodeId, to: end } };
    }
  }
  // 没有一个候选接得上路网：岛照画（第一个合格平台），不连堤道——不编一座车开不过去的桥。
  return fallback;
}

/** 堤道在平台上的落点：平台近岸长边的中点往里 AIRPORT_CAUSEWAY_INSET。 */
export function airportCausewayEnd(plan: AirportPlan): Vec2 {
  const back = AIRPORT_PLATFORM.width / 2 - AIRPORT_CAUSEWAY_INSET;
  return { x: plan.centre.x - plan.outward.x * back, z: plan.centre.z - plan.outward.z * back };
}

type LayoutRoadEdge = { id: string; from: string; to: string; width: number; kind: "arterial" | "local"; points: Vec2[]; bridge?: boolean; structure?: string };
type LayoutRoadNode = Vec2 & { id: string };
type LayoutSite = Vec2 & { radius?: number };
const q2 = (v: number) => Math.round(v * 100) / 100;
/** 线段到线段的最近距离（不相交时 = 四个端点到对边的最小值）。 */
function segmentGap(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  const cross = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const point = (p: Vec2, s: Vec2, t: Vec2) => {
    const dx = t.x - s.x, dz = t.z - s.z; const k = Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.z - s.z) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(p.x - s.x - dx * k, p.z - s.z - dz * k);
  };
  return Math.min(point(a, c, d), point(b, c, d), point(c, a, b), point(d, a, b));
}
/** 起桥路口离候选岸点的最远距离（同旧的「岸点吸附到 40 内的路点」）。 */
const CONNECT_RADIUS = 40;
/** 堤道与起点路口上任何一条路的最小夹角（同画路工具的锐角下限：小于它桥头会压在路上）。 */
const CONNECT_MIN_ANGLE = (50 * Math.PI) / 180;
/** 顺接：起点路口上至少有一条路与堤道几乎成一直线（来路方向偏差不超过它）。体检的桥头斜接判据是 45°
 *  （planGeometry.bridgeheadDefects：下桥最顺的一条路也要转 > 45° 即报错），这里留 5° 余量。
 *  曾允许从支路中间垂直起桥：试驾在岸端 no-surface（7/2、42/1），体检也会把它报成斜接坏桥。 */
const STRAIGHT_ON = (40 * Math.PI) / 180;

/**
 * 布局期机场（cityLayout 在生长剪枝之后调用——堤道必须挂在最终显示的路网上，否则起点那段支路可能被剪掉、桥悬空）：
 * 选址同渲染期旧口径（避港口 / 歌剧院 / 海滨景观段，平台全在水里），另要求堤道能从一个**路口**起桥、直线到平台落点
 * 不压别的路和地标：离桥头 8 以外，与任何非本路口的路段间隙 ≥ 两者半宽 + 1.5；与本路口其它路的夹角 ≥ 50°。
 * 接得上就把堤道作为一段桥面（bridge / deck）加进路网——普通桥梁渲染器画桥面、护栏、桥墩，驾驶面把它编成桥，
 * 平台端落到机场平台（surface/landmarkPlatforms）。不改入参数组。
 */
export function layoutAirport(input: {
  coast: Vec2[]; core: Vec2; roadEdges: readonly LayoutRoadEdge[]; roadNodes: readonly LayoutRoadNode[];
  publicSites: readonly (LayoutSite & { kind: string })[]; landmarks: readonly (LayoutSite & { kind: string })[];
  seasideWaterlines: Vec2[]; isWater: (x: number, z: number) => boolean;
}): { airport: AirportPlan | null; roadEdges: LayoutRoadEdge[]; roadNodes: LayoutRoadNode[] } {
  const avoid = [...input.publicSites.filter((x) => x.kind === "harbor"), ...input.landmarks.filter((x) => x.kind === "sail-opera"), ...input.seasideWaterlines];
  const ground = input.roadEdges.filter((e) => !e.bridge && e.structure !== "deck");
  const degree = new Map<string, number>();
  for (const e of ground) for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const half = AIRPORT_CAUSEWAY_WIDTH / 2;
  const obstacles = [...input.publicSites, ...input.landmarks].filter((s) => (s.radius ?? 0) > 0);
  const byNode = new Map<string, LayoutRoadEdge[]>();
  for (const e of input.roadEdges) {
    const from = byNode.get(e.from); if (from) from.push(e); else byNode.set(e.from, [e]);
    const to = byNode.get(e.to); if (to) to.push(e); else byNode.set(e.to, [e]);
  }
  // Causeway-vs-road tests used to scan every edge. Bin segments so a candidate
  // only looks at nearby carriageways; AABB pad is the exact clearance radius.
  const CELL = 40;
  const segs: Array<{ a: Vec2; b: Vec2; pad: number; from: string; to: string; minX: number; maxX: number; minZ: number; maxZ: number }> = [];
  const cells = new Map<string, number[]>();
  for (const e of input.roadEdges) {
    if (e.points.length < 2) continue;
    const pad = half + e.width / 2 + 1.5;
    for (let i = 1; i < e.points.length; i += 1) {
      const a = e.points[i - 1], b = e.points[i];
      const minX = Math.min(a.x, b.x) - pad, maxX = Math.max(a.x, b.x) + pad;
      const minZ = Math.min(a.z, b.z) - pad, maxZ = Math.max(a.z, b.z) + pad;
      const index = segs.length;
      segs.push({ a, b, pad, from: e.from, to: e.to, minX, maxX, minZ, maxZ });
      for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx += 1)
        for (let gz = Math.floor(minZ / CELL); gz <= Math.floor(maxZ / CELL); gz += 1) {
          const key = `${gx}:${gz}`;
          const list = cells.get(key);
          if (list) list.push(index); else cells.set(key, [index]);
        }
    }
  }
  const causewayBlocked = (start: Vec2, end: Vec2, nodeId: string) => {
    const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x);
    const minZ = Math.min(start.z, end.z), maxZ = Math.max(start.z, end.z);
    const seen = new Set<number>();
    for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx += 1)
      for (let gz = Math.floor(minZ / CELL); gz <= Math.floor(maxZ / CELL); gz += 1) {
        for (const index of cells.get(`${gx}:${gz}`) ?? []) {
          if (seen.has(index)) continue;
          seen.add(index);
          const seg = segs[index];
          if (seg.from === nodeId || seg.to === nodeId) continue;
          if (seg.maxX < minX || seg.minX > maxX || seg.maxZ < minZ || seg.minZ > maxZ) continue;
          if (segmentGap(start, end, seg.a, seg.b) < seg.pad) return true;
        }
      }
    return obstacles.some((s) => segmentGap(start, end, s, s) < (s.radius ?? 0) + half);
  };
  const connect: AirportCausewayConnector = (shorePoint, end) => {
    const nodes = input.roadNodes.filter((n) => degree.has(n.id) && Math.hypot(n.x - shorePoint.x, n.z - shorePoint.z) <= CONNECT_RADIUS)
      .sort((a, b) => Math.hypot(a.x - shorePoint.x, a.z - shorePoint.z) - Math.hypot(b.x - shorePoint.x, b.z - shorePoint.z) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let best: { node: LayoutRoadNode; skew: number } | null = null;
    for (const node of nodes) {
      const len = Math.hypot(end.x - node.x, end.z - node.z); if (len < 20) continue;
      const ux = (end.x - node.x) / len, uz = (end.z - node.z) / len;
      const incident = byNode.get(node.id) ?? [];
      if (incident.some((e) => e.bridge || e.structure === "deck")) continue;
      // 每条路离开路口的方向与「上桥方向 u」/「下桥方向 −u」的夹角：
      const angles = incident.map((e) => {
        const pts = e.from === node.id ? e.points : [...e.points].reverse(); const n = pts[1]; const l = Math.hypot(n.x - node.x, n.z - node.z) || 1;
        return Math.acos(Math.max(-1, Math.min(1, ((n.x - node.x) * ux + (n.z - node.z) * uz) / l)));
      });
      if (angles.some((a) => a < CONNECT_MIN_ANGLE)) continue;               // 有路压在桥上
      const skew = Math.min(...angles.map((a) => Math.PI - a));               // 最顺的那条来路偏多少
      if (skew > STRAIGHT_ON) continue;                                       // 没有顺接的来路：下桥得急转
      const start = { x: node.x + ux * 8, z: node.z + uz * 8 };
      if (!causewayBlocked(start, end, node.id) && (!best || skew < best.skew - 1e-9)) best = { node, skew };
    }
    return best ? { at: { x: best.node.x, z: best.node.z }, nodeId: best.node.id } : null;
  };
  const airport = planAirport(input.coast, input.core, avoid, roadSamples(input.roadEdges as LayoutRoadEdge[]), input.isWater, connect);
  if (!airport?.causeway) return { airport, roadEdges: [...input.roadEdges], roadNodes: [...input.roadNodes] };
  const to = { x: q2(airport.causeway.to.x), z: q2(airport.causeway.to.z) };
  const toId = `${to.x}:${to.z}`;
  const fromId = airport.causeway.fromNode; const from = { x: airport.causeway.from.x, z: airport.causeway.from.z };
  const width = Math.max(AIRPORT_CAUSEWAY_WIDTH, ...ground.filter((e) => e.from === fromId || e.to === fromId).map((e) => e.width));
  const edge: LayoutRoadEdge = { id: `${fromId}/${toId}`, from: fromId, to: toId, width, kind: kindOfWidth(width), points: [from, to], bridge: true, structure: "deck" };
  return { airport: { ...airport, causeway: { ...airport.causeway, to } }, roadEdges: [...input.roadEdges, edge], roadNodes: [...input.roadNodes, { ...to, id: toId }] };
}
