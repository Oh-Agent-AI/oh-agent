/** Deterministic samples of a bounded gyroid level set for the porous organism.
 * The three periodic channels remain open; this is a visual surface, not a collider.
 */
export function samplePorousGyroid(resolution = 32): Float32Array {
  const n = Math.max(12, Math.min(48, Math.floor(resolution)));
  const result: number[] = [];
  const extent = 3.15;
  const field = (x: number, y: number, z: number) => {
    const k = 1.25;
    return Math.sin(k*x)*Math.cos(k*y) + Math.sin(k*y)*Math.cos(k*z) + Math.sin(k*z)*Math.cos(k*x);
  };
  // Intersections on lattice edges approximate the zero isosurface without
  // filling its channels. A spherical envelope keeps the silhouette bounded.
  const step = 2 * extent / n;
  for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) for (let z = 0; z <= n; z++) {
    const a = -extent + x*step, b = -extent + y*step, c = -extent + z*step;
    const f = field(a,b,c);
    for (const [dx,dy,dz] of [[1,0,0],[0,1,0],[0,0,1]] as const) {
      if (x+dx > n || y+dy > n || z+dz > n) continue;
      const g = field(a+dx*step,b+dy*step,c+dz*step);
      if ((f < 0) === (g < 0) || f === g) continue;
      const t = f / (f-g), px = a+dx*step*t, py = b+dy*step*t, pz = c+dz*step*t;
      if (px*px + py*py + pz*pz <= extent*extent) result.push(px,py,pz);
    }
  }
  return new Float32Array(result);
}
