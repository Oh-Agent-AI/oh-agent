/** Explicit structural entry portals. Geometry continuity is necessary but never a road
 * release. Only existing facing boundary spans are used; XZ crossings elsewhere do not
 * create connections. Overlapping landings must cover the ENTIRE connecting ribbon on
 * both layers, including holes and islands. */
import type { CitySurfaceCompilation, StructureLanding } from "./compileSurface";
import type { BoundarySpan, CompiledCitySurface, SurfacePortal, Vec2 } from "./types";
import { checkLandingSeams } from "./landingSeams";
import { buildSurfaceIndex, type SurfaceTriangle } from "./SurfaceIndex";
import { buildSurfaceRegions, DEFAULT_SURFACE_REGION_PARAMS } from "./surfaceRegions";

export const LANDING_PORTAL_RULES_VERSION = 1;
export type LandingPortalOptions = Readonly<{
  maxStep: number; maxSlopeChange: number; aliasTolerance: number;
  maxOverlapDistance: number; maxCandidates: number; maxTests: number;
}>;
export const DEFAULT_LANDING_PORTAL_OPTIONS: LandingPortalOptions = Object.freeze({
  maxStep: 0.1, maxSlopeChange: 0.3, aliasTolerance: 0.1,
  maxOverlapDistance: 3, maxCandidates: 4096, maxTests: 1_000_000,
});
export type LandingPortalDecision = Readonly<{
  structureId: string; end: StructureLanding["end"];
  status: "connected" | "closed";
  reason: "connected" | "seam-blocked" | "no-facing-boundary" | "ribbon-uncovered" | "height-gap" | "slope-change";
  portalId: string | null;
}>;
export type LandingPortalBuild = Readonly<{
  status: "ready" | "unresolved";
  reason: "none" | "invalid-input" | "seams-unresolved" | "index-unresolved" | "regions-unresolved" | "budget";
  surface: CompiledCitySurface;
  rulesVersion: number;
  tests: number;
  decisions: readonly LandingPortalDecision[];
}>;

// Exact orientation of binary64 points; no geometric snapping. A shared collinear
// boundary is distinguished from an actual gap however small that gap is.
const binary = new DataView(new ArrayBuffer(8));
function dyadic(v: number): readonly [bigint, number] {
  binary.setFloat64(0,v,false);const bits=binary.getBigUint64(0,false);
  const exponent=Number((bits>>52n)&2047n),mantissa=bits&((1n<<52n)-1n);
  const n=exponent===0?mantissa:mantissa|(1n<<52n);
  return [(bits>>63n)?-n:n,exponent===0?-1074:exponent-1075];
}
function orientation(a:Vec2,b:Vec2,c:Vec2):bigint {
  const parts=[a.x,a.z,b.x,b.z,c.x,c.z].map(dyadic),exponent=Math.min(...parts.map((p)=>p[1]));
  const n=parts.map(([v,e])=>v<<BigInt(e-exponent));
  return (n[2]-n[0])*(n[5]-n[1])-(n[3]-n[1])*(n[4]-n[0]);
}
type Fraction={n:bigint;d:bigint};
const greater=(a:Fraction,b:Fraction)=>a.n*b.d>b.n*a.d;
function entersInterior(a:Vec2,b:Vec2,polygon:readonly Vec2[]):boolean {
  let lo:Fraction={n:0n,d:1n},hi:Fraction={n:1n,d:1n};
  const values:Array<readonly [bigint,bigint]>=[];
  for(let i=0;i<polygon.length;i++) {
    const p=polygon[i],q=polygon[(i+1)%polygon.length];
    const x=orientation(p,q,a),delta=orientation(p,q,b)-x;values.push([x,delta]);
    if(delta===0n){if(x<=0n)return false;continue;}
    let n=-x,d=delta;if(d<0n){n=-n;d=-d;}
    const at={n,d};
    if(delta>0n&&greater(at,lo))lo=at;
    if(delta<0n&&greater(hi,at))hi=at;
  }
  if(!greater(hi,lo))return false;
  const mid={n:lo.n*hi.d+hi.n*lo.d,d:2n*lo.d*hi.d};
  return values.every(([x,delta])=>x*mid.d+delta*mid.n>0n);
}
const cross=(a:Vec2,b:Vec2,c:Vec2)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
function clip(poly:readonly Vec2[],a:Vec2,b:Vec2,sign:number):Vec2[] {
  const out:Vec2[]=[];
  for(let i=0;i<poly.length;i++) {
    const p=poly[i],q=poly[(i+1)%poly.length],dp=sign*cross(a,b,p),dq=sign*cross(a,b,q);
    if(dp>=0)out.push(p);
    if((dp>=0)!==(dq>=0)){const t=dp/(dp-dq);out.push({x:p.x+(q.x-p.x)*t,z:p.z+(q.z-p.z)*t});}
  }
  return out;
}
const points=(t:SurfaceTriangle):Vec2[]=>[{x:t.ax,z:t.az},{x:t.bx,z:t.bz},{x:t.cx,z:t.cz}];
function intersect(poly:readonly Vec2[],triangle:SurfaceTriangle):Vec2[] {
  const p=points(triangle),sign=Math.sign(cross(p[0],p[1],p[2]));let result=[...poly];
  for(let i=0;i<3;i++)result=clip(result,p[i],p[(i+1)%3],sign);
  return result;
}
function height(t:SurfaceTriangle,p:Vec2):number {
  const d=(t.bz-t.cz)*(t.ax-t.cx)+(t.cx-t.bx)*(t.az-t.cz);
  const a=((t.bz-t.cz)*(p.x-t.cx)+(t.cx-t.bx)*(p.z-t.cz))/d;
  const b=((t.cz-t.az)*(p.x-t.cx)+(t.ax-t.cx)*(p.z-t.cz))/d;
  return a*t.ay+b*t.by+(1-a-b)*t.cy;
}
function normal(t:SurfaceTriangle):readonly number[] {
  const x=(t.by-t.ay)*(t.cz-t.az)-(t.bz-t.az)*(t.cy-t.ay);
  const y=(t.bz-t.az)*(t.cx-t.ax)-(t.bx-t.ax)*(t.cz-t.az);
  const z=(t.bx-t.ax)*(t.cy-t.ay)-(t.by-t.ay)*(t.cx-t.ax);
  const length=Math.hypot(x,y,z);return [x/length,y/length,z/length];
}
type Candidate={patchId:string;span:BoundarySpan;a:Vec2;b:Vec2};

