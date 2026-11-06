#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { siteRoadClear, toWorld, straddleSitesAcrossTrunk, emptyNetwork, addNetworkEdge, runRepairTransaction, groundJunctionFindings, snapNearEdgeJunctions, endpointRelineCandidates, relineLooseEndpoint,
  assignConnectedSite, specByKind, SITE_SPECS, canRelocateGroundSite, resolvePlanarAccess, planarAccessPose, stationEntranceLocal, settleShoreSitesOnCoast,
  trimLeafBeforeUnsafeCrossing, connectGroundJunctions, corridorViolation, validateCandidate, bridgeheadContinuity, roadReport, CONSTRAINTS, classifyRoadSegments, crowdedPolylinePair, commitNetworkPatch, diagnoseNetwork, componentOf, retainRepairDemands, remapDemandNode, REPAIR_STRATEGIES, resiteArchesOnAcceptedRoads, groundFrontageSegments, rerouteUnsafeGroundCrossings, jointJunctionSiteCandidates, moveJunctionSite, groundJunctionCorridorFailure, groundJunctionCorridorViolation, screenTrunkRoute, connectDisconnectedComponent, connectLooseEnd, pruneShortSpurs, extendLooseEnds, endpointClear } = await loadCity({
  "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge", "commitNetworkPatch"],
  "engine/planner/solve.ts": ["runRepairTransaction", "REPAIR_STRATEGIES", "resiteArchesOnAcceptedRoads"],
  "engine/planner/access.ts": ["groundFrontageSegments", "straddleSitesAcrossTrunk"],
  "engine/planFootprint.ts": ["siteRoadClear", "toWorld"],
  "engine/planner/report.ts": ["groundJunctionFindings", "roadReport"],
  "engine/planner/snapJunctions.ts": ["trimLeafBeforeUnsafeCrossing", "rerouteUnsafeGroundCrossings", "jointJunctionSiteCandidates", "moveJunctionSite", "snapNearEdgeJunctions", "endpointRelineCandidates", "relineLooseEndpoint"],
  "engine/planner/junctions.ts": ["connectGroundJunctions"],
  "engine/planner/validation.ts": ["corridorViolation", "validateCandidate"],
  "engine/planner/constraints.ts": ["bridgeheadContinuity", "CONSTRAINTS"],
  "engine/planner/relations.ts": ["classifyRoadSegments", "crowdedPolylinePair"],
  "engine/planner/repairs.ts": ["extendLooseEnds"],
  "engine/planner/connect.ts": ["endpointClear"],
  "engine/planner/intent.ts": ["diagnoseNetwork", "componentOf", "retainRepairDemands", "remapDemandNode"],
  "engine/planner/networkRepairs.ts": ["connectDisconnectedComponent", "connectLooseEnd", "pruneShortSpurs"],
  "engine/planner/civicClearance.ts": ["groundJunctionCorridorFailure", "groundJunctionCorridorViolation"],
  "engine/planner/skeleton.ts": ["screenTrunkRoute"],
  "engine/planner/jointSite.ts": ["assignConnectedSite"],
  "engine/planner/sitespec.ts": ["specByKind", "SITE_SPECS", "canRelocateGroundSite"],
  "engine/models/siteAccess.ts": ["resolvePlanarAccess", "planarAccessPose"],
  "engine/models/publicSiteGeometry.ts": ["stationEntranceLocal"],
  "engine/planner/siting.ts": ["settleShoreSitesOnCoast"],
});
const p = (x, z) => ({ x, z });
// Declared through-lanes are not exterior plot setbacks or whole-site exemptions.
for (const yaw of [0, Math.PI / 2, -0.73, 2.1]) {
  const owner = { id: "passage", kind: "arch", x: 27, z: -19, yaw, radius: 18 };
  const clear = (a, b, width = 12) => siteRoadClear(owner, toWorld(a, owner, yaw), toWorld(b, owner, yaw), width);
  assert.equal(clear(p(0, -30), p(0, 30)), true, "full road fits a declared through-passage");
  assert.equal(clear(p(0, 30), p(0, -30)), true, "travel direction does not change lane admission");
  assert.equal(clear(p(1, -30), p(1, 30)), true);
  assert.equal(clear(p(3, -30), p(3, 30)), false, "road shoulder clips a pier");
  assert.equal(clear(p(0, -30), p(0, 30), 16), false, "touching the pier is not spare passage width");
  assert.equal(clear(p(-30, 0), p(30, 0)), false, "a transverse route cannot use a passage declaration");
  assert.equal(clear(p(0, -30), p(10, 30)), false, "tilted road leaves the full-width lane");
  assert.equal(clear(p(18, -30), p(18, 30)), false, "passage does not waive exterior setback");
  assert.equal(clear(p(28, -30), p(28, 30)), true, "ordinary exterior setback remains usable");
  assert.equal(siteRoadClear({ ...owner, yaw: NaN }, p(0, -30), p(0, 30), 12), false);
  assert.equal(siteRoadClear({ ...owner, kind: "unknown-model" }, toWorld(p(0, -30), owner, yaw),
    toWorld(p(0, 30), owner, yaw), 12), false, "unknown models receive no passage exception");
}
{
  const arch = { id: "resite-passage", kind: "arch", x: 0, z: 0, yaw: 0, radius: 18 };
  const world = { publicSites: [], landmarks: [arch], trunkSegments: [[p(0, -30), p(0, 30)]],
    groundRoads: [{ points: [p(0, -30), p(0, 30)], width: 20 }], ringRuns: [],
    buildable: () => true, height: () => 1.2, inRiver: () => false, riverBank: () => false };
  arch.x = 50;
  straddleSitesAcrossTrunk(world);
  assert.equal(arch.x, 50, "wide actual host cannot pass admission through a width12 skeleton proxy");
  world.groundRoads[0].width = 12;
  straddleSitesAcrossTrunk(world);
  assert.equal(arch.x, 0);
}
const context = () => ({
  network: emptyNetwork(), publicSites: [], landmarks: [], blocks: [], core: p(0, 0),
  geo: { height: () => 1.2, buildable: () => true, terrain: { height: () => 1.2, slope: () => 0 }, river: null },
  inRiver: () => false, coast: [p(-100, 20), p(100, 20)], seaside: null,
  height: () => 1.2,
  coastRoadRuns: [], riverRoadRuns: [], coastRoadRunEnds: [], carPaths: [], bridges: [], connectionLog: [],
  SHORE_SITE_KINDS: new Set(), ringRuns: [], trunkRuns: [],
});
const snapshot = (ctx) => JSON.stringify({ ...ctx, network: { ...ctx.network, nodes: [...ctx.network.nodes], edges: [...ctx.network.edges] } });
const intentView = (ctx) => ({ roadNodes: [...ctx.network.nodes.values()], roadEdges: [...ctx.network.edges.values()],
  publicSites: ctx.publicSites, landmarks: ctx.landmarks, core: ctx.core, coast: ctx.coast, river: null,
  coastRoads: ctx.coastRoadRuns, riverRoadRuns: ctx.riverRoadRuns, seaside: ctx.seaside,
  primaryAnchorNodeId: ctx.primaryAnchorNodeId, siteObligations: ctx.siteObligations, demandCatalogue: ctx.demandCatalogue });
