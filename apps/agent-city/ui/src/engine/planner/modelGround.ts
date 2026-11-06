/** Shared finite-sample ground admission. Never upgrades partial model facts into full physical proof. */
import { hashSeed } from "../../cityModel";
import { DetMath as Math } from "../detMath";
import { isPlanningInterrupted } from "./operationBudget";
import { pointInRegion, regionBounds, type LocalRegion } from "../models/physical";
import { GROUND_MODEL_FACTORIES, resolveGroundModel } from "../models/groundRegistry";
import { WATER_LEVEL } from "./footprint";

export const MODEL_GROUND_CONFIG = { version: 1, maxStep: 1, maxHeightQueries: 4096, planningDryLevel: WATER_LEVEL, rendererSeaLevel: -0.55 } as const;
export type GroundOwner = { readonly id: string; readonly kind: string; readonly x: number; readonly z: number; readonly yaw: number; readonly radius: number };
export type GroundGeo = { readonly height: (x: number, z: number) => number; readonly inRiver: (x: number, z: number) => boolean };
export type GroundWitness = { readonly at: { readonly x: number; readonly z: number }; readonly terrain: number; readonly supportY: number; readonly part: number };
export type GroundFinding = { readonly code: "foundation-water" | "foundation-gap" | "foundation-embed" | "foundation-relief";
  readonly witness: GroundWitness; readonly observed: number; readonly allowed: number };
export type GroundSampleEvidence = {
  readonly modelId: string; readonly modelRevision: string; readonly schemaVersion: number;
  readonly seed: number; readonly radius: number; readonly ownerX: number; readonly ownerZ: number; readonly ownerYaw: number;
  readonly baseY: number; readonly supportY: number;
  readonly maxStep: number; readonly heightQueryLimit: number; readonly heightQueries: number; readonly supportSamples: number;
  readonly belowPlanningDryLevel: number; readonly belowRendererSeaLevel: number; readonly inRiverSamples: number;
  readonly minTerrain: number; readonly maxTerrain: number; readonly maxGap: number; readonly maxEmbed: number;
  readonly coverage: "bounded-samples-only";
};
export type ModelGroundInspection =
  | { readonly status: "unsupported"; readonly ownerId: string; readonly reason: string;
      readonly reasonCode: "unregistered-model" | "unsupported-parameters" | "invalid-context" | "budget-exhausted";
      readonly heightQueries: number; readonly wholeModelReady: false }
  | { readonly status: "partial" | "violation"; readonly ownerId: string; readonly wholeModelReady: false;
      readonly evidence: GroundSampleEvidence; readonly findings: readonly GroundFinding[]; readonly missing: readonly string[] };

/** Undefined for unregistered legacy proxies means 'no registered ground gate', never physical readiness. */
export function registeredModelGroundFailure(owner: GroundOwner, geo: GroundGeo): string | undefined {
  if (!Object.hasOwn(GROUND_MODEL_FACTORIES, owner.kind)) return;
  const inspection = inspectModelGround(owner, geo);
  if (inspection.status === "unsupported") return `registered-model-ground-${inspection.reasonCode}: ${inspection.reason}`;
  if (inspection.status === "violation") return inspection.findings.map(finding => finding.code).join(",");
}

/** Bounded before any terrain query. Grid spacing is <=1 on each local axis;
 * curved/convex boundaries additionally have <=1 Euclidean step and are sampled explicitly.
 */
function supportSamples(parts: readonly LocalRegion[], limit: number): Array<{ x: number; z: number; part: number }> | undefined {
  const out: Array<{ x: number; z: number; part: number }> = [];
  let candidateChecks = 0;
  const add = (x: number, z: number, part: number) => { if (out.length >= limit) return false; out.push({ x, z, part }); return true; };
  for (let part = 0; part < parts.length; part += 1) {
    const region = parts[part], bounds = regionBounds(region);
    const nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / MODEL_GROUND_CONFIG.maxStep));
    const nz = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / MODEL_GROUND_CONFIG.maxStep));
    // Bound clipped candidate work too: a huge thin polygon cannot spin over an unbounded AABB.
    candidateChecks += (nx + 1) * (nz + 1);
    if (!Number.isSafeInteger(candidateChecks) || candidateChecks > limit) return;
    for (let ix = 0; ix <= nx; ix += 1) for (let iz = 0; iz <= nz; iz += 1) {
      const x = bounds.minX + (bounds.maxX - bounds.minX) * ix / nx;
      const z = bounds.minZ + (bounds.maxZ - bounds.minZ) * iz / nz;
      if (pointInRegion({ x, z }, region, 1e-9) && !add(x, z, part)) return;
    }
    if (region.shape === "circle") {
      const n = Math.max(4, Math.ceil(2 * Math.PI * region.radius / MODEL_GROUND_CONFIG.maxStep));
      if (n > limit - out.length) return;
      for (let i = 0; i < n; i += 1) if (!add(region.center.x + Math.cos(i * 2 * Math.PI / n) * region.radius,
        region.center.z + Math.sin(i * 2 * Math.PI / n) * region.radius, part)) return;
    } else if (region.shape === "convex") {
      for (let i = 0; i < region.vertices.length; i += 1) {
        const a = region.vertices[i], b = region.vertices[(i + 1) % region.vertices.length];
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / MODEL_GROUND_CONFIG.maxStep));
        if (n > limit - out.length) return;
        for (let k = 0; k < n; k += 1) if (!add(a.x + (b.x - a.x) * k / n, a.z + (b.z - a.z) * k / n, part)) return;
      }
    }
  }
  return out;
}

