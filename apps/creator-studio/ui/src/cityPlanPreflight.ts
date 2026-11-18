import { ensureCityPlan } from "../../../agent-city/ui/src/engine/cityLayout";
import { createCityShape } from "../../../agent-city/ui/src/engine/cityShape";
import { cityWorldBuildConfig, coastalConfigForWorld } from "../../../agent-city/ui/src/engine/cityWorldProfile";

/** The planner result `creator_city_create` rejects on: a seed whose required connection
 * demands cannot be met at the initial tier still produces a City, but the viewport later
 * fails with layout-preparation:planning-outcome-failed. Preflight the same tier-1 plan
 * before the host persists, so a dead seed never gets a City row. `ensureCityPlan` caches
 * the plan, so opening the viewport afterwards reuses it instead of planning twice. */
export function assertCityPlanPlayable(seed: unknown, profile: unknown): void {
  if (!Number.isSafeInteger(seed) || typeof profile !== "object" || profile === null) throw new Error("planning_outcome_failed");
  try {
    const worldProfile = profile as Parameters<typeof cityWorldBuildConfig>[0];
    const world = cityWorldBuildConfig(worldProfile, createCityShape(seed as number));
    const plan = ensureCityPlan(seed as number, 1, coastalConfigForWorld(worldProfile),
      world.geographyGenerator, world.geographyOptions, world.biome);
    if (plan.planningOutcome.status === "failed") throw new Error("planning_outcome_failed");
  } catch (error) {
    if (error instanceof Error && error.message === "planning_outcome_failed") throw error;
    throw new Error("planning_outcome_failed");
  }
}
