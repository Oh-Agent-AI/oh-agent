import type { AuditPlan } from "./driving/audit/RoadAuditPlanner";
import type { PassabilityResult } from "./driving/audit/RoadPassabilityAudit";

export type RoadAuditViewRow = Readonly<{
  id: string; status: "passed" | "blocked" | "inconclusive" | "excluded"; reason: string;
  result: PassabilityResult | null; location: Readonly<{ x: number; z: number }> | null;
}>;

function routeMidpoint(path: readonly Readonly<{ x: number; z: number }>[]): Readonly<{ x: number; z: number }> | null {
  if (!path.length) return null;
  if (path.length === 1) return Object.freeze({ ...path[0] });
  const lengths = [0];
  for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
  const half = lengths[lengths.length - 1] / 2;
  let i = 1;
  while (i < lengths.length - 1 && lengths[i] < half) i++;
  const span = lengths[i] - lengths[i - 1];
  const t = span > 0 ? (half - lengths[i - 1]) / span : 0;
  return Object.freeze({ x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, z: path[i - 1].z + (path[i].z - path[i - 1].z) * t });
}

/** Project the planner's complete frozen denominator into bounded, browseable rows.
 * A result is never inferred from a missing case: unrun mandatory units are inconclusive. */
export function buildRoadAuditViewRows(plan: AuditPlan, results: readonly PassabilityResult[]): readonly RoadAuditViewRow[] {
  const resultById = new Map(results.map((result) => [result.routeId, result]));
  const routeById = new Map(plan.routes.map((route) => [route.id, route]));
  const excluded = new Map(plan.exclusions.map((item) => [item.unitId, item.reason]));
  return Object.freeze(plan.units.map((unit) => {
    const result = resultById.get(unit.id) ?? null;
    const route = routeById.get(unit.id);
    const witness = result?.witness;
    const location = witness?.kind === "cut" ? Object.freeze({ x: (witness.a.x + witness.b.x) / 2, z: (witness.a.z + witness.b.z) / 2 })
      : result?.run?.diagnostic ? Object.freeze({ x: result.run.diagnostic.x, z: result.run.diagnostic.z })
        : route ? routeMidpoint(route.path) : null;
    if (excluded.has(unit.id)) return Object.freeze({ id: unit.id, status: "excluded" as const, reason: excluded.get(unit.id)!, result: null, location });
    return Object.freeze({ id: unit.id, status: result?.verdict ?? "inconclusive" as const,
      reason: result?.detail ?? "not-run", result, location });
  }));
}
