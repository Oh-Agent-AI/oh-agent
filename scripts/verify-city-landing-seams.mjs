#!/usr/bin/env node
// Full-width deck seam checks: gaps/islands away from centre and finite interval proof.
import assert from "node:assert/strict";
import { loadCity, cachedPlan } from "./city-kit/index.mjs";
const { checkLandingSeams }=await loadCity({"engine/surface/landingSeams.ts":["checkLandingSeams"]});
const rect=(id,x0,x1,z0,z1,height=()=>0,kind="carriageway",layerId="ground")=>{
  const ring=[{x:x0,z:z0},{x:x1,z:z0},{x:x1,z:z1},{x:x0,z:z1}];
  return {id,kind,layerId,source:{kind:"structure",id},vertices:new Float32Array(ring.flatMap((p)=>[p.x,height(p.z),p.z])),indices:new Uint32Array([0,2,1,0,3,2]),
    boundaryLoops:[{hole:false,vertices:ring,segments:["closed","closed","closed","closed"]}]};
};
const road=()=>rect("road",-4,0,-2,2);
const fixture=(ground=[road()],layerId="ground")=>{
  const deck=rect("deck",0,4,-2,2,()=>0,"bridge-deck",layerId);
  return {revision:"world-fixture",surface:{revision:"surface-fixture",geometryVersion:3,patches:[deck,...ground],portals:[],renderBatches:[],report:{candidateLength:0,geometricallyEligibleLength:0,issues:[]}},
    landings:[{structureId:"deck",end:"from",patchId:"deck",layerId,x:0,z:0,outX:-1,outZ:0,deckY:0,groundY:0,step:0,status:"aligned",seam:{a:{x:0,y:0,z:-2},b:{x:0,y:0,z:2}}}]};
};
const options={maxStep:0.1,maxSlopeChange:0.3,aliasTolerance:0.1};
const run=(input,opts=options)=>checkLandingSeams(input,opts);
const straight=run(fixture());assert.equal(straight.status,"complete");assert.equal(straight.seams[0].status,"continuous");assert.equal(straight.seams[0].continuousSpans[0].width,4);
for(let k=1;k<=20;k++) {
  const input=fixture(),angle=k*0.173,c=Math.cos(angle),s=Math.sin(angle);
  const rotate=(x,z)=>({x:Math.fround(245.23+c*x-s*z),z:Math.fround(-129.56+s*x+c*z)});
  for(const patch of input.surface.patches) {
    for(let i=0;i<patch.vertices.length;i+=3){const p=rotate(patch.vertices[i],patch.vertices[i+2]);patch.vertices[i]=p.x;patch.vertices[i+2]=p.z;}
    for(const loop of patch.boundaryLoops)loop.vertices=loop.vertices.map((p)=>rotate(p.x,p.z));
  }
  const seam=input.landings[0].seam;
  for(const p of [seam.a,seam.b])Object.assign(p,rotate(p.x,p.z));
  const checked=run(input);
  assert.equal(checked.status,"complete",`rotated shared Float32 edge ${k}: ${checked.reason}`);
  assert.equal(checked.seams[0].status,"continuous",`rotated shared edge ${k}`);
}
const hole=run(fixture([rect("left",-4,0,-2,0.7),rect("right",-4,0,0.75,2)]));
assert.equal(hole.seams[0].status,"blocked");assert.ok(hole.seams[0].intervals.some((i)=>i.reason==="no-ground"),"5cm gap away from centre/endpoints must be found");
const tinyGap=run(fixture([rect("tiny-left",-4,0,-2,0.7),rect("tiny-right",-4,0,0.7000001,2)]));
assert.equal(tinyGap.status,"complete");
assert.ok(tinyGap.seams[0].intervals.some((i)=>i.reason==="no-ground"),"a Float32 representable gap must not be snapped away");
const island=run(fixture([road(),rect("island",-0.1,0.1,0.71,0.72,()=>0.2,"island")]));
assert.ok(island.seams[0].intervals.some((i)=>i.reason==="island"),"1cm island must split the seam");
const crossSlope=fixture([rect("slope",-4,0,-2,2,(z)=>z*0.2)]);
assert.ok(run(crossSlope).seams[0].intervals.some((i)=>i.reason==="height-gap"),"matching centre height must not hide raised edge");
assert.ok(run(crossSlope,{...options,maxStep:1,maxSlopeChange:0.1}).seams[0].intervals.some((i)=>i.reason==="slope-change"));
const aliases=run(fixture([road(),rect("upper",-4,0,-2,2,()=>0.3)]));
assert.ok(aliases.seams[0].intervals.some((i)=>i.reason==="ambiguous-ground"));
const layered=fixture([road()],"bridge:upper");const portal=run(layered);
assert.equal(portal.seams[0].status,"continuous");assert.equal(portal.seams[0].portalRequired,true);assert.equal(layered.surface.portals.length,0,"continuity evidence never implicitly opens a layer portal");
const unresolved=fixture();unresolved.surface.patches[1].boundaryLoops=[];
assert.equal(run(unresolved).status,"unresolved");
const wrongEdge=fixture();wrongEdge.landings[0].seam.a.x=0.01;
assert.equal(run(wrongEdge).reason,"invalid-input","seam must be an actual top-face boundary edge");
assert.equal(run(fixture(),{...options,maxTests:1}).reason,"budget");
assert.equal(run(fixture(),{...options,maxStep:NaN}).reason,"invalid-input");
console.log("Landing seams: whole-width coverage, narrow gap/island, edge height and slope, overlapping heights, explicit cross-layer status, unresolved mesh and budgets passed.");
if(process.argv.includes("--cities")) {
  const {createCityPlan,compileCitySurface}=await loadCity({"engine/cityPlan.ts":["createCityPlan"],"engine/surface/compileSurface.ts":["compileCitySurface"]});
  for(const seed of [1,7,42,2026,65537])for(const tier of [1,2,3]) {
    const c=compileCitySurface(cachedPlan(createCityPlan,seed,tier));
    const report=run({...c,revision:`fixture:${seed}/${tier}`});
    assert.equal(report.status,"complete",`${seed}/${tier}: ${report.reason}`);
    console.log(`Landing seams ${seed}/${tier}: ${report.status}/${report.reason}, ${report.seams.filter((s)=>s.status==="continuous").length}/${c.landings.length} whole-width cross-sections continuous; ${report.tests} interval tests. No portal released.`);
  }
}
