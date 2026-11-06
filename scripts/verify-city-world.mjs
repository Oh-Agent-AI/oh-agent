#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { createPlanningWorld, applyWorldPatch, worldEvidenceFailure, WORLD_VERSION_DOMAINS,
  emptyNetwork, addNetworkEdge, runRepairTransaction, initializeRepairPlanningWorld, repairPlanningOutcome, runRepairDerivedFinalization,
  REPAIR_STRATEGIES, createCityPlan, MIAMI_COASTAL, diagnoseNetwork } = await loadCity({
  "engine/planner/world.ts": ["createPlanningWorld", "applyWorldPatch", "worldEvidenceFailure", "WORLD_VERSION_DOMAINS"],
  "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge"],
  "engine/planner/solve.ts": ["runRepairTransaction", "initializeRepairPlanningWorld", "repairPlanningOutcome", "runRepairDerivedFinalization", "REPAIR_STRATEGIES"],
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/intent.ts": ["diagnoseNetwork"],
});
const versions = Object.fromEntries(WORLD_VERSION_DOMAINS.map(domain => [domain, 0]));
const demand = { id: "station-service", ownerId: "site:1", purpose: "model-entrance", required: true };
const physical = version => ({ status: "verified", evidence: { id: "physical:fixture", dependencies: [...WORLD_VERSION_DOMAINS], versions: version } });
const pending = { status: "pending", reason: "fixture has no shared-policy validation yet" };
const reservation = (id = "plot:1") => ({ id, ownerId: "site:1", purpose: "plot-and-entrance",
  envelope: { type: "polygon", points: [{ x: 0, z: 0 }, { x: 12, z: 0 }, { x: 0, z: 12 }] },
  layer: "ground", elevation: { min: 0, max: 3 }, state: "tentative", immutable: false,
  required: true, demandIds: [demand.id], physical: pending });
const initialInput = { versions, demands: [demand], reservations: [reservation()],
  budget: { limits: { candidates: 3, geometry: 5 }, consumed: { candidates: 0 } } };
const initial = createPlanningWorld(initialInput);
const saved = JSON.stringify(initial);
initialInput.reservations[0].envelope.points[0].x = 900;
assert.equal(JSON.stringify(initial), saved, "authority is detached from caller-owned nested data");
assert.ok(Object.isFrozen(initial) && Object.isFrozen(initial.reservations[0].envelope.points[0]));
assert.throws(() => { initial.reservations[0].state = "released"; }, TypeError);
assert.throws(() => { initial.demands.pop(); }, TypeError);
const patch = (world, operations, extra = {}) => ({ expectedVersions: world.versions, operations, ...extra });
function accept(result) { assert.equal(result.ok, true, result.reason); return result.world; }
function reject(world, value, pattern) {
  const snapshot = JSON.stringify(world);
  const result = applyWorldPatch(world, value);
  assert.equal(result.ok, false);
  assert.match(result.reason, pattern);
  assert.equal(result.world, world, "failure returns the identical authority");
  assert.equal(JSON.stringify(world), snapshot, "rejected draft has zero side effects");
}
reject(initial, patch(initial, [{ type: "transition", id: "plot:1", to: "accepted" }]), /physical-pending/);
reject(initial, patch(initial, [{ type: "transition", id: "plot:1", to: "accepted", physical: { status: "unsupported", reason: "unknown model" } }]), /physical-unsupported/);
reject(initial, patch(initial, [{ type: "transition", id: "plot:1", to: "accepted", physical: physical(initial.versions) }]), /stale-evidence.*reservation/);
const acceptedVersions = { ...initial.versions, reservation: 1 };
const accepted = accept(applyWorldPatch(initial, patch(initial, [{ type: "transition", id: "plot:1", to: "accepted", physical: physical(acceptedVersions) }], { charge: { candidates: 1, geometry: 2 } })));
assert.equal(accepted.reservations[0].state, "accepted");
assert.equal(accepted.budget.consumed.geometry, 2);
assert.equal(accepted.versions.reservation, 1);
assert.deepEqual(accepted.ownerIndex, [{ ownerId: "site:1", reservationIds: ["plot:1"] }]);
assert.deepEqual(createPlanningWorld(JSON.parse(JSON.stringify(accepted))), accepted, "JSON roundtrip retains all authority semantics");
reject(accepted, patch(initial, []), /stale-world-patch/);
reject(accepted, patch(accepted, [{ type: "transition", id: "plot:1", to: "tentative" }]), /invalid-reservation-transition/);
reject(accepted, patch(accepted, [{ type: "transition", id: "plot:1", to: "released", reason: "move" }]), /missing-replacement-authorization/);
const auth = { id: "replace:1", reservationId: "plot:1", replacementId: "plot:2", reason: "shared-policy joint relocation",
  dependencyReservationIds: ["plot:1"] };
