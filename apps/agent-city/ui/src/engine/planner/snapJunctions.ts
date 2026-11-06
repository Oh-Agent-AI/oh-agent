/** 亚单位近接端点合并；道路与 owner/车流引用在求解草稿中一起更新。 */
import { atLeast, roadWidthFor, kindOfWidth, isStandardEdge, EXPRESSWAY_DECK_WIDTH } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import type { RepairContext } from "./context";
import { commitNetworkPatch, keyOf, type Network, type NetworkPatch } from "./network";
import type { RoadEdge, RoadNode, Vec2 } from "../cityLayout";
import { polylineDistance, polylineClosest, isDry, wetCount } from "./footprint";
import { clearsRingRuns } from "./access";
import { groundJunctionFindings } from "./report";
import { groundJunctionCorridorFailure, groundJunctionCorridorViolation } from "./civicClearance";
import { runConnection } from "./connect";
import { classifyRoadSegments, closestSegmentPoints, ROAD_RELATION_CONFIG } from "./relations";
import { bridgeLandingNodes, isPlannedRoadEnd } from "./endpoints";
import { JUNCTION_CONFIG } from "./junctions";
import { siteGeometry, shoreRelocationCandidates } from "./repairs";
import { canRelocateGroundSite } from "./sitespec";
import { resolveModelEnvelope, footprintPolylineDistance } from "./modelEnvelope";

export const SNAP_JUNCTION_CONFIG = { version: 3, maxDistance: 0.5, maxShortLegMove: JUNCTION_CONFIG.minLegLength, minAngleDeg: JUNCTION_CONFIG.minAngleDeg };

/** 定线搜索不是吸附：外端点保持不变，在有限邻域内重建共享路口。 */
export const JOINT_RELINE_CONFIG = { version: 1, offsets: [2, 4, 6, 8, 10, 12] as readonly number[] };

/** Owner relocation is not a wider road snap. Only an unbound optional site
 * actually blocking a current contact may participate, within a bounded move. */
export const JOINT_JUNCTION_SITE_CONFIG = { version: 2, offsets: [1, 2, 4, 8, 12] as readonly number[], directions: 8 };
const movableJunctionSite = (site: RepairContext["publicSites"][number] | RepairContext["landmarks"][number]) =>
  canRelocateGroundSite(site)
  && !!site.id && site.radius > 0;

export function jointJunctionSiteCandidates(ctx: RepairContext): Array<{ findingId: string; ownerId: string; at: Vec2; shoreReassignment?: boolean }> {
  const out: Array<{ findingId: string; ownerId: string; at: Vec2; shoreReassignment?: boolean }> = [];
  const world = { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [] };
  const sites = [...ctx.publicSites, ...ctx.landmarks].filter(movableJunctionSite).sort((a, b) => a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0);
  for (const finding of groundJunctionFindings([...ctx.network.edges.values()])) {
    const roads = finding.edges.map((id) => ctx.network.edges.get(id)!).filter(Boolean);
    for (const site of sites) {
      if (!roads.some((road) => road.points.slice(1).some((point, k) => groundJunctionCorridorViolation(
        { ...world, reservations: () => [site] }, road.points[k], point, road.width, road)?.kind === "site-clearance"))) continue;
      const near = polylineClosest(roads.map((road) => road.points), site); if (!near) continue;
      const normal = Math.atan2(site.z - near.q.z, site.x - near.q.x);
      for (const offset of JOINT_JUNCTION_SITE_CONFIG.offsets) for (let k = 0; k < JOINT_JUNCTION_SITE_CONFIG.directions; k += 1) {
        const angle = normal + k * Math.PI / 4;
        out.push({ findingId: finding.id, ownerId: site.id!, at: keyOf({ x: site.x + offset * Math.cos(angle), z: site.z + offset * Math.sin(angle) }) });
      }
      // Reuse the existing bounded coastal reassignment tier, not a larger
      // road snap. Pre-screen it before expensive transaction cloning.
      const seen = new Set<string>();
      const others = [...ctx.publicSites, ...ctx.landmarks].filter((other) => other !== site && other.radius);
      for (const candidate of shoreRelocationCandidates(ctx, site, siteGeometry(ctx, site.id), others)) {
        const at = keyOf(candidate), key = `${at.x}:${at.z}`;
        if (seen.has(key)) continue; seen.add(key);
        if (relocatedSitePositionFailure(ctx, site, at, true)) continue;
        out.push({ findingId: finding.id, ownerId: site.id!, at, shoreReassignment: true });
      }
    }
  }
  return out;
}

/** Run only on a solve draft: the outer acceptance gate publishes the owner,
 * network and reference remaps together, or discards all of them. */
export function moveJunctionSite(ctx: RepairContext, findingId: string, ownerId: string, at: Vec2, shoreReassignment = false): { changes: number; reason?: string } {
  const owners = [...ctx.publicSites, ...ctx.landmarks].filter((site) => site.id === ownerId);
  const owner = owners[0];
  if (owners.length !== 1 || !movableJunctionSite(owner) || !groundJunctionFindings([...ctx.network.edges.values()]).some((finding) => finding.id === findingId)) return { changes: 0 };
  const distance = Math.hypot(owner.x - at.x, owner.z - at.z);
  if (!Number.isFinite(distance) || distance <= 0 || (!shoreReassignment && distance > 12.02)) return { changes: 0, reason: "owner-move-budget" };
  if (shoreReassignment) {
    const others = [...ctx.publicSites, ...ctx.landmarks].filter((site) => site !== owner && site.radius);
    let declared = false;
    for (const candidate of shoreRelocationCandidates(ctx, owner, siteGeometry(ctx, ownerId), others)) {
      const point = keyOf(candidate); if (point.x === at.x && point.z === at.z) { declared = true; break; }
    }
    if (!declared) return { changes: 0, reason: "undeclared-shore-reassignment" };
  }
  const failure = relocatedSitePositionFailure(ctx, owner, at, shoreReassignment);
  if (failure) return { changes: 0, reason: failure };
  const old = { x: owner.x, z: owner.z };
  owner.x = at.x; owner.z = at.z;
  const changes = snapNearEdgeJunctions(ctx, false, findingId) || snapNearEdgeJunctions(ctx, true, findingId);
  if (!changes || groundJunctionFindings([...ctx.network.edges.values()]).some((finding) => finding.id === findingId)) {
    owner.x = old.x; owner.z = old.z; return { changes: 0, reason: "joint-owner-junction-refused" };
  }
  return { changes };
}

