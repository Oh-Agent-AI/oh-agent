/** Frozen CPU solid queries. No layer filtering: bridge piers span several height layers.
 * Pose is the CENTRE of the body box, not the wheel support height. Angles interpolate
 * literally (no implicit shortest arc). Sweep is conservative advancement of the full
 * rotating OBB; it never certifies clearance from endpoint samples alone.
 */
import type { StructureObstacle } from "../../engine/surface/compileSurface";
import { conservativeVehicleVerticalRadius, isValidMountableHeight, type MountablePolicy } from "./staticSolidContracts";

export const COLLISION_RULES_VERSION = 2;
type V = Readonly<{ x: number; y: number; z: number }>;
export type CollisionPose = V & Readonly<{ heading: number; pitch: number; roll: number }>;
export type CollisionDimensions = Readonly<{ halfLength: number; halfWidth: number; halfHeight: number }>;
export type CollisionLimits = Readonly<{ maxObstacles: number; maxVertices: number; maxNodes: number; maxCandidates: number; maxTests: number; maxIterations: number; skin: number }>;
export const DEFAULT_COLLISION_LIMITS: CollisionLimits = Object.freeze({ maxObstacles: 100000, maxVertices: 1000000, maxNodes: 400000,
  maxCandidates: 4096, maxTests: 1000000, maxIterations: 512, skin: 1e-5 });
export type CollisionResult = Readonly<{ status: "clear" | "contact" | "unresolved"; revision: string;
  reason: "none" | "solid" | "initial-overlap" | "budget" | "invalid-input" | "precision";
  /** Certified collision-free prefix, excluding the contact skin. */
  lastSafeFraction: number; contact: Readonly<{ obstacleId: string; toi: number; normal: V; point: V }> | null; tests: number }>;
type Bound = { min: V; max: V };
type IndexedSolid = { id: string; vertices: readonly V[]; normals: readonly V[]; edges: readonly V[]; bound: Bound; mountable?: number };
type Node = Bound & { left?: Node; right?: Node; solids?: readonly IndexedSolid[] };
const add = (a: V, b: V): V => ({ x: a.x+b.x, y: a.y+b.y, z: a.z+b.z });
const sub = (a: V, b: V): V => ({ x: a.x-b.x, y: a.y-b.y, z: a.z-b.z });
const mul = (a: V, n: number): V => ({ x:a.x*n,y:a.y*n,z:a.z*n });
const dot = (a: V,b: V) => a.x*b.x+a.y*b.y+a.z*b.z;
const cross = (a: V,b: V): V => ({ x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x });
const length = (a: V) => Math.hypot(a.x,a.y,a.z);
const unit = (a: V): V => mul(a,1/length(a));
const finite = (a: V) => Number.isFinite(a.x)&&Number.isFinite(a.y)&&Number.isFinite(a.z);
const bounds = (v: readonly V[]): Bound => ({ min:{x:Math.min(...v.map(p=>p.x)),y:Math.min(...v.map(p=>p.y)),z:Math.min(...v.map(p=>p.z))},
  max:{x:Math.max(...v.map(p=>p.x)),y:Math.max(...v.map(p=>p.y)),z:Math.max(...v.map(p=>p.z))} });
