import { atLeast, isStandardEdge } from "../roadStandard";
import { DetMath as Math } from "../detMath"; // 跨引擎确定性：与 cityPlan.ts 同一份 Math（见 detMath.ts）
import { clearsHighways, roadNodeId, segmentDistance } from "../roadGeometry";
import type { RoadEdge, Vec2 } from "../cityLayout";
import { polylineClosest, wetCount } from "./footprint";
import { addNetworkEdge, keyOf, commitNetworkPatch } from "./network";
import { endpointClear, parseFailure } from "./connect";
import { validateCandidate } from "./validation";
import { JUNCTION_CONFIG } from "./junctions";
import { groundJunctionCorridorFailure } from "./civicClearance";
import { crosses, nearBridgeEnd, polylineDistance, safeRoadLink } from "./footprint";
import { bridgeLandingNodes, isPlannedRoadEnd } from "./endpoints";
import { canRelocateGroundSite, specByKind } from "./sitespec";
import { planarAccessPose, resolvePlanarAccess } from "../models/siteAccess";
import { declaredGroundRoadClear } from "./modelEnvelope";
import { registeredModelGroundFailure } from "./modelGround";

/** 与 constraints/networkRepairs 同一计划内终点视图（批次 3-2：repairs 的两处 height 门切语义判定）。 */
function plannedEndWorld(ctx: RepairContext) {
  const sites = [...ctx.publicSites, ...ctx.landmarks].filter((s) => s.radius);
  return {
    bridgeLandings: bridgeLandingNodes([...ctx.network.edges.values()]),
    sites,
    boulevardEnds: (ctx.seaside?.samples ?? []).filter((x: { valid: boolean; boulevard?: Vec2 }) => x.valid && x.boulevard).map((x: { boulevard?: Vec2 }) => x.boulevard!),
    coastRoadRunEnds: ctx.coastRoadRunEnds,
    coast: ctx.coast,
    river: ctx.geo.river,
    waterEdges: ctx.geo.waterEdges,
  };
}
import type { RepairContext } from "./context";

// 规划尾部的修复遍（CITY_ARCHITECTURE §2 迁移步 5b）：逐字从 cityPlan.ts 的 buildPlan 尾部搬来，闭包引用改为 ctx 解构，
// 迭代顺序、阈值与常数一律不变（planner 基线哈希是证明）。每个遍返回「改动数」，供 solve.ts 汇总。

/** 用地修复遍共用的几何：可挪动的用地、最近非桥路段（含垂足）、占地圈湿点数。路网在这些遍内不变，所以每个遍各算一份与原先共用一份等价。 */
export function siteGeometry(ctx: RepairContext, onlyOwnerId?: string) {
  const { publicSites, landmarks, height, inRiver } = ctx; const { edges } = ctx.network;
  // 港口在 solve 前有专属贴岸遍。通用避路遍会把它从岸边推到内陆，覆盖明确的岸线规划意图；
  // 港口的道路接入由 site-access 连接负责，不应通过移动港口中心来解决。
  const movable = [...publicSites, ...landmarks].filter((s) => s.radius && canRelocateGroundSite(s)
    && (onlyOwnerId === undefined || s.id === onlyOwnerId));
  const solidRuns = [...edges.values()].filter((e) => !e.bridge).map((e) => e.points);
  const geo = { height, inRiver };
  const nearestRoad = (x: number, z: number) => polylineClosest(solidRuns, { x, z });
  const wetAt = (site: { radius: number }, x: number, z: number) => wetCount(geo, { x, z }, site.radius, { river: true });
  return { movable, nearestRoad, wetAt };
}
type SiteGeometry = ReturnType<typeof siteGeometry>;