const release = { type: "transition", id: "plot:1", to: "released", reason: "joint relocation", replacementId: "plot:2", authorization: auth };
reject(accepted, patch(accepted, [release]), /required-reservation-not-replaced/);
reject(accepted, patch(accepted, [{ ...release, reason: "" }]), /missing-release-reason/);
const nextVersions = { ...accepted.versions, reservation: 2, site: 1 };
const operations = [release, { type: "reserve", reservation: reservation("plot:2") },
  { type: "transition", id: "plot:2", to: "accepted", physical: physical(nextVersions) }];
reject(accepted, patch(accepted, operations.map(op => op === release ? { ...op, authorization: { ...auth, dependencyReservationIds: [] } } : op),
  { changedDomains: ["site"] }), /incomplete-replacement-dependency-closure/);
const replaced = accept(applyWorldPatch(accepted, patch(accepted, operations, { changedDomains: ["site"], charge: { candidates: 1 } })));
assert.equal(replaced.reservations.find(r => r.id === "plot:1").state, "released");
assert.equal(replaced.reservations.find(r => r.id === "plot:2").state, "accepted");
assert.deepEqual(replaced.demands, initial.demands, "unmet or fulfilled required demand identity never disappears");
assert.deepEqual(accept(applyWorldPatch(accepted, patch(accepted, [...operations].reverse(), { changedDomains: ["site"], charge: { candidates: 1 } }))), replaced,
  "independent reserve/release order yields the same sorted serializable authority");
assert.throws(() => createPlanningWorld({ versions, demands: [demand], reservations: [{ ...reservation(), state: "released", release: { reason: "discard", authorizationId: "explicit:fixture" } }] }), /required-reservation-not-replaced/);
const frozenVersions = { ...replaced.versions, reservation: 3 };
const frozen = accept(applyWorldPatch(replaced, patch(replaced, [{ type: "transition", id: "plot:2", to: "frozen", physical: physical(frozenVersions) }])));
const frozenAuth = { ...auth, reservationId: "plot:2", replacementId: "plot:3", dependencyReservationIds: ["plot:2"] };
reject(frozen, patch(frozen, [{ type: "transition", id: "plot:2", to: "released", reason: "replace published address", replacementId: "plot:3", authorization: frozenAuth }]), /missing-published-mapping/);
const publishedVersions = { ...frozen.versions, reservation: 4, site: 2 };
const publishedReplacement = accept(applyWorldPatch(frozen, patch(frozen, [
  { type: "transition", id: "plot:2", to: "released", reason: "mapped address relocation", replacementId: "plot:3",
    authorization: { ...frozenAuth, publishedMappingEvidence: { id: "reviewed-address-mapping", dependencies: ["site", "reservation"], versions: frozen.versions } } },
  { type: "reserve", reservation: reservation("plot:3") },
  { type: "transition", id: "plot:3", to: "accepted", physical: physical(publishedVersions) },
], { changedDomains: ["site"] })));
assert.deepEqual(publishedReplacement.demands, frozen.demands);
assert.equal(publishedReplacement.reservations.find(r => r.id === "plot:3").state, "accepted");
reject(frozen, patch(frozen, [], { changedDomains: ["model"] }), /stale-evidence.*model/);
const refreshedVersions = { ...frozen.versions, model: 1, reservation: 4 };
const refreshed = accept(applyWorldPatch(frozen, patch(frozen, [{ type: "revalidate", id: "plot:2", physical: physical(refreshedVersions) }], { changedDomains: ["model"] })));
assert.equal(refreshed.reservations.find(r => r.id === "plot:2").state, "frozen");
assert.equal(worldEvidenceFailure(physical(frozen.versions).evidence, refreshed.versions).startsWith("stale-evidence:"), true);
assert.equal(worldEvidenceFailure({ id: "topology-only", dependencies: ["network"], versions: frozen.versions }, refreshed.versions), undefined,
  "evidence checks declared dependencies, not unrelated domains");
