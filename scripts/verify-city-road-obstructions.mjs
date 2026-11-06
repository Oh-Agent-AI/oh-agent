#!/usr/bin/env node
// Actual rendered Miami scenes; diagnostic witnesses do not release any road.
import assert from 'node:assert/strict';
import {sceneKit,buildParts} from './city-kit/scene-parts.mjs';
const k=await sceneKit({'engine/surface/citySurfacePort.ts':['CitySurfacePort'],'engine/surface/SurfaceIndex.ts':['buildSurfaceIndex'],'engine/surface/surfaceRegions.ts':['buildSurfaceRegions'],'game/driving/citySolids.ts':['cityCollisionIndex','solidsOnRoad']});
const totals={};
for(const sessions of [0,90,500])for(const seed of [1,7,42,2026,65537]){
 const {parts}=buildParts(k,sessions,seed);let lease;
 try{
  lease=parts.acquireDrivingWorldSource();const cap=await new k.CitySurfacePort().capture(lease.source);assert.equal(cap.status,'ready');
  const c=cap.readWorld(),r=k.buildSurfaceRegions(c.surface,k.buildSurfaceIndex(c.surface));assert.equal(r.status,'ready');
  const index=k.cityCollisionIndex(c.obstacles,c.sceneSolids),hits=k.solidsOnRoad(r,index);
  for(const h of hits)totals[h.role]=(totals[h.role]??0)+1;
  console.log(`${sessions}/${seed}: ${JSON.stringify(hits)}`);
  assert.deepEqual(hits,[],`${sessions}/${seed}: scenery obstructs road`);
 }finally{lease?.release();parts.dispose();}
}
console.log(`Rendered road obstruction witnesses: ${JSON.stringify(totals)}`);
