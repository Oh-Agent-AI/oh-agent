/**
 * 桥头落地环（bridge landing circle，2026-10-08 E 轨）：桥的地面端方向失配
 * （桥轴向与接地路向夹角 > 25°）或接地路缺失/面临被删风险时，在桥头插入半径 10–14 的落地环——
 * 桥面端点落在环上、接地路接入环，环形吸收方向差。治病目标（实测）：bridgeheadContinuity
 * 普查残留 t1 8/60（桥头悬空：路端与桥头擦肩不并点 0.1–1.6、或接地链被 solve 的
 * pruneShortSpurs 删除——其 deg 只数地面边，桥头「桥+1 地面边」被当断头）；堤道切向错位
 * （用户截图 ③：悬索桥/歌剧院堤道引道悬空）。
 *
 * 几何形态（offset-circle）：环心 O = 桥头 C + r·w，w 取所有桥轴向的「背侧」可行半平面内的
 * 确定方向（先 −normalize(Σ桥轴)，退化时 72 方向扫描）——桥头 C 恰在环上、桥沿半径方向离环，
 * 环面朝陆侧鼓出。桥边一律不动（bridges 注册表、悬索桥装饰选址 withBridgeLandmark、
 * nearBridgeEnd 桥头避让全部保持兼容）。
 *
 * 拓扑批（事务提交，§4.3 口径）：接地边拆边（穿环道路在环缘交点处裁断，外段属性继承重接，
 * 道路经环连通）+ 4–6 段弧边（锚点按角度排序，>90° 角隙补填充点；相邻环节点内角 ≥ 90°，
 * 锚点处入边与弧的最小角隙 ≥ 30°——acuteJunctions 同判据，不新增锐角路口）。弧段过地面走廊
 * （逐 4 单位采样：水/用地 0.7r——桥头河岸带的 buildable/坡度豁免沿用 bridge-candidate 历史口径，
 * TerrainPatch 批次前的已知豁免；用地按 0.7r + 半采样步取保守下界，保证精确距离口径的
 * roadThroughSite 不因采样盲区新增违例）。锚点合并（重合或角隙 <10° 并到先者）时被并锚点
 * 的关联边端点改接到幸存锚（mergeInto 重写，不悬空）；桥头锚不并出（环必须经过桥头，
 * 否则桥头只剩桥边）；仅剩桥头一个锚时构成整环（近失误擦肩的落地形态）。确定性：无随机、
 * 无墙钟；桥头/边/锚点/候选全部按稳定 id 或角度排序，半径按固定序 [12,10,14] 取首个全检
 * 通过者；任一半径失败零副作用，全部失败如实 declined（不建「通向虚无的环」冒充连续——
 * 真无地可接时让约束违例如实可见）。
 */
import { atLeast, roadWidthFor } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import { roadNodeId } from "../roadGeometry";
import type { RoadEdge, Vec2 } from "../cityLayout";
import { commitNetworkPatch, keyOf, type Network, type NetworkPatch } from "./network";
import { crosses } from "./footprint";
import type { Geography } from "./geography";

/** 版本化配置（设计 §6.3：参数实测后锁入版本化配置，禁散落默认数值）。 */
export const LANDING_CONFIG = {
  version: 1,
  radii: [12, 10, 14] as const, // 尝试顺序固定（确定性）：名义 12 → 收 10 → 放 14
  mismatchDeg: 25,              // 桥轴向与接地路向夹角阈值（切向连续性口径，|dot| 折算 0–90°）
  maxArcGapDeg: 90,             // 相邻环节点最大角隙：超过补填充点（保证环节点内角 ≥ 90°）
  minArcs: 4, maxArcs: 6,       // 环边数区间（任务口径：4–6 段弧边）
  captureReach: 26,             // 缺接地路时的捕获半径：环缘外 ≤26 的最近地面路以接杆并入（实测残端 25–26 需要此档）
  anchorMergeDeg: 10,           // 角隙 <10° 的锚点并到先者（避免碎弧）
  siteClearanceRatio: 0.7,      // 弧/接杆离用地中心 ≥ 0.7×radius（roadThroughSite 同口径，不新造压路）
  riskChainMax: 60,             // 「接地路缺失风险」：唯一地面边 + 窄短悬挂链 <60（pruneShortSpurs 同判据）
  sampleSpacing: 4,             // 弧段走廊采样步长（corridorFailure 同步长，不含端点——门口常在水线上）
  endpointSnap: 2,              // 捕获/拆点离宿主端点 <2 时吸附端点（不留碎段）
  minJunctionGapDeg: 30,        // 新增/改写路口的最小角隙（acuteJunctions 同判据；仅要求不比补丁前更差）
};

