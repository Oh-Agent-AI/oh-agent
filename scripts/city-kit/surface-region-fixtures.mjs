// Synthetic surface patches for region/footprint guards. No session data or host bridge.
// Winding matches the compiler: SurfaceIndex accepts triangles whose XZ signed area is negative.
export function makeFixtures({ extractMeshBoundaries, buildSurfaceIndex, buildSurfaceRegions }) {
  /** Grid mesh over [x0,x1]×[z0,z1]; `keep(i,j)` drops cells (holes); `h(x,z)` heights. */
  const grid = (x0, z0, x1, z1, nx, nz, h = () => 0, keep = () => true) => {
    const positions = []; const indices = [];
    const id = (i, j) => j * (nx + 1) + i;
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + (x1 - x0) * i / nx; const z = z0 + (z1 - z0) * j / nz;
      positions.push(x, h(x, z), z);
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      if (!keep(i, j)) continue;
      const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
      indices.push(a, c, b, a, d, c);
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  };
  const patch = (id, kind, mesh, layerId = "ground", loops = true) => {
    const boundary = extractMeshBoundaries(mesh.positions, mesh.indices);
    return { id, kind, layerId, vertices: mesh.positions, indices: mesh.indices,
      boundaryLoops: loops && boundary.status === "complete" ? boundary.loops : [], source: { kind: "road", id } };
  };
  const snapshot = (patches, revision = "fixture-rev") => ({ revision, geometryVersion: 1, patches, portals: [], renderBatches: [],
    report: { candidateLength: 0, geometricallyEligibleLength: 0, issues: [] } });
  const regionsOf = (patches, params, indexBudget) => {
    const snap = snapshot(patches);
    const index = buildSurfaceIndex(snap, indexBudget);
    const regions = buildSurfaceRegions(snap, index, params);
    return { snap, index, regions };
  };
  return { grid, patch, snapshot, regionsOf };
}
