/** Bounded rectangle proposals on a real face; never an invented block or model door. */
import { DetMath as Math } from "../detMath";
import type { CityBlock, Vec2 } from "../cityLayout";
import { inspectBlockPlacement, type BlockPlacementInput, type BlockPlacementResult } from "./blockPlacement";

export const BLOCK_LOT_CANDIDATE_CONFIG = { version: 1, maxCandidates: 30, maxCentres: 5,
  extentScales: [0.9, 0.75, 0.6, 0.45, 0.3] as readonly number[] };
/** One cumulative sampler ceiling for layout consumers; not a road-search or whole-plan budget. */
export const LAYOUT_PLACEMENT_WORK_CONFIG = { version: 1, terrainSampleBudget: 500000 };
export type BlockLotCandidateInput = {
  block: Pick<CityBlock, "x" | "z" | "polygon" | "holes" | "parcels">;
  environment: Omit<BlockPlacementInput, "block" | "footprint">;
  minimumSize: { width: number; depth: number }; candidateLimit: number;
};
type Footprint = BlockPlacementInput["footprint"];
type Coverage = { availableCentres: number; selectedCentres: number; unselectedCentres: number;
  generatedCandidates: number; attempted: number; remainingCandidates: number; terrainSamples: number;
  terrainSampleBudget: number; belowMinimumCentres: number; rejectionReasons: Record<string, number> };
export type BlockLotCandidateResult = { ok: true; footprint: Footprint; evidence: BlockPlacementResult; coverage: Coverage }
  | { ok: false; reason: string; coverage: Coverage };

/** Project actual boundary vertices to the existing parcel yaw, propose inset
 * rectangles, and let the shared face/hole/capsule/terrain checker decide.
 * The projected extent is only a search bound, never containment evidence. */
export function findBlockLotCandidate(input: BlockLotCandidateInput): BlockLotCandidateResult {
  const { block, environment, minimumSize, candidateLimit } = input;
  const budget = environment.terrainSampleBudget ?? Number.MAX_SAFE_INTEGER;
  const coverage: Coverage = { availableCentres: 0, selectedCentres: 0, unselectedCentres: 0,
    generatedCandidates: 0, attempted: 0, remainingCandidates: 0, terrainSamples: 0,
    terrainSampleBudget: budget, belowMinimumCentres: 0, rejectionReasons: {} };
  const failed = (reason: string): BlockLotCandidateResult => ({ ok: false, reason, coverage });
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit <= 0 || candidateLimit > BLOCK_LOT_CANDIDATE_CONFIG.maxCandidates
    || !Number.isSafeInteger(budget) || budget < 0
    || ![minimumSize.width, minimumSize.depth].every(Number.isFinite) || minimumSize.width <= 0 || minimumSize.depth <= 0) return failed("invalid-candidate-or-terrain-budget-or-minimum-size");
  if (environment.cancelled?.()) return failed("cancelled");
  const yaw = block.parcels[0]?.yaw;
  if (!Number.isFinite(yaw)) return failed("unsupported-missing-parcel-orientation");
  if (block.polygon.length < 3 || block.polygon.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.z))
    || !Number.isFinite(block.x) || !Number.isFinite(block.z)
    || block.parcels.some((parcel) => !Number.isFinite(parcel.x) || !Number.isFinite(parcel.z))) return failed("invalid-real-face-or-centre");
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const project = (point: Vec2) => ({ x: c * point.x - s * point.z, z: s * point.x + c * point.z });
  const boundary = block.polygon.map(project);
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const point of boundary) {
    bounds.minX = Math.min(bounds.minX, point.x); bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minZ = Math.min(bounds.minZ, point.z); bounds.maxZ = Math.max(bounds.maxZ, point.z);
  }
  const unique = new Map<string, Vec2>();
  const add = (point: Vec2) => { const id = `${point.x}:${point.z}`; if (!unique.has(id)) unique.set(id, { x: point.x, z: point.z }); };
  add(block);
  for (const parcel of [...block.parcels].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.x - b.x || a.z - b.z)) add(parcel);
  const centres = [...unique.values()];
  coverage.availableCentres = centres.length;
  const selected = centres.slice(0, BLOCK_LOT_CANDIDATE_CONFIG.maxCentres);
  coverage.selectedCentres = selected.length; coverage.unselectedCentres = centres.length - selected.length;
  const candidates: Footprint[] = [], seen = new Set<string>();
  for (const centre of selected) {
    const local = project(centre);
    const width = 2 * Math.min(local.x - bounds.minX, bounds.maxX - local.x);
    const depth = 2 * Math.min(local.z - bounds.minZ, bounds.maxZ - local.z);
    if (width < minimumSize.width || depth < minimumSize.depth) { coverage.belowMinimumCentres += 1; continue; }
    for (const scale of [...BLOCK_LOT_CANDIDATE_CONFIG.extentScales, 0]) {
      const footprint = { ...centre, yaw,
        width: Math.max(minimumSize.width, Math.floor(width * scale * 100) / 100),
        depth: Math.max(minimumSize.depth, Math.floor(depth * scale * 100) / 100) };
      const id = `${footprint.x}:${footprint.z}:${footprint.width}:${footprint.depth}`;
      if (!seen.has(id) && candidates.length < candidateLimit) { candidates.push(footprint); seen.add(id); }
    }
  }
  coverage.generatedCandidates = candidates.length; coverage.remainingCandidates = candidates.length;
  for (const footprint of candidates) {
    if (environment.cancelled?.()) return failed("cancelled");
    const evidence = inspectBlockPlacement({ ...environment, block, footprint,
      terrainSampleBudget: budget - coverage.terrainSamples });
    coverage.attempted += 1; coverage.remainingCandidates -= 1; coverage.terrainSamples += evidence.terrainSamples;
    if (evidence.reason === "cancelled" || evidence.reason === "terrain-sample-budget-exhausted") return failed(evidence.reason);
    if (environment.cancelled?.()) return failed("cancelled");
    if (evidence.ok) return { ok: true, footprint, evidence, coverage };
    const reason = evidence.reason ?? "placement-rejected";
    coverage.rejectionReasons[reason] = (coverage.rejectionReasons[reason] ?? 0) + 1;
  }
  return failed("candidate-exhausted-not-a-proof-of-infeasibility");
}