export type LandingWorld = {
  network: Network;
  geo: Geography;
  inRiver: (x: number, z: number) => boolean;
  /** 预留地（publicSites + landmarks）：弧段/接杆的用地避让。 */
  sites: () => Array<{ x: number; z: number; radius: number }>;
  /** 车流折线（可选）：被车流走过的链不会被 pruneShortSpurs 删，不算「缺失风险」。 */
  carPaths?: Vec2[][];
  /** 不可动节点（可选）：高架出口落在这些节点上。删除与之相连的边或删除节点本身的落地环一律放弃——
   *  0/42（seed 42 tier 1 Miami）的落地环曾删掉高架 to 端所在的路，出口离最近的路中线 2.29，路缘穿过落地区。 */
  pinned?: ReadonlySet<string>;
};

export type LandingReport = {
  built: number;
  rings: Array<{ center: Vec2; radius: number; node: string }>;
  /** 本次提交新增的地面边（供调用方清理落在环上的树）。 */
  addedEdges: Array<{ a: Vec2; b: Vec2; width: number }>;
  declined: Array<{ node: string; reason: string }>;
};

type AddEdge = NetworkPatch["addEdges"][number];
type Anchor = { p: Vec2; angle: number };

/** 节点的邻接边表（按边 id 排序，确定性；提交后由调用方以 network.edges.has 复核存活）。 */
function incidentMap(network: Network): Map<string, RoadEdge[]> {
  const map = new Map<string, RoadEdge[]>();
  for (const edge of [...network.edges.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const id of [edge.from, edge.to]) {
      const list = map.get(id);
      if (list) list.push(edge); else map.set(id, [edge]);
    }
  }
  return map;
}

const otherPoint = (network: Network, edge: RoadEdge, id: string): Vec2 | null => {
  if (edge.from === id) return network.nodes.get(edge.to) ?? null;
  if (edge.to === id) return network.nodes.get(edge.from) ?? null;
  return null;
};

const edgeLength = (e: RoadEdge) => Math.hypot(e.points[1].x - e.points[0].x, e.points[1].z - e.points[0].z);

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x; const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

/** 节点处 ≥3 条关联边的最小角隙（acuteJunctions 同判据；不足 3 条返回 null，不参与校验）。 */
function minAngleGap(network: Network, id: string): number | null {
  const node = network.nodes.get(id);
  if (!node) return null;
  const incident = [...network.edges.values()].filter((e) => e.from === id || e.to === id);
  if (incident.length < 3) return null;
  const angles = incident
    .map((e) => { const far = e.from === id ? e.points[1] : e.points[0]; return Math.atan2(far.z - node.z, far.x - node.x); })
    .sort((a, b) => a - b);
  let gap = Infinity;
  for (let k = 0; k < angles.length; k += 1) gap = Math.min(gap, (k + 1 < angles.length ? angles[k + 1] : angles[0] + Math.PI * 2) - angles[k]);
  return gap;
}

