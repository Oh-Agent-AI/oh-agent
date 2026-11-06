/** Decorative overview light pools follow the exact rendered terrain, not a
 * tangent plane of the procedural height function. No collision geometry. */
import type { CityLayout } from "../cityLayout";
import type { StreetLampPlan } from "./nightLighting";
import { ROAD_SURFACE_LIFT } from "../surface/groundRoadCompiler";
import { clipConvexToTerrain, terrainFit } from "../surface/terrainClip";

export const STREET_POOL_LIFT = ROAD_SURFACE_LIFT + 0.08;
export function streetLightPoolGeometry(layout: Pick<CityLayout,"terrain"|"extent">, plan: readonly StreetLampPlan[]) {
  const fit = terrainFit(layout, STREET_POOL_LIFT);
  const positions:number[] = [], uvs:number[] = [], colors:number[] = [], indices:number[] = [];
  for (const lamp of plan) {
    const radius = lamp.poolRadius * (0.6 + 0.4 * lamp.tier);
    const cx = lamp.x - lamp.nx * lamp.poolReach, cz = lamp.z - lamp.nz * lamp.poolReach;
    const corners = Array.from({length:14}, (_,i) => ({x:cx+radius*Math.cos(i*Math.PI/7),z:cz+radius*Math.sin(i*Math.PI/7)}));
    // Elevated receivers stay on their deck; never sample terrain underneath.
    const pieces = lamp.flat ? [corners] : clipConvexToTerrain(fit.grid,corners);
    const vertices = new Map<object,number>();
    const vertex = (p:{x:number;z:number}) => {
      let index = vertices.get(p);
      if (index !== undefined) return index;
      index = positions.length/3; vertices.set(p,index);
      positions.push(p.x,lamp.flat ? lamp.base+0.12 : fit.heightAt(p.x,p.z),p.z);
      uvs.push((p.x-cx)/(2*radius)+0.5,(p.z-cz)/(2*radius)+0.5);
      const brightness = 0.4+0.6*lamp.tier; colors.push(brightness,brightness,brightness);
      return index;
    };
    for (const piece of pieces) for (let i=1;i+1<piece.length;i++) {
      const a=piece[0],b=piece[i],c=piece[i+1];
      const area=(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
      if (Math.abs(area)<1e-10) continue;
      // XZ counterclockwise faces downward in XYZ; keep upward-facing winding.
      indices.push(vertex(a),vertex(area>0?c:b),vertex(area>0?b:c));
    }
  }
  return {positions:new Float32Array(positions),uvs:new Float32Array(uvs),colors:new Float32Array(colors),indices:new Uint32Array(indices)};
}