const intersects = (a: Bound,b: Bound) => a.min.x<=b.max.x&&a.max.x>=b.min.x&&a.min.y<=b.max.y&&a.max.y>=b.min.y&&a.min.z<=b.max.z&&a.max.z>=b.min.z;
const union = (a: Bound,b: Bound): Bound => ({min:{x:Math.min(a.min.x,b.min.x),y:Math.min(a.min.y,b.min.y),z:Math.min(a.min.z,b.min.z)},max:{x:Math.max(a.max.x,b.max.x),y:Math.max(a.max.y,b.max.y),z:Math.max(a.max.z,b.max.z)}});
const lexical = (a: string,b: string) => a < b ? -1 : a > b ? 1 : 0;
class Invalid extends Error {}
class Budget extends Error {}
function shape(id: string, vertices: readonly V[], faces: readonly (readonly number[])[]): IndexedSolid {
  const normals: V[]=[]; const edges: V[]=[];
  for (const f of faces) {
    const n=cross(sub(vertices[f[1]],vertices[f[0]]),sub(vertices[f[2]],vertices[f[0]]));
    if (!(length(n)>1e-12)) throw new Invalid();
    const normal=unit(n); normals.push(normal);
    // Every face must be planar, with the entire convex polyhedron on one side.
    const distances=vertices.map(v=>dot(normal,sub(v,vertices[f[0]])));
    // Roundoff scales with the absolute coordinates too (as in separation()): corners at |x| ≈ 500 carry ~1e-13 of
    // rounding, more than a tolerance sized only by the solid's own extent allows — 8 of 68k city boxes failed on it.
    const scale=Math.max(1,...vertices.map(v=>length(sub(v,vertices[f[0]]))),...vertices.map(v=>Math.max(Math.abs(v.x),Math.abs(v.y),Math.abs(v.z))));
    if (f.some(i=>Math.abs(distances[i])>128*Number.EPSILON*scale) || (Math.min(...distances)<-128*Number.EPSILON*scale&&Math.max(...distances)>128*Number.EPSILON*scale)) throw new Invalid();
    for (let i=0;i<f.length;i++) { const e=sub(vertices[f[(i+1)%f.length]],vertices[f[i]]); if (!(length(e)>1e-12)) throw new Invalid(); edges.push(unit(e)); }
  }
  return {id,vertices,normals,edges,bound:bounds(vertices)};
}
const boxFaces = [[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]];
const orient = (a: V,b: V,c: V) => (b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
/** Ear-clipping simple prisms preserves concave islands instead of blocking their convex hull. */
function prism(obstacle: Extract<StructureObstacle,{shape:"prism"}>, spend: () => void): IndexedSolid[] {
  const {ring,yMin,yMax,id}=obstacle;
  if (ring.length<3||!Number.isFinite(yMin)||!Number.isFinite(yMax)||!(yMin<yMax)) throw new Invalid();
  const vertices=ring.map(p=>({x:p.x,y:yMin,z:p.z})); if(vertices.some(p=>!finite(p)))throw new Invalid();
  const on=(a:V,b:V,p:V)=>orient(a,b,p)===0&&p.x>=Math.min(a.x,b.x)&&p.x<=Math.max(a.x,b.x)&&p.z>=Math.min(a.z,b.z)&&p.z<=Math.max(a.z,b.z);
  for(let i=0;i<vertices.length;i++)for(let j=i+1;j<vertices.length;j++) {
    spend(); if(j===i+1||(i===0&&j===vertices.length-1))continue;
    const a=vertices[i],b=vertices[(i+1)%vertices.length],c=vertices[j],d=vertices[(j+1)%vertices.length];
    if((orient(a,b,c)*orient(a,b,d)<0&&orient(c,d,a)*orient(c,d,b)<0)||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b))throw new Invalid();
  }
  const area=vertices.reduce((n,p,i)=>n+p.x*vertices[(i+1)%vertices.length].z-p.z*vertices[(i+1)%vertices.length].x,0);
  if(!Number.isFinite(area)||area===0)throw new Invalid();
  const remaining=vertices.map((_,i)=>i); if(area<0)remaining.reverse(); const triangles:number[][]=[];
  while(remaining.length>3){let clipped=false; for(let i=0;i<remaining.length;i++) {
    spend();const a=remaining[(i+remaining.length-1)%remaining.length],b=remaining[i],c=remaining[(i+1)%remaining.length];
    if(orient(vertices[a],vertices[b],vertices[c])<=0)continue;
    if(remaining.some(k=>{spend();return k!==a&&k!==b&&k!==c&&orient(vertices[a],vertices[b],vertices[k])>=0&&orient(vertices[b],vertices[c],vertices[k])>=0&&orient(vertices[c],vertices[a],vertices[k])>=0;}))continue;
    triangles.push([a,b,c]);remaining.splice(i,1);clipped=true;break;
  } if(!clipped)throw new Invalid();}
  triangles.push(remaining);
  return triangles.map(t=>{const low=t.map(i=>vertices[i]), high=low.map(p=>({...p,y:yMax})); const s=shape(id,[...low,...high],[[0,1,2],[3,5,4],[0,3,4,1],[1,4,5,2],[2,5,3,0]]); if(obstacle.mountableHeight!==undefined)s.mountable=obstacle.mountableHeight; return s;});
}
function body(p: CollisionPose,d: CollisionDimensions): IndexedSolid {
  // Long axis matches DrivingSimulation: heading 0 points +X; pitch raises the nose.
  const c=Math.cos(p.heading),s=Math.sin(p.heading),cp=Math.cos(p.pitch),sp=Math.sin(p.pitch),cr=Math.cos(p.roll),sr=Math.sin(p.roll);
  const forward:V={x:c*cp,y:sp,z:s*cp}, up0:V={x:-c*sp,y:cp,z:-s*sp}, side0:V={x:-s,y:0,z:c};
  const up=add(mul(up0,cr),mul(side0,-sr)),side=add(mul(side0,cr),mul(up0,sr));
  const vertices=[-1,1].flatMap(x=>[-1,1].flatMap(y=>[-1,1].map(z=>add(p,add(mul(forward,x*d.halfLength),add(mul(up,y*d.halfHeight),mul(side,z*d.halfWidth)))))));
  return {id:"body",vertices,normals:[forward,up,side],edges:[forward,up,side],bound:bounds(vertices)};
}
/** SAT projection gap is a lower bound on Euclidean separation, sufficient for safe advancement. */
function separation(a: IndexedSolid,b: IndexedSolid,spend:()=>void): {gap:number;normal:V} {
  let gap=-Infinity,normal:V={x:1,y:0,z:0};
  const test=(axis:V)=>{spend();const len=length(axis);if(len<1e-12)return;const n=mul(axis,1/len);
    const av=a.vertices.map(v=>dot(v,n)),bv=b.vertices.map(v=>dot(v,n));const left=Math.min(...av)-Math.max(...bv),right=Math.min(...bv)-Math.max(...av);
    const roundoff=64*Number.EPSILON*Math.max(1,...av.map(Math.abs),...bv.map(Math.abs));
    const g=Math.max(left,right)-roundoff;if(g>gap){gap=g;normal=mul(n,left>=right?1:-1);}};
  for(const n of a.normals)test(n);for(const n of b.normals)test(n);for(const x of a.edges)for(const y of b.edges)test(cross(x,y));
  return {gap,normal};
}
function valid(p:CollisionPose,d:CollisionDimensions){return finite(p)&&[p.heading,p.pitch,p.roll,d.halfLength,d.halfWidth,d.halfHeight].every(Number.isFinite)&&d.halfLength>0&&d.halfWidth>0&&d.halfHeight>0;}
export type CollisionIndexBuild = Readonly<{status:"ready";index:CollisionIndex}> | Readonly<{status:"unresolved";reason:"invalid-input"|"budget"}>;
function buildFrozenCollisionIndex(input: Readonly<{revision:string;obstacles:readonly StructureObstacle[]}>, options: Partial<CollisionLimits> = {}, staticParams?: CollisionParams, sourceSolids?: readonly SolidInput[]): CollisionIndexBuild {
  const limits={...DEFAULT_COLLISION_LIMITS,...options};let tests=0;
  const spend=()=>{if(++tests>limits.maxTests)throw new Budget();};
  try {
    if(!input.revision||!Number.isFinite(limits.skin)||limits.skin<=0||Object.entries(limits).some(([k,v])=>k!=="skin"&&(!Number.isSafeInteger(v)||v<1)))throw new Invalid();
    if(input.obstacles.length>limits.maxObstacles)throw new Budget();
    const ids=new Set<string>();const solids:IndexedSolid[]=[];let vertexCount=0;
    for(const [index,obstacle] of input.obstacles.entries()){spend();if(!obstacle.id||ids.has(obstacle.id))throw new Invalid();ids.add(obstacle.id);
      vertexCount+=obstacle.shape==="box"?obstacle.corners.length:Math.max(0,6*(obstacle.ring.length-2));if(vertexCount>limits.maxVertices)throw new Budget();
      if(obstacle.shape==="box") {if(obstacle.corners.length!==8||obstacle.corners.some(p=>!finite(p)))throw new Invalid();
        const source=sourceSolids?.[index];
        let bs:IndexedSolid;
        if(source?.kind==="box") {
          // An affine box is convex by construction. Preserve original half-axes:
          // subtracting large world corners loses precision for thin rotated boxes.
          const axes=source.halfAxes;
          if(!finite(source.center)||axes.some(a=>!finite(a)||length(a)<=1e-12))throw new Invalid();
          const normals=[cross(axes[1],axes[2]),cross(axes[2],axes[0]),cross(axes[0],axes[1])];
          const volume=Math.abs(dot(axes[0],normals[0])), axisVolume=axes.reduce((n,a)=>n*length(a),1);
          if(normals.some(n=>length(n)<=1e-12)||!Number.isFinite(volume)||volume<=64*Number.EPSILON*axisVolume)throw new Invalid();
          bs={id:source.id,vertices:obstacle.corners.map(p=>({...p})),normals:normals.map(unit),edges:axes.map(unit),bound:bounds(obstacle.corners)};
        } else bs=shape(obstacle.id,obstacle.corners.map(p=>({...p})),boxFaces);
        if(obstacle.mountableHeight!==undefined)bs.mountable=obstacle.mountableHeight;solids.push(bs);}
      else if(obstacle.shape==="prism")solids.push(...prism(obstacle,spend));else throw new Invalid();
    }
    let nodes=0;
    const tree=(items:IndexedSolid[]):Node|null=>{if(!items.length)return null;if(++nodes>limits.maxNodes)throw new Budget();spend();let bound=items[0].bound;for(const s of items)bound=union(bound,s.bound);
      if(items.length<=4)return {...bound,solids:items};const axes=["x","y","z"] as const;const axis=axes.reduce((best,a)=>bound.max[a]-bound.min[a]>bound.max[best]-bound.min[best]?a:best,"x");
      items.sort((a,b)=>(a.bound.min[axis]+a.bound.max[axis])-(b.bound.min[axis]+b.bound.max[axis])||lexical(a.id,b.id));const mid=Math.floor(items.length/2);
      return {...bound,left:tree(items.slice(0,mid))!,right:tree(items.slice(mid))!};};
    return Object.freeze({status:"ready",index:new CollisionIndex(input.revision,tree(solids),Object.freeze(limits), input.obstacles,staticParams,sourceSolids)});
  } catch(e){if(e instanceof Invalid||e instanceof Budget)return Object.freeze({status:"unresolved",reason:e instanceof Budget?"budget":"invalid-input"});throw e;}
}
export class CollisionIndex {
  private readonly staticIndex: StaticCollisionIndex;
  constructor(readonly revision:string, private readonly root:Node|null, readonly limits:CollisionLimits, obstacles: readonly StructureObstacle[] = [], staticParams?: CollisionParams, sourceSolids?: readonly SolidInput[]) {
    this.staticIndex=buildStaticCollisionIndex(sourceSolids ?? obstacles.map(o=>o.shape === "box" ? {...boxSolidFromCorners(o.id,o.role,o.corners),...(o.mountableHeight===undefined?{}:{mountableHeight:o.mountableHeight})} : ({id:o.id,role:o.role,kind:"prism" as const,ring:o.ring,yMin:o.yMin,yMax:o.yMax,mountableHeight:o.mountableHeight})), {...DEFAULT_COLLISION_PARAMS,maxCandidates:limits.maxCandidates,...staticParams});
  }
  get report(): CollisionReport { return this.staticIndex.report; }
  hit(poly: Poly, mountablePolicy: MountablePolicy = "disabled"): CollisionHit { return this.staticIndex.hit(poly, mountablePolicy); }
  solids(): readonly Solid[] { return this.staticIndex.solids(); }
  overlap(pose:CollisionPose,dimensions:CollisionDimensions,mountablePolicy:MountablePolicy="disabled"):CollisionResult{return this.sweep(pose,pose,dimensions,mountablePolicy);}
  sweep(from:CollisionPose,to:CollisionPose,dimensions:CollisionDimensions,mountablePolicy:MountablePolicy="disabled"):CollisionResult {
    let tests=0,lastSafeFraction=0;
    const result=(status:CollisionResult["status"],reason:CollisionResult["reason"],contact:CollisionResult["contact"]=null):CollisionResult=>Object.freeze({status,reason,revision:this.revision,lastSafeFraction,contact,tests});
    const spend=()=>{if(++tests>this.limits.maxTests)throw new Budget();};
    if(!valid(from,dimensions)||!valid(to,dimensions))return result("unresolved","invalid-input");
    const coordinateScale=Math.max(1,Math.abs(from.x),Math.abs(from.y),Math.abs(from.z),Math.abs(to.x),Math.abs(to.y),Math.abs(to.z));
    if(coordinateScale*128*Number.EPSILON>this.limits.skin)return result("unresolved","precision");
    const radius=Math.hypot(dimensions.halfLength,dimensions.halfWidth,dimensions.halfHeight);
    const delta=sub(to,from),motion=length(delta)+radius*(Math.abs(to.heading-from.heading)+Math.abs(to.pitch-from.pitch)+Math.abs(to.roll-from.roll));
    if(!Number.isFinite(motion))return result("unresolved","invalid-input");
    const broad:Bound={min:{x:Math.min(from.x,to.x)-radius-this.limits.skin,y:Math.min(from.y,to.y)-radius-this.limits.skin,z:Math.min(from.z,to.z)-radius-this.limits.skin},max:{x:Math.max(from.x,to.x)+radius+this.limits.skin,y:Math.max(from.y,to.y)+radius+this.limits.skin,z:Math.max(from.z,to.z)+radius+this.limits.skin}};
    try {
      const candidates:IndexedSolid[]=[];const stack=this.root?[this.root]:[];
      while(stack.length){spend();const node=stack.pop()!;if(!intersects(node,broad))continue;if(node.solids){for(const solid of node.solids){spend();if(intersects(solid.bound,broad)){candidates.push(solid);if(candidates.length>this.limits.maxCandidates)throw new Budget();}}}else{if(node.right)stack.push(node.right);if(node.left)stack.push(node.left);}}
      // 可越障碍（mountable curbs）：扫掠期间车底可能的高度下界 = min(from,to).y − 半高 − 俯仰裕量。
      // 用最保守车底判爬升——整段扫掠都不高于预算才跳过（中途爬上岛的场景 from 车底已在路面，
      // 0.22 的岛顶在预算内，从扫掠起点即跳过；高墙/桥墩永不满足）。
      if(mountablePolicy!=="disabled"&&mountablePolicy!=="gameplay")return result("unresolved","invalid-input");
      const verticalRadius=conservativeVehicleVerticalRadius(dimensions.halfLength,dimensions.halfWidth,dimensions.halfHeight,from.pitch,to.pitch,from.roll,to.roll);
      const sweepBottom=Math.min(from.y,to.y)-verticalRadius;
      const filtered=candidates.filter((solid)=>!(mountablePolicy==="gameplay"&&solid.mountable!==undefined&&solid.bound.max.y-sweepBottom<=solid.mountable));
      filtered.sort((a,b)=>lexical(a.id,b.id));if(!filtered.length){lastSafeFraction=1;return result("clear","none");}
      let t=0;
      for(let iteration=0;iteration<this.limits.maxIterations;iteration++){
        const p:CollisionPose={x:from.x+delta.x*t,y:from.y+delta.y*t,z:from.z+delta.z*t,heading:from.heading+(to.heading-from.heading)*t,pitch:from.pitch+(to.pitch-from.pitch)*t,roll:from.roll+(to.roll-from.roll)*t};
        const vehicle=body(p,dimensions);let nearest:{solid:IndexedSolid;gap:number;normal:V}|null=null;
        for(const solid of filtered){const found=separation(vehicle,solid,spend);if(!Number.isFinite(found.gap))return result("unresolved","precision");if(!nearest||found.gap<nearest.gap)nearest={solid,...found};}
        const hit=nearest!;
        if(hit.gap<=this.limits.skin){const point=vehicle.vertices.reduce((best,v)=>dot(v,hit.normal)<dot(best,hit.normal)?v:best,vehicle.vertices[0]);return result("contact",t===0&&hit.gap<0?"initial-overlap":"solid",Object.freeze({obstacleId:hit.solid.id,toi:t,normal:Object.freeze(hit.normal),point:Object.freeze({...point})}));}
        lastSafeFraction=t;
        if(t===1||motion===0){lastSafeFraction=1;return result("clear","none");}
        // Any point travels at most motion per unit t. This step cannot pass a solid.
        const step=(hit.gap-this.limits.skin)/motion;
        if(!(step>0))return result("unresolved","precision");
        if(step<1e-12){const point=vehicle.vertices.reduce((best,v)=>dot(v,hit.normal)<dot(best,hit.normal)?v:best,vehicle.vertices[0]);return result("contact","solid",Object.freeze({obstacleId:hit.solid.id,toi:t,normal:Object.freeze(hit.normal),point:Object.freeze({...point})}));}
        if(t+step===t)return result("unresolved","precision");
        const next=Math.min(1,t+step);
        t=next;
      }
      return result("unresolved","budget");
    }catch(e){if(e instanceof Budget)return result("unresolved","budget");throw e;}
  }
}

