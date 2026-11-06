#!/usr/bin/env node
// Worker regression: the exact structured-clone payload used by CityApp can
// cross a worker boundary, and importing/running the worker contract has no DOM
// dependency while producing real planner/audit results.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadCity } from "./city-kit/index.mjs";
import { makeFixtures } from "./city-kit/surface-region-fixtures.mjs";

const city = await loadCity({
  "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
  "game/RoadAuditWorker.ts": ["runRoadAuditWorker"],
  "engine/surface/SurfaceIndex.ts":["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts":["buildSurfaceRegions"],
  "game/driving/audit/FinalSurfaceBoundary.ts":["buildFinalSurfaceBoundary","matchesFinalSurfaceBoundary"],
  "game/driving/audit/RoadPassabilityAudit.ts":["passabilityWorld","auditRoute"],
  "game/driving/audit/RoadAuditPlanner.ts":["planRoadAudit"],
  "game/RoadAuditLifecycle.ts": ["RoadAuditRunLock", "clearOwnedCaptureResources", "auditMustInvalidate"],
});
assert.equal(typeof globalThis.self, "undefined", "worker module import must not require a DOM worker global");
const lifecycle = new city.RoadAuditRunLock();
const pending = lifecycle.begin(true);
assert.notEqual(pending, null);
assert.equal(lifecycle.begin(true), null, "a second click during async capture cannot start a competing run");
lifecycle.invalidate();
assert.equal(lifecycle.isCurrent(pending), false, "cancel invalidates late capture completion");
assert.equal(lifecycle.finish(pending), false, "stale capture cannot finish over a newer run");
assert.equal(lifecycle.begin(false), null, "disabled scene modes reject new audits");
const next = lifecycle.begin(true);
assert.equal(lifecycle.finish(next), true, "current run can finish exactly once");
assert.equal(lifecycle.active, false);
assert.equal(city.auditMustInvalidate(false, lifecycle.active, true), true, "disabling after completion invalidates a retained capture");
assert.equal(city.auditMustInvalidate(true, lifecycle.active, true), false, "enabled completed snapshot remains inspectable");
const oldRun = lifecycle.begin(true);
const slots = { timer: { current: "old-timeout" }, abort: { current: "old-abort" } };
lifecycle.invalidate();
const currentRun = lifecycle.begin(true);
slots.timer.current = "new-timeout"; slots.abort.current = "new-abort";
const cleared = [];
assert.equal(city.clearOwnedCaptureResources(lifecycle.isCurrent(oldRun), slots.timer, slots.abort,
  "old-timeout", "old-abort", (timer) => cleared.push(timer)), false, "late old capture cannot clean shared resources");
assert.deepEqual(slots, { timer: { current: "new-timeout" }, abort: { current: "new-abort" } });
assert.deepEqual(cleared, []);
assert.equal(city.clearOwnedCaptureResources(lifecycle.isCurrent(currentRun), slots.timer, slots.abort,
  "new-timeout", "new-abort", (timer) => cleared.push(timer)), true, "current capture cleans only its own resources");
assert.deepEqual(slots, { timer: { current: null }, abort: { current: null } });
assert.deepEqual(cleared, ["new-timeout"]);
const hookSource = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../apps/agent-city/ui/src/game/useRoadAudit.ts"), "utf8");
assert.equal((hookSource.match(/\.verifyCurrent\(\)/g) ?? []).length, 1, "deep capture verification runs once at completion");
assert.equal((hookSource.match(/clearOwnedCaptureResources\(/g) ?? []).length, 2, "capture success and failure both use run-owned cleanup");
const { grid, patch } = makeFixtures(city);
const surface = { revision: "worker-surface", geometryVersion: 1,
  patches: [patch("road", "carriageway", grid(-50, -5, 50, 5, 40, 4))],
  portals: [], renderBatches: [], report: { candidateLength: 100, geometricallyEligibleLength: 100, issues: [] } };
const snapshot = { revision: "worker-world", surface, obstacles: [], landings: [],
  counts: { bridges: 0, expresswaySegments: 0, flares: 0, islands: 0, culDeSacs: 0 },
  obstacleCoverage: "structures-and-rendered-buildings", renderedSolids: [], sceneSolids: [] };
const input = { roadEdges: [{ id: "road", from: "west", to: "east", width: 6, points: [{ x: -40, z: 0 }, { x: 40, z: 0 }] }],
  landings: [], structurePaths: {} };
const request = structuredClone({ runId: 17, snapshot, input });
assert.ok(request.snapshot.surface.patches[0].vertices instanceof Float32Array, "typed surface geometry survives structured clone");
assert.ok(request.snapshot.surface.patches[0].indices instanceof Uint32Array, "surface indices survive structured clone");
const messages = [];
city.runRoadAuditWorker(request, (message) => messages.push(structuredClone(message)));
assert.ok(messages.some((message) => message.type === "progress"), "worker streams actual case results");
const completed = messages.find((message) => message.type === "complete");
assert.ok(completed, JSON.stringify(messages.find((message) => message.type === "error")));
assert.equal(completed.report.worldRevision, snapshot.revision);
assert.equal(completed.report.manifestHash, completed.plan.manifestHash);
assert.equal(completed.report.results.length, completed.plan.routes.length);
assert.ok(completed.report.results.every((result) => result.key.manifestHash === completed.manifest.key.manifestHash));
console.log("city road audit worker serialization and execution guard passed");
assert.equal(completed.publication.status, "published", "a fully passing fixture must complete final-boundary replay and publication");
assert.equal(completed.phase, "final-replay");
assert.ok(completed.key.releaseBoundaryHash);
assert.ok(completed.publication.graph.geometry.every((entry) => entry.boundaryEvidence?.finalReplayPassed));
assert.ok(messages.some((message)=>message.type==="progress"&&message.phase==="diagnostic"));
assert.ok(messages.some((message)=>message.type==="progress"&&message.phase==="final-replay"));
const incomplete=[];
city.runRoadAuditWorker({runId:2,snapshot:{...snapshot,obstacleCoverage:"structures-only"},input},(message)=>incomplete.push(message));
const denied=incomplete.find((message)=>message.type==="complete");
assert.ok(denied); assert.equal(denied.publication.status,"not-published");
assert.equal(denied.phase,"diagnostic"); assert.equal(denied.key.releaseBoundaryHash,null);
assert.ok(denied.report.results.some((result)=>result.verdict==="inconclusive"));
const excluded=[];
city.runRoadAuditWorker({runId:3,snapshot,input:{...input,roadEdges:[...input.roadEdges,
  {id:"short",from:"a",to:"b",width:6,points:[{x:10,z:1},{x:10.5,z:1}]}]}},(message)=>excluded.push(message));
const excludedResult=excluded.find((message)=>message.type==="complete");
assert.ok(excludedResult); assert.ok(excludedResult.plan.exclusions.length>0);
assert.equal(excludedResult.publication.status,"not-published");
assert.equal(excludedResult.publication.reason,"excluded-units-require-physical-closure");
console.log("Road audit final replay: complete fixture publishes; incomplete solids and excluded roads never publish a green subset.");

const regions=city.buildSurfaceRegions(surface,city.buildSurfaceIndex(surface));
const worldResult=city.passabilityWorld(snapshot,regions,()=>true);assert.equal(worldResult.status,"ready");
const world=worldResult.world;
const boundary=city.buildFinalSurfaceBoundary(world);assert.ok(boundary);
const finalKey={...completed.key,releaseBoundaryHash:boundary.hash};
assert.equal(city.matchesFinalSurfaceBoundary(boundary,world,finalKey),true);
assert.equal(city.matchesFinalSurfaceBoundary({...boundary},world,finalKey),false,"a copied hash/contour is not an issued boundary capability");
assert.equal(city.matchesFinalSurfaceBoundary(boundary,{...world},finalKey),false,"boundary is bound to the actual enforcing world");
assert.equal(city.matchesFinalSurfaceBoundary(boundary,world,{...finalKey,releaseBoundaryHash:"forged"}),false);
const changed={...world,regions:{...regions,boundaryOf:id=>regions.boundaryOf(id).map(s=>({...s,ya:s.ya+1}))}};
assert.notEqual(city.buildFinalSurfaceBoundary(changed).hash,boundary.hash,"height layers participate in final boundary identity");
const route=completed.plan.routes[0];
for(const options of [{finalBoundary:{...boundary}},{finalBoundary:boundary,mountablePolicy:"gameplay"},{finalBoundary:boundary,engine:"legacy"}]){
 const result=city.auditRoute(world,finalKey,route,options);
 assert.equal(result.verdict,"inconclusive");assert.equal(result.detail,"final-boundary-policy-mismatch");
}
assert.equal(city.buildFinalSurfaceBoundary({...world,isCurrent:()=>false}),null);
const landing=(end,x)=>({structureId:"expressway:0",end,layerId:"deck",patchId:"deck",x,z:0,
 seam:{a:{x,y:3,z:-3},b:{x,y:3,z:3}},outX:end==="from"?-1:1,outZ:0,deckY:3,groundY:3,step:0,status:"aligned"});
const spanPlan=city.planRoadAudit({...input,worldRevision:snapshot.revision,landings:[landing("from",-30),landing("to",30)],
 structurePaths:{"expressway:0":[{x:-30,z:0},{x:0,z:3},{x:30,z:0}]}});
const spans=spanPlan.routes.filter(r=>r.id.startsWith("span:"));assert.equal(spans.length,2);
assert.ok(spans.every(r=>r.path.some(p=>p.x===0&&p.z===3)),"both directions test the curved middle, not just landing probes");
assert.ok(spans.every(r=>r.startLayer==="deck"&&r.exitLayer==="deck"));
console.log("Final boundary: unforgeable world binding, height identity, stale/policy rejection and whole elevated-span coverage passed.");