/** 连通分量数（草稿校验：环不得切断路网——被裁的内侧残段必须仍经环连通）。 */
function componentCount(network: Network): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let c = x; while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
  for (const id of network.nodes.keys()) if (!parent.has(id)) parent.set(id, id);
  for (const edge of network.edges.values()) {
    const ra = find(edge.from); const rb = find(edge.to);
    if (ra !== rb) parent.set(ra, rb);
  }
  return new Set([...network.nodes.keys()].map(find)).size;
}

/** 「接地路缺失风险」：桥头恰有一条地面边（调用方已保证），沿地面图的悬挂链
 *  窄（宽 <12）、短（合计 <60）、尽头是分岔路口（≥3 地面度），且链上没有用地门前路
 *  （keepsSiteDoors 同口径：链边是某用地 ≤r+20 内唯一非桥路则 prune 不删）、没有被车流
 *  折线走过——与 pruneShortSpurs 的可删判据同口径（其 deg 只数地面边、桥不计入，故
 *  「桥+1 地面边」的桥头正是它的删除起点）。 */
function groundChainAtRisk(world: LandingWorld, incident: Map<string, RoadEdge[]>, headId: string): boolean {
  const { network } = world;
  const sites = world.sites();
  let cursor = headId; let prev: RoadEdge | null = null; let length = 0;
  for (let step = 0; step < 12; step += 1) {
    const forward = (incident.get(cursor) ?? []).filter((e) => !e.bridge && network.edges.has(e.id) && e !== prev);
    if (!forward.length) return false; // 链尾断头：pruneShortSpurs 要求尽头 ≥3 地面度才整链删除
    if (forward.length > 1) return true; // 分岔路口：链到此为止，前面的链满足可删形状
    const next = forward[0];
    if (atLeast(next, "arterial")) return false;
    length += edgeLength(next);
    if (length >= LANDING_CONFIG.riskChainMax) return false;
    const mid = { x: (next.points[0].x + next.points[1].x) / 2, z: (next.points[0].z + next.points[1].z) / 2 };
    for (const s of sites) {
      if (segmentDistance(s, next.points[0], next.points[1]) >= s.radius + 20 && Math.hypot(mid.x - s.x, mid.z - s.z) >= s.radius + 20) continue;
      let hasOtherDoor = false; // keepsSiteDoors 同判据：链边之外还有别的门前路（≤r+20）才可删
      for (const e of network.edges.values()) {
        if (e.bridge || e === next) continue;
        if (segmentDistance(s, e.points[0], e.points[1]) < s.radius + 20) { hasOtherDoor = true; break; }
      }
      if (!hasOtherDoor) return false;
    }
    if (world.carPaths?.some((path) => { for (let i = 1; i < path.length; i += 1) if (segmentDistance(mid, path[i - 1], path[i]) < 0.3) return true; return false; })) return false;
    prev = next; cursor = next.from === cursor ? next.to : next.from;
  }
  return false;
}

/** 弧/接杆走廊（不含端点采样）：水（height ≤0.5 或河内）与用地 0.7r（+ 半步长的保守余量：
 *  采样间距内真最近距离可比采样值近 ≤2，roadThroughSite 用精确距离，0.7r+2 保证不越 0.7r 线）。 */
function segmentBlocked(world: LandingWorld, a: Vec2, b: Vec2): string | null {
  const distance = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(distance / LANDING_CONFIG.sampleSpacing));
  const sites = world.sites();
  for (let i = 1; i < steps; i += 1) {
    const p = { x: a.x + (b.x - a.x) * i / steps, z: a.z + (b.z - a.z) * i / steps };
    if (world.geo.height(p.x, p.z) <= 0.5 || world.inRiver(p.x, p.z)) return "water-span";
    for (const s of sites) if (Math.hypot(p.x - s.x, p.z - s.z) < s.radius * LANDING_CONFIG.siteClearanceRatio + LANDING_CONFIG.sampleSpacing / 2) return "site-clearance";
  }
  return null;
}

