/**
 * 环岛滨海路 + 河岸路（R5 第 4 道，逐字迁自 cityPlan.ts::buildPlan 的内嵌工序）。
 *
 * 读：network.edges（既有主干/海滨大道，用于避让与同级降级）、coast、core、bbox、hasRiver·riverX·riverWidth、
 *     coastDistance / landClearance / hillProj / hillLine / height / inRiver、seaside（海滨景观带避让）、
 *     reservations()（实时读 publicSites+landmarks，调用方闭包）、ringIndex（环线高架索引）。
 * 写：network.edges / network.nodes（addEdge 原地加边；对 ground-road 边写 purpose="waterfront"）。
 * 返回：coastRoadRuns（前 coastalRunCount 条是环岛滨海路，其后是河岸路）与 coastalRunCount
 *       （原先是 buildPlan 里的 const 数组与 let 计数器；数组在块内原地 push，顺序即原顺序）。
 * 不调用 random()；河岸路穿过桥头引道处用 commitNetworkPatch 拆出 T 口（见下）；不 import ../cityPlan 的运行时（R2 边界）。
 */
import { atLeast } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import { seasideStripContains, type SeasideBand } from "../citySeaside";
import type { Vec2 } from "../cityLayout";
import { roadNodeId, SegmentIndex } from "../roadGeometry";
import { addNetworkEdge, commitNetworkPatch, keyOf, type Network } from "./network";
import { classifyRoadSegments } from "./relations";

export type CoastalRingRoadWorld = {
  network: Network;
  coast: Vec2[]; bbox: { minX: number; maxX: number; minZ: number; maxZ: number };
  hasRiver: boolean; riverX: (z: number) => number; riverWidth: (z: number) => number;
  coastDistance: (x: number, z: number) => number; landClearance: (x: number, z: number) => number;
  hillProj: (x: number, z: number) => number; hillLine: number; height: (x: number, z: number) => number;
  inRiver: (x: number, z: number) => boolean;
  /** 实时读取（每次调用现取 publicSites+landmarks），不可换成快照。 */
  reservations: () => ReadonlyArray<Vec2 & { radius: number }>;
  ringIndex: SegmentIndex;
};
export type CoastalRingRoadParams = { core: Vec2; seaside: SeasideBand | null };
export type CoastalRingRoadResult = { coastRoadRuns: Vec2[][]; coastalRunCount: number };