// A split child can duplicate the incoming leg after a sub-unit projection.
// Coalesce exact physical ground shapes, preserve the wider host and rewrite
// both traffic references. This is not permission to discard a road branch.
{
  const ctx = context(); ctx.primaryAnchorNodeId = "0:0";
  addNetworkEdge(ctx.network, p(0, 0), p(100, 0), true, false, true);
  addNetworkEdge(ctx.network, p(0, 0), p(50, 0.2), true);
  addNetworkEdge(ctx.network, p(50, 0.2), p(50, 40), true);
  ctx.carPaths.push([p(0, 0), p(50, 0.2), p(50, 40)]);
  ctx.coastRoadRuns.push([p(0, 0), p(100, 0)]);
  assert.ok(groundJunctionFindings([...ctx.network.edges.values()]).length);
  assert.equal(snapNearEdgeJunctions(ctx), 1);
  assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
  assert.equal(ctx.network.edges.get("0:0/50:0").width, 12);
  assert.equal(ctx.network.edges.get("100:0/50:0").width, 12);
  assert.equal(ctx.network.edges.get("50:0/50:40").width, 8);
  assert.deepEqual(ctx.carPaths[0], [p(0, 0), p(50, 0), p(50, 40)]);
  assert.deepEqual(ctx.coastRoadRuns[0], [p(0, 0), p(50, 0), p(100, 0)]);
  assert.equal(ctx.network.edges.size, 3);
}
// Shared stems realign to an existing junction using the original 24-unit/16
// candidate bound. Rotation cannot change graph ownership or the result.
for (const turns of [0, 1, 2, 3]) {
  const rotate = (x, z) => { for (let k = 0; k < turns; k++) [x, z] = [-z, x]; return p(x || 0, z || 0); };
  const id = point => `${point.x}:${point.z}`;
  const fixture = () => {
    const ctx = context(), a = rotate(0, 0), target = rotate(20, 0), source = rotate(10, 0.2), far = rotate(24, -5);
    ctx.primaryAnchorNodeId = id(a);
    addNetworkEdge(ctx.network, a, target, true, false, true);
    addNetworkEdge(ctx.network, target, rotate(40, 0), true, false, true);
    addNetworkEdge(ctx.network, a, source, true);
    addNetworkEdge(ctx.network, source, far, true);
    addNetworkEdge(ctx.network, far, rotate(34, -15), true);
    ctx.carPaths.push([a, source, far]);
    return { ctx, a, target, source, far, hostId: [id(a), id(target)].sort().join("/") };
  };
  const { ctx, a, target, source, far, hostId } = fixture(), before = snapshot(ctx);
  const candidate = endpointRelineCandidates(ctx, id(source)).find(candidate => candidate.hostId === hostId);
  assert(candidate); assert.deepEqual(candidate.at, target); assert.equal(snapshot(ctx), before);
  assert(endpointRelineCandidates(ctx, id(source)).length <= 16);
  assert.equal(relineLooseEndpoint(ctx, id(source), hostId, target), 1);
  assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
  assert.equal(ctx.network.edges.get(hostId).width, 12);
  assert.equal(ctx.network.edges.get([id(target), id(far)].sort().join("/")).width, 8);
  assert.deepEqual(ctx.carPaths[0], [a, target, far]);
  for (const denial of ["bound", "narrow-host", "incompatible-purpose", "bridge"]) {
    const test = fixture();
    if (denial === "bound") test.ctx.landmarks.push({ id: "bound", kind: "tower", radius: 0, x: 0, z: 0, yaw: 0, access: { nodeId: id(test.source) } });
    if (denial === "narrow-host") test.ctx.network.edges.get(test.hostId).width = 5;
    if (denial === "incompatible-purpose") test.ctx.network.edges.get(test.hostId).purpose = "waterfront";
    if (denial === "bridge") [...test.ctx.network.edges.values()].find(edge => edge.from === id(test.source) || edge.to === id(test.source)).bridge = true;
    const original = snapshot(test.ctx);
    assert(!endpointRelineCandidates(test.ctx, id(test.source)).some(candidate => candidate.hostId === test.hostId), denial);
    assert.equal(snapshot(test.ctx), original);
  }
}
// An explicitly requested joint relocation must handle a dry coastal blocker,
// not only a wet model. Extra spacing is owner data, never a building-name test.
{
  const fixture = () => ({ publicSites: [{ id: "reserved", kind: "station", x: 24, z: 0, radius: 10, yaw: 0 }],
    landmarks: [{ id: "movable", kind: "lighthouse", x: 0, z: 0, radius: 12, yaw: 0 }], core: p(0, 0), coast: [p(0, -20)],
    coastDistance: () => 4, height: () => 1.2, inRiver: () => false, riverBank: () => false, bridges: [], ringRuns: [],
    trunkRuns: [[p(-200, 30), p(200, 30)]], roadEnvelopes: [{ points: [p(-200, 30), p(200, 30)], width: 8 }],
    relocateSiteIds: new Set(["movable"]), neighbourMargins: new Map([["reserved", 10]]) });
  const ctx = fixture(); settleShoreSitesOnCoast(ctx);
  assert.ok(Math.hypot(ctx.landmarks[0].x - 24, ctx.landmarks[0].z) >= 32,
    "dry owner must actually leave the reserved neighbour clearance");
  assert.ok(Math.hypot(ctx.landmarks[0].x, ctx.landmarks[0].z) <= 70, "reuse the original bounded local tier");
  assert.ok(Math.abs(ctx.landmarks[0].z - 30) >= 12 + 8 / 2 + 3, "full road envelope remains clear");
  for (const denial of ["unscoped", "bound", "road-envelope"]) {
    const world = fixture();
    if (denial === "unscoped") delete world.relocateSiteIds;
    if (denial === "bound") world.landmarks[0].access = { nodeId: "accepted" };
    if (denial === "road-envelope") { world.trunkRuns = []; world.roadEnvelopes = [{ points: [p(-200, 0), p(200, 0)], width: 200 }]; }
    const before = JSON.stringify(world.landmarks);
    settleShoreSitesOnCoast(world);
    assert.equal(JSON.stringify(world.landmarks), before, `${denial}: no legal forced move may publish`);
  }
}
// Declaration-driven access: changing a model name with identical capability
// cannot change its pose/route. Missing or invalid data never falls back by name.
{
  const a = p(-600, 0), b = p(600, 0), network = emptyNetwork();
  addNetworkEdge(network, a, b, true, false, true);
  const world = { core: p(0, 0), R: 1200, turn: 0, coast: [], trunkRuns: [[a, b]], ringRuns: [], bridges: [], placed: [],
    height: () => 1.2, inRiver: () => false, riverBank: () => false, coastDistance: () => 1000, landClearance: () => 1000,
    buildable: () => true, hasRiver: false, riverX: () => 9999, riverWidth: () => 0, hillDir: p(0, 1), hillLine: 9999, hillProj: () => 0 };
  const connector = { network, geo: { height: world.height, buildable: world.buildable, terrain: { slope: () => 0 } },
    inRiver: world.inRiver, reservations: () => [] };
  const spec = specByKind("station"), frozen = JSON.stringify([...network.edges]);
  {
    const remote = emptyNetwork(), left = p(-600, 300), right = p(600, 300);
    addNetworkEdge(remote, left, right, true, false, true);
    const before = JSON.stringify([...remote.edges]);
    const limited = { ...world, trunkRuns: [[left, right]], buildable: (x, z) => Math.hypot(x, z) <= 25 };
    const unreachable = assignConnectedSite(limited, { ...connector, network: remote },
      { ...spec, nominalAnchor: { at: "core" } }, "unreachable", "-600:300");
    assert.equal(unreachable.site, null);
    assert.match(unreachable.reason, /no-target-outside-route-bound/);
    assert.equal(unreachable.routeRetries, 0, "provably unreachable gates must not enter repeated route search");
    assert.equal(JSON.stringify([...remote.edges]), before);
  }
  assert.equal(canRelocateGroundSite({ kind: "new-clinic" }, { ...spec, kind: "new-clinic" }), true);
  assert.equal(canRelocateGroundSite({ kind: "new-clinic" }, { ...spec, kind: "new-clinic", mobility: "fixed" }), false);
  assert.equal(canRelocateGroundSite({ kind: "new-clinic" }, { ...spec, kind: "new-clinic", mobility: "dependency-bound" }), false);
  assert.equal(canRelocateGroundSite({ kind: "new-clinic", access: { nodeId: "bound" } }, spec), false);
  assert.equal(canRelocateGroundSite({ kind: "new-clinic", shore: p(0, 0) }, spec), false);
  assert.equal(canRelocateGroundSite({ kind: "unregistered" }), false, "missing mobility declarations fail closed");
  const original = assignConnectedSite(world, connector, spec, "same-owner", "-600:0");
  const renamed = assignConnectedSite(world, connector, { ...spec, kind: "new-clinic" }, "same-owner", "-600:0");
  assert.ok(original.site && renamed.site);
  assert.deepEqual({ ...renamed.site, kind: original.site.kind }, original.site, "model name is not a planning decision");
  assert.deepEqual([...renamed.network.edges], [...original.network.edges]);
  assert.equal(renamed.site.access.entranceEvidence, "model-position");
  const lateralSpec = { ...spec, kind: "new-clinic", planarAccess: { ...spec.planarAccess,
    entrance: { ...spec.planarAccess.entrance, id: "side-door", local: {
      ...spec.planarAccess.entrance.local, x: { radiusScale: 0, offset: 10 } } } } };
  const lateral = assignConnectedSite(world, connector, lateralSpec, "lateral", "-600:0");
  assert.ok(lateral.site, lateral.reason);
  const gate = lateral.network.nodes.get(lateral.site.access.nodeId), yaw = lateral.site.yaw;
  const route = { x: gate.x - lateral.site.access.doorX, z: gate.z - lateral.site.access.doorZ };
  const normal = lateralSpec.planarAccess.entrance.outward;
  const outward = { x: normal.x * Math.cos(yaw) + normal.z * Math.sin(yaw), z: -normal.x * Math.sin(yaw) + normal.z * Math.cos(yaw) };
  assert.ok((route.x * outward.x + route.z * outward.z) / Math.hypot(route.x, route.z) > 0.99999,
    "off-centre model door must reach its own outward gate, not a centre-line proxy");
  for (const radius of [20, 32, 46]) {
    const access = resolvePlanarAccess(spec.planarAccess, radius);
    assert.ok(access.ok); assert.deepEqual(access.access.localDoor, stationEntranceLocal(radius));
    const resized = assignConnectedSite(world, connector, { ...spec, kind: "new-clinic", radius }, "resized", "-600:0");
    assert.ok(resized.site, resized.reason);
    const normal = access.access.outward;
    const pose = planarAccessPose(access.access, resized.site, { x: normal.x * Math.cos(resized.site.yaw) + normal.z * Math.sin(resized.site.yaw),
      z: -normal.x * Math.sin(resized.site.yaw) + normal.z * Math.cos(resized.site.yaw) });
    assert.ok(Math.hypot(pose.door.x - resized.site.access.doorX, pose.door.z - resized.site.access.doorZ) < 1e-8);
  }
  for (const outward of [p(1, 0), p(-1, 0), p(0, 1), p(0, -1)]) for (const toRoad of [p(1, 0), p(-1, 0), p(0, 1), p(0, -1)]) {
    const pose = planarAccessPose({ entranceId: "test", outward }, p(0, 0), toRoad);
    const direction = { x: outward.x * Math.cos(pose.yaw) + outward.z * Math.sin(pose.yaw),
      z: -outward.x * Math.sin(pose.yaw) + outward.z * Math.cos(pose.yaw) };
    assert.ok(Math.hypot(direction.x - toRoad.x, direction.z - toRoad.z) < 1e-8);
  }
  for (const declaration of [undefined, { ...spec.planarAccess, schemaVersion: 99 },
    { ...spec.planarAccess, entrance: { id: "zero", outward: p(0, 0) } },
    { ...spec.planarAccess, entrance: { id: "invalid", outward: p(NaN, 1) } },
    { ...spec.planarAccess, entrance: { id: "outside", outward: p(0, 1), local: { x: { radiusScale: 0, offset: 1000 }, z: { radiusScale: 0, offset: 0 } } } },
    { ...spec.planarAccess, entrance: { id: "bad-local", outward: p(0, 1), local: { x: { radiusScale: 0, offset: Infinity }, z: { radiusScale: 1, offset: 0 } } } }]) {
    const rejected = assignConnectedSite(world, connector, { ...spec, planarAccess: declaration }, "bad", "-600:0");
    assert.equal(rejected.site, null); assert.match(rejected.reason, /capability unsupported|invalid/);
  }
  assert.equal(JSON.stringify([...network.edges]), frozen, "proposals, including invalid capabilities, cannot publish roads");
}
// A failed coastal service route is a placement obligation even when the
// owner is neither wet nor overlapping. No road widening, deletion or relaxed
// snap is required; fixed gates, wet candidates, parcels and isolated roads veto it.
{
  const fixture = () => {
    const ctx = context(); ctx.coast = [p(80, -100)]; ctx.primaryAnchorNodeId = "-20:-75";
    ctx.geo.coastDistance = () => 1000; ctx.SHORE_SITE_KINDS.add("ferris-wheel");
    addNetworkEdge(ctx.network, p(-20, -75), p(120, -75), false);
    ctx.landmarks.push({ id: "wheel", kind: "ferris-wheel", x: 0, z: -200, radius: 11, yaw: 1.2 });
    return ctx;
  };
  const strategy = REPAIR_STRATEGIES.find((entry) => entry.name === "resiteUnservedShoreSites");
  const ctx = fixture(), frozen = snapshot(ctx), roadBytes = JSON.stringify([...ctx.network.edges]);
  assert.ok(diagnoseNetwork(intentView(ctx)).unmet.some((entry) => entry.demandId === "site:wheel"));
  const candidates = strategy.candidates(ctx);
  assert.ok(candidates.length); assert.equal(snapshot(ctx), frozen, "candidate enumeration is read-only");
  const result = runRepairTransaction(ctx, candidates[0]);
  assert.ok(result.changes > 0, JSON.stringify(result));
  assert.ok(diagnoseNetwork(intentView(ctx)).demands.find((entry) => entry.demand.id === "site:wheel").satisfied);
  assert.equal(JSON.stringify([...ctx.network.edges]), roadBytes, "safe reassignment preserves every original road and width");
  for (const denial of ["fixed", "wet", "parcel", "isolated"]) {
    const world = fixture();
    if (denial === "fixed") world.landmarks[0].access = { role: "plot-gate", nodeId: "missing", ownerX: 0, ownerZ: -200, ownerYaw: 1.2 };
    if (denial === "wet") { world.height = () => 0.2; world.geo.height = () => 0.2; }
    if (denial === "parcel") world.blocks.push({ id: "reserved", polygon: [], parcels: [{ id: "reserved/p", x: 80, z: -90, width: 80, depth: 80 }] });
    if (denial === "isolated") {
      addNetworkEdge(world.network, p(-300, -400), p(-200, -400), false);
      world.primaryAnchorNodeId = "-300:-400";
    }
    const before = snapshot(world);
    assert.equal(strategy.candidates(world).length, 0, `${denial} candidates cannot be admitted`);
    assert.equal(snapshot(world), before);
  }
}
// Wet coastal owners use the same original local tier, but relocate jointly
// without deleting parcels or losing a previously satisfied service demand.
{
  const fixture = () => {
    const ctx = context(), height = (_x, z) => z < -12 ? -1 : 1.2;
    ctx.height = height; ctx.geo.height = height; ctx.geo.terrain.height = height;
    ctx.geo.coastDistance = (_x, z) => Math.abs(z + 12);
    ctx.coast = [p(-150, -12), p(150, -12)]; ctx.primaryAnchorNodeId = "-100:20";
    ctx.SHORE_SITE_KINDS.add("ferris-wheel");
    addNetworkEdge(ctx.network, p(-100, 20), p(100, 20), false);
    ctx.landmarks.push({ id: "wet-shore", kind: "ferris-wheel", x: 0, z: -10, radius: 11, yaw: 0 });
    return ctx;
  };
  const strategy = REPAIR_STRATEGIES.find((entry) => entry.name === "resiteWetShoreSites"), ctx = fixture();
  const water = () => CONSTRAINTS.find((entry) => entry.id === "siteInWater").measure({ ...intentView(ctx), terrain: ctx.geo.terrain, blocks: ctx.blocks });
  assert.ok(water().length > 0);
  const before = snapshot(ctx), roads = JSON.stringify([...ctx.network.edges]);
  const candidates = strategy.candidates(ctx);
  assert.ok(candidates.length, "wet but served owners must have joint repair candidates");
  assert.equal(snapshot(ctx), before);
  const result = runRepairTransaction(ctx, candidates[0]);
  assert.ok(result.changes > 0, JSON.stringify(result));
  assert.notEqual(ctx.landmarks[0].z, -10);
  assert.equal(water().length, 0);
  assert.equal(JSON.stringify([...ctx.network.edges]), roads);
  assert.ok(diagnoseNetwork(intentView(ctx)).demands.find((entry) => entry.demand.id === "site:wet-shore").satisfied);
  const bound = fixture(); bound.landmarks[0].access = { nodeId: "-100:20" };
  assert.equal(strategy.candidates(bound).length, 0, "a bound owner is not movable");
}

