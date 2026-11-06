import { atLeast, roadWidthFor } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import { segmentDistance } from "../roadGeometry";
import type { RoadEdge, Vec2 } from "../cityLayout";
import { addNetworkEdge, keyOf } from "./network";
import { crosses, polylineDistance, safeRoadLink } from "./footprint";
import type { RepairContext } from "./context";
import { bridgeheadStubEnds, bridgeLandingNodes, isPlannedRoadEnd, type PlannedEndInputs } from "./endpoints";
import { runConnection, runMiniRoundabout, type ConnectorWorld, type ConnectionStrategy } from "./connect";
import { mergeCoincidentJunctionLegs } from "./snapJunctions";
import { groundJunctionCorridorFailure } from "./civicClearance";
import { groundJunctionFindings } from "./report";
import { componentOf, primaryComponentId } from "./intent";
import { crowdedPolylinePair } from "./relations";

export const COMPONENT_REPAIR_CONFIG = { version: 1, maxSources: 12, maxRouteLength: 320 };

function componentView(ctx: RepairContext) {
  return { roadNodes: [...ctx.network.nodes.values()], roadEdges: [...ctx.network.edges.values()],
    publicSites: ctx.publicSites, landmarks: ctx.landmarks, seaside: ctx.seaside, coastRoads: ctx.coastRoadRuns,
    riverRoadRuns: ctx.riverRoadRuns, coast: ctx.coast, river: ctx.geo.river, waterEdges: ctx.geo.waterEdges, core: ctx.core, primaryAnchorNodeId: ctx.primaryAnchorNodeId };
}

/** Components, including planned coast ends, need a real route to the shared
 * primary anchor; endpoint legality alone does not satisfy that obligation. */
export function componentConnectionSources(ctx: RepairContext): string[] {
  const plan = componentView(ctx), components = componentOf(plan), primary = primaryComponentId(plan, components);
  if (!primary) return [];
  const targets = plan.roadEdges.filter((edge) => !edge.bridge && components.get(edge.from) === primary);
  const groups = new Map<string, Array<{ id: string; distance: number }>>();
  for (const node of plan.roadNodes) {
    const component = components.get(node.id)!;
    if (component === primary || !plan.roadEdges.some((edge) => !edge.bridge && (edge.from === node.id || edge.to === node.id))) continue;
    let distance = Infinity;
    for (const edge of targets) for (let k = 1; k < edge.points.length; k += 1) {
      distance = Math.min(distance, segmentDistance(node, edge.points[k - 1], edge.points[k]));
    }
    if (distance > COMPONENT_REPAIR_CONFIG.maxRouteLength) continue;
    const group = groups.get(component) ?? []; group.push({ id: node.id, distance }); groups.set(component, group);
  }
  return [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([, sources]) => sources
    .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1)).slice(0, COMPONENT_REPAIR_CONFIG.maxSources).map((source) => source.id));
}

export function connectDisconnectedComponent(ctx: RepairContext, sourceId: string, strategy: ConnectionStrategy): { changes: number; reason?: string } {
  const plan = componentView(ctx), components = componentOf(plan), primary = primaryComponentId(plan, components);
  const source = ctx.network.nodes.get(sourceId);
  if (!source || !primary || components.get(sourceId) === primary) return { changes: 0 };
  const arterial = plan.roadEdges.some((edge) => !edge.bridge && edge.kind === "arterial" && (edge.from === sourceId || edge.to === sourceId));
  const id = `component:${sourceId}:${strategy}`;
  const result = runConnection({ id, source, target: { kind: "primary", isPrimaryNode: (nodeId) => components.get(nodeId) === primary },
    purpose: "district-access", allowBridge: false, maxLength: COMPONENT_REPAIR_CONFIG.maxRouteLength,
    roadClass: arterial ? "arterial" : "local",
  }, { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [...ctx.publicSites, ...ctx.landmarks] }, { strategies: [strategy] });
  ctx.connectionLog?.push({ id, purpose: "district-access", ok: result.ok,
    ...(result.ok ? { strategy: result.strategy } : { reason: result.reason, detail: result.detail }) });
  return result.ok ? { changes: 1 } : { changes: 0, reason: result.detail ?? result.reason };
}

