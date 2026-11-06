import type { DrivingState, DrivingInputState } from "../../DrivingSimulation";
import type { KernelStep } from "../DrivingKernel";

/** Local-only identities; this is not a plugin protocol or an export schema. */
export type AuditKey = Readonly<{
  baseSnapshotHash: string; vehicleConfigHash: string; kernelBuildId: string;
  surfaceVersion: number; queryVersion: number; snapshotCompilerVersion: number;
  physicsVersion: number; collisionVersion: number; controllerVersion: number;
  plannerVersion: number; observerVersion: number; manifestHash: string;
  releasePolicyVersion: number; releaseBoundaryHash: string | null;
}>;
export type AuditUnitKind = "directed-edge" | "turn" | "structure-transition" | "spawn-access" | "recovery";
export type AuditUnit = Readonly<{ id: string; kind: AuditUnitKind }>;
export type DirectedGate = Readonly<{
  id: string; x: number; y: number; z: number;
  forwardX: number; forwardZ: number;
  halfWidth: number; heightTolerance: number;
  surfaceIds: readonly string[];
}>;
export type RoadAuditCase = Readonly<{
  id: string; units: readonly string[]; start: Readonly<DrivingState>;
  /** Ordered full-body exit gates. Not pilot waypoint indices. */
  gates: readonly DirectedGate[];
  corridor: Readonly<{
    surfaceSequence: readonly string[]; portalSequence: readonly string[];
    waypoints: readonly Readonly<{ x: number; z: number }>[];
  }>;
  policy: Readonly<{ cruiseSpeed: number; maxReverseSpeed: number }>;
  maxTicks: number; maxNoProgressTicks: number;
}>;
export type AuditManifest = Readonly<{
  key: AuditKey;
  /** Frozen candidate denominator. Deliberate exclusions remain visible. */
  units: readonly AuditUnit[];
  exclusions: readonly Readonly<{ unitId: string; reason: string }>[];
  cases: readonly RoadAuditCase[];
}>;
export type AuditVerdict = "passed" | "blocked" | "inconclusive";
export type AuditCause = "none" | "topology-disconnected" | "geometry-blocked" | "pilot-failed"
  | "simulation-invalid" | "route-deviation" | "budget-exhausted" | "cancelled" | "unconfirmed";
export type RoadAuditCaseResult = Readonly<{
  key: AuditKey; caseId: string; verdict: AuditVerdict; cause: AuditCause;
  coveredUnits: readonly string[]; simulatedTicks: number;
  /** Local bounded diagnostics, never a substitute for blocking evidence. No raw exception text. */
  diagnostic?: Readonly<{ stage: "kernel" | "observer"; reason: string; tick: number; x: number; y: number; z: number }>;

}>;
export type AuditRunState = "queued" | "running" | "complete" | "cancelled" | "stale";
/** Pilot receives immutable snapshots and returns buttons only. */
export interface RoutePilot {
  input(state: Readonly<DrivingState>, tick: number): Readonly<DrivingInputState>;
}
export type Observation = Readonly<{
  status: "continue" | "complete" | "route-deviation" | "simulation-invalid" | "budget-exhausted";
  /** Monotone legal corridor progress, not distance travelled or wheel spin. */
  progress: number;
  /** Planned stops only; cannot exempt a case from its global tick limit. */
  plannedStop: boolean;
}>;
export interface AuditObserver {
  begin(state: Readonly<DrivingState>): StepValidation;
  observe(previous: Readonly<DrivingState>, next: KernelStep, tick: number): Observation;
}
export type StaticUnitEvidence = Readonly<{
  key: AuditKey; unitId: string;
  topology: AuditVerdict; geometry: AuditVerdict;
  /** Required for blocked; a failed path search alone cannot provide a witness. */
  witness: string | null;
}>;
/** budget-exhausted: the kernel stopped a step because its collision query ran out of budget — the world was
 * not decided there, so the case is unconfirmed, not a simulation defect. */
export type StepValidation = "valid" | "route-deviation" | "simulation-invalid" | "budget-exhausted";
export interface AuditWorldValidator {
  validateStart(state: Readonly<DrivingState>): StepValidation;
  /** Independent corridor, layer, support and penetration validation. Mandatory. */
  validate(previous: Readonly<DrivingState>, next: KernelStep): StepValidation;
  progress(state: Readonly<DrivingState>): number;
}
