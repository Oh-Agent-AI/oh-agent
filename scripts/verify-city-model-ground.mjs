#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { inspectModelGround, MODEL_GROUND_CONFIG, GROUND_MODEL_FACTORIES, resolveGroundModel, declarePhysical,
  buildGeography, hashSeed, resolveVillaGroundPhysical, wetCount, settleShoreSitesOnCoast, emptyNetwork, addNetworkEdge,
  REPAIR_STRATEGIES, runRepairTransaction, initializeRepairPlanningWorld, repairPlanningOutcome, CONSTRAINTS } = await loadCity({
  "engine/planner/modelGround.ts": ["inspectModelGround", "MODEL_GROUND_CONFIG"],
  "engine/models/groundRegistry.ts": ["GROUND_MODEL_FACTORIES", "resolveGroundModel"],
  "engine/models/physical.ts": ["declarePhysical"],
  "engine/planner/geography.ts": ["buildGeography"],
  "cityModel.ts": ["hashSeed"],
  "engine/models/villaGeometry.ts": ["resolveVillaGroundPhysical"],
  "engine/planner/footprint.ts": ["wetCount"],
  "engine/planner/siting.ts": ["settleShoreSitesOnCoast"],
  "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge"],
  "engine/planner/solve.ts": ["REPAIR_STRATEGIES", "runRepairTransaction", "initializeRepairPlanningWorld", "repairPlanningOutcome"],
  "engine/planner/constraints.ts": ["CONSTRAINTS"],
});
const owner = { id: "landmark:villa-complex", kind: "villa-complex", x: 3, z: -9, yaw: 0.7, radius: 34 };
const flat = { height: () => 1.2, inRiver: () => false };
const before = JSON.stringify(owner), result = inspectModelGround(owner, flat);
assert.equal(result.status, "partial"); assert.equal(result.wholeModelReady, false);
assert.equal(result.evidence.supportSamples, 1441); assert.equal(result.evidence.heightQueries, 1442);
assert.equal(result.evidence.baseY, 1.2); assert.equal(result.evidence.supportY, 1.2);
assert.deepEqual(result.findings, []); assert.equal(result.evidence.coverage, "bounded-samples-only");
assert.ok(result.missing.includes("continuous terrain support proof"));
assert.equal(JSON.stringify(owner), before);
assert.deepEqual(inspectModelGround(owner, flat), result);
assert.equal(result.evidence.seed, hashSeed(owner.id), "model dimensions use the same instance id hash as the renderer");
assert.equal(resolveGroundModel("villa-complex", { seed: hashSeed(owner.id), radius: 34 }).status, "partial");
GROUND_MODEL_FACTORIES["renamed-villa"] = GROUND_MODEL_FACTORIES["villa-complex"];
try { assert.deepEqual(inspectModelGround({ ...owner, kind: "renamed-villa" }, flat), result,
  "registration alias with identical parameters cannot alter generic ground decisions"); }
finally { delete GROUND_MODEL_FACTORIES["renamed-villa"]; }

for (const instance of [{ ...owner, kind: "unknown-model" }, { ...owner, kind: "suspension-bridge", radius: 0 },
  { ...owner, kind: "constructor" }, { ...owner, radius: 11 }]) {
  let queries = 0;
  const denied = inspectModelGround(instance, { height: () => { queries += 1; return 1.2; }, inRiver: () => false });
  assert.equal(denied.status, "unsupported"); assert.equal(denied.wholeModelReady, false); assert.equal(queries, 0);
}
for (const budget of [0, 1, 10, 1441, 4097, NaN]) {
  let queries = 0;
  const denied = inspectModelGround(owner, { height: () => { queries += 1; return 1.2; }, inRiver: () => false }, { maxHeightQueries: budget });
  assert.equal(denied.status, "unsupported"); assert.equal(denied.reasonCode, "budget-exhausted"); assert.equal(queries, 0,
    "insufficient declared sampling coverage cannot publish a misleading partial-safe result");
}
for (const malformed of [{ ...owner, yaw: NaN }, { ...owner, x: Infinity }]) assert.equal(inspectModelGround(malformed, flat).status, "unsupported");
for (const badGeo of [{ height: () => NaN, inRiver: () => false }, { height: () => 1.2, inRiver: () => "no" },
  { height: () => { throw new Error("source expired"); }, inRiver: () => false }]) {
  const denied = inspectModelGround(owner, badGeo);
  assert.equal(denied.status, "unsupported"); assert.equal(denied.reasonCode, "invalid-context");
}
for (const [kind, geo] of [
  ["water", { height: () => -2, inRiver: () => false }],
  ["river", { height: () => 1.2, inRiver: () => true }],
  ["gap", { height: (x, z) => x === owner.x && z === owner.z ? 1.2 : 0.7, inRiver: () => false }],
  ["embed", { height: (x, z) => x === owner.x && z === owner.z ? 1.2 : 2.2, inRiver: () => false }],
  ["relief", { height: x => x < owner.x ? 0.7 : 2.2, inRiver: () => false }],
]) {
  const inspected = inspectModelGround(owner, geo);
  assert.equal(inspected.status, "violation", kind); assert.equal(inspected.wholeModelReady, false);
  const code = kind === "river" ? "foundation-water" : `foundation-${kind}`;
  assert.ok(inspected.findings.some(finding => finding.code === code), JSON.stringify(inspected.findings));
  assert.ok(inspected.evidence.heightQueries <= MODEL_GROUND_CONFIG.maxHeightQueries);
}

