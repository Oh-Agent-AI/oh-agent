/** Exact cross-section diagnostics at actual deck end edges. Intersecting all ground
 * triangles with the seam partitions the WHOLE width; midpoint-only or uniform samples
 * can miss a narrow gap/island. This proves a cross-section, not an approach corridor,
 * swept car coverage, or an open cross-layer portal. */
import { buildSurfaceIndex, type SurfaceTriangle } from "./SurfaceIndex";
import type { CitySurfaceCompilation, StructureLanding } from "./compileSurface";

export const LANDING_SEAM_CHECKS_VERSION = 2;
type P3 = Readonly<{ x: number; y: number; z: number }>;
export type LandingSeamOptions = Readonly<{
  maxStep: number;
  maxSlopeChange: number;
  aliasTolerance: number;
  maxCandidates?: number;
  maxTests?: number;
}>;
export type SeamReason = "none" | "no-ground" | "island" | "height-gap" | "slope-change" | "ambiguous-ground" | "boundary-unresolved" | "budget" | "invalid-input";
export type SeamInterval = Readonly<{
  from: number; to: number;
  reason: SeamReason;
  maxStep: number | null; maxSlopeChange: number | null;
  witness: Readonly<{ x: number; z: number; deckY: number; groundY: number | null }>;
}>;
export type LandingSeam = Readonly<{
  structureId: string; end: StructureLanding["end"]; patchId: string;
  portalRequired: boolean;
  status: "continuous" | "blocked" | "unresolved";
  width: number;
  intervals: readonly SeamInterval[];
  /** Fractions along the actual seam, before vehicle margins. Does not create portals. */
  continuousSpans: readonly Readonly<{ from: number; to: number; width: number }>[];
}>;
export type LandingSeamReport = Readonly<{
  status: "complete" | "unresolved";
  reason: "none" | "invalid-input" | "index" | "budget" | "boundary-unresolved" | "precision";
  scope: "boundary-cross-section";
  snapshotRevision: string; checksVersion: number;
  options: Readonly<{ maxStep: number; maxSlopeChange: number; aliasTolerance: number }>;
  tests: number;
  seams: readonly LandingSeam[];
}>;
type Ratio = Readonly<{n:bigint;d:bigint}>;
const compare=(a:Ratio,b:Ratio)=>{const v=a.n*b.d-b.n*a.d;return v<0n?-1:v>0n?1:0;};
const numberOf=(r:Ratio)=>Number(r.n)/Number(r.d);
const zero:Ratio={n:0n,d:1n},one:Ratio={n:1n,d:1n};
type Interval = { lo: Ratio; hi: Ratio; y0: number; y1: number; angle: number; island: boolean; unresolved: boolean; patchId: string; triangle: number };
const at = (a: P3, b: P3, t: number): P3 => ({ x: a.x+(b.x-a.x)*t,y: a.y+(b.y-a.y)*t,z: a.z+(b.z-a.z)*t });
const weights = (t: SurfaceTriangle, p: P3): [number,number,number] => {
  const d=(t.bz-t.cz)*(t.ax-t.cx)+(t.cx-t.bx)*(t.az-t.cz);
  const a=((t.bz-t.cz)*(p.x-t.cx)+(t.cx-t.bx)*(p.z-t.cz))/d;
  const b=((t.cz-t.az)*(p.x-t.cx)+(t.ax-t.cx)*(p.z-t.cz))/d;
  return [a,b,1-a-b];
};
const normal = (t: SurfaceTriangle): P3 => {
  const x=(t.by-t.ay)*(t.cz-t.az)-(t.bz-t.az)*(t.cy-t.ay);
  const y=(t.bz-t.az)*(t.cx-t.ax)-(t.bx-t.ax)*(t.cz-t.az);
  const z=(t.bx-t.ax)*(t.cy-t.ay)-(t.by-t.ay)*(t.cx-t.ax);
  const length=Math.hypot(x,y,z); return {x:x/length,y:y/length,z:z/length};
};
// Every endpoint is a finite binary floating point value. Scale all coordinates in
// one clipping operation to a common power of two, then compare exact rational cuts.
const bitsView=new DataView(new ArrayBuffer(8));
function dyadic(value:number):readonly [bigint,number] {
  if(value===0)return [0n,0];
  bitsView.setFloat64(0,value,false);const bits=bitsView.getBigUint64(0,false);
  const e=Number((bits>>52n)&2047n),m=bits&((1n<<52n)-1n);
  return [(bits>>63n)?-(e?m|(1n<<52n):m):(e?m|(1n<<52n):m),e?e-1075:-1074];
}
function lineInterval(t: SurfaceTriangle, a: P3, b: P3): [Ratio,Ratio,number,number] | null {
  const values=[t.ax,t.az,t.bx,t.bz,t.cx,t.cz,a.x,a.z,b.x,b.z].map(dyadic);
  const exponent=Math.min(...values.map((v)=>v[1]));
  const v=values.map(([n,e])=>n<<BigInt(e-exponent));
  const side=(i:number,j:number,k:number)=>(v[j]-v[i])*(v[k+1]-v[i+1])-(v[j+1]-v[i+1])*(v[k]-v[i]);
  const sign=side(0,2,4)>0n?1n:-1n;let lo=zero,hi=one;
  for(let i=0;i<6;i+=2) {
    const j=(i+2)%6,x=side(i,j,6)*sign,delta=(side(i,j,8)-side(i,j,6))*sign;
    if(delta===0n){if(x<0n)return null;continue;}
    let n=-x,d=delta;if(d<0n){n=-n;d=-d;}
    const cut={n,d};
    if(delta>0n&&compare(cut,lo)>0)lo=cut;
    if(delta<0n&&compare(cut,hi)<0)hi=cut;
  }
  if(compare(hi,lo)<=0)return null;
  const y=(w:readonly number[])=>w[0]*t.ay+w[1]*t.by+w[2]*t.cy;
  return [lo,hi,y(weights(t,a)),y(weights(t,b))];
}