/** Static solid obstacles for driving: buildings, landmarks, railings, piers, truss bars, islands and
 * structure deck slabs. Pure CPU; no THREE, DOM or host (THREE scene capture lives in
 * engine/surface/sceneSolids.ts and hands plain numbers in).
 *
 * 为什么不是「XZ 多边形 + y 区间」：桥面板、匝道板、护栏都是倾斜的长盒子，用整体 y 区间判，
 * 车开在匝道板上会撞到同一块板高处那端的「区间」。这里每个固体都是凸多面体（平行六面体或
 * 竖直凸棱柱），车身是按支撑面 pitch/roll 摆好的有向盒，两者用分离轴定理精确判交：
 * 面法线（各 3 / 棱柱 n+2）+ 双方棱方向两两叉积。触碰即相交（闭集），与区域边界的「触碰即拦」一致。
 *
 * 净空（立交桥下、匝道下）也由这里判：结构板本身就是固体，地面上的车身顶到板底即碰撞。
 * 区域层只回答「车轮下有没有面」，从来不回答「车顶上有没有东西」。 */



export type V3 = Readonly<{ x: number; y: number; z: number }>;
/** Parallelepiped: centre and three half-edge vectors (an OBB when orthogonal; sheared transforms stay exact). */
export type BoxSolidInput = Readonly<{ id: string; role: string; kind: "box"; center: V3; halfAxes: readonly [V3, V3, V3]; mountableHeight?: number }>;
/** Vertical prism over a convex XZ ring (any winding; non-convex input is replaced by its hull). */
export type PrismSolidInput = Readonly<{ id: string; role: string; kind: "prism"; ring: readonly Readonly<{ x: number; z: number }>[]; yMin: number; yMax: number; mountableHeight?: number }>;
export type SolidInput = BoxSolidInput | PrismSolidInput;