// Generic region handling and rotation: this factory has no building-name branch in the inspector.
const parts = [
  { shape: "rect", center: { x: 0, z: 0 }, width: 2, depth: 2 },
  { shape: "circle", center: { x: 4, z: 0 }, radius: 1 },
  { shape: "convex", vertices: [{ x: 7, z: 0 }, { x: 9, z: 0 }, { x: 8, z: 2 }] },
];
const declaration = declarePhysical({ modelId: "synthetic-ground", modelRevision: "test-1", footprint: { parts },
  foundation: { kind: "ground", support: { parts }, maxRelief: 1, maxGap: 0.2, maxEmbed: 0.6, baseOffset: 0 }, entrances: [] });
GROUND_MODEL_FACTORIES["synthetic-ground"] = () => ({ status: "partial", declaration, missing: ["entrance-and-approach"] });
try {
  for (const yaw of [0, Math.PI / 2, -Math.PI / 2, 0.73]) {
    const seen = [], instance = { id: "synthetic-owner", kind: "synthetic-ground", x: 11, z: -13, yaw, radius: 1 };
    const inspected = inspectModelGround(instance, { height: (x, z) => { seen.push({ x, z }); return 1.2; }, inRiver: () => false });
    assert.equal(inspected.status, "partial"); assert.equal(inspected.wholeModelReady, false);
    for (const point of seen.slice(1)) {
      const dx = point.x - instance.x, dz = point.z - instance.z;
      const local = { x: dx * Math.cos(yaw) - dz * Math.sin(yaw), z: dx * Math.sin(yaw) + dz * Math.cos(yaw) };
      assert.ok((Math.abs(local.x) <= 1 + 1e-8 && Math.abs(local.z) <= 1 + 1e-8)
        || Math.hypot(local.x - 4, local.z) <= 1 + 1e-8
        || (local.x >= 7 - 1e-8 && local.x <= 9 + 1e-8 && local.z >= -1e-8 && local.z <= 2 + 1e-8),
      "world samples use renderer's rotationY convention, not its inverse");
    }
  }
} finally { delete GROUND_MODEL_FACTORIES["synthetic-ground"]; }

// Frozen real failing pose, independent of whether the current planner has since moved it.
const seed = 1703310796, R = 579.2644041008882, random = key => hashSeed(`${seed}:${key}`);
const shape = {
  stretch: 0.78 + random("stretch") * 0.5, spin: random("spin") * Math.PI * 2,
  harmonics: [2, 3, 5].map(k => ({ k, a: 0.05 + random(`h${k}`) * (k === 2 ? 0.16 : 0.1), p: random(`hp${k}`) * Math.PI * 2 })),
  bays: Array.from({ length: 1 + Math.floor(random("bays") * 3) }, (_, i) => ({ at: random(`bay${i}`) * Math.PI * 2,
    depth: 0.14 + random(`bayd${i}`) * 0.18, width: 0.18 + random(`bayw${i}`) * 0.25 })),
};
const geography = buildGeography(seed, R, shape);
const failingOwner = { ...owner, x: 356.6787732260374, z: -295.7379451603026, yaw: 2.420430145796707 };
const actual = inspectModelGround(failingOwner, { height: geography.height, inRiver: (x, z) => geography.hasRiver && Math.abs(x - geography.riverX(z)) < geography.riverWidth(z) });
assert.equal(actual.status, "violation"); assert.ok(actual.findings.some(finding => finding.code === "foundation-water"));
assert.ok(actual.findings.some(finding => finding.code === "foundation-gap" && finding.observed > 6));
assert.equal(actual.evidence.belowRendererSeaLevel, 479, "actual deck478 + second step1 samples lie below real sea level, using shared support dimensions");
assert.equal(actual.evidence.belowPlanningDryLevel, 541);
assert.equal(actual.evidence.supportSamples, 1441); assert.equal(actual.evidence.heightQueries, 1442);
assert.equal(actual.evidence.modelRevision, resolveVillaGroundPhysical({ seed: hashSeed(owner.id), radius: 34 }).declaration.modelRevision);
assert.equal(JSON.stringify(owner), before, "all accepted/refused inspections preserve owner data");

