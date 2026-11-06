#!/usr/bin/env node
// Read-only, reproducible tracing of synthetic City planning. No user logs or
// authority files are read/written; source instrumentation exists only in the diagnostic bundle.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { repo, citySrc } from "./city-kit/index.mjs";
const { build } = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"))("esbuild");
const seed = Number(process.argv[2] ?? 2003037141), tier = Number(process.argv[3] ?? 1);
if (!Number.isSafeInteger(seed) || ![1, 2, 5, 10].includes(tier)) throw new Error("usage: diagnose-city-ground-stages.mjs seed tier");
const sources = new Map(), stageRows = [], beforeSolve = [], shoreInputs = [];
globalThis.__groundDiagnostic = {
  stage(label, attemptRadius, models, height, inRiver, inspector, wet) {
    const owner = models.find(site => site.kind === "villa-complex");
    if (!owner) return;
    const inspection = inspector(owner, { height, inRiver });
    stageRows.push({ label, radius: attemptRadius, owner: { ...owner }, wetCircle: wet({ height, inRiver }, owner, owner.radius),
      ground: inspection.status, findings: inspection.status === "violation" ? inspection.findings.map(finding => finding.code) : [],
      belowSea: inspection.evidence?.belowRendererSeaLevel, maxGap: inspection.evidence?.maxGap });
  },
  beforeSolve(ctx, radius) {
    beforeSolve.push({ radius, ctx: { ...ctx, network: { ...ctx.network,
      nodes: new Map([...ctx.network.nodes].map(([id, node]) => [id, { ...node }])),
      edges: new Map([...ctx.network.edges].map(([id, edge]) => [id, { ...edge, points: edge.points.map(point => ({ ...point })) }])) },
      publicSites: structuredClone(ctx.publicSites), landmarks: structuredClone(ctx.landmarks), blocks: structuredClone(ctx.blocks) } });
  },
  shoreInput(ctx, radius) { shoreInputs.push({ radius, ctx: { ...ctx,
    publicSites: structuredClone(ctx.publicSites), landmarks: structuredClone(ctx.landmarks), diagnosticRoads: structuredClone(ctx.diagnosticRoads) } }); },
};
const cityPlanFile = path.join(citySrc, "engine/cityPlan.ts");
const instrument = raw => {
  let text = 'import { inspectModelGround as __diagnoseGround } from "./planner/modelGround";\nimport { wetCount as __diagnoseWet } from "./planner/footprint";\n' + raw;
  const trace = label => `globalThis.__groundDiagnostic.stage(${JSON.stringify(label)}, R, landmarks, height, inRiver, __diagnoseGround, __diagnoseWet);`;
  const markers = [
    ["restickSitesClearOfRingRuns(frontageCtx);", "restick"],
    ["retreatShoreSitesToDryLand(shoreCtx);", "retreat"],
    ["frontSitesOnTrunks(frontageCtx);", "frontage"],
    ["resnapSitesOntoDryLand(frontageCtx);", "dry-resnap"],
    ["settleHarborOnCoast(shoreCtx);", "harbor"],
    ["settleShoreSitesOnCoast(shoreCtx);", "shore-settle"],
    ["let sailOperaCandidateSets = settleSailOperaOffshore(shoreCtx);", "offshore"],
  ];
  for (const [marker, label] of markers) {
    if (!text.includes(marker)) throw new Error(`source tracing marker missing: ${label}`);
    text = text.replace(marker, `${trace(label + "-before")}\n${label === "shore-settle" ? "globalThis.__groundDiagnostic.shoreInput({ ...shoreCtx, diagnosticRoads: [...network.edges.values()] }, R);" : ""}\n${marker}\n${trace(label + "-after")}`);
  }
  const solveMarker = "const solveReport = skipSolve ? null : solvePlan(repairCtx);";
  if (!text.includes(solveMarker)) throw new Error("source tracing marker missing: solve");
  return text.replace(solveMarker, `${trace("solve-before")}\nglobalThis.__groundDiagnostic.beforeSolve(repairCtx, R);\n${solveMarker}\n${trace("solve-after")}`);
};
const output = await build({ stdin: { contents: [
  `export {createCityPlan, clearsHighways} from ${JSON.stringify(cityPlanFile)};`,
  `export {MIAMI_COASTAL} from ${JSON.stringify(path.join(citySrc, "engine/citySeaside.ts"))};`,
  `export {localResiteCandidates} from ${JSON.stringify(path.join(citySrc, "engine/planner/siting.ts"))};`,
  `export {relocatedSitePositionFailure} from ${JSON.stringify(path.join(citySrc, "engine/planner/snapJunctions.ts"))};`,
  `export {inspectModelGround, registeredModelGroundFailure} from ${JSON.stringify(path.join(citySrc, "engine/planner/modelGround.ts"))};`,
  `export {inspectEnvelopeRoad, inspectEnvelopePair} from ${JSON.stringify(path.join(citySrc, "engine/planner/modelEnvelope.ts"))};`,
  `export {prepareJointSiteRoadRelocation} from ${JSON.stringify(path.join(citySrc, "engine/planner/jointSiteRoad.ts"))};`,
  `export {closestPolylineSegment} from ${JSON.stringify(path.join(citySrc, "engine/planner/footprint.ts"))};`,
  `export {DetMath} from ${JSON.stringify(path.join(citySrc, "engine/detMath.ts"))};`,
  `export {polylineDistance, nearBridgeEnd, wetCount} from ${JSON.stringify(path.join(citySrc, "engine/planner/footprint.ts"))};`,
  `export {componentOf, primaryComponentId} from ${JSON.stringify(path.join(citySrc, "engine/planner/intent.ts"))};`,
].join("\n"), resolveDir: citySrc }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
  plugins: [{ name: "read-only-ground-trace", setup(builder) {
    builder.onLoad({ filter: /\.tsx?$/ }, args => {
      const raw = fs.readFileSync(args.path, "utf8"); sources.set(args.path, raw);
      return { contents: args.path === cityPlanFile ? instrument(raw) : raw, loader: args.path.endsWith("tsx") ? "tsx" : "ts" };
    });
  } }] });