/** 临街：车站/体育场拉到离路 0.85 半径（先不转向、再转向车站正面各一遍，与原先顺序一致）。返回挪动次数。 */
export function frontStationsAndStadiums(ctx: RepairContext): number {
  const { publicSites, landmarks, blocks, ringRuns, height } = ctx;
  const { movable, nearestRoad, wetAt } = siteGeometry(ctx);
  let moved = 0;
  // 临街：车站/体育场的正面要贴着路边（用户截图：车站离路一大截——「门前有路」守卫只要求 ≤ 半径+20）。
  // 沿「路 → 用地中心」反方向的反向把它拉到离路 0.85 半径（占地前沿 ≈ 0.65 半径，贴着人行道），
  // 仍满足上面的「中心到路 ≥ 0.7 半径」；新位置须是干地、不压其它用地/高架、不让别的路穿过。
  for (const site of movable) {
    if (!resolvePlanarAccess(specByKind(site.kind)?.planarAccess, site.radius).ok) continue;
    const near = nearestRoad(site.x, site.z);
    if (!near || near.d <= site.radius * 0.95 || near.d > site.radius + 90) continue;
    const others = [...publicSites, ...landmarks].filter((o) => o !== site && o.radius);
    const dirx = (site.x - near.q.x) / near.d; const dirz = (site.z - near.q.z) / near.d;
    const nx = near.q.x + dirx * site.radius * 0.85; const nz = near.q.z + dirz * site.radius * 0.85;
    const probe = nearestRoad(nx, nz);
    if (!probe || probe.d < site.radius * 0.8) continue;
    if (wetAt(site, nx, nz) > Math.max(3, wetAt(site, site.x, site.z)) || height(nx, nz) <= 0.5) continue;
    if (others.some((o) => Math.hypot(o.x - nx, o.z - nz) < o.radius + site.radius)) continue;
    if (!clearsHighways({ x: nx, z: nz }, site.radius * 2, site.radius * 2, ringRuns)) continue;
    site.x = nx; site.z = nz; moved += 1;
    for (const block of blocks) block.parcels = block.parcels.filter((pc) => Math.hypot(pc.x - nx, pc.z - nz) >= site.radius);
  }
  // 临街：车站/体育场的正面要贴着路边（用户截图：车站离路一大截——「门前有路」守卫只要求 ≤ 半径+20）。
  // 沿「路 → 用地中心」反方向的反向把它拉到离路 0.85 半径（占地前沿 ≈ 0.65 半径，贴着人行道），
  // 仍满足上面的「中心到路 ≥ 0.7 半径」；新位置须是干地、不压其它用地/高架、不让别的路穿过。
  for (const site of movable) {
    const resolved = resolvePlanarAccess(specByKind(site.kind)?.planarAccess, site.radius);
    if (!resolved.ok) continue;
    const near = nearestRoad(site.x, site.z);
    if (!near || near.d > site.radius + 90) continue;
    // Entrance direction comes from the declaration, not a building-name convention.
    if (near.d > 0.5) { const yaw = planarAccessPose(resolved.access, site, { x: (near.q.x - site.x) / near.d, z: (near.q.z - site.z) / near.d }).yaw;
      if (yaw !== site.yaw) { site.yaw = yaw; moved += 1; } }
    if (near.d <= site.radius * 0.95) continue;
    const others = [...publicSites, ...landmarks].filter((o) => o !== site && o.radius);
    const dirx = (site.x - near.q.x) / near.d; const dirz = (site.z - near.q.z) / near.d;
    const nx = near.q.x + dirx * site.radius * 0.85; const nz = near.q.z + dirz * site.radius * 0.85;
    const probe = nearestRoad(nx, nz);
    if (!probe || probe.d < site.radius * 0.8) continue;
    if (wetAt(site, nx, nz) > Math.max(3, wetAt(site, site.x, site.z)) || height(nx, nz) <= 0.5) continue;
    if (others.some((o) => Math.hypot(o.x - nx, o.z - nz) < o.radius + site.radius)) continue;
    if (!clearsHighways({ x: nx, z: nz }, site.radius * 2, site.radius * 2, ringRuns)) continue;
    site.x = nx; site.z = nz; moved += 1;
    for (const block of blocks) block.parcels = block.parcels.filter((pc) => Math.hypot(pc.x - nx, pc.z - nz) >= site.radius);
  }
  return moved;
}

