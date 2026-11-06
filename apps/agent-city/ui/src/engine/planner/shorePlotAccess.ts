/** Bounded shore plot proposals. A radial plot proxy is never a model-door proof. */
import { DetMath as Math } from "../detMath";
import type { Vec2 } from "../cityLayout";
import { closestPolylineSegment } from "./footprint";
import { keyOf, type Network } from "./network";
import { runConnection, type BridgeSpan, type ConnectorWorld } from "./connect";
import { CONNECTION_BUDGET } from "./connectionBudget";
import type { SiteSpec } from "./sitespec";

export const SHORE_PLOT_ACCESS_CONFIG = { version: 1, maxHostCandidates: CONNECTION_BUDGET.bridgeCandidates, maxRouteLength: 1e4 };
type PlotOwner = Vec2 & { id: string; kind: string; radius: number; yaw: number; access?: unknown; shore?: unknown };
type ShorePlotProposal = { ok: true; network: Network; gate: Vec2; bridgeSpans: BridgeSpan[];
  attempted: number; candidateLimit: number; hostId: string; entranceEvidence: "plot-proxy" }
  | { ok: false; reason: string; attempted: number; candidateLimit: number };

/** Every host consumes one slot in the original 40-host tier, including an
 * unusable gate. Do not spend the old single-gate 40 first and then call this. */
export function proposeShorePlotAccess(world: ConnectorWorld, owner: PlotOwner, spec: SiteSpec, primaryAnchor: string | null,
  validateProposal?: (network: Network, gate: Vec2) => string | null): ShorePlotProposal {
  const candidateLimit = SHORE_PLOT_ACCESS_CONFIG.maxHostCandidates;
  const rejected = (reason: string, attempted = 0): ShorePlotProposal => ({ ok: false, reason, attempted, candidateLimit });
  const declaration = spec.plotBoundaryAccess;
  if (!declaration || declaration.schemaVersion !== 1 || declaration.type !== "shore-plot-proxy"
    || spec.placement !== "shore" || spec.planarAccess || owner.access || owner.shore) return rejected("unsupported or bound shore plot capability");
  if (![owner.x, owner.z, owner.radius, owner.yaw, declaration.gateOffset].every(Number.isFinite)
    || owner.radius <= 0 || declaration.gateOffset !== 6) return rejected("invalid shore plot geometry");
  if (!primaryAnchor || !world.network.nodes.has(primaryAnchor)) return rejected("primary anchor missing");
  const adjacent = new Map<string, string[]>();
  for (const edge of world.network.edges.values()) {
    const from = adjacent.get(edge.from) ?? []; from.push(edge.to); adjacent.set(edge.from, from);
    const to = adjacent.get(edge.to) ?? []; to.push(edge.from); adjacent.set(edge.to, to);
  }
  const primary = new Set([primaryAnchor]), queue = [primaryAnchor];
  for (let i = 0; i < queue.length; i++) for (const next of adjacent.get(queue[i]) ?? []) if (!primary.has(next)) {
    primary.add(next); queue.push(next);
  }
  const roads = [...world.network.edges.values()].filter((edge) => !edge.bridge);
  const byId = (a: { edge: { id: string }; d: number }, b: { edge: { id: string }; d: number }) => a.d - b.d || (a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0);
  const near = roads.map((edge) => ({ edge, projection: closestPolylineSegment(edge.points, owner) }))
    .filter((entry): entry is typeof entry & { projection: NonNullable<typeof entry.projection> } => !!entry.projection)
    .map(({ edge, projection }) => ({ edge, ...projection })).sort(byId)[0];
  if (!near || near.d <= 0) return rejected("no nearest ground host");
  const reach = owner.radius + declaration.gateOffset;
  const oldGate = keyOf({ x: owner.x + (near.q.x - owner.x) * reach / near.d,
    z: owner.z + (near.q.z - owner.z) * reach / near.d });
  const hosts = roads.map((edge) => ({ edge, projection: closestPolylineSegment(edge.points, oldGate) }))
    .filter((entry): entry is typeof entry & { projection: NonNullable<typeof entry.projection> } => !!entry.projection)
    .map(({ edge, projection }) => ({ edge, ...projection })).sort(byId).slice(0, candidateLimit);
  const failures = new Map<string, number>(); let attempted = 0;
  for (const { edge } of hosts) {
    attempted += 1;
    if (!primary.has(edge.from) || !primary.has(edge.to)) { failures.set("non-primary-host", (failures.get("non-primary-host") ?? 0) + 1); continue; }
    // Use the actual polyline's arclength midpoint, never the endpoint chord.
    const lengths = edge.points.slice(1).map((point, i) => Math.hypot(point.x - edge.points[i].x, point.z - edge.points[i].z));
    let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
    let mid: Vec2 | null = null;
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] > 0 && remaining <= lengths[i]) {
        const a = edge.points[i], b = edge.points[i + 1], t = remaining / lengths[i];
        mid = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }; break;
      }
      remaining -= lengths[i];
    }
    if (!mid) { failures.set("invalid-host-polyline", (failures.get("invalid-host-polyline") ?? 0) + 1); continue; }
    const distance = Math.hypot(mid.x - owner.x, mid.z - owner.z);
    if (!Number.isFinite(distance) || distance <= 0) { failures.set("invalid-gate-direction", (failures.get("invalid-gate-direction") ?? 0) + 1); continue; }
    const gate = keyOf({ x: owner.x + (mid.x - owner.x) * reach / distance, z: owner.z + (mid.z - owner.z) * reach / distance });
    const network: Network = { ...world.network,
      nodes: new Map([...world.network.nodes].map(([id, node]) => [id, { ...node }])),
      edges: new Map([...world.network.edges].map(([id, road]) => [id, { ...road, points: road.points.map((point) => ({ ...point })) }])),
      patchRemaps: (world.network.patchRemaps ?? []).map((remap) => ({ nodes: { ...remap.nodes },
        edges: Object.fromEntries(Object.entries(remap.edges).map(([id, children]) => [id, [...children]])),
        paths: remap.paths.map((path) => ({ before: path.before.map((point) => ({ ...point })),
          after: path.after ? path.after.map((point) => ({ ...point })) : null })),
        positions: Object.fromEntries(Object.entries(remap.positions).map(([id, point]) => [id, { ...point }])) })) };
    const result = runConnection({ id: `plot:${owner.id}:${edge.id}`, source: gate,
      target: { kind: "edges", include: (candidate) => candidate.id === edge.id }, purpose: "site-access",
      allowBridge: true, maxLength: SHORE_PLOT_ACCESS_CONFIG.maxRouteLength, roadClass: "local" },
    { ...world, network }, { strategies: ["bridge-candidate"],
      bridge: { self: owner, blockers: world.reservations().filter((site) => (site as { id?: string }).id !== owner.id), siteGate: true }, crossings: true });
    const failure = result.ok ? validateProposal?.(network, gate) : result.detail ?? result.reason;
    if (failure) { const reason = result.ok ? failure : result.reason;
      failures.set(reason, (failures.get(reason) ?? 0) + 1); continue; }
    if (result.ok) return { ok: true, network, gate, bridgeSpans: result.bridgeSpans, attempted, candidateLimit,
      hostId: edge.id, entranceEvidence: "plot-proxy" };
  }
  return rejected(`no legal shore plot proposal [${[...failures].map(([reason, count]) => `${reason}=${count}`).join(", ")}]`, attempted);
}
