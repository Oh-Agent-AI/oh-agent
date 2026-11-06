/**
 * 小地图「道路审计」的车流估算（2026-10-21，用户：「点击查看道路审计可以看到哪里拥堵」）。
 *
 * 这是**估算**，不是实测——城市里没有真实车流，也不跑逐车仿真（几千辆车逐帧跑，体检要等几十秒，结论还随随机种子抖）。
 * 用交通规划的标准四步法里最小的两步，结果确定、毫秒级、改一条路就能重算：
 *   1. 出行生成 + 分布：每栋楼按建筑面积产生高峰小时出行，就近挂到路口，路口按网格聚成小区（≤ MAX_ZONES 个）；
 *      小区间按重力模型分配（离得越远去得越少，exp(−d/DECAY)），每个小区出发的总量守恒。
 *   2. 交通分配：增量分配，分 SLICES 批，每批按当前拥堵后的行程时间（BPR 函数）走最短路——
 *      先走的车把主路塞起来，后面的车才会改走旁路；一次性全走自由流最短路会把所有车压在同一条路上，热点被夸大。
 * 车开不过去的路（坡比 > 0.31、斜接/陡岸桥头的桥）不进路网：车流会绕开，绕不开的出行记作「到不了」——
 * 小地图上红色的路一修好，这里的绕行和「到不了」就跟着消失，修复的效果能直接看见。
 * 高架/快速路（layout.highways）不在路口图里，不计入（图例写明）。
 */
import type { CityLayout, RoadEdge, Vec2 } from "../engine/cityLayout";

/** 拥堵档位：v/c（流量 / 通行能力）。 */
export type TrafficLevel = "free" | "busy" | "slow" | "jam";
export type TrafficEdge = { id: string; volume: number; capacity: number; vc: number; level: TrafficLevel };
export type TrafficHotspot = { id: string; at: Vec2; vc: number; volume: number; text: { zh: string; en: string } };
export type TrafficModel = {
  edges: ReadonlyMap<string, TrafficEdge>;
  hotspots: readonly TrafficHotspot[];
  /** 高峰小时出行总量与其中到不了的（起终点之间没有可通行的路）。 */
  trips: number; unreachable: number;
  counts: Record<TrafficLevel, number>;
};

/** 小区格边长下限（米）；小区数上限 MAX_ZONES——4000 楼的城市若仍按 60 m 切，几百个小区 × 4 批最短路要近一秒。 */
const ZONE = 60;
const MAX_ZONES = 110;
const DECAY = 900;
const SLICES = 4;
/** 每 100 m² 建筑面积的高峰小时出行（城市是缩尺模型：地块约 7×8 m，按真实尺度的出行率会全城畅通、什么都看不出）。
 * 校准（种子 1927 / 7）：380 楼全城畅通，1600 楼 5 段拥堵，4000 楼 74 段拥堵 + 43 段偏慢——城越大越堵，瓶颈落在主干与过河处。 */
const TRIPS_PER_100M2 = 8;
const LANE_CAPACITY = 800;
/** 分区的平均层数（地块占地 → 建筑面积）。 */
const ZONE_FLOORS = { downtown: 8, commercial: 4, waterfront: 3, residential: 2 } as const;
const LEVELS: readonly [TrafficLevel, number][] = [["jam", 1], ["slow", 0.8], ["busy", 0.5], ["free", -Infinity]];
export const trafficLevel = (vc: number): TrafficLevel => LEVELS.find(([, at]) => vc >= at)![0];

const polylineLength = (points: readonly Vec2[]) => { let s = 0; for (let i = 1; i < points.length; i += 1) s += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z); return s; };
const lanes = (edge: RoadEdge) => Math.max(1, Math.round(edge.width / 3.5));
const speed = (edge: RoadEdge) => (edge.width >= 12 ? 14 : edge.width >= 8 ? 11 : 8);

/** 二叉堆最短路：返回到每个节点的时间、前驱边与结算顺序（逆序回推即可把整棵树上的流量一次累加）。 */
function shortest(n: number, adjacency: readonly (readonly [number, number][])[], ends: readonly [number, number][], cost: Float64Array, source: number) {
  const dist = new Float64Array(n).fill(Infinity); const via = new Int32Array(n).fill(-1); const order: number[] = [];
  const heap: number[] = [source]; const key: number[] = [0]; dist[source] = 0;
  const done = new Uint8Array(n);
  while (heap.length) {
    const u = heap[0], du = key[0];
    const lastNode = heap.pop()!, lastKey = key.pop()!;
    if (heap.length) {
      let i = 0; heap[0] = lastNode; key[0] = lastKey;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && key[l] < key[m]) m = l; if (r < heap.length && key[r] < key[m]) m = r; if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]]; [key[i], key[m]] = [key[m], key[i]]; i = m; }
    }
    if (done[u] || du > dist[u]) continue;
    done[u] = 1; order.push(u);
    for (const [v, e] of adjacency[u]) {
      const nd = du + cost[e];
      if (nd < dist[v]) {
        dist[v] = nd; via[v] = e; let i = heap.length; heap.push(v); key.push(nd);
        while (i > 0) { const p = (i - 1) >> 1; if (key[p] <= key[i]) break; [heap[i], heap[p]] = [heap[p], heap[i]]; [key[i], key[p]] = [key[p], key[i]]; i = p; }
      }
    }
  }
  return { dist, via, order, ends };
}

