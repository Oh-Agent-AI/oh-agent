import type { CityLayout } from "../engine/cityLayout";
import { assertGroundRoadSurfaceMatches, groundPieceTriangles, type CompiledGroundRoadSurface } from "../engine/surface/groundRoadCompiler";
import { buildSurfaceIndex, type SurfaceIndexBuild } from "../engine/surface/SurfaceIndex";
import { terrainSurfaceHeight } from "../engine/surface/terrainSampling";
import type { CompiledCitySurface, SurfacePatch } from "../engine/surface/types";

export function buildAssaultRoadIndex(ground: CompiledGroundRoadSurface): SurfaceIndexBuild {
  const patches: SurfacePatch[] = ground.pieces.map((piece) => {
    const { positions, indices } = groundPieceTriangles(ground, piece);
    return { id: piece.id, kind: piece.kind, layerId: "ground", source: { kind: piece.source.kind, id: piece.source.id }, vertices: positions, indices, boundaryLoops: [] };
  });
  const snapshot: CompiledCitySurface = { revision: "assault-ground", geometryVersion: 1, patches, portals: [], renderBatches: [], report: { candidateLength: 0, geometricallyEligibleLength: 0, issues: [] } };
  return buildSurfaceIndex(snapshot);
}

export function createAssaultCityGround(
  layout: Pick<CityLayout, "extent" | "terrain" | "roadEdges">,
  ground: CompiledGroundRoadSurface,
  isCurrent: () => boolean = () => true,
): (x: number, z: number) => number {
  if (!isCurrent()) throw new Error("Assault ground source is stale");
  assertGroundRoadSurfaceMatches(ground, layout);
  const index = buildAssaultRoadIndex(ground);
  if (index.status !== "ready") throw new Error(`Assault road index unavailable: ${index.reason}`);
  return (x, z) => {
    if (!isCurrent()) throw new Error("Assault ground source is stale");
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error("invalid Assault ground coordinate");
    const terrain = terrainSurfaceHeight(layout, x, z);
    const road = index.query({ x, z, layerId: "ground", kinds: ["carriageway", "junction", "sidewalk"] });
    if (road.status === "miss") return terrain;
    if (road.status === "hit") return Math.max(terrain, road.hit.point.y);
    if (road.status === "ambiguous") return Math.max(terrain, ...road.candidates.map((candidate) => candidate.point.y));
    throw new Error(`Assault ground query failed: ${road.status}`);
  };
}