export function relocatedSitePositionFailure(ctx: RepairContext, owner: RepairContext["publicSites"][number] | RepairContext["landmarks"][number], at: Vec2,
  shoreReassignment: boolean): string | null {
  const old = { x: owner.x, z: owner.z }, shore = ctx.SHORE_SITE_KINDS.has(owner.kind);
  const riverBank = (x: number, z: number, bank: number) => ctx.geo.hasRiver && Math.abs(x - ctx.geo.riverX(z)) < ctx.geo.riverWidth(z) + bank;
  const geo = { height: ctx.geo.height, inRiver: ctx.inRiver, riverBank };
  if (shore ? wetCount(geo, at, owner.radius, { river: true, riverBank: 14 }) > 3 || ctx.geo.height(at.x, at.z) <= 0.5
    || ctx.geo.coastDistance(at.x, at.z) > Math.max(owner.radius * (shoreReassignment ? 2 : 0.7), ctx.geo.coastDistance(old.x, old.z))
    : !ctx.geo.buildable(at.x, at.z) || !isDry(geo, at, owner.radius)) return "owner-footprint-unsafe";
  const envelope = resolveModelEnvelope({ ...owner, ...at });
  const declaredXY = envelope.status === "partial" && envelope.relocationCorridorEnvelope?.schemaVersion === 1
    && envelope.relocationCorridorEnvelope.coverage === "complete-conservative-renderer-xy";
  const projectionClear = (points: readonly Vec2[], required: number) => {
    if (envelope.status !== "partial") return false;
    const distance = footprintPolylineDistance(envelope.conservativeProjection, points);
    return Number.isFinite(distance) && distance >= required;
  };
  // Same accepted deck width and sidewalk setback; change only the explicitly
  // declared complete XY obstacle, never the shore/plot/service constraints.
  if (declaredXY ? ctx.ringRuns.some(run => !projectionClear(run, EXPRESSWAY_DECK_WIDTH / 2 + 1))
    : !clearsRingRuns(at, owner.radius * 2, owner.radius * 2, ctx.ringRuns)) return "owner-highway-clearance";
  if ([...ctx.publicSites, ...ctx.landmarks].some((other) => other !== owner
    && Math.hypot(other.x - at.x, other.z - at.z) < other.radius + owner.radius)) return "owner-spacing";
  // Generic sites keep the existing full capsule r + width/2 + 3 contract;
  // no other untouched road may become a new obstacle to the moved owner.
  const roads = [...ctx.network.edges.values()];
  if (roads.some((road) => declaredXY ? !projectionClear(road.points, road.width / 2 + 3)
    : polylineDistance([road.points], at) < owner.radius + road.width / 2 + 3)) return "owner-road-envelope";
  if (shoreReassignment && polylineDistance(roads.filter((road) => !road.bridge).map((road) => road.points), at) > owner.radius + 20) return "owner-access-too-far";
  return null;
}

/** Reconstruct the existing terminal corridor, rather than adding a short
 * parallel connector. This budget is separate from the 0.5-unit snap rule. */
export function endpointRelineCandidates(ctx: RepairContext, sourceId: string): Array<{ hostId: string; at: Vec2 }> {
  const source = ctx.network.nodes.get(sourceId);
  const own = [...ctx.network.edges.values()].filter((edge) => edge.from === sourceId || edge.to === sourceId);
  if (!source || sourceId === ctx.primaryAnchorNodeId || ![1, 2].includes(own.length)
    || own.some(edge => edge.bridge || edge.structure !== "ground-road" || edge.points.length !== 2)
    || [...ctx.publicSites, ...ctx.landmarks].some((site) => site.access?.nodeId === sourceId)) return [];
  const candidates: Array<{ hostId: string; at: Vec2 }> = [];
  if (own.length === 2) {
    // A degree-two bend may have a near-coincident common stem with a wider
    // host. Realign to the host's existing junction, never widen the snap or
    // delete an independent branch. Strict coalescing preserves both lineages.
    for (const host of ctx.network.edges.values()) {
      if (host.bridge || host.structure !== "ground-road" || host.points.length !== 2 || own.some(edge => edge.id === host.id)
        || host.from === sourceId || host.to === sourceId || polylineDistance([host.points], source) > SNAP_JUNCTION_CONFIG.maxDistance) continue;
      const stem = own.find(edge => {
        const far = edge.from === sourceId ? edge.to : edge.from;
        return (far === host.from || far === host.to) && edge.width <= host.width
          && (edge.kind !== "arterial" || host.kind === "arterial") && edge.purpose === host.purpose;
      });
      if (!stem) continue;
      const common = stem.from === sourceId ? stem.to : stem.from;
      const target = ctx.network.nodes.get(host.from === common ? host.to : host.from);
      if (!target) continue;
      const distance = Math.hypot(target.x - source.x, target.z - source.z);
      if (distance <= SNAP_JUNCTION_CONFIG.maxDistance || distance > 24) continue;
      candidates.push({ hostId: host.id, at: { x: target.x, z: target.z } });
    }
    return candidates.sort((a, b) => Math.hypot(a.at.x - source.x, a.at.z - source.z) - Math.hypot(b.at.x - source.x, b.at.z - source.z)
      || (a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : 0)).slice(0, 16);
  }
  for (const host of ctx.network.edges.values()) {
    if (host.bridge || host.id === own[0].id || host.from === sourceId || host.to === sourceId) continue;
    for (let k = 1; k < host.points.length; k += 1) {
      const a = host.points[k - 1], b = host.points[k], dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      if (!length) continue;
      const nearest = Math.max(0, Math.min(1, ((source.x - a.x) * dx + (source.z - a.z) * dz) / (length * length)));
      for (const offset of [0, -6, 6, -12, 12, -18, 18]) {
        const t = Math.max(0, Math.min(1, nearest + offset / length));
        const at = keyOf({ x: a.x + t * dx, z: a.z + t * dz });
        const distance = Math.hypot(source.x - at.x, source.z - at.z);
        if (distance <= SNAP_JUNCTION_CONFIG.maxDistance || distance > 24) continue;
        if (candidates.some((candidate) => candidate.hostId === host.id && candidate.at.x === at.x && candidate.at.z === at.z)) continue;
        candidates.push({ hostId: host.id, at });
      }
    }
  }
  return candidates.sort((a, b) => Math.hypot(a.at.x - source.x, a.at.z - source.z) - Math.hypot(b.at.x - source.x, b.at.z - source.z)
    || (a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : a.at.x - b.at.x || a.at.z - b.at.z)).slice(0, 16);
}

