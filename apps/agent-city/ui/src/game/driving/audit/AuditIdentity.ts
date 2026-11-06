import type { AuditKey, AuditManifest, RoadAuditCase } from "./contracts";
import { validDrivingState } from "../DrivingKernel";
/** Explicit field order: never compare arbitrary object insertion order or seed alone. */
export function auditKeyId(key: AuditKey): string {
  const strings = [key.baseSnapshotHash, key.vehicleConfigHash, key.kernelBuildId, key.manifestHash];
  const versions = [key.surfaceVersion, key.queryVersion, key.snapshotCompilerVersion,
    key.physicsVersion, key.collisionVersion, key.controllerVersion, key.plannerVersion,
    key.observerVersion, key.releasePolicyVersion];
  if (strings.some((s) => typeof s !== "string" || !s.trim()) ||
      versions.some((n) => !Number.isSafeInteger(n) || n < 1) ||
      (key.releaseBoundaryHash !== null && (typeof key.releaseBoundaryHash !== "string" || !key.releaseBoundaryHash.trim()))) {
    throw new Error("invalid-audit-key");
  }
  return JSON.stringify([...strings, ...versions, key.releaseBoundaryHash]);
}
export const sameAuditKey = (a: AuditKey, b: AuditKey) => auditKeyId(a) === auditKeyId(b);
export function validateManifest(manifest: AuditManifest): void {
  auditKeyId(manifest.key);
  const units = new Set<string>(); const cases = new Set<string>(); const excluded = new Set<string>();
  for (const unit of manifest.units) {
    if (!unit.id.trim() || units.has(unit.id)) throw new Error("duplicate-or-empty-unit");
    units.add(unit.id);
  }
  if (!units.size) throw new Error("empty-audit-manifest");
  for (const exclusion of manifest.exclusions) {
    if (!units.has(exclusion.unitId) || excluded.has(exclusion.unitId) || !exclusion.reason.trim()) throw new Error("invalid-audit-exclusion");
    excluded.add(exclusion.unitId);
  }
  const covered = new Set<string>();
  for (const item of manifest.cases) {
    if (!item.id.trim() || cases.has(item.id) || !item.units.length || new Set(item.units).size !== item.units.length) throw new Error("invalid-audit-case");
    cases.add(item.id);
    if (!validDrivingState(item.start) || !Number.isSafeInteger(item.maxTicks) || item.maxTicks < 1 ||
        !Number.isSafeInteger(item.maxNoProgressTicks) || item.maxNoProgressTicks < 1 || item.maxNoProgressTicks > item.maxTicks || !item.gates.length) throw new Error("invalid-case-bounds");
    if (!item.corridor.surfaceSequence.length || item.corridor.surfaceSequence.some((id) => !id.trim()) ||
        item.corridor.portalSequence.some((id) => !id.trim()) || item.corridor.waypoints.length < 2 ||
        item.corridor.waypoints.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.z)) ||
        !Number.isFinite(item.policy.cruiseSpeed) || item.policy.cruiseSpeed <= 0 ||
        !Number.isFinite(item.policy.maxReverseSpeed) || item.policy.maxReverseSpeed < 0) throw new Error("invalid-audit-corridor-policy");
    const gates = new Set<string>();
    for (const gate of item.gates) {
      if (!gate.id.trim() || gates.has(gate.id) || ![gate.x, gate.y, gate.z, gate.forwardX, gate.forwardZ, gate.halfWidth, gate.heightTolerance].every(Number.isFinite) ||
          Math.abs(Math.hypot(gate.forwardX, gate.forwardZ) - 1) > 1e-6 || gate.halfWidth <= 0 || gate.heightTolerance <= 0 || !gate.surfaceIds.length || gate.surfaceIds.some((s) => !s.trim())) throw new Error("invalid-audit-gate");
      gates.add(gate.id);
    }
    for (const unit of item.units) {
      if (!units.has(unit) || excluded.has(unit)) throw new Error("unknown-or-excluded-case-unit");
      covered.add(unit);
    }
  }
  for (const unit of units) if (!excluded.has(unit) && !covered.has(unit)) throw new Error("unplanned-mandatory-unit");
  if (excluded.size === units.size) throw new Error("no-mandatory-units");
}

/** Canonical case identity for scheduler/factory matching; hashes themselves are
 * supplied by the future snapshot/manifest builders, never fabricated here. */
export function auditCaseId(test: RoadAuditCase): string {
  const s = test.start;
  return JSON.stringify([test.id, test.units, [s.x, s.y, s.z, s.heading, s.speed, s.steering,
    s.distance, s.braking, s.reversing, s.pitch, s.roll, s.surfaceId],
    test.gates.map((g) => [g.id, g.x, g.y, g.z, g.forwardX, g.forwardZ, g.halfWidth, g.heightTolerance, g.surfaceIds]),
    test.corridor.surfaceSequence, test.corridor.portalSequence, test.corridor.waypoints.map((p) => [p.x, p.z]),
    [test.policy.cruiseSpeed, test.policy.maxReverseSpeed], test.maxTicks, test.maxNoProgressTicks]);
}

export function freezeAuditCase(test: RoadAuditCase): RoadAuditCase {
  return Object.freeze({ ...test, units: Object.freeze([...test.units]), start: Object.freeze({ ...test.start }),
    gates: Object.freeze(test.gates.map((gate) => Object.freeze({ ...gate, surfaceIds: Object.freeze([...gate.surfaceIds]) }))),
    corridor: Object.freeze({ surfaceSequence: Object.freeze([...test.corridor.surfaceSequence]),
      portalSequence: Object.freeze([...test.corridor.portalSequence]),
      waypoints: Object.freeze(test.corridor.waypoints.map((point) => Object.freeze({ ...point }))) }),
    policy: Object.freeze({ ...test.policy }) });
}
