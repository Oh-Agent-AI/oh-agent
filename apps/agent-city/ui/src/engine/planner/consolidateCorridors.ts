/** 已由短连接接入同一走廊的终端重复段：保留完整、更宽宿主，重绑独立支路而非降角度门槛。 */
import { DetMath as Math } from "../detMath";
import { roadNodeId } from "../roadGeometry";
import type { RepairContext } from "./context";
import { commitNetworkPatch, keyOf, type NetworkPatch } from "./network";
import { groundJunctionFindings } from "./report";
import { groundJunctionCorridorFailure } from "./civicClearance";
import { polylineDistance } from "./footprint";
import { rebindJunctionReferences } from "./snapJunctions";

export const CONSOLIDATE_CONFIG = { version: 3, maxAngleDeg: 15, maxOffset: 0.5, maxEndMove: 3, minJunctionAngleDeg: 35, maxRelocation: 16, maxRelocationCandidates: 96 };

const relocationCandidates = (ctx: RepairContext, id: string): Array<{ from: string; id: string; x: number; z: number }> => {
  const node = ctx.network.nodes.get(id);
  if (!node || id === ctx.primaryAnchorNodeId) return [];
  const incident = [...ctx.network.edges.values()].filter((edge) => edge.from === id || edge.to === id);
  if (incident.length !== 2 || incident.some((edge) => edge.bridge)) return [];
  if (ctx.publicSites.some((site) => site.access?.nodeId === id)) return [];
  const routes = [...ctx.carPaths, ...ctx.coastRoadRuns, ...ctx.riverRoadRuns, ctx.coastRoadRunEnds];
  if (routes.some((route) => route.some((p) => p.x === node.x && p.z === node.z))) return [];
  if (ctx.blocks.some((block) => block.polygon.some((p) => p.x === node.x && p.z === node.z))) return [];
  const candidates: Array<{ id: string; x: number; z: number; height: number; distance: number }> = [];
  const directions = Array.from({ length: 16 }, (_, i) => ({ x: Math.cos(i * Math.PI / 8), z: Math.sin(i * Math.PI / 8) }));
  for (const radius of [1, 2, 3, 4, 6, 8, 12, 16].filter((value) => value <= CONSOLIDATE_CONFIG.maxRelocation)) for (const direction of directions) {
    const at = keyOf({ x: node.x + direction.x * radius, z: node.z + direction.z * radius });
    const candidateId = roadNodeId(at);
    if (candidateId === id || ctx.network.nodes.has(candidateId) || ctx.inRiver(at.x, at.z)) continue;
    const height = ctx.height(at.x, at.z);
    if (!Number.isFinite(height) || height <= 0.5) continue;
    candidates.push({ ...at, id: candidateId, height, distance: Math.hypot(at.x - node.x, at.z - node.z) });
  }
  return candidates.sort((a, b) => b.height - a.height || a.distance - b.distance || a.x - b.x || a.z - b.z)
    .slice(0, CONSOLIDATE_CONFIG.maxRelocationCandidates).map(({ id: candidateId, x, z }) => ({ from: id, id: candidateId, x, z }));
};