export function relineLooseEndpoint(ctx: RepairContext, sourceId: string, hostId: string, at: Vec2): number {
  const source = ctx.network.nodes.get(sourceId), host = ctx.network.edges.get(hostId);
  if (!source || !host || !endpointRelineCandidates(ctx, sourceId).some((candidate) => candidate.hostId === hostId
    && candidate.at.x === at.x && candidate.at.z === at.z)) return 0;
  const target = { ...at, id: `${at.x}:${at.z}` };
  const endpoint = target.id === host.from || target.id === host.to;
  return commitSnap(ctx, source, target, endpoint ? [] : [{ edgeId: host.id, at }], true) ? 1 : 0;
}

function safeLegDirections(at: Vec2, points: Vec2[]): boolean {
  const directions = points.map((p) => ({ x: p.x - at.x, z: p.z - at.z }));
  if (directions.some((d) => Math.hypot(d.x, d.z) < JUNCTION_CONFIG.minLegLength)) return false;
  for (let i = 0; i < directions.length; i += 1) for (let j = i + 1; j < directions.length; j += 1) {
    const a = directions[i], b = directions[j];
    if ((a.x * b.x + a.z * b.z) / (Math.hypot(a.x, a.z) * Math.hypot(b.x, b.z))
      > Math.cos(JUNCTION_CONFIG.minAngleDeg * Math.PI / 180)) return false;
  }
  return true;
}

export function jointGroundRelineCandidates(ctx: RepairContext): Array<{ edges: [string, string]; at: Vec2 }> {
  const candidates: Array<{ edges: [string, string]; at: Vec2 }> = [];
  for (const finding of groundJunctionFindings([...ctx.network.edges.values()])) {
    const pair = finding.edges.map((id) => ctx.network.edges.get(id));
    if (pair.some((edge) => !edge || edge.bridge || edge.structure !== "ground-road" || edge.points.length !== 2)) continue;
    const a = pair[0]!, b = pair[1]!;
    if (new Set([a.from, a.to, b.from, b.to]).size !== 4) continue;
    const relation = classifyRoadSegments(a.points[0], a.points[1], b.points[0], b.points[1]);
    if (relation.kind !== "interior-crossing") continue;
    for (const radius of JOINT_RELINE_CONFIG.offsets) for (let k = 0; k < 8; k += 1) {
      const angle = k * Math.PI / 4;
      const at = keyOf({ x: relation.a.point.x + radius * Math.cos(angle), z: relation.a.point.z + radius * Math.sin(angle) });
      if (!safeLegDirections(at, [...a.points, ...b.points])) continue;
      candidates.push({ edges: [a.id, b.id], at });
    }
  }
  return candidates;
}

export function relineGroundJunction(ctx: RepairContext, ids: [string, string], at: Vec2): { changes: number; reason?: string } {
  const pair = ids.map((id) => ctx.network.edges.get(id));
  if (pair.some((edge) => !edge || edge.bridge || edge.structure !== "ground-road" || edge.points.length !== 2)) return { changes: 0 };
  const parents = pair as RoadEdge[];
  if (!safeLegDirections(at, parents.flatMap((edge) => edge.points))) return { changes: 0, reason: "junction-angle" };
  const before = groundJunctionFindings([...ctx.network.edges.values()]);
  const preserved = new Set(before.filter((finding) => !finding.edges.some((id) => ids.includes(id))).map((finding) => finding.id));
  const result = commitNetworkPatch(ctx.network, { baseVersion: ctx.network.version,
    addEdges: [], removeEdgeIds: [], splits: [], relineSplits: ids.map((edgeId) => ({ edgeId, at })) }, (draft) => {
    const nodeId = `${at.x}:${at.z}`;
    const legs = [...draft.edges.values()].filter((edge) => edge.from === nodeId || edge.to === nodeId);
    if (legs.length !== 4) return "joint reline needs exactly four ground legs";
    const world = { network: draft, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [...ctx.publicSites, ...ctx.landmarks] };
    for (const edge of legs) {
      const parent = parents.find((old) => [old.from, old.to].some((id) => id === edge.from || id === edge.to))!;
      const failure = groundJunctionCorridorViolation(world, edge.points[0], edge.points[1], edge.width, parent);
      if (failure) return `joint reline corridor unsafe: ${failure.kind}/${failure.cause}${failure.at ? ` at ${failure.at.x}:${failure.at.z}` : ""}`;
      if (ctx.blocks.some((block) => block.parcels.some((parcel) => polylineDistance([edge.points], parcel)
        < Math.hypot(parcel.width, parcel.depth) / 2 + edge.width / 2 + 0.5))) return "joint reline parcel clearance";
      const endpointId = edge.from === nodeId ? edge.to : edge.from;
      const endpoint = draft.nodes.get(endpointId)!;
      const neighbors = [...draft.edges.values()].filter((other) => other.from === endpointId || other.to === endpointId);
      const newPoint = edge.from === endpointId ? edge.points[1] : edge.points[edge.points.length - 2];
      // Reject new acute endpoint joins too; unrelated pre-existing neighbor
      // pairs are not changed by this patch and remain the solve gate's concern.
      for (const other of neighbors.filter((road) => road !== edge)) {
        const p = other.from === endpointId ? other.points[1] : other.points[other.points.length - 2];
        if (!safeLegDirections(endpoint, [newPoint, p])) return "joint reline remote junction angle";
      }
    }
    const after = groundJunctionFindings([...draft.edges.values()]);
    if (after.length >= before.length || after.some((finding) => !preserved.has(finding.id))) return "joint reline introduced a road relation";
    return null;
  });
  return result.ok ? { changes: 1 } : { changes: 0, reason: result.detail ?? result.reason };
}

export function rebindJunctionReferences(ctx: RepairContext, source: RoadNode, target: RoadNode): void {
  for (const site of [...ctx.publicSites, ...ctx.landmarks]) if (site.access?.nodeId === source.id) site.access.nodeId = target.id;
  for (const route of [...ctx.carPaths, ...ctx.coastRoadRuns, ...ctx.riverRoadRuns]) {
    for (let k = 0; k < route.length; k += 1) if (route[k].x === source.x && route[k].z === source.z) route[k] = { x: target.x, z: target.z };
    for (let k = route.length - 1; k > 0; k -= 1) if (route[k].x === route[k - 1].x && route[k].z === route[k - 1].z) route.splice(k, 1);
  }
  for (let k = 0; k < ctx.coastRoadRunEnds.length; k += 1) if (ctx.coastRoadRunEnds[k].x === source.x && ctx.coastRoadRunEnds[k].z === source.z) ctx.coastRoadRunEnds[k] = { x: target.x, z: target.z };
}

