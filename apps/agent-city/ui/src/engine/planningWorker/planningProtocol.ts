import { MAX_TIER, targetParcels, RADIUS_CALIBRATION_CONFIG, type Biome, type createCityPlan } from "../cityPlan";
import type { CoastalConfig } from "../citySeaside";
import type { TerrainField } from "../cityLayout";
import { buildGeographyWithGenerator, validateGeographyBuildOptions, DEFAULT_GEOGRAPHY_GENERATOR, GEOGRAPHY_GENERATOR_IDS,
  type GeographyGeneratorId, type GeographyGeneratorOptions } from "../planner/geography";
import { PLANNING_WORK_UNITS, type PlanningWorkCounts, type PlanningWorkSnapshot, type PlanningStop } from "../planner/operationBudget";

export const PLANNING_PROTOCOL_VERSION = 2;
export type GeneratedCityPlan = ReturnType<typeof createCityPlan>;
type GeneratorPlanningOptions = { [G in GeographyGeneratorId]: { geographyGenerator: G; geographyOptions: GeographyGeneratorOptions[G] } }[GeographyGeneratorId];
export type PlanningParameters = { seed: number; tier: number; coastal: CoastalConfig | null; biome: Biome;
  limits: PlanningWorkCounts; memoizeTerrain?: boolean } & GeneratorPlanningOptions;
export type PlanningRequest = { version: typeof PLANNING_PROTOCOL_VERSION; requestId: string; parameters: PlanningParameters };
export type PlanningPlanSnapshot = {
  version: typeof PLANNING_PROTOCOL_VERSION; requestKey: string;
  plan: Omit<GeneratedCityPlan, "terrain"> & { terrain: Pick<TerrainField, "center" | "radius" | "hasRiver"> };
};
export type PlanningWorkerResponse =
  | { version: typeof PLANNING_PROTOCOL_VERSION; requestId: string; status: "computed"; snapshot: PlanningPlanSnapshot }
  | { version: typeof PLANNING_PROTOCOL_VERSION; requestId: string; status: "progress"; workBudget: PlanningWorkSnapshot }
  | { version: typeof PLANNING_PROTOCOL_VERSION; requestId: string; status: "failed"; reason: string;
      stop?: PlanningStop; workBudget?: PlanningWorkSnapshot };
const coastalNumbers = ["version", "preferredAzimuth", "azimuthTolerance", "segmentArc", "wetSandWidth", "drySandWidth",
  "promenadeOffset", "boulevardOffset", "hotelOffset", "bandOuter", "maxCoastalSlope", "maxCoastalHeight", "riverMargin", "siteMargin", "minValidRatio", "bayHalfWidth", "bayShift"] as const;