export function checkLandingSeams(input: Pick<CitySurfaceCompilation,"surface"|"landings"> & Readonly<{revision:string}>, options: LandingSeamOptions): LandingSeamReport {
  const seams: LandingSeam[]=[]; let tests=0;
  const maxCandidates=options.maxCandidates??4096,maxTests=options.maxTests??1_000_000;
  const result=(reason:LandingSeamReport["reason"]):LandingSeamReport=>Object.freeze({
    status:reason==="none"?"complete":"unresolved",reason,scope:"boundary-cross-section",snapshotRevision:input.revision,
    checksVersion:LANDING_SEAM_CHECKS_VERSION,options:Object.freeze({maxStep:options.maxStep,maxSlopeChange:options.maxSlopeChange,aliasTolerance:options.aliasTolerance}),
    tests,seams:Object.freeze(seams),
  });
  if(!input.revision||![options.maxStep,options.aliasTolerance].every((v)=>Number.isFinite(v)&&v>=0)||!Number.isFinite(options.maxSlopeChange)||options.maxSlopeChange<0||options.maxSlopeChange>=Math.PI||
    ![maxCandidates,maxTests].every((v)=>Number.isSafeInteger(v)&&v>0))return result("invalid-input");
  const index=buildSurfaceIndex(input.surface); if(index.status!=="ready")return result("index");
  const patches=new Map(input.surface.patches.map((p)=>[p.id,p]));
  const sorted=[...input.landings].sort((a,b)=>a.structureId<b.structureId?-1:a.structureId>b.structureId?1:a.end<b.end?-1:a.end>b.end?1:0);
  for(const landing of sorted) {
    if(++tests>maxTests)return result("budget");
    const patch=patches.get(landing.patchId),a=landing.seam?.a,b=landing.seam?.b;
    if(!patch||patch.layerId!==landing.layerId||!a||!b||![a.x,a.y,a.z,b.x,b.y,b.z].every(Number.isFinite))return result("invalid-input");
    const width=Math.hypot(b.x-a.x,b.z-a.z);
    if(width<=0||!Number.isFinite(width))return result("invalid-input");
    const sameXZ=(p:Readonly<{x:number;z:number}>,q:P3)=>p.x===q.x&&p.z===q.z;
    if(!patch.boundaryLoops.some((loop)=>loop.vertices.some((p,i)=>{
      const q=loop.vertices[(i+1)%loop.vertices.length];
      return (sameXZ(p,a)&&sameXZ(q,b))||(sameXZ(p,b)&&sameXZ(q,a));
    })))return result("invalid-input");
    for(const point of [a,b]) {
      let found=false;
      for(let i=0;i<patch.vertices.length;i+=3)if(patch.vertices[i]===point.x&&patch.vertices[i+1]===point.y&&patch.vertices[i+2]===point.z){found=true;break;}
      if(!found)return result("invalid-input");
    }
    // Use the unique face incident to the actual boundary edge. Triangle order is
    // unrelated to the landing; a non-planar deck can be flat away from its entry.
    const sameVertex=(id:number,p:P3)=>patch.vertices[id*3]===p.x&&patch.vertices[id*3+1]===p.y&&patch.vertices[id*3+2]===p.z;
    const adjacent:SurfaceTriangle[]=[];
    for(let offset=0;offset<patch.indices.length;offset+=3) {
      if(++tests>maxTests)return result("budget");
      for(let k=0;k<3;k++) {
        const u=patch.indices[offset+k],v=patch.indices[offset+(k+1)%3];
        if((sameVertex(u,a)&&sameVertex(v,b))||(sameVertex(u,b)&&sameVertex(v,a))) {
          const triangle=index.triangle({patchId:patch.id,triangleIndex:offset/3});
          if(!triangle)return result("invalid-input");adjacent.push(triangle);break;
        }
      }
    }
    if(adjacent.length!==1)return result("invalid-input");
    const deckNormal=normal(adjacent[0]);
    const found=index.trianglesInBox({minX:Math.min(a.x,b.x),minZ:Math.min(a.z,b.z),maxX:Math.max(a.x,b.x),maxZ:Math.max(a.z,b.z),
      layerId:"ground",kinds:["carriageway","junction","island"],maxResults:maxCandidates});
    if(found.status!=="ok")return result(found.status==="budget"?"budget":"invalid-input");
    const intervals:Interval[]=[];const splits:Ratio[]=[zero,one];
    for(const ref of found.triangles) {
      if(++tests>maxTests)return result("budget");
      const triangle=index.triangle(ref),ground=patches.get(ref.patchId);if(!triangle||!ground)return result("invalid-input");
      const clipped=lineInterval(triangle,a,b);if(!clipped)continue;
      const [lo,hi,y0,y1]=clipped,n=normal(triangle);
      const angle=Math.acos(Math.max(-1,Math.min(1,n.x*deckNormal.x+n.y*deckNormal.y+n.z*deckNormal.z)));
      if(![numberOf(lo),numberOf(hi),y0,y1,angle].every(Number.isFinite))return result("invalid-input");
      intervals.push({lo,hi,y0,y1,angle,island:ground.kind==="island",unresolved:ground.boundaryLoops.length===0,patchId:ref.patchId,triangle:ref.triangleIndex});
      splits.push(lo,hi);
    }
    intervals.sort((a,b)=>a.patchId<b.patchId?-1:a.patchId>b.patchId?1:a.triangle-b.triangle);
    const ends=splits.sort(compare).filter((r,i,all)=>i===0||compare(r,all[i-1])!==0),evaluated:SeamInterval[]=[];
    for(let i=1;i<ends.length;i++) {
      const low=ends[i-1],high=ends[i],exactMid={n:low.n*high.d+high.n*low.d,d:2n*low.d*high.d};
      const from=numberOf(low),to=numberOf(high),mid=numberOf(exactMid);
      if(!(mid>from&&mid<to))return result("precision"); // no representable interior: do not hide an uncertain sliver
      const covering:Interval[]=[];
      for(const candidate of intervals) {
        if(++tests>maxTests)return result("budget");
        if(compare(candidate.lo,exactMid)<=0&&compare(candidate.hi,exactMid)>=0)covering.push(candidate);
      }
      let reason:SeamReason="none",maxStep:number|null=null,maxSlopeChange:number|null=null;
      let witnessT=mid,groundY:number|null=null;
      const supporting=covering.filter((c)=>!c.island);
      if(covering.some((c)=>c.island))reason="island";
      else if(covering.some((c)=>c.unresolved))reason="boundary-unresolved";
      else if(!supporting.length)reason="no-ground";
      else {
        maxStep=0;maxSlopeChange=0;
        for(const t of [from,to]) {
          const heights=supporting.map((c)=>c.y0+(c.y1-c.y0)*t);
          const spread=Math.max(...heights)-Math.min(...heights);
          if(spread>options.aliasTolerance+1e-6)reason="ambiguous-ground";
          for(let k=0;k<supporting.length;k++) {
            const step=Math.abs(at(a,b,t).y-heights[k]);
            if(step>maxStep){maxStep=step;witnessT=t;groundY=heights[k];}
            maxSlopeChange=Math.max(maxSlopeChange,supporting[k].angle);
          }
        }
        if(reason==="none"&&maxStep>options.maxStep+1e-6)reason="height-gap";
        if(reason==="none"&&maxSlopeChange>options.maxSlopeChange+1e-9)reason="slope-change";
        if(groundY===null)groundY=supporting[0].y0+(supporting[0].y1-supporting[0].y0)*mid;
      }
      const p=at(a,b,witnessT);
      evaluated.push(Object.freeze({from,to,reason,maxStep,maxSlopeChange,witness:Object.freeze({x:p.x,z:p.z,deckY:p.y,groundY})}));
    }
    const spans:Array<{from:number;to:number;width:number}>=[];
    for(const interval of evaluated)if(interval.reason==="none") {
      const previous=spans[spans.length-1];
      if(previous?.to===interval.from){previous.to=interval.to;previous.width=(previous.to-previous.from)*width;}
      else spans.push({from:interval.from,to:interval.to,width:(interval.to-interval.from)*width});
    }
    const unresolved=evaluated.some((i)=>i.reason==="boundary-unresolved");
    seams.push(Object.freeze({structureId:landing.structureId,end:landing.end,patchId:landing.patchId,portalRequired:landing.layerId!=="ground",
      status:unresolved?"unresolved":evaluated.every((i)=>i.reason==="none")?"continuous":"blocked",width,
      intervals:Object.freeze(evaluated),continuousSpans:Object.freeze(spans.map((s)=>Object.freeze(s)))}));
  }
  return result(seams.some((s)=>s.status==="unresolved")?"boundary-unresolved":"none");
}
