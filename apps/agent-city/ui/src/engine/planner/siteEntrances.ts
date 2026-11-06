import { DetMath as Math } from "../detMath";
/**
 * 用地入口路（R5 步 6e）：自 cityPlan.ts::buildPlan 逐字迁出的「地面路口收口 → 孤立分量接入 → 逐用地入口路 / 堤道」工序段。
 *
 * 顺序（与原内联段一字不差）：connectGroundJunctions → connectGeneratedComponents() → 逐个公共用地/地标：
 * 海上岛地标先铺堤道（暂存草稿、成功才覆盖 nodes/edges 并记 bridges）；其余从门口接最近道路，
 * 失败则走岸边地块边界入口（proposeShorePlotAccess）或显式桥候选兜底。
 *
 * 对外部世界的读写（原为 buildPlan 闭包变量，现显式传入）：
 *   读：connectorWorld、connectToNetwork（闭包，内部自增 connectSeq——调用序不变）、
 *       connectGeneratedComponents（cityPlan 里的函数声明，被本段在 connectGroundJunctions 之后调用一次）、
 *       sailOperaCandidateSets、primaryAnchorNodeIds、reservations、key、terrain/core/coast/river（来自 geo）、
 *       seaside、coastRoadRuns、coastalRunCount、siteObligations、declaredSiteDemands
 *   原地改（保持对象身份与顺序）：network（nodes/edges/version/patchRemaps，含 commitNetwork 与手写覆盖）、
 *       publicSites / landmarks（挪动堤道地标、写 access）、bridges（push）、connectionLog（push；
 *       数组须在 cityPlan 里先建好——connectGeneratedComponents 也写它）
 *   新产生并返回：junctionReport
 * random() 不被本段使用。
 */
import type { CityLayout, PublicSite, RoadEdge, Vec2 } from "../cityLayout";
import type { Landmark } from "../cityPlan";
import type { SeasideBand } from "../citySeaside";
import { roadNodeId } from "../roadGeometry";
import { CONSTRAINTS, type CityPlan as ConstraintPlan } from "./constraints";
import { closestPolylineSegment } from "./footprint";
import { specByKind } from "./sitespec";
import { componentOf, type ConnectionDemand } from "./intent";
import { proposeShorePlotAccess } from "./shorePlotAccess";
import { commitNetwork, keyOf, type Network } from "./network";
import { runConnection, commitFixedLink, parseFailure, type ConnectionAttempt, type ConnectorWorld } from "./connect";
import { connectGroundJunctions } from "./junctions";
import { SAIL_OPERA_CONFIG, type settleSailOperaOffshore } from "./siting";
import type { buildGeography } from "./geography";

export type SiteEntranceWorld = {
  geo: ReturnType<typeof buildGeography>;
  core: Vec2;
  network: Network;
  connectorWorld: ConnectorWorld;
  connectToNetwork: (endpoint: Vec2, maxDistance: number, arterial: boolean, exclude?: (edge: RoadEdge) => boolean, minAngle?: number) => boolean;
  connectGeneratedComponents: () => void;
  publicSites: PublicSite[];
  landmarks: Landmark[];
  bridges: CityLayout["bridges"];
  connectionLog: ConnectionAttempt[];
  sailOperaCandidateSets: ReturnType<typeof settleSailOperaOffshore>;
  primaryAnchorNodeIds: string[];
  reservations: () => Array<PublicSite | Landmark>;
  seaside: SeasideBand | null;
  coastRoadRuns: Vec2[][];
  coastalRunCount: number;
  siteObligations: Array<{ ownerId: string; placed: boolean; reason?: string; routeRetries?: number }>;
  declaredSiteDemands: ConnectionDemand[];
};

