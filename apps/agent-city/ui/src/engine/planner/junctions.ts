/** 地面交点按位置联合拆边；实际折线与端点 T 口共用节点，桥不平接。 */
import { DetMath as Math } from "../detMath";
import type { Parcel, RoadEdge, Vec2 } from "../cityLayout";
import { commitNetworkPatch, keyOf } from "./network";
import type { ConnectorWorld } from "./connect";
import { groundJunctionCorridorFailure, groundJunctionCorridorViolation } from "./civicClearance";
import { polylineDistance } from "./footprint";
import type { RepairContext } from "./context";

export const JUNCTION_CONFIG = { version: 4, maxJunctions: 128, minAngleDeg: 35, minLegLength: 3 };

/** 后续连接/修复新增的交叉，也通过同一草稿内的几何与路径接线收口。 */
export function normalizeGroundJunctions(ctx: RepairContext): { changes: number; reason?: string } {
  const before = new Map(ctx.network.edges);
  const report = connectGroundJunctions({ network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [...ctx.publicSites, ...ctx.landmarks] }, ctx.blocks.flatMap((block) => block.parcels));
  const summary = report.declined.length ? `${report.declined.length} junctions declined: ${report.declined.slice(0, 8).map(({ node, reason }) => `${node} ${reason}`).join("; ")}${report.declined.length > 8 ? "; …" : ""}${report.budgetExhausted ? "; budget exhausted" : ""}` : report.budgetExhausted ? "junction budget exhausted" : undefined;
  if (!report.connected) return { changes: 0, ...(summary ? { reason: summary } : {}) };
  const nodes = [...ctx.network.nodes.values()];
  for (const route of [...ctx.carPaths, ...ctx.coastRoadRuns, ...ctx.riverRoadRuns]) {
    for (let i = route.length - 1; i > 0; i -= 1) {
      const a = route[i - 1], b = route[i];
      const id = [`${a.x}:${a.z}`, `${b.x}:${b.z}`].sort().join("/");
      if (!before.has(id) || ctx.network.edges.has(id)) continue;
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
      const between = nodes.map((node) => ({ node, t: ((node.x - a.x) * dx + (node.z - a.z) * dz) / l2 }))
        .filter(({ node, t }) => t > 1e-4 && t < 1 - 1e-4 && polylineDistance([[a, b]], node) < 0.02)
        .sort((u, v) => u.t - v.t || (u.node.id < v.node.id ? -1 : u.node.id > v.node.id ? 1 : 0));
      route.splice(i, 0, ...between.map(({ node }) => ({ x: node.x, z: node.z })));
    }
  }
  return { changes: report.connected, ...(summary ? { reason: summary } : {}) };
}