export function buildLandingPortals(input:Pick<CitySurfaceCompilation,"surface"|"landings">,
  options:LandingPortalOptions=DEFAULT_LANDING_PORTAL_OPTIONS):LandingPortalBuild {
  const decisions:LandingPortalDecision[]=[],portals:SurfacePortal[]=[];let tests=0;
  const result=(reason:LandingPortalBuild["reason"]):LandingPortalBuild=>Object.freeze({
    status:reason==="none"?"ready":"unresolved",reason,rulesVersion:LANDING_PORTAL_RULES_VERSION,tests,decisions:Object.freeze(decisions),
    // Never publish a partial portal set on an unresolved build.
    surface:reason==="none"?Object.freeze({...input.surface,portals:Object.freeze([...input.surface.portals,...portals])}):input.surface,
  });
  if(![options.maxStep,options.aliasTolerance].every((n)=>Number.isFinite(n)&&n>=0)||!Number.isFinite(options.maxSlopeChange)||options.maxSlopeChange<0||options.maxSlopeChange>=Math.PI||
    !Number.isFinite(options.maxOverlapDistance)||options.maxOverlapDistance<=0||![options.maxCandidates,options.maxTests].every((n)=>Number.isSafeInteger(n)&&n>0))return result("invalid-input");
  if(input.surface.portals.some((p)=>p.id.startsWith("landing:")))return result("invalid-input");
  const identities=new Set<string>();
  for(const landing of input.landings) {
    const key=JSON.stringify([landing.structureId,landing.end]);
    if(identities.has(key))return result("invalid-input");identities.add(key);
  }
  const layered=input.landings.filter((l)=>l.layerId!=="ground");
  if(!layered.length)return result("none");
  const seamReport=checkLandingSeams({...input,revision:input.surface.revision},options);
  tests=seamReport.tests;
  if(seamReport.status!=="complete")return result("seams-unresolved");
  const continuous=layered.filter((l)=>seamReport.seams.some((s)=>s.patchId===l.patchId&&s.end===l.end&&s.status==="continuous"));
  for(const l of layered)if(!continuous.includes(l))decisions.push(Object.freeze({structureId:l.structureId,end:l.end,status:"closed",reason:"seam-blocked",portalId:null}));
  if(!continuous.length)return result("none");
  const index=buildSurfaceIndex(input.surface);if(index.status!=="ready")return result("index-unresolved");
  const regions=buildSurfaceRegions(input.surface,index,{...DEFAULT_SURFACE_REGION_PARAMS,aliasTolerance:options.aliasTolerance});
  if(regions.status!=="ready")return result("regions-unresolved");
  const patches=new Map(input.surface.patches.map((p)=>[p.id,p]));
  const spend=()=>++tests<=options.maxTests;
  for(const landing of continuous) {
    const from=patches.get(landing.patchId)!;const a=landing.seam.a,b=landing.seam.b;
    const width=Math.hypot(b.x-a.x,b.z-a.z),ux=(b.x-a.x)/width,uz=(b.z-a.z)/width;
    if(![landing.outX,landing.outZ].every(Number.isFinite)||Math.abs(Math.hypot(landing.outX,landing.outZ)-1)>1e-6||
      Math.abs(ux*landing.outX+uz*landing.outZ)>1e-5)return result("invalid-input");
    let fromSpan:BoundarySpan|null=null;
    for(let loop=0;loop<from.boundaryLoops.length;loop++) {
      const vertices=from.boundaryLoops[loop].vertices;
      for(let i=0;i<vertices.length;i++) {
        const p=vertices[i],q=vertices[(i+1)%vertices.length];
        if((p.x===a.x&&p.z===a.z&&q.x===b.x&&q.z===b.z)||(p.x===b.x&&p.z===b.z&&q.x===a.x&&q.z===a.z))fromSpan={loop,firstSegment:i,segmentCount:1};
      }
    }
    if(!fromSpan)return result("invalid-input");
    const center={x:(a.x+b.x)/2,z:(a.z+b.z)/2};
    const sourceRegion=regions.classify(center.x-landing.outX*0.05,center.z-landing.outZ*0.05,landing.layerId);
    const groundRegion=regions.classify(center.x+landing.outX*0.05,center.z+landing.outZ*0.05,"ground");
    const candidates:Candidate[]=[];
    if(sourceRegion.status==="drivable"&&groundRegion.status==="drivable") {
      const ground=regions.regionById(groundRegion.regionId)!;
      for(const patchId of ground.patchIds) {
        const patch=patches.get(patchId)!;
        if(patch.kind!=="carriageway"&&patch.kind!=="junction")continue;
        for(let loop=0;loop<patch.boundaryLoops.length;loop++) {
          const ring=patch.boundaryLoops[loop];if(ring.hole)continue;
          const origin=ring.vertices[0];
          const area=ring.vertices.reduce((sum,p,i)=>sum+cross(origin,p,ring.vertices[(i+1)%ring.vertices.length]),0);
          const winding=Math.sign(area);if(!winding)return result("invalid-input");
          if(ring.vertices.length>options.maxCandidates)return result("budget");
          const aligned=ring.vertices.map((p,i)=>{
            const q=ring.vertices[(i+1)%ring.vertices.length],dx=q.x-p.x,dz=q.z-p.z,len=Math.hypot(dx,dz);
            return len>0&&winding*(-dz*landing.outX+dx*landing.outZ)/len>0.999999&&
              Math.abs((p.x-a.x)*landing.outX+(p.z-a.z)*landing.outZ)<=options.maxOverlapDistance&&
              Math.abs((q.x-a.x)*landing.outX+(q.z-a.z)*landing.outZ)<=options.maxOverlapDistance;
          });
          for(let start=0;start<aligned.length;start++) {
            if(!spend())return result("budget");
            if(!aligned[start]||aligned[(start+aligned.length-1)%aligned.length])continue;
            let count=1;while(count<aligned.length&&aligned[(start+count)%aligned.length])count++;
            // BoundarySpan is non-wrapping by contract; a wrapped span stays closed.
            if(start+count>aligned.length)continue;
            const p=ring.vertices[start],q=ring.vertices[(start+count)%ring.vertices.length];
            if(Array.from({length:count+1},(_,i)=>ring.vertices[(start+i)%ring.vertices.length]).some((v)=>orientation(p,q,v)!==0n))continue;
            const lp=(p.x-a.x)*ux+(p.z-a.z)*uz,lq=(q.x-a.x)*ux+(q.z-a.z)*uz;
            if(Math.min(lp,lq)>0||Math.max(lp,lq)<width)continue;
            const at=(s:number):Vec2=>{const t=(s-lp)/(lq-lp);return {x:p.x+(q.x-p.x)*t,z:p.z+(q.z-p.z)*t};};
            if(candidates.length>=options.maxCandidates)return result("budget");
            candidates.push({patchId,span:{loop,firstSegment:start,segmentCount:count},a:at(0),b:at(width)});
          }
        }
      }
    }
    candidates.sort((a,b)=>a.patchId<b.patchId?-1:a.patchId>b.patchId?1:a.span.loop-b.span.loop||a.span.firstSegment-b.span.firstSegment);
    let chosen:SurfacePortal|null=null,reason:LandingPortalDecision["reason"]="no-facing-boundary";
    for(const candidate of candidates) {
      if(!spend())return result("budget");
      const p=candidate.a,q=candidate.b;
      const shared=orientation(a,b,p)===0n&&orientation(a,b,q)===0n;
      const depthP=-((p.x-a.x)*landing.outX+(p.z-a.z)*landing.outZ),depthQ=-((q.x-b.x)*landing.outX+(q.z-b.z)*landing.outZ);
      if(!shared&&(depthP<=0||depthQ<=0))continue; // a gap is never bridged by tolerance
      let maxHeightMismatch=0;
      if(!shared) {
        let quad:Vec2[]=[a,b,q,p];if(cross(quad[0],quad[1],quad[2])<0)quad=quad.reverse();
        if(quad.some((v,i)=>orientation(v,quad[(i+1)%4],quad[(i+2)%4])<=0n)){reason="ribbon-uncovered";continue;}
        const minX=Math.min(...quad.map((v)=>v.x)),maxX=Math.max(...quad.map((v)=>v.x)),minZ=Math.min(...quad.map((v)=>v.z)),maxZ=Math.max(...quad.map((v)=>v.z));
        let covered=true;
        for(const regionId of [sourceRegion.status==="drivable"?sourceRegion.regionId:"",groundRegion.status==="drivable"?groundRegion.regionId:""]) {
          const region=regions.regionById(regionId);if(!region){covered=false;break;}
          const middle={x:quad.reduce((n,v)=>n+v.x,0)/4,z:quad.reduce((n,v)=>n+v.z,0)/4};
          const state=regions.classify(middle.x,middle.z,region.layerId);
          if(state.status!=="drivable"||state.regionId!==regionId){covered=false;break;}
          const boundary=regions.segmentsInBox(regionId,minX,minZ,maxX,maxZ,options.maxCandidates);
          if(boundary.status!=="ok")return result(boundary.status==="budget"?"budget":"invalid-input");
          for(const segment of boundary.segments) {
            if(!spend())return result("budget");
            if(entersInterior({x:segment.ax,z:segment.az},{x:segment.bx,z:segment.bz},quad)){covered=false;break;}
          }
          if(!covered)break;
        }
        if(!covered){reason="ribbon-uncovered";continue;}
        const fromRefs=index.trianglesInBox({minX,minZ,maxX,maxZ,layerId:landing.layerId,maxResults:options.maxCandidates});
        const toRefs=index.trianglesInBox({minX,minZ,maxX,maxZ,layerId:"ground",kinds:["carriageway","junction"],maxResults:options.maxCandidates});
        if(fromRefs.status!=="ok"||toRefs.status!=="ok")return result("budget");
        let maxSlopeChange=0;
        for(const r of fromRefs.triangles)for(const s of toRefs.triangles) {
          if(!spend())return result("budget");
          const t=index.triangle(r)!,u=index.triangle(s)!;
          const overlap=intersect(intersect(quad,t),u);
          if(overlap.length<3||Math.abs(overlap.reduce((sum,p,i)=>sum+p.x*overlap[(i+1)%overlap.length].z-p.z*overlap[(i+1)%overlap.length].x,0))===0)continue;
          const nt=normal(t),nu=normal(u);
          const dot=nt.reduce((sum,n,i)=>sum+n*nu[i],0);
          maxSlopeChange=Math.max(maxSlopeChange,Math.acos(Math.max(-1,Math.min(1,dot))));
          for(const point of overlap)maxHeightMismatch=Math.max(maxHeightMismatch,Math.abs(height(t,point)-height(u,point)));
        }
        if(!Number.isFinite(maxHeightMismatch))return result("invalid-input");
        if(maxSlopeChange>options.maxSlopeChange+1e-9){reason="slope-change";continue;}
        if(maxHeightMismatch>options.maxStep+1e-6){reason="height-gap";continue;}
      } else {
        const seam=seamReport.seams.find((s)=>s.patchId===landing.patchId&&s.end===landing.end)!;
        maxHeightMismatch=Math.max(...seam.intervals.map((i)=>i.maxStep??0));
      }
      chosen=Object.freeze({id:`landing:${JSON.stringify([landing.structureId,landing.end,candidate.patchId])}`,fromPatch:landing.patchId,toPatch:candidate.patchId,
        fromBoundary:Object.freeze(fromSpan),toBoundary:Object.freeze(candidate.span),permittedDirection:"both",clearance:width,maxHeightMismatch,validated:true});
      portals.push(chosen);break;
    }
    decisions.push(Object.freeze({structureId:landing.structureId,end:landing.end,status:chosen?"connected":"closed",reason:chosen?"connected":reason,portalId:chosen?.id??null}));
  }
  return result("none");
}
