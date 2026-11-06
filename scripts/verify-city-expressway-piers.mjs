#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity, cachedPlan } from "./city-kit/index.mjs";
const k = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/surface/structureCompiler.ts": ["expresswayPieces", "boxCorners"],
  "engine/surface/compileSurface.ts": ["compileCitySurface"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "game/driving/citySolids.ts": ["cityCollisionIndex", "solidsOnRoad"],
  "game/driving/DrivingCollision.ts": ["sweepBody"],
});
const road = (a, b, width = 8) => ({id: "underpass", from: "a", to: "b", points: [a,b], width, kind: "arterial"});
const dims = {halfLength: 1.5, halfWidth: 1.032, halfHeight: .575};
const pose = (x,z,heading) => ({x,y:.715,z,heading,pitch:0,roll:0});
for (const width of [8,12]) for (const angle of [0, Math.PI / 2, Math.PI / 4]) {
  const a = {x:-80*Math.cos(angle), z:-80*Math.sin(angle)}, b = {x:-a.x,z:-a.z};
  const layout = {extent:400, terrain:{height:()=>0}, highways:[[{x:-100,z:0},{x:100,z:0}]], roadEdges:[road(a,b,width)], bridges:[], landmarks:[], culDeSacEnds:[]};
  const parts = k.expresswayPieces(layout).filter(p=>p.role==="expressway-pier");
  assert.ok(parts.length >= 3 && parts.length % 3 === 0, "each support has two columns and a cap");
  for(let i=0;i<parts.length;i+=3) {
    assert.equal(parts[i].sz,1.1); assert.equal(parts[i+1].sz,1.1);
    assert.ok(parts[i+2].sz>9,"cap joins the separate columns");
  }
  const obstacles = parts.map((p,i)=>({id:`pier:${i}`,role:p.role,shape:"box",corners:k.boxCorners(p)}));
  const solids = k.cityCollisionIndex(obstacles).solids();
  assert.equal(k.sweepBody(solids,pose(a.x,a.z,angle),pose(b.x,b.z,angle),dims).status,"clear",`road angle ${angle}: full car must pass below the portal supports`);
  const c=parts[0];
  assert.equal(k.sweepBody(solids,pose(c.x,c.z,0),pose(c.x,c.z,0),dims).reason,"initial-overlap","columns remain physical collision solids");
}
console.log("Portal piers: separate colliding columns; full-car continuous sweeps clear parallel, perpendicular and diagonal roads.");
if (process.argv.includes("--cities")) {
  let count=0;
  for(const seed of [1,7,42,2026,65537]) for(const tier of [1,2,3]) {
    const plan=cachedPlan(k.createCityPlan,seed,tier), c=k.compileCitySurface(plan);
    const regions=k.buildSurfaceRegions(c.surface,k.buildSurfaceIndex(c.surface));assert.equal(regions.status,"ready");
    const piers=c.obstacles.filter(p=>p.role==="expressway-pier"),collision=k.cityCollisionIndex(piers);
    const onRoad=k.solidsOnRoad(regions,collision);
    assert.deepEqual(onRoad,[],`${seed}/${tier}: supports still occupy a drivable surface: ${JSON.stringify(onRoad)}`);
    count+=piers.length;console.log(`Portal piers ${seed}/${tier}: ${piers.length} physical boxes, none on drivable road.`);
  }
  console.log(`Portal piers: all 15 plans, ${count} collision boxes, zero road-obstructing piers.`);
}
if (process.argv.includes("--scenes")) {
  const {sceneKit,buildParts}=await import("./city-kit/scene-parts.mjs"),kit=await sceneKit();
  let count=0;
  for(const sessions of [0,90,500]) for(const seed of [1,7,42,2026,65537]) {
    const {parts,layout}=buildParts(kit,sessions,seed);
    try {
      const c=k.compileCitySurface(layout),regions=k.buildSurfaceRegions(c.surface,k.buildSurfaceIndex(c.surface));
      assert.equal(regions.status,"ready");
      const piers=c.obstacles.filter(p=>p.role==="expressway-pier");
      const onRoad=k.solidsOnRoad(regions,k.cityCollisionIndex(piers));
      assert.deepEqual(onRoad,[],`${sessions}/${seed}: rendered city piers obstruct a road: ${JSON.stringify(onRoad)}`);
      count+=piers.length;console.log(`Rendered portal piers ${sessions}/${seed}: ${piers.length} boxes, none on drivable road.`);
    } finally {parts.dispose();}
  }
  console.log(`Rendered portal piers: 15 Miami city scenes, ${count} collision boxes, zero road-obstructing piers.`);
}
