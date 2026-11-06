#!/usr/bin/env node
import assert from "node:assert/strict";
import {loadCity} from "./city-kit/index.mjs";
import {makeFixtures} from "./city-kit/surface-region-fixtures.mjs";
const k=await loadCity({
  "game/driving/CollisionIndex.ts":["buildCollisionIndex","boxPoly"],
  "game/driving/DrivingCollision.ts":["sweepBody"],
  "game/driving/DrivingCollisionSolver.ts":["resolveDrivingCollision"],
  "game/driving/ContinuousDrivingEnvironment.ts":["ContinuousDrivingEnvironment"],
  "game/driving/ContinuousWorldValidator.ts":["ContinuousWorldValidator"],
  "game/driving/createContinuousDrivingKernel.ts":["createContinuousDrivingKernel"],
  "game/DrivingSimulation.ts":["stepDriving","initialDrivingState","DRIVING_DT"],
  "game/driving/DrivingKernel.ts":["DrivingKernel"],
  "game/runtime/FixedStepClock.ts":["FixedStepClock"],
  "engine/surface/SurfaceIndex.ts":["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts":["buildSurfaceRegions"],
  "engine/surface/meshBoundaries.ts":["extractMeshBoundaries"],
  "game/driving/audit/RoadPassabilityAudit.ts":["CONTINUOUS_AUDIT_COLLIDER","CorridorPilot"],
  "game/driving/surfaceFootprint.ts":["footprintSupport"],
});
const box=(id,x,y,z,hx,hy,hz)=>({id,role:"test",kind:"box",center:{x,y,z},halfAxes:[{x:hx,y:0,z:0},{x:0,y:hy,z:0},{x:0,y:0,z:hz}]});
const solids=(...items)=>k.buildCollisionIndex(items).solids();
const pose=(x=0,z=0,heading=0)=>({x,y:1,z,heading,pitch:0,roll:0,surfaceId:"road"});
const dims={halfLength:0.5,halfHeight:0.4,halfWidth:0.3};
const close=(a,b,e=1e-6)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);
const wall=solids(box("thin",5,1,0,0.001,3,100));
const fast=k.sweepBody(wall,pose(),pose(100),dims);
assert.equal(fast.status,"contact",JSON.stringify(fast));close(fast.contact.time,(5-0.001-0.5-0.0001)/100,1e-10);close(fast.contact.normal.x,-1);
const leave=k.sweepBody(wall,pose(4.4988),pose(0),dims);assert.equal(leave.status,"clear","reverse away from contact");
const rotational=solids(box("rotation",0,1,1.2,0.15,2,0.15));
const long={halfLength:2,halfHeight:0.3,halfWidth:0.15};
const rotate=k.sweepBody(rotational,pose(),pose(0,0,Math.PI),long);
assert.equal(rotate.status,"contact",JSON.stringify(rotate));
assert.ok(rotate.contact.timeUpper-rotate.contact.time<=1e-7);assert.ok(rotate.contact.time>0&&rotate.contact.time<0.5);
assert.equal(k.sweepBody(wall,pose(),pose(100),dims,{maxTests:1}).status,"unresolved");
assert.equal(k.sweepBody(wall,pose(5),pose(6),dims).reason,"initial-overlap");
assert.equal(k.sweepBody(wall,pose(5.2),pose(6),dims).reason,"initial-overlap","outward motion cannot hide an existing overlap");
const pitchWall=solids(box("pitch",0,2.2,0,0.15,0.001,0.15));
const pitchHit=k.sweepBody(pitchWall,pose(),{...pose(),pitch:Math.PI},long);
assert.equal(pitchHit.status,"contact",JSON.stringify(pitchHit));assert.ok(pitchHit.contact.timeUpper-pitchHit.contact.time<=1e-7);
// The directional interval certificates must also retain interior collisions
// when heading, pitch and roll change together. Static SAT supplies witnesses.
const boxAt=(p,d)=>{
  const c=Math.cos(p.heading),s=Math.sin(p.heading),cp=Math.cos(p.pitch),sp=Math.sin(p.pitch),cr=Math.cos(p.roll),sr=Math.sin(p.roll);
  return k.boxPoly(p,[{x:c*cp*d.halfLength,y:sp*d.halfLength,z:s*cp*d.halfLength},
    {x:(-c*sp*cr+s*sr)*d.halfHeight,y:cp*cr*d.halfHeight,z:(-s*sp*cr-c*sr)*d.halfHeight},
    {x:(c*sp*sr+s*cr)*d.halfWidth,y:-cp*sr*d.halfWidth,z:(s*sp*sr-c*cr)*d.halfWidth}]);
};
let interiorCases=0;
for(let i=0;i<24;i++){
  const a={...pose(),heading:-0.4,pitch:0.1,roll:-0.2},b={...pose(),heading:1.7+i*0.07,pitch:0.6+i*0.03,roll:0.5+i*0.04};
  const mid=Object.fromEntries(["x","y","z","heading","pitch","roll"].map(key=>[key,(a[key]+b[key])/2]));
  const vertex=boxAt(mid,long).vertices[i%8],p={x:mid.x+(vertex.x-mid.x)*0.9,y:mid.y+(vertex.y-mid.y)*0.9,z:mid.z+(vertex.z-mid.z)*0.9};
  const index=k.buildCollisionIndex([box(`interior-${i}`,p.x,p.y,p.z,0.01,0.01,0.01)]);
  if(index.hit(boxAt(a,long)).status!=="clear"||index.hit(boxAt(b,long)).status!=="clear")continue;
  assert.equal(index.hit(boxAt(mid,long)).status,"hit");
  const hit=k.sweepBody(index.solids(),a,b,long);assert.equal(hit.status,"contact",JSON.stringify(hit));
  assert.ok(hit.contact.timeUpper-hit.contact.time<=1e-7);interiorCases++;
}
assert.ok(interiorCases>=8,`insufficient 3D interior collision witnesses: ${interiorCases}`);
const orderA=solids(box("a",5,1,0,0.001,3,100),box("b",5,1,0,0.001,3,100));
const orderB=solids(box("b",5,1,0,0.001,3,100),box("a",5,1,0,0.001,3,100));
assert.deepEqual(k.sweepBody(orderA,pose(),pose(10),dims),k.sweepBody(orderB,pose(),pose(10),dims));
const world={isCurrent:()=>true,constrain:(from,to)=>({ok:true,pose:to}),body:p=>p};
const slide=k.resolveDrivingCollision(wall,world,pose(),pose(10,8),dims);
assert.equal(slide.status,"moved",JSON.stringify(slide));assert.ok(slide.pose.x<4.499);close(slide.pose.z,8,1e-4);assert.ok(slide.contacts.length>0);
assert.ok(slide.distance<=Math.hypot(10,8)+1e-6,"projection cannot add energy/path length");
// Starting just inside the contact skin must permit a sustained tangent slide.
const resting=pose(4.49895,0),tangent=k.resolveDrivingCollision(wall,world,resting,pose(4.49895,1),dims);
assert.equal(tangent.status,"moved",JSON.stringify(tangent));close(tangent.pose.z,1,1e-8);
assert.equal(k.sweepBody(wall,resting,pose(4.49895,1),dims).status,"clear");
// Large immutable worlds use a cached broadphase tree; distant solids do not
// consume a full linear-scan budget on every tick alongside the same wall.
const distant=Array.from({length:12000},(_,i)=>{const x=1000+i*2,y=1,z=0,poly=k.boxPoly({x,y,z},[{x:0.1,y:0,z:0},{x:0,y:0.1,z:0},{x:0,y:0,z:0.1}]);
  return {id:`far-${String(i).padStart(5,"0")}`,role:"test",minX:x-0.1,maxX:x+0.1,minY:y-0.1,maxY:y+0.1,minZ:z-0.1,maxZ:z+0.1,poly};});