/** Read-only: unknown model, exhausted work or malformed terrain never becomes a safe placement. */
export function inspectModelGround(owner: GroundOwner, geo: GroundGeo, options: { readonly maxHeightQueries?: number } = {}): ModelGroundInspection {
  let heightQueries = 0;
  const unsupported = (reasonCode: Extract<ModelGroundInspection, { status: "unsupported" }>["reasonCode"], reason: string): ModelGroundInspection =>
    ({ status: "unsupported", ownerId: owner?.id ?? "", reasonCode, reason, heightQueries, wholeModelReady: false });
  if (!owner || !owner.id || !owner.kind || ![owner.x, owner.z, owner.yaw, owner.radius].every(Number.isFinite)
    || owner.radius < 0 || !geo || typeof geo.height !== "function" || typeof geo.inRiver !== "function")
    return unsupported("invalid-context", "invalid ground owner/terrain contract");
  const queryLimit = options.maxHeightQueries ?? MODEL_GROUND_CONFIG.maxHeightQueries;
  if (!Number.isSafeInteger(queryLimit) || queryLimit < 1 || queryLimit > MODEL_GROUND_CONFIG.maxHeightQueries)
    return unsupported("budget-exhausted", "ground sampling budget unavailable or outside declared bound");
  const seed = hashSeed(owner.id), resolved = resolveGroundModel(owner.kind, { seed, radius: owner.radius });
  if (resolved.status === "unsupported") return unsupported(resolved.reason.startsWith("ground declaration not registered") ? "unregistered-model" : "unsupported-parameters", resolved.reason);
  const declaration = resolved.declaration, foundation = declaration.foundation;
  if (foundation.kind !== "ground") return unsupported("unsupported-parameters", "ground inspector has no declared piles/floating admission policy");
  const samples = supportSamples(foundation.support.parts, queryLimit - 1);
  if (!samples || samples.length === 0) return unsupported("budget-exhausted", "ground support exceeds bounded sampling coverage");
  try {
    heightQueries += 1;
    const centreHeight = geo.height(owner.x, owner.z);
    if (!Number.isFinite(centreHeight)) return unsupported("invalid-context", "non-finite centre terrain height");
    const baseY = Math.max(0.3, centreHeight), supportY = baseY + foundation.baseOffset;
    const cos = Math.cos(owner.yaw), sin = Math.sin(owner.yaw), findings = new Map<GroundFinding["code"], GroundFinding>();
    let minTerrain = Infinity, maxTerrain = -Infinity, maxGap = 0, maxEmbed = 0, belowPlanningDryLevel = 0, belowRendererSeaLevel = 0, inRiverSamples = 0;
    let minWitness: GroundWitness | undefined;
    const finding = (code: GroundFinding["code"], witness: GroundWitness, observed: number, allowed: number) => {
      const prior = findings.get(code);
      if (!prior || observed > prior.observed) findings.set(code, { code, witness, observed, allowed });
    };
    for (const sample of samples) {
      const at = { x: owner.x + sample.x * cos + sample.z * sin, z: owner.z - sample.x * sin + sample.z * cos };
      heightQueries += 1;
      const terrain = geo.height(at.x, at.z), river = geo.inRiver(at.x, at.z);
      if (!Number.isFinite(terrain) || typeof river !== "boolean") return unsupported("invalid-context", "non-finite height or invalid river evidence");
      const witness = { at, terrain, supportY, part: sample.part };
      if (terrain < minTerrain) { minTerrain = terrain; minWitness = witness; }
      maxTerrain = Math.max(maxTerrain, terrain);
      const gap = Math.max(0, supportY - terrain), embed = Math.max(0, terrain - supportY);
      maxGap = Math.max(maxGap, gap); maxEmbed = Math.max(maxEmbed, embed);
      belowPlanningDryLevel += Number(terrain < MODEL_GROUND_CONFIG.planningDryLevel);
      belowRendererSeaLevel += Number(terrain < MODEL_GROUND_CONFIG.rendererSeaLevel); inRiverSamples += Number(river);
      if (terrain < MODEL_GROUND_CONFIG.planningDryLevel || river) finding("foundation-water", witness,
        river ? 1 : MODEL_GROUND_CONFIG.planningDryLevel - terrain, 0);
      if (gap > foundation.maxGap) finding("foundation-gap", witness, gap, foundation.maxGap);
      if (embed > foundation.maxEmbed) finding("foundation-embed", witness, embed, foundation.maxEmbed);
    }
    if (maxTerrain - minTerrain > foundation.maxRelief) finding("foundation-relief", minWitness!, maxTerrain - minTerrain, foundation.maxRelief);
    return { status: findings.size ? "violation" : "partial", ownerId: owner.id, wholeModelReady: false,
      evidence: { modelId: declaration.modelId, modelRevision: declaration.modelRevision, schemaVersion: declaration.schemaVersion,
        seed, radius: owner.radius, ownerX: owner.x, ownerZ: owner.z, ownerYaw: owner.yaw, baseY, supportY,
        maxStep: MODEL_GROUND_CONFIG.maxStep, heightQueryLimit: queryLimit, heightQueries, supportSamples: samples.length,
        belowPlanningDryLevel, belowRendererSeaLevel, inRiverSamples, minTerrain, maxTerrain, maxGap, maxEmbed, coverage: "bounded-samples-only" },
      findings: [...findings.values()], missing: [...resolved.missing, "continuous terrain support proof"] };
  } catch (error) { if (isPlanningInterrupted(error)) throw error; return unsupported("invalid-context", error instanceof Error ? error.message : "ground terrain inspection failed"); }
}
