/** CPU-only transport of exact current architectural render meshes. */
export type RenderedSolidRole = "building" | "landmark" | "civic" | "context" | "massing";
export type RenderedSolid = Readonly<{
  id: string; role: RenderedSolidRole;
  positions: Float32Array; indices: Uint32Array;
  /** Column-major matrices, one per rendered instance; already includes matrixWorld. */
  transforms: Float64Array;
}>;
export type RenderedSolidSource = Readonly<{ solids: readonly RenderedSolid[]; isCurrent: () => boolean; verifyCurrent?: () => boolean }>;
export const RENDERED_SOLID_LIMITS = Object.freeze({ meshes: 20000, vertices: 1000000, instances: 100000, bytes: 32 * 1024 * 1024 });
export function assertRenderedSolidBudget(solids: readonly RenderedSolid[]): void {
  let vertices = 0, instances = 0, bytes = 0;
  if (solids.length > RENDERED_SOLID_LIMITS.meshes) throw new Error("rendered-solids-budget");
  for (const s of solids) {
    vertices += s.positions.length / 3; instances += s.transforms.length / 16;
    bytes += s.positions.byteLength + s.indices.byteLength + s.transforms.byteLength;
    if (vertices > RENDERED_SOLID_LIMITS.vertices || instances > RENDERED_SOLID_LIMITS.instances || bytes > RENDERED_SOLID_LIMITS.bytes) throw new Error("rendered-solids-budget");
  }
}
export function copyRenderedSolids(solids: readonly RenderedSolid[]): readonly RenderedSolid[] {
  assertRenderedSolidBudget(solids);
  return Object.freeze(solids.map((s) => Object.freeze({ ...s, positions: s.positions.slice(), indices: s.indices.slice(), transforms: s.transforms.slice() })));
}