const indexedWorld=Object.freeze([...wall,...distant]);let sustained=resting,maxSustainedTests=0;
for(let tick=0;tick<300;tick++){const next={...sustained,z:sustained.z+0.03};const moved=k.resolveDrivingCollision(indexedWorld,world,sustained,next,dims);
  assert.equal(moved.status,"moved",`sustained slide tick ${tick}: ${moved.reason}`);if(tick>0)maxSustainedTests=Math.max(maxSustainedTests,moved.tests);sustained=moved.pose;}
assert.ok(sustained.z>8.9);assert.ok(maxSustainedTests<2000,`broadphase query still scans too much: ${maxSustainedTests}`);
const corner=k.resolveDrivingCollision(solids(box("x",5,1,0,0.001,3,100),box("z",0,1,5,20,3,0.001)),world,pose(),pose(10,10),dims);
assert.ok(corner.pose.x<4.499&&corner.pose.z<4.699);assert.ok(corner.contacts.length<=5);
const headon=k.resolveDrivingCollision(wall,world,pose(),pose(10),dims);
assert.equal(headon.speedFraction,0,"normal velocity is removed at first contact, not one tick later");
const rotationResolved=k.resolveDrivingCollision(rotational,world,pose(),pose(0,0,Math.PI),long);
assert.notEqual(rotationResolved.status,"unresolved",rotationResolved.reason);assert.ok(rotationResolved.pose.heading<Math.PI/2);
let active=true;const invalidating={...world,constrain:(a,b)=>{active=false;return {ok:true,pose:b};},isCurrent:()=>active};
assert.equal(k.resolveDrivingCollision(wall,invalidating,pose(),pose(10),dims).status,"unresolved");
function surface(slope=0){
  const vertices=new Float32Array([-20,-20*slope,-20,20,20*slope,-20,20,20*slope,20,-20,-20*slope,20]);
  const ring=[{x:-20,z:-20},{x:20,z:-20},{x:20,z:20},{x:-20,z:20}];
  const snapshot={revision:`surface:${slope}`,geometryVersion:5,patches:[{id:"road",kind:"carriageway",layerId:"ground",source:{kind:"road-edge",id:"road"},vertices,indices:new Uint32Array([0,2,1,0,3,2]),boundaryLoops:[{hole:false,vertices:ring,segments:ring.map(()=>"closed")}]}],portals:[],renderBatches:[],report:{candidateLength:200,geometricallyEligibleLength:0,issues:[]}};
  return k.buildSurfaceRegions(snapshot,k.buildSurfaceIndex(snapshot));
}
assert.equal(k.sweepBody(wall,pose(),pose(10),dims,{maxSourceSolids:0}).reason,"invalid-input");
assert.equal(k.sweepBody(wall,pose(),pose(10),dims,{maxAxes:1}).reason,"budget");
assert.equal(k.sweepBody(wall,{...pose(),heading:1e16},{...pose(10),heading:1e16},dims).reason,"precision");
const region=surface();assert.equal(region.status,"ready",JSON.stringify(region));const regionId=region.regions[0].id;
const env=new k.ContinuousDrivingEnvironment(region,{surfaceRevision:region.revision,worldRevision:"world",solidRevision:"world",solids:wall,dimensions:dims,centerHeight:1,isCurrent:()=>true});
assert.throws(()=>new k.ContinuousDrivingEnvironment(region,{surfaceRevision:region.revision,worldRevision:"world",solidRevision:"wrong",solids:wall,dimensions:dims,centerHeight:1,isCurrent:()=>true}),/invalid-continuous-world/);
const placed=k.footprintSupport(region,{x:0,z:0,heading:0},regionId);assert.ok(placed.ok);
const initial={...k.initialDrivingState(0,0,0,regionId),y:placed.y,pitch:placed.pitch,roll:placed.roll};
const move=env.move(initial,{x:10,z:8,heading:0});
// Explicit large-step fixture needs its own bounded prediction budget.
assert.equal(move.queryStatus,"unresolved");
const roomy=new k.ContinuousDrivingEnvironment(region,{surfaceRevision:region.revision,worldRevision:"world",solidRevision:"world",solids:wall,dimensions:dims,centerHeight:1,isCurrent:()=>true},undefined,undefined,{maxSupportSegments:256});
const idleMove=roomy.move(initial,{...initial,travelBudget:0});
assert.equal(idleMove.blocked,false,"a supported parked car is not reported as blocked without a movement request");
assert.equal(idleMove.reason,undefined);
const result=roomy.move(initial,{x:10,z:8,heading:0});assert.equal(result.queryStatus,"resolved");assert.ok(result.x<4.499&&result.z>7.99);
assert.equal(roomy.validateTrajectory(initial,result,result.trajectory),true);
const forged=result.trajectory.map(p=>({...p}));forged[forged.length-1].x=8;
assert.equal(roomy.validateTrajectory(initial,{...result,x:8},forged),false);
const forward={forward:true,backward:false,left:false,right:false},idle={forward:false,backward:false,left:false,right:false};
const brakeReverseWorld={move:(before,desired)=>({...desired,y:before.y,pitch:before.pitch,roll:before.roll,
  surfaceId:before.surfaceId,blocked:false})};
{
  let state={...k.initialDrivingState(),speed:3};
  state=k.stepDriving(state,{...idle,backward:true},brakeReverseWorld);
  assert.ok(state.speed>0&&state.speed<3,"S-style opposing input brakes before reverse");
  let stopped=false;
  for(let tick=0;tick<24;tick++) {
    state=k.stepDriving(state,{...idle,backward:true},brakeReverseWorld);
    if(state.speed<0){stopped=true;break;}
  }
  assert.ok(stopped,"holding S after braking through rest selects reverse");
  const coast=k.stepDriving({...k.initialDrivingState(),speed:3},idle,brakeReverseWorld);
  assert.ok(coast.speed>0&&coast.speed<3,"releasing pedals retains inertia and coasts down gradually");
}
const planeWorld=slope=>({move:(before,want)=>({...want,y:want.x*slope,pitch:Math.atan(slope),roll:0,surfaceId:"plane",blocked:false})});
for(const slope of [-0.2,0.2]) {
  let state={...k.initialDrivingState(),pitch:Math.atan(slope)};
  const next=k.stepDriving(state,forward,planeWorld(slope));
  close(next.distance,Math.hypot(next.x,next.y),1e-10);close(next.distance/k.DRIVING_DT,next.speed,1e-10);
  state=k.stepDriving(state,idle,planeWorld(slope));assert.equal(state.speed,0,"passive slope parking hold");
  state={...state,speed:1};for(let i=0;i<120;i++)state=k.stepDriving(state,{...forward,backward:true},planeWorld(slope));assert.equal(state.speed,0,"active slope brake");
}
function run(hz){const clock=new k.FixedStepClock(),world=planeWorld(0.15);let state={...k.initialDrivingState(),pitch:Math.atan(0.15)};for(let i=0;i<hz*5;i++)clock.advance(1/hz,false,()=>{state=k.stepDriving(state,forward,world);});return state;}
assert.deepEqual(run(30),run(60));assert.deepEqual(run(60),run(120));