export function connectSiteEntrances(w: SiteEntranceWorld) {
  const { geo, core, network, connectorWorld, connectToNetwork, connectGeneratedComponents, publicSites, landmarks, bridges, connectionLog,
    sailOperaCandidateSets, primaryAnchorNodeIds, reservations, seaside, coastRoadRuns, coastalRunCount, siteObligations, declaredSiteDemands } = w;
  const { terrain, coast, river } = geo;
  const { nodes, edges } = network;
  const key = keyOf;
  // Close the generated ground network before accepting a site's entrance.
  // Otherwise a valid shore attachment can be committed to a component whose
  // main-network route has not even been attempted yet.
  const junctionReport = connectGroundJunctions(connectorWorld);
  connectGeneratedComponents();
  for (const site of [...publicSites, ...landmarks]) {
    if (!site.radius) continue;
    // 海上岛地标：先铺堤道桥（岛缘 → 岸点），再从岸点往路网接路。落位期已验证
    // （占地圈全深水、岸点在实地 ≥0.3），此处仅事务化提交（commitFixedLink）。
    const landmarkSite = site as typeof site & { shore?: Vec2 };
    const ref: Vec2 = landmarkSite.shore ?? site;
    if (landmarkSite.shore) {
      const candidateSet = sailOperaCandidateSets.find((set) => set.siteId === (site.id ?? site.kind));
      const candidates = candidateSet?.candidates.slice(0, SAIL_OPERA_CONFIG.jointCandidates) ?? [{ x: site.x, z: site.z, yaw: site.yaw, shore: ref }];
      const original = { x: site.x, z: site.z, zShore: ref.z, shoreX: ref.x, yaw: site.yaw };
      const failed: string[] = [];
      let accepted = false;
      for (const candidate of candidates) {
        site.x = candidate.x; site.z = candidate.z; site.yaw = candidate.yaw; landmarkSite.shore = candidate.shore;
        const l = Math.hypot(site.x - candidate.shore.x, site.z - candidate.shore.z) || 1;
        const edgePt = key({ x: site.x - ((site.x - candidate.shore.x) / l) * site.radius * 0.9, z: site.z - ((site.z - candidate.shore.z) / l) * site.radius * 0.9 });
        const shorePt = key(candidate.shore);
        const staged: Network = { nodes: new Map([...network.nodes].map(([id, node]) => [id, { ...node }])), edges: new Map([...network.edges].map(([id, edge]) => [id, { ...edge, points: edge.points.map((p) => ({ ...p })) }])), version: 0 };
        const stagedConnector: ConnectorWorld = { ...connectorWorld, network: staged, reservations: () => connectorWorld.reservations().filter((reserved) => reserved !== site) };
        const causeway = commitFixedLink(stagedConnector, [{ a: shorePt, b: edgePt, arterial: false, bridge: true, primary: false }]);
        if (!causeway.ok) { failed.push(`causeway:${causeway.detail ?? causeway.reason}`); continue; }
        // 连接器的 owner-revalidation 必须能重新找到设施；路径候选本身仍从 blockers 中排除 owner。
        stagedConnector.reservations = connectorWorld.reservations;
        const stagedComponents = componentOf({ roadNodes: [...staged.nodes.values()], roadEdges: [...staged.edges.values()] } as ConstraintPlan);
        const primaryAnchor = primaryAnchorNodeIds.find((id) => staged.nodes.has(id));
        const primaryComponent = primaryAnchor ? stagedComponents.get(primaryAnchor) : undefined;
        if (!primaryComponent || ![...staged.edges.values()].some((edge) => !edge.bridge && stagedComponents.get(edge.from) === primaryComponent)) {
          failed.push("no-primary-ground-network-target"); continue;
        }
        const access = runConnection({ id: `causeway-access:${site.id ?? site.kind}`, source: shorePt,
          target: { kind: "primary", isPrimaryNode: (id) => stagedComponents.get(id) === primaryComponent }, purpose: "site-access", allowBridge: true, maxLength: 1000, roadClass: "local", minAngleDeg: 35 },
        stagedConnector, { strategies: ["direct-projection", "node-merge", "detour", "bridge-candidate"],
          bridge: { self: site, blockers: reservations().filter((reserved) => reserved !== site), siteGate: true } });
        if (!access.ok) { failed.push(`shore:${access.detail ?? access.reason}`); continue; }
        const acceptedComponents = componentOf({ roadNodes: [...staged.nodes.values()], roadEdges: [...staged.edges.values()] } as ConstraintPlan);
        if (acceptedComponents.get(roadNodeId(edgePt)) !== acceptedComponents.get(primaryAnchor!)) {
          failed.push("causeway-not-attached-to-primary"); continue;
        }
        site.access = { role: "plot-gate", capability: "island-causeway", nodeId: roadNodeId(edgePt), ownerX: site.x, ownerZ: site.z, ownerYaw: site.yaw };
        nodes.clear(); for (const [id, node] of staged.nodes) nodes.set(id, node);
        edges.clear(); for (const [id, edge] of staged.edges) edges.set(id, edge);
        network.version = staged.version;
        bridges.push({ from: shorePt, to: edgePt, angle: Math.atan2(edgePt.z - shorePt.z, edgePt.x - shorePt.x), length: Math.hypot(edgePt.x - shorePt.x, edgePt.z - shorePt.z) });
        for (const span of access.bridgeSpans) bridges.push({ from: span.from, to: span.to, angle: Math.atan2(span.to.z - span.from.z, span.to.x - span.from.x), length: Math.hypot(span.to.x - span.from.x, span.to.z - span.from.z) });
        accepted = true;
        break;
      }
      if (accepted) continue; // 堤道及岸侧主网引道已经作为同一草稿提交。
      site.x = original.x; site.z = original.z; site.yaw = original.yaw;
      landmarkSite.shore = { x: original.shoreX, z: original.zShore };
      const detail = `no joint causeway/shore-access candidate among ${candidates.length}: ${failed.slice(-4).join("; ")}`;
      connectionLog.push({ id: `causeway:${site.id ?? site.kind}`, purpose: "site-access", ok: false, reason: parseFailure(detail), detail });
      continue;
    }
    let nearest: { p: Vec2; d: number; edge: RoadEdge } | null = null;
    for (const edge of edges.values()) {
      if (edge.bridge) continue;
      const closest = closestPolylineSegment(edge.points, ref);
      if (!closest) continue;
      const p = closest.q; const d = closest.d;
      if (!nearest || d < nearest.d) nearest = { p, d, edge };
    }
    if (!nearest || nearest.d <= (landmarkSite.shore ? 6 : site.radius + 14)) continue;
    const ux = (nearest.p.x - ref.x) / nearest.d; const uz = (nearest.p.z - ref.z) / nearest.d;
    // 岸边地标（灯塔在岬角尖上）门口常是不可建的岸滩：沿朝路方向往里走到可建地面再起路。
    let reach = landmarkSite.shore ? 0 : site.radius + 6;
    // 不再向内陆走到可建地：岬角灯塔会走 100+，入口路从远处的路边起步、根本到不了地标（用户：门前要有路）。
    // 门口在不可建岸滩时，由下方的显式桥候选兜底（全程在陆上或 ≤84 连续水段成桥）。
    const gate = key({ x: ref.x + ux * reach, z: ref.z + uz * reach });
    if (!connectToNetwork(gate, 240, false) && !connectToNetwork(gate, 700, false, () => false, 35)) {
      const spec = specByKind(site.kind);
      if (spec?.plotBoundaryAccess) {
        const view = (candidate: Network, access?: PublicSite["access"]) => ({
          roadEdges: [...candidate.edges.values()], roadNodes: [...candidate.nodes.values()],
          publicSites: publicSites.map((owner) => owner === site && access ? { ...owner, access } : owner),
          landmarks, blocks: [], terrain, core, coast, river, waterEdges: geo.waterEdges, seaside,
          coastRoads: coastRoadRuns.slice(0, coastalRunCount), riverRoadRuns: coastRoadRuns.slice(coastalRunCount),
          primaryAnchorNodeId: primaryAnchorNodeIds.find((id) => candidate.nodes.has(id)) ?? null,
          siteObligations, demandCatalogue: declaredSiteDemands } as unknown as ConstraintPlan);
        const identity = (finding: { site?: string; at?: Vec2; detail?: string }) => JSON.stringify([finding.site, finding.at, finding.detail]);
        const baseline = new Map(CONSTRAINTS.map((rule) => [rule.id, new Set(rule.measure(view(network)).map(identity))]));
        const binding = (point: Vec2): NonNullable<PublicSite["access"]> => ({ role: "plot-gate", capability: "shore-plot-boundary",
          nodeId: roadNodeId(point), ownerX: site.x, ownerZ: site.z, ownerYaw: site.yaw,
          entranceId: "shore-plot-boundary", entranceEvidence: "plot-proxy" });
        const proposal = proposeShorePlotAccess(connectorWorld, site, spec,
          primaryAnchorNodeIds.find((id) => nodes.has(id)) ?? null, (candidate, point) => {
            for (const rule of CONSTRAINTS) if (rule.measure(view(candidate, binding(point)))
              .some((finding) => !baseline.get(rule.id)!.has(identity(finding)))) return `shore-plot-new-${rule.id}`;
            return null;
          });
        if (!proposal.ok) connectionLog.push({ id: `gate:${site.id}`, purpose: "site-access", ok: false,
          reason: "no-target", detail: proposal.reason });
        else {
          commitNetwork(network, proposal.network);
          network.patchRemaps = proposal.network.patchRemaps;
          site.access = binding(proposal.gate);
          for (const span of proposal.bridgeSpans) bridges.push({ from: span.from, to: span.to,
            angle: Math.atan2(span.to.z - span.from.z, span.to.x - span.from.x), length: Math.hypot(span.to.x - span.from.x, span.to.z - span.from.z) });
        }
        continue; // Replace, rather than duplicate, the original 40-host bridge tier.
      }
      // 兜底（批次 5-1 起统一走 bridge-candidate）：门口 → 近岸 → 桥 → 对岸 → 接入点（无水时纯地面引道）。
      // 地面引道不查 buildable/坡度（门前引道穿过不可建前滩带是历史口径，TerrainPatch 批次前的已知豁免）。
      const blockers = [...publicSites, ...landmarks].filter((o) => o !== site && o.radius);
      const bridged = runConnection({
        id: `gate:${site.id ?? site.kind}`,
        source: gate,
        target: { kind: "edges", include: () => true },
        purpose: "site-access",
        allowBridge: true,
        maxLength: 1e4, // 桥候选的界限是候选数（前 40 个投影点），不是半径（历史口径）
        roadClass: "local",
      }, connectorWorld, { strategies: ["bridge-candidate"], bridge: { self: site, blockers, siteGate: true }, crossings: true });
      for (const span of bridged.ok ? bridged.bridgeSpans : []) {
        bridges.push({ from: span.from, to: span.to, angle: Math.atan2(span.to.z - span.from.z, span.to.x - span.from.x), length: Math.hypot(span.to.x - span.from.x, span.to.z - span.from.z) });
      }
      if (!bridged.ok) connectionLog.push({ id: `gate:${site.id ?? site.kind}`, purpose: "site-access", ok: false, reason: bridged.reason, detail: bridged.detail });
    }
  }
  return { junctionReport };
}