/** Read-only, lazy candidates for the existing bounded coastal fallback. */
export function* shoreRelocationCandidates(ctx: RepairContext, site: RepairContext["landmarks"][number] | RepairContext["publicSites"][number], g: SiteGeometry,
  others: Array<{ x: number; z: number; radius: number }>): Iterable<Vec2> {
  const { ringRuns, coast, core, height, SHORE_SITE_KINDS } = ctx;
  const { nearestRoad, wetAt } = g;
  const groundRoads = [...ctx.network.edges.values()].filter(road => !road.bridge);
  if (!(SHORE_SITE_KINDS.has(site.kind)) || (site as { shore?: Vec2 }).shore) return;
  const ranked2 = [...coast].sort((u, v) => Math.hypot(u.x - site.x, u.z - site.z) - Math.hypot(v.x - site.x, v.z - site.z));
  // 向内移 0.7 / 1.0 / 1.5 / 2.0 个半径各试一次：沿海大道离水线 ~22，贴岸 0.7 半径的位置正好压在它上面，
  // 退到大道内侧（岸边用地与海之间隔一条路）也算临水。
  const slots = ranked2.slice(0, 400).flatMap((q) => [0.7, 1.0, 1.5, 2.0].map((f) => ({ q, f })));
  for (let idx = 0; idx < slots.length; idx += 1) {
    const { q, f } = slots[idx]; const lx = core.x - q.x; const lz = core.z - q.z; const ll = Math.hypot(lx, lz) || 1;
    const nx = q.x + (lx / ll) * site.radius * f; const nz = q.z + (lz / ll) * site.radius * f;
    const probe = nearestRoad(nx, nz);
    const proposed = declaredGroundRoadClear({ ...site, x: nx, z: nz }, groundRoads);
    if (!probe || proposed === false || (proposed === undefined && probe.d < site.radius * 0.85) || probe.d > site.radius + 20) continue;
    if (wetAt(site, nx, nz) > 3 || height(nx, nz) <= 0.5 || nearBridgeEnd(ctx.bridges, nx, nz, site.radius)) continue;
    if (others.some((o) => Math.hypot(o.x - nx, o.z - nz) < o.radius + site.radius)) continue;
    if (!clearsHighways({ x: nx, z: nz }, site.radius * 2, site.radius * 2, ringRuns)) continue;
    if (polylineDistance(ctx.trunkRuns, { x: nx, z: nz }) < site.radius * 0.7) continue;
    if (registeredModelGroundFailure({ ...site, x: nx, z: nz }, { height, inRiver: ctx.inRiver })) continue;
    yield { x: nx, z: nz };
  }
}

export function relocateShoreSite(ctx: RepairContext, site: RepairContext["landmarks"][number] | RepairContext["publicSites"][number], g: SiteGeometry, others: Array<{ x: number; z: number; radius: number }>): boolean {
  for (const at of shoreRelocationCandidates(ctx, site, g, others)) {
    site.x = at.x; site.z = at.z;
    for (const block of ctx.blocks) block.parcels = block.parcels.filter((pc) => Math.hypot(pc.x - at.x, pc.z - at.z) >= site.radius);
    return true;
  }
  return false;
}

