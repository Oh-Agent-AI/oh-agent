import { groundPieceTriangles, type CompiledGroundRoadSurface } from "./groundRoadCompiler";
import { extractMeshBoundaries, DEFAULT_BOUNDARY_BUDGET, type BoundaryBudget } from "./meshBoundaries";
import type { CompiledCitySurface, SurfaceCompileIssue, SurfacePatch } from "./types";

/** Adapts A1 geometry into owned patch buffers, WITHOUT claiming a union, portals
 * or road eligibility. A closed per-piece loop is not a legal driving corridor. */
export function buildGroundSurfaceSnapshot(compiled: CompiledGroundRoadSurface,
  budget: BoundaryBudget = DEFAULT_BOUNDARY_BUDGET): CompiledCitySurface {
  const issues: SurfaceCompileIssue[] = [];
  const patches: SurfacePatch[] = compiled.pieces.map((piece) => {
    const { positions, indices } = groundPieceTriangles(compiled, piece);
    const boundary = extractMeshBoundaries(positions, indices, budget);
    if (boundary.status !== "complete") issues.push({ source: piece.source,
      reason: boundary.reason === "budget" ? "budget" : boundary.reason === "degenerate" ? "degenerate" : "open-boundary",
      detail: boundary.reason === "none" ? undefined : boundary.reason });
    return Object.freeze({ id: piece.id, kind: piece.kind, layerId: "ground", source: Object.freeze({ kind: piece.source.kind, id: piece.source.id }),
      vertices: positions, indices, boundaryLoops: boundary.loops });
  });
  for (const reason of compiled.unresolved) issues.push({ source: { kind: "structure", id: reason }, reason: "unsupported" });
  let candidateLength = 0;
  for (const edge of compiled.input.roadEdges) for (let i = 1; i < edge.points.length; i++) {
    candidateLength += Math.hypot(edge.points[i].x - edge.points[i - 1].x, edge.points[i].z - edge.points[i - 1].z);
  }
  return Object.freeze({ revision: "unpublished", geometryVersion: 1, patches: Object.freeze(patches), portals: Object.freeze([]),
    renderBatches: Object.freeze(compiled.layers.map((layer, i) => Object.freeze({
      materialKey: `ground-layer-${i}`, patchIds: Object.freeze(compiled.pieces.filter((piece) => piece.layer === i).map((piece) => piece.id)),
      positions: new Float32Array(layer.positions), indices: new Uint32Array(layer.index),
    }))),
    report: Object.freeze({ candidateLength, geometricallyEligibleLength: 0, issues: Object.freeze(issues) }) });
}