// Actual C environment/kernel/independent validator share one immutable world.
function integrated(hz,slope=0){
  const r=surface(slope),id=r.regions[0].id;
  const environment=new k.ContinuousDrivingEnvironment(r,{surfaceRevision:r.revision,worldRevision:"integrated",solidRevision:"integrated",solids:wall,dimensions:dims,centerHeight:1,isCurrent:()=>true});
  const support=k.footprintSupport(r,{x:0,z:0,heading:0},id);assert.ok(support.ok);
  let state={...k.initialDrivingState(0,0,0,id),y:support.y,pitch:support.pitch,roll:support.roll};
  const kernel=k.createContinuousDrivingKernel(environment,{worldRevision:"integrated",vehicleConfigHash:"test-config",kernelBuildId:"test-C"});
  // physics v3：非对称转向回正（steeringReturnResponse）。assert.equal(kernel.identity.physicsVersion,3);assert.equal(kernel.identity.collisionVersion,4);assert.equal(kernel.identity.queryVersion,3);
  const validator=new k.ContinuousWorldValidator(environment,s=>s.x);assert.equal(validator.validateStart(state),"valid");
  const clock=new k.FixedStepClock();let contacts=0;
  for(let frame=0;frame<hz*3;frame++)clock.advance(1/hz,false,()=>{
    const next=kernel.step(state,forward);assert.equal(validator.validate(state,next),"valid",JSON.stringify(next.motion));
    if(next.motion.contact)contacts++;state=next.state;
  });
  assert.ok(state.x<4.8);assert.ok(contacts>0);
  // Back out after sustained contact, rather than freezing at t=0 forever.
  const contactX=state.x;
  for(let tick=0;tick<90;tick++) {const next=kernel.step(state,{...idle,backward:true});assert.equal(validator.validate(state,next),"valid");state=next.state;}
  assert.ok(state.x<contactX-0.5,"reverse must escape the wall");
  return state;
}
assert.deepEqual(integrated(30),integrated(60));assert.deepEqual(integrated(60),integrated(120));
integrated(60,0.1);integrated(60,-0.1);
// Reported tick-38 regression: a steering car slides beside a parked box on a
// six-wide road. A global translation Lipschitz bound exhausted rotation CCD.
{
  const {grid,patch,snapshot}=makeFixtures(k);
  const s=snapshot([patch("road","carriageway",grid(-50,-3,50,3,50,6))]),r=k.buildSurfaceRegions(s,k.buildSurfaceIndex(s));
  const collider=k.CONTINUOUS_AUDIT_COLLIDER,parked=solids(box("parked",-40,1,1.2,1,1,0.6));
  const environment=new k.ContinuousDrivingEnvironment(r,{surfaceRevision:s.revision,worldRevision:"parked",solidRevision:"parked",solids:parked,...collider,isCurrent:()=>true});
  const kernel=k.createContinuousDrivingKernel(environment,{worldRevision:"parked",vehicleConfigHash:"parked-fixture",kernelBuildId:"parked-fixture"});
  const validator=new k.ContinuousWorldValidator(environment,s=>s.x),pilot=new k.CorridorPilot([{x:-40,z:0},{x:40,z:0}],7);
  let state=k.initialDrivingState(-40.18,-0.47,0,r.regions[0].id),contactTicks=0;
  assert.equal(validator.validateStart(state),"valid");
  for(let tick=0;tick<600;tick++){
    const next=kernel.step(state,pilot.input(state));
    assert.equal(next.motion.queryStatus,"resolved",`parked tick ${tick}: ${next.motion.reason}`);
    assert.equal(validator.validate(state,next),"valid",`parked tick ${tick}: invalid trace`);
    if(next.motion.contact)contactTicks++;state=next.state;
  }
  assert.ok(contactTicks>10);assert.ok(state.x>-35,"driver gets past parked box");
}
// Stationary traces also verify support and collision; no one-element escape.
assert.equal(roomy.validateTrajectory({...initial,y:2},{...initial,y:2},[{...initial,y:2}]),false);


