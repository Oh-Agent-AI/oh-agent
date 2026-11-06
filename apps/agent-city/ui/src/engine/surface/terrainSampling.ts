/** Pure CPU sampler for the actual rendered terrain triangulation. */
import type { CityLayout } from "../cityLayout";

/** 地形网格分段数（PlaneGeometry extent×extent，segments²格）。路面网格（roadSurfaceSystem）按同一份三角剖分取高度。 */
export const TERRAIN_SEGMENTS = 384;

/** 地形网格顶点高度表（按 terrain 对象缓存）：路面网格建网要查几十万次高度，逐次算噪声场是秒级开销。 */
const vertexHeightCache = new WeakMap<object, { extent: number; heights: Float64Array }>();
function terrainVertexHeights(layout: Pick<CityLayout, "extent" | "terrain">): Float64Array {
  const cached = vertexHeightCache.get(layout.terrain);
  if (cached && cached.extent === layout.extent) return cached.heights;
  const n = TERRAIN_SEGMENTS + 1; const cell = layout.extent / TERRAIN_SEGMENTS;
  const heights = new Float64Array(n * n);
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) heights[j * n + i] = layout.terrain.height(-layout.extent / 2 + i * cell, -layout.extent / 2 + j * cell);
  vertexHeightCache.set(layout.terrain, { extent: layout.extent, heights });
  return heights;
}
/** 渲染出来的地形表面高度：不是 terrain.height 的真值，而是 PlaneGeometry 三角形上的线性插值——
 *  贴在地面上的网格（路面）若按真值取高，在格内凸处会钻进地形里（格宽 extent/TERRAIN_SEGMENTS）。
 *  三角剖分与 PlaneGeometry 一致：每格 (a,b,d)/(b,c,d)，对角线连 (ix, iy+1)–(ix+1, iy)；rotateX(−π/2) 后行号沿 +z 增长。 */
export function terrainSurfaceHeight(layout: Pick<CityLayout, "extent" | "terrain">, x: number, z: number): number {
  const cell = layout.extent / TERRAIN_SEGMENTS;
  const gx = Math.min(TERRAIN_SEGMENTS - 1e-9, Math.max(0, (x + layout.extent / 2) / cell));
  const gz = Math.min(TERRAIN_SEGMENTS - 1e-9, Math.max(0, (z + layout.extent / 2) / cell));
  const ix = Math.floor(gx); const iz = Math.floor(gz);
  const fx = gx - ix; const fz = gz - iz;
  const grid = terrainVertexHeights(layout);
  const at = (i: number, j: number) => grid[j * (TERRAIN_SEGMENTS + 1) + i];
  if (fx + fz <= 1) {
    const ha = at(ix, iz);
    return ha + (at(ix + 1, iz) - ha) * fx + (at(ix, iz + 1) - ha) * fz;
  }
  const hc = at(ix + 1, iz + 1);
  return hc + (at(ix, iz + 1) - hc) * (1 - fx) + (at(ix + 1, iz) - hc) * (1 - fz);
}