function commitSnap(ctx: RepairContext, source: RoadNode, target: RoadNode, splits: NetworkPatch["splits"] = [], coalesceStraightGround = false): boolean {
  const incident = [...ctx.network.edges.values()].filter((edge) => [edge.from, edge.to].some((id) => id === source.id || id === target.id));
  // 只禁止移动「桥头」本身（source 带桥：重绑会把桥端挪走）。把普通路端吸到桥头上（target 带桥）不动桥：
  // survey seed 2004608076 t1 的 12 宽干道端点离桥头 2.2、离桥头引道 0.5，曾因 target 带桥被拒，未接路口修不上。
  // 角度、短腿、走廊与交叉校验照旧。
  if (source.id === ctx.primaryAnchorNodeId || incident.some((edge) => edge.bridge && (edge.from === source.id || edge.to === source.id))) return false;
  // Two near junctions may already be joined by a sub-unit connector. Rebinding
  // them would turn that edge into a self-loop, so remove only that collapsed
  // connector in the same atomic patch (never a bridge or a longer road).
  const nodeGap = Math.hypot(source.x - target.x, source.z - target.z);
  const collapsedConnectors = incident.filter((edge) =>
    ((edge.from === source.id && edge.to === target.id) || (edge.to === source.id && edge.from === target.id))
      && !edge.bridge && edge.points.length === 2
      && Math.hypot(edge.points[1].x - edge.points[0].x, edge.points[1].z - edge.points[0].z) <= SNAP_JUNCTION_CONFIG.maxDistance);
  if (incident.some((edge) => ((edge.from === source.id && edge.to === target.id) || (edge.to === source.id && edge.from === target.id))
    && !collapsedConnectors.includes(edge))) return false;
  // Close nodes with a common neighbor create the same canonical edge on rebind.
  // Resolve compatible straight duplicates in this transaction, retaining the wider corridor.
  const removeEdgeIds: string[] = collapsedConnectors.map((edge) => edge.id);
  if (nodeGap <= SNAP_JUNCTION_CONFIG.maxDistance) {
    for (const edge of incident.filter((e) => e.from === source.id || e.to === source.id)) {
      const other = edge.from === source.id ? edge.to : edge.from;
      const duplicate = incident.find((e) => e !== edge && ((e.from === target.id && e.to === other) || (e.to === target.id && e.from === other)));
      if (!duplicate || edge.points.length !== 2 || duplicate.points.length !== 2
        || (edge.structure ?? "ground-road") !== (duplicate.structure ?? "ground-road")) continue;
      const preferred = [edge, duplicate].sort((a, b) => b.width - a.width || Number(b.kind === "arterial") - Number(a.kind === "arterial") || (a.id < b.id ? -1 : 1));
      removeEdgeIds.push(preferred[1].id);
    }
  }
  const originalHosts = new Map(splits.map((split) => [split.edgeId, ctx.network.edges.get(split.edgeId)!]));
  const world = { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [...ctx.publicSites, ...ctx.landmarks] };
    const changedEdges = [...incident, ...originalHosts.values()].filter((edge) => edge.from === source.id || edge.to === source.id || splits.some((split) => split.edgeId === edge.id));
    const remappedIds = (id: string) => {
      const edge = ctx.network.edges.get(id)!;
      const from = edge.from === source.id ? target.id : edge.from, to = edge.to === source.id ? target.id : edge.to;
      return splits.some((split) => split.edgeId === id) ? [[from, target.id].sort().join("/"), [target.id, to].sort().join("/")] : [[from, to].sort().join("/")];
    };
    const existingCrossings = new Set(groundJunctionFindings([...ctx.network.edges.values()]).flatMap((finding) => remappedIds(finding.edges[0]).flatMap((a) => remappedIds(finding.edges[1]).map((b) => [a, b].sort().join("|")))));
    const result = commitNetworkPatch(ctx.network, { baseVersion: ctx.network.version,
      removeEdgeIds, splits, addEdges: [], rebindNodes: [{ from: source.id, to: target.id, coalesceStraightGround }] }, (draft) => {
      const legs = [...draft.edges.values()].filter((edge) => edge.from === target.id || edge.to === target.id);
      if (groundJunctionFindings([...draft.edges.values()]).some((finding) => !existingCrossings.has([...finding.edges].sort().join("|")))) return "snap introduced a new crossing";
      if (legs.length < 2) return "snap needs a real road continuation";
      for (const edge of legs) {
        // 桥腿只会出现在 target 一侧（source 带桥已在上面拒绝），重绑不改它的端点：不是地面路，不走地面走廊校验。
        if (edge.bridge) continue;
        const parent = [...incident, ...originalHosts.values()].find((old) => remappedIds(old.id).includes(edge.id)) ?? edge;
        // 用地净距只要求「不比原来更差」：腿的父边本来就压进用地净距时（survey seed 2004608076 t1：桥头引道离
        // riverside-park 中心 46.48，半径 47），吸附即使不碰它的几何也会因重新校验这条旧违例被拒，未接路口永远修不上。
        // 父边已有 site-clearance 违例时同类违例放行；其余（坡度、可建、交叉、角度、地块）照旧。
        const parentSiteViolation = parent.points.slice(1).some((point, k) => groundJunctionCorridorViolation(world, parent.points[k], point, parent.width, parent)?.kind === "site-clearance");
        for (let k = 1; k < edge.points.length; k += 1) {
          const failure = groundJunctionCorridorViolation(world, edge.points[k - 1], edge.points[k], edge.width, parent);
          if (failure && !(failure.kind === "site-clearance" && parentSiteViolation)) return `snap corridor unsafe: ${failure.kind}/${failure.cause}${failure.at ? ` at ${failure.at.x}:${failure.at.z}` : ""} on ${edge.id}`;
        }
        if (changedEdges.some((old) => old.from === edge.from || old.to === edge.to || old.from === edge.to || old.to === edge.from)) {
          for (const parcel of ctx.blocks.flatMap((block) => block.parcels)) if (polylineDistance([edge.points], parcel) < Math.hypot(parcel.width, parcel.depth) / 2 + edge.width / 2 + 0.5) return "snap parcel clearance";
        }
      }
      const directions = legs.map((edge) => { const point = edge.from === target.id ? edge.points[1] : edge.points[edge.points.length - 2]; return { edge, point, direction: { x: point.x - target.x, z: point.z - target.z } }; });
      for (const leg of directions) {
        const length = Math.hypot(leg.direction.x, leg.direction.z);
        const old = incident.find((edge) => remappedIds(edge.id).includes(leg.edge.id));
        const oldLength = old ? Math.hypot(old.points[1].x - old.points[0].x, old.points[1].z - old.points[0].z) : Infinity;
        // A merge may preserve a pre-existing short junction leg, but it may
        // not create one or make the existing leg materially shorter.
        if (length < 3 && !(nodeGap <= SNAP_JUNCTION_CONFIG.maxDistance && oldLength < 3
          && length > 1e-6 && length + nodeGap >= oldLength - 1e-6)) return "snap junction angle";
      }
      for (let p = 0; p < directions.length; p += 1) for (let q = p + 1; q < directions.length; q += 1) {
        const u = directions[p].direction, v = directions[q].direction, lu = Math.hypot(u.x, u.z), lv = Math.hypot(v.x, v.z);
        if ((u.x * v.x + u.z * v.z) / (lu * lv) > Math.cos(SNAP_JUNCTION_CONFIG.minAngleDeg * Math.PI / 180)) return "snap junction angle";
      }
      return null;
    });
    if (!result.ok) {
      const reason = result.detail?.includes("site-clearance") || result.detail?.includes("parcel clearance") ? "site-clearance" : result.detail?.includes("angle") ? "junction-angle" : result.detail?.includes("crossing") ? "crossing" : "projection-loss";
      ctx.connectionLog?.push({ id: `junction-snap:${source.id}/${target.id}`, purpose: "district-access", ok: false, reason, detail: result.detail ?? result.reason });
      return false;
    }
    rebindJunctionReferences(ctx, source, target);
    // 拆分的宿主路径也插入同一节点，不能等最终展示时再过滤掉旧引用。
    for (const split of splits) {
      const host = originalHosts.get(split.edgeId)!;
      for (const route of [...ctx.carPaths, ...ctx.coastRoadRuns, ...ctx.riverRoadRuns]) for (let k = route.length - 1; k > 0; k -= 1) {
        const a = route[k - 1], b = route[k];
        for (let p = 1; p < host.points.length; p += 1) {
          const u = host.points[p - 1], v = host.points[p];
          if ((a.x === u.x && a.z === u.z && b.x === v.x && b.z === v.z) || (a.x === v.x && a.z === v.z && b.x === u.x && b.z === u.z)) {
            if ((split.at.x !== a.x || split.at.z !== a.z) && (split.at.x !== b.x || split.at.z !== b.z)) route.splice(k, 0, { ...split.at });
          }
        }
      }
    }
    return true;
}