// 路网修复手段（CITY_ROAD_NETWORK_SPEC §6：no-parallel / no-acute / no-loose-end）。与 repairs.ts 不同，这些会**改变**规划结果
// （删冗余路段），所以每条都有三道保险：① 只删窄路（局部街 5 / 次干 8），主干 12、桥、沿岸大道一律不动；
// ② 删后连通分量数不变（不切断路网）；③ 不拿走任何用地仅有的门前路。删完产生的新断头交给同一张表里的
// extendLooseEnds / pruneShortSpurs，在 solvePlan 的不动点循环里收口。

const edgeLength = (e: RoadEdge) => e.points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - e.points[i].x, point.z - e.points[i].z), 0);

/** 删一条路段，并清掉因此无任何路段的孤立节点（只清我们删出来的，已有的孤立节点不动，免得改变无关的规划哈希）。 */
function dropEdge(ctx: RepairContext, e: RoadEdge): void {
  ctx.network.edges.delete(e.id);
  for (const id of [e.from, e.to]) {
    let used = false;
    for (const other of ctx.network.edges.values()) if (other.from === id || other.to === id) { used = true; break; }
    if (!used) ctx.network.nodes.delete(id);
  }
}

/** 当前路网（含桥）的连通分量数。 */
function components(ctx: RepairContext, skip?: string): number {
  const adj = new Map<string, string[]>();
  for (const e of ctx.network.edges.values()) {
    if (e.id === skip) continue;
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }
  const seen = new Set<string>(); let n = 0;
  for (const id of adj.keys()) {
    if (seen.has(id)) continue;
    n += 1; const stack = [id]; seen.add(id);
    while (stack.length) { const c = stack.pop()!; for (const next of adj.get(c) ?? []) if (!seen.has(next)) { seen.add(next); stack.push(next); } }
  }
  return n;
}

/** 删掉 edge 后，附近每块用地是否仍有 ≤ 半径+20 的非桥路（门前路不能因为去冗余而没了）。 */
function keepsSiteDoors(ctx: RepairContext, edge: RoadEdge): boolean {
  const sites = [...ctx.publicSites, ...ctx.landmarks].filter((s) => s.radius && !(s as { shore?: unknown }).shore);
  for (const s of sites) {
    if (polylineDistance([edge.points], s) > s.radius + 20) continue; // 这条路本来就不是它的门前路
    let other = Infinity;
    for (const e of ctx.network.edges.values()) if (e !== edge && !e.bridge) other = Math.min(other, polylineDistance([e.points], s));
    if (other > s.radius + 20) return false;
  }
  return true;
}

/** Required route/boundary references veto removal, including curved edges
 * whose endpoint-only reference must not be mistaken for their chord. */
function onCarPath(ctx: RepairContext, edge: RoadEdge): boolean {
  const paths = [...ctx.carPaths, ...ctx.coastRoadRuns, ...ctx.riverRoadRuns,
    ...ctx.blocks.filter((block) => block.polygon.length).map((block) => [...block.polygon, block.polygon[0]])];
  const idOf = (point: Vec2) => { const at = keyOf(point); return `${at.x}:${at.z}`; };
  for (const path of paths) for (let i = 1; i < path.length; i += 1) {
    const a = idOf(path[i - 1]), b = idOf(path[i]);
    if ((a === edge.from && b === edge.to) || (a === edge.to && b === edge.from)) return true;
  }
  for (let k = 1; k < edge.points.length; k += 1) {
    const m = { x: (edge.points[k - 1].x + edge.points[k].x) / 2, z: (edge.points[k - 1].z + edge.points[k].z) / 2 };
    for (const path of paths) for (let i = 1; i < path.length; i += 1) if (segmentDistance(m, path[i - 1], path[i]) < 0.3) return true;
  }
  return false;
}


/** 修复策略的计划内终点视图（与 constraints.ts 的 measure 同一谓词、同一数据）。 */
function plannedEndWorld(ctx: RepairContext, sites: Array<{ x: number; z: number; radius: number }>): PlannedEndInputs {
  return {
    bridgeLandings: bridgeLandingNodes([...ctx.network.edges.values()]),
    sites,
    boulevardEnds: (ctx.seaside?.samples ?? []).filter((s: { valid: boolean; boulevard?: Vec2 }) => s.valid && s.boulevard).map((s: { boulevard?: Vec2 }) => s.boulevard!),
    coastRoadRunEnds: ctx.coastRoadRunEnds,
    coast: ctx.coast,
    river: ctx.geo.river,
    waterEdges: ctx.geo.waterEdges,
  };
}