export function buildCoastalRingRoads(env: CoastalRingRoadWorld, params: CoastalRingRoadParams): CoastalRingRoadResult {
  const { network, coast, bbox, hasRiver, riverX, riverWidth, coastDistance, landClearance, hillProj, hillLine, height, inRiver, reservations, ringIndex } = env;
  const { core, seaside } = params;
  const { edges } = network;
  const key = keyOf;
  const addEdge = (a0: Vec2, b0: Vec2, arterial: boolean, bridge = false, primary = false) => addNetworkEdge(network, a0, b0, arterial, bridge, primary);

  // ── 环岛滨海路（规划总纲 S1，Lynch「边界要被路径看见」）：沿整条海岸、离水线 22 单位一条连续道路。
  // 曾只有海滨景观那 85° 一段有大道，其余海岸没有路（真机：住宅区一直延伸到海边却没有沿海道路）。
  // 跳过：海滨景观段（已有大道）、山体、河口、岸边用地；按连续可用段成路，段端稍后接入路网。
  const COAST_ROAD_OFFSET = 22;
  const coastRoadRuns: Vec2[][] = [];
  let coastalRunCount = 0; // 之前是环岛滨海路段，之后是河岸路段（S3 滨海景观带只沿前者铺）
  {
    const existingPrimary = new SegmentIndex([...edges.values()].filter((edge) => atLeast(edge, "arterial")).map((edge) => edge.points));
    const n = coast.length;
    const offsetPoint = (i: number) => {
      const p = coast[i]; const prev = coast[(i - 1 + n) % n]; const next = coast[(i + 1) % n];
      let nx = -(next.z - prev.z); let nz = next.x - prev.x; const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
      if (nx * (core.x - p.x) + nz * (core.z - p.z) < 0) { nx = -nx; nz = -nz; }
      return { x: p.x + nx * COAST_ROAD_OFFSET, z: p.z + nz * COAST_ROAD_OFFSET };
    };
    const usable = (q: Vec2) => coastDistance(q.x, q.z) > 10 && !inRiver(q.x, q.z) && landClearance(q.x, q.z) > 10
      && hillProj(q.x, q.z) < hillLine - 12 && height(q.x, q.z) < 6
      && !(seaside && seasideStripContains(seaside, q, 6))
      && !reservations().some((site) => Math.hypot(q.x - site.x, q.z - site.z) < site.radius + 8)
      && !ringIndex.closerThan(q, 10)
      && !existingPrimary.closerThan(q, 26); // 已有主干道/海滨大道经过的岸段不再并排修一条
    const pts = Array.from({ length: n }, (_, i) => offsetPoint(i));
    const ok = pts.map(usable);
    // 从一个不可用点开始绕一圈，切出连续段（全可用时就是闭环）。
    const start = ok.indexOf(false);
    let current: Vec2[] = [];
    for (let k = 0; k <= n; k += 1) {
      const i = start < 0 ? k % n : (start + k) % n;
      const a = current[current.length - 1];
      const chordOk = !a || [0.25, 0.5, 0.75].every((t) => usable({ x: a.x + (pts[i].x - a.x) * t, z: a.z + (pts[i].z - a.z) * t }));
      if (ok[i] && chordOk) current.push(pts[i]);
      else { if (current.length >= 3) coastRoadRuns.push(current); current = ok[i] ? [pts[i]] : []; }
    }
    if (current.length >= 3) coastRoadRuns.push(current);
    // ── 河岸路（规划总纲 S2）：河是城市的另一条「边界」，两岸各一条沿河道路（离河道边缘 14），
    // 遇主干道/桥头/预留地断开，段端稍后以 T 路口接入。与环岛滨海路共用一套接入、避让与街网退让逻辑。
    coastalRunCount = coastRoadRuns.length;
    if (hasRiver) {
      // 只有与岸线大致平行的既有主干道才挡河岸路（避免两条主干道贴着并排）。垂直穿过岸线的主干道——主要是跨湾桥的引道——
      // 曾同样被当成「已有主干道」：岸路在每个桥头两侧各丢两三个采样点、断出 80–90 的口子，再由街网在内陆绕一个 V 字接回来
      // （用户截图「这个主干道为什么不直接连起来」）。现在它们不挡路，岸路在交叉处与引道做 T 口（见下方 joinCrossings）。
      const arterialSegments = [...edges.values()].filter((edge) => atLeast(edge, "collector") && !edge.bridge)
        .flatMap((edge) => edge.points.slice(1).map((b, k) => ({ a: edge.points[k], b })));
      const PARALLEL_COS = Math.cos((50 * Math.PI) / 180);
      const bankDirection = (z: number) => { const dx = riverX(z + 10) - riverX(z - 10); const l = Math.hypot(dx, 20); return { x: dx / l, z: 20 / l }; };
      const parallelArterialNear = (q: Vec2, radius: number) => {
        const d = bankDirection(q.z);
        return arterialSegments.some(({ a, b }) => {
          const ux = b.x - a.x, uz = b.z - a.z, l2 = ux * ux + uz * uz; if (l2 < 1e-9) return false;
          const t = Math.max(0, Math.min(1, ((q.x - a.x) * ux + (q.z - a.z) * uz) / l2));
          if (Math.hypot(q.x - a.x - ux * t, q.z - a.z - uz * t) >= radius) return false;
          return Math.abs(ux * d.x + uz * d.z) / Math.sqrt(l2) > PARALLEL_COS;
        });
      };
      // Coastal candidates are accepted before publication into edges. River
      // planning must see those actual planned corridors too, not a stale
      // network-only reservation snapshot that permits a second width12 road.
      const plannedCoastalArterial = new SegmentIndex(coastRoadRuns.slice(0, coastalRunCount));
      const riverUsable = (q: Vec2) => coastDistance(q.x, q.z) > 14 && !inRiver(q.x, q.z) && landClearance(q.x, q.z) > 8
        && hillProj(q.x, q.z) < hillLine - 12 && height(q.x, q.z) < 6
        && !(seaside && seasideStripContains(seaside, q, 6))
        && !reservations().some((site) => Math.hypot(q.x - site.x, q.z - site.z) < site.radius + 8)
        // 不再避让环线高架：高架是架空的，河岸路从桥下穿过（曾在高架两侧各断一截，真机截图「道路缺少连接」）。
        && !parallelArterialNear(q, 28) && !plannedCoastalArterial.closerThan(q, 28); // 28 > 规划守卫的「拥挤」阈值 25
      for (const side of [-1, 1]) {
        let runPts: Vec2[] = [];
        for (let z = bbox.minZ; z <= bbox.maxZ; z += 20) {
          const q = { x: riverX(z) + side * (riverWidth(z) + 14), z };
          const last = runPts[runPts.length - 1];
          // <=4 spacing plus the existing 3-unit separation margin prevents
          // an unsampled chord interior from approaching a reserved coast road.
          const steps = last ? Math.max(1, Math.ceil(Math.hypot(q.x - last.x, q.z - last.z) / 4)) : 1;
          const chordOk = !last || Array.from({ length: steps - 1 }, (_, k) => (k + 1) / steps)
            .every((t) => riverUsable({ x: last.x + (q.x - last.x) * t, z: last.z + (q.z - last.z) * t }));
          if (riverUsable(q) && chordOk) runPts.push(q);
          else { if (runPts.length >= 3) coastRoadRuns.push(runPts); runPts = riverUsable(q) ? [q] : []; }
        }
        if (runPts.length >= 3) coastRoadRuns.push(runPts);
      }
    }
    // 河岸路与既有道路的交叉：在交点插入节点并把被穿过的路拆成 T 口（属性由 NetworkPatch 拆边原语继承），
    // 被穿过的是桥面时改为经过它落在陆地一侧的桥头节点——不在桥面上平交。拆不成功就在交叉处把岸路断开，绝不留无路口的平交。
    if (hasRiver) {
      const joined: Vec2[][] = [];
      // 交点处岸路两条腿与已有道路各腿的最小夹角：< 35° 就是锐角路口（acuteJunctions 约束 30°，留 5° 余量），宁可断开。
      const MIN_JOIN_ANGLE = (35 * Math.PI) / 180;
      const legsAt = (at: Vec2, extra: Vec2[]) => {
        const id = roadNodeId(keyOf(at));
        const out: Vec2[] = [...extra];
        for (const edge of edges.values()) {
          if (edge.from === id) out.push(edge.points[1]);
          else if (edge.to === id) out.push(edge.points[edge.points.length - 2]);
        }
        return out;
      };
      const anglesOk = (at: Vec2, runLegs: Vec2[], others: Vec2[]) => runLegs.every((r) => others.every((o) => {
        const ux = r.x - at.x, uz = r.z - at.z, vx = o.x - at.x, vz = o.z - at.z;
        const l = Math.hypot(ux, uz) * Math.hypot(vx, vz); if (l < 1e-9) return false;
        return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / l))) >= MIN_JOIN_ANGLE;
      }));
      for (const run of coastRoadRuns.splice(coastalRunCount)) {
        let current: Vec2[] = [run[0]];
        for (let k = 1; k < run.length; k += 1) {
          const a = run[k - 1], b = run[k];
          const hits: Array<{ t: number; at: Vec2; split?: string }> = [];
          for (const edge of edges.values()) {
            for (let j = 1; j < edge.points.length; j += 1) {
              const c = edge.points[j - 1], d = edge.points[j];
              const relation = classifyRoadSegments(a, b, c, d, 0);
              if (relation.kind !== "interior-crossing" && relation.kind !== "endpoint-on-edge") continue;
              if (edge.bridge) {
                // 桥头：取桥面上离岸路更近、且在陆地上的那个端点。
                const head = [c, d].filter((p) => !inRiver(p.x, p.z)).sort((p, q) => Math.hypot(p.x - relation.a.point.x, p.z - relation.a.point.z) - Math.hypot(q.x - relation.a.point.x, q.z - relation.a.point.z))[0];
                if (head) hits.push({ t: relation.a.t, at: head });
                continue;
              }
              const at = keyOf(relation.b.point);
              const nearEnd = [c, d].find((p) => Math.hypot(p.x - at.x, p.z - at.z) < 3);
              hits.push(nearEnd ? { t: relation.a.t, at: nearEnd } : { t: relation.a.t, at, split: edge.id });
            }
          }
          hits.sort((p, q) => p.t - q.t);
          let broken = false;
          for (const hit of hits) {
            // 上一个岸路点贴着交点（< 3）：并入交点，否则这条 0.x 长的「腿」方向是随机的，夹角判定没有意义。
            if (current.length >= 2 && Math.hypot(current[current.length - 1].x - hit.at.x, current[current.length - 1].z - hit.at.z) < 3) current.pop();
            const prev = current[current.length - 1];
            const others = hit.split ? (() => { const e = edges.get(hit.split!)!; return [e.points[0], e.points[e.points.length - 1]]; })() : legsAt(hit.at, []);
            if (!anglesOk(hit.at, [prev, b], others)) { broken = true; break; }
            if (hit.split) {
              const result = commitNetworkPatch(network, { baseVersion: network.version, addEdges: [], removeEdgeIds: [], splits: [{ edgeId: hit.split, at: hit.at }] });
              if (!result.ok) { broken = true; break; }
            }
            const last = current[current.length - 1];
            if (Math.hypot(last.x - hit.at.x, last.z - hit.at.z) > 0.5) current.push(hit.at);
          }
          if (broken) { if (current.length >= 3) joined.push(current); current = [b]; continue; }
          const tail = current[current.length - 1];
          if (hits.length && Math.hypot(tail.x - b.x, tail.z - b.z) < 3) continue; // b 贴着刚插入的交点：交点替代它
          current.push(b);
        }
        if (current.length >= 3) joined.push(current);
      }
      coastRoadRuns.push(...joined);
    }
    // 主干级（宽 12）：与海滨大道同级，平行的街网道路据此降级为支路。
    for (const runPts of coastRoadRuns) for (let k = 1; k < runPts.length; k += 1) {
      addEdge(runPts[k - 1], runPts[k], true, false, true);
      const id = [roadNodeId(key(runPts[k - 1])), roadNodeId(key(runPts[k]))].sort().join("/");
      const edge = edges.get(id);
      if (edge && !edge.bridge && edge.structure === "ground-road") edge.purpose = "waterfront";
    }
  }
  return { coastRoadRuns, coastalRunCount };
}