function distanceToShape(edge: RoadEdge, at: Vec2): number {
  let nearest = Infinity;
  for (let i = 1; i < edge.points.length; i += 1) {
    const a = edge.points[i - 1], b = edge.points[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    nearest = Math.min(nearest, Math.hypot(at.x - a.x - t * dx, at.z - a.z - t * dz));
  }
  return nearest;
}

export function connectGroundJunctions(world: ConnectorWorld, parcels: readonly Parcel[] = []): { connected: number; declined: Array<{ node: string; reason: string }>; budgetExhausted: boolean } {
  let connected = 0; const declined: Array<{ node: string; reason: string }> = [];
  const decline = (node: string, reason: string) => { declined.push({ node, reason }); };
  const edges = [...world.network.edges.values()].filter((e) => !e.bridge).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const groups = new Map<string, { at: Vec2; originals: Set<string> }>();
  const parts = new Map(edges.map((e) => [e.id, [e.id]]));
  for (let i = 0; i < edges.length; i += 1) for (let j = i + 1; j < edges.length; j += 1) {
    const a = edges[i], b = edges[j];
    for (let p = 1; p < a.points.length; p += 1) for (let q = 1; q < b.points.length; q += 1) {
      const start = a.points[p - 1], other = b.points[q - 1];
      const ux = a.points[p].x - start.x, uz = a.points[p].z - start.z;
      const vx = b.points[q].x - other.x, vz = b.points[q].z - other.z;
      const determinant = ux * vz - uz * vx;
      if (Math.abs(determinant) < 1e-9) continue;
      const dx = other.x - start.x, dz = other.z - start.z;
      const t = (dx * vz - dz * vx) / determinant, s = (dx * uz - dz * ux) / determinant;
      if (t < -1e-9 || t > 1 + 1e-9 || s < -1e-9 || s > 1 + 1e-9) continue;
      const at = keyOf({ x: start.x + t * ux, z: start.z + t * uz });
      const id = `${at.x}:${at.z}`;
      if ((a.from === id || a.to === id) && (b.from === id || b.to === id)) continue;
      const group = groups.get(id) ?? { at, originals: new Set<string>() };
      group.originals.add(a.id); group.originals.add(b.id); groups.set(id, group);
    }
  }
  for (const [nodeId, group] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const hosts = [...group.originals].sort().flatMap((original) => (parts.get(original) ?? []).map((id) => world.network.edges.get(id)).filter((edge): edge is RoadEdge => !!edge && edge.from !== nodeId && edge.to !== nodeId && distanceToShape(edge, group.at) <= 0.05));
    if (!hosts.length) { decline(nodeId, "no eligible unsplit host segment"); continue; }
    // 既有同坐标桥节点不能借地面细分并入；高程契约仍由分层网络负责。
    if ([...world.network.edges.values()].some((e) => e.bridge && (e.from === nodeId || e.to === nodeId))) { decline(nodeId, "bridge endpoint cannot be merged as ground junction"); continue; }
    const participants = [...world.network.edges.values()].filter((edge) => hosts.includes(edge) || edge.from === nodeId || edge.to === nodeId);
    if (hosts.some((edge) => Math.hypot(edge.points[0].x - group.at.x, edge.points[0].z - group.at.z) < JUNCTION_CONFIG.minLegLength
      || Math.hypot(edge.points.at(-1)!.x - group.at.x, edge.points.at(-1)!.z - group.at.z) < JUNCTION_CONFIG.minLegLength)
      ) { decline(nodeId, "short host leg (<3)"); continue; }
    const unsafeParticipant = participants.flatMap((edge) => edge.points.slice(1).map((point, i) => ({
      edge,
      failure: groundJunctionCorridorViolation(world, edge.points[i], point, edge.width, edge),
    }))).find(({ failure }) => failure);
    if (unsafeParticipant) { decline(nodeId, `participant corridor unsafe (${unsafeParticipant.failure!.kind}) on ${unsafeParticipant.edge.id}: ${unsafeParticipant.failure!.cause}`); continue; }
    if (connected >= JUNCTION_CONFIG.maxJunctions) return { connected, declined, budgetExhausted: true };
    const result = commitNetworkPatch(world.network, { baseVersion: world.network.version ?? 0, addEdges: [], removeEdgeIds: [], splits: hosts.map((edge) => ({ edgeId: edge.id, at: group.at })) }, (draft) => {
      const incident = [...draft.edges.values()].filter((e) => e.from === nodeId || e.to === nodeId);
      if (incident.length < 3) return "junction has fewer than three legs";
      for (const edge of incident) {
        const parent = participants.find((old) => old.id === edge.id || (hosts.includes(old) && [old.from, old.to].some((node) => node === edge.from || node === edge.to))) ?? edge;
        const failure = edge.points.slice(1).map((point, i) => groundJunctionCorridorFailure(world, edge.points[i], point, edge.width, parent)).find(Boolean);
        if (failure) return `junction corridor unsafe after canonical split (${failure}) on ${edge.id}`;
        if (parcels.some((parcel) => polylineDistance([edge.points], parcel) < Math.hypot(parcel.width, parcel.depth) / 2 + edge.width / 2 + 0.5)) return "junction parcel clearance";
      }
      const legs = incident.map((e) => e.from === nodeId ? e.points[1] : e.points[e.points.length - 2]);
      for (let p = 0; p < legs.length; p += 1) for (let q = p + 1; q < legs.length; q += 1) {
        const ux = legs[p].x - group.at.x, uz = legs[p].z - group.at.z;
        const vx = legs[q].x - group.at.x, vz = legs[q].z - group.at.z;
        const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
        if (lu < JUNCTION_CONFIG.minLegLength || lv < JUNCTION_CONFIG.minLegLength) return "junction-short-leg";
        if ((ux * vx + uz * vz) / (lu * lv) > Math.cos(JUNCTION_CONFIG.minAngleDeg * Math.PI / 180)) return "junction-angle";
      }
      return null;
    });
    if (!result.ok) { decline(nodeId, result.detail ?? result.reason ?? "network patch refused"); continue; }
    for (const original of group.originals) {
      const old = parts.get(original)!;
      const split = hosts.filter((host) => old.includes(host.id));
      parts.set(original, [...old.filter((id) => !split.some((host) => host.id === id)), ...split.flatMap((host) => [host.from, host.to].map((id) => [id, nodeId].sort().join("/")))]);
    }
    connected += 1;
  }
  return { connected, declined, budgetExhausted: false };
}
