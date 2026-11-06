/** Local diagnostic history only. No graph/lease/credential is persisted or restored. */
import type { RoadAuditDiagnostics } from "./RoadAuditDiagnostics";
import type { AuditPlanReport } from "./driving/audit/RoadAuditPlanner";
import type { RoadAuditPublication, RoadAuditPhase } from "./RoadAuditWorker";
export type AuditHistoryFrame = Readonly<{tick:number;x:number;y:number;z:number;speed:number;heading:number;buttons:string}>;
export type AuditHistoryClip = Readonly<{caseId:string;phase:RoadAuditPhase;truncated:boolean;frames:readonly AuditHistoryFrame[]}>;
export type RoadAuditHistoryEntry = Readonly<{
  id:string;at:number;worldRevision:string;phase:RoadAuditPhase;publication:"published"|"not-published";reason:string;
  counts:Readonly<{passed:number;blocked:number;inconclusive:number;excluded:number}>;
  failures:readonly Readonly<{caseId:string;verdict:"blocked"|"inconclusive";cause:string;detail:string}>[];
  clips:readonly AuditHistoryClip[];truncated:boolean;
}>;
export type AuditHistoryStorage = Pick<Storage,"getItem"|"setItem">;
const KEY="city-road-audit-history-v1";
const MAX_BYTES=512*1024;
const MAX_ENTRIES=8;
function storage():AuditHistoryStorage|null { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } }
const text=(v:unknown,n:number):v is string=>typeof v==="string"&&v.length<=n;
const natural=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
function clean(value:unknown):RoadAuditHistoryEntry|null {
  if(!value||typeof value!=="object")return null;
  const row=value as RoadAuditHistoryEntry;
  if(!text(row.id,256)||!natural(row.at)||!text(row.worldRevision,256)||!text(row.reason,256)||
    !["diagnostic","final-replay"].includes(row.phase)||!["published","not-published"].includes(row.publication)||
    !row.counts||![row.counts.passed,row.counts.blocked,row.counts.inconclusive,row.counts.excluded].every(natural)||
    typeof row.truncated!=="boolean"||!Array.isArray(row.failures)||row.failures.length>100||!Array.isArray(row.clips)||row.clips.length>4)return null;
  const failures:RoadAuditHistoryEntry["failures"][number][]=[];
  for(const item of row.failures){
    if(!item||!text(item.caseId,2048)||!["blocked","inconclusive"].includes(item.verdict)||!text(item.cause,128)||!text(item.detail,256))return null;
    failures.push({caseId:item.caseId,verdict:item.verdict,cause:item.cause,detail:item.detail});
  }
  const clips:AuditHistoryClip[]=[];
  for(const clip of row.clips){
    if(!clip||!text(clip.caseId,2048)||!["diagnostic","final-replay"].includes(clip.phase)||typeof clip.truncated!=="boolean"||!Array.isArray(clip.frames)||clip.frames.length>120)return null;
    const frames:AuditHistoryFrame[]=[];
    let tick=-1;
    for(const f of clip.frames){
      if(!f||!natural(f.tick)||f.tick<=tick||![f.x,f.y,f.z,f.speed,f.heading].every((n)=>Number.isFinite(n)&&Math.abs(n)<=10_000_000)||!text(f.buttons,4)||!/^[WSAD]*$/.test(f.buttons))return null;
      tick=f.tick;frames.push({tick:f.tick,x:f.x,y:f.y,z:f.z,speed:f.speed,heading:f.heading,buttons:f.buttons});
    }
    clips.push({caseId:clip.caseId,phase:clip.phase,truncated:clip.truncated,frames});
  }
  // Project known fields; unknown persisted properties never reach the UI or become authorization.
  return {id:row.id,at:row.at,worldRevision:row.worldRevision,phase:row.phase,publication:row.publication,reason:row.reason,
    counts:{passed:row.counts.passed,blocked:row.counts.blocked,inconclusive:row.counts.inconclusive,excluded:row.counts.excluded},failures,clips,truncated:row.truncated};
}
export function loadRoadAuditHistory(target:AuditHistoryStorage|null=storage()):readonly RoadAuditHistoryEntry[] {
  try {
    const raw=target?.getItem(KEY);if(!raw||raw.length*2>MAX_BYTES)return [];
    const data=JSON.parse(raw);if(data?.version!==1||!Array.isArray(data.entries)||data.entries.length>MAX_ENTRIES)return [];
    return data.entries.map(clean).filter((item:RoadAuditHistoryEntry|null):item is RoadAuditHistoryEntry=>item!==null);
  } catch { return []; }
}
export function makeRoadAuditHistory(report:AuditPlanReport,publication:RoadAuditPublication,phase:RoadAuditPhase,diagnostics:RoadAuditDiagnostics,at=Date.now()):RoadAuditHistoryEntry {
  const counts={passed:0,blocked:0,inconclusive:0,excluded:0};
  for(const coverage of Object.values(report.coverage)){
    counts.passed+=coverage.passed;counts.blocked+=coverage.blocked;counts.inconclusive+=coverage.inconclusive;counts.excluded+=coverage.excluded;
  }
  const failed=report.results.filter((row)=>row.verdict!=="passed");
  const clips:AuditHistoryClip[]=diagnostics.clips.slice(0,4).map(({caseId,clip})=>({caseId,phase:clip.kind==="boundary-replay"?"final-replay":"diagnostic",truncated:clip.truncated,
    frames:clip.frames.flatMap((f)=>{const state=f.next??f.previous;return state?[{tick:f.tick,x:state.x,y:state.y,z:state.z,speed:state.speed,heading:state.heading,
      buttons:(f.input.forward?"W":"")+(f.input.backward?"S":"")+(f.input.left?"A":"")+(f.input.right?"D":"")}]:[];})}));
  return {id:`${at}:${report.manifestHash}`,at,worldRevision:report.worldRevision,phase,publication:publication.status,
    reason:publication.status==="published"?"verified-strict-audit-policy":publication.reason,counts,
    failures:failed.slice(0,100).map((row)=>({caseId:row.routeId,verdict:row.verdict as "blocked"|"inconclusive",cause:row.cause,detail:row.detail.slice(0,256)})),
    clips,truncated:diagnostics.truncated||failed.length>100};
}
export function saveRoadAuditHistory(entry:RoadAuditHistoryEntry,target:AuditHistoryStorage|null=storage()):boolean {
  if(!target)return false;
  try {
    const row=clean(entry);if(!row)return false;
    const entries=[row,...loadRoadAuditHistory(target).filter((old)=>old.id!==row.id)].slice(0,MAX_ENTRIES);
    let raw=JSON.stringify({version:1,entries});
    while(raw.length*2>MAX_BYTES&&entries.length>1){entries.pop();raw=JSON.stringify({version:1,entries});}
    if(raw.length*2>MAX_BYTES){entries[0]={...row,clips:[],truncated:true};raw=JSON.stringify({version:1,entries});}
    if(raw.length*2>MAX_BYTES)return false;
    target.setItem(KEY,raw);return true;
  } catch { return false; }
}
/** Cancellation/timeout records stay diagnostic: the unknown remainder is never counted as passed. */
export function makeInterruptedAuditHistory(worldRevision:string,phase:RoadAuditPhase,results:AuditPlanReport["results"],total:number,reason:string,at=Date.now()):RoadAuditHistoryEntry {
  const counts={passed:0,blocked:0,inconclusive:Math.max(0,total-results.length),excluded:0};
  for(const result of results)counts[result.verdict]++;
  const failed=results.filter((row)=>row.verdict!=="passed");
  return {id:`${at}:interrupted`,at,worldRevision,phase,publication:"not-published",reason:reason.slice(0,256),counts,
    failures:failed.slice(0,100).map((row)=>({caseId:row.routeId,verdict:row.verdict as "blocked"|"inconclusive",cause:row.cause,detail:row.detail.slice(0,256)})),
    clips:[],truncated:true};
}
