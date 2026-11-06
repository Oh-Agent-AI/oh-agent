import assert from "node:assert/strict";
import fs from "node:fs";
import { citySrc, loadCity } from "./city-kit/index.mjs";
const { declaredOwnerDetour, detourEndpointAnglesClear, prepareJointSiteRoadRelocation, relocateSiteWithGroundRoads, runRepairTransaction,
  createCityPlan, MIAMI_COASTAL,
  emptyNetwork, addNetworkEdge, localResiteCandidates, inspectModelGround, footprintPolylineDistance, resolveModelEnvelope,
  declaredGroundRoadClear, roadThroughSite, nudgeSitesOffRoads, polylineDistance, previewNetworkPatch, groundJunctionFindings } = await loadCity({
  "engine/planner/constraints.ts": ["roadThroughSite"], "engine/planner/repairs.ts": ["nudgeSitesOffRoads"], "engine/planner/footprint.ts": ["polylineDistance"],
  "engine/planner/jointSiteRoad.ts": ["declaredOwnerDetour", "detourEndpointAnglesClear", "prepareJointSiteRoadRelocation", "relocateSiteWithGroundRoads"],
  "engine/planner/solve.ts": ["runRepairTransaction"], "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge", "previewNetworkPatch"],
  "engine/planner/report.ts": ["groundJunctionFindings"],
  "engine/planner/siting.ts": ["localResiteCandidates"], "engine/planner/modelGround.ts": ["inspectModelGround"],
  "engine/cityPlan.ts": ["createCityPlan"], "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/modelEnvelope.ts": ["footprintPolylineDistance", "resolveModelEnvelope", "declaredGroundRoadClear"],
});
{
  const network = emptyNetwork();
  addNetworkEdge(network, { x: -20, z: 0 }, { x: 0, z: 0 }, true);
  addNetworkEdge(network, { x: 0, z: 0 }, { x: 20, z: 0 }, true);
  const road = [...network.edges.values()].find(edge => edge.to === "20:0");
  assert.equal(detourEndpointAnglesClear(network, road, { x: 0, z: 0 }, { x: -10, z: 1 }), false,
    "even a two-leg continuation cannot fold backwards into its incoming road");
  assert.equal(detourEndpointAnglesClear(network, road, { x: 0, z: 0 }, { x: 10, z: 10 }), true);
  addNetworkEdge(network, { x: 0, z: 0 }, { x: 0, z: -20 }, false);
  assert.equal(detourEndpointAnglesClear(network, road, { x: 0, z: 0 }, { x: 10, z: 10 }), true);
}
const footprint = { parts: [{ shape: "rect", center: { x: 0, z: 0 }, width: 20, depth: 20 }] };
for (const width of [5, 8, 12]) {
  const road = { width, points: [{ x: -50, z: 0 }, { x: 50, z: 0 }] };
  const before = JSON.stringify([footprint, road]);
  const route = declaredOwnerDetour(footprint, road); assert(route && route.length > 2);
  assert.deepEqual(route[0], road.points[0]); assert.deepEqual(route.at(-1), road.points.at(-1));
  assert(footprintPolylineDistance(footprint, route) >= width / 2 + 3);
  assert.deepEqual(declaredOwnerDetour(footprint, road), route);
  assert.equal(JSON.stringify([footprint, road]), before);
  assert.equal(declaredOwnerDetour(footprint, road, () => false), null);
  assert.equal(declaredOwnerDetour(footprint, { ...road, points: [{ x: 0, z: 0 }, road.points[1]] }), null);
}
const opening = { parts: [-20, 20].map(x => ({ shape: "rect", center: { x, z: 0 }, width: 10, depth: 10 })) };
const direct = [{ x: 0, z: -30 }, { x: 0, z: 30 }];
assert.deepEqual(declaredOwnerDetour(opening, { width: 8, points: [direct[0], { x: 20, z: 0 }, direct[1]] }), direct,
  "real union opening is clear; bounding corners must not become a solid hull");

