import { sameAuditKey, validateManifest } from "./AuditIdentity";
import type { AuditManifest, RoadAuditCaseResult, StaticUnitEvidence } from "./contracts";
export type UnitRelease = Readonly<{ unitId: string; status: "passed" | "blocked" | "pending" | "excluded" | "closed"; reason: string }>;
export type AuditReleaseDecision = Readonly<{
  ready: boolean; candidateCount: number; mandatoryCount: number; passedCount: number; closedCount: number;
  units: readonly UnitRelease[]; reasons: readonly string[];
}>;
/** No graph mutation. The consumer must enforce every returned direction/turn
 * restriction; a green subset is not a certificate that the whole city passed. */
export function evaluateAuditRelease(manifest: AuditManifest, staticResults: readonly StaticUnitEvidence[], runs: readonly RoadAuditCaseResult[]): AuditReleaseDecision {
  validateManifest(manifest);
  const reasons: string[] = [];
  if (manifest.key.releaseBoundaryHash === null) reasons.push("final-boundary-replay-required");
  const staticByUnit = new Map<string, StaticUnitEvidence>(); const cases = new Map<string, RoadAuditCaseResult>();
  const duplicateStatic = new Set<string>(); const duplicateCases = new Set<string>();
  for (const result of staticResults) {
    if (!sameAuditKey(result.key, manifest.key)) continue;
    if (staticByUnit.has(result.unitId)) duplicateStatic.add(result.unitId);
    staticByUnit.set(result.unitId, result);
  }
  for (const run of runs) {
    if (!sameAuditKey(run.key, manifest.key)) continue;
    if (cases.has(run.caseId)) duplicateCases.add(run.caseId);
    cases.set(run.caseId, run);
  }
  const exclusions = new Map(manifest.exclusions.map((x) => [x.unitId, x.reason]));
  const units = manifest.units.map((unit): UnitRelease => {
    const excluded = exclusions.get(unit.id);
    if (excluded) return { unitId: unit.id, status: "excluded", reason: excluded };
    const evidence = staticByUnit.get(unit.id);
    if (!evidence || duplicateStatic.has(unit.id)) return { unitId: unit.id, status: "pending", reason: "missing-or-duplicate-static-evidence" };
    if ((evidence.topology === "blocked" || evidence.geometry === "blocked") && evidence.witness?.trim()) {
      return { unitId: unit.id, status: "blocked", reason: evidence.witness };
    }
    if (evidence.topology !== "passed" || evidence.geometry !== "passed") return { unitId: unit.id, status: "pending", reason: "unconfirmed-static-evidence" };
    const required = manifest.cases.filter((item) => item.units.includes(unit.id));
    for (const test of required) {
      const result = cases.get(test.id);
      if (!result || duplicateCases.has(test.id) || result.verdict !== "passed" || result.cause !== "none" ||
          !Number.isSafeInteger(result.simulatedTicks) || result.simulatedTicks < 1 || result.simulatedTicks > test.maxTicks ||
          result.coveredUnits.length !== test.units.length || new Set(result.coveredUnits).size !== test.units.length ||
          test.units.some((id) => !result.coveredUnits.includes(id))) {
        return { unitId: unit.id, status: "pending", reason: "mandatory-run-not-passed" };
      }
    }
    if (manifest.key.releaseBoundaryHash === null) return { unitId: unit.id, status: "pending", reason: "final-boundary-replay-required" };
    return { unitId: unit.id, status: "passed", reason: "verified-for-current-key" };
  });
  const mandatory = units.filter((unit) => unit.status !== "excluded");
  const passedCount = mandatory.filter((unit) => unit.status === "passed").length;
  if (!manifest.units.some((unit) => unit.kind === "spawn-access" && !exclusions.has(unit.id))) reasons.push("spawn-access-case-required");
  if (passedCount !== mandatory.length) reasons.push("mandatory-coverage-incomplete");
  return Object.freeze({ ready: reasons.length === 0, candidateCount: units.length, mandatoryCount: mandatory.length,
    passedCount, closedCount: 0, units: Object.freeze(units.map((unit) => Object.freeze(unit))), reasons: Object.freeze(reasons) });
}