// A circle-dry location can contain a submerged actual support patch. This
// must trigger registered admission independently of the legacy wetCount.
const narrowWater = (x, z) => x > 28 && x < 31 && Math.abs(z) < 2 ? -2 : 1.2;
const circleDryOwner = { ...owner, x: 0, z: 0, yaw: 0 };
const hiddenGeo = { height: narrowWater, inRiver: () => false };
assert.equal(wetCount(hiddenGeo, circleDryOwner, 34), 0);
assert.equal(inspectModelGround(circleDryOwner, hiddenGeo).status, "violation");
const shoreCtx = { publicSites: [], landmarks: [{ ...circleDryOwner }], core: { x: 0, z: 0 }, coast: [{ x: 0, z: -100 }],
  coastDistance: () => 0, ...hiddenGeo, riverBank: () => false, trunkRuns: [], bridges: [], ringRuns: [] };
settleShoreSitesOnCoast(shoreCtx);
assert.equal(inspectModelGround(shoreCtx.landmarks[0], hiddenGeo).status, "partial", "initial shore admission cannot retain an apparent circle-dry false success");
assert.ok(Math.hypot(shoreCtx.landmarks[0].x, shoreCtx.landmarks[0].z) <= 70, "initial ground repair reuses the original local tier");
const blockedShore = { ...shoreCtx, landmarks: [{ ...circleDryOwner, radius: 11 }] };
const blockedBytes = JSON.stringify(blockedShore.landmarks);
settleShoreSitesOnCoast(blockedShore);
assert.equal(JSON.stringify(blockedShore.landmarks), blockedBytes, "registered unsupported radius cannot be moved as though its physical gate passed");

const ctx = { network: emptyNetwork(), publicSites: [], landmarks: [{ ...circleDryOwner },
  { id: "unknown-decoration", kind: "unknown-zero-model", x: 0, z: 0, yaw: 0, radius: 0 }], blocks: [], core: { x: 0, z: 0 },
  geo: { ...hiddenGeo, buildable: () => true, coastDistance: () => 1000, terrain: { ...hiddenGeo, slope: () => 0 }, river: null },
  ...hiddenGeo, coast: [], seaside: null, coastRoadRuns: [], riverRoadRuns: [], coastRoadRunEnds: [], carPaths: [], bridges: [], connectionLog: [],
  SHORE_SITE_KINDS: new Set(["villa-complex"]), ringRuns: [], trunkRuns: [], primaryAnchorNodeId: "-100:50" };
const corners = [{ x: -100, z: 50 }, { x: 100, z: 50 }, { x: 100, z: 100 }, { x: -100, z: 100 }];
for (let i = 0; i < corners.length; i += 1) addNetworkEdge(ctx.network, corners[i], corners[(i + 1) % corners.length], false);
const planView = { roadNodes: [...ctx.network.nodes.values()], roadEdges: [...ctx.network.edges.values()], publicSites: ctx.publicSites,
  landmarks: ctx.landmarks, blocks: [], core: ctx.core, terrain: ctx.geo.terrain, coast: [], river: null, seaside: null,
  primaryAnchorNodeId: ctx.primaryAnchorNodeId, coastRoads: [], riverRoadRuns: [] };
assert.ok(CONSTRAINTS.every(constraint => constraint.measure(planView).length === 0), "fixture has no legacy circle constraint failures");
initializeRepairPlanningWorld(ctx);
const checkCoverage = outcome => {
  assert.equal(outcome.groundCoverage.total, ctx.publicSites.length + ctx.landmarks.length);
  assert.equal(outcome.groundCoverage.partial + outcome.groundCoverage.violations + outcome.groundCoverage.unsupported, outcome.groundCoverage.total);
  assert.ok(outcome.groundCoverage.unsupported >= 1, "unknown zero-radius decoration remains in the coverage denominator");
};
const failedOutcome = repairPlanningOutcome(ctx);
checkCoverage(failedOutcome); assert.equal(failedOutcome.status, "failed");
assert.ok(failedOutcome.groundFailures.some(failure => failure.ownerId === circleDryOwner.id && failure.reason.includes("foundation-water")));
const strategy = REPAIR_STRATEGIES.find(entry => entry.name === "resiteWetShoreSites");
const candidates = strategy.candidates(ctx);
assert.ok(candidates.length, "true support failure must enter wet-shore repair even with wetCount0");
const roads = JSON.stringify([...ctx.network.edges]);
const repaired = runRepairTransaction(ctx, candidates[0]);
assert.ok(repaired.changes > 0, JSON.stringify(repaired));
assert.equal(JSON.stringify([...ctx.network.edges]), roads, "ground-only repair does not fabricate or discard road service");
const partialOutcome = repairPlanningOutcome(ctx);
checkCoverage(partialOutcome); assert.equal(partialOutcome.status, "degraded");
assert.deepEqual(partialOutcome.groundFailures, []); assert.equal(partialOutcome.groundCoverage.partial, 1);
assert.equal(ctx.planningWorld.versions.network, 0); assert.equal(ctx.planningWorld.versions.site, 1);
console.log("City model ground: pure registry, renderer-id seed/base/rotation, rect/circle/convex bounded supports, explicit water/gap/embed/relief failures, zero-radius unknown coverage, malformed source and exhausted-budget refusal, alias invariance and frozen real 479 submerged-support witnesses pass. Bounded ground samples remain partial, never full model physical readiness.");
