#!/usr/bin/env node
// Cold createCityPlan vs hydratePlanningPlan from a persisted worker snapshot.
// Usage: node scripts/bench-city-plan-disk-cache.mjs [--tier 10] [--seed 1927]
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { loadCity } from "./city-kit/index.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const SEED = flag("--seed", 1927);
const TIER = flag("--tier", 10);

const {
  executePlanningWorkerJob, hydratePlanningPlan, PLANNING_WORK_UNITS, MIAMI_COASTAL, scaleTierFor,
} = await loadCity({
  "engine/planningWorker/planningWorkerJob.ts": ["executePlanningWorkerJob"],
  "engine/planningWorker/planningProtocol.ts": ["hydratePlanningPlan"],
  "engine/planner/operationBudget.ts": ["PLANNING_WORK_UNITS"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/scaleTier.ts": ["scaleTierFor"],
});

assert.equal(TIER, scaleTierFor(TIER * 400), `tier ${TIER} matches ${TIER * 400} sessions`);
const parameters = {
  seed: SEED, tier: TIER, coastal: { ...MIAMI_COASTAL },
  limits: Object.fromEntries(PLANNING_WORK_UNITS.map(unit => [unit, Number.MAX_SAFE_INTEGER])),
};
const shape = (plan) => JSON.parse(JSON.stringify({ ...plan, terrain: undefined, workBudget: undefined }));

const t0 = performance.now();
const response = executePlanningWorkerJob({ version: 1, requestId: "bench", parameters });
const coldMs = performance.now() - t0;
assert.equal(response.status, "computed", response.reason ?? "planning failed");
const snapshot = response.snapshot;
const bytes = Buffer.byteLength(JSON.stringify(snapshot));
const t1 = performance.now();
const hydrated = hydratePlanningPlan(structuredClone(snapshot), parameters);
const warmMs = performance.now() - t1;
assert.deepEqual(shape(hydrated), shape(snapshot.plan), "hydrate keeps roads, parcels and sites");
assert.ok(Number.isFinite(hydrated.terrain.height(0, 0)));
assert.ok(warmMs < coldMs * 0.2, `warm hydrate should be << cold plan (cold ${Math.round(coldMs)}ms, warm ${Math.round(warmMs)}ms)`);

const report = {
  seed: SEED, tier: TIER, snapshotBytes: bytes,
  coldCreateCityPlanMs: Math.round(coldMs),
  warmHydrateMs: Math.round(warmMs),
  speedup: Number((coldMs / Math.max(1, warmMs)).toFixed(1)),
};
console.log(JSON.stringify(report, null, 2));
console.log("bench-city-plan-disk-cache: ok");
