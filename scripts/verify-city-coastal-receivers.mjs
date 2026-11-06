#!/usr/bin/env node
import assert from 'node:assert/strict';

// Beach/road/bridgehead receiver ordering on curved rendered terrain. Sand
// used to sample the raw field at just four corners and sit above asphalt.
const {loadCity}=await import('./city-kit/index.mjs');
const beachKit=await loadCity({
 'pkg:three':['* as THREE'],
 'engine/systems/seasideSystem.ts':['buildBeachRibbon'],
 'engine/surface/terrainSampling.ts':['terrainSurfaceHeight'],
 'engine/surface/groundRoadCompiler.ts':['ROAD_SURFACE_LIFT'],
 'engine/surface/structureCompiler.ts':['bridgeDeckProfile'],
});
const beachLayout={extent:384,terrain:{height:(x,z)=>1+0.3*Math.sin(x*.65)+0.2*Math.cos(z*.8)},
 coast:[{x:-20,z:-20},{x:20,z:-20},{x:20,z:20},{x:-20,z:20}],publicSites:[],river:[],
 roadEdges:[{id:'bank',from:'-20:0',to:'-30:0',width:6,kind:'local',points:[{x:-20,z:0},{x:-30,z:0}]}]};
const beachHost={layout:beachLayout,group:new beachKit.THREE.Group(),disposables:[]};
beachKit.buildBeachRibbon(beachHost);
const beach=beachHost.group.getObjectByName('city-beach');assert.ok(beach);
const positions=beach.geometry.attributes.position.array;
for(let i=0;i<positions.length;i+=9){
 for(const weights of [[1/3,1/3,1/3],[.1,.4,.5]]){
  const [x,y,z]=[0,1,2].map(axis=>weights.reduce((sum,w,v)=>sum+w*positions[i+v*3+axis],0));
  const terrain=beachKit.terrainSurfaceHeight(beachLayout,x,z);
  assert.ok(Math.abs(y-terrain-beachKit.ROAD_SURFACE_LIFT/4)<1e-5,'beach interiors stay on the rendered terrain, without holes or raised wedges');
  assert.ok(terrain+beachKit.ROAD_SURFACE_LIFT-y>.029,'road receiver remains above sand at shoreline overlaps');
 }
}
const profile=beachKit.bridgeDeckProfile(beachLayout,{x:-20,z:0},{x:20,z:0},6);
assert.equal(profile.fromLands,true);
assert.ok(Math.abs(profile.ya-beachKit.terrainSurfaceHeight(beachLayout,-20,0)-beachKit.ROAD_SURFACE_LIFT)<1e-10,'landed bridge endpoint shares the road height reference');
for(const disposable of beachHost.disposables)disposable.dispose();
console.log('Coastal receivers: beach triangle interiors conform to rendered terrain; asphalt stays above sand; landed bridge shares asphalt height.');

const {gradeRoadLandings}=await loadCity({'engine/surface/roadLandingGrading.ts':['gradeRoadLandings']});
const raw={height:(x,z)=>x < -8 && x > -15 ? -.5 : .4+Math.min(1,Math.abs(x)/18),slope:()=>1/18,buildable:()=>true,center:{x:0,z:0},radius:100,hasRiver:true,coastRadius:()=>100};
const bank={id:'bank',from:'0:0',to:'40:0',width:8,kind:'local',points:[{x:0,z:0},{x:40,z:0}]};
const bridge={id:'bridge',from:'-20:0',to:'0:0',width:8,kind:'arterial',bridge:true,points:[{x:-20,z:0},{x:0,z:0}]};
const farBank={...bank,id:'far-bank',from:'-20:0',to:'-40:0',points:[{x:-20,z:0},{x:-40,z:0}]};
const roads=[bank,bridge,farBank],graded=gradeRoadLandings(raw,roads);
assert.notEqual(graded,raw);assert.equal(raw.height(0,0),.4,'cached geography is never mutated');
assert.ok(Math.abs(graded.height(0,0)-1.4)<1e-10,'bridgehead is raised to the dry approach anchor');
for(let x=0;x<=40;x+=.25){
 const h=graded.height(x,0);assert.ok(Math.abs(h-1.4)<1e-10,'no new dip between the landing pad and its uphill approach');
 assert.ok(h>=raw.height(x,0)&&h-raw.height(x,0)<=1.2+1e-10,'bounded fill, no excavation');
}
assert.equal(graded.height(-10,0),raw.height(-10,0),'water is not reclaimed');
const shallow={...raw,height:(x,z)=>x < -8 && x > -15?.3:raw.height(x,z)};
const shallowGraded=gradeRoadLandings(shallow,roads);
assert.equal(shallowGraded.height(-10,0),.3,'shallow positive-height water under the bridge is not reclaimed');
assert.equal(shallowGraded.height(0,0),graded.height(0,0),'protecting the channel preserves the abutment pad');
assert.equal(graded.height(0,60),raw.height(0,60),'remote terrain stays exact');
for(const delta of [-1e-5,1e-5])assert.ok(Math.abs(graded.height(0,30+delta)-raw.height(0,30+delta))<1e-8,'shoulder rejoins original terrain continuously');
assert.ok(Number.isFinite(graded.slope(0,0)));assert.ok(graded.slope(0,0)<1e-10,'the graded core is flat');
assert.equal(gradeRoadLandings(raw,roads),graded,'same source and roads reuse the terrain identity');
assert.equal(gradeRoadLandings(raw,[bank]),raw,'no bridge junction means no earthworks');
assert.equal(gradeRoadLandings(raw,[bank,bridge]),raw,'one-ended dead-end decks retain their original bank elevation');
const reversed=gradeRoadLandings(raw,[bridge,farBank,bank]);
for(const p of [[0,0],[10,3],[0,23],[0,31]])assert.equal(reversed.height(...p),graded.height(...p),'road ordering cannot change the earthworks');
const gradedLayout={...beachLayout,terrain:graded,roadEdges:roads};
const gradedDeck=beachKit.bridgeDeckProfile(gradedLayout,{x:0,z:0},{x:-20,z:0},8);
assert.ok(Math.abs(gradedDeck.ya-1.4-beachKit.ROAD_SURFACE_LIFT)<1e-10,'bridge deck consumes the same graded terrain as the road');
console.log('Landing grading: flat approach without transition dip, bounded fill, water/remote preservation, immutable cached source and shared deck height passed.');