// Persistent catalogue and nested transaction authority: merging a district
// must not erase its promise from later diagnostics or permit ledger edits.
{
  const ctx = context(); ctx.coast = []; ctx.primaryAnchorNodeId = "0:0";
  for (const x of [0, 80]) {
    const corners = [p(x, 0), p(x + 40, 0), p(x + 40, 40), p(x, 40)];
    for (let i = 0; i < 4; i += 1) addNetworkEdge(ctx.network, corners[i], corners[(i + 1) % 4], false);
  }
  const district = diagnoseNetwork(intentView(ctx)).demands.find((entry) => entry.demand.class === "district-access");
  const before = snapshot(ctx);
  const refused = runRepairTransaction(ctx, { name: "nested-discard", constraint: "disconnectedComponents", run: (draft) => {
    const child = runRepairTransaction(draft, { name: "merge-child", constraint: "disconnectedComponents", run: (world) => {
      addNetworkEdge(world.network, p(40, 0), p(80, 0), false); return 1;
    } });
    assert.ok(child.changes > 0, JSON.stringify(child));
    return 0;
  } });
  assert.equal(refused.changes, 0); assert.equal(snapshot(ctx), before, "discarded parent cannot publish its accepted child or catalogue");
  const joined = runRepairTransaction(ctx, { name: "nested-merge", constraint: "disconnectedComponents", run: (draft) =>
    runRepairTransaction(draft, { name: "merge-child", constraint: "disconnectedComponents", run: (world) => {
      addNetworkEdge(world.network, p(40, 0), p(80, 0), false); return 1;
    } }) });
  assert.ok(joined.changes > 0, JSON.stringify(joined));
  assert.ok(ctx.demandCatalogue.some((demand) => demand.id === district.demand.id));
  const final = diagnoseNetwork(intentView(ctx));
  assert.ok(final.demands.find((entry) => entry.demand.id === district.demand.id).satisfied,
    "merged district remains visible and satisfied across transactions");
  assert.deepEqual(final.unmet, []);
  const frozen = snapshot(ctx);
  for (const mutate of [
    (world) => { world.demandCatalogue = []; },
    (world) => { world.demandCatalogue.length = 0; },
    (world) => { world.demandCatalogue[0].required = false; },
    (world) => { world.demandCatalogue[0].anchor = "missing"; },
    (world) => { delete world.demandCatalogue[0]; },
    (world) => { delete world.demandCatalogue; },
    (world) => { Object.setPrototypeOf(world.demandCatalogue, []); },
    (world) => { Object.defineProperty(world, "demandCatalogue", { value: [] }); },
  ]) {
    const result = runRepairTransaction(ctx, { name: "tamper-catalogue", constraint: "disconnectedComponents", run: (draft) => { mutate(draft); return 1; } });
    assert.equal(result.changes, 0); assert.match(result.reason, /protected demand catalogue/);
    assert.equal(snapshot(ctx), frozen, "catalogue tampering must never alter the authority");
  }
  assert.equal(snapshot(ctx), frozen, "catalogue diagnostics are read-only");
}
// A nested near-edge repair carries its remap to the outer acceptance. Both
// the original endpoint ID and its new binding survive the final catalogue.
{
  const ctx = context(); ctx.coast = []; ctx.primaryAnchorNodeId = "-20:0";
  addNetworkEdge(ctx.network, p(-20, 0), p(20, 0), true);
  addNetworkEdge(ctx.network, p(0, -0.16), p(0, -20), true, false, true);
  const sourceId = "0:-0.16", demandId = `endpoint:${sourceId}`;
  const before = snapshot(ctx);
  assert.ok(diagnoseNetwork(intentView(ctx)).unmet.some((entry) => entry.demandId === demandId));
  const result = runRepairTransaction(ctx, { name: "nested-remap", constraint: "unjoinedGroundJunctions", run: (draft) =>
    runRepairTransaction(draft, { name: "snap-child", constraint: "unjoinedGroundJunctions", run: snapNearEdgeJunctions }) });
  assert.ok(result.changes > 0, JSON.stringify(result));
  assert.notEqual(snapshot(ctx), before);
  const demand = ctx.demandCatalogue.find((entry) => entry.id === demandId);
  assert.ok(demand); assert.equal(demand.originAnchor, sourceId); assert.notEqual(demand.anchor, sourceId);
  assert.ok(diagnoseNetwork(intentView(ctx)).demands.find((entry) => entry.demand.id === demandId).satisfied);
  assert.equal(ctx.demandCatalogue.filter((entry) => entry.class === "endpoint-access" && entry.anchor === demand.anchor).length, 1);
  const frozen = snapshot(ctx);
  const lost = runRepairTransaction(ctx, { name: "later-drop-bound-node", constraint: "looseInlandRoadEnds", run: (draft) => {
    draft.network.nodes.delete(demand.anchor);
    for (const [id, edge] of draft.network.edges) if (edge.from === demand.anchor || edge.to === demand.anchor) draft.network.edges.delete(id);
    return 1;
  } });
  assert.equal(lost.changes, 0); assert.match(lost.reason, /required demand binding removed/);
  assert.equal(snapshot(ctx), frozen);
}
// Unmet obligations cannot vanish just because a repair deletes their owner or
// disconnected component. A verified merge may rebind evidence, never its ID.
{
  const ctx = context(); ctx.primaryAnchorNodeId = "0:0";
  addNetworkEdge(ctx.network, p(0, 0), p(80, 0), false);
  ctx.siteObligations = [{ ownerId: "unplaced-required", placed: false }];
  const before = snapshot(ctx);
  const lost = runRepairTransaction(ctx, { constraint: "siteWithoutDoorRoad", name: "drop-unmet-owner",
    run: (draft) => { draft.siteObligations = []; return 1; } });
  assert.equal(lost.changes, 0); assert.match(lost.reason, /required demand owner removed/);
  assert.equal(snapshot(ctx), before, "rejecting a missing unmet owner is atomic");
  addNetworkEdge(ctx.network, p(200, 100), p(280, 100), false);
  const view = (world) => ({ roadNodes: [...world.network.nodes.values()], roadEdges: [...world.network.edges.values()],
    publicSites: world.publicSites, landmarks: world.landmarks, core: world.core, coast: [], river: null,
    coastRoads: [], riverRoadRuns: [], seaside: null, primaryAnchorNodeId: world.primaryAnchorNodeId,
    siteObligations: world.siteObligations });
  const original = view(ctx), originalBytes = JSON.stringify(original);
  const district = diagnoseNetwork(original).demands.find((entry) => entry.demand.class === "district-access");
  assert.ok(district && !district.satisfied);
  const erased = { ...original, roadNodes: original.roadNodes.filter((n) => n.x < 200),
    roadEdges: original.roadEdges.filter((e) => e.points[0].x < 200) };
  assert.match(retainRepairDemands(original, erased).reason, /required demand binding removed/);
  addNetworkEdge(ctx.network, p(80, 0), p(200, 100), false);
  const merged = retainRepairDemands(original, view(ctx));
  assert.equal(merged.reason, undefined);
  assert.ok(merged.demands.find((entry) => entry.demand.id === district.demand.id).satisfied,
    "a disappearing transient component diagnostic is a satisfied retained district, not a lost demand");
  const oldEndpoint = diagnoseNetwork(original).demands.find((entry) => entry.demand.class === "endpoint-access" && entry.demand.anchor === "280:100");
  assert.ok(oldEndpoint && !oldEndpoint.satisfied);
  const remap = { nodes: { "280:100": "80:0" }, edges: {}, paths: [], positions: {} };
  const rebound = { ...view(ctx), roadNodes: view(ctx).roadNodes.filter((n) => n.id !== "280:100"),
    roadEdges: view(ctx).roadEdges.map((edge) => edge.to === "280:100" ? { ...edge, to: "80:0", points: [p(200, 100), p(80, 0)] } : edge) };
  assert.match(retainRepairDemands(original, rebound).reason, /required demand binding removed/);
  const retained = retainRepairDemands(original, rebound, [remap]);
  assert.equal(retained.reason, undefined);
  assert.ok(retained.demands.find((entry) => entry.demand.id === oldEndpoint.demand.id).satisfied);
  assert.equal(remapDemandNode("280:100", [remap, { ...remap, nodes: { "80:0": "0:0" } }]), "0:0");
  assert.equal(remapDemandNode("280:100", [{ ...remap, nodes: { "280:100": null } }, remap]), null);
  assert.equal(JSON.stringify(original), originalBytes, "retention and evidence rebinding are read-only");
}
// Coastal reassignment consumes only declared existing slots; a far optional
// owner move and exposed-end access must remain one transaction.
{
  const fixture = (kind, radius) => {
    const ctx = context(); ctx.coast = [p(100, -100)]; ctx.primaryAnchorNodeId = "-20:0";
    ctx.SHORE_SITE_KINDS.add(kind); ctx.geo.coastDistance = () => 1000;
    addNetworkEdge(ctx.network, p(-20, 0), p(20, 0), true);
    addNetworkEdge(ctx.network, p(0, -0.16), p(0, -20), true, false, true);
    addNetworkEdge(ctx.network, p(20, 0), p(80, -75), true);
    addNetworkEdge(ctx.network, p(80, -75), p(120, -75), true);
    ctx.landmarks.push({ id: "coastal-owner", kind, x: 0, z: -39.9, radius, yaw: 0 });
    return ctx;
  };
  const strategy = REPAIR_STRATEGIES.find((entry) => entry.name === "jointJunctionSite");
  const real = fixture("villa-complex", 34), realBytes = snapshot(real);
  assert.equal(strategy.candidates(real).find((entry) => entry.name.endsWith(":shore")), undefined,
    "the actual large villa cannot fit this old tiny-slot fixture; do not widen budgets or invent a resize");
  assert.equal(snapshot(real), realBytes);
  const tiny = fixture("villa-complex", 11), tinyBytes = snapshot(tiny);
  const tinyCandidate = strategy.candidates(tiny).find((entry) => entry.name.endsWith(":shore"));
  assert.equal(tinyCandidate, undefined, "unsupported foundation dimensions must be rejected during candidate enumeration");
  const tinyResult = runRepairTransaction(tiny, { constraint: "siteInWater", name: "unsupported-ground-pose",
    run: draft => { draft.landmarks[0].yaw = 0.25; return 1; } });
  assert.equal(tinyResult.changes, 0); assert.match(tinyResult.reason, /registered-model-ground-unsupported-parameters/);
  assert.equal(snapshot(tiny), tinyBytes, "unsupported villa radius11 cannot publish a false physical success");
  // Explicitly test only the preexisting proxy layer here. This alias has no
  // ground model declaration and must never be counted as villa physical coverage.
  const proxyKind = "unregistered-shore-proxy";
  SITE_SPECS.push({ ...specByKind("villa-complex"), kind: proxyKind, radius: 11 });
  try {
  const ctx = fixture(proxyKind, 11);
  const before = snapshot(ctx), finding = groundJunctionFindings([...ctx.network.edges.values()])[0];
  const invalid = runRepairTransaction(ctx, { name: "undeclared-shore-slot", constraint: "unjoinedGroundJunctions",
    run: (draft) => moveJunctionSite(draft, finding.id, "coastal-owner", p(999, 999), true) });
  assert.equal(invalid.changes, 0); assert.equal(snapshot(ctx), before);
  const candidate = strategy.candidates(ctx).find((entry) => entry.name.endsWith(":shore"));
  assert.ok(candidate, "valid coastal slot must survive full-width pre-screening");
  assert.equal(snapshot(ctx), before, "enumeration cannot publish an owner or road change");
  const result = runRepairTransaction(ctx, candidate);
  assert.ok(result.changes > 0, JSON.stringify(result));
  assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
  assert.ok(ctx.landmarks[0].x > 80);
  assert.ok([...ctx.network.edges.values()].filter((road) => road.from === "0:-20" || road.to === "0:-20").length >= 2,
    "newly exposed terminal must stay present and actually connect");
  } finally { SITE_SPECS.pop(); }
}
// Short collinear graph edges remain one real frontage, while bends,
// intersections, bridges and incompatible road roles never become chords.
{
  const ctx = context();
  for (const x of [-30, -15, 0, 15]) addNetworkEdge(ctx.network, p(x, 0), p(x + 15, 0), true, false, true);
  const roads = [...ctx.network.edges.values()], before = snapshot(ctx);
  assert.deepEqual(groundFrontageSegments(roads), [[p(-30, 0), p(30, 0)]]);
  assert.deepEqual(groundFrontageSegments([...roads].reverse()), groundFrontageSegments(roads));
  const reversed = roads.map((road) => ({ ...road, from: road.to, to: road.from, points: [...road.points].reverse() }));
  assert.deepEqual(groundFrontageSegments(reversed), groundFrontageSegments(roads));
  assert.equal(snapshot(ctx), before);
  assert.equal(groundFrontageSegments(roads.map((road, index) => ({ ...road, width: index === 1 ? 8 : 12 }))).length, 2);
  assert.equal(groundFrontageSegments(roads.map((road, index) => ({ ...road, bridge: index === 1 }))).length, 2);
  assert.equal(groundFrontageSegments(roads.map((road, index) => ({ ...road, purpose: index === 1 ? "waterfront" : undefined }))).length, 3);
  assert.deepEqual(groundFrontageSegments(roads, NaN), []);
  assert.deepEqual(groundFrontageSegments([{ ...roads[0], points: [p(NaN, 0), p(-15, 0)] }]), []);
  addNetworkEdge(ctx.network, p(0, 0), p(0, 20), false);
  assert.equal(groundFrontageSegments([...ctx.network.edges.values()]).length, 2, "an intersection must split the frontage");
  const bent = { ...roads[0], points: [p(-30, 0), p(-25, 5), p(-15, 0)] };
  assert.equal(groundFrontageSegments([bent]).length, 2, "a curve cannot become an end-to-end chord");
}
for (const wet of [false, true]) {
  const ctx = context(); ctx.coast = [p(-1000, 1000), p(1000, 1000)]; ctx.primaryAnchorNodeId = "-40:0";
  for (const x of [-40, -20, 0, 20]) addNetworkEdge(ctx.network, p(x, 0), p(x + 20, 0), true, false, true);
  ctx.landmarks.push({ id: "arch", kind: "arch", x: 0, z: 50, radius: 4, yaw: 0 });
  ctx.publicSites.push({ id: "midpoint-blocker", kind: "park", x: 0, z: 14, radius: 5, yaw: 0 });
  addNetworkEdge(ctx.network, p(0, 25), p(0, 40), false);
  if (wet) ctx.geo.buildable = () => false;
  const before = snapshot(ctx), roads = JSON.stringify([...ctx.network.edges.values()]);
  const result = runRepairTransaction(ctx, { name: "resite-arch", constraint: "archStraddlesRoad", run: resiteArchesOnAcceptedRoads });
  if (wet) { assert.equal(result.changes, 0); assert.equal(snapshot(ctx), before); }
  else {
    assert.equal(result.changes, 2, JSON.stringify(result));
    assert.equal(ctx.landmarks[0].x, -20, "quarter-span retry must recover when every midpoint is blocked");
    assert.equal(CONSTRAINTS.find((constraint) => constraint.id === "archStraddlesRoad").measure({ roadEdges: [...ctx.network.edges.values()], publicSites: [], landmarks: ctx.landmarks }).length, 0);
    for (const road of JSON.parse(roads)) assert.equal(JSON.stringify(ctx.network.edges.get(road.id)), JSON.stringify(road), "arch placement must preserve every original road");
    assert.ok([...ctx.network.edges.values()].filter((road) => road.from === "0:40" || road.to === "0:40").length >= 2,
      "the old arch-exempt terminal must be repaired inside the same transaction");
  }
}
// A small optional-owner move and a true shared node must commit together.
// Protected owners and a poisoned footprint cannot acquire a weaker envelope.
for (const mode of ["safe", "protected", "wet"]) {
  const ctx = context(); ctx.coast = [p(-1000, 1000), p(1000, 1000)]; ctx.primaryAnchorNodeId = "-20:0";
  addNetworkEdge(ctx.network, p(-20, 0), p(20, 0), true);
  addNetworkEdge(ctx.network, p(0, -0.16), p(0, -20), true, false, true);
  const owner = { id: "optional-park", kind: "park", x: 0, z: -39.9, radius: 11, yaw: 0 };
  if (mode === "protected") owner.access = { role: "plot-gate", nodeId: "0:-20", ownerX: owner.x, ownerZ: owner.z, ownerYaw: 0 };
  ctx.publicSites.push(owner);
  if (mode === "wet") ctx.geo.height = () => -1;
  const before = snapshot(ctx), contact = groundJunctionFindings([...ctx.network.edges.values()])[0];
  if (mode === "protected") assert.equal(jointJunctionSiteCandidates(ctx).length, 0);
  const result = runRepairTransaction(ctx, { name: "joint-site-junction", constraint: "unjoinedGroundJunctions",
    run: (draft) => moveJunctionSite(draft, contact.id, owner.id, p(0, -40.9)) });
  if (mode === "safe") {
    assert.equal(result.changes, 1, JSON.stringify(result));
    assert.equal(ctx.publicSites[0].z, -40.9);
    assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
    assert.ok(ctx.network.nodes.has("0:0"));
    assert.equal([...ctx.network.edges.values()].filter((road) => road.width === 12).length, 1);
  } else { assert.equal(result.changes, 0); assert.equal(snapshot(ctx), before); }
}
// A new collector access is a separate road role, never a downgrade of the
// existing primary. Its width8 capsule still passes the same physical gate.
for (const unsafe of [false, true]) {
  const ctx = context(); ctx.coast = [p(-1000, 1000), p(1000, 1000)]; ctx.primaryAnchorNodeId = "0:-40";
  addNetworkEdge(ctx.network, p(0, -40), p(0, 0), true, false, true);
  addNetworkEdge(ctx.network, p(-40, 20), p(40, 20), true);
  const primaryId = "0:-40/0:0", primary = JSON.stringify(ctx.network.edges.get(primaryId));
  if (unsafe) ctx.geo.buildable = () => false;
  const before = snapshot(ctx);
  const result = runRepairTransaction(ctx, { name: "collector-access", constraint: "looseInlandRoadEnds",
    run: (draft) => connectLooseEnd(draft, "0:0", "direct-projection", true) });
  if (unsafe) { assert.equal(result.changes, 0); assert.equal(snapshot(ctx), before); }
  else {
    assert.equal(result.changes, 1, JSON.stringify(result));
    assert.equal(JSON.stringify(ctx.network.edges.get(primaryId)), primary);
    assert.equal(ctx.network.edges.get("0:0/0:20").width, 8);
    assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
  }
}
// Ordinary trunk prefixes and both real bridge approaches are screened before
// publication. Rejecting a deck must remove its approach exemption too.
{
  const ctx = context(); ctx.geo.buildable = (x) => x < 50;
  const world = { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [] };
  const before = snapshot(ctx), screened = screenTrunkRoute(world, [p(0, 0), p(20, 0), p(40, 0), p(60, 0)], [], 0);
  assert.equal(snapshot(ctx), before);
  assert.deepEqual(screened.points, [p(0, 0), p(20, 0), p(40, 0)]);
  assert.ok(screened.diagnostics.some((entry) => entry.cause === "building-setback"));
  assert.ok(commitNetworkPatch(ctx.network, screened.patch, screened.validate).ok);
  assert.ok(!ctx.network.nodes.has("60:0"));
  assert.ok([...ctx.network.edges.values()].every((edge) => edge.width === 12 && !edge.bridge));
}
for (const unsafe of [false, true]) {
  const ctx = context(); ctx.geo.buildable = (x) => Math.abs(x) > 30;
  ctx.inRiver = (x) => Math.abs(x) < 10;
  if (unsafe) ctx.geo.height = (x) => x >= 15 && x <= 25 ? 0.3 : 1.2;
  const span = { from: p(-20, 0), to: p(20, 0), angle: 0, length: 40 };
  const input = [p(-140, 0), p(-100, 0), p(-60, 0), p(-20, 0), p(20, 0), p(60, 0)];
  const world = { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [] };
  const before = snapshot(ctx), screened = screenTrunkRoute(world, input, [span], 0);
  assert.equal(snapshot(ctx), before, "screening must not publish pending bridges or ground edges");
  if (unsafe) {
    assert.deepEqual(screened.points, input.slice(0, 3)); assert.equal(screened.bridges.length, 0);
    assert.ok(screened.diagnostics.some((entry) => entry.cause === "missing-ground-approach"));
    assert.ok(screened.diagnostics.some((entry) => entry.cause === "building-setback"), "retained prefix cannot keep the rejected deck exemption");
  } else { assert.deepEqual(screened.points, input); assert.equal(screened.bridges.length, 1); }
  assert.ok(commitNetworkPatch(ctx.network, screened.patch, screened.validate).ok);
  assert.equal([...ctx.network.edges.values()].filter((edge) => edge.bridge).length, unsafe ? 0 : 1);
}
{
  const ctx = context(); ctx.geo.buildable = () => false;
  const world = { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [] };
  const detail = groundJunctionCorridorViolation(world, p(0, 0), p(20, 0), 12);
  assert.equal(detail.cause, "building-setback");
  assert.equal(groundJunctionCorridorFailure(world, p(0, 0), p(20, 0), 12), detail.kind);
  const before = snapshot(ctx), screened = screenTrunkRoute(world, [p(0, 0), p(20, 0), p(40, 0)], [], 0);
  assert.equal(screened.patch, null); assert.equal(snapshot(ctx), before);
  assert.ok(screened.diagnostics.some((entry) => entry.cause === "no-valid-trunk-prefix"));
}
// Endpoint-only references still own the entire curved edge. Optional short
// spurs may be removed, but no traffic/coast/river/boundary reference may vanish.
for (const mode of [null, "traffic", "coast", "river", "boundary"]) {
  const ctx = context(); ctx.coast = [p(-1000, 1000), p(1000, 1000)];
  const a = p(30, 0), b = p(30, 20);
  addNetworkEdge(ctx.network, p(0, 0), a, true, false, true);
  addNetworkEdge(ctx.network, a, p(60, 0), true, false, true);
  addNetworkEdge(ctx.network, a, b, false);
  ctx.network.edges.get("30:0/30:20").points = [a, p(45, 5), p(45, 15), b];
  if (mode === "traffic") ctx.carPaths = [[b, a]];
  if (mode === "coast") ctx.coastRoadRuns = [[a, b]];
  if (mode === "river") ctx.riverRoadRuns = [[b, a]];
  if (mode === "boundary") ctx.blocks = [{ id: "boundary", polygon: [a, b, p(60, 20), p(60, 0)], parcels: [] }];
  const before = snapshot(ctx), changed = pruneShortSpurs(ctx);
  if (mode) { assert.equal(changed, 0); assert.equal(snapshot(ctx), before); }
  else { assert.equal(changed, 1); assert.ok(!ctx.network.edges.has("30:0/30:20")); }
}
// Relocation must repair a proximity-exempt former access spur atomically.
// If a protected primary spur cannot be reconnected, reject the owner move too.
for (const protectedSpur of [false, true]) {
  const ctx = context(); ctx.coast = [p(-1000, 1000), p(1000, 1000)];
  ctx.height = ctx.geo.height; ctx.ringRuns = []; ctx.trunkRuns = []; ctx.SHORE_SITE_KINDS = new Set();
  ctx.geo.R = 1000; ctx.geo.bbox = { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };
  ctx.primaryAnchorNodeId = "-100:0";
  addNetworkEdge(ctx.network, p(-100, 0), p(75, 0), false);
  addNetworkEdge(ctx.network, p(75, 0), p(100, 0), false);
  addNetworkEdge(ctx.network, p(75, 0), p(75, -15), protectedSpur, false, protectedSpur);
  ctx.publicSites = [{ id: "park-owner", kind: "park", ...p(50, 0), radius: 20, yaw: 0 }];
  if (protectedSpur) ctx.geo.buildable = () => false;
  const before = snapshot(ctx);
  const outcome = runRepairTransaction(ctx, REPAIR_STRATEGIES.find((entry) => entry.name === "nudgeSitesWithAccessRepair"));
  if (protectedSpur) {
    assert.equal(outcome.changes, 0); assert.equal(snapshot(ctx), before);
    assert.equal(ctx.network.edges.get("75:-15/75:0").width, 12);
  } else {
    assert.ok(outcome.changes > 0, JSON.stringify(outcome));
    const plan = { roadNodes: [...ctx.network.nodes.values()], roadEdges: [...ctx.network.edges.values()],
      publicSites: ctx.publicSites, landmarks: [], seaside: null, coastRoads: [], riverRoadRuns: [], coast: ctx.coast,
      river: null, core: ctx.core, primaryAnchorNodeId: ctx.primaryAnchorNodeId, blocks: [], terrain: ctx.geo.terrain };
    assert.equal(CONSTRAINTS.find((entry) => entry.id === "roadThroughSite").measure(plan).length, 0);
    const ends = CONSTRAINTS.find((entry) => entry.id === "looseInlandRoadEnds").measure(plan);
    assert.ok(ends.length <= 2, "the two pre-existing unrelated ends must not increase");
    assert.ok(!ends.some((end) => end.at.x === 75 && end.at.z === -15), "the exposed owner spur must actually be repaired");
    assert.ok(diagnoseNetwork(plan).demands.find((entry) => entry.demand.id === "site:park-owner").satisfied);
  }
}
// Legacy ray extension cannot bypass the ordinary 35-degree T contract.
{
  const ctx = context(); ctx.coast = [p(-1000, 1000), p(1000, 1000)];
  addNetworkEdge(ctx.network, p(-30, -20), p(-15, -10), true);
  addNetworkEdge(ctx.network, p(-60, 0), p(60, 0), false);
  const before = snapshot(ctx);
  assert.equal(extendLooseEnds(ctx, "-15:-10"), 0);
  assert.equal(snapshot(ctx), before);
}
// Both angle clearance and crowding use real tangents/segments, not a chord.
{
  const network = emptyNetwork(); addNetworkEdge(network, p(0, 0), p(100, 0), false);
  [...network.edges.values()][0].points = [p(0, 0), p(0, 20), p(100, 0)];
  assert.equal(endpointClear(network, p(0, 0), p(0, 40)), false);
  assert.equal(endpointClear(network, p(0, 0), p(40, 0)), true);
  const u = [p(0, 0), p(0, 100), p(100, 100), p(100, 0)];
  assert.equal(crowdedPolylinePair(u, [p(20, 10), p(80, 10)]), null);
  const near = [p(20, 90), p(80, 90)], conflict = crowdedPolylinePair(u, near);
  assert.ok(conflict);
  assert.deepEqual(crowdedPolylinePair(near, u), conflict);
  assert.deepEqual(crowdedPolylinePair([...u].reverse(), [...near].reverse()), conflict);
}
// Extension intersects the third host segment and atomically splits the real
// curve. Width9, all old bends and both path directions must survive.
for (const unsafe of [false, true]) {
  const ctx = context(); ctx.coast = [p(-1000, 1000), p(1000, 1000)];
  addNetworkEdge(ctx.network, p(0, -60), p(0, -50), false);
  addNetworkEdge(ctx.network, p(-60, 30), p(-60, -30), true);
  const host = [...ctx.network.edges.values()].find((edge) => edge.kind === "arterial");
  host.width = 9; host.points = [p(-60, 30), p(60, 30), p(60, -30), p(-60, -30)];
  ctx.carPaths = [[...host.points].reverse()]; ctx.coastRoadRuns = [[host.points[0], host.points[3]]];
  if (unsafe) ctx.publicSites = [{ id: "blocker", kind: "park", ...p(0, -40), radius: 1, yaw: 0 }];
  const before = snapshot(ctx);
  const outcome = runRepairTransaction(ctx, { constraint: "looseInlandRoadEnds", name: "curve-extension",
    run: (draft) => extendLooseEnds(draft, "0:-50") });
  if (unsafe) { assert.equal(outcome.changes, 0); assert.equal(snapshot(ctx), before); }
  else {
    assert.equal(outcome.changes, 1, JSON.stringify(outcome));
    assert.ok(ctx.network.edges.has("0:-30/0:-50"));
    assert.ok(!ctx.network.edges.has(host.id));
    assert.ok([...ctx.network.edges.values()].filter((edge) => edge.kind === "arterial").every((edge) => edge.width === 9));
    const expected = [p(-60, 30), p(60, 30), p(60, -30), p(0, -30), p(-60, -30)];
    assert.deepEqual(ctx.coastRoadRuns[0], expected); assert.deepEqual(ctx.carPaths[0], [...expected].reverse());
    assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
  }
}
// A U road's chord is not a street: neither a phantom crossing nor a phantom
// door route is legal evidence. Actual curved-road segments and tangents are.
{
  const a = { ...p(0, 0), id: "0:0" }, b = { ...p(100, 0), id: "100:0" };
  const points = [a, p(0, 100), p(100, 100), b];
  const plan = { roadNodes: [a, b], roadEdges: [{ id: "0:0/100:0", from: a.id, to: b.id,
    width: 12, kind: "arterial", structure: "ground-road", points }], primaryAnchorNodeId: a.id,
    publicSites: [{ id: "probe", kind: "park", ...p(50, 0), radius: 5, yaw: 0 }], landmarks: [],
    coastRoads: [], riverRoadRuns: [], coast: [], river: null, seaside: null, core: a, blocks: [], terrain: { height: () => 1.2 } };
  const measure = (id) => CONSTRAINTS.find((constraint) => constraint.id === id).measure(plan);
  const before = JSON.stringify(plan);
  assert.equal(measure("roadThroughSite").length, 0);
  assert.equal(measure("siteWithoutDoorRoad").length, 1);
  assert.equal(diagnoseNetwork(plan).demands.find((entry) => entry.demand.id === "site:probe").satisfied, false);
  assert.equal(JSON.stringify(plan), before);
  plan.publicSites[0].z = 100;
  assert.equal(measure("roadThroughSite").length, 1);
  assert.equal(measure("siteWithoutDoorRoad").length, 0);
  assert.equal(diagnoseNetwork(plan).demands.find((entry) => entry.demand.id === "site:probe").satisfied, true);
  plan.publicSites = [{ id: "station", kind: "station", ...p(10, 50), radius: 12, yaw: -Math.PI / 2 }];
  assert.equal(measure("stationDoorFacesRoad").length, 0, "station must face the actual vertical segment");
  plan.publicSites = [{ id: "arch", kind: "arch", ...p(0, 50), radius: 12, yaw: 0 }];
  assert.equal(measure("archStraddlesRoad").length, 0, "arch uses its actual host-segment tangent");
  plan.publicSites = [{ id: "probe", kind: "park", ...p(50, 0), radius: 5, yaw: 0 }];
  plan.roadEdges[0].bridge = true; plan.roadEdges[0].structure = "deck";
  assert.equal(measure("siteWithoutDoorRoad").length, 1, "bridge chord cannot invent a door route");
}
// A closer isolated road is not a valid substitute for the requested primary
// component. Only the shared-anchor target may satisfy this repair candidate.
{
  const ctx = context(); ctx.coast = [p(-1000, 1000), p(1000, 1000)]; ctx.primaryAnchorNodeId = "0:0";
  for (const z of [0, 30, 40]) addNetworkEdge(ctx.network, p(0, z), p(40, z), false);
  const outcome = runRepairTransaction(ctx, { name: "primary-only", constraint: "disconnectedComponents",
    run: (draft) => connectDisconnectedComponent(draft, "0:30", "direct-projection") });
  assert.equal(outcome.changes, 1, JSON.stringify(outcome));
  const comp = componentOf({ roadNodes: [...ctx.network.nodes.values()], roadEdges: [...ctx.network.edges.values()] });
  assert.equal(comp.get("0:30"), comp.get("0:0"));
  assert.notEqual(comp.get("0:40"), comp.get("0:0"));
}
// Planned coast endpoints do not excuse an isolated component. Connect to the
// actual primary anchor and preserve existing paths/edges. Unsafe candidates
// must leave the full context unchanged, including failed draft logs.
for (const unsafe of [false, true]) {
  const ctx = context(); ctx.coast = [p(-1000, 1000), p(1000, 1000)];
  ctx.primaryAnchorNodeId = "0:0";
  addNetworkEdge(ctx.network, p(0, 0), p(40, 0), false);
  addNetworkEdge(ctx.network, p(0, 30), p(40, 30), false);
  ctx.coastRoadRuns = [[p(0, 30), p(40, 30)]]; ctx.coastRoadRunEnds = [p(0, 30), p(40, 30)];
  if (unsafe) ctx.geo.buildable = () => false;
  const before = snapshot(ctx), edges = [...ctx.network.edges].map(([id, edge]) => [id, JSON.stringify(edge)]);
  const outcome = runRepairTransaction(ctx, REPAIR_STRATEGIES.find((entry) => entry.name === "connectDisconnectedComponents"));
  if (unsafe) { assert.equal(outcome.changes, 0); assert.equal(snapshot(ctx), before); }
  else {
    assert.equal(outcome.changes, 1, JSON.stringify(outcome));
    for (const [id, shape] of edges) assert.equal(JSON.stringify(ctx.network.edges.get(id)), shape);
    assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
    const diagnostic = diagnoseNetwork({ roadNodes: [...ctx.network.nodes.values()], roadEdges: [...ctx.network.edges.values()],
      publicSites: [], landmarks: [], seaside: null, coastRoads: ctx.coastRoadRuns, riverRoadRuns: [], coast: ctx.coast,
      river: null, core: ctx.core, primaryAnchorNodeId: ctx.primaryAnchorNodeId });
    assert.ok(diagnostic.demands.some((entry) => entry.demand.class === "coastal-link" && entry.satisfied));
    assert.ok(!diagnostic.unmet.some((entry) => entry.demandId.startsWith("district:")));
  }
}
// Explicit waterfront roads use their roadway envelope, not a building's
// setback. Unknown purpose cannot inherit it; dry width, hills, slope and sites
// are still independently checked, and missing geography fails closed.
for (const failure of [null, "ordinary", "dry-width", "hill", "slope", "water", "missing-geo", "site"]) {
  const ctx = context(); ctx.geo.buildable = () => false;
  ctx.geo.landClearance = () => 5; ctx.geo.hillLine = 100; ctx.geo.hillProj = () => 0;
  addNetworkEdge(ctx.network, p(-20, 8), p(20, 8), true, false, true);
  const parent = [...ctx.network.edges.values()][0];
  if (failure !== "ordinary") parent.purpose = "waterfront";
  if (failure === "dry-width") ctx.geo.landClearance = (_x, z) => z;
  if (failure === "hill") ctx.geo.hillProj = () => 90;
  if (failure === "slope") ctx.geo.terrain.slope = () => 1;
  if (failure === "water") ctx.inRiver = () => true;
  if (failure === "missing-geo") delete ctx.geo.landClearance;
  if (failure === "site") ctx.publicSites = [{ x: 0, z: 8, radius: 2 }];
  const world = { network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => ctx.publicSites };
  const result = groundJunctionCorridorFailure(world, parent.points[0], parent.points[1], 12, parent);
  if (failure) assert.ok(result, `${failure} was incorrectly exempted`); else assert.equal(result, null);
}
// Reconstruct a terminal leg into a split host; do not append a parallel short
// connector. Source route references move with it, but owned gates stay fixed.
for (const owned of [false, true]) {
  const ctx = context(); ctx.coast = [p(-1000, 1000), p(1000, 1000)];
  const a = p(0, -40), source = p(0, 0);
  addNetworkEdge(ctx.network, a, source, true);
  addNetworkEdge(ctx.network, p(-30, 10), p(30, 10), true, false, true);
  ctx.carPaths = [[a, source]];
  if (owned) ctx.publicSites = [{ id: "fixed-gate", kind: "station", x: 0, z: 2, radius: 1, yaw: 0,
    access: { nodeId: "0:0", kind: "plot-gate", x: 0, z: 0 } }];
  const before = snapshot(ctx);
  const outcome = runRepairTransaction(ctx, REPAIR_STRATEGIES.find((entry) => entry.name === "jointEndpointReline"));
  if (owned) { assert.equal(outcome.changes, 0); assert.equal(snapshot(ctx), before); }
  else {
    assert.ok(outcome.changes > 0, JSON.stringify(outcome));
    assert.ok(!ctx.network.nodes.has("0:0"));
    assert.ok(ctx.carPaths[0].every((point) => ctx.network.nodes.has(`${point.x}:${point.z}`)));
    assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
  }
}
// A 32-degree cross cannot merely be split. Joint realignment must preserve
// all outer endpoints, primary widths and referenced routes; unsafe terrain
// must reject the complete candidate without any reference/geometry mutation.
for (const unsafe of [false, true]) {
  const ctx = context();
  ctx.coast = [p(-1000, 2000), p(1000, 2000)];
  const a = p(-126.22, 526), b = p(-132.94, 561.36), c = p(-128.96, 549.96), d = p(-138.99, 560.69);
  addNetworkEdge(ctx.network, a, b, true, false, true);
  addNetworkEdge(ctx.network, c, d, true, false, true);
  ctx.coastRoadRuns = [[a, b], [d, c]];
  if (unsafe) ctx.geo.buildable = () => false;
  const before = snapshot(ctx);
  const outcome = runRepairTransaction(ctx, REPAIR_STRATEGIES.find((entry) => entry.name === "jointGroundReline"));
  if (unsafe) { assert.equal(outcome.changes, 0); assert.equal(snapshot(ctx), before); }
  else {
    assert.equal(outcome.changes, 1, JSON.stringify(outcome));
    assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
    assert.ok([...ctx.network.edges.values()].every((edge) => edge.width === 12));
    for (const endpoint of [a, b, c, d]) assert.ok(ctx.network.nodes.has(`${endpoint.x}:${endpoint.z}`));
    assert.equal(ctx.coastRoadRuns[0].length, 3); assert.equal(ctx.coastRoadRuns[1].length, 3);
    assert.deepEqual(ctx.coastRoadRuns[0][1], ctx.coastRoadRuns[1][1]);
  }
}
// A bad candidate must not roll back a later independent, legal candidate.
{
  const ctx = context();
  for (const x of [0, 100]) {
    addNetworkEdge(ctx.network, p(x - 20, 0), p(x + 20, 0), true);
    addNetworkEdge(ctx.network, p(x, -20), p(x, 20), false);
  }
  const outcome = runRepairTransaction(ctx, { name: "independent", constraint: "unjoinedGroundJunctions", run: () => 0,
    candidates: () => [
      { name: "bad", constraint: "unjoinedGroundJunctions", run(draft) {
        draft.network.edges.get("100:-20/100:20").points = [p(100, -20), p(105, 0), p(100, 20)]; return 1;
      } },
      { name: "good", constraint: "unjoinedGroundJunctions", run(draft) {
        const result = commitNetworkPatch(draft.network, { baseVersion: draft.network.version ?? 0, addEdges: [], removeEdgeIds: [],
          splits: [{ edgeId: "-20:0/20:0", at: p(0, 0) }, { edgeId: "0:-20/0:20", at: p(0, 0) }] });
        return result.ok ? 1 : 0;
      } },
    ] });
  assert.equal(outcome.changes, 1);
  assert.match(outcome.reason, /bad:/);
  assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 1);
  assert.deepEqual(ctx.network.edges.get("100:-20/100:20").points, [p(100, -20), p(100, 20)]);
}
// Connected-component membership cannot hide an unfinished road endpoint.
{
  const ctx = context(); ctx.coast = [p(-100, 1000), p(100, 1000)];
  addNetworkEdge(ctx.network, p(0, 0), p(20, 0), false);
  const plan = { roadNodes: [...ctx.network.nodes.values()], roadEdges: [...ctx.network.edges.values()],
    publicSites: [], landmarks: [], seaside: null, coastRoads: [], riverRoadRuns: [], coast: ctx.coast,
    river: null, core: p(0, 0), primaryAnchorNodeId: "0:0" };
  const diagnostic = diagnoseNetwork(plan);
  assert.equal(diagnostic.unmet.length, 2);
  for (const endpoint of diagnostic.endpoints) {
    assert.equal(endpoint.role.kind, "must-connect");
    assert.ok(diagnostic.demands.some((entry) => entry.demand.id === endpoint.role.demandId && !entry.satisfied));
  }
}
// Moving the incoming primary leg makes its remote junction acute. The host
// alternative must still be attempted and preserve that primary leg exactly.
{
  const ctx = context(); ctx.coast = [p(-100, 1000), p(100, 1000)];
  const source = p(0, 0.25), far = p(10, 20);
  addNetworkEdge(ctx.network, source, far, true, false, true);
  addNetworkEdge(ctx.network, p(-10, 0), p(2.5, 0), true);
  addNetworkEdge(ctx.network, p(2.5, 0), p(10, -10), true);
  addNetworkEdge(ctx.network, far, p(11.74, 0.08), false);
  addNetworkEdge(ctx.network, far, p(30, 20), false);
  const primary = [...ctx.network.edges.values()].find((edge) => edge.width === 12);
  const before = JSON.stringify(primary);
  const strategy = REPAIR_STRATEGIES.find((entry) => entry.name === "snapNearEdgeJunctions");
  const outcome = runRepairTransaction(ctx, strategy);
  assert.equal(outcome.changes, 1, JSON.stringify(outcome));
  assert.match(outcome.reason, /acuteJunctions/);
  assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
  assert.equal(JSON.stringify(ctx.network.edges.get(primary.id)), before);
}
// Primary corridors may be rerouted, never downgraded or silently detached from
// declared paths. This is a route replacement, not permission to delete them.
for (const referenced of [false, true]) {
  const ctx = context();
  ctx.geo.R = 1000; ctx.geo.bbox = { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };
  addNetworkEdge(ctx.network, p(-50, 0), p(50, 0), true, false, true);
  addNetworkEdge(ctx.network, p(-40, -20), p(40, 20), true, false, true);
  if (referenced) ctx.coastRoadRuns = [[p(-50, 0), p(50, 0)], [p(-40, -20), p(40, 20)]];
  const before = snapshot(ctx), result = rerouteUnsafeGroundCrossings(ctx);
  if (referenced) { assert.equal(result.changes, 0); assert.equal(snapshot(ctx), before); }
  else {
    assert.equal(result.changes, 1, JSON.stringify(result));
    assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
    assert.ok([...ctx.network.edges.values()].every((edge) => edge.width === 12));
    for (const id of ["-50:0", "50:0", "-40:-20", "40:20"]) assert.ok(ctx.network.nodes.has(id));
  }
}
{
  const shared = p(-277.98, -669.89);
  assert.equal(classifyRoadSegments(p(-254.1, -667.55), shared, shared, p(-284.19, -660.45)).kind, "endpoint-contact");
  assert.equal(classifyRoadSegments(p(0, 0), p(20, 0), p(20, 0), p(10, 0)).kind, "collinear-overlap");
}

