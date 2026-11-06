/** Bounded joint ground-owner/corridor proposals. Call mutation only on a solve
 * draft; the dispatcher publishes network/site/references together. */
import { EXPRESSWAY_DECK_WIDTH } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import type { RoadEdge, Vec2 } from "../cityLayout";
import type { LocalFootprint } from "../models/physical";
import type { RepairContext } from "./context";
import { footprintPolylineDistance, resolveModelEnvelope } from "./modelEnvelope";
import { commitNetworkPatch, previewNetworkPatch, NETWORK_RELINE_CONFIG, type Network, type NetworkPatch } from "./network";
import { relocatedSitePositionFailure } from "./snapJunctions";
import { registeredModelGroundFailure } from "./modelGround";
import { canRelocateGroundSite } from "./sitespec";
import { localResiteCandidates } from "./siting";
import { polylineDistance } from "./footprint";
import { groundJunctionCorridorFailure } from "./civicClearance";
import { classifyRoadSegments, closestSegmentPoints, ROAD_RELATION_CONFIG } from "./relations";
import { groundJunctionFindings } from "./report";
import { roadNodeId } from "../roadGeometry";
import { isOwnedIslandGate } from "./endpoints";

/** Bounded node closure; at most 4P2=12 target assignments per proposal. */
export const JOINT_NODE_RELOCATION_CONFIG = { version: 1, maxNodes: 2, targetCorners: 4 } as const;

/** Six-node visibility graph: endpoints plus conservative bounding corners are
 * candidate waypoints only. Every visibility edge checks the actual UNION,
 * so openings are not replaced by a solid bounding rectangle. */
function declaredOwnerDetourBetween(footprint: LocalFootprint, road: RoadEdge, a: Vec2, b: Vec2,
  allowed: (a: Vec2, b: Vec2) => boolean = () => true): Vec2[] | null {
  const required = road.width / 2 + 3;
  if (!a || !b || !Number.isFinite(required) || road.width <= 0 ||
    ![a, b].every(point => { const distance = footprintPolylineDistance(footprint, [point]); return Number.isFinite(distance) && distance >= required; })) return null;
  const bounds = footprint.parts.flatMap(part => part.shape === "circle" ? [
    { x: part.center.x - part.radius, z: part.center.z - part.radius }, { x: part.center.x + part.radius, z: part.center.z + part.radius },
  ] : part.shape === "convex" ? part.vertices : [
    { x: part.center.x - part.width / 2, z: part.center.z - part.depth / 2 },
    { x: part.center.x + part.width / 2, z: part.center.z + part.depth / 2 },
  ]);
  const left = Math.floor((Math.min(...bounds.map(point => point.x)) - required) * 100) / 100;
  const right = Math.ceil((Math.max(...bounds.map(point => point.x)) + required) * 100) / 100;
  const top = Math.floor((Math.min(...bounds.map(point => point.z)) - required) * 100) / 100;
  const bottom = Math.ceil((Math.max(...bounds.map(point => point.z)) + required) * 100) / 100;
  const nodes = [a, b, { x: left, z: top }, { x: right, z: top }, { x: right, z: bottom }, { x: left, z: bottom }];
  const costs = nodes.map(() => nodes.map(() => Infinity));
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const length = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z);
    const distance = footprintPolylineDistance(footprint, [nodes[i], nodes[j]]);
    if (length > 0 && Number.isFinite(distance) && distance >= required && allowed(nodes[i], nodes[j])) costs[i][j] = costs[j][i] = length;
  }
  const distance = nodes.map(() => Infinity), previous = nodes.map(() => -1), used = nodes.map(() => false); distance[0] = 0;
  for (let step = 0; step < nodes.length; step++) {
    let at = -1;
    for (let i = 0; i < nodes.length; i++) if (!used[i] && Number.isFinite(distance[i]) && (at < 0 || distance[i] < distance[at])) at = i;
    if (at < 0) return null;
    if (at === 1) {
      if (distance[at] > Math.min(700, Math.max(160, Math.hypot(b.x - a.x, b.z - a.z) * 2.5))) return null;
      const indices = []; for (let cursor = 1; cursor >= 0; cursor = previous[cursor]) indices.unshift(cursor);
      return indices.map(index => ({ ...nodes[index] }));
    }
    used[at] = true;
    for (let i = 0; i < nodes.length; i++) if (!used[i] && distance[at] + costs[at][i] < distance[i]) {
      distance[i] = distance[at] + costs[at][i]; previous[i] = at;
    }
  }
  return null;
}

