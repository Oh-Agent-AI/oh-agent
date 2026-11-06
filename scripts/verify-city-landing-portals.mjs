#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadCity } from "./city-kit/index.mjs";
const {SurfaceStore}=await loadCity({"engine/surface/SurfaceStore.ts":["SurfaceStore"]});
const {buildLandingPortals,DEFAULT_LANDING_PORTAL_OPTIONS}=await loadCity({"engine/surface/landingPortals.ts":["buildLandingPortals","DEFAULT_LANDING_PORTAL_OPTIONS"]});
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

const run=(input,options={})=>buildLandingPortals(input,{...DEFAULT_LANDING_PORTAL_OPTIONS,...options});
const shared=run(fixture([road()],"bridge:upper"));
assert.equal(shared.status,"ready");assert.equal(shared.surface.portals.length,1,JSON.stringify(shared.decisions));
const overlap=run(fixture([rect("road",-4,0.25,-2,2)],"bridge:upper"));
assert.equal(overlap.status,"ready");assert.equal(overlap.surface.portals.length,1,JSON.stringify(overlap.decisions));
const island=run(fixture([rect("road",-4,0.25,-2,2),rect("island",0.1,0.15,0.7,0.8,()=>0.2,"island")],"bridge:upper"));
assert.equal(island.status,"ready");assert.equal(island.surface.portals.length,0,"island inside ribbon away from seam must block portal");
const gap=run(fixture([rect("road",-4,-0.000001,-2,2)],"bridge:upper"));
assert.equal(gap.surface.portals.length,0,"small real gap must remain closed");
const narrow=run(fixture([rect("road",-4,0.25,-1,1)],"bridge:upper"));
assert.equal(narrow.surface.portals.length,0,"partial width must remain closed");
// Keep the seam flat, but introduce a steep grade inside the overlap ribbon.
const kinked=rect("road",-4,0.25,-2,2);
// Separate flat and sloping sections at x=0.1; both cover the entire width.
kinked.vertices=new Float32Array([-4,0,-2,0.1,0,-2,0.25,0.08,-2,-4,0,2,0.1,0,2,0.25,0.08,2]);
kinked.indices=new Uint32Array([0,4,1,0,3,4,1,5,2,1,4,5]);
const slope=run(fixture([kinked],"bridge:upper"),{maxStep:0.2,maxSlopeChange:0.3});
assert.equal(slope.status,"ready");assert.equal(slope.surface.portals.length,0);
assert.equal(slope.decisions[0].reason,"slope-change","interior slope change must be checked beyond the seam");
const budget=run(fixture([rect("road",-4,0.25,-2,2)],"bridge:upper"),{maxTests:1});
assert.equal(budget.status,"unresolved");assert.equal(budget.surface.portals.length,0);
const duplicate=run({...fixture([road()],"bridge:upper"),surface:shared.surface});
assert.equal(duplicate.reason,"invalid-input","existing generated portals cannot be duplicated");
assert.equal(run(fixture(),{maxStep:NaN}).reason,"invalid-input");
console.log("Landing portals: shared edge, overlap ribbon, interior island, real gap, narrow approach, budgets and duplicate publication passed.");

const store=new SurfaceStore(async bytes=>createHash("sha256").update(bytes).digest("hex"));
const publication=await store.publish(overlap.surface);
assert.equal(publication.status,"published");
assert.equal(store.read(publication.revision).portals.length,1,"generated spans satisfy published snapshot contract");

const clockwise=fixture([road()],"bridge:upper");
clockwise.surface.patches[1].boundaryLoops[0].vertices.reverse();
assert.equal(run(clockwise).surface.portals.length,1,"renderer clockwise boundary winding must be supported");

// A deck patch may contain multiple grades. The seam normal must come from its
// indexed adjacent face, regardless of where that triangle appears in the list.
// The first/remote face is flat, while the actual x=0 entry climbs 45 degrees.
for(const remoteFirst of [true,false]) {
  const nonplanar=fixture([road()],"bridge:upper");
  const deck=nonplanar.surface.patches[0];
  deck.vertices=new Float32Array([0,0,-2,0.1,0.1,-2,4,0.1,-2,0,0,2,0.1,0.1,2,4,0.1,2]);
  const remote=[1,5,2,1,4,5],entry=[0,4,1,0,3,4];
  deck.indices=new Uint32Array(remoteFirst?[...remote,...entry]:[...entry,...remote]);
  const checked=run(nonplanar,{maxSlopeChange:0.3});
  assert.equal(checked.status,"ready");
  assert.equal(checked.surface.portals.length,0,`local entry grade cannot use remote normal; remoteFirst=${remoteFirst}`);
  assert.equal(checked.decisions[0].reason,"seam-blocked");
}