const module = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const began = performance.now(), plan = module.createCityPlan(seed, tier, module.MIAMI_COASTAL);
const sourceDigest = crypto.createHash("sha256");
for (const [file, raw] of [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) sourceDigest.update(path.relative(citySrc, file)).update("\0").update(raw);
console.log(JSON.stringify({ seed, tier, loadedSourceDigest: sourceDigest.digest("hex"), ms: Math.round(performance.now() - began),
  radius: plan.islandRadius, capacity: plan.capacity, outcome: plan.planningOutcome, stages: stageRows }));

const tally = (rows, counter, reason, at) => { counter[reason] = (counter[reason] ?? 0) + 1; if (!rows[reason]) rows[reason] = { ...at }; };
for (const { radius, ctx } of shoreInputs.filter(row => row.radius === plan.islandRadius)) {
  const owner = ctx.landmarks.find(site => site.kind === "villa-complex"); if (!owner) continue;
    const others = [...ctx.publicSites, ...ctx.landmarks].filter(site => site.id !== owner.id && site.radius), counts = {}, examples = {}, groundAdmissibleRejectedBy = {}, groundAdmissibleExamples = {};
  const initialEntityCounts = {}, initialEntityExamples = {}, initialEntityCandidates = [], initialRoadOnlyCandidates = [];
  let attempts = 0;
  for (let rr = 6; rr <= 70; rr += 6) for (let k = 0; k < 24; k += 1) {
    attempts += 1; const angle = k * Math.PI * 2 / 24, at = { x: owner.x + Math.cos(angle) * rr, z: owner.z + Math.sin(angle) * rr };
    let reason;
    if (module.wetCount({ height: ctx.height, inRiver: ctx.inRiver, riverBank: ctx.riverBank }, at, owner.radius, { river: true, riverBank: 14 }) > 2) reason = "legacy-wet-circle";
    else if (ctx.height(at.x, at.z) <= 0.5) reason = "centre-water";
    else if (module.polylineDistance(ctx.trunkRuns, at) < owner.radius + 4) reason = "legacy-circle-trunk-setback";
    else if (!module.clearsHighways(at, owner.radius * 2, owner.radius * 2, ctx.ringRuns)) reason = "legacy-square-highway-envelope";
    else if (others.some(other => Math.hypot(other.x - at.x, other.z - at.z) < owner.radius + other.radius)) reason = "owner-spacing";
    else reason = module.registeredModelGroundFailure({ ...owner, ...at }, { height: ctx.height, inRiver: ctx.inRiver }) ?? "candidate-admitted";
    tally(examples, counts, reason, at);
    if (module.inspectModelGround({ ...owner, ...at }, { height: ctx.height, inRiver: ctx.inRiver }).status === "partial") {
      tally(groundAdmissibleExamples, groundAdmissibleRejectedBy, reason, at);
      const candidate = { ...owner, ...at }, roads = ctx.diagnosticRoads;
      const roadFacts = roads.map(road => module.inspectEnvelopeRoad(candidate, road, { setback: 3 }));
      const highwayFacts = ctx.ringRuns.map((points, index) => module.inspectEnvelopeRoad(candidate,
        { id: `diagnostic-highway:${index}`, points, width: 10.5 }, { setback: 1 }));
      const overlappingOwners = others.filter(other => Math.hypot(other.x - at.x, other.z - at.z) < owner.radius + other.radius).map(other => other.id);
      const wetCircle = module.wetCount({ height: ctx.height, inRiver: ctx.inRiver, riverBank: ctx.riverBank }, at, owner.radius, { river: true, riverBank: 14 });
      const entityReason = wetCircle > 2 || ctx.height(at.x, at.z) <= 0.5 ? "original-wet-or-centre-policy"
        : roadFacts.some(fact => fact.status !== "partial" || fact.entity.relation === "unsupported") ? "initial-road-envelope-unsupported"
        : roadFacts.some(fact => fact.entity.relation !== "clear") ? "initial-actual-full-road-width-conflict"
        : highwayFacts.some(fact => fact.status !== "partial" || fact.entity.relation !== "clear") ? "initial-actual-highway-conflict-or-unsupported"
        : overlappingOwners.length ? "original-nominal-owner-spacing"
        : "partial-initial-geometry-clear-not-published";
      tally(initialEntityExamples, initialEntityCounts, entityReason, at);
      // Joint reline diagnosis keeps every original site/highway condition and
      // records actual blocking roads, rather than pretending they disappeared.
      const roadConflicts = roadFacts.flatMap((fact, index) => fact.status === "partial" && fact.entity.relation === "conflict"
        ? [{ id: roads[index].id, width: roads[index].width, kind: roads[index].kind, bridge: !!roads[index].bridge,
            structure: roads[index].structure, margin: fact.entity.margin, points: roads[index].points }] : []);
      if (wetCircle <= 2 && ctx.height(at.x, at.z) > 0.5 && overlappingOwners.length === 0 && roadConflicts.length
        && roadFacts.every(fact => fact.status === "partial" && fact.entity.relation !== "unsupported")
        && highwayFacts.every(fact => fact.status === "partial" && fact.entity.relation === "clear")) {
        const coastDistance = ctx.coastDistance(at.x, at.z), maximumRelocationCoastDistance = Math.max(owner.radius * 2, ctx.coastDistance(owner.x, owner.z));
        initialRoadOnlyCandidates.push({ at, wetCircle, coastDistance, maximumRelocationCoastDistance,
          withinExistingRelocationCoastBound: coastDistance <= maximumRelocationCoastDistance,
          nearBridgeEnd: module.nearBridgeEnd(ctx.bridges, at.x, at.z, owner.radius), blockingRoads: roadConflicts,
          admission: "not-admitted; joint road/site proposal unattempted, final network/entrance/transaction unverified" });
      }
      if (entityReason === "partial-initial-geometry-clear-not-published") initialEntityCandidates.push({ at, originalReason: reason, wetCircle,
        legacyTrunkDistance: module.polylineDistance(ctx.trunkRuns, at), coastDistance: ctx.coastDistance(at.x, at.z),
        nearBridgeEnd: module.nearBridgeEnd(ctx.bridges, at.x, at.z, owner.radius),
        minimumActualRoadMargin: roadFacts.length ? Math.min(...roadFacts.map(fact => fact.entity.margin)) : null,
        admission: "not-admitted; stage counterfactual only, final roads/entrance/transaction policy unverified" });
    }
  }
  console.log(JSON.stringify({ stage: "initial-shore-local-tier", radius, owner, attempts, firstRejectionCounts: counts, examples,
    groundAdmissibleRejectedBy, groundAdmissibleExamples, initialRoadCount: ctx.diagnosticRoads.length,
    initialEntityCounts, initialEntityExamples, initialEntityCandidates, initialRoadOnlyCandidateCount: initialRoadOnlyCandidates.length,
    initialRoadOnlyCandidates: initialRoadOnlyCandidates.sort((a, b) => a.blockingRoads.length - b.blockingRoads.length || a.at.x - b.at.x || a.at.z - b.at.z).slice(0, 5) }));
}
for (const { radius, ctx } of beforeSolve.filter(row => row.radius === plan.islandRadius)) {
  const owner = ctx.landmarks.find(site => site.kind === "villa-complex"); if (!owner) continue;
  const view = { roadNodes: [...ctx.network.nodes.values()], roadEdges: [...ctx.network.edges.values()], publicSites: ctx.publicSites, landmarks: ctx.landmarks,
    core: ctx.core, coast: ctx.coast, coastRoads: ctx.coastRoadRuns.slice(0, ctx.coastalRunCount), riverRoadRuns: ctx.riverRoadRuns,
    river: ctx.geo.river, seaside: ctx.seaside, primaryAnchorNodeId: ctx.primaryAnchorNodeId, siteObligations: ctx.siteObligations, demandCatalogue: ctx.demandCatalogue };
  const components = module.componentOf(view), primary = module.primaryComponentId(view, components);
  const primaryRoads = view.roadEdges.filter(edge => !edge.bridge && components.get(edge.from) === primary).map(edge => edge.points);
  const counts = {}, examples = {}, groundAdmissibleRejectedBy = {}, groundAdmissibleExamples = {}, entityFactCounts = {}, entityFactExamples = {}, remainingPolicyCandidates = [], coastAlignedCandidateCounts = {}, coastAlignedCandidateExamples = {}, jointRoadCounts = {}, jointRoadExamples = {}; let attempts = 0;
  for (const at of module.localResiteCandidates(owner)) {
    attempts += 1;
    // Read-only counterfactual: one local coast-facing yaw per existing position,
    // not additional positions or route attempts. The copied diagnostic owner
    // is restored before evaluating the original production candidate.
    const localCoast = module.closestPolylineSegment([...ctx.coast, ctx.coast[0]], at);
    if (localCoast) {
      const yaw = module.DetMath.atan2(localCoast.q.x - at.x, localCoast.q.z - at.z), priorYaw = owner.yaw;
      try {
        owner.yaw = yaw;
        let poseReason = module.relocatedSitePositionFailure(ctx, owner, at, true);
        if (!poseReason && module.polylineDistance(primaryRoads, at) > owner.radius + 20) poseReason = "primary-service-bound";
        if (!poseReason && ctx.blocks.some(block => block.parcels.some(parcel => Math.hypot(parcel.x - at.x, parcel.z - at.z)
          < owner.radius + 9 + Math.hypot(parcel.width, parcel.depth) / 2))) poseReason = "reserved-parcel-envelope";
        poseReason ??= module.registeredModelGroundFailure({ ...owner, ...at }, { height: ctx.height, inRiver: ctx.inRiver });
        tally(coastAlignedCandidateExamples, coastAlignedCandidateCounts, poseReason ?? "candidate-pre-screen-admitted-not-transaction-accepted", { ...at, yaw });
      } finally { owner.yaw = priorYaw; }
    }
    let reason = module.relocatedSitePositionFailure(ctx, owner, at, true);
    if (!reason && module.polylineDistance(primaryRoads, at) > owner.radius + 20) reason = "primary-service-bound";
    if (!reason && ctx.blocks.some(block => block.parcels.some(parcel => Math.hypot(parcel.x - at.x, parcel.z - at.z)
      < owner.radius + 9 + Math.hypot(parcel.width, parcel.depth) / 2))) reason = "reserved-parcel-envelope";
    reason ??= module.registeredModelGroundFailure({ ...owner, ...at }, { height: ctx.height, inRiver: ctx.inRiver });
    tally(examples, counts, reason ?? "candidate-admitted", at);
    if (module.inspectModelGround({ ...owner, ...at }, { height: ctx.height, inRiver: ctx.inRiver }).status === "partial") {
      tally(groundAdmissibleExamples, groundAdmissibleRejectedBy, reason ?? "candidate-admitted", at);
      const joint = module.prepareJointSiteRoadRelocation(ctx, owner.id, at);
      tally(jointRoadExamples, jointRoadCounts, joint.ok ? "joint-proposal-prepared-not-published" : joint.reason, at);
      const candidate = { ...owner, ...at };
      const roadFacts = view.roadEdges.map(road => module.inspectEnvelopeRoad(candidate, road, { setback: 3 }));
      const ownerFacts = [...ctx.publicSites, ...ctx.landmarks].filter(other => other.id !== owner.id && other.radius > 0)
        .map(other => module.inspectEnvelopePair(candidate, other, { setback: 0 }));
      const entityReason = roadFacts.some(fact => fact.status !== "partial" || fact.entity.relation === "unsupported") ? "road-envelope-unsupported"
        : roadFacts.some(fact => fact.entity.relation === "conflict") ? "actual-full-road-width-conflict"
        : ownerFacts.some(fact => fact.status === "partial" && fact.entity.relation === "conflict") ? "registered-entity-conflict"
        : ownerFacts.some(fact => fact.status === "unsupported" && fact.proxy?.relation !== "clear") ? "unknown-owner-proxy-conflict-or-missing"
        : "partial-XY-facts-clear-still-plot-highway-entrance-policy-pending";
      tally(entityFactExamples, entityFactCounts, entityReason, at);
      if (entityReason === "partial-XY-facts-clear-still-plot-highway-entrance-policy-pending") {
        const riverBank = (x, z, bank) => ctx.geo.hasRiver && Math.abs(x - ctx.geo.riverX(z)) < ctx.geo.riverWidth(z) + bank;
        const wetCircle = module.wetCount({ height: ctx.geo.height, inRiver: ctx.inRiver, riverBank }, at, owner.radius, { river: true, riverBank: 14 });
        const coastDistance = ctx.geo.coastDistance(at.x, at.z);
        const maximumCoastDistance = Math.max(owner.radius * 2, ctx.geo.coastDistance(owner.x, owner.z));
        const overlappingPlotOwners = [...ctx.publicSites, ...ctx.landmarks].filter(other => other.id !== owner.id
          && Math.hypot(other.x - at.x, other.z - at.z) < other.radius + owner.radius).map(other => other.id);
        const reservedParcelIds = ctx.blocks.flatMap(block => block.parcels).filter(parcel => Math.hypot(parcel.x - at.x, parcel.z - at.z)
          < owner.radius + 9 + Math.hypot(parcel.width, parcel.depth) / 2).map(parcel => parcel.id);
        const primaryDistance = module.polylineDistance(primaryRoads, at);
        const highwayClear = module.clearsHighways(at, owner.radius * 2, owner.radius * 2, ctx.ringRuns);
        // Same deck half-width 5.25 and sidewalk setback 1 as clearsHighways;
        // compare the actual XY projection rather than the square's circumscribed circle.
        const highwayProjectionFacts = ctx.ringRuns.map(points => module.inspectEnvelopeRoad(candidate, { width: 10.5, points }, { setback: 1 }));
        const highwayProjection = highwayProjectionFacts.some(fact => fact.status !== "partial" || fact.entity.relation === "unsupported") ? "unsupported"
          : highwayProjectionFacts.some(fact => fact.entity.relation === "conflict") ? "conflict" : "clear";
        remainingPolicyCandidates.push({ at, wetCircle, wetCircleLimit: 3, coastDistance, maximumCoastDistance,
          overlappingPlotOwners, reservedParcelIds, primaryDistance, maximumPrimaryDistance: owner.radius + 20, highwayClear, highwayProjection,
          rejectedBy: [...(wetCircle > 3 ? ["nominal-plot-wet-budget"] : []),
            ...(coastDistance > maximumCoastDistance ? ["coastal-reassignment-band"] : []),
            ...(overlappingPlotOwners.length ? ["nominal-plot-owner-spacing"] : []),
            ...(reservedParcelIds.length ? ["reserved-parcel-envelope"] : []),
            ...(primaryDistance > owner.radius + 20 ? ["primary-service-bound"] : []),
            ...(!highwayClear ? ["nominal-square-highway-clearance"] : [])],
          admission: "not-admitted; actual entrance and full physical policy remain unverified" });
      }
    }
  }
  console.log(JSON.stringify({ stage: "pre-solve-wet-local-tier", radius, owner, attempts, firstRejectionCounts: counts, examples,
    groundAdmissibleRejectedBy, groundAdmissibleExamples, entityFactCounts, entityFactExamples, remainingPolicyCandidates, coastAlignedCandidateCounts, coastAlignedCandidateExamples,
    jointRoadCounts, jointRoadExamples,
    entityFactScope: "read-only conservative XY projection; neighbor extra setback=0; highway/plot/entrance policy remains pending; no candidate published" }));
}
delete globalThis.__groundDiagnostic;