export function snapNearJunctions(ctx: RepairContext): number {
  const nodes = [...ctx.network.nodes.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let changed = 0;
  for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
    const a = nodes[i], b = nodes[j];
    if (!ctx.network.nodes.has(a.id) || !ctx.network.nodes.has(b.id)) continue;
    const distance = Math.hypot(a.x - b.x, a.z - b.z);
    if (distance <= 0 || distance > SNAP_JUNCTION_CONFIG.maxDistance) continue;
    if ([...ctx.network.edges.values()].some((edge) => (edge.from === a.id && edge.to === b.id) || (edge.from === b.id && edge.to === a.id))) continue;
    const target = ctx.primaryAnchorNodeId === b.id ? b : a;
    if (commitSnap(ctx, target === a ? b : a, target)) changed += 1;
  }
  return changed;
}

/** 折叠同一路口上几何重合的平行支路，合并远端节点并保留两侧支路。 */
export function mergeCoincidentJunctionLegs(ctx: RepairContext, junctionId: string): boolean {
  const junction = ctx.network.nodes.get(junctionId);
  if (!junction) return false;
  const incident = [...ctx.network.edges.values()].filter((edge) => edge.from === junctionId || edge.to === junctionId);
  const outward = (edge: typeof incident[number]) => {
    const at = edge.from === junctionId ? edge.points[0] : edge.points[edge.points.length - 1];
    const far = edge.from === junctionId ? edge.points[1] : edge.points[edge.points.length - 2];
    return { at, far, angle: Math.atan2(far.z - at.z, far.x - at.x), farId: edge.from === junctionId ? edge.to : edge.from };
  };
  const angleGap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  for (let i = 0; i < incident.length; i += 1) for (let j = i + 1; j < incident.length; j += 1) {
    const pair = [incident[i], incident[j]];
    if (pair.some((edge) => edge.bridge || edge.points.length !== 2)) continue;
    const ends = pair.map(outward);
    if (angleGap(ends[0].angle, ends[1].angle) > (15 * Math.PI) / 180) continue;
    if (Math.hypot(ends[0].far.x - ends[1].far.x, ends[0].far.z - ends[1].far.z) > SNAP_JUNCTION_CONFIG.maxDistance) continue;
    const ranked = pair.map((edge, index) => ({ edge, end: ends[index], degree: [...ctx.network.edges.values()].filter((other) => other.from === ends[index].farId || other.to === ends[index].farId).length }))
      .sort((a, b) => b.edge.width - a.edge.width || Number(b.edge.kind === "arterial") - Number(a.edge.kind === "arterial") || b.degree - a.degree || (a.edge.id < b.edge.id ? -1 : 1));
    const host = ranked[0], victim = ranked[1];
    const sourceId = victim.end.farId, targetId = host.end.farId;
    if (sourceId === ctx.primaryAnchorNodeId || targetId === ctx.primaryAnchorNodeId || sourceId === targetId) continue;
    const sourceEdges = [...ctx.network.edges.values()].filter((edge) => edge.from === sourceId || edge.to === sourceId);
    const targetEdges = [...ctx.network.edges.values()].filter((edge) => edge.from === targetId || edge.to === targetId);
    if (sourceEdges.some((edge) => edge.bridge) || targetEdges.some((edge) => edge.bridge)) continue;
    if (sourceEdges.some((edge) => edge !== victim.edge && (edge.from === targetId || edge.to === targetId))) continue;
    const source = ctx.network.nodes.get(sourceId), target = ctx.network.nodes.get(targetId);
    if (!source || !target) continue;
    const bindings: NetworkPatch["rebindNodes"] = [{ from: sourceId, to: targetId }];
    const result = commitNetworkPatch(ctx.network, {
      baseVersion: ctx.network.version,
      removeEdgeIds: [victim.edge.id], removeNodeIds: [], splits: [], addEdges: [], rebindNodes: bindings,
    }, (draft) => {
      const changedIds = sourceEdges.filter((edge) => edge.id !== victim.edge.id).map((edge) => [edge.from === sourceId ? targetId : edge.from, edge.to === sourceId ? targetId : edge.to].sort().join("/"));
      const changed = changedIds.map((id) => draft.edges.get(id)).filter((edge): edge is NonNullable<typeof edge> => !!edge);
      const world = { network: draft, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [...ctx.publicSites, ...ctx.landmarks] };
      for (const edge of changed) if (!edge.bridge) {
        for (let k = 1; k < edge.points.length; k += 1) {
          const failure = groundJunctionCorridorFailure(world, edge.points[k - 1], edge.points[k], edge.width, edge);
          if (failure) return `coincident-leg merge corridor unsafe: ${failure} on ${edge.id}`;
        }
        if (ctx.blocks.some((block) => block.parcels.some((parcel) => polylineDistance([edge.points], parcel) < Math.hypot(parcel.width, parcel.depth) / 2 + edge.width / 2 + 0.5))) return "coincident-leg merge parcel clearance";
      }
      const legs = [...draft.edges.values()].filter((edge) => edge.from === targetId || edge.to === targetId);
      const dirs = legs.map((edge) => { const p = edge.from === targetId ? edge.points[1] : edge.points[edge.points.length - 2]; return { x: p.x - target.x, z: p.z - target.z }; });
      for (let a = 0; a < dirs.length; a += 1) for (let b = a + 1; b < dirs.length; b += 1) {
        const u = dirs[a], v = dirs[b], lu = Math.hypot(u.x, u.z), lv = Math.hypot(v.x, v.z);
        if (lu < 3 || lv < 3 || (u.x * v.x + u.z * v.z) / (lu * lv) > Math.cos(SNAP_JUNCTION_CONFIG.minAngleDeg * Math.PI / 180)) return "coincident-leg merge junction angle";
      }
      return null;
    });
    if (!result.ok) continue;
    rebindJunctionReferences(ctx, source, target);
    return true;
  }
  return false;
}