// Legacy slope summaries retain separate setback and physical-slope evidence.
{
  const ctx = context(), world = { ...ctx, reservations: () => [] };
  const policy = { requireBuildable: true, maxSlope: 1, sites: [], siteMargin: 0, roadWidth: 5 };
  ctx.geo.buildable = () => false;
  assert.equal(corridorViolation(world, p(0, 0), p(20, 0), policy).cause, "building-setback");
  ctx.geo.buildable = () => true; ctx.geo.terrain.slope = () => 2;
  assert.equal(corridorViolation(world, p(0, 0), p(20, 0), policy).cause, "road-slope");
}
// Exact T contact without a host split, a 0.16 gap and overlap all fail the same
// final screen; proximity alone never creates a graph junction.
for (const [a, b] of [[p(0, -20), p(0, 0)], [p(0, -20), p(0, -0.16)], [p(-10, 0), p(10, 0)]]) {
  const ctx = context(); addNetworkEdge(ctx.network, p(-30, 0), p(30, 0), false);
  const before = snapshot(ctx);
  const verdict = validateCandidate({ ...ctx, reservations: () => [] }, ctx.network,
    { id: "contact", crossings: false, blockers: [], gate: false, segments: [{ a, b, width: 5, kind: "ground-road" }] },
    { roadPolicy: { requireBuildable: true, maxSlope: 1, sites: [], siteMargin: 0 } });
  assert.ok(!verdict.ok && verdict.violations.some((v) => v.kind === "crossing"));
  assert.equal(snapshot(ctx), before);
}
// A dangling bridge endpoint is invalid even if a dangling ground edge uses it.
{
  const ctx = context(); addNetworkEdge(ctx.network, p(0, 0), p(20, 0), true, true);
  addNetworkEdge(ctx.network, p(20, 0), p(40, 0), false);
  ctx.network.nodes.delete("20:0");
  const plan = { roadNodes: [...ctx.network.nodes.values()], roadEdges: [...ctx.network.edges.values()], publicSites: [], landmarks: [] };
  assert.ok(bridgeheadContinuity.measure(plan).some((v) => /20:0 is missing/.test(v.detail)));
  assert.ok(roadReport({ ...plan, nodes: plan.roadNodes, blocks: [] }).graph.bridges.violations.length > 0,
    "explicitly missing bridge node is invalid in the report too");
}
// An offshore owner must explicitly own the endpoint; nearby geometry, stale
// placement or the wrong role is not a valid bridgehead exception.
{
  const ctx = context(); addNetworkEdge(ctx.network, p(0, 0), p(20, 0), true, true);
  addNetworkEdge(ctx.network, p(20, 0), p(40, 0), false);
  const owner = { id: "island", kind: "sail-opera", x: 0, z: 0, yaw: 0, radius: 10, shore: p(20, 0) };
  const plan = { roadNodes: [...ctx.network.nodes.values()], roadEdges: [...ctx.network.edges.values()], publicSites: [], landmarks: [owner] };
  assert.equal(bridgeheadContinuity.measure(plan).length, 1);
  owner.access = { role: "plot-gate", nodeId: "0:0", ownerX: 0, ownerZ: 0, ownerYaw: 0 };
  assert.equal(bridgeheadContinuity.measure(plan).length, 0);
  const report = () => roadReport({ ...plan, nodes: plan.roadNodes, blocks: [] }).graph.bridges.violations;
  assert.equal(report().length, 0, "declared current island gate is not a broken landing");
  owner.x = 1;
  assert.equal(bridgeheadContinuity.measure(plan).length, 1);
  assert.equal(report().length, 1, "stale owner must fail both reporting faces");
  owner.x = 0; owner.access.role = "near-road";
  assert.equal(report().length, 1);
  owner.access.role = "plot-gate"; owner.shore.x = NaN;
  assert.equal(bridgeheadContinuity.measure(plan).length, 1);
  assert.equal(report().length, 1, "malformed shore cannot grant a gate exception");
}