/** 穿路的用地推离路（最多 6 轮直到没有挪动）；推不开的岸边用地走 relocateShoreSite。返回总挪动数。 */
export function nudgeSitesOffRoads(ctx: RepairContext, onlyOwnerId?: string): number {
  const { publicSites, landmarks, blocks, ringRuns, height } = ctx;
  const g = siteGeometry(ctx, onlyOwnerId);
  const { movable, nearestRoad, wetAt } = g;
  const groundRoads = [...ctx.network.edges.values()].filter(road => !road.bridge);
  let total = 0;
  for (let round = 0; round < 6; round += 1) {
    let moved = 0;
    for (const site of movable) {
      const near = nearestRoad(site.x, site.z);
      const declared = declaredGroundRoadClear(site, groundRoads);
      if (!near || declared === true || (declared === undefined && near.d >= site.radius * 0.7)) continue;
      const others = [...publicSites, ...landmarks].filter((o) => o !== site && o.radius);
      const away = near.d > 0.5 ? { x: (site.x - near.q.x) / near.d, z: (site.z - near.q.z) / near.d } : { x: 1, z: 0 };
      const wet0 = wetAt(site, site.x, site.z);
      // 沿「离路」方向优先，再试两侧与四个斜向（路穿过用地、而用地一侧临河时只有斜着挪得开）；最大推 1.3 半径。
      const diag = Math.SQRT1_2; const tryDirs = [away, { x: -away.z, z: away.x }, { x: away.z, z: -away.x }, { x: (away.x - away.z) * diag, z: (away.z + away.x) * diag }, { x: (away.x + away.z) * diag, z: (away.z - away.x) * diag }, { x: -away.x, z: -away.z }];
      let done = false;
      for (const dir of tryDirs) {
        for (let push = 4; push <= site.radius * 1.3 && !done; push += 3) {
          const nx = site.x + dir.x * push; const nz = site.z + dir.z * push;
          const probe = nearestRoad(nx, nz);
          const proposed = declaredGroundRoadClear({ ...site, x: nx, z: nz }, groundRoads);
          if (!probe || proposed === false || (proposed === undefined && probe.d < site.radius * 0.85)) continue;
          if (wetAt(site, nx, nz) > Math.max(3, wet0) || height(nx, nz) <= 0.5) continue;
          if (others.some((o) => Math.hypot(o.x - nx, o.z - nz) < o.radius + site.radius)) continue;
          if (!clearsHighways({ x: nx, z: nz }, site.radius * 2, site.radius * 2, ringRuns)) continue;
          if (polylineDistance(ctx.trunkRuns, { x: nx, z: nz }) < site.radius * 0.7) continue;
          if (registeredModelGroundFailure({ ...site, x: nx, z: nz }, { height, inRiver: ctx.inRiver })) continue;
          site.x = nx; site.z = nz; done = true; moved += 1;
          for (const block of blocks) block.parcels = block.parcels.filter((p) => Math.hypot(p.x - nx, p.z - nz) >= site.radius);
        }
        if (done) break;
      }
  // 兜底：附近推不开（岸边用地夹在海与路之间、桥头贴着它）——沿海岸换一个位置。
  if (!done && relocateShoreSite(ctx, site, g, others)) moved += 1;
    }
    total += moved;
    if (!moved) break;
  }
  return total;
}

/** 被用地截断的路：两个共线断头隔着同一块用地时，用绕用地外缘的折线接起来。返回新增折线数。 */
export function detourAroundSites(ctx: RepairContext): number {
  const { height, inRiver, publicSites, landmarks } = ctx; const { nodes, edges } = ctx.network; const addEdge = (a: Vec2, b: Vec2, arterial: boolean, bridge = false, primary = false) => addNetworkEdge(ctx.network, a, b, arterial, bridge, primary); const key = keyOf;
  let joined = 0;
    const solid = () => [...edges.values()].filter((e) => !e.bridge);
    const degree = new Map<string, RoadEdge[]>();
    for (const e of solid()) for (const id of [e.from, e.to]) (degree.get(id) ?? degree.set(id, []).get(id)!).push(e);
    const loose = [...degree.entries()].filter(([, list]) => list.length === 1).map(([id, list]) => ({ id, edge: list[0], at: nodes.get(id)! })).filter((x) => x.at && !isPlannedRoadEnd(x.at, plannedEndWorld(ctx)));
    const sitesAll = [...publicSites, ...landmarks].filter((o) => o.radius);
    const crosses = (a: Vec2, b: Vec2) => solid().some((e) => {
      const [c, d] = e.points; if (roadNodeId(c) === roadNodeId(a) || roadNodeId(d) === roadNodeId(a) || roadNodeId(c) === roadNodeId(b) || roadNodeId(d) === roadNodeId(b)) return false;
      const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
      return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
    });
    const used = new Set<string>();
    for (let i = 0; i < loose.length; i += 1) for (let j = i + 1; j < loose.length; j += 1) {
      const A = loose[i]; const B = loose[j];
      if (used.has(A.id) || used.has(B.id) || A.edge.kind !== B.edge.kind || A.edge.width !== B.edge.width) continue;
      const span = Math.hypot(B.at.x - A.at.x, B.at.z - A.at.z); if (span < 30 || span > 320) continue;
      const nb = (L: typeof A) => { const [p0, p1] = L.edge.points; return roadNodeId(p0) === L.id ? p1 : p0; };
      const dirOf = (L: typeof A, to: Vec2) => { const n = nb(L); const v = { x: L.at.x - n.x, z: L.at.z - n.z }; const w = { x: to.x - L.at.x, z: to.z - L.at.z }; const c = (v.x * w.x + v.z * w.z) / ((Math.hypot(v.x, v.z) || 1) * (Math.hypot(w.x, w.z) || 1)); return c; };
      if (dirOf(A, B.at) < Math.cos((50 * Math.PI) / 180) || dirOf(B, A.at) < Math.cos((50 * Math.PI) / 180)) continue; // 两头都要朝着对方延伸
      const blocker = sitesAll.find((o) => segmentDistance(o, A.at, B.at) < o.radius + 4 && Math.hypot(o.x - A.at.x, o.z - A.at.z) <= o.radius + 90 && Math.hypot(o.x - B.at.x, o.z - B.at.z) <= o.radius + 90);
      if (!blocker) continue;
      const R = blocker.radius + 8; const ux = (B.at.x - A.at.x) / span; const uz = (B.at.z - A.at.z) / span; const px = -uz; const pz = ux;
      for (const side of [1, -1]) {
        const m = key({ x: blocker.x + px * side * R, z: blocker.z + pz * side * R });
        // 折线 A → q1 → m → q2 → B：q1/q2 取 A/B 与 m 的中点再向外推，让转角缓一些（单个拐点会出 <60° 的急弯）。
        const q1 = key({ x: (A.at.x + m.x) / 2 + px * side * R * 0.15, z: (A.at.z + m.z) / 2 + pz * side * R * 0.15 });
        const q2 = key({ x: (B.at.x + m.x) / 2 + px * side * R * 0.15, z: (B.at.z + m.z) / 2 + pz * side * R * 0.15 });
        const chain = [A.at, q1, m, q2, B.at];
        let ok = true;
        for (let k = 0; k < chain.length && ok; k += 1) {
          const q = chain[k];
          if (k > 0 && k < chain.length - 1 && (height(q.x, q.z) <= 0.5 || inRiver(q.x, q.z))) ok = false;
          if (sitesAll.some((o) => o !== blocker && Math.hypot(o.x - q.x, o.z - q.z) < o.radius + 4)) ok = false;
          if (k > 0 && crosses(chain[k - 1], q)) ok = false;
        }
        if (!ok) continue;
        for (let k = 1; k < chain.length; k += 1) addEdge(chain[k - 1], chain[k], A.edge.kind === "arterial", false, atLeast(A.edge, "arterial"));
        used.add(A.id); used.add(B.id); joined += 1;
        break;
      }
    }
  return joined;
}