export function declaredOwnerDetour(footprint: LocalFootprint, road: RoadEdge,
  allowed: (a: Vec2, b: Vec2) => boolean = () => true): Vec2[] | null {
  return declaredOwnerDetourBetween(footprint, road, road.points[0], road.points[road.points.length - 1], allowed);
}

/** Visibility edges touching a fixed graph endpoint must also fit the existing
 * junction. Check during search so a rejected shortest side does not conceal
 * a longer legal detour. Existing acute pairs may improve, never get worse. */
export function detourEndpointAnglesClear(network: Network, road: RoadEdge, a: Vec2, b: Vec2,
  excluded: ReadonlySet<string> = new Set()): boolean {
  const same = (p: Vec2, q: Vec2) => p.x === q.x && p.z === q.z;
  const gap = (origin: Vec2, p: Vec2, q: Vec2) => {
    const delta = Math.atan2(p.z - origin.z, p.x - origin.x) - Math.atan2(q.z - origin.z, q.x - origin.x);
    return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
  };
  for (const [id, endpoint, previous] of [
    [road.from, road.points[0], road.points[1]],
    [road.to, road.points[road.points.length - 1], road.points[road.points.length - 2]],
  ] as const) {
    const next = same(a, endpoint) ? b : same(b, endpoint) ? a : null;
    if (!next) continue;
    const incident = [...network.edges.values()].filter(edge => edge.from === id || edge.to === id);
    if (incident.length < 2) continue;
    for (const other of incident) {
      if (other.id === road.id || excluded.has(other.id)) continue;
      const outward = other.from === id ? other.points[1] : other.points[other.points.length - 2];
      if (gap(endpoint, next, outward) + 1e-9 < Math.min(Math.PI / 6, gap(endpoint, previous, outward))) return false;
    }
  }
  return true;
}

/** Reject new at-grade contacts while a replacement corridor is being searched.
 * Existing graph-node contacts at this road's fixed endpoints remain legal. */
function routeIntroducesGroundContact(network: Network, road: RoadEdge, a: Vec2, b: Vec2, excluded: ReadonlySet<string>): boolean {
  const same = (p: Vec2, q: Vec2) => p.x === q.x && p.z === q.z;
  for (const other of network.edges.values()) {
    if (excluded.has(other.id) || other.bridge) continue;
    const shared = [road.from, road.to].filter(node => node === other.from || node === other.to);
    for (let i = 1; i < other.points.length; i++) {
      const c = other.points[i - 1], d = other.points[i];
      const relation = classifyRoadSegments(a, b, c, d);
      if (relation.distance > ROAD_RELATION_CONFIG.nearDistance) continue;
      const existingSharedEndpoint = relation.kind === "endpoint-contact" && shared.some(node => {
        const point = node === road.from ? road.points[0] : road.points[road.points.length - 1];
        return (same(a, point) || same(b, point)) && (same(c, point) || same(d, point))
          && same(relation.a.point, point) && same(relation.b.point, point);
      });
      if (!existingSharedEndpoint) return true;
    }
  }
  return false;
}