export function consolidateTerminalCorridors(ctx: RepairContext): number {
  let changed = 0;
  for (const finding of groundJunctionFindings([...ctx.network.edges.values()])) {
    const pair = finding.edges.map((id) => ctx.network.edges.get(id));
    if (pair.some((edge) => !edge || edge.bridge || edge.points.length !== 2)) continue;
    const length = (edge: typeof pair[number]) => Math.hypot(edge!.points[1].x - edge!.points[0].x, edge!.points[1].z - edge!.points[0].z);
    const [host, victim] = pair.sort((a, b) => length(b) - length(a) || (a!.id < b!.id ? -1 : 1)) as NonNullable<typeof pair[number]>[];
    if (host.width < victim.width || (host.kind !== "arterial" && victim.kind === "arterial")) continue;
    const a = host.points[0], b = host.points[1], u = victim.points[0], v = victim.points[1];
    const hx = b.x - a.x, hz = b.z - a.z, vx = v.x - u.x, vz = v.z - u.z;
    if (Math.abs((hx * vx + hz * vz) / (length(host) * length(victim))) < Math.cos(CONSOLIDATE_CONFIG.maxAngleDeg * Math.PI / 180)) continue;
    const incident = (id: string) => [...ctx.network.edges.values()].filter((edge) => edge.from === id || edge.to === id);
    const freeId = [victim.from, victim.to].find((id) => incident(id).length === 1);
    if (!freeId) continue;
    const free = ctx.network.nodes.get(freeId)!, source = ctx.network.nodes.get(freeId === victim.from ? victim.to : victim.from)!;
    if ([free.id, source.id].includes(ctx.primaryAnchorNodeId ?? "") || incident(source.id).some((edge) => edge.bridge)) continue;
    if (ctx.publicSites.some((site) => site.access?.nodeId === free.id)) continue;
    if ([...ctx.carPaths, ...ctx.coastRoadRuns, ...ctx.riverRoadRuns, ctx.coastRoadRunEnds].some((route) => route.some((p) => p.x === free.x && p.z === free.z))) continue;
    const t = ((free.x - a.x) * hx + (free.z - a.z) * hz) / (hx * hx + hz * hz);
    if (t <= 0 || t >= 1 || polylineDistance([host.points], free) > CONSOLIDATE_CONFIG.maxOffset) continue;
    const target = [ctx.network.nodes.get(host.from)!, ctx.network.nodes.get(host.to)!].sort((p, q) => Math.hypot(p.x - source.x, p.z - source.z) - Math.hypot(q.x - source.x, q.z - source.z) || (p.id < q.id ? -1 : 1))[0];
    if (Math.hypot(target.x - source.x, target.z - source.z) > CONSOLIDATE_CONFIG.maxEndMove) continue;
    const link = incident(source.id).find((edge) => !edge.bridge && (edge.from === target.id || edge.to === target.id));
    if (!link || link.id === victim.id) continue;
    if ([...ctx.carPaths, ...ctx.coastRoadRuns, ...ctx.riverRoadRuns].some((route) => route.length > 1 && route.every((p) => (p.x === source.x && p.z === source.z) || (p.x === target.x && p.z === target.z)))) continue;
    const removed = new Set([victim.id, link.id]);
    const relocationNodeIds = [...new Set(incident(source.id).filter((edge) => !removed.has(edge.id)).flatMap((edge) => [edge.from, edge.to]).filter((id) => id !== source.id))].sort();
    const relocationOptions = [null, ...relocationNodeIds.flatMap((id) => relocationCandidates(ctx, id))];
    let committed = false;
    let lastFailure = "no safe relocation candidate";
    const failuresByNode = new Map<string, string>();
    for (const relocation of relocationOptions) {
      const nodeMap = new Map([[source.id, target.id]]);
      if (relocation) nodeMap.set(relocation.from, relocation.id);
      const mappedEdgeId = (edge: { from: string; to: string }) => [nodeMap.get(edge.from) ?? edge.from, nodeMap.get(edge.to) ?? edge.to].sort().join("/");
      const existing = new Set(groundJunctionFindings([...ctx.network.edges.values()])
        .filter((f) => !f.edges.some((id) => removed.has(id)))
        .map((f) => f.edges.map((id) => mappedEdgeId(ctx.network.edges.get(id)!)).sort().join("|")));
      const bindings: NetworkPatch["rebindNodes"] = [{ from: source.id, to: target.id }];
      if (relocation) bindings!.push({ from: relocation.from, to: relocation.id, targetAt: { x: relocation.x, z: relocation.z } });
      const result = commitNetworkPatch(ctx.network, { baseVersion: ctx.network.version,
        removeEdgeIds: [...removed], removeNodeIds: [free.id], splits: [], addEdges: [], rebindNodes: bindings }, (draft) => {
      if (groundJunctionFindings([...draft.edges.values()]).some((f) => !existing.has([...f.edges].sort().join("|")))) return "corridor merge introduced crossing";
      const changedNodes = new Set([target.id, ...(relocation ? [relocation.id] : [])]);
      const changedEdgeIds = new Set(incident(source.id).filter((edge) => !removed.has(edge.id)).map((edge) => mappedEdgeId(edge)));
      if (relocation) for (const edge of incident(relocation.from)) changedEdgeIds.add(mappedEdgeId(edge));
      const legs = [...changedEdgeIds].map((id) => draft.edges.get(id)).filter((edge): edge is NonNullable<typeof edge> => !!edge);
      const world = { network: draft, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [...ctx.publicSites, ...ctx.landmarks] };
      for (const edge of legs) if (!edge.bridge) {
        for (let k = 1; k < edge.points.length; k += 1) {
          const failure = groundJunctionCorridorFailure(world, edge.points[k - 1], edge.points[k], edge.width, edge);
          if (failure) return `corridor merge unsafe: ${failure} on ${edge.id}`;
        }
        if (ctx.blocks.some((block) => block.parcels.some((p) => polylineDistance([edge.points], p) < Math.hypot(p.width, p.depth) / 2 + edge.width / 2 + 0.5))) return "corridor merge parcel clearance";
      }
      for (const nodeId of changedNodes) {
        const node = draft.nodes.get(nodeId);
        if (!node) return "corridor merge missing junction node";
        const atNode = [...draft.edges.values()].filter((edge) => edge.from === nodeId || edge.to === nodeId);
        const directions = atNode.map((edge) => { const p = edge.from === nodeId ? edge.points[1] : edge.points[edge.points.length - 2]; return { x: p.x - node.x, z: p.z - node.z }; });
        for (let i = 0; i < directions.length; i += 1) for (let j = i + 1; j < directions.length; j += 1) {
          const u = directions[i], v = directions[j], lu = Math.hypot(u.x, u.z), lv = Math.hypot(v.x, v.z);
          if (lu < 3 || lv < 3 || (u.x * v.x + u.z * v.z) / (lu * lv) > Math.cos(CONSOLIDATE_CONFIG.minJunctionAngleDeg * Math.PI / 180)) return "corridor merge junction angle";
        }
      }
      return null;
      });
      if (result.ok) { committed = true; break; }
      lastFailure = `${relocation ? `${relocation.from}->${relocation.id}` : "direct"}: ${result.detail ?? result.reason}`;
      failuresByNode.set(relocation?.from ?? "direct", `${relocation?.id ?? "direct"}: ${result.detail ?? result.reason}`);
    }
    if (!committed) { const byNode = [...failuresByNode].map(([id, reason]) => `${id}: ${reason}`).join("; "); ctx.connectionLog?.push({ id: `corridor-merge:${victim.id}`, purpose: "district-access", ok: false, reason: "projection-loss", detail: byNode || lastFailure }); continue; }
    rebindJunctionReferences(ctx, source, target); changed += 1;
  }
  return changed;
}
