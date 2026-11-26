import test from "node:test";
import assert from "node:assert/strict";
import { createCityShape } from "../src/engine/cityPlan.ts";
import { ARID_DUNES_CITY_WORLD_V1, cityWorldBuildConfig } from "../src/engine/cityWorldProfile.ts";
import { executePlanningWorkerJob } from "../src/engine/planningWorker/planningWorkerJob.ts";
import { hydratePlanningPlan, PLANNING_PROTOCOL_VERSION, type PlanningParameters } from "../src/engine/planningWorker/planningProtocol.ts";
import { PLANNING_WORK_UNITS } from "../src/engine/planner/operationBudget.ts";

test("the selected desert draft seed survives the worker's full plan and snapshot gates", () => {
  const seed = 42;
  const config = cityWorldBuildConfig(ARID_DUNES_CITY_WORLD_V1, createCityShape(seed));
  const parameters = { seed, tier: 1, coastal: null, biome: config.biome, geographyGenerator: config.geographyGenerator,
    geographyOptions: config.geographyOptions, limits: Object.fromEntries(PLANNING_WORK_UNITS.map(unit => [unit, Number.MAX_SAFE_INTEGER])) } as PlanningParameters;
  const result = executePlanningWorkerJob({ version: PLANNING_PROTOCOL_VERSION, requestId: "desert-draft-test", parameters });
  assert.equal(result.status, "computed");
  if (result.status !== "computed") return;
  const plan = hydratePlanningPlan(result.snapshot, parameters);
  assert.notEqual(plan.planningOutcome.status, "failed");
  assert.equal(plan.planningOutcome.unmetDemandIds.length, 0);
  assert.ok(plan.capacity.satisfied);
});