export function validPlanningWorkSnapshot(budget: PlanningWorkSnapshot, limits: PlanningWorkCounts): boolean {
  return !!budget && !budget.stop && !!budget.limits && !!budget.consumed
    && Object.keys(budget.limits).length === PLANNING_WORK_UNITS.length && Object.keys(budget.consumed).length === PLANNING_WORK_UNITS.length
    && PLANNING_WORK_UNITS.every(unit => budget.limits[unit] === limits[unit]
      && Number.isSafeInteger(budget.consumed[unit]) && budget.consumed[unit] >= 0 && budget.consumed[unit] <= limits[unit]);
}
export function validPlanningParameters(value: unknown): value is PlanningParameters {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["seed", "tier", "coastal", "biome", "geographyGenerator", "geographyOptions", "limits", "memoizeTerrain"].includes(key))
    || ["seed", "tier", "coastal", "biome", "geographyGenerator", "geographyOptions", "limits"].some(key => !Object.hasOwn(value, key))) return false;
  const input = value as PlanningParameters;
  if (!Number.isSafeInteger(input.seed) || !Number.isInteger(input.tier) || input.tier < 1 || input.tier > MAX_TIER
    || !["tropical", "temperate", "boreal", "savanna", "eastasian", "arid"].includes(input.biome)
    || (input.memoizeTerrain !== undefined && typeof input.memoizeTerrain !== "boolean")) return false;
  if (!input.limits || Object.keys(input.limits).length !== PLANNING_WORK_UNITS.length
    || PLANNING_WORK_UNITS.some(unit => !Object.hasOwn(input.limits, unit) || !Number.isSafeInteger(input.limits[unit]) || input.limits[unit] < 0)) return false;
  if (!(GEOGRAPHY_GENERATOR_IDS as readonly string[]).includes(input.geographyGenerator)) return false;
  const coast = input.coastal;
  const coastalValid = coast === null || (!!coast && Object.hasOwn(coast, "profile") && Object.hasOwn(coast, "biome")
    && coast.profile === "miami-coastal" && coast.biome === "tropical"
    && Object.keys(coast).length === coastalNumbers.length + 2
    && coastalNumbers.every(key => Object.hasOwn(coast, key) && Number.isFinite(coast[key]))
    && Number.isSafeInteger(coast.version) && coast.version >= 1 && coast.minValidRatio >= 0 && coast.minValidRatio <= 1);
  if (!coastalValid || (input.geographyGenerator !== "coastal-islands-v1" && coast !== null)
    || (coast !== null && coast.biome !== input.biome)
    || ((input.geographyGenerator === "arid-dunes-v1") !== (input.biome === "arid"))) return false;
  try { validateGeographyBuildOptions(input.geographyGenerator, input.geographyOptions); }
  catch { return false; }
  return true;
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalize(record[key])]));
}
/** Includes every generator parameter, biome and coastal content override. */
export function planningRequestKey(input: PlanningParameters): string {
  if (!validPlanningParameters(input)) throw new Error("invalid-planning-parameters");
  return JSON.stringify([PLANNING_PROTOCOL_VERSION, input.seed, input.tier,
    input.geographyGenerator, canonicalize(input.geographyOptions), input.biome,
    input.coastal ? [input.coastal.profile, input.coastal.biome, ...coastalNumbers.map(key => input.coastal![key])] : null,
    PLANNING_WORK_UNITS.map(unit => input.limits[unit]), input.memoizeTerrain === true]);
}
export function serializePlanningPlan(plan: GeneratedCityPlan, input: PlanningParameters): PlanningPlanSnapshot {
  return { version: PLANNING_PROTOCOL_VERSION, requestKey: planningRequestKey(input), plan: { ...plan,
    terrain: { center: { ...plan.terrain.center }, radius: plan.terrain.radius, hasRiver: plan.terrain.hasRiver } } };
}
export function hydratePlanningPlan(snapshot: PlanningPlanSnapshot, input: PlanningParameters): GeneratedCityPlan {
  if (!snapshot || snapshot.version !== PLANNING_PROTOCOL_VERSION || snapshot.requestKey !== planningRequestKey(input))
    throw new Error("stale-planning-snapshot");
  const plan = snapshot.plan;
  if (!plan || plan.scaleTier !== input.tier || plan.biome !== input.biome || !Number.isFinite(plan.islandRadius) || plan.islandRadius <= 0
    || !plan.derivedFinalization?.ok || !plan.capacity?.satisfied || plan.planningOutcome?.status === "failed"
    || !Array.isArray(plan.roadNodes) || !Array.isArray(plan.roadEdges) || !Array.isArray(plan.blocks)) throw new Error("invalid-planning-snapshot");
  const collections = ["publicSites", "landmarks", "bridges", "parkTrees", "highways", "carPaths", "districtAnchors",
    "coastRoads", "riverRoadRuns", "coast", "culDeSacEnds", "siteObligations", "junctionRings", "highwayRamps"] as const;
  if (collections.some(key => !Array.isArray(plan[key]))) throw new Error("incomplete-planning-snapshot");
  const point = (value: { x: number; z: number }) => !!value && Number.isFinite(value.x) && Number.isFinite(value.z);
  const nodes = new Map(plan.roadNodes.map(node => [node.id, node]));
  const edgeIds = new Set<string>();
  if (nodes.size !== plan.roadNodes.length || plan.roadNodes.some(node => !point(node) || typeof node.id !== "string")
    || plan.roadEdges.some(edge => {
      const start = nodes.get(edge.from), end = nodes.get(edge.to);
      if (!start || !end || edge.from === edge.to || typeof edge.id !== "string" || edgeIds.has(edge.id)
        || !Number.isFinite(edge.width) || edge.width <= 0 || !Array.isArray(edge.points) || edge.points.length < 2 || edge.points.some(p => !point(p))) return true;
      edgeIds.add(edge.id);
      return start.x !== edge.points[0].x || start.z !== edge.points[0].z
        || end.x !== edge.points[edge.points.length - 1].x || end.z !== edge.points[edge.points.length - 1].z;
    })) throw new Error("invalid-planning-network-snapshot");
  if (plan.blocks.some(block => !Array.isArray(block.parcels))
    || plan.blocks.reduce((total, block) => total + block.parcels.length, 0) !== plan.capacity.available
    || plan.capacity.required !== targetParcels(input.tier))
    throw new Error("invalid-planning-capacity-snapshot");
  if (!Number.isInteger(plan.radiusAttempts) || plan.radiusAttempts < 0 || plan.radiusAttempts > RADIUS_CALIBRATION_CONFIG.maxRetries
    || !Array.isArray(plan.radiusHistory) || plan.radiusHistory.length !== plan.radiusAttempts + 1
    || plan.radiusHistory.some((entry, index) => entry.attempt !== index || !Number.isFinite(entry.radius) || entry.radius <= 0)
    || plan.radiusHistory[plan.radiusHistory.length - 1].radius !== plan.islandRadius
    || plan.planningOutcome.versions?.network !== plan.derivedNetworkVersion)
    throw new Error("invalid-planning-version-snapshot");
  const owners = [...plan.publicSites, ...plan.landmarks];
  if (plan.siteObligations.some(obligation => !obligation.placed
    || !owners.some(owner => owner.id === obligation.ownerId && owner.access && nodes.has(owner.access.nodeId))))
    throw new Error("invalid-planning-owner-snapshot");
  const budget = (plan as GeneratedCityPlan & { workBudget?: PlanningWorkSnapshot }).workBudget;
  if (!budget || !validPlanningWorkSnapshot(budget, input.limits))
    throw new Error("invalid-planning-budget-snapshot");
  const geo = buildGeographyWithGenerator(input.geographyGenerator ?? DEFAULT_GEOGRAPHY_GENERATOR, { seed: input.seed, radius: plan.islandRadius,
    memoize: input.memoizeTerrain, options: input.geographyOptions }), terrain = geo.terrain;
  if (!plan.features || Object.keys(geo.features).some((key) => plan.features[key as keyof typeof geo.features] !== geo.features[key as keyof typeof geo.features]))
    throw new Error("invalid-planning-geography-snapshot");
  if (plan.terrain?.radius !== terrain.radius || plan.terrain?.hasRiver !== terrain.hasRiver
    || plan.terrain?.center?.x !== terrain.center.x || plan.terrain?.center?.z !== terrain.center.z)
    throw new Error("invalid-planning-terrain-snapshot");
  if (plan.coast.length !== geo.coast.length || plan.coast.some((p, index) => p.x !== geo.coast[index].x || p.z !== geo.coast[index].z))
    throw new Error("invalid-planning-geography-snapshot");
  const workBudget = Object.freeze({ limits: Object.freeze({ ...budget.limits }), consumed: Object.freeze({ ...budget.consumed }) });
  return { ...plan, terrain, workBudget };
}
