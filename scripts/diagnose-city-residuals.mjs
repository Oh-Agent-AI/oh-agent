#!/usr/bin/env node
// Read-only tuning diagnosis, not an acceptance suite or a frozen-seed tuner.
// Usage: node scripts/diagnose-city-residuals.mjs SEED/TIER [...] [--compare-solve]
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { cachedPlan, citySrc, loadCity, repo } from "./city-kit/index.mjs";

const args = process.argv.slice(2), compare = args.includes("--compare-solve");
const cases = args.filter((arg) => arg !== "--compare-solve").map((arg) => {
  assert.match(arg, /^\d+\/[1-9]\d*$/, "expected SEED/TIER, no implicit frozen sample selection");
  const [seed, tier] = arg.split("/").map(Number);
  assert.ok(Number.isSafeInteger(seed) && Number.isSafeInteger(tier) && tier <= 10);
  return { seed, tier };
});
assert.ok(cases.length > 0 && cases.length <= 60, "provide 1–60 explicit tuning cases");
const hash = crypto.createHash("sha256");
const visit = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.(ts|tsx|js|json)$/.test(entry.name)) hash.update(path.relative(repo, file)).update("\0").update(fs.readFileSync(file));
  }
};
visit(citySrc);
const source = { sha256: hash.digest("hex"), node: process.version, platform: process.platform, arch: process.arch };
const { createCityPlan, MIAMI_COASTAL, CONSTRAINTS, diagnoseNetwork, roadReport } = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan"], "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/constraints.ts": ["CONSTRAINTS"], "engine/planner/intent.ts": ["diagnoseNetwork"],
  "engine/planner/report.ts": ["roadReport"],
});
const inspect = (plan) => {
  const before = JSON.stringify(plan);
  const constraints = Object.fromEntries(CONSTRAINTS.map((constraint) => {
    const findings = constraint.measure(plan);
    return [constraint.id, { count: findings.length, findings }];
  }));
  const intent = diagnoseNetwork(plan);
  const report = roadReport({ roadEdges: plan.roadEdges, nodes: plan.roadNodes, blocks: plan.blocks,
    publicSites: plan.publicSites, landmarks: plan.landmarks, culDeSacEnds: plan.culDeSacEnds ?? [], seaside: plan.seaside ?? null });
  const contactIds = new Set(report.graph.planarCrossings.findings.flatMap((finding) => finding.edges));
  assert.equal(JSON.stringify(plan), before, "diagnosis changed the plan");
  return { radius: plan.islandRadius, radiusAttempts: plan.radiusAttempts, radiusHistory: plan.radiusHistory,
    parcelGeneration: plan.parcelGeneration, capacity: plan.capacity,
    derivedNetworkVersion: plan.derivedNetworkVersion, constraints, intent,
    skeletonDiagnostics: plan.skeletonDiagnostics, skeletonReservationIds: plan.skeletonReservationIds,
    placementObligations: plan.siteObligations, reportGraph: report.graph,
    contactRoads: plan.roadEdges.filter((edge) => contactIds.has(edge.id)),
    sites: [...plan.publicSites, ...plan.landmarks],
    repairRejections: (plan.solveReport ?? []).filter((entry) => entry.declined > 0),
    connectionFailures: { count: (plan.connections ?? []).filter((entry) => !entry.ok).length,
      // Bound log text; never truncate the geometry/constraint evidence above.
      last: (plan.connections ?? []).filter((entry) => !entry.ok).slice(-80) } };
};
for (const { seed, tier } of cases) {
  console.error(`City diagnosis: start ${seed}/t${tier}`);
  const began = performance.now();
  const plan = cachedPlan(createCityPlan, seed, tier, MIAMI_COASTAL);
  const solved = inspect(plan);
  const unsolved = compare ? inspect(cachedPlan(createCityPlan, seed, tier, MIAMI_COASTAL, { skipSolve: true })) : null;
  console.log(JSON.stringify({ schemaVersion: 1, source, seed, tier, profile: "MIAMI_COASTAL",
    durationMs: Math.round(performance.now() - began), solved, unsolved,
    comparison: unsolved ? { sameRadius: solved.radius === unsolved.radius,
      causalAttributionAllowed: false,
      note: "Same radius is necessary, not sufficient: demand/reservation versions must also match; changed-radius counts are not a solve counterfactual." } : null }));
  console.error(`City diagnosis: done ${seed}/t${tier}`);
}