const target = [...localResiteCandidates({ x: 0, z: 0 })].find(point => point.x > 110 && Math.abs(point.z) < 20); assert(target);
function fixture(half = 60) {
  const height = x => x > 20 ? 1.2 : -1;
  const terrain = { height, slope: () => 0, buildable: x => x > 20, coastRadius: () => 500, center: { x: 0, z: 0 }, radius: 500, hasRiver: false };
  const network = emptyNetwork(); addNetworkEdge(network, { x: target.x - half, z: target.z }, { x: target.x + half, z: target.z }, true, false, true);
  const road = [...network.edges.values()][0];
  return { network, primaryAnchorNodeId: road.from, publicSites: [], landmarks: [{ id: "landmark:joint-test", kind: "villa-complex", x: 0, z: 0, yaw: 0, radius: 34 }], blocks: [],
    height, inRiver: () => false, geo: { terrain, height, buildable: terrain.buildable, coastDistance: () => 20, landClearance: () => 1000,
      hasRiver: false, river: null, riverX: () => 0, riverWidth: () => 0, hillLine: 1000, hillProj: () => 0 },
    ringRuns: [], coast: [], core: { x: 100, z: 0 }, trunkRuns: [road.points], carPaths: [road.points, [...road.points].reverse()],
    bridges: [], SHORE_SITE_KINDS: new Set(["villa-complex", "lighthouse"]), seaside: null, coastRoadRunEnds: [], coastRoadRuns: [], riverRoadRuns: [], connectionLog: [] };
}
// An unrelated ground road blocks the shortest owner detour. Search must pick
// the other safe side rather than proposing a new unjoined at-grade contact.
const contactCtx = fixture(), contactOwner = contactCtx.landmarks[0], contactRoad = [...contactCtx.network.edges.values()][0];
const contactTarget = { x: target.x, z: target.z };
const contactEnvelope = resolveModelEnvelope({ ...contactOwner, ...contactTarget }).conservativeProjection;
const shortestDetour = declaredOwnerDetour(contactEnvelope, contactRoad); assert(shortestDetour && shortestDetour.length > 2);
let obstruction = null;
for (let i = 1; i < shortestDetour.length && !obstruction; i += 1) {
  const a = shortestDetour[i - 1], b = shortestDetour[i], dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
  const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  if (length < 35 || polylineDistance([contactRoad.points], mid) < 18) continue;
  obstruction = { a: { x: mid.x - dz / length * 12, z: mid.z + dx / length * 12 },
    b: { x: mid.x + dz / length * 12, z: mid.z - dx / length * 12 } };
}
assert(obstruction, "fixture must expose a clear detour segment away from the original road");
addNetworkEdge(contactCtx.network, obstruction.a, obstruction.b, false, false, false);
const contactBefore = groundJunctionFindings([...contactCtx.network.edges.values()]).map(finding => finding.id);
const contactProposal = prepareJointSiteRoadRelocation(contactCtx, contactOwner.id, contactTarget);
if (contactProposal.ok) {
  const contactPreview = previewNetworkPatch(contactCtx.network, contactProposal.patch); assert(contactPreview.ok);
  assert.deepEqual(groundJunctionFindings([...contactPreview.network.edges.values()]).map(finding => finding.id), contactBefore,
    "joint relocation must find a route that does not introduce a ground contact");
} else assert.match(contactProposal.reason, /ground-contact/,
  "an unusable combination of individually clear replacement routes must be rejected before publication");
const snapshot = ctx => JSON.stringify([ctx.landmarks, ctx.blocks, [...ctx.network.nodes], [...ctx.network.edges], ctx.network.version ?? 0,
  ctx.trunkRuns, ctx.carPaths, ctx.connectionLog]);