/** 端点贴近实际路段，但其两个注册节点相距更远：内段拆T，短残段则合并邻端。 */
export function snapNearEdgeJunctions(ctx: RepairContext, preferHost = false, onlyFindingId?: string): number {
  let changed = 0;
  for (const finding of groundJunctionFindings([...ctx.network.edges.values()])) {
    if (onlyFindingId !== undefined && finding.id !== onlyFindingId) continue;
    const pair = finding.edges.map((id) => ctx.network.edges.get(id));
    if (pair.some((edge) => !edge || edge.bridge)) continue;
    let accepted = false;
    for (const [own, host] of [[pair[0]!, pair[1]!], [pair[1]!, pair[0]!]]) {
      if (accepted) break;
      for (const id of [own.from, own.to]) {
        const source = ctx.network.nodes.get(id); if (!source || source.id === host.from || source.id === host.to) continue;
        for (let k = 1; k < host.points.length && !accepted; k += 1) {
          const a = host.points[k - 1], b = host.points[k], dx = b.x - a.x, dz = b.z - a.z;
          const t = Math.max(0, Math.min(1, ((source.x - a.x) * dx + (source.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
          const at = keyOf({ x: a.x + t * dx, z: a.z + t * dz });
          if (Math.hypot(source.x - at.x, source.z - at.z) > SNAP_JUNCTION_CONFIG.maxDistance) continue;
          const nearby = [host.from, host.to].map((node) => ctx.network.nodes.get(node)!)
            .filter((node) => Math.hypot(node.x - at.x, node.z - at.z) < SNAP_JUNCTION_CONFIG.maxShortLegMove)
            .sort((u, v) => Math.hypot(u.x - at.x, u.z - at.z) - Math.hypot(v.x - at.x, v.z - at.z) || (u.id < v.id ? -1 : 1));
          if (nearby.length) {
            const target = nearby[0];
            if (Math.hypot(source.x - target.x, source.z - target.z) <= SNAP_JUNCTION_CONFIG.maxShortLegMove) {
              // Keep the wide incoming leg fixed when moving it would disturb
              // its remote junction; rebind both host legs as one alternative.
              const moveHost = preferHost || source.id === ctx.primaryAnchorNodeId;
              accepted = moveHost ? commitSnap(ctx, target, source) : commitSnap(ctx, source, target);
            }
          } else {
            // A split child can coincide with a rebound incoming leg. Use the
            // patch's strict straight-ground coalescing: exact shape, matching
            // purpose/structure, both lineages and the widest class survive.
            accepted = commitSnap(ctx, source, { ...at, id: `${at.x}:${at.z}` }, [{ edgeId: host.id, at }], true);
          }
          if (accepted) { changed += 1; break; }
        }
        if (accepted) break;
      }
    }
  }
  return changed;
}

/** 交点邻近尽端时，移动尽端并拆分宿主为T，避免四岔产生小于3单位的残段。 */
export function snapShortCrossings(ctx: RepairContext): number {
  let changed = 0;
  for (const finding of groundJunctionFindings([...ctx.network.edges.values()])) {
    const edges = finding.edges.map((id) => ctx.network.edges.get(id));
    if (edges.some((edge) => !edge || edge.bridge)) continue;
    const a = edges[0]!, b = edges[1]!;
    let accepted = false;
    for (let i = 1; i < a.points.length && !accepted; i += 1) for (let j = 1; j < b.points.length && !accepted; j += 1) {
      const p = a.points[i - 1], q = b.points[j - 1];
      const ux = a.points[i].x - p.x, uz = a.points[i].z - p.z, vx = b.points[j].x - q.x, vz = b.points[j].z - q.z;
      const denominator = ux * vz - uz * vx;
      if (Math.abs(denominator) < 1e-9) continue;
      const dx = q.x - p.x, dz = q.z - p.z;
      const t = (dx * vz - dz * vx) / denominator, s = (dx * uz - dz * ux) / denominator;
      if (t <= 0 || t >= 1 || s <= 0 || s >= 1) continue;
      const at = keyOf({ x: p.x + t * ux, z: p.z + t * uz }), target = { ...at, id: `${at.x}:${at.z}` };
      const candidates = [a, b].flatMap((edge) => [edge.from, edge.to].map((id) => ({ source: ctx.network.nodes.get(id)!, host: edge === a ? b : a })))
        .filter(({ source }) => Math.hypot(source.x - at.x, source.z - at.z) > 0 && Math.hypot(source.x - at.x, source.z - at.z) < SNAP_JUNCTION_CONFIG.maxShortLegMove)
        .sort((x, y) => Math.hypot(x.source.x - at.x, x.source.z - at.z) - Math.hypot(y.source.x - at.x, y.source.z - at.z) || (x.source.id < y.source.id ? -1 : 1));
      for (const { source, host } of candidates) {
        if (commitSnap(ctx, source, target, [{ edgeId: host.id, at }])) { changed += 1; accepted = true; break; }
      }
    }
  }
  return changed;
}

/** Replace an unreferenced ground corridor when its crossing cannot be joined safely.
 * Endpoints/graph role stay fixed; the connector searches a legal route around the
 * crossing, then the ordinary solve acceptance gate checks all city invariants. */
export function rerouteUnsafeGroundCrossings(ctx: RepairContext): { changes: number; reason?: string } {
  const edgeIsReferenced = (edge: RoadEdge): boolean => {
    const samePoint = (a: Vec2, b: Vec2) => a.x === b.x && a.z === b.z;
    const [a, b] = edge.points;
    const inRuns = [...ctx.carPaths, ...ctx.coastRoadRuns, ...ctx.riverRoadRuns].some((run) => run.some((point, i) => i > 0
      && ((samePoint(run[i - 1], a) && samePoint(point, b)) || (samePoint(run[i - 1], b) && samePoint(point, a)))));
    if (inRuns) return true;
    return ctx.blocks.some((block) => block.polygon.some((point, i) => {
      const next = block.polygon[(i + 1) % block.polygon.length];
      return (samePoint(point, a) && samePoint(next, b)) || (samePoint(point, b) && samePoint(next, a));
    }));
  };
  const attempted = new Set((ctx.connectionLog ?? []).map((entry) => entry.id));
  let changes = 0;
  const rejected: string[] = [];
  const maxCandidates = 3;
  let considered = 0;
  for (const finding of groundJunctionFindings([...ctx.network.edges.values()])) {
    if (considered >= maxCandidates) break;
    const candidates = finding.edges.map((id) => ctx.network.edges.get(id)).filter((edge): edge is NonNullable<typeof edge> => !!edge)
      .filter((edge) => !edge.bridge && edge.structure === "ground-road" && edge.points.length === 2
        && isStandardEdge(edge)
        && !edgeIsReferenced(edge) && !attempted.has(`reroute-crossing:${edge.id}`))
      .sort((a, b) => a.width - b.width || (a.id < b.id ? -1 : 1));
    for (const edge of candidates) {
      if (considered >= maxCandidates) break;
      considered += 1;
      const attemptId = `reroute-crossing:${edge.id}`;
      const originalFindingCount = groundJunctionFindings([...ctx.network.edges.values()]).length;
      let accepted = false;
      const directions = [[edge.from, edge.to], [edge.to, edge.from]] as const;
      for (const [sourceId, targetId] of directions) {
        const source = ctx.network.nodes.get(sourceId), target = ctx.network.nodes.get(targetId);
        if (!source || !target) continue;
        const staged: Network = {
          version: 0,
          nodes: new Map([...ctx.network.nodes].map(([id, node]) => [id, { ...node }])),
          edges: new Map([...ctx.network.edges].filter(([id]) => id !== edge.id).map(([id, road]) => [id, { ...road, points: road.points.map((point) => ({ ...point })) }])),
        };
        staged.version = ctx.network.version;
        const world = { network: staged, geo: ctx.geo, inRiver: ctx.inRiver,
          reservations: () => [...ctx.publicSites, ...ctx.landmarks] };
        const result = runConnection({ id: attemptId, source: { x: source.x, z: source.z }, target: { kind: "node", id: targetId },
          purpose: "district-access", allowBridge: false, maxLength: Math.min(700, Math.max(160, Math.hypot(target.x - source.x, target.z - source.z) * 2.5)),
          roadClass: kindOfWidth(edge.width), primary: atLeast(edge, "arterial") }, world,
        { strategies: ["direct-projection", "node-merge", "detour", "grid-astar"], crossings: true });
        if (!result.ok) { rejected.push(`${edge.id}:${result.detail ?? result.reason}`); continue; }
        const preserved = new Set(groundJunctionFindings([...ctx.network.edges.values()])
          .filter((old) => !old.edges.includes(edge.id)).map((old) => [...old.edges].sort().join("|")));
        const after = groundJunctionFindings([...staged.edges.values()]);
        if (after.length >= originalFindingCount || after.some((next) => !preserved.has([...next.edges].sort().join("|")))) {
          rejected.push(`${edge.id}:replacement did not strictly reduce crossings without adding a relation (${after.map((finding) => finding.id).slice(0, 2).join("; ") || "no findings but count guard failed"})`);
          continue;
        }
        ctx.network.nodes.clear(); for (const [id, node] of staged.nodes) ctx.network.nodes.set(id, node);
        ctx.network.edges.clear(); for (const [id, road] of staged.edges) ctx.network.edges.set(id, road);
        ctx.network.version = staged.version;
        ctx.connectionLog?.push({ id: attemptId, purpose: "district-access", ok: true, strategy: result.strategy });
        accepted = true; changes += 1;
        break;
      }
      if (!accepted) ctx.connectionLog?.push({ id: attemptId, purpose: "district-access", ok: false, reason: "no-target",
        detail: rejected.slice(-2).join("; ") || "no legal endpoint-preserving reroute candidate" });
      attempted.add(attemptId);
      if (accepted) break;
    }
  }
  return { changes, ...(rejected.length ? { reason: rejected.slice(0, 4).join("; ") } : {}) };
}

/** End a leaf road at the shoreline when its only continuation crosses a hard
 * terrain barrier. This is allowed only when the new endpoint is a semantic
 * coast/water terminus and the complete remaining road corridor is safe. */
export function trimLeafBeforeUnsafeCrossing(ctx: RepairContext): { changes: number; reason?: string } {
  const edges = [...ctx.network.edges.values()];
  const initialFindings = groundJunctionFindings(edges);
  const initialRelations = new Set(initialFindings.map((finding) => [...finding.edges].sort().join("|")));
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const segmentKey = (a: Vec2, b: Vec2) => {
    const first = `${a.x}:${a.z}`, second = `${b.x}:${b.z}`;
    return first < second ? `${first}/${second}` : `${second}/${first}`;
  };
  const referencedSegments = new Set<string>();
  for (const run of [...ctx.carPaths, ...ctx.coastRoadRuns, ...ctx.riverRoadRuns]) {
    for (let i = 1; i < run.length; i += 1) referencedSegments.add(segmentKey(run[i - 1], run[i]));
  }
  for (const block of ctx.blocks) for (let i = 0; i < block.polygon.length; i += 1) {
    referencedSegments.add(segmentKey(block.polygon[i], block.polygon[(i + 1) % block.polygon.length]));
  }
  const edgeReferenced = (edge: RoadEdge): boolean => {
    return edge.points.length === 2 && referencedSegments.has(segmentKey(edge.points[0], edge.points[1]));
  };
  const endpoints = {
    bridgeLandings: bridgeLandingNodes([...ctx.network.edges.values()]),
    sites: [...ctx.publicSites, ...ctx.landmarks].filter((site) => site.radius),
    boulevardEnds: (ctx.seaside?.samples ?? []).filter((sample) => sample.valid && sample.boulevard).map((sample) => sample.boulevard!),
    coastRoadRunEnds: ctx.coastRoadRunEnds,
    coast: ctx.coast,
    river: ctx.geo.river,
    waterEdges: ctx.geo.waterEdges,
  };
  const world = { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [...ctx.publicSites, ...ctx.landmarks] };
  let changes = 0;
  const reasons: string[] = [];
  for (const finding of initialFindings) {
    const pair = finding.edges.map((id) => ctx.network.edges.get(id));
    if (pair.some((edge) => !edge || edge.bridge)) continue;
    let committed = false;
    for (let ownIndex = 0; ownIndex < 2 && !committed; ownIndex += 1) {
      const edge = pair[ownIndex]!, other = pair[1 - ownIndex]!;
      if (atLeast(edge, "arterial") || edge.structure !== "ground-road" || edge.points.length !== 2 || edgeReferenced(edge)) continue;
      const relation = classifyRoadSegments(edge.points[0], edge.points[1], other.points[0], other.points[1]);
      const length = Math.hypot(edge.points[1].x - edge.points[0].x, edge.points[1].z - edge.points[0].z);
      if (length < 6) continue;
      const terminalIsTo = relation.a.t >= 0.5;
      const terminalId = terminalIsTo ? edge.to : edge.from;
      const retainedId = terminalIsTo ? edge.from : edge.to;
      const terminal = ctx.network.nodes.get(terminalId), retained = ctx.network.nodes.get(retainedId);
      if (!terminal || !retained || degree.get(terminalId) !== 1) continue;
      // Proximity is not permission to remove an endpoint. Only an explicitly
      // declared shore-run end with no live owner/path reference may move.
      const sameTerminal = (p: Vec2) => p.x === terminal.x && p.z === terminal.z;
      if (terminalId === ctx.primaryAnchorNodeId
        || !ctx.coastRoadRunEnds.some(sameTerminal)
        || [...ctx.publicSites, ...ctx.landmarks].some((site) => site.access?.nodeId === terminalId)
        || [...ctx.carPaths, ...ctx.coastRoadRuns, ...ctx.riverRoadRuns].some((run) => run.some(sameTerminal))
        || ctx.blocks.some((block) => block.polygon.some(sameTerminal))) continue;
      const originalFailure = groundJunctionCorridorFailure(world, edge.points[0], edge.points[1], edge.width, edge);
      if (originalFailure !== "slope" && originalFailure !== "water-span") continue;
      if (Math.hypot(terminal.x - relation.a.point.x, terminal.z - relation.a.point.z) > 18) continue;
      const clearance = edge.width / 2 + other.width / 2 + ROAD_RELATION_CONFIG.nearDistance + 0.5;
      const towardStart = terminalIsTo ? -1 : 1;
      for (let retreat = 4; retreat <= 60 && !committed; retreat += 2) {
        const t = Math.max(0.02, Math.min(0.98, relation.a.t + towardStart * retreat / length));
        const at = keyOf({ x: edge.points[0].x + (edge.points[1].x - edge.points[0].x) * t,
          z: edge.points[0].z + (edge.points[1].z - edge.points[0].z) * t });
        if (at.x === retained.x && at.z === retained.z) continue;
        // Here only coast/river proximity applies; a nearby site or another
        // declared endpoint cannot authorize this replacement shore stop.
        if (!isPlannedRoadEnd(at, { ...endpoints, bridgeLandings: new Set(), sites: [], boulevardEnds: [], coastRoadRunEnds: [] })) continue;
        const gap = closestSegmentPoints(at, at, other.points[0], other.points[1]).distance;
        if (gap < clearance) continue;
        const result = commitNetworkPatch(ctx.network, {
          baseVersion: ctx.network.version,
          removeEdgeIds: [edge.id], removeNodeIds: [terminalId], splits: [], rebindNodes: [],
          addEdges: [{ a: { x: retained.x, z: retained.z }, b: at, arterial: edge.kind === "arterial", primary: false, bridge: false }],
        }, (draft) => {
          const replacementId = [retainedId, `${at.x}:${at.z}`].sort().join("/");
          const replacement = draft.edges.get(replacementId);
          if (!replacement || replacement.width !== edge.width) return "shore trim failed to preserve road class/width";
          const corridor = groundJunctionCorridorFailure(world, replacement.points[0], replacement.points[1], replacement.width, edge);
          if (corridor) return `shore trim corridor ${corridor}`;
          const findings = groundJunctionFindings([...draft.edges.values()]);
          if (findings.some((next) => !initialRelations.has([...next.edges].sort().join("|")))) return "shore trim introduced another geometric relation";
          if (findings.length >= initialFindings.length) return "shore trim did not remove the original relation";
          const roads = [...draft.edges.values()].filter((road) => road.id !== replacementId && !road.bridge
            && road.from !== retainedId && road.to !== retainedId);
          for (const road of roads) for (let i = 1; i < road.points.length; i += 1) {
            const d = closestSegmentPoints(replacement.points[0], replacement.points[1], road.points[i - 1], road.points[i]).distance;
            if (d < replacement.width / 2 + road.width / 2 + 0.5) return `shore trim road-envelope conflict ${road.id}`;
          }
          return null;
        });
        if (!result.ok) { reasons.push(`${edge.id}:${result.detail ?? result.reason}`); continue; }
        for (let i = 0; i < ctx.coastRoadRunEnds.length; i += 1) {
          if (sameTerminal(ctx.coastRoadRunEnds[i])) ctx.coastRoadRunEnds[i] = { ...at };
        }
        committed = true; changes += 1;
        ctx.connectionLog?.push({ id: `shore-trim:${edge.id}`, purpose: "district-access", ok: true, strategy: "direct-projection" });
      }
    }
  }
  return { changes, ...(reasons.length ? { reason: reasons.slice(0, 4).join("; ") } : {}) };
}