/** 断头顺着自己的方向直接延伸到下一条路（两遍）。返回接上的断头数。 */
export function extendLooseEnds(ctx: RepairContext, onlyNodeId?: string): number {
  const { publicSites, landmarks } = ctx; const { nodes, edges } = ctx.network; const key = keyOf;
  let total = 0;
    for (let pass = 0; pass < 2; pass += 1) {
      const solidEdges = [...edges.values()].filter((e) => !e.bridge);
      const inc = new Map<string, RoadEdge[]>();
      for (const e of solidEdges) for (const id of [e.from, e.to]) (inc.get(id) ?? inc.set(id, []).get(id)!).push(e);
      const sitesAll2 = [...publicSites, ...landmarks].filter((o) => o.radius);
      let healed = 0;
      for (const [id, list] of inc) {
        if (onlyNodeId !== undefined && id !== onlyNodeId) continue;
        if (list.length !== 1) continue;
        const at = nodes.get(id); if (!at || isPlannedRoadEnd(at, plannedEndWorld(ctx))) continue;
        if (sitesAll2.some((o) => Math.hypot(o.x - at.x, o.z - at.z) < o.radius + 12)) continue; // 伸进用地边缘的门前路是正常终点
        const own = list[0];
        if (!isStandardEdge(own)) continue;
        const from = own.from === id ? own.points[1] : own.points[own.points.length - 2];
        const dx = at.x - from.x; const dz = at.z - from.z; const dl = Math.hypot(dx, dz); if (dl < 1) continue;
        const ux = dx / dl; const uz = dz / dl;
        let best: { t: number; edge: RoadEdge; c: Vec2; d: Vec2 } | null = null;
        for (const e of solidEdges) {
          if (e === own) continue;
          for (let k = 1; k < e.points.length; k += 1) {
          const c = e.points[k - 1], d = e.points[k]; const ex = d.x - c.x; const ez = d.z - c.z;
          const den = ux * ez - uz * ex; if (Math.abs(den) < 1e-6) continue;
          const t = ((c.x - at.x) * ez - (c.z - at.z) * ex) / den;
          const w = ((c.x - at.x) * uz - (c.z - at.z) * ux) / den;
          if (t < 3 || t > 320 || w < 0 || w > 1) continue;
          if (!best || t < best.t) best = { t, edge: e, c, d };
          }
        }
        if (!best) continue;
        const { c, d } = best;
        let target = key({ x: at.x + ux * best.t, z: at.z + uz * best.t });
        const lenE = Math.hypot(d.x - c.x, d.z - c.z) || 1;
        const hostStart = best.edge.points[0], hostEnd = best.edge.points[best.edge.points.length - 1];
        if (Math.hypot(target.x - hostStart.x, target.z - hostStart.z) < 12) target = hostStart;
        else if (Math.hypot(target.x - hostEnd.x, target.z - hostEnd.z) < 12) target = hostEnd;
        if (roadNodeId(target) === id) continue;
        if (!safeRoadLink(ctx.geo, [...publicSites, ...landmarks], at, target)) continue;
        // Ordinary new T junctions share the same 35-degree contract.
        const ex2 = d.x - c.x; const ez2 = d.z - c.z; const cosA = Math.abs((ux * ex2 + uz * ez2) / lenE);
        const targetIsEndpoint = target === hostStart || target === hostEnd;
        if (!targetIsEndpoint && cosA > Math.cos((JUNCTION_CONFIG.minAngleDeg * Math.PI) / 180)) continue;
        if (!endpointClear(ctx.network, at, target) || !endpointClear(ctx.network, target, at)) continue;
        const host = best.edge;
        const world = { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [...publicSites, ...landmarks] };
        const result = commitNetworkPatch(ctx.network, { baseVersion: ctx.network.version,
          removeEdgeIds: [], splits: targetIsEndpoint ? [] : [{ edgeId: host.id, at: target }],
          addEdges: [{ a: at, b: target, arterial: own.kind === "arterial", primary: atLeast(own, "arterial") }] }, (draft) => {
          const verdict = validateCandidate(world, draft, { id: `extend:${id}`, crossings: true, blockers: [],
            segments: [{ a: at, b: target, width: own.width, kind: "ground-road" }] },
          { roadPolicy: { requireBuildable: true, maxSlope: 0.9, sites: world.reservations(), siteMargin: 3, roadWidth: own.width } });
          if (!verdict.ok) return `${verdict.violations[0].kind} ${verdict.violations[0].detail}`;
          const targetId = roadNodeId(target);
          const legs = [...draft.edges.values()].filter((edge) => !edge.bridge && (edge.from === targetId || edge.to === targetId));
          const directions = legs.map((edge) => {
            const outward = edge.from === targetId ? edge.points[1] : edge.points[edge.points.length - 2];
            return { x: outward.x - target.x, z: outward.z - target.z };
          });
          for (let i = 0; i < directions.length; i += 1) for (let j = i + 1; j < directions.length; j += 1) {
            const a = directions[i], b = directions[j], la = Math.hypot(a.x, a.z), lb = Math.hypot(b.x, b.z);
            if ((!targetIsEndpoint && (la < JUNCTION_CONFIG.minLegLength || lb < JUNCTION_CONFIG.minLegLength))
              || (a.x * b.x + a.z * b.z) / (la * lb) > Math.cos(JUNCTION_CONFIG.minAngleDeg * Math.PI / 180)) return "junction-angle extension";
          }
          for (const edge of legs) if (edge.from !== id && edge.to !== id) for (let k = 1; k < edge.points.length; k += 1) {
            const parent = edges.get(edge.id) ?? host;
            const failure = groundJunctionCorridorFailure({ ...world, network: draft }, edge.points[k - 1], edge.points[k], edge.width, parent);
            if (failure) return `${failure} extension host corridor`;
          }
          return null;
        });
        ctx.connectionLog?.push({ id: `extend:${id}`, purpose: "district-access", ok: result.ok,
          ...(!result.ok ? { reason: parseFailure(result.detail), detail: result.detail ?? result.reason } : {}) });
        if (!result.ok) continue;
        healed += 1;
      }
      total += healed;
      if (!healed) break;
    }
  return total;
}
