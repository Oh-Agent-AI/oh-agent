#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadCity } from "./city-kit/index.mjs";
const {makeRoadAuditHistory,saveRoadAuditHistory,loadRoadAuditHistory,makeInterruptedAuditHistory}=await loadCity({
  "game/RoadAuditHistory.ts":["makeRoadAuditHistory","saveRoadAuditHistory","loadRoadAuditHistory","makeInterruptedAuditHistory"],
});
let data=null;
const store={getItem:()=>data,setItem:(_key,value)=>{data=value;}};
const report={worldRevision:"world",manifestHash:"plan",coverage:{road:{passed:1,blocked:0,inconclusive:1,excluded:0}},
  results:[{routeId:"failed-case",verdict:"inconclusive",cause:"pilot-failed",detail:"run:pilot-failed"}]};
const diagnostics={summaries:[],truncated:false,clips:[{caseId:"failed-case",clip:{kind:"mandatory",truncated:true,
  frames:[{tick:12,input:{forward:true,backward:false,left:true,right:false},previous:null,
    next:{x:1,y:2,z:3,heading:0.1,speed:4,surfaceId:"private-internal-state"}}]}}]};
const row=makeRoadAuditHistory(report,{status:"not-published",reason:"mandatory-coverage-incomplete"},"diagnostic",diagnostics,1000);
assert.equal(saveRoadAuditHistory(row,store),true);
let read=loadRoadAuditHistory(store);
assert.equal(read.length,1);assert.equal(read[0].clips[0].frames[0].buttons,"WA");
assert.ok(!data.includes("private-internal-state"),"the archive projects positions/buttons, never internal source or support objects");
const tampered=JSON.parse(data);tampered.entries[0].graph={ready:true};tampered.entries[0].credential="injected";
data=JSON.stringify(tampered);read=loadRoadAuditHistory(store);
assert.equal(read[0].graph,undefined);assert.equal(read[0].credential,undefined);
for(let i=1;i<=12;i++)assert.equal(saveRoadAuditHistory({...row,id:`run-${i}`,at:1000+i},store),true);
read=loadRoadAuditHistory(store);assert.equal(read.length,8);assert.equal(read[0].id,"run-12");
assert.ok(data.length*2<=512*1024);
assert.equal(saveRoadAuditHistory(row,{getItem:()=>null,setItem:()=>{throw Error("quota");}}),false);
assert.equal(saveRoadAuditHistory(row,null),false);
const large={...row,id:"large",failures:Array.from({length:100},(_,i)=>({caseId:`${i}:`+"x".repeat(2040),verdict:"inconclusive",cause:"budget-exhausted",detail:"d".repeat(256)})),
 clips:Array.from({length:4},(_,i)=>({...row.clips[0],caseId:`clip-${i}`,frames:Array.from({length:120},(_,tick)=>({tick,x:123456.123456,y:123456.123456,z:123456.123456,speed:123456.123456,heading:123456.123456,buttons:"WASD"}))}))};
data=null;
assert.equal(saveRoadAuditHistory(large,store),true);
read=loadRoadAuditHistory(store);
assert.ok(data.length*2<=512*1024,"the serialized byte cap is enforced even for a single large record");
assert.equal(read[0].clips.length,0,"oversized clips are dropped before the summary");
assert.equal(read[0].truncated,true);
assert.equal(read[0].failures.length,100);
for(const bad of ["not-json",JSON.stringify({version:2,entries:[]}),"x".repeat(512*1024)]){
 data=bad;assert.equal(loadRoadAuditHistory(store).length,0);
}
for(const change of [r=>r.clips[0].frames[0].x=Infinity,r=>r.clips[0].frames[0].x=1e100,
  r=>r.clips[0].frames[0].tick=-1,r=>r.clips[0].frames[0].buttons="secret",r=>r.clips[0].frames=Array(121).fill(r.clips[0].frames[0])]){
 const invalid=structuredClone(row);change(invalid);assert.equal(saveRoadAuditHistory(invalid,store),false);
}
const interrupted=makeInterruptedAuditHistory("world","diagnostic",[],100,"audit-time-limit",2000);
assert.equal(interrupted.publication,"not-published");assert.equal(interrupted.counts.passed,0);
assert.equal(interrupted.counts.inconclusive,100);assert.equal(interrupted.truncated,true);
// Render the actual history UI: a historical success must not reactivate a
// live permission or enable relocation into a different captured city.
const repo=path.resolve(import.meta.dirname,"..");
const {buildSync}=createRequire(path.join(repo,"apps/desktop/ui-dev/package.json"))("esbuild");
const temporary=mkdtempSync(path.join(os.tmpdir(),"city-audit-history-"));
try {
 const output=buildSync({stdin:{contents:`
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { RoadAuditHistoryPanel } from './src/game/ui/RoadAuditHistoryPanel';
  export const render = (entry,capture) => renderToStaticMarkup(React.createElement(RoadAuditHistoryPanel,
    {entries:[entry],saved:false,capture,engineRef:{current:null},en:true}));
 `,resolveDir:path.join(repo,"apps/agent-city/ui"),loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",
 banner:{js:'import { createRequire as nodeRequire } from "node:module"; const require = nodeRequire(import.meta.url);'}});
 const target=path.join(temporary,"history.mjs");writeFileSync(target,output.outputFiles[0].contents);
 const {render}=await import(pathToFileURL(target).href);
 const prior={...row,publication:"published"};
 for(const capture of [null,{worldRevision:"other-world",isLeaseCurrent:()=>true},{worldRevision:"world",isLeaseCurrent:()=>false}]){
  const html=render(prior,capture);
  assert.match(html,/Past strict-policy verification/);
  assert.match(html,/never restores a graph, lease or driving permission/);
  assert.match(html,/<button type="button" disabled="">Locate recorded position/);
  assert.match(html,/Local storage unavailable/);
 }
 const live=render(prior,{worldRevision:"world",isLeaseCurrent:()=>true});
 assert.match(live,/<button type="button">Locate recorded position/);
 assert.match(live,/type="range"/);
} finally {rmSync(temporary,{recursive:true,force:true});}
console.log("Road audit local history: bounded FIFO, diagnostic-only projection, quota/corrupt-store degradation, failure frames and interrupted coverage passed.");