for(let index=1;index<=24;index++) {
  const angle=index*0.17,n={x:Math.cos(angle),z:Math.sin(angle)},t={x:-n.z,z:n.x};
  const obstacle={id:"oblique",role:"test",kind:"box",center:{x:5*n.x,y:1,z:5*n.z},halfAxes:[{x:0.001*n.x,y:0,z:0.001*n.z},{x:0,y:3,z:0},{x:100*t.x,y:0,z:100*t.z}]};
  const hit=k.sweepBody(solids(obstacle),pose(),pose(10*n.x+3*t.x,10*n.z+3*t.z),dims);
  assert.equal(hit.status,"contact");
  const radius=0.5*Math.abs(n.x)+0.3*Math.abs(n.z);
  close(hit.contact.time,(5-0.001-radius-0.0001)/10,1e-9);
  close(hit.contact.normal.x,-n.x,1e-9);close(hit.contact.normal.z,-n.z,1e-9);
  const moved=k.resolveDrivingCollision(solids(obstacle),world,pose(),pose(10*n.x+3*t.x,10*n.z+3*t.z),dims);
  assert.notEqual(moved.status,"unresolved",moved.reason);
  assert.ok(moved.pose.x*n.x+moved.pose.z*n.z<5-0.001-radius);
}
// Non-orthogonal double wall cannot gain distance or escape through the wedge.
const wedge=solids(box("wall-x",5,1,0,0.001,3,100),{id:"angled",role:"test",kind:"box",center:{x:0,y:1,z:5},halfAxes:[{x:80,y:0,z:40},{x:0,y:3,z:0},{x:-0.0005,y:0,z:0.001}]});
const wedged=k.resolveDrivingCollision(wedge,world,pose(),pose(10,10),dims);
assert.notEqual(wedged.status,"unresolved",wedged.reason);assert.ok(wedged.distance<=Math.sqrt(200)+1e-6);
assert.equal(k.sweepBody(wedge,wedged.pose,wedged.pose,dims).status,"clear");
// Grade changes use measured support length, never exceed the tick travel budget.
const changed=surface(0.2),changedId=changed.regions[0].id;
const changedEnv=new k.ContinuousDrivingEnvironment(changed,{surfaceRevision:changed.revision,worldRevision:"slope",solidRevision:"slope",solids:[],dimensions:dims,centerHeight:1,isCurrent:()=>true});
const s=k.footprintSupport(changed,{x:0,z:0,heading:0},changedId);
const budgeted=changedEnv.move({...k.initialDrivingState(0,0,0,changedId),y:s.y,pitch:s.pitch,roll:s.roll},{x:1,z:0,heading:0,travelBudget:0.5});
assert.ok(budgeted.travelledDistance<=0.5+1e-9);close(budgeted.travelledDistance,0.5,1e-8);
console.log("C continuous driving: analytic TOI, bounded rotation, slides/corners, stale/budgets, independent trajectories, slope/brake/reverse and real-kernel frame parity passed.");
if(process.argv.includes("--contact-cities")) {
  const {sceneKit,buildParts}=await import("./city-kit/scene-parts.mjs");
  const kit=await sceneKit({"engine/surface/citySurfacePort.ts":["CitySurfacePort"],
    "game/driving/audit/RoadPassabilityAudit.ts":["auditCapture","directedEdgeRoutes","continuousAuditKeyFields"]});
  for(const [seed,prefix] of [[42,"-103.81:-388.59/-59.58:-396.21"],[65537,"-136.97:-232.97/"]]){
    const {parts,layout}=buildParts(kit,500,seed),lease=parts.acquireDrivingWorldSource();
    try{
      const capture=await new kit.CitySurfacePort().capture(lease.source);assert.equal(capture.status,"ready");
      const routes=kit.directedEdgeRoutes(layout.roadEdges.filter(e=>e.id.startsWith(prefix)));assert.equal(routes.length,seed===42?2:6,`500/${seed}: contact regression edges missing`);
      const audited=kit.auditCapture(capture,revision=>({baseSnapshotHash:revision,...kit.continuousAuditKeyFields(),kernelBuildId:"C-contact-regression-v3",
        surfaceVersion:capture.readWorld().surface.geometryVersion,snapshotCompilerVersion:1,controllerVersion:1,plannerVersion:1,observerVersion:2,manifestHash:"C-contact-regressions-v3",releasePolicyVersion:1,releaseBoundaryHash:null}),routes);
      assert.equal(audited.status,"ready");
      for(const result of audited.results){
        assert.ok(result.run,`${result.routeId}: regression must exercise a dynamic run`);
        assert.notEqual(result.cause,"simulation-invalid",`${result.routeId}: ${result.detail}`);
        assert.notEqual(result.run.cause,"simulation-invalid",`${result.routeId}: invalid dynamic run`);
        if(seed===42)assert.equal(result.verdict,"passed",`${result.routeId}: regression should drive past pier`);
        console.log(`C contact city 500/${seed} ${result.routeId}: ${result.verdict}:${result.cause}`);
      }
    }finally{lease.release();parts.dispose();}
  }
}
if(process.argv.includes("--cities")) {
  const {createCityPlan,compileCitySurface,cityCollisionIndex,cachedPlan}=await (async()=>{
    const m=await loadCity({"engine/cityPlan.ts":["createCityPlan"],"engine/surface/compileSurface.ts":["compileCitySurface"],"game/driving/citySolids.ts":["cityCollisionIndex"]});
    const kit=await import("./city-kit/index.mjs");return {...m,cachedPlan:kit.cachedPlan};
  })();
  let runs=0,ticks=0,contacts=0,uncertain=0,budgetChecked=false;
  for(const seed of [1,7,42,2026,65537])for(const tier of [1,2,3]) {
    const layout=cachedPlan(createCityPlan,seed,tier),compilation=compileCitySurface(layout);
    const surface={...compilation.surface,revision:`C:${seed}/${tier}`};
    const regions=k.buildSurfaceRegions(surface,k.buildSurfaceIndex(surface));assert.equal(regions.status,"ready");
    const solidIndex=cityCollisionIndex(compilation.obstacles);assert.equal(solidIndex.report.rejected,0);
    let sceneRuns=0;
    for(const edge of layout.roadEdges.filter(e=>!e.bridge&&e.structure!=="deck"&&e.points.length===2)) {
      const [a,b]=edge.points,dx=b.x-a.x,dz=b.z-a.z,len=Math.hypot(dx,dz);if(len<35)continue;
      const x=a.x+dx/len*12,z=a.z+dz/len*12,heading=Math.atan2(dz,dx),point=regions.classify(x,z,"ground");
      if(point.status!=="drivable")continue;
      const support=k.footprintSupport(regions,{x,z,heading},point.regionId);if(!support.ok)continue;
      const environment=new k.ContinuousDrivingEnvironment(regions,{surfaceRevision:surface.revision,worldRevision:surface.revision,solidRevision:surface.revision,solids:solidIndex.solids(),dimensions:{halfLength:1.4,halfHeight:0.35,halfWidth:0.7},centerHeight:0.7,isCurrent:()=>true});
      let state={...k.initialDrivingState(x,z,heading,point.regionId),y:support.y,pitch:support.pitch,roll:support.roll};
      const validator=new k.ContinuousWorldValidator(environment,s=>s.distance);
      if(validator.validateStart(state)!=="valid")continue;
      const kernel=k.createContinuousDrivingKernel(environment,{worldRevision:surface.revision,vehicleConfigHash:"C-city-explicit-collider",kernelBuildId:"C-city-test"});
      for(let tick=0;tick<60;tick++) {
        const next=kernel.step(state,forward);
        // 预算用尽且原地停下 → budget-exhausted（未判定）；其余 unresolved 仍是 simulation-invalid。
        if(next.motion.queryStatus==="unresolved") {assert.equal(validator.validate(state,next),/(^|:)budget$/.test(next.motion.reason??"")&&next.state.x===state.x&&next.state.z===state.z?"budget-exhausted":"simulation-invalid");uncertain++;break;}
        assert.equal(validator.validate(state,next),"valid",`${seed}/${tier}: ${next.motion.reason}`);
        ticks++;if(next.motion.contact)contacts++;state=next.state;
      }
      // 同一起点、碰撞测试预算压到 1：内核原地停下报 continuous-collision:budget，验证器给 budget-exhausted 而不是 simulation-invalid。
      if(!budgetChecked){
        const starved=new k.ContinuousDrivingEnvironment(regions,{surfaceRevision:surface.revision,worldRevision:surface.revision,solidRevision:surface.revision,solids:solidIndex.solids(),dimensions:{halfLength:1.4,halfHeight:0.35,halfWidth:0.7},centerHeight:0.7,isCurrent:()=>true},undefined,undefined,{maxTests:1});
        const s0={...k.initialDrivingState(x,z,heading,point.regionId),y:support.y,pitch:support.pitch,roll:support.roll};
        const step=k.createContinuousDrivingKernel(starved,{worldRevision:surface.revision,vehicleConfigHash:"C-city-explicit-collider",kernelBuildId:"C-city-test"}).step(s0,forward);
        if(step.motion.queryStatus==="unresolved"&&/(^|:)budget$/.test(step.motion.reason??"")){assert.equal(new k.ContinuousWorldValidator(starved,q=>q.distance).validate(s0,step),"budget-exhausted","a collision-budget stop is unconfirmed, not a simulation defect");budgetChecked=true;}
      }
      runs++;if(++sceneRuns===2)break;
    }
    console.log(`C city ${seed}/${tier}: ${sceneRuns} valid spawns, all committed pieces independently checked`);
  }
  assert.ok(budgetChecked,"a starved collision budget was exercised at least once");
  assert.ok(runs>=15&&ticks>=runs*10,JSON.stringify({runs,ticks,contacts,uncertain}));
  console.log(`C structural city matrix: ${runs} runs, ${ticks} verified ticks, ${contacts} contact ticks, ${uncertain} explicit uncertainties; no road release.`);
}