// Even when the total decreases, moving a surviving contact to another location
// on the same edge pair must fail atomically (IDs alone are insufficient).
{
  const ctx = context();
  for (const x of [0, 100]) {
    addNetworkEdge(ctx.network, p(x - 20, 0), p(x + 20, 0), true);
    addNetworkEdge(ctx.network, p(x, -20), p(x, 20), false);
  }
  assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 2);
  const before = snapshot(ctx);
  const result = runRepairTransaction(ctx, { name: "move-contact", constraint: "unjoinedGroundJunctions", run(draft) {
    const first = [...draft.network.edges.values()].find((e) => e.from === "0:-20");
    first.points = [p(0, -20), p(30, -20), p(30, 20), p(0, 20)];
    const second = [...draft.network.edges.values()].find((e) => e.from === "100:-20");
    second.points = [p(100, -20), p(105, 0), p(100, 20)];
    assert.equal(groundJunctionFindings([...draft.network.edges.values()]).length, 1);
    return 1;
  } });
  assert.match(result.reason, /unjoinedGroundJunctions introduced at a new object/);
  assert.equal(result.changes, 0);
  assert.equal(snapshot(ctx), before);
}

const shoreFixture = () => {
  const ctx = context();
  ctx.geo.terrain.slope = (_x, z) => z > -2 ? 2 : 0;
  addNetworkEdge(ctx.network, p(-50, 0), p(50, 0), true, false, true);
  addNetworkEdge(ctx.network, p(0, -40), p(0, 5), false);
  ctx.coastRoadRunEnds = [p(0, 5)];
  return ctx;
};
// A declared, unreferenced shore stop may retreat from unsafe terrain.
{
  const ctx = shoreFixture();
  assert.equal(trimLeafBeforeUnsafeCrossing(ctx).changes, 1);
  assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
  assert.ok(!ctx.network.nodes.has("0:5"));
  const end = ctx.coastRoadRunEnds[0];
  assert.ok(ctx.network.nodes.has(`${end.x}:${end.z}`));
  assert.equal(trimLeafBeforeUnsafeCrossing(ctx).changes, 0);
}
// Proximity alone, an owner, an anchor, any path reference, or no terrain failure
// must prevent trimming. Rejection preserves topology, declarations and logs.
for (const protect of [
  (ctx) => { ctx.coastRoadRunEnds = []; },
  (ctx) => { ctx.publicSites = [{ id: "gate", kind: "park", x: 80, z: 80, radius: 2, access: { nodeId: "0:5" } }]; },
  (ctx) => { ctx.primaryAnchorNodeId = "0:5"; },
  (ctx) => { ctx.carPaths = [[p(0, 5)]]; },
  (ctx) => { ctx.geo.terrain.slope = () => 0; },
]) {
  const ctx = shoreFixture(); protect(ctx);
  const before = snapshot(ctx);
  assert.equal(trimLeafBeforeUnsafeCrossing(ctx).changes, 0);
  assert.equal(snapshot(ctx), before);
}

// Ordinary junctions at 32 degrees are not a special turning geometry; 40 is legal.
for (const [degrees, expected] of [[32, 0], [40, 1]]) {
  const ctx = context(), angle = degrees * Math.PI / 180;
  addNetworkEdge(ctx.network, p(-100, 0), p(100, 0), true);
  addNetworkEdge(ctx.network, p(-100 * Math.cos(angle), -100 * Math.sin(angle)), p(100 * Math.cos(angle), 100 * Math.sin(angle)), false);
  const before = snapshot(ctx);
  const result = connectGroundJunctions({ network: ctx.network, geo: ctx.geo, inRiver: ctx.inRiver, reservations: () => [] });
  assert.equal(result.connected, expected);
  if (!expected) {
    assert.ok(result.declined.some((d) => d.reason === "junction-angle"));
    assert.equal(snapshot(ctx), before);
  } else assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
}
console.log("City repair safety: atomic contact/shore/angle guards; shared T/near/overlap final screen; separate setback/slope evidence; missing bridge nodes and stale/unowned island gates rejected.");
