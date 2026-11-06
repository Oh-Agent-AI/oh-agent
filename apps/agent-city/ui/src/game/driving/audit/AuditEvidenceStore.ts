/** Local presentation only. No disk, IPC, export, timers or manual-driving recorder.
 * A single active evidence epoch owns all retained records in this JS runtime;
 * replacing it clears the previous epoch and invalidates every old handle.
 * Run summaries are diagnostics, never road-release certificates. */
import { auditKeyId } from "./AuditIdentity";
import { validDrivingState } from "../DrivingKernel";
import type { DrivingInputState, DrivingState } from "../../DrivingSimulation";
import type { AuditKey, RoadAuditCase, RoadAuditCaseResult } from "./contracts";

export const AUDIT_EVIDENCE_VERSION = 1;
export type EvidenceLimits = Readonly<{
  maxTicksPerClip:number; maxFailureClips:number; maxSummaries:number;
  maxActiveCases:number; maxBytes:number; maxIdentifierLength:number;maxKeyVariants:number;
}>;
export const DEFAULT_EVIDENCE_LIMITS:EvidenceLimits=Object.freeze({
  maxTicksPerClip:600,maxFailureClips:32,maxSummaries:4096,maxActiveCases:4,
  maxBytes:8*1024*1024,maxIdentifierLength:2048,maxKeyVariants:16,
});
export type EvidenceScope=Readonly<{owner:object;isCurrent():boolean;currentKey():AuditKey|null}>;
export type EvidenceFrame=Readonly<{
  tick:number; input:Readonly<DrivingInputState>;
  previous:Readonly<DrivingState>|null; next:Readonly<DrivingState>|null;
  invalidState:boolean;
}>;
export type RunEvidenceSummary=Readonly<{
  key:AuditKey;kind:"mandatory"|"alternate-controller"|"reduced-speed"|"boundary-replay";sourceCaseId:string|null;
  caseId:string; verdict:RoadAuditCaseResult["verdict"]; cause:RoadAuditCaseResult["cause"];
  simulatedTicks:number; evidence:string|null; truncated:boolean;
  evidenceStatus:"retained"|"evicted"|"not-recorded";
}>;
export type EvidenceClip=Readonly<{key:AuditKey;kind:RunEvidenceSummary["kind"];sourceCaseId:string|null;caseId:string;frames:readonly EvidenceFrame[];truncated:boolean}>;
export interface AuditEvidenceCapture {
  record(tick:number,input:Readonly<DrivingInputState>,previous:Readonly<DrivingState>,next:Readonly<DrivingState>):void;
  finish(result:RoadAuditCaseResult):void;
  discard():void;
}
/** Only the automatic audit runner calls this capability. It has no read/export API. */
export interface AuditEvidenceSink {
  begin(key:AuditKey,test:RoadAuditCase):AuditEvidenceCapture|null;
  invalidate():void;
}
type Entry={id:number;keyToken:number;caseId:string;slots:(string|undefined)[];head:number;count:number;base:number;truncated:boolean;lastTick:number};
type Row={json:string;bytes:number;handle:string|null;keyToken:number};
type KeyVariant={identity:string;json:string;kind:RunEvidenceSummary["kind"];sourceCaseId:string|null};
let activeEpoch:AuditEvidenceStore|null=null;
let epochSerial=0;
// Charge stored strings conservatively: >= UTF-8 payload, UTF-16 backing and slot overhead.
// This bounds retained diagnostic records, not JS heap/temporary read copies or the whole app.
const bytes=(json:string)=>6*json.length+256;
const ownKey=(k:AuditKey):AuditKey=>({
  baseSnapshotHash:k.baseSnapshotHash,vehicleConfigHash:k.vehicleConfigHash,kernelBuildId:k.kernelBuildId,
  surfaceVersion:k.surfaceVersion,queryVersion:k.queryVersion,snapshotCompilerVersion:k.snapshotCompilerVersion,
  physicsVersion:k.physicsVersion,collisionVersion:k.collisionVersion,controllerVersion:k.controllerVersion,
  plannerVersion:k.plannerVersion,observerVersion:k.observerVersion,manifestHash:k.manifestHash,
  releasePolicyVersion:k.releasePolicyVersion,releaseBoundaryHash:k.releaseBoundaryHash,
});
const frozenState=(s:Readonly<DrivingState>,limit:number):Readonly<DrivingState>|null=>{
  if(!s||typeof s!=="object"||!validDrivingState(s)||s.surfaceId.length>limit)return null;
  return Object.freeze({x:s.x,y:s.y,z:s.z,heading:s.heading,speed:s.speed,steering:s.steering,
    distance:s.distance,braking:s.braking,reversing:s.reversing,pitch:s.pitch,roll:s.roll,surfaceId:s.surfaceId});
};
export class AuditEvidenceStore {
  private scope:EvidenceScope|null;
  private readonly identity:string;
  private readonly primary:AuditKey;
  private readonly variants=new Map<number,KeyVariant>();
  private readonly limits:EvidenceLimits;
  private readonly epoch:number;
  private serial=0;
  private used=0;
  private closed=false;
  private readonly active=new Map<number,Entry>();
  private readonly clips=new Map<string,Entry>();
  private readonly rows=new Map<string,Row>();
  private readonly totals={passed:0,blocked:0,inconclusive:0,droppedFrames:0,droppedCaptures:0,evictedClips:0,evictedSummaries:0};
  constructor(key:AuditKey,scope:EvidenceScope,limits:Partial<EvidenceLimits>={}) {
    this.limits=Object.freeze({...DEFAULT_EVIDENCE_LIMITS,...limits});
    if(Object.values(this.limits).some(n=>!Number.isSafeInteger(n)||n<1)||this.limits.maxTicksPerClip>10000||
      this.limits.maxActiveCases>64||this.limits.maxKeyVariants>64||this.limits.maxIdentifierLength>65536||this.limits.maxBytes>64*1024*1024)throw new Error("invalid-evidence-limits");
    if(!scope.owner||typeof scope.owner!=="object"||typeof scope.isCurrent!=="function"||typeof scope.currentKey!=="function")throw new Error("invalid-evidence-scope");
    if(Object.values(ownKey(key)).some(v=>typeof v==="string"&&v.length>this.limits.maxIdentifierLength))throw new Error("evidence-key-too-large");
    this.primary=Object.freeze(ownKey(key));this.identity=auditKeyId(this.primary);
    this.scope=Object.freeze({owner:scope.owner,isCurrent:scope.isCurrent,currentKey:scope.currentKey});
    const json=JSON.stringify(this.primary);
    this.variants.set(0,{identity:this.identity,json,kind:"mandatory",sourceCaseId:null});
    this.used=bytes(this.identity)+bytes(json)+256;
    if(this.used>this.limits.maxBytes)throw new Error("evidence-key-budget");
    if(epochSerial>=Number.MAX_SAFE_INTEGER)throw new Error("evidence-epoch-exhausted");
    this.epoch=++epochSerial;
    if(!this.allowed(scope.owner))throw new Error("stale-evidence-scope");
    activeEpoch?.invalidate();activeEpoch=this;
  }
  private count(field:keyof typeof this.totals,n=1){this.totals[field]=Math.min(Number.MAX_SAFE_INTEGER,this.totals[field]+n);}
  private allowed(owner:object):boolean {
    if(this.closed||this.scope?.owner!==owner)return false;
    try{const key=this.scope.currentKey();if(this.scope.isCurrent()&&key&&auditKeyId(key)===this.identity)return true;}catch{/* stale/failed host check */}
    this.invalidate();return false;
  }
  private pop(entry:Entry) {
    if(!entry.count)return;
    const json=entry.slots[entry.head]!;
    entry.slots[entry.head]=undefined;entry.head=(entry.head+1)%this.limits.maxTicksPerClip;entry.count--;
    this.used-=bytes(json);entry.truncated=true;this.count("droppedFrames");
  }
  private release(entry:Entry) {
    for(let i=0;i<entry.count;i++)this.used-=bytes(entry.slots[(entry.head+i)%this.limits.maxTicksPerClip]!);
    entry.count=0;
    entry.slots.length=0;this.used-=entry.base;
  }
  private evictClip():boolean {
    const first=this.clips.entries().next().value;if(!first)return false;
    this.clips.delete(first[0]);this.release(first[1]);this.count("evictedClips");return true;
  }
  private evictSummary():boolean {
    const first=this.rows.entries().next().value;if(!first)return false;
    this.rows.delete(first[0]);this.used-=first[1].bytes;this.count("evictedSummaries");return true;
  }
  private room(required:number):boolean {
    while(this.used+required>this.limits.maxBytes&&this.evictClip()){}
    while(this.used+required>this.limits.maxBytes&&this.evictSummary()){}
    for(const entry of this.active.values())while(this.used+required>this.limits.maxBytes&&entry.count)this.pop(entry);
    return this.used+required<=this.limits.maxBytes;
  }
  private invalidate() {
    if(this.closed)return;this.closed=true;
    for(const entry of this.active.values())this.release(entry);
    for(const entry of this.clips.values())this.release(entry);
    this.active.clear();this.clips.clear();this.rows.clear();this.variants.clear();this.used=0;this.scope=null;
    if(activeEpoch===this)activeEpoch=null;
  }
  dispose(owner:object):void {if(this.scope?.owner===owner)this.invalidate();}
  sink(owner:object):AuditEvidenceSink|null {
    if(!this.allowed(owner))return null;
    return this.boundSink(owner,0);
  }
  /** Diagnostic conditions get their own full key and labelled records. They cannot
   * overwrite the first mandatory failure or change its release-policy identity. */
  variantSink(owner:object,key:AuditKey,kind:Exclude<RunEvidenceSummary["kind"],"mandatory">,sourceCaseId:string|null):AuditEvidenceSink|null {
    if(!this.allowed(owner)||!["alternate-controller","reduced-speed","boundary-replay"].includes(kind))return null;
    if(sourceCaseId!==null&&(typeof sourceCaseId!=="string"||!sourceCaseId||sourceCaseId.length>this.limits.maxIdentifierLength))return null;
    let identity:string;
    try{identity=auditKeyId(key);}catch{return null;}
    if(identity===this.identity||this.variants.size>=this.limits.maxKeyVariants||
      Object.values(ownKey(key)).some(v=>typeof v==="string"&&v.length>this.limits.maxIdentifierLength))return null;
    // Same physical world and verifier; only explicitly diagnostic planning/controller
    // conditions or a final boundary replay may vary inside this evidence epoch.
    if(auditKeyId({...key,manifestHash:this.primary.manifestHash,controllerVersion:this.primary.controllerVersion,
      plannerVersion:this.primary.plannerVersion,releaseBoundaryHash:this.primary.releaseBoundaryHash})!==this.identity)return null;
    if(kind==="boundary-replay") {if(!key.releaseBoundaryHash||key.releaseBoundaryHash===this.primary.releaseBoundaryHash)return null;}
    else {
      const first=sourceCaseId&&this.rows.get("0:"+sourceCaseId);
      if(!first||JSON.parse(first.json).verdict==="passed")return null;
    }
    const variant={identity,json:JSON.stringify(ownKey(key)),kind,sourceCaseId},charge=bytes(identity)+bytes(variant.json)+bytes(sourceCaseId??"");
    if(!this.room(charge))return null;
    const token=this.variants.size;this.variants.set(token,variant);this.used+=charge;
    return this.boundSink(owner,token);
  }
  private boundSink(owner:object,keyToken:number):AuditEvidenceSink {
    return Object.freeze({
      begin:(key:AuditKey,test:RoadAuditCase)=>this.begin(owner,key,test,keyToken),
      invalidate:()=>{if(this.scope?.owner===owner)this.invalidate();},
    });
  }
  private begin(owner:object,key:AuditKey,test:RoadAuditCase,keyToken:number):AuditEvidenceCapture|null {
    if(!this.allowed(owner))return null;
    const variant=this.variants.get(keyToken);if(!variant)return null;
    let matches=false;try{matches=auditKeyId(key)===variant.identity;}catch{/* invalid caller key */}
    const maxTicks=test.maxTicks,rowId=keyToken+":"+test.id;
    if(!matches||!test.id||test.id.length>this.limits.maxIdentifierLength||!Number.isSafeInteger(test.maxTicks)||test.maxTicks<1||
      this.serial>=Number.MAX_SAFE_INTEGER||
      this.active.size>=this.limits.maxActiveCases||this.rows.has(rowId)||
      [...this.active.values()].some(e=>e.caseId===test.id&&e.keyToken===keyToken)){this.count("droppedCaptures");return null;}
    const base=bytes(test.id)+this.limits.maxTicksPerClip*8+256;
    if(!this.room(base)){this.count("droppedCaptures");return null;}
    const entry:Entry={id:++this.serial,keyToken,caseId:test.id,slots:new Array(this.limits.maxTicksPerClip),head:0,count:0,base,truncated:false,lastTick:0};
    this.active.set(entry.id,entry);this.used+=base;
    const live=()=>this.allowed(owner)&&this.active.get(entry.id)===entry;
    const discard=()=>{if(this.active.delete(entry.id))this.release(entry);};
    return Object.freeze({
      record:(tick:number,input:Readonly<DrivingInputState>,previous:Readonly<DrivingState>,next:Readonly<DrivingState>)=>{
        if(!live())return;
        if(!Number.isSafeInteger(tick)||tick<=entry.lastTick||tick>maxTicks||!input||![input.forward,input.backward,input.left,input.right].every(v=>typeof v==="boolean")){
          entry.truncated=true;this.count("droppedFrames");return;
        }
        if(tick!==entry.lastTick+1)entry.truncated=true;
        entry.lastTick=tick;
        const before=frozenState(previous,this.limits.maxIdentifierLength),after=frozenState(next,this.limits.maxIdentifierLength);
        const frame:EvidenceFrame={tick,input:{forward:input.forward,backward:input.backward,left:input.left,right:input.right},
          previous:before,next:after,invalidState:before===null||after===null};
        const json=JSON.stringify(frame),charge=bytes(json);
        if(entry.count===this.limits.maxTicksPerClip)this.pop(entry);
        if(!this.room(charge)){entry.truncated=true;this.count("droppedFrames");return;}
        entry.slots[(entry.head+entry.count)%this.limits.maxTicksPerClip]=json;entry.count++;this.used+=charge;
      },
      finish:(result:RoadAuditCaseResult)=>{
        if(!live())return;
        let matches=false;try{matches=auditKeyId(result.key)===variant.identity;}catch{/* invalid result key */}
        if(result.caseId!==entry.caseId||!matches||!["passed","blocked","inconclusive"].includes(result.verdict)||
          !["none","topology-disconnected","geometry-blocked","pilot-failed","simulation-invalid","route-deviation","budget-exhausted","cancelled","unconfirmed"].includes(result.cause)||
          !Number.isSafeInteger(result.simulatedTicks)||result.simulatedTicks<entry.lastTick||result.simulatedTicks>maxTicks||
          (result.verdict==="passed"&&(result.cause!=="none"||result.simulatedTicks<1))){discard();this.count("droppedCaptures");return;}
        this.count(result.verdict);
        let handle:string|null=null;
        if(result.verdict!=="passed"&&result.cause!=="cancelled"&&entry.count){
          while(this.clips.size>=this.limits.maxFailureClips)this.evictClip();
          handle="audit-failure:"+this.epoch+":"+entry.id;this.clips.set(handle,entry);
          this.active.delete(entry.id);
        }else discard();
        const json=JSON.stringify({caseId:entry.caseId,verdict:result.verdict,cause:result.cause,simulatedTicks:result.simulatedTicks,truncated:entry.truncated});
        const charge=bytes(json)+192;
        while(this.rows.size>=this.limits.maxSummaries)this.evictSummary();
        if(this.room(charge)){this.rows.set(rowId,{json,bytes:charge,handle,keyToken});this.used+=charge;}
        else this.count("evictedSummaries");
      },
      discard,
    });
  }
  summaries(owner:object):readonly RunEvidenceSummary[]|null {
    if(!this.allowed(owner))return null;
    return Object.freeze([...this.rows.values()].map(row=>{
      const retained=row.handle!==null&&this.clips.has(row.handle),summary=JSON.parse(row.json);
      const variant=this.variants.get(row.keyToken)!;
      return Object.freeze({...summary,key:Object.freeze(JSON.parse(variant.json)),kind:variant.kind,sourceCaseId:variant.sourceCaseId,evidence:retained?row.handle:null,
        evidenceStatus:retained?"retained":row.handle?"evicted":"not-recorded",truncated:summary.truncated||(row.handle!==null&&!retained)});
    }));
  }
  read(owner:object,handle:string):EvidenceClip|null {
    if(!this.allowed(owner))return null;
    const entry=this.clips.get(handle);if(!entry)return null;
    const frames:EvidenceFrame[]=[];
    for(let i=0;i<entry.count;i++){
      const f=JSON.parse(entry.slots[(entry.head+i)%this.limits.maxTicksPerClip]!);
      frames.push(Object.freeze({...f,input:Object.freeze(f.input),previous:f.previous&&Object.freeze(f.previous),next:f.next&&Object.freeze(f.next)}));
    }
    const variant=this.variants.get(entry.keyToken)!;
    return Object.freeze({key:Object.freeze(JSON.parse(variant.json)),kind:variant.kind,sourceCaseId:variant.sourceCaseId,
      caseId:entry.caseId,frames:Object.freeze(frames),truncated:entry.truncated});
  }
  stats(owner:object) {
    if(!this.allowed(owner))return null;
    return Object.freeze({...this.totals,retainedBytes:this.used,maxBytes:this.limits.maxBytes,
      activeCases:this.active.size,failureClips:this.clips.size,summaries:this.rows.size,version:AUDIT_EVIDENCE_VERSION});
  }
}