reject(refreshed, patch(refreshed, [], { charge: { candidates: 2 } }), /budget-exhausted/);
reject(refreshed, patch(refreshed, [], { charge: { candidates: -1 } }), /invalid-budget-charge/);
reject(refreshed, patch(refreshed, [], { charge: { unknown: 1 } }), /invalid-budget-charge/);
reject(refreshed, patch(refreshed, [{ type: "register-demand", demand: { ...demand, required: false } }]), /demand-identity-conflict/);
const fixed = createPlanningWorld({ versions, demands: [demand], reservations: [{ ...reservation(), immutable: true }] });
reject(fixed, patch(fixed, [{ type: "transition", id: "plot:1", to: "released", reason: "move" }]), /immutable-reservation/);
const incompletePhysical = physical(acceptedVersions);
incompletePhysical.evidence.dependencies = ["network", "site", "terrain", "policy", "model"];
reject(initial, patch(initial, [{ type: "transition", id: "plot:1", to: "accepted", physical: incompletePhysical }]), /physical-evidence-missing-dependency:reservation/);
const incompletePatch = patch(initial, [
  { type: "reserve", reservation: reservation("draft-only") },
  { type: "transition", id: "unknown", to: "accepted" },
]);
reject(initial, incompletePatch, /unknown-reservation/);
const cyclicA = { ...reservation("cycle:a"), state: "released", release: { reason: "replace", replacementId: "cycle:b", authorizationId: "explicit:a" } };
const cyclicB = { ...reservation("cycle:b"), state: "released", release: { reason: "replace", replacementId: "cycle:a", authorizationId: "explicit:b" } };
assert.throws(() => createPlanningWorld({ versions, demands: [demand], reservations: [cyclicA, cyclicB] }), /cyclic-required-replacement/);
for (const malformed of [
  { ...reservation(), envelope: { type: "polygon", points: [{ x: 0, z: 0 }, { x: 1, z: 1 }, { x: 2, z: 2 }] } },
  { ...reservation(), envelope: { type: "corridor", width: 0, points: [{ x: 0, z: 0 }, { x: 1, z: 1 }] } },
  { ...reservation(), envelope: { type: "polygon", points: [{ x: Infinity, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 1 }] } },
  { ...reservation(), elevation: { min: 3, max: 1 } },
  { ...reservation(), demandIds: ["forgotten-required-demand"] },
  { ...reservation(), ownerId: "unrelated-owner" },
]) assert.throws(() => createPlanningWorld({ versions, demands: [demand], reservations: [malformed] }));
for (const domain of WORLD_VERSION_DOMAINS) {
  const stale = { ...accepted.versions, [domain]: accepted.versions[domain] + 1 };
  reject(accepted, { expectedVersions: stale, operations: [] }, /stale-world-patch/);
}
const p = (x, z) => ({ x, z });
const context = () => ({
  network: emptyNetwork(), publicSites: [], landmarks: [], blocks: [], core: p(0, 0),
  geo: { height: () => 1.2, buildable: () => true, terrain: { height: () => 1.2, slope: () => 0 }, river: null },
  height: () => 1.2, inRiver: () => false, coast: [], seaside: null, coastRoadRuns: [], riverRoadRuns: [],
  coastRoadRunEnds: [], carPaths: [], bridges: [], connectionLog: [], SHORE_SITE_KINDS: new Set(), ringRuns: [], trunkRuns: [],
});
const contextBytes = ctx => JSON.stringify({ ...ctx, network: { ...ctx.network, nodes: [...ctx.network.nodes], edges: [...ctx.network.edges] } });
const twoDistricts = () => {
  const ctx = context(); ctx.primaryAnchorNodeId = "0:0";
  for (const x of [0, 80]) {
    const corners = [p(x, 0), p(x + 40, 0), p(x + 40, 40), p(x, 40)];
    for (let i = 0; i < corners.length; i += 1) addNetworkEdge(ctx.network, corners[i], corners[(i + 1) % corners.length], false);
  }
  return ctx;
};
const joinDistricts = { name: "world-merge", constraint: "disconnectedComponents", run: draft => {
  addNetworkEdge(draft.network, p(40, 0), p(80, 0), false); return 1;
} };
{
  const ctx = twoDistricts(), base = initializeRepairPlanningWorld(ctx), before = contextBytes(ctx);
  const declined = runRepairTransaction(ctx, { name: "discard-child-world", constraint: "disconnectedComponents", run: draft => {
    assert.ok(runRepairTransaction(draft, joinDistricts).changes > 0); return 0;
  } });
  assert.equal(declined.changes, 0); assert.equal(contextBytes(ctx), before); assert.equal(ctx.planningWorld, base);
  const merged = runRepairTransaction(ctx, { name: "publish-child-world", constraint: "disconnectedComponents", run: draft => runRepairTransaction(draft, joinDistricts) });
  assert.ok(merged.changes > 0, JSON.stringify(merged));
  assert.equal(ctx.planningWorld.versions.network, 1);
  assert.equal(ctx.network.version, ctx.planningWorld.versions.network);
  assert.equal(ctx.planningWorld.versions.site, 0, "network-only repair cannot bump site revision");
  assert.equal(ctx.planningWorld.versions.reservation, 1);
  assert.ok(base.demands.every(d => ctx.planningWorld.demands.some(next => next.id === d.id)));
  assert.ok(ctx.planningWorld.reservations.every(r => r.state === "tentative" && r.physical.status === "pending"));
  assert.deepEqual(ctx.planningWorld.sourceStatus, { network: "observed", site: "observed", reservation: "observed", terrain: "pending", policy: "pending", model: "pending" });
  const outcome = repairPlanningOutcome(ctx);
  assert.equal(outcome.status, "degraded"); assert.deepEqual(outcome.unmetDemandIds, []);
  assert.ok(!outcome.reasons.some(reason => reason.includes("stale")));
  for (const mutate of [draft => { draft.planningWorld = {}; }, draft => { delete draft.planningWorld; },
    draft => { Object.defineProperty(draft, "planningWorld", { value: {} }); }]) {
    const saved = contextBytes(ctx), authority = ctx.planningWorld;
    const rejected = runRepairTransaction(ctx, { name: "tamper-world", constraint: "disconnectedComponents", run: draft => { mutate(draft); return 1; } });
    assert.equal(rejected.changes, 0); assert.match(rejected.reason, /protected planning world/);
    assert.equal(contextBytes(ctx), saved); assert.equal(ctx.planningWorld, authority);
  }
  const staged = runRepairDerivedFinalization(ctx, draft => {
    draft.blocks.push({ id: "new-block", districtId: "district", x: 400, z: 400, width: 40, depth: 40, zone: "residential",
      polygon: [p(380, 380), p(420, 380), p(420, 420), p(380, 420)],
      parcels: [{ id: "parcel:new", blockId: "new-block", x: 400, z: 400, yaw: 0, width: 12, depth: 12, zone: "residential" }] });
    draft.carPaths.push([p(40, 0), p(80, 0)]);
    draft.landmarks.push({ id: "derived-model", kind: "suspension-bridge", x: 40, z: 0, to: p(80, 0), radius: 0, yaw: 0 });
  });
  assert.equal(staged.ok, true, staged.reason);
  assert.equal(staged.outcome.status, "degraded"); assert.ok(!staged.outcome.reasons.some(reason => reason.includes("stale")));
  assert.equal(ctx.planningWorld.versions.network, 1);
  assert.equal(ctx.planningWorld.versions.site, 1);
  assert.equal(ctx.planningWorld.versions.reservation, 2);
  assert.ok(ctx.planningWorld.reservations.some(r => r.id === "parcel:parcel:new" && r.state === "tentative"));
  assert.ok(ctx.planningWorld.reservations.some(r => r.id === "site:derived-model" && r.envelope.type === "unregistered" && r.physical.status === "pending"),
    "zero-radius decoration stays in physical coverage, not silently omitted");
  for (const invalidDerive of [
    draft => { addNetworkEdge(draft.network, p(40, 0), p(400, 400), false); },
    draft => { draft.carPaths.push([p(40, 0), p(400, 400)]); },
    draft => { draft.blocks[0].parcels[0].width = NaN; },
    draft => { draft.height = () => 99; },
    draft => { throw new Error("cancelled derived producer"); },
  ]) {
    const saved = contextBytes(ctx), authority = ctx.planningWorld;
    const rejected = runRepairDerivedFinalization(ctx, invalidDerive);
    assert.equal(rejected.ok, false); assert.ok(rejected.reason);
    assert.equal(rejected.outcome.status, "failed");
    assert.ok(rejected.outcome.reasons.some(reason => reason.includes("derived finalization rejected")));
    assert.equal(contextBytes(ctx), saved); assert.equal(ctx.planningWorld, authority);
  }
}
{
  const ctx = context(), height = (_x, z) => z < -12 ? -1 : 1.2;
  ctx.height = height; ctx.geo.height = height; ctx.geo.terrain.height = height;
  ctx.geo.coastDistance = (_x, z) => Math.abs(z + 12);
  ctx.coast = [p(-150, -12), p(150, -12)]; ctx.primaryAnchorNodeId = "-100:20";
  ctx.SHORE_SITE_KINDS.add("ferris-wheel"); addNetworkEdge(ctx.network, p(-100, 20), p(100, 20), false);
  ctx.landmarks.push({ id: "wet-owner", kind: "ferris-wheel", x: 0, z: -10, radius: 11, yaw: 0 });
  const base = initializeRepairPlanningWorld(ctx), candidate = REPAIR_STRATEGIES.find(s => s.name === "resiteWetShoreSites").candidates(ctx)[0];
  assert.ok(candidate);
  const result = runRepairTransaction(ctx, candidate); assert.ok(result.changes > 0, JSON.stringify(result));
  assert.equal(ctx.planningWorld.versions.network, base.versions.network, "site-only relocation preserves actual network revision");
  assert.equal(ctx.planningWorld.versions.site, 1); assert.equal(ctx.planningWorld.versions.reservation, 1);
  const owner = ctx.planningWorld.reservations.find(r => r.id === "site:wet-owner");
  assert.deepEqual(owner.envelope.centre, p(ctx.landmarks[0].x, ctx.landmarks[0].z));
  assert.equal(owner.physical.status, "pending"); assert.equal(owner.state, "tentative");
  assert.equal(repairPlanningOutcome(ctx).status, "degraded");
}
for (const staleChange of [ctx => { ctx.network.version = 9; }, ctx => { addNetworkEdge(ctx.network, p(0, 0), p(80, 0), false); },
  ctx => { ctx.geo.terrain.height = () => 9; }]) {
  const ctx = twoDistricts(); initializeRepairPlanningWorld(ctx); staleChange(ctx);
  let ran = false;
  const result = runRepairTransaction(ctx, { ...joinDistricts, run: draft => { ran = true; return joinDistricts.run(draft); } });
  assert.equal(result.changes, 0); assert.match(result.reason, /stale repair world/); assert.equal(ran, false);
  assert.equal(repairPlanningOutcome(ctx).status, "failed");
}
// Production, not just an adapter fixture: final parcel/traffic generation must
// publish the same observed world revision while still reporting pending physics.
for (const skipSolve of [false, true]) {
  const plan = createCityPlan(2005864824, 1, MIAMI_COASTAL, { skipSolve });
  assert.equal(plan.derivedFinalization.ok, true, plan.derivedFinalization.reason);
  assert.ok(plan.planningOutcome.status === "degraded" || plan.planningOutcome.status === "failed");
  assert.ok(!plan.planningOutcome.reasons.some(reason => reason.includes("stale")), "final production world may not be an obsolete pre-parcel snapshot");
  assert.equal(plan.planningOutcome.versions.network, plan.derivedNetworkVersion);
  assert.ok(plan.planningOutcome.pendingPhysicalReservations >= plan.roadEdges.length + plan.publicSites.length + plan.landmarks.length);
  assert.equal(plan.planningOutcome.requiredDemands, diagnoseNetwork(plan).demands.filter(entry => entry.demand.required).length);
  assert.deepEqual(plan.planningOutcome.unmetDemandIds, diagnoseNetwork(plan).unmet.map(entry => entry.demandId));
  if (!skipSolve) assert.equal(plan.planningOutcome.status, "degraded", "known served plan stays honestly pending, not unsafe success");
}
console.log("City world: immutable JSON authority, six-domain versions, prior demand/binding preservation, explicit atomic replacements, stale-proof rejection, cumulative contract budgets, production repair publication and derived parcel/traffic finalization. Physical/model/whole-plan budget coverage remains explicitly pending; no unsafe success.");