/** 能删吗：窄路、非桥、不切断、不夺门前路、不拆车流回路。删出来的短枝由表尾的 pruneShortSpurs 收尾
 *  （策略顺序见 solve.ts 注释）；2026-10-08 起 prune 不再有高度盲区，平地短枝同样会被收掉。 */
function removable(ctx: RepairContext, edge: RoadEdge, baseline: number): boolean {
  if (edge.bridge || atLeast(edge, "arterial")) return false;
  // 桥头连续（评审修复轮实测）：地面引道是桥面的唯一地面接入，删了就剩悬空桥板
  // （seed 2000104729：连接器建好引道+桥面，prune 把引道当普通窄枝收走）。
  for (const other of ctx.network.edges.values()) {
    if (!other.bridge || other === edge) continue;
    if (other.from === edge.from || other.to === edge.from || other.from === edge.to || other.to === edge.to) return false;
  }
  if (components(ctx, edge.id) > baseline) return false;
  if (onCarPath(ctx, edge)) return false;
  return keepsSiteDoors(ctx, edge);
}

/** 约束 crowdedArterials（与 constraints.ts 同一判据）：两条不共点的次干道并排（< 25、夹角 < 15°、侧向重叠）——删较短的一条。 */
export function resolveCrowdedArterials(ctx: RepairContext): number {
  let removed = 0;
  const baseline = components(ctx);
  const arterials = [...ctx.network.edges.values()].filter((e) => e.kind === "arterial" && !e.bridge).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const dead = new Set<string>();
  for (let a = 0; a < arterials.length; a += 1) for (let b = a + 1; b < arterials.length; b += 1) {
    const A = arterials[a]; const B = arterials[b];
    if (dead.has(A.id) || dead.has(B.id)) continue;
    if ([A.from, A.to].some((id) => id === B.from || id === B.to)) continue;
    if (!crowdedPolylinePair(A.points, B.points)) continue;
    const [shorter, longer] = edgeLength(A) <= edgeLength(B) ? [A, B] : [B, A];
    for (const victim of [shorter, longer]) {
      if (!removable(ctx, victim, baseline)) continue;
      dropEdge(ctx, victim); dead.add(victim.id); removed += 1; break;
    }
  }
  return removed;
}

/** ctx → 连接器世界视图（resolveAcuteJunctions 的 mini-roundabout 策略档用；用地面视时取，规划中会挪动）。 */
function roundaboutWorld(ctx: RepairContext): ConnectorWorld {
  return { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [...ctx.publicSites, ...ctx.landmarks] };
}

