/** CPU-only contracts. Buffers are owned by SurfaceStore, never mutated by consumers. */
export type Vec2 = Readonly<{ x: number; z: number }>;
export type Vec3 = Readonly<{ x: number; y: number; z: number }>;
export type SurfaceKind = "carriageway" | "junction" | "bridge-deck" | "ramp" | "expressway-deck" | "sidewalk" | "island" | "decor";
export type SurfaceSource = Readonly<{ kind: "road" | "junction" | "structure"; id: string }>;
export type BoundaryLoop = Readonly<{
  hole: boolean;
  vertices: readonly Vec2[];
  segments: readonly ("driveable" | "curb" | "closed")[];
}>;
export type SurfacePatch = Readonly<{
  id: string; kind: SurfaceKind; layerId: string;
  vertices: Float32Array; indices: Uint32Array;
  boundaryLoops: readonly BoundaryLoop[]; source: SurfaceSource;
}>;
export type BoundarySpan = Readonly<{ loop: number; firstSegment: number; segmentCount: number }>;
export type SurfacePortal = Readonly<{
  id: string; fromPatch: string; toPatch: string;
  fromBoundary: BoundarySpan; toBoundary: BoundarySpan;
  permittedDirection: "both" | "forward";
  clearance: number; maxHeightMismatch: number;
  /** Geometric continuity only; never means a completed driving audit. */
  validated: boolean;
}>;
export type SurfaceCompileIssue = Readonly<{
  source: SurfaceSource; reason: "unsupported" | "degenerate" | "open-boundary" | "height-gap" | "budget";
  detail?: "empty" | "invalid-mesh" | "degenerate" | "non-manifold" | "intersection" | "budget";
}>;
export type SurfaceCompileReport = Readonly<{
  candidateLength: number; geometricallyEligibleLength: number;
  issues: readonly SurfaceCompileIssue[];
}>;
export type RoadRenderBatch = Readonly<{
  patchIds: readonly string[]; positions: Float32Array; indices: Uint32Array;
  /** Opaque names resolved by rendering code, not THREE material objects. */
  materialKey: string;
}>;
export type CompiledCitySurface = Readonly<{
  revision: string; geometryVersion: number;
  patches: readonly SurfacePatch[]; portals: readonly SurfacePortal[];
  renderBatches: readonly RoadRenderBatch[]; report: SurfaceCompileReport;
}>;