function routesHaveUnjoinedContact(left: RoadEdge, leftPoints: readonly Vec2[], right: RoadEdge, rightPoints: readonly Vec2[]): boolean {
  if (left.bridge || right.bridge) return false;
  const same = (a: Vec2, b: Vec2) => a.x === b.x && a.z === b.z;
  const shared = [left.from, left.to].filter(node => node === right.from || node === right.to);
  for (let i = 1; i < leftPoints.length; i++) for (let j = 1; j < rightPoints.length; j++) {
    const relation = classifyRoadSegments(leftPoints[i - 1], leftPoints[i], rightPoints[j - 1], rightPoints[j]);
    if (relation.distance > ROAD_RELATION_CONFIG.nearDistance) continue;
    const sharedGraphEndpoint = shared.some(node => {
      const leftPoint = node === left.from ? leftPoints[0] : leftPoints[leftPoints.length - 1];
      const rightPoint = node === right.from ? rightPoints[0] : rightPoints[rightPoints.length - 1];
      return same(leftPoint, rightPoint) && same(relation.a.point, leftPoint) && same(relation.b.point, rightPoint);
    });
    if (!sharedGraphEndpoint) return true;
  }
  return false;
}

type Proposal = { ok: true; patch: NetworkPatch } | { ok: false; reason: string };
export function prepareJointSiteRoadRelocation(ctx: RepairContext, ownerId: string, at: Vec2): Proposal {
  const reject = (reason: string): Proposal => ({ ok: false, reason });
  const owners = [...ctx.publicSites, ...ctx.landmarks].filter(owner => owner.id === ownerId), owner = owners[0];
  if (owners.length !== 1 || !canRelocateGroundSite(owner) || !ctx.SHORE_SITE_KINDS.has(owner.kind)) return reject("joint-owner-not-relocatable");
  if (ctx.planningWorld?.reservations.some(reservation => reservation.ownerId === ownerId && reservation.state !== "released"
    && (reservation.immutable || reservation.state !== "tentative"))) return reject("joint-owner-reservation-protected");
  let declared = false;
  for (const point of localResiteCandidates(owner)) if (point.x === at.x && point.z === at.z) { declared = true; break; }
  if (!declared) return reject("joint-owner-undeclared-candidate");
  const envelope = resolveModelEnvelope({ ...owner, ...at });
  if (envelope.status !== "partial" || envelope.relocationCorridorEnvelope?.schemaVersion !== 1
    || envelope.relocationCorridorEnvelope.coverage !== "complete-conservative-renderer-xy") return reject("joint-owner-XY-unsupported");
  const ground = registeredModelGroundFailure({ ...owner, ...at }, { height: ctx.height, inRiver: ctx.inRiver });
  if (ground) return reject(ground);
  const initial = relocatedSitePositionFailure(ctx, owner, at, true);
  if (initial !== "owner-road-envelope") return reject(initial ?? "joint-owner-has-no-road-blocker");
  if (ctx.blocks.some(block => block.parcels.some(parcel => Math.hypot(parcel.x - at.x, parcel.z - at.z)
    < owner.radius + 9 + Math.hypot(parcel.width, parcel.depth) / 2))) return reject("owner-parcel-envelope");
  const roads = [...ctx.network.edges.values()].filter(road => footprintPolylineDistance(envelope.conservativeProjection, road.points) < road.width / 2 + 3);
  if (!roads.length || roads.length > NETWORK_RELINE_CONFIG.maxEdgesPerPatch) return reject("joint-road-blocker-budget");
  if (roads.some(road => road.bridge || road.structure !== "ground-road" || [...ctx.network.edges.values()].some(edge => edge.bridge
    && [edge.from, edge.to].some(node => node === road.from || node === road.to)))) return reject("joint-road-structure-protected");
  if (roads.some(road => ctx.planningWorld?.reservations.some(reservation => reservation.ownerId === `road:${road.id}`
    && reservation.state !== "released" && (reservation.immutable || reservation.state !== "tentative")))) return reject("joint-road-reservation-protected");
  const world = { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [...ctx.publicSites, ...ctx.landmarks].filter(site => site.id !== ownerId) };
  const decks = [...ctx.ringRuns.map(points => ({ points, width: EXPRESSWAY_DECK_WIDTH })), ...[...ctx.network.edges.values()].filter(edge => edge.bridge)];
  const endpointsInside = new Set(roads.flatMap(road => [road.from, road.to].filter((nodeId, index) =>
    footprintPolylineDistance(envelope.conservativeProjection, [road.points[index === 0 ? 0 : road.points.length - 1]]) < road.width / 2 + 3)));
  const relocationOptions: Array<{ nodes: Array<{ from: string; to: string; targetAt: Vec2 }>; edges: NonNullable<NetworkPatch["relineEdges"]> }> = [];
  let relocationReason = "joint-road-endpoint-in-owner-envelope";
  if (endpointsInside.size) {
    const ownersForGate = [...ctx.publicSites, ...ctx.landmarks];
    if (endpointsInside.size > JOINT_NODE_RELOCATION_CONFIG.maxNodes) return reject("joint-road-endpoint-node-budget");
    const protectedNode = [...endpointsInside].find(id => id === ctx.primaryAnchorNodeId || isOwnedIslandGate(id, ownersForGate)
      || [...ctx.network.edges.values()].some(edge => edge.bridge && (edge.from === id || edge.to === id)));
    if (protectedNode) return reject(`joint-road-endpoint-protected:${protectedNode}`);
    const affected = [...ctx.network.edges.values()].filter(edge => endpointsInside.has(edge.from) || endpointsInside.has(edge.to));
    if (!affected.length || affected.length > NETWORK_RELINE_CONFIG.maxEdgesPerPatch
      || affected.some(edge => edge.bridge || edge.structure !== "ground-road" || !Number.isFinite(edge.width) || edge.width <= 0
        || ctx.planningWorld?.reservations.some(reservation => reservation.ownerId === `road:${edge.id}`
          && reservation.state !== "released" && (reservation.immutable || reservation.state !== "tentative"))))
      return reject("joint-road-endpoint-dependency-protected");
    const maxSetback = Math.max(...affected.map(edge => edge.width / 2 + 3));
    const parts = envelope.conservativeProjection.parts;
    const bounds = parts.flatMap(part => part.shape === "circle" ? [
      { x: part.center.x - part.radius, z: part.center.z - part.radius }, { x: part.center.x + part.radius, z: part.center.z + part.radius },
    ] : part.shape === "convex" ? part.vertices : [
      { x: part.center.x - part.width / 2, z: part.center.z - part.depth / 2 }, { x: part.center.x + part.width / 2, z: part.center.z + part.depth / 2 },
    ]);
    const left = Math.floor(Math.min(...bounds.map(point => point.x)) - maxSetback - 2), right = Math.ceil(Math.max(...bounds.map(point => point.x)) + maxSetback + 2);
    const top = Math.floor(Math.min(...bounds.map(point => point.z)) - maxSetback - 2), bottom = Math.ceil(Math.max(...bounds.map(point => point.z)) + maxSetback + 2);
    const corners = [{ x: left, z: top }, { x: right, z: top }, { x: right, z: bottom }, { x: left, z: bottom }]
      .slice(0, JOINT_NODE_RELOCATION_CONFIG.targetCorners);
    const nodes = [...endpointsInside];
    const assignments: Vec2[][] = [];
    const enumerate = (index: number, chosen: Vec2[]) => {
      if (index === nodes.length) { assignments.push(chosen); return; }
      for (const point of corners) if (!chosen.some(other => other.x === point.x && other.z === point.z)) enumerate(index + 1, [...chosen, point]);
    };
    enumerate(0, []);
    const routeAllowed = (road: RoadEdge, a: Vec2, b: Vec2, blockedBy: { value: string }) => {
      if (routeIntroducesGroundContact(ctx.network, road, a, b, new Set([...roads, ...affected].map(edge => edge.id)))) {
        blockedBy.value = "unjoined-ground-contact"; return false;
      }
      const corridor = groundJunctionCorridorFailure(world, a, b, road.width, road);
      if (corridor) { blockedBy.value = `corridor-${corridor}`; return false; }
      if (ctx.blocks.some(block => block.parcels.some(parcel => polylineDistance([[a, b]], parcel)
        < Math.hypot(parcel.width, parcel.depth) / 2 + road.width / 2 + 0.5))) { blockedBy.value = "reserved-parcel-corridor"; return false; }
      for (const deck of decks) for (let k = 1; k < deck.points.length; k++) {
        const relation = classifyRoadSegments(a, b, deck.points[k - 1], deck.points[k], 0);
        if (["invalid", "interior-crossing", "endpoint-contact", "endpoint-on-edge", "collinear-overlap"].includes(relation.kind)
          || closestSegmentPoints(a, b, deck.points[k - 1], deck.points[k]).distance < road.width / 2 + deck.width / 2 + 1) {
          blockedBy.value = "deck-clearance-unsupported"; return false;
        }
      }
      return true;
    };
    for (const assignment of assignments) {
      const moved = new Map(nodes.map((id, index) => [id, assignment[index]]));
      if (assignment.some(point => [...ctx.network.nodes.values()].some(node => !endpointsInside.has(node.id)
        && Math.hypot(node.x - point.x, node.z - point.z) < 1))) continue;
      if (nodes.some((id, index) => {
        const width = Math.max(...affected.filter(edge => edge.from === id || edge.to === id).map(edge => edge.width));
        return footprintPolylineDistance(envelope.conservativeProjection, [assignment[index]]) < width / 2 + 3;
      })) continue;
      const edgePlans: NonNullable<NetworkPatch["relineEdges"]> = [];
      let failed = false;
      for (const road of affected) {
        const start = moved.get(road.from) ?? road.points[0], end = moved.get(road.to) ?? road.points[road.points.length - 1];
        const blockedBy = { value: "path-length-or-visibility" };
        const shape = declaredOwnerDetourBetween(envelope.conservativeProjection, road, start, end,
          (a, b) => routeAllowed(road, a, b, blockedBy));
        if (!shape) { relocationReason = `joint-road-node-detour:${blockedBy.value}`; failed = true; break; }
        const points = shape.map(point => ({ ...point }));
        points[0] = { ...road.points[0] }; points[points.length - 1] = { ...road.points[road.points.length - 1] };
        edgePlans.push({ edgeId: road.id, points });
      }
      if (failed) continue;
      relocationOptions.push({ nodes: nodes.map((from, index) => ({ from, to: roadNodeId(assignment[index]), targetAt: assignment[index] })), edges: edgePlans });
    }
    if (!relocationOptions.length) return reject(relocationReason);
  }
  const replacements: NonNullable<NetworkPatch["relineEdges"]> = [];
  const routedEdges = relocationOptions[0]?.edges ?? [];
  const movingEdgeIds = new Set(roads.map(road => road.id));
  for (const road of roads) {
    if (endpointsInside.size && routedEdges.some(route => route.edgeId === road.id)) {
      replacements.push(...routedEdges.filter(route => route.edgeId === road.id));
      continue;
    }
    let blockedBy = "path-length-or-visibility";
    const shape = declaredOwnerDetour(envelope.conservativeProjection, road, (a, b) => {
      if (!detourEndpointAnglesClear(ctx.network, road, a, b, movingEdgeIds)) { blockedBy = "junction-angle"; return false; }
      if (routeIntroducesGroundContact(ctx.network, road, a, b, movingEdgeIds)) { blockedBy = "unjoined-ground-contact"; return false; }
      const corridor = groundJunctionCorridorFailure(world, a, b, road.width, road);
      if (corridor) { blockedBy = `corridor-${corridor}`; return false; }
      if (ctx.blocks.some(block => block.parcels.some(parcel => polylineDistance([[a, b]], parcel)
        < Math.hypot(parcel.width, parcel.depth) / 2 + road.width / 2 + 0.5))) { blockedBy = "reserved-parcel-corridor"; return false; }
      for (const deck of decks) for (let k = 1; k < deck.points.length; k++) {
        const relation = classifyRoadSegments(a, b, deck.points[k - 1], deck.points[k], 0);
        if (["invalid", "interior-crossing", "endpoint-contact", "endpoint-on-edge", "collinear-overlap"].includes(relation.kind)
          || closestSegmentPoints(a, b, deck.points[k - 1], deck.points[k]).distance < road.width / 2 + deck.width / 2 + 1) {
          blockedBy = "deck-clearance-unsupported"; return false;
        }
      }
      return true;
    });
    if (!shape) return reject(`joint-road-no-endpoint-preserving-detour:${blockedBy}`);
    replacements.push({ edgeId: road.id, points: shape });
  }
  const alternatives = relocationOptions.length ? relocationOptions : [{ nodes: [], edges: [] }];
  let lastFailure = "joint-road-no-valid-patch";
  for (const option of alternatives) {
    const byId = new Map(replacements.map(edge => [edge.edgeId, edge]));
    for (const edge of option.edges) byId.set(edge.edgeId, edge);
    const patch: NetworkPatch = { baseVersion: ctx.network.version,
      removeEdgeIds: [], addEdges: [], splits: [], relineEdges: [...byId.values()], ...(option.nodes.length ? { rebindNodes: option.nodes } : {}) };
    const preview = previewNetworkPatch(ctx.network, patch);
    if (!preview.ok) { lastFailure = preview.detail ?? preview.reason; continue; }
    const replacementEdges = [...byId.values()];
    let introducedContact = false;
    for (let i = 0; i < replacementEdges.length && !introducedContact; i++) for (let j = i + 1; j < replacementEdges.length; j++) {
      const left = ctx.network.edges.get(replacementEdges[i].edgeId), right = ctx.network.edges.get(replacementEdges[j].edgeId);
      if (left && right && !routesHaveUnjoinedContact(left, left.points, right, right.points)
        && routesHaveUnjoinedContact(left, replacementEdges[i].points, right, replacementEdges[j].points)) {
        introducedContact = true; break;
      }
    }
    if (introducedContact) { lastFailure = "joint-route-introduced-ground-contact"; continue; }
    const final = relocatedSitePositionFailure({ ...ctx, network: preview.network }, owner, at, true);
    if (final) { lastFailure = final; continue; }
    return { ok: true, patch };
  }
  return reject(lastFailure);
}

export function relocateSiteWithGroundRoads(ctx: RepairContext, ownerId: string, at: Vec2): { changes: number; reason?: string } {
  const proposal = prepareJointSiteRoadRelocation(ctx, ownerId, at);
  if (!proposal.ok) return { changes: 0, reason: proposal.reason };
  const owner = [...ctx.publicSites, ...ctx.landmarks].find(site => site.id === ownerId)!;
  const oldContacts = new Set(groundJunctionFindings([...ctx.network.edges.values()]).map(finding => finding.id));
  const result = commitNetworkPatch(ctx.network, proposal.patch, draft => {
    if (groundJunctionFindings([...draft.edges.values()]).some(finding => !oldContacts.has(finding.id))) return "joint-road-introduced-ground-contact";
    return relocatedSitePositionFailure({ ...ctx, network: draft }, owner, at, true);
  });
  if (!result.ok) return { changes: 0, reason: result.detail ?? result.reason };
  owner.x = at.x; owner.z = at.z;
  return { changes: 1 + proposal.patch.relineEdges!.length };
}