type Poly = { vertices: V3[]; faces: V3[]; edges: V3[] };
export type Solid = Readonly<{ id: string; role: string; minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; poly: Poly;
  /** 可越障碍（mountable curbs）：障碍顶面高出车底 ≤ 此值时跳过法向阻挡（支撑融合另行处理）。 */
  mountableHeight?: number }>;
export type CollisionParams = Readonly<{ cellSize: number; maxCellsPerSolid: number; maxCandidates: number }>;
export const DEFAULT_COLLISION_PARAMS: CollisionParams = Object.freeze({ cellSize: 8, maxCellsPerSolid: 4096, maxCandidates: 4096 });
export type CollisionReport = Readonly<{ rulesVersion: number; solids: number; rejected: number; byRole: Readonly<Record<string, number>> }>;
export type CollisionHit = Readonly<{ status: "hit"; solid: Solid }> | Readonly<{ status: "clear" }> | Readonly<{ status: "budget" | "invalid-input" }>;

const staticSub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const staticCross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const staticDot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const staticFinite = (v: V3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** Convex polytope of a parallelepiped (8 corners, 3 face normals, 3 edge directions). */
export function boxPoly(center: V3, h: readonly [V3, V3, V3]): Poly {
  const vertices: V3[] = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) {
    vertices.push({ x: center.x + a * h[0].x + b * h[1].x + c * h[2].x, y: center.y + a * h[0].y + b * h[1].y + c * h[2].y, z: center.z + a * h[0].z + b * h[1].z + c * h[2].z });
  }
  return { vertices, faces: [staticCross(h[1], h[2]), staticCross(h[2], h[0]), staticCross(h[0], h[1])], edges: [h[0], h[1], h[2]] };
}
function hull2(points: readonly Readonly<{ x: number; z: number }>[]) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const c = (o: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: { x: number; z: number }[] = []; for (const p of pts) { while (lower.length >= 2 && c(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper: { x: number; z: number }[] = []; for (const p of [...pts].reverse()) { while (upper.length >= 2 && c(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
function prismPoly(ring: readonly Readonly<{ x: number; z: number }>[], yMin: number, yMax: number): Poly | null {
  const h = hull2(ring);
  if (h.length < 3) return null;
  const vertices: V3[] = [...h.map((p) => ({ x: p.x, y: yMin, z: p.z })), ...h.map((p) => ({ x: p.x, y: yMax, z: p.z }))];
  const edges: V3[] = [{ x: 0, y: 1, z: 0 }];
  const faces: V3[] = [{ x: 0, y: 1, z: 0 }];
  for (let i = 0; i < h.length; i++) {
    const a = h[i]; const b = h[(i + 1) % h.length]; const e = { x: b.x - a.x, y: 0, z: b.z - a.z };
    edges.push(e); faces.push({ x: -e.z, y: 0, z: e.x });
  }
  return { vertices, faces, edges };
}
/** Separating-axis test between two convex polytopes; touching counts as intersecting. */
export function polytopesIntersect(a: Poly, b: Poly): boolean {
  const axes: V3[] = [...a.faces, ...b.faces];
  for (const ea of a.edges) for (const eb of b.edges) axes.push(staticCross(ea, eb));
  for (const axis of axes) {
    const len = Math.hypot(axis.x, axis.y, axis.z);
    if (len < 1e-12) continue; // parallel edges: covered by the face axes
    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (const v of a.vertices) { const d = staticDot(v, axis); if (d < aMin) aMin = d; if (d > aMax) aMax = d; }
    for (const v of b.vertices) { const d = staticDot(v, axis); if (d < bMin) bMin = d; if (d > bMax) bMax = d; }
    const slack = 1e-9 * len * (1 + Math.abs(aMin) / len + Math.abs(bMin) / len);
    if (aMax < bMin - slack || bMax < aMin - slack) return false;
  }
  return true;
}

export type StaticCollisionIndex = Readonly<{
  report: CollisionReport;
  /** First solid (stable: lowest id) intersecting the body. */
  hit: (body: Poly, mountablePolicy?: MountablePolicy) => CollisionHit;
  solids: () => readonly Solid[];
}>;

function buildStaticCollisionIndex(inputs: readonly SolidInput[], params: CollisionParams = DEFAULT_COLLISION_PARAMS): StaticCollisionIndex {
  const solids: Solid[] = []; let rejected = 0; const byRole: Record<string, number> = Object.create(null);
  if(!Number.isFinite(params.cellSize)||params.cellSize<=0||!Number.isSafeInteger(params.maxCellsPerSolid)||params.maxCellsPerSolid<1||!Number.isSafeInteger(params.maxCandidates)||params.maxCandidates<1)throw new Error("invalid-static-collision-params");
  for (const input of [...inputs].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (!isValidMountableHeight(input.mountableHeight)) throw new Invalid();
    let poly: Poly | null = null;
    if (input.kind === "box" && staticFinite(input.center) && input.halfAxes.every(staticFinite)) {
      const volume = Math.abs(staticDot(input.halfAxes[0], staticCross(input.halfAxes[1], input.halfAxes[2])));
      const axisVolume = input.halfAxes.reduce((n, axis) => n * Math.hypot(axis.x, axis.y, axis.z), 1);
      poly = Number.isFinite(volume) && volume > 64 * Number.EPSILON * axisVolume ? boxPoly(input.center, input.halfAxes) : null;
    } else if (input.kind === "prism" && Number.isFinite(input.yMin) && Number.isFinite(input.yMax) && input.yMax > input.yMin && input.ring.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z))) {
      poly = prismPoly(input.ring, input.yMin, input.yMax);
    }
    if (!poly) { rejected++; continue; }
    const xs = poly.vertices.map((v) => v.x), ys = poly.vertices.map((v) => v.y), zs = poly.vertices.map((v) => v.z);
    solids.push(Object.freeze({ id: input.id, role: input.role, minX: Math.min(...xs), minY: Math.min(...ys), minZ: Math.min(...zs), maxX: Math.max(...xs), maxY: Math.max(...ys), maxZ: Math.max(...zs),
      mountableHeight: input.mountableHeight,
      poly: Object.freeze({ vertices: Object.freeze(poly.vertices.map(v=>Object.freeze({...v}))), faces: Object.freeze(poly.faces.map(v=>Object.freeze({...v}))), edges: Object.freeze(poly.edges.map(v=>Object.freeze({...v}))) }) as unknown as Poly }));
    byRole[input.role] = (byRole[input.role] ?? 0) + 1;
  }
  const cell = params.cellSize; const grid = new Map<string, number[]>();
  const cells = (minX: number, minZ: number, maxX: number, maxZ: number) => [Math.floor(minX / cell), Math.floor(minZ / cell), Math.floor(maxX / cell), Math.floor(maxZ / cell)];
  const oversized: number[] = [];
  solids.forEach((s, i) => {
    const [x0, z0, x1, z1] = cells(s.minX, s.minZ, s.maxX, s.maxZ);
    // Huge solids (a sea mountain) go to a short always-tested list instead of thousands of cells.
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > params.maxCellsPerSolid) { oversized.push(i); return; }
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = `${x}:${z}`; const b = grid.get(k); if (b) b.push(i); else grid.set(k, [i]); }
  });
  const hit = (body: Poly, mountablePolicy: MountablePolicy = "disabled"): CollisionHit => {
    if(mountablePolicy!=="disabled"&&mountablePolicy!=="gameplay")return Object.freeze({status:"invalid-input"});
    if (!body.vertices.length || !body.vertices.every(staticFinite)) return Object.freeze({ status: "invalid-input" });
    const xs = body.vertices.map((v) => v.x), ys = body.vertices.map((v) => v.y), zs = body.vertices.map((v) => v.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const [x0, z0, x1, z1] = cells(minX, minZ, maxX, maxZ);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > params.maxCellsPerSolid) return Object.freeze({ status: "budget" });
    const seen = new Set<number>(oversized);
    const candidates = [...oversized];
    if(candidates.length>params.maxCandidates)return Object.freeze({status:"budget"});
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (const i of grid.get(`${x}:${z}`) ?? []) {
      if (seen.has(i)) continue; seen.add(i); candidates.push(i);
      if (candidates.length > params.maxCandidates) return Object.freeze({ status: "budget" });
    }
    candidates.sort((a, b) => a - b);
    for (const i of candidates) {
      const s = solids[i];
      if (s.maxX < minX || s.minX > maxX || s.maxY < minY || s.minY > maxY || s.maxZ < minZ || s.minZ > maxZ) continue;
      // 可越障碍：顶面高出车底 ≤ 预算时跳过法向阻挡——车「爬」上去而不是撞停。
      if (mountablePolicy === "gameplay" && s.mountableHeight !== undefined && s.maxY - minY <= s.mountableHeight) continue;
      if (polytopesIntersect(body, s.poly)) return Object.freeze({ status: "hit", solid: s });
    }
    return Object.freeze({ status: "clear" });
  };
  return Object.freeze({ report: Object.freeze({ rulesVersion: COLLISION_RULES_VERSION, solids: solids.length, rejected, byRole: Object.freeze(byRole) }), hit, solids: () => Object.freeze(solids) });
}

/** Solid inputs from 8 box corners in boxCorners() order (lx ∈ ±½ → ly ∈ {0,1} → lz ∈ ±½). */
export function boxSolidFromCorners(id: string, role: string, c: readonly V3[]): BoxSolidInput {
  const half = (a: V3, b: V3): V3 => ({ x: (b.x - a.x) / 2, y: (b.y - a.y) / 2, z: (b.z - a.z) / 2 });
  const center = c.reduce((n, p) => ({ x: n.x + p.x / 8, y: n.y + p.y / 8, z: n.z + p.z / 8 }), { x: 0, y: 0, z: 0 });
  return Object.freeze({ id, role, kind: "box", center, halfAxes: [half(c[0], c[4]), half(c[0], c[2]), half(c[0], c[1])] as const });
}

/** Vehicle body: bottom clearance and roof above the support plane, footprint margins horizontally. */
export type BodyParams = Readonly<{ bottom: number; top: number }>;
/** bottom 0.1 ≈ 0.4 × wheel radius (road paint 0.025–0.05 and the 0.04 road lift never reach it);
 *  top = car height 1.15 + 0.1 vertical margin. */
export const DEFAULT_BODY_PARAMS: BodyParams = Object.freeze({ bottom: 0.1, top: 1.25 });

/** The car's oriented body box at a support pose; `grow` widens it horizontally (swept sample) and
 * `lift` extends it vertically both ways (height change across the sample). */
export function carBody(pose: Readonly<{ x: number; z: number; heading: number }>, support: Readonly<{ y: number; pitch: number; roll: number }>,
  halfLength: number, halfWidth: number, body: BodyParams = DEFAULT_BODY_PARAMS, grow = 0, lift = 0): Poly {
  const ch = Math.cos(pose.heading), sh = Math.sin(pose.heading);
  const cp = Math.cos(support.pitch), sp = Math.sin(support.pitch), cr = Math.cos(support.roll), sr = Math.sin(support.roll);
  const f0 = { x: ch, y: 0, z: sh }; const l0 = { x: -sh, y: 0, z: ch }; const up = { x: 0, y: 1, z: 0 };
  // Pitch > 0: front higher; roll > 0: left (+l, the footprint's w = +1 side) higher.
  const f = { x: f0.x * cp + up.x * sp, y: f0.y * cp + up.y * sp, z: f0.z * cp + up.z * sp };
  const u1 = { x: up.x * cp - f0.x * sp, y: up.y * cp - f0.y * sp, z: up.z * cp - f0.z * sp };
  const l = { x: l0.x * cr + u1.x * sr, y: l0.y * cr + u1.y * sr, z: l0.z * cr + u1.z * sr };
  const u = { x: u1.x * cr - l0.x * sr, y: u1.y * cr - l0.y * sr, z: u1.z * cr - l0.z * sr };
  const mid = (body.bottom + body.top) / 2; const hh = (body.top - body.bottom) / 2 + lift;
  const center = { x: pose.x + u.x * mid, y: support.y + u.y * mid, z: pose.z + u.z * mid };
  const scale = (v: V3, k: number): V3 => ({ x: v.x * k, y: v.y * k, z: v.z * k });
  return boxPoly(center, [scale(f, halfLength + grow), scale(l, halfWidth + grow), scale(u, hh)]);
}
export type { Poly as CollisionPoly };


/** Legacy static-source callers retain hit/report/solids; versioned callers also get CCD. */
export function buildCollisionIndex(inputs: readonly SolidInput[], params?: CollisionParams): CollisionIndex;
export function buildCollisionIndex(inputs: Readonly<{revision:string;obstacles:readonly StructureObstacle[]}>, params?: Partial<CollisionLimits>): CollisionIndexBuild;

export function buildCollisionIndex(inputs: readonly SolidInput[] | Readonly<{revision:string;obstacles:readonly StructureObstacle[]}>, params: Partial<CollisionLimits> | CollisionParams = {}): CollisionIndex | CollisionIndexBuild {
  if (!Array.isArray(inputs)) return buildFrozenCollisionIndex(inputs as Readonly<{revision:string;obstacles:readonly StructureObstacle[]}>,params as Partial<CollisionLimits>);
  const obstacles: StructureObstacle[]=inputs.map(input=>input.kind === "box"
    ? ({id:input.id,role:input.role,shape:"box",corners:boxPoly(input.center,input.halfAxes).vertices,...(input.mountableHeight===undefined?{}:{mountableHeight:input.mountableHeight})} as StructureObstacle)
    : ({id:input.id,role:input.role,shape:"prism",ring:input.ring,yMin:input.yMin,yMax:input.yMax,mountableHeight:input.mountableHeight} as StructureObstacle));
  // Pass the inputs as source solids, like buildVersionedCollisionIndex: boxes keep their half-axes instead of
  // re-proving planarity from world corners (seed 7's platform-bridge railings failed that on rounding alone).
  const built=buildFrozenCollisionIndex({revision:"legacy-static-unversioned",obstacles},{maxCandidates:params.maxCandidates ?? DEFAULT_COLLISION_LIMITS.maxCandidates},{...DEFAULT_COLLISION_PARAMS,...params} as CollisionParams,inputs);
  if(built.status!=="ready")throw new Error(`collision-index-${built.reason}`);
  return built.index;
}

/** Mixed exact-structure + whitelisted-scene solids under a versioned revision.
 * Same budget semantics as the frozen build; overflow/invalid → unresolved, never a partial index. */
export function buildVersionedCollisionIndex(revision: string, solids: readonly SolidInput[], params?: CollisionParams): CollisionIndexBuild {
  try {
    const obstacles: StructureObstacle[] = solids.map((input) => input.kind === "box"
      ? ({ id: input.id, role: input.role, shape: "box", corners: boxPoly(input.center, input.halfAxes).vertices.map((v) => ({ ...v })), ...(input.mountableHeight === undefined ? {} : { mountableHeight: input.mountableHeight }) } as StructureObstacle)
      : ({ id: input.id, role: input.role, shape: "prism", ring: input.ring, yMin: input.yMin, yMax: input.yMax, mountableHeight: input.mountableHeight } as StructureObstacle));
    return buildFrozenCollisionIndex({ revision, obstacles }, { maxCandidates: DEFAULT_COLLISION_LIMITS.maxCandidates }, params ?? DEFAULT_COLLISION_PARAMS, solids);
  } catch (error) {
    if (error instanceof Budget) return Object.freeze({ status: "unresolved", reason: "budget" });
    return Object.freeze({ status: "unresolved", reason: "invalid-input" });
  }
}