const cache = new WeakMap<CityLayout, WeakMap<ReadonlySet<string>, TrafficModel>>();

/** blocked：车开不过去的路（与小地图路况同一判据，由调用方给出），不进路网。按（布局, blocked 集合）缓存。 */
export function trafficModel(layout: CityLayout, blocked: ReadonlySet<string>): TrafficModel {
  const hit = cache.get(layout)?.get(blocked);
  if (hit) return hit;
  const index = new Map(layout.roadNodes.map((node, i) => [node.id, i] as const));
  const nodes = layout.roadNodes;
  const usable = layout.roadEdges.filter((edge) => !blocked.has(edge.id) && index.has(edge.from) && index.has(edge.to) && edge.from !== edge.to);
  const ends = usable.map((edge) => [index.get(edge.from)!, index.get(edge.to)!] as [number, number]);
  const free = Float64Array.from(usable, (edge) => Math.max(1, polylineLength(edge.points)) / speed(edge));
  const capacity = Float64Array.from(usable, (edge) => lanes(edge) * LANE_CAPACITY);
  const adjacency: [number, number][][] = nodes.map(() => []);
  ends.forEach(([a, b], e) => { adjacency[a].push([b, e]); adjacency[b].push([a, e]); });
  // 挂着路的节点能当起终点——包括只挂着开不过去的路的节点：那里的楼照样要出行，出不去就记「到不了」；
  // 只按可通行的路选起终点，被切断的街区的出行会整个消失，看起来反而一切畅通。楼按建筑面积挂到最近的节点——网格哈希近邻。
  const touched = new Uint8Array(nodes.length);
  for (const edge of layout.roadEdges) for (const id of [edge.from, edge.to]) { const i = index.get(id); if (i !== undefined) touched[i] = 1; }
  const cell = 40; const grid = new Map<string, number[]>();
  nodes.forEach((node, i) => { if (!touched[i]) return; const k = `${Math.floor(node.x / cell)},${Math.floor(node.z / cell)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); });
  const nearest = (p: Vec2) => {
    const cx = Math.floor(p.x / cell), cz = Math.floor(p.z / cell); let best = -1, bestD = Infinity;
    for (let ring = 0; ring <= 3 && best < 0; ring += 1)
      for (let dx = -ring; dx <= ring; dx += 1) for (let dz = -ring; dz <= ring; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        for (const i of grid.get(`${cx + dx},${cz + dz}`) ?? []) { const d = Math.hypot(nodes[i].x - p.x, nodes[i].z - p.z); if (d < bestD) { bestD = d; best = i; } }
      }
    return best;
  };
  // 出行来自用地：每块已建街区的地块按占地 × 分区强度（市中心楼高、住宅楼矮）计，外围配景楼按实际建筑面积计。
  // 不读 session 楼：小地图只拿得到布局，而楼落在地块上——地块就是楼的位置与体量的上限。
  const weight = new Float64Array(nodes.length);
  const add = (p: Vec2, floorArea: number) => { const i = nearest(p); if (i >= 0) weight[i] += (floorArea / 100) * TRIPS_PER_100M2; };
  for (const block of layout.blocks) if (!block.vacant) for (const parcel of block.parcels) add(parcel, parcel.width * parcel.depth * ZONE_FLOORS[parcel.zone]);
  for (const b of layout.contextBuildings ?? []) add(b, b.width * b.depth * Math.max(1, b.height / 3.5));
  // 小区：节点按 zone 米网格聚类（格边长随城市占地放大，小区数不超过 MAX_ZONES），小区的代表点是区内出行最多的节点。
  let lo = { x: Infinity, z: Infinity }, hi = { x: -Infinity, z: -Infinity };
  nodes.forEach((node, i) => { if (weight[i]) { lo = { x: Math.min(lo.x, node.x), z: Math.min(lo.z, node.z) }; hi = { x: Math.max(hi.x, node.x), z: Math.max(hi.z, node.z) }; } });
  const zone = Math.max(ZONE, Math.sqrt(Math.max(0, (hi.x - lo.x) * (hi.z - lo.z)) / MAX_ZONES));
  const zoneOf = new Map<string, number>(); const zones: { node: number; trips: number }[] = []; const nodeZone = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((node, i) => {
    if (!weight[i]) return;
    const k = `${Math.floor(node.x / zone)},${Math.floor(node.z / zone)}`;
    let z = zoneOf.get(k); if (z === undefined) { z = zones.length; zoneOf.set(k, z); zones.push({ node: i, trips: 0 }); }
    zones[z].trips += weight[i]; nodeZone[i] = z; if (weight[i] > weight[zones[z].node]) zones[z].node = i;
  });
  const trips = zones.reduce((s, z) => s + z.trips, 0);
  // 出行分布（重力模型，出发总量守恒）：距离用直线距离——用路网距离的话，被切断的小区之间距离无穷，需求会被悄悄改写成 0，「到不了」就看不见了。
  const demand = zones.map((from) => {
    const raw = zones.map((to) => (to === from ? 0 : to.trips * Math.exp(-Math.hypot(nodes[to.node].x - nodes[from.node].x, nodes[to.node].z - nodes[from.node].z) / DECAY)));
    const sum = raw.reduce((s, v) => s + v, 0);
    return raw.map((v) => (sum > 0 ? (v / sum) * from.trips * 0.5 : 0)); // ×0.5：A→B 与 B→A 各算一半，合计即该小区的双向出行
  });
  const volume = new Float64Array(usable.length); const cost = Float64Array.from(free);
  let unreachable = 0;
  const acc = new Float64Array(nodes.length);
  for (let slice = 0; slice < SLICES; slice += 1) {
    for (let e = 0; e < usable.length; e += 1) cost[e] = free[e] * (1 + 0.15 * (volume[e] / capacity[e]) ** 4);
    zones.forEach((from, z) => {
      const tree = shortest(nodes.length, adjacency, ends, cost, from.node);
      acc.fill(0);
      zones.forEach((to, w) => { const q = demand[z][w] / SLICES; if (!q) return; if (tree.dist[to.node] === Infinity) { unreachable += q; return; } acc[to.node] += q; });
      for (let k = tree.order.length - 1; k > 0; k -= 1) {
        const v = tree.order[k]; const e = tree.via[v]; if (e < 0 || !acc[v]) continue;
        volume[e] += acc[v]; const [a, b] = ends[e]; acc[a === v ? b : a] += acc[v];
      }
    });
  }
  const edges = new Map<string, TrafficEdge>();
  const counts: Record<TrafficLevel, number> = { free: 0, busy: 0, slow: 0, jam: 0 };
  usable.forEach((edge, e) => {
    const vc = volume[e] / capacity[e]; const level = trafficLevel(vc); counts[level] += 1;
    edges.set(edge.id, { id: edge.id, volume: Math.round(volume[e]), capacity: capacity[e], vc, level });
  });
  const hotspots: TrafficHotspot[] = usable.map((edge) => ({ edge, t: edges.get(edge.id)! })).filter(({ t }) => t.vc >= 0.8)
    .sort((a, b) => b.t.vc - a.t.vc).slice(0, 8).map(({ edge, t }) => {
      const mid = edge.points[Math.floor(edge.points.length / 2)]; const a = edge.points[Math.max(0, Math.floor(edge.points.length / 2) - 1)];
      const at = edge.points.length === 2 ? { x: (edge.points[0].x + edge.points[1].x) / 2, z: (edge.points[0].z + edge.points[1].z) / 2 } : { x: (mid.x + a.x) / 2, z: (mid.z + a.z) / 2 };
      const over = Math.round((t.vc - 1) * 100);
      return { id: edge.id, at, vc: t.vc, volume: t.volume, text: t.vc >= 1
        ? { zh: `拥堵：高峰约 ${t.volume} 辆/小时，超出通行能力 ${over}%`, en: `Jammed: about ${t.volume} cars/h at peak, ${over}% over capacity` }
        : { zh: `偏慢：高峰约 ${t.volume} 辆/小时，已用到通行能力的 ${Math.round(t.vc * 100)}%`, en: `Slow: about ${t.volume} cars/h at peak, ${Math.round(t.vc * 100)}% of capacity` } };
    });
  const model: TrafficModel = { edges, hotspots, trips: Math.round(trips), unreachable: Math.round(unreachable), counts };
  const perLayout = cache.get(layout) ?? new WeakMap(); perLayout.set(blocked, model); cache.set(layout, perLayout);
  return model;
}