/** 线段与圆的交点（参数 t 升序；t 贴端 0/1 处不算——贴端情形由 endpointSnap 吸附处理）。 */
function circleCrossings(a: Vec2, b: Vec2, o: Vec2, r: number): Vec2[] {
  const dx = b.x - a.x; const dz = b.z - a.z;
  const fx = a.x - o.x; const fz = a.z - o.z;
  const qa = dx * dx + dz * dz; const qb = 2 * (fx * dx + fz * dz); const qc = fx * fx + fz * fz - r * r;
  if (qa < 1e-9) return [];
  const disc = qb * qb - 4 * qa * qc;
  if (disc <= 0) return [];
  const sq = Math.sqrt(disc);
  const out: Vec2[] = [];
  for (const t of [(-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa)]) {
    if (t <= 0.01 || t >= 0.99) continue;
    out.push({ x: a.x + dx * t, z: a.z + dz * t });
  }
  return out;
}

/** 环心方向可行性：所有桥轴向 û 需满足 û·w ≤ −0.05（桥从桥头出发即离环而去，不穿环岛）。 */
function centroidFeasible(axes: Vec2[], w: Vec2): boolean {
  return axes.every((u) => u.x * w.x + u.z * w.z <= -0.05);
}

/**
 * 桥头落地环一遍（桥全部生成、断头收尾之后，solve 之前）：对每个桥端评估
 * 失配（>25°）/ 缺失 / 可删风险，建环或如实 declined。返回报告（含新增地面边供清树）。
 */
