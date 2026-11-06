#!/usr/bin/env node
import assert from 'node:assert/strict';
import {loadCity} from './city-kit/index.mjs';
import {makeFixtures} from './city-kit/surface-region-fixtures.mjs';
const k=await loadCity({
 'game/driving/audit/AuditEvidenceStore.ts':['AuditEvidenceStore','DEFAULT_EVIDENCE_LIMITS'],
 'game/driving/audit/DrivingRouteRunner.ts':['DrivingRouteRunner'],
 'game/driving/audit/GateAuditObserver.ts':['GateAuditObserver'],
 'game/driving/audit/AuditScheduler.ts':['scheduleAudit'],
 'game/driving/DrivingKernel.ts':['DrivingKernel'],
 'game/DrivingWorld.ts':['DrivingWorld'],
 'game/DrivingSimulation.ts':['initialDrivingState'],
 'engine/surface/meshBoundaries.ts':['extractMeshBoundaries'],
 'engine/surface/SurfaceIndex.ts':['buildSurfaceIndex'],
 'engine/surface/surfaceRegions.ts':['buildSurfaceRegions'],
 'game/driving/audit/RoadPassabilityAudit.ts':['passabilityWorld','auditRoute','continuousAuditKeyFields'],
});
const key={baseSnapshotHash:'synthetic-plane-v1',vehicleConfigHash:'car-v1',kernelBuildId:'fixture-build-v1',surfaceVersion:1,queryVersion:1,snapshotCompilerVersion:1,physicsVersion:1,collisionVersion:1,controllerVersion:1,plannerVersion:1,observerVersion:1,manifestHash:'straight-v1',releasePolicyVersion:1,releaseBoundaryHash:null};
const world=new k.DrivingWorld([{id:'pad',layer:'ground',minX:-100,maxX:100,minZ:-10,maxZ:10,base:0,slopeX:0,slopeZ:0,connections:[]}],[]);
const forward={forward:true,backward:false,left:false,right:false},idle={...forward,forward:false};
const test=id=>({id,units:['edge'],start:k.initialDrivingState(),corridor:{surfaceSequence:['pad'],portalSequence:[],waypoints:[{x:0,z:0},{x:5,z:0}]},policy:{cruiseSpeed:7,maxReverseSpeed:0},gates:[{id:'exit',x:3,y:0,z:0,forwardX:1,forwardZ:0,halfWidth:2,heightTolerance:.1,surfaceIds:['pad']}],maxTicks:300,maxNoProgressTicks:8});
const validator={validateStart:s=>s.surfaceId==='pad'?'valid':'route-deviation',validate:(_,n)=>n.state.surfaceId==='pad'&&!n.motion.blocked?'valid':'route-deviation',progress:s=>s.x};
const runner=(t,buttons,sink,identity=key)=>new k.DrivingRouteRunner(identity,t,new k.DrivingKernel(world,identity),{input:()=>buttons},new k.GateAuditObserver(t,validator),sink);
const finish=r=>{for(let i=0;!r.result&&i<1000;i++)r.advance(1,r.key);assert.ok(r.result);return r.result;};
const owner={},state={current:true,key};
const scope={owner,isCurrent:()=>state.current,currentKey:()=>state.key};
let store=new k.AuditEvidenceStore(key,scope,{maxTicksPerClip:4,maxFailureClips:2,maxSummaries:8});
let sink=store.sink(owner);assert.ok(sink);
const plain=runner(test('good'),forward),recorded=runner(test('good'),forward,sink);
assert.deepEqual(finish(recorded),finish(plain));assert.deepEqual(recorded.state,plain.state,'recording cannot change simulation');
assert.equal(store.stats(owner).failureClips,0,'successful paths are discarded');
assert.equal(store.summaries(owner)[0].evidence,null);
const failed=runner(test('stalled'),idle,sink);assert.equal(finish(failed).cause,'pilot-failed');
let row=store.summaries(owner).find(r=>r.caseId==='stalled'),handle=row.evidence;assert.ok(handle);
let clip=store.read(owner,handle);assert.equal(clip.frames.length,4);assert.ok(clip.truncated);
assert.deepEqual(clip.frames.map(f=>f.tick),[failed.simulatedTicks-3,failed.simulatedTicks-2,failed.simulatedTicks-1,failed.simulatedTicks]);
assert.deepEqual(clip.frames.at(-1).next,failed.state);assert.deepEqual(clip.frames[0].input,idle);
assert.throws(()=>{clip.frames[0].next.x=777;},TypeError);assert.equal(store.read({},handle),null);assert.equal(store.summaries({}),null);
const diagnosticKey={...key,controllerVersion:2,manifestHash:'alternate-controller-v1'};
const diagnostic=store.variantSink(owner,diagnosticKey,'alternate-controller','stalled');assert.ok(diagnostic);
assert.equal(finish(runner(test('stalled'),forward,diagnostic,diagnosticKey)).verdict,'passed');
const contrast=store.summaries(owner).filter(r=>r.caseId==='stalled');assert.equal(contrast.length,2);
assert.equal(contrast.find(r=>r.kind==='mandatory').verdict,'inconclusive');assert.equal(contrast.find(r=>r.kind==='alternate-controller').verdict,'passed');
assert.ok(store.read(owner,handle),'diagnostic success cannot overwrite first failure');
assert.equal(store.variantSink(owner,{...diagnosticKey,physicsVersion:2},'alternate-controller','stalled'),null,'different physical world is not a diagnostic condition');
assert.equal(store.variantSink(owner,{...diagnosticKey,manifestHash:'missing'},'reduced-speed','absent'),null);
// FIFO clip limits and explicit evicted status; summaries remain bounded independently.
for(const id of ['f2','f3'])finish(runner(test(id),idle,sink));
assert.equal(store.read(owner,handle),null);assert.equal(store.stats(owner).failureClips,2);
assert.equal(store.summaries(owner).find(r=>r.caseId==='stalled'&&r.kind==='mandatory').evidenceStatus,'evicted');
assert.ok(store.stats(owner).retainedBytes<=store.stats(owner).maxBytes);
// Automatic runner cancellation invalidates all older handles, including completed cases.
const cancel=runner(test('cancel'),idle,sink);cancel.advance(2,key);cancel.cancel();assert.equal(store.summaries(owner),null);
store=new k.AuditEvidenceStore(key,scope,{maxTicksPerClip:4});sink=store.sink(owner);
finish(runner(test('before-change'),idle,sink));handle=store.summaries(owner)[0].evidence;
state.key={...key,vehicleConfigHash:'changed'};assert.equal(store.read(owner,handle),null);assert.equal(store.stats(owner),null);state.key=key;
// Byte pressure includes active rings, summaries and key variants. Never changes run verdicts.
store=new k.AuditEvidenceStore(key,scope,{maxTicksPerClip:4,maxBytes:18000,maxSummaries:2,maxFailureClips:2});sink=store.sink(owner);
for(let i=0;i<10;i++){const r=runner(test('byte-'+i),idle,sink);assert.equal(finish(r).verdict,'inconclusive');assert.ok(store.stats(owner).retainedBytes<=18000);assert.ok(store.stats(owner).summaries<=2);}
assert.ok(store.stats(owner).evictedClips+store.stats(owner).droppedFrames>0);
// No unknown object fields or non-finite JSON coercion may enter the retained frames.
store=new k.AuditEvidenceStore(key,scope,{maxTicksPerClip:4});sink=store.sink(owner);
const cap=sink.begin(key,test('invalid-sample'));assert.ok(cap);
cap.record(1,{...idle,credential:'DO_NOT_STORE'},{...test('x').start,credential:'DO_NOT_STORE'},{...test('x').start,x:NaN,credential:'DO_NOT_STORE'});
cap.finish({key,caseId:'invalid-sample',verdict:'inconclusive',cause:'simulation-invalid',coveredUnits:[],simulatedTicks:1});
clip=store.read(owner,store.summaries(owner)[0].evidence);assert.equal(clip.frames[0].invalidState,true);assert.equal(clip.frames[0].next,null);
assert.ok(!JSON.stringify(clip).includes('DO_NOT_STORE'));
const old=store,oldHandle=store.summaries(owner)[0].evidence;
store=new k.AuditEvidenceStore(key,scope);assert.equal(old.read(owner,oldHandle),null,'new epoch invalidates previous runtime-wide handles');
// Between-case scheduler cancellation must clear evidence even when it creates no runner.
sink=store.sink(owner);finish(runner(test('before-schedule'),idle,sink));
const manifest={key,units:[{id:'edge',kind:'directed-edge'}],exclusions:[],cases:[test('schedule')]};
const report=await k.scheduleAudit(manifest,t=>runner(t,forward,sink),{ticksPerBatch:10,maxTotalTicks:500,currentKey:()=>key,isCancelled:()=>true,yieldControl:async()=>{},evidence:sink});
assert.equal(report.state,'cancelled');assert.equal(store.summaries(owner),null);
// Real B audit wiring (continuous kernel + independent world validator), not a tracing-only harness.
const {grid,patch}=makeFixtures(k),surface={revision:'surface-fixture',geometryVersion:3,patches:[patch('road','carriageway',grid(-50,-3,50,3,50,6,()=>0))],portals:[],renderBatches:[],report:{candidateLength:0,geometricallyEligibleLength:0,issues:[]}};
const regions=k.buildSurfaceRegions(surface,k.buildSurfaceIndex(surface));assert.equal(regions.status,'ready');
const built=k.passabilityWorld({revision:'world-fixture',surface,obstacles:[],landings:[],counts:{bridges:0,expresswaySegments:0,flares:0,islands:0,culDeSacs:0},obstacleCoverage:'structures-only',renderedSolids:[],sceneSolids:[]},regions,()=>true,{declareNoBuildings:true});assert.equal(built.status,'ready');
const realKey={...key,...k.continuousAuditKeyFields(),baseSnapshotHash:'world-fixture'};state.key=realKey;
store=new k.AuditEvidenceStore(realKey,scope,{maxTicksPerClip:6});
const route={id:'real-failure',units:['edge'],path:[{x:-40,z:0},{x:40,z:0}],halfWidth:3.5};
const result=k.auditRoute(built.world,realKey,route,{pilot:()=>({input:()=>idle}),evidence:store.sink(owner)});
assert.equal(result.verdict,'inconclusive');assert.equal(result.cause,'pilot-failed');
row=store.summaries(owner).find(r=>r.caseId===result.run.caseId);assert.ok(row.evidence);assert.equal(store.read(owner,row.evidence).frames.length,6);
state.current=false;assert.equal(store.read(owner,row.evidence),null);
assert.equal(k.DEFAULT_EVIDENCE_LIMITS.maxTicksPerClip,600);assert.equal(k.DEFAULT_EVIDENCE_LIMITS.maxFailureClips,32);
console.log('Audit evidence: automatic real-run capture, same-kernel parity, bounded rings/bytes/summaries, first failure vs diagnostic key, FIFO eviction, redacted schema, owner/revision/epoch/cancel invalidation and B continuous audit integration passed.');
