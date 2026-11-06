#!/usr/bin/env node
// Real WebGL CityEngine + CityParts, synthetic sessions only. Start City Vite first.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadCity } from "./city-kit/index.mjs";
import { sessionModel } from "./city-kit/session-models.mjs";
const require=createRequire(new URL("../apps/desktop/ui-dev/package.json",import.meta.url));
const {chromium}=require("playwright");
const {buildCityModel}=await loadCity({"cityModel.ts":["buildCityModel"]});
const model=sessionModel(buildCityModel,90);
const base=process.argv[2]??"http://127.0.0.1:5179";
const browser=await chromium.launch({channel:"chromium",headless:true,args:["--use-angle=metal"]});
try {
  const page=await browser.newPage({viewport:{width:800,height:600}});
  const errors=[];page.on("pageerror",(e)=>errors.push(e.message));
  // Same-origin empty fixture, never starts CityApp, plugin bridge or a real data provider.
  await page.route(new URL("/__driving-surface-host-test",base).href,(route)=>route.fulfill({contentType:"text/html",body:"<!doctype html><canvas width='800' height='600'></canvas>"}));
  await page.goto(new URL("/__driving-surface-host-test",base).href);
  const result=await page.evaluate(async(model)=>{
    const {CityEngine}=await import("/src/engine/CityEngine.ts");
    const {emptyPlanPatch,edgeLocked}=await import("/src/engine/planPatch.ts");
    const check=(value,message)=>{if(!value)throw new Error(message);};
    const engine=new CityEngine({canvas:document.querySelector("canvas"),headless:true});
    const renderedBuffersMatch=(capture)=>{
      const batches=capture.readWorld().surface.renderBatches;
      for(const [name,layers] of [["city-road-surface-base",[0,1]],["city-road-surface",[2,3,4]]]) {
        const mesh=engine.parts.group.getObjectByName(name),positions=[],indices=[];
        for(const layer of layers){const batch=batches[layer],base=positions.length/3;positions.push(...batch.positions);for(const i of batch.indices)indices.push(i+base);}
        if(!indices.length){check(!mesh,`${name}: absent empty mesh`);continue;}
        check(mesh,`${name}: actual render mesh exists`);
        const actual=mesh.geometry.getAttribute("position").array,index=mesh.geometry.index.array;
        check(actual.length===positions.length&&index.length===indices.length,`${name}: buffer lengths`);
        check(actual.every((v,i)=>v===positions[i])&&index.every((v,i)=>v===indices[i]),`${name}: renderer and frozen snapshot buffers identical`);
      }
    };
    try {
      engine.setSeed(1);engine.applyModel(model);
      const first=await engine.captureDrivingSurface();check(first.status==="ready","initial capture");
      const initial=first.readWorld();check(initial?.surface.revision===first.revision,"published surface identity");
      renderedBuffersMatch(first);engine.renderFrame();check(engine.renderer.info.render.calls>0,"real WebGL draw completed");
      check(initial.obstacleCoverage==="structures-only","coverage must stay explicit");
      const source=engine.parts.drivingSurfaceSource();
      const firstQuery=first.querySurface({x:0,z:0,layerId:"ground"});check(firstQuery.status==="current","initial bound query");
      engine.applyModel(model,true);
      const reusedSource=engine.parts.drivingSurfaceSource();
      check(reusedSource.ground===source.ground&&reusedSource.layout===source.layout,"actual static renderer cache reused");
      const reused=await engine.captureDrivingSurface();check(reused.status==="ready"&&reused.worldRevision===first.worldRevision,"same static content identity");
      check(first.readWorld()===null&&first.querySurface({x:0,z:0,layerId:"ground"}).status==="stale","rebuild invalidates old handles even on cache reuse");
      const layout=engine.currentLayout;
      const length=(e)=>e.points.slice(1).reduce((n,p,i)=>n+Math.hypot(p.x-e.points[i].x,p.z-e.points[i].z),0);
      const edge=layout.roadEdges.filter((e)=>!edgeLocked(e)&&length(e)>30).sort((a,b)=>a.id<b.id?-1:1)[0];check(edge,"editable visible road");
      const patch=emptyPlanPatch(layout.seed,layout.scaleTier);patch.roadOps=[{t:"restyle",edge:edge.id,width:edge.width===5?8:5}];
      engine.setPlanPatch(patch);
      check(engine.planPatched.stale.length===0,"actual repair accepted");
      const repaired=await engine.captureDrivingSurface();check(repaired.status==="ready"&&repaired.worldRevision!==reused.worldRevision,"repair changes frozen content");
      renderedBuffersMatch(repaired);engine.renderFrame();
      check(reused.readWorld()===null,"repair invalidates old source");
      check(engine.parts.drivingSurfaceSource().ground!==source.ground,"renderer cache rebuilt for repaired roads");
      const seamReport=repaired.checkLandings({maxStep:0.1,maxSlopeChange:0.3,aliasTolerance:0.1});
      check(seamReport?.snapshotRevision===repaired.worldRevision,"host seam evidence tied to current world");
      engine.setTimeCursor(model.windowStartMs,{playing:false});
      check(repaired.isCurrent(),"timeline leaves structural geometry unchanged; buildings are explicitly outside this snapshot");
      engine.setPlanPatch(null);
      const inFlight=engine.captureDrivingSurface();
      engine.setSeed(7);
      check((await inFlight).status==="stale","seed change during actual Web Crypto hash discards capture");
      check(repaired.readWorld()===null,"seed invalidates repaired handle");
      const seeded=await engine.captureDrivingSurface();check(seeded.status==="ready","new seed capture");
      engine.dispose();
      check(seeded.readWorld()===null&&seeded.querySurface({x:0,z:0,layerId:"ground"}).status==="stale","dispose invalidates reads and indices");
      check((await engine.captureDrivingSurface()).status==="unavailable","disposed host unavailable");
      return {initialRevision:first.worldRevision,repairedRevision:repaired.worldRevision,newSeedRevision:seeded.worldRevision,seams:seamReport.seams.length};
    } finally {engine.dispose();}
  },model);
  assert.deepEqual(errors,[]);assert.notEqual(result.initialRevision,result.repairedRevision);
  console.log(`Surface host browser: real WebGL draw, renderer/snapshot buffer equality, CityEngine/CityParts cache reuse, accepted repair, ${result.seams} bound seam reports, in-flight seed race and teardown passed. Synthetic 90-session model; no native bundle/performance claim.`);
} finally {await browser.close();}