export function buildLandingCircles(world: LandingWorld): LandingReport {
  const { network } = world;
  const report: LandingReport = { built: 0, rings: [], addedEdges: [], declined: [] };
  const incident = incidentMap(network);
  const heads = [...new Set([...network.edges.values()].filter((e) => e.bridge).flatMap((e) => [e.from, e.to]))].sort();
  const mismatchCos = Math.cos((LANDING_CONFIG.mismatchDeg * Math.PI) / 180);
  for (const headId of heads) {
    const node = network.nodes.get(headId);
    if (!node) continue;
    const atHead = (incident.get(headId) ?? []).filter((e) => network.edges.has(e.id));
    const bridgesInc = atHead.filter((e) => e.bridge);
    const grounds = atHead.filter((e) => !e.bridge);
    if (!bridgesInc.length) continue;
    // 触发判据：接地路缺失 / 方向失配 >25°（|dot| 折算，直线穿越亦算对齐）/ 唯一地面边可被 solve 删除。
    const missing = grounds.length === 0;
    let mismatch = false;
    if (grounds.length) {
      let best = -1;
      for (const b of bridgesInc) {
        const f = otherPoint(network, b, headId);
        if (!f) continue;
        const bl = Math.hypot(f.x - node.x, f.z - node.z) || 1;
        const bu = { x: (f.x - node.x) / bl, z: (f.z - node.z) / bl };
        for (const g of grounds) {
          const gp = otherPoint(network, g, headId);
          if (!gp) continue;
          const gl = Math.hypot(gp.x - node.x, gp.z - node.z) || 1;
          const dot = Math.abs(bu.x * (gp.x - node.x) / gl + bu.z * (gp.z - node.z) / gl);
          if (dot > best) best = dot;
        }
      }
      mismatch = best >= 0 && best < mismatchCos;
    }
    const atRisk = grounds.length === 1 && groundChainAtRisk(world, incident, headId);
    if (!missing && !mismatch && !atRisk) continue;
    const axes: Vec2[] = [];
    for (const b of bridgesInc) {
      const f = otherPoint(network, b, headId);
      if (!f) continue;
      const l = Math.hypot(f.x - node.x, f.z - node.z) || 1;
      axes.push({ x: (f.x - node.x) / l, z: (f.z - node.z) / l });
    }
    // 环心方向序（确定）：主方向 −normalize(Σû)（环居桥簇背侧）；全部半径不成时按 72 方向扫描
    // 依次尝试可行者——堤道/贴岸桥头的背侧常在水上或正压接地路，环需要让到侧向。
    const wCandidates: Vec2[] = [];
    {
      let sx = 0; let sz = 0;
      for (const u of axes) { sx += u.x; sz += u.z; }
      const sum = Math.hypot(sx, sz);
      if (sum >= 0.2) {
        const w = { x: -sx / sum, z: -sz / sum };
        if (centroidFeasible(axes, w)) wCandidates.push(w);
      }
      for (let k = 0; k < 72; k += 1) {
        const a = (k / 72) * Math.PI * 2;
        const w = { x: Math.cos(a), z: Math.sin(a) };
        if (centroidFeasible(axes, w) && !wCandidates.some((q) => Math.abs(q.x - w.x) + Math.abs(q.z - w.z) < 1e-9)) wCandidates.push(w);
      }
    }
    if (!wCandidates.length) { report.declined.push({ node: headId, reason: "centroid-infeasible" }); continue; }
    let lastReason = "no-radius";
    placement: for (const w of wCandidates) for (const radius of LANDING_CONFIG.radii) {
      const o = { x: node.x + radius * w.x, z: node.z + radius * w.z };
      // 与本遍已建环保持圆盘分离（否则互相捕获/穿越，几何无解）。
      if (report.rings.some((ring) => Math.hypot(ring.center.x - o.x, ring.center.z - o.z) < ring.radius + radius + 4)) { lastReason = "ring-overlap"; continue; }
      const removeIds: string[] = [];
      const splits: NetworkPatch["splits"] = [];
      const adds: AddEdge[] = [];
      const anchors: Anchor[] = [{ p: keyOf(node), angle: Math.atan2(node.z - o.z, node.x - o.x) }];
      let failed: string | null = null;
      // 接地边径向重锚：端点从桥头挪到环缘（沿环心→对端射线，不入盘、不穿弧）；
      // 对端已在环缘 ±2 的原边即弦接入（不动）；对端陷进环内则该边作为被环吞并的首段裁除——
      // 对端的延续边（穿环缘）由下方捕获档接到环缘，纯死端由合并残点清除；因此断连的形状由
      // 草稿校验 disconnect 如实拒绝本 (w, r)。
      const touched = new Set<string>();
      for (const g of grounds) {
        touched.add(g.id);
        const gp = otherPoint(network, g, headId);
        if (!gp) continue;
        const d = Math.hypot(gp.x - o.x, gp.z - o.z);
        if (d >= radius + 2) {
          const p = keyOf({ x: o.x + ((gp.x - o.x) / d) * radius, z: o.z + ((gp.z - o.z) / d) * radius });
          if (roadNodeId(p) !== headId) {
            removeIds.push(g.id);
            adds.push({ a: p, b: keyOf(gp), arterial: g.kind === "arterial", primary: atLeast(g, "arterial") });
            anchors.push({ p, angle: Math.atan2(p.z - o.z, p.x - o.x) });
          } // 重锚点即桥头（对端在环心延长线上）：边不动，锚就是桥头
        } else if (d >= radius - 2) {
          anchors.push({ p: keyOf(gp), angle: Math.atan2(gp.z - o.z, gp.x - o.x) });
        } else {
          removeIds.push(g.id);
        }
      }
      // 穿环道路捕获：环缘交点（贴宿主端点 <2 吸附端点）裁断宿主，外段属性继承重接、经环连通；
      // 缺接地路时另以接杆捕获环缘外 ≤14 的最近地面路（中段垂足拆边成 T 口，贴端点则直连端点）。
      const spokeCandidates: Array<{ edge: RoadEdge; d: number; q: Vec2 }> = [];
      const groundEdges = [...network.edges.values()].filter((e) => !e.bridge && !touched.has(e.id) && e.from !== headId && e.to !== headId).sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const host of groundEdges) {
        const [a, b] = host.points;
        const d = segmentDistance(o, a, b);
        if (d < radius - 0.5) {
          const aIn = Math.hypot(a.x - o.x, a.z - o.z) < radius - 0.5;
          const bIn = Math.hypot(b.x - o.x, b.z - o.z) < radius - 0.5;
          if (aIn && bIn) { failed = "edge-inside"; break; }
          const snapped = circleCrossings(a, b, o, radius).map((p) =>
            Math.hypot(p.x - a.x, p.z - a.z) <= LANDING_CONFIG.endpointSnap ? a
              : Math.hypot(p.x - b.x, p.z - b.z) <= LANDING_CONFIG.endpointSnap ? b : p);
          const bounds: Vec2[] = [];
          for (const p of snapped) if (!bounds.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 1)) bounds.push(p);
          if (!bounds.length) { failed = "edge-inside"; break; }
          removeIds.push(host.id);
          if (!aIn) adds.push({ a: keyOf(a), b: keyOf(bounds[0]), arterial: host.kind === "arterial", primary: atLeast(host, "arterial") });
          if (!bIn) adds.push({ a: keyOf(bounds[bounds.length - 1]), b: keyOf(b), arterial: host.kind === "arterial", primary: atLeast(host, "arterial") });
          for (const p of bounds) anchors.push({ p: keyOf(p), angle: Math.atan2(p.z - o.z, p.x - o.x) });
        } else if (missing && d <= radius + LANDING_CONFIG.captureReach) {
          const dx = b.x - a.x; const dz = b.z - a.z; const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((o.x - a.x) * dx + (o.z - a.z) * dz) / l2));
          spokeCandidates.push({ edge: host, d, q: { x: a.x + dx * t, z: a.z + dz * t } });
        }
      }
      if (failed) { lastReason = failed; continue; }
      if (missing) {
        spokeCandidates.sort((x, y) => x.d - y.d || (x.edge.id < y.edge.id ? -1 : 1));
        const pick = spokeCandidates[0];
        if (!pick) { lastReason = "no-ground-reach"; continue; }
        const [a, b] = pick.edge.points;
        const nearEnd = Math.hypot(pick.q.x - a.x, pick.q.z - a.z) <= LANDING_CONFIG.endpointSnap ? keyOf(a)
          : Math.hypot(pick.q.x - b.x, pick.q.z - b.z) <= LANDING_CONFIG.endpointSnap ? keyOf(b) : null;
        const p = keyOf({ x: o.x + ((pick.q.x - o.x) / pick.d) * radius, z: o.z + ((pick.q.z - o.z) / pick.d) * radius });
        // 近失误擦肩（接地端点贴着桥头、环缘点即桥头）：接杆从桥头出发只会与桥轴成锐角——
        // 改把宿主边端点重锚到桥头（0.x–2 的并点），桥头即刻接地；环照建（吸收方向差 + 防 spur 删除）。
        if (nearEnd && Math.hypot(p.x - node.x, p.z - node.z) < LANDING_CONFIG.endpointSnap) {
          const far = roadNodeId(nearEnd) === roadNodeId(keyOf(a)) ? keyOf(b) : keyOf(a);
          removeIds.push(pick.edge.id);
          adds.push({ a: keyOf(node), b: far, arterial: pick.edge.kind === "arterial", primary: atLeast(pick.edge, "arterial") });
        } else if (nearEnd) {
          adds.push({ a: p, b: nearEnd, arterial: false, primary: false });
          anchors.push({ p, angle: Math.atan2(p.z - o.z, p.x - o.x) });
        } else {
          splits.push({ edgeId: pick.edge.id, at: pick.q });
          adds.push({ a: p, b: keyOf(pick.q), arterial: false, primary: false });
          anchors.push({ p, angle: Math.atan2(p.z - o.z, p.x - o.x) });
        }
      }
      // 锚点去重/合并（重合或角隙 <10° 并到先者；桥头锚不并出——环必须经过桥头，否则桥头只剩桥边）。
      // 被并锚点记入 mergeInto：其关联边端点改接到幸存锚（捕获外段/接杆不悬在非环点上）。
      anchors.sort((x, y) => x.angle - y.angle || (roadNodeId(x.p) < roadNodeId(y.p) ? -1 : 1));
      const headAnchor = anchors.find((a) => roadNodeId(a.p) === headId) ?? null;
      const merged: Anchor[] = [];
      const mergeInto = new Map<string, Vec2>();
      for (const a of anchors) {
        const prev = merged[merged.length - 1];
        const dup = !!prev && Math.hypot(a.p.x - prev.p.x, a.p.z - prev.p.z) < 1;
        const tight = !!prev && a.angle - prev.angle < (LANDING_CONFIG.anchorMergeDeg * Math.PI) / 180;
        if (a !== headAnchor && (dup || tight)) { mergeInto.set(roadNodeId(keyOf(a.p)), prev!.p); continue; }
        merged.push(a);
      }
      if (merged.length >= 2 && Math.hypot(merged[0].p.x - merged[merged.length - 1].p.x, merged[0].p.z - merged[merged.length - 1].p.z) < 1) {
        const drop = merged[merged.length - 1] === headAnchor ? merged.shift()! : merged.pop()!;
        mergeInto.set(roadNodeId(keyOf(drop.p)), merged[merged.length - 1].p);
      }
      if (merged.length < 1) { lastReason = "no-anchor"; continue; }
      // 关联边改接：端点过 mergeInto（单跳——幸存锚不会再被并掉），并锚后成自环的边丢弃。
      {
        const rerouted = (p: Vec2): Vec2 => mergeInto.get(roadNodeId(keyOf(p))) ?? p;
        const rewrite: AddEdge[] = [];
        for (const e of adds) {
          const a = rerouted(e.a); const b = rerouted(e.b);
          if (roadNodeId(keyOf(a)) === roadNodeId(keyOf(b))) continue;
          rewrite.push({ ...e, a, b });
        }
        adds.length = 0; adds.push(...rewrite);
      }
      // 角隙 → 分段数（每段 ≤90°），不足 4 段向最大角隙补；超出 4–6 段区间则本半径放弃。
      // 仅桥头一个锚时 gap = 2π：整环 4 段（近失误擦肩——接杆并到桥头锚后的落地形态）。
      const pieces: number[] = [];
      for (let i = 0; i < merged.length; i += 1) {
        const next = merged[(i + 1) % merged.length];
        let gap = next.angle - merged[i].angle;
        if (i === merged.length - 1) gap += Math.PI * 2;
        pieces.push(Math.max(1, Math.ceil(gap / ((LANDING_CONFIG.maxArcGapDeg * Math.PI) / 180))));
      }
      while (pieces.reduce((s, n) => s + n, 0) < LANDING_CONFIG.minArcs) {
        let big = 0;
        for (let i = 1; i < pieces.length; i += 1) if (pieces[i] > pieces[big]) big = i;
        pieces[big] += 1;
      }
      const total = pieces.reduce((s, n) => s + n, 0);
      if (total < LANDING_CONFIG.minArcs || total > LANDING_CONFIG.maxArcs) { lastReason = "arc-count"; continue; }
      const ring: Vec2[] = [];
      for (let i = 0; i < merged.length; i += 1) {
        const next = merged[(i + 1) % merged.length];
        let gap = next.angle - merged[i].angle;
        if (i === merged.length - 1) gap += Math.PI * 2;
        ring.push(merged[i].p);
        for (let j = 1; j < pieces[i]; j += 1) {
          const a = merged[i].angle + gap * (j / pieces[i]);
          ring.push(keyOf({ x: o.x + Math.cos(a) * radius, z: o.z + Math.sin(a) * radius }));
        }
      }
      for (let i = 0; i < ring.length; i += 1) adds.push({ a: ring[i], b: ring[(i + 1) % ring.length], arterial: false, primary: false });
      // 走廊终筛：新增地面边（弧/接杆/重锚/裁剪外段）逐段过检（水/用地 0.7r）。
      let blocked: string | null = null;
      for (const e of adds) {
        blocked = segmentBlocked(world, e.a, e.b);
        if (blocked) break;
      }
      if (blocked) { lastReason = blocked; continue; }
      // 事务提交：草稿上校验（不切断连通、不与草稿路网交叉、受影响路口角隙不恶化）→ 版本匹配 → 一次替换。
      const baseComponents = componentCount(network);
      const touchedIds = new Set<string>([headId]);
      for (const e of adds) { touchedIds.add(roadNodeId(keyOf(e.a))); touchedIds.add(roadNodeId(keyOf(e.b))); }
      for (const s of splits) {
        touchedIds.add(roadNodeId(keyOf(s.at)));
        const host = network.edges.get(s.edgeId);
        if (host) { touchedIds.add(host.from); touchedIds.add(host.to); }
      }
      // 合并残点：被删边的端点若因此再无任何关联边（且不被新边引用），随补丁一并清除——
      // 孤立节点在 componentCount 口径里是独立分量，还会被下游当作悬空引用。
      const removedSet = new Set(removeIds);
      const mergeCandidates = new Set<string>();
      for (const id of removeIds) { const dead = network.edges.get(id); if (dead) { mergeCandidates.add(dead.from); mergeCandidates.add(dead.to); } }
      const removeNodeIds: string[] = [];
      for (const id of [...mergeCandidates].sort()) {
        let live = 0;
        for (const e of network.edges.values()) if (!removedSet.has(e.id) && (e.from === id || e.to === id)) live += 1;
        if (live === 0 && !adds.some((e) => roadNodeId(keyOf(e.a)) === id || roadNodeId(keyOf(e.b)) === id)) removeNodeIds.push(id);
      }
      const pinned = world.pinned;
      if (pinned && (removeNodeIds.some((id) => pinned.has(id)) || removeIds.some((id) => { const e = network.edges.get(id); return !!e && (pinned.has(e.from) || pinned.has(e.to)); }))) {
        lastReason = "pinned-exit"; continue;
      }
      const minGap = (LANDING_CONFIG.minJunctionGapDeg * Math.PI) / 180;
      const patch: NetworkPatch = { baseVersion: network.version ?? 0, removeEdgeIds: removeIds, removeNodeIds, splits, addEdges: adds };
      const committed = commitNetworkPatch(network, patch, (draft) => {
        if (componentCount(draft) > baseComponents) return "disconnect";
        for (const e of adds) for (const other of draft.edges.values()) if (crosses(e.a, e.b, other.points[0], other.points[1])) return `crossing ${other.id}`;
        // acuteJunctions 同判据：补丁前角隙 ≥30°（或不足 3 边不判）的受影响节点，补丁后不得 <30°。
        for (const id of touchedIds) {
          const before = minAngleGap(network, id);
          if (before === null || before >= minGap) {
            const after = minAngleGap(draft, id);
            if (after !== null && after < minGap) return `acute ${id}`;
          }
        }
        // 保险：未列入 removeNodeIds 的受删端点不得在草稿里变成孤立点（计算口径外的意外形状）。
        for (const id of mergeCandidates) {
          if (removeNodeIds.includes(id)) continue;
          let any = false;
          for (const e of draft.edges.values()) if (e.from === id || e.to === id) { any = true; break; }
          if (!any && network.nodes.has(id)) return `orphan ${id}`;
        }
        return null;
      });
      if (!committed.ok) { lastReason = committed.reason === "validation" ? (committed.detail?.split(" ")[0] ?? "validation") : committed.reason; continue; }
      report.built += 1;
      report.rings.push({ center: o, radius, node: headId });
      for (const e of adds) report.addedEdges.push({ a: e.a, b: e.b, width: roadWidthFor(e.primary ? "arterial" : e.arterial ? "collector" : "local") });
      break placement;
    }
    if (!report.rings.some((ring) => ring.node === headId)) report.declined.push({ node: headId, reason: lastReason });
  }
  return report;
}