/** Rotate a protected local junction leg into a legal approach using a sampled cubic; endpoints/topology stay fixed. */
function bendAcuteLocalLeg(ctx: RepairContext, junctionId: string, edge: RoadEdge): boolean {
  if (edge.bridge || edge.kind !== "local" || atLeast(edge, "collector") || edge.structure !== "ground-road" || edge.points.length !== 2) return false;
  const junction = ctx.network.nodes.get(junctionId); if (!junction) return false;
  const fromJunction = edge.from === junctionId;
  const farId = fromJunction ? edge.to : edge.from;
  const far = ctx.network.nodes.get(farId); if (!far) return false;
  const routeReferences = [...ctx.carPaths, ...ctx.coastRoadRuns, ...ctx.riverRoadRuns];
  const routeSamples = [0.2, 0.5, 0.8].map((t) => ({ x: junction.x + (far.x - junction.x) * t, z: junction.z + (far.z - junction.z) * t }));
  if (routeReferences.some((route) => routeSamples.some((sample) => route.some((p, i) => i > 0 && segmentDistance(sample, route[i - 1], p) < 0.3)))) return false;
  const same = (a: Vec2, b: Vec2) => a.x === b.x && a.z === b.z;
  if (ctx.blocks.some((block) => block.polygon.some((p, i) => {
    const q = block.polygon[(i + 1) % block.polygon.length];
    return (same(p, edge.points[0]) && same(q, edge.points[1])) || (same(p, edge.points[1]) && same(q, edge.points[0]));
  }))) return false;

  const baselineFindings = new Set(groundJunctionFindings([...ctx.network.edges.values()]).map((finding) => finding.id));
  const incident = [...ctx.network.edges.values()].filter((road) => road.from === junctionId || road.to === junctionId);
  const minimumGap = (at: string, candidate: RoadEdge): number => {
    const node = ctx.network.nodes.get(at)!;
    const roads = at === junctionId ? incident.map((road) => road.id === edge.id ? candidate : road)
      : [...ctx.network.edges.values()].map((road) => road.id === edge.id ? candidate : road).filter((road) => road.from === at || road.to === at);
    const angles = roads.map((road) => {
      const outward = road.from === at ? road.points[1] : road.points[road.points.length - 2];
      return ((Math.atan2(outward.z - node.z, outward.x - node.x) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    }).sort((a, b) => a - b);
    if (angles.length < 3) return Math.PI * 2;
    let gap = Math.PI * 2;
    for (let i = 0; i < angles.length; i += 1) {
      const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
      gap = Math.min(gap, next - angles[i]);
    }
    return gap;
  };
  const originalOutward = edge.from === junctionId ? edge.points[1] : edge.points[0];
  const originalAngle = Math.atan2(originalOutward.z - junction.z, originalOutward.x - junction.x);
  const angleCandidates = Array.from({ length: 24 }, (_, i) => i * Math.PI / 12)
    .filter((angle) => incident.filter((road) => road.id !== edge.id).every((road) => {
      const other = road.from === junctionId ? road.points[1] : road.points[road.points.length - 2];
      const otherAngle = Math.atan2(other.z - junction.z, other.x - junction.x);
      const gap = Math.abs(Math.atan2(Math.sin(angle - otherAngle), Math.cos(angle - otherAngle)));
      return gap >= Math.PI / 6;
    }))
    .sort((a, b) => Math.abs(Math.atan2(Math.sin(a - originalAngle), Math.cos(a - originalAngle)))
      - Math.abs(Math.atan2(Math.sin(b - originalAngle), Math.cos(b - originalAngle))) || a - b);
  const dx = far.x - junction.x, dz = far.z - junction.z, length = Math.hypot(dx, dz);
  if (length < 40) return false;
  const endDir = { x: dx / length, z: dz / length };
  const world = roundaboutWorld(ctx);
  for (const angle of angleCandidates) for (const handle of [12, 16, 20, 24, 28]) {
    const startDir = { x: Math.cos(angle), z: Math.sin(angle) };
    const c1 = { x: junction.x + handle * startDir.x, z: junction.z + handle * startDir.z };
    const c2 = { x: far.x - handle * endDir.x, z: far.z - handle * endDir.z };
    const curve: Vec2[] = [];
    for (let i = 0; i <= 16; i += 1) {
      const t = i / 16, s = 1 - t;
      curve.push({ x: Math.round((s ** 3 * junction.x + 3 * s * s * t * c1.x + 3 * s * t * t * c2.x + t ** 3 * far.x) * 100) / 100,
        z: Math.round((s ** 3 * junction.z + 3 * s * s * t * c1.z + 3 * s * t * t * c2.z + t ** 3 * far.z) * 100) / 100 });
    }
    if (curve.some((p, i) => i > 0 && Math.hypot(p.x - curve[i - 1].x, p.z - curve[i - 1].z) < 3)) continue;
    let sharpTurn = false;
    for (let i = 1; i < curve.length - 1; i += 1) {
      const a = { x: curve[i].x - curve[i - 1].x, z: curve[i].z - curve[i - 1].z };
      const b = { x: curve[i + 1].x - curve[i].x, z: curve[i + 1].z - curve[i].z };
      const cosine = (a.x * b.x + a.z * b.z) / (Math.hypot(a.x, a.z) * Math.hypot(b.x, b.z));
      if (cosine < Math.cos(Math.PI / 12)) { sharpTurn = true; break; }
    }
    if (sharpTurn) continue;
    const points = fromJunction ? curve : [...curve].reverse();
    const candidate = { ...edge, points };
    if (minimumGap(junctionId, candidate) < Math.PI / 6 || minimumGap(farId, candidate) < Math.PI / 6) continue;
    let failure: string | null = null;
    for (let i = 1; i < curve.length && !failure; i += 1) failure = groundJunctionCorridorFailure(world, curve[i - 1], curve[i], edge.width, edge);
    if (failure) continue;
    const changed = [...ctx.network.edges.values()].map((road) => road.id === edge.id ? candidate : road);
    if (groundJunctionFindings(changed).some((finding) => !baselineFindings.has(finding.id))) continue;
    if (ctx.blocks.some((block) => block.parcels.some((parcel) => polylineDistance([curve], parcel) < Math.hypot(parcel.width, parcel.depth) / 2 + edge.width / 2 + 0.5))) continue;
    ctx.network.edges.set(edge.id, candidate);
    return true;
  }
  return false;
}

/** 约束 acuteJunctions：路口相邻两条路夹角 < 30°。city-roundabout 起先试小型交通环（connect.ts 的
 *  mini-roundabout 策略档：三岔口建半径 10–14 的环、4–6 段弧边接上三条腿，主干腿允许进环——环是
 *  路口形态不是删路，不违反删除路径的主干保护；阈值放宽 (b)——建环后新路口相邻边夹角全部 ≥30° 时，
 *  原本 <30° 的对也以环消解），建环不成（腿上有车流回路、腿太短、桥腿、走廊或角度不过）才退回删
 *  较短的窄路。删是最后手段，不再是无条件首选。 */
export function resolveAcuteJunctions(ctx: RepairContext): number {
  let resolved = 0;
  const baseline = components(ctx);
  const incident = new Map<string, RoadEdge[]>();
  for (const e of ctx.network.edges.values()) for (const id of [e.from, e.to]) (incident.get(id) ?? incident.set(id, []).get(id)!).push(e);
  for (const [id, list] of incident) {
    const live = list.filter((e) => ctx.network.edges.has(e.id));
    if (live.length < 3) continue;
    const node = ctx.network.nodes.get(id); if (!node) continue;
    if (mergeCoincidentJunctionLegs(ctx, id)) { resolved += 1; continue; }
    const ang = (e: RoadEdge) => { const pts = e.from === id ? e.points : [...e.points].reverse(); return Math.atan2(pts[1].z - node.z, pts[1].x - node.x); };
    const sorted = live.map((e) => ({ e, a: ((ang(e) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) })).sort((x, y) => x.a - y.a);
    for (let k = 0; k < sorted.length; k += 1) {
      const gap = (k + 1 < sorted.length ? sorted[k + 1].a : sorted[0].a + Math.PI * 2) - sorted[k].a;
      if (gap >= (30 * Math.PI) / 180) continue;
      // 策略档 mini-roundabout：三岔口且三条腿都不载车流回路（换边会让车流折线的逐段核对失效）。
      let roundaboutSiteBlocked = false;
      if (live.length === 3 && live.every((e) => !onCarPath(ctx, e))) {
        const world = roundaboutWorld(ctx);
        const roundabout = runMiniRoundabout(world, node, live, (a, b, width) => groundJunctionCorridorFailure(world, a, b, width));
        if (roundabout.ok) { resolved += 1; break; }
        roundaboutSiteBlocked = roundabout.reason === "site-clearance";
      }
      // If the physical ring is blocked but deleting the acute leg would split
      // the graph, try a smooth local-road approach bend with fixed endpoints.
      if (roundaboutSiteBlocked) {
        const candidates = [sorted[k].e, sorted[(k + 1) % sorted.length].e]
          .filter((road) => road.kind === "local" && road.width < roadWidthFor("collector"))
          .sort((a, b) => edgeLength(a) - edgeLength(b) || (a.id < b.id ? -1 : 1));
        if (candidates.some((road) => bendAcuteLocalLeg(ctx, id, road))) { resolved += 1; break; }
      }
      const pair = [sorted[k].e, sorted[(k + 1) % sorted.length].e].sort((x, y) => edgeLength(x) - edgeLength(y));
      const victim = pair.find((e) => ctx.network.edges.has(e.id) && removable(ctx, e, baseline));
      if (victim) { dropEdge(ctx, victim); resolved += 1; }
      break;
    }
  }
  return resolved;
}

/** 约束 looseInlandRoadEnds：短悬挂链（< 60、全是窄路）就删——通往空地的小尾巴；长路不动（要接通而不是删）。 */
export function pruneShortSpurs(ctx: RepairContext): number {
  let removed = 0;
  const sites = [...ctx.publicSites, ...ctx.landmarks].filter((s) => s.radius);
  const baseWorld = plannedEndWorld(ctx, sites);
  for (let pass = 0; pass < 4; pass += 1) {
    // 桥头残桩不享受计划内终点豁免（endpoints.bridgeheadStubEnds，与 looseInlandRoadEnds 检测同口径）。
    const plannedWorld = { ...baseWorld, bridgeheadStubs: bridgeheadStubEnds([...ctx.network.edges.values()]) };
    const deg = new Map<string, RoadEdge[]>();
    for (const e of ctx.network.edges.values()) if (!e.bridge) for (const id of [e.from, e.to]) (deg.get(id) ?? deg.set(id, []).get(id)!).push(e);
    let changed = 0;
    for (const [id, list] of deg) {
      if (list.length !== 1) continue;
      const node = ctx.network.nodes.get(id); if (!node || isPlannedRoadEnd(node, plannedWorld)) continue;
      const chain: RoadEdge[] = []; let cur = id; let prev: RoadEdge | null = null; let len = 0; let ok = true;
      for (let step = 0; step < 12; step += 1) {
        const next: RoadEdge | undefined = (deg.get(cur) ?? []).find((e) => e !== prev && ctx.network.edges.has(e.id));
        if (!next || atLeast(next, "arterial")) { ok = false; break; }
        chain.push(next); len += edgeLength(next); prev = next; cur = next.from === cur ? next.to : next.from;
        if ((deg.get(cur)?.length ?? 0) >= 3) break;
        if (len >= 60) { ok = false; break; }
      }
      if (!ok || len >= 60 || (deg.get(cur)?.length ?? 0) < 3) continue;
      // 非桥度数会把桥头唯一引道误当短枝；删链必须同时保留桥头的地面邻接。
      // 只保护「删完桥头就没有地面边」的链（与 landing.ts::groundChainAtRisk 同口径：桥头恰一条地面边）。
      // 曾是碰到桥头一律不删，桥头旁另有引道时贴桥头的断头残桩也删不掉（7/2，见 endpoints.bridgeheadStubEnds）。
      const chainIds = new Set(chain.map((e) => e.id));
      if (chain.some((e) => [e.from, e.to].some((end) =>
        [...ctx.network.edges.values()].some((b) => b.bridge && (b.from === end || b.to === end)) &&
        !(deg.get(end) ?? []).some((g) => !chainIds.has(g.id) && ctx.network.edges.has(g.id))))) continue;
      if (!chain.every((e) => keepsSiteDoors(ctx, e) && !onCarPath(ctx, e))) continue;
      for (const e of chain) dropEdge(ctx, e);
      removed += chain.length; changed += 1;
    }
    if (!changed) break;
  }
  return removed;
}

/**
 * 约束 looseInlandRoadEnds：「近失误」断头——端点离另一条路只有一个车道宽的距离（实测 15 个样本外断头里 12 个在 10–15），
 * 原来的垂直接入因为夹角/最小角规则被拒。这里放宽到：端点 ≤ 24 内有他路，沿垂足直连安全（不过水、不穿用地、不穿路），就接上；
 * 垂足离路段端点 < 12 时吸附到端点，中段则把宿主路段切成 T 路口。连接线与宿主垂直，所以不会新造锐角路口。
 */
export const ENDPOINT_REPAIR_CONFIG = { version: 1, maxRouteLength: 320 };

/** Route search is distinct from snapping: each proposal has its own acceptance
 * transaction, and the existing 24-unit near-link limit remains unchanged. */
export function connectLooseEnd(ctx: RepairContext, id: string, strategy: ConnectionStrategy, collectorAccess = false): { changes: number; reason?: string } {
  const node = ctx.network.nodes.get(id);
  const incident = [...ctx.network.edges.values()].filter((edge) => !edge.bridge && (edge.from === id || edge.to === id));
  if (!node || incident.length !== 1 || isPlannedRoadEnd(node,
    plannedEndWorld(ctx, [...ctx.publicSites, ...ctx.landmarks].filter((site) => site.radius)))) return { changes: 0 };
  const own = incident[0];
  if (collectorAccess && own.width !== roadWidthFor("arterial")) return { changes: 0 };
  const attemptId = `endpoint:${id}:${strategy}${collectorAccess ? ":collector" : ""}`;
  const crowdedCount = (network: RepairContext["network"]) => {
    const arterials = [...network.edges.values()].filter((edge) => !edge.bridge && edge.kind === "arterial");
    let count = 0;
    for (let i = 0; i < arterials.length; i += 1) for (let j = i + 1; j < arterials.length; j += 1) {
      const a = arterials[i], b = arterials[j];
      if ([a.from, a.to].some((nodeId) => nodeId === b.from || nodeId === b.to)) continue;
      if (crowdedPolylinePair(a.points, b.points)) count += 1;
    }
    return count;
  };
  const baselineCrowded = crowdedCount(ctx.network);
  const result = runConnection({ id: attemptId, source: node,
    target: { kind: "edges", include: (edge) => !edge.bridge && edge.id !== own.id && edge.from !== id && edge.to !== id },
    purpose: "district-access", allowBridge: false,
    maxLength: strategy === "direct-projection" ? 24 : ENDPOINT_REPAIR_CONFIG.maxRouteLength,
    roadClass: own.kind === "arterial" ? "arterial" : "local", primary: atLeast(own, "arterial") && !collectorAccess,
  }, { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver,
    reservations: () => [...ctx.publicSites, ...ctx.landmarks].filter((site) => site.radius),
    draftAcceptance: (draft) => crowdedCount(draft) > baselineCrowded ? "crossing endpoint route increases crowded arterials" : null,
  }, { strategies: [strategy] });
  ctx.connectionLog?.push({ id: attemptId, purpose: "district-access", ok: result.ok,
    ...(result.ok ? { strategy: result.strategy } : { reason: result.reason, detail: result.detail }) });
  return result.ok ? { changes: 1 } : { changes: 0, reason: result.detail ?? result.reason };
}

export function joinNearMissEnds(ctx: RepairContext, onlyNodeId?: string): number {
  let joined = 0;
  const sites = [...ctx.publicSites, ...ctx.landmarks].filter((s) => s.radius);
  const plannedWorld = plannedEndWorld(ctx, sites);
  const deg = new Map<string, RoadEdge[]>();
  for (const e of ctx.network.edges.values()) if (!e.bridge) for (const id of [e.from, e.to]) (deg.get(id) ?? deg.set(id, []).get(id)!).push(e);
  for (const [id, list] of [...deg].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
    if (onlyNodeId !== undefined && id !== onlyNodeId) continue;
    if (list.length !== 1) continue;
    const node = ctx.network.nodes.get(id); if (!node || isPlannedRoadEnd(node, plannedWorld)) continue;
    const own = list[0];
    // 之前的候选可能已经接入这个端点；重新查当前图，不使用旧度数提交第二条近接路。
    if ([...ctx.network.edges.values()].filter((e) => !e.bridge && (e.from === id || e.to === id)).length !== 1) continue;
    if (![...ctx.network.edges.values()].some((edge) => {
      if (edge.bridge || edge === own || edge.from === id || edge.to === id) return false;
      const distance = polylineDistance([edge.points], node);
      return distance >= 0.5 && distance <= 24;
    })) continue;
    const world: ConnectorWorld = { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [...ctx.publicSites, ...ctx.landmarks].filter((s) => s.radius) };
    const result = runConnection({ id: `near-junction:${id}`, source: node,
      target: { kind: "edges", include: (e) => !e.bridge && e.id !== own.id && e.from !== id && e.to !== id },
      purpose: "district-access", allowBridge: false, maxLength: 24,
      roadClass: own.kind === "arterial" ? "arterial" : "local", primary: atLeast(own, "arterial"),
    }, world, { strategies: ["direct-projection"] });
    ctx.connectionLog?.push({ id: `near-junction:${id}`, purpose: "district-access", ok: result.ok,
      ...(result.ok ? { strategy: result.strategy } : { reason: result.reason, detail: result.detail }) });
    if (result.ok) joined += 1;
  }
  return joined;
}