const ctx = fixture(), ownerId = ctx.landmarks[0].id, originalRoad = [...ctx.network.edges.values()][0], before = snapshot(ctx);
assert.equal(inspectModelGround(ctx.landmarks[0], ctx).status, "violation");
assert.equal(inspectModelGround({ ...ctx.landmarks[0], ...target }, ctx).status, "partial");
const proposal = prepareJointSiteRoadRelocation(ctx, ownerId, target); assert.ok(proposal.ok, proposal.reason);
assert.equal(snapshot(ctx), before);
// A late failure after mutating both pieces of the private draft publishes none.
const rejected = runRepairTransaction(ctx, { constraint: "siteInWater", name: "joint-late-refusal", run(draft) {
  const result = relocateSiteWithGroundRoads(draft, ownerId, target); assert(result.changes > 0, result.reason);
  return { changes: 0, reason: "joint-final-policy-refused" };
} });
assert.equal(rejected.changes, 0); assert.equal(snapshot(ctx), before);
const accepted = runRepairTransaction(ctx, { constraint: "siteInWater", name: "joint-ground-test", run: draft => relocateSiteWithGroundRoads(draft, ownerId, target) });
assert(accepted.changes > 0, accepted.reason);
const changed = ctx.network.edges.get(originalRoad.id); assert.equal(ctx.network.edges.size, 1);
assert.equal(changed.width, 12); assert.equal(changed.kind, "arterial"); assert.equal(changed.from, originalRoad.from); assert.equal(changed.to, originalRoad.to);
assert.deepEqual(ctx.carPaths, [changed.points, [...changed.points].reverse()]); assert.deepEqual(ctx.trunkRuns, [changed.points]);
assert.equal(ctx.landmarks[0].x, target.x); assert.equal(ctx.landmarks[0].z, target.z);
assert.equal(inspectModelGround(ctx.landmarks[0], ctx).status, "partial");
assert(footprintPolylineDistance(resolveModelEnvelope(ctx.landmarks[0]).conservativeProjection, changed.points) >= 9);
assert.equal(ctx.planningWorld.versions.network, 1); assert.equal(ctx.planningWorld.versions.site, 1);
const view = { publicSites: [], landmarks: ctx.landmarks, roadEdges: [changed] };
assert(polylineDistance([changed.points], ctx.landmarks[0]) < ctx.landmarks[0].radius * 0.7, "fixture must reproduce the old circle false rejection");
assert.equal(declaredGroundRoadClear(ctx.landmarks[0], [changed]), true);
assert.equal(declaredGroundRoadClear({ ...ctx.landmarks[0], yaw: NaN }, [changed]), false);
assert.equal(declaredGroundRoadClear(ctx.landmarks[0], [{ ...changed, points: undefined }]), false);
assert.equal(roadThroughSite.measure(view).length, 0);
const stable = snapshot(ctx); assert.equal(nudgeSitesOffRoads(ctx), 0); assert.equal(snapshot(ctx), stable);
const unknown = { ...ctx.landmarks[0], kind: "lighthouse" };
assert.equal(declaredGroundRoadClear(unknown, [changed]), undefined);
assert.equal(roadThroughSite.measure({ ...view, landmarks: [unknown] }).length, 1, "undeclared renderer keeps circle protection");
for (const failure of ["bound", "bridge", "endpoint", "parcel", "unknown", "undeclared"]) {
  const ctx = fixture(failure === "endpoint" ? 20 : 60), owner = ctx.landmarks[0];
  if (failure === "bound") owner.access = { nodeId: ctx.primaryAnchorNodeId };
  if (failure === "bridge") { const road = [...ctx.network.edges.values()][0]; road.bridge = true; road.structure = "deck"; }
  if (failure === "parcel") ctx.blocks.push({ id: "reserved", polygon: [], parcels: [{ id: "p", ...target, width: 2, depth: 2, yaw: 0 }] });
  if (failure === "unknown") owner.kind = "lighthouse";
  const before = snapshot(ctx), result = relocateSiteWithGroundRoads(ctx, owner.id, failure === "undeclared" ? { x: 9999, z: 0 } : target);
  assert.equal(result.changes, 0, failure); assert(result.reason, failure); assert.equal(snapshot(ctx), before, failure);
}
assert(!fs.readFileSync(`${citySrc}/engine/planner/jointSiteRoad.ts`, "utf8").includes("villa-complex"), "generic operation must not branch on model names");
for (const [seed, tier, cfg] of [[1703350391, 2, MIAMI_COASTAL], [2003037141, 1, MIAMI_COASTAL]]) {
  const plan = createCityPlan(seed, tier, cfg);
  assert.equal(plan.planningOutcome.groundCoverage.violations, 0, `seed ${seed}: declared ground violations`);
  assert.equal(plan.planningOutcome.groundFailures.length, 0, `seed ${seed}: ground placement failures`);
  assert.notEqual(plan.planningOutcome.status, "failed", `seed ${seed}: planning still failed`);
  assert(plan.planningOutcome.versions.network > 0 && plan.planningOutcome.versions.site > 0, `seed ${seed}: joint network/site revision missing`);
}
console.log("City joint site-road: synthetic safety, real registered ground recovery, atomic publication/refusal, car/trunk lineage and both named endpoint-blocked seeds passed; full model/budget coverage pending.");
