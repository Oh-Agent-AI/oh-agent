/** C integration, separate from B's legacy whole-step-rejection environment.
 * No recovery, route search, audit outcome attribution or release graph lives here.
 * Every segment (including tangent slides) is re-fitted to B's surface authority.
 */
import type { SurfaceRegionsBuild } from "../../engine/surface/surfaceRegions";
import type { DrivingEnvironment, DrivingMoveResult, DrivingMotion, DrivingState, DrivingTrajectoryPose, DrivingContact } from "../DrivingSimulation";
import type { Solid, CollisionDimensions } from "./CollisionIndex";
import { DEFAULT_FOOTPRINT_PARAMS, footprintSupport, mountableQueryOf, validateMotion, type FootprintParams, type MountableQuery, type VehicleFootprint } from "./surfaceFootprint";
import { DRIVING_FOOTPRINT } from "./vehicleFootprint";
import { resolveDrivingCollision, type SupportedPose } from "./DrivingCollisionSolver";
import { DEFAULT_SWEEP_LIMITS, interpolateBody, type SweepLimits, type BodyPose } from "./DrivingCollision";
import { isValidMountableHeight, MOUNTABLE_POLICY_VERSION, type MountablePolicy } from "./staticSolidContracts";
export const CONTINUOUS_DRIVING_QUERY_VERSION=5; // 5: seam support steps are not charged as travel; relative budget tolerance
export const CONTINUOUS_MOUNTABLE_POLICY_VERSION=MOUNTABLE_POLICY_VERSION;
export type ContinuousEnvironmentPolicy=Readonly<{boundarySlide?:boolean;mountablePolicy?:MountablePolicy}>;
export type ContinuousWorldBinding=Readonly<{
  surfaceRevision:string;worldRevision:string;solidRevision:string;solids:readonly Solid[];
  dimensions:CollisionDimensions;centerHeight:number;isCurrent():boolean;
}>;
export type ContinuousMotionParams=Partial<SweepLimits>&Readonly<{maxSlides?:number;maxSupportSegments?:number;supportStep?:number}>;
export const CONTINUOUS_MOTION_DEFAULTS=Object.freeze({maxSlides:4,maxSupportSegments:64,supportStep:0.1});
/** 行程预算的计费长度（2026-10-19 起，C 内核由 B/D 接手）。曾直接用 3D 弧长与 1e-10 绝对容差比较，两处在
 *  真实城市里卡死成 travel-prefix-precision（0/42 匝道落地端，D1 审计 simulation-invalid）：
 *  1. 支撑跳变：同区域内的接缝允许 ≤ aliasTolerance（0.1）的高差，过缝那一小段里竖直落差 0.05 而水平只有 0.03，
 *     3D 长度被跳变撑大且不随裁切比例缩小，12 次裁切都压不进预算。超出最大坡度所能解释的那部分竖直落差
 *     不算油门行程（无可越覆盖时封顶 SUPPORT_STEP_EXEMPT，可越路缘用自己的预算）；真坡道照旧按 3D 计费。
 *     曾在可越覆盖时把整段 dy 都豁免：高架/匝道板的 XZ 包住车，每 tick 的 speedFraction≈1−sin(pitch)，
 *     全油门也在坡上平衡到几 km/h。坡度本身能解释的爬升必须计费。
 *  2. 浮点：坐标 ~600、高度来自 float32 时，裁切结果比预算多 2.3e-9 就判失败；容差改为相对量。 */
const SUPPORT_STEP_EXEMPT = 0.1 + 1e-6;
const budgetSlack = (remaining: number) => 1e-9 + remaining * 1e-7;
function chargedLength(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, riseAllowance: number, maxSlope: number): number {
  const h = Math.hypot(b.x - a.x, b.z - a.z), dy = Math.abs(b.y - a.y);
  const excess = Math.max(0, dy - h * Math.tan(maxSlope));
  const cap = riseAllowance > 0 ? riseAllowance : SUPPORT_STEP_EXEMPT;
  return Math.hypot(h, dy) - Math.min(excess, cap);
}
function pathCharge(path: readonly { x: number; y: number; z: number }[], riseAllowance: number, maxSlope: number): number {
  let total = 0;
  for (let k = 1; k < path.length; k++) total += chargedLength(path[k - 1], path[k], riseAllowance, maxSlope);
  return total;
}
export class ContinuousDrivingEnvironment implements DrivingEnvironment {
  private readonly solids:readonly Solid[];
  private readonly mountable:MountableQuery|null;
  constructor(private readonly regions:SurfaceRegionsBuild,private readonly binding:ContinuousWorldBinding,
    private readonly footprint:VehicleFootprint=DRIVING_FOOTPRINT,private readonly params:FootprintParams=DEFAULT_FOOTPRINT_PARAMS,
    private readonly motionParams:ContinuousMotionParams={},policy:ContinuousEnvironmentPolicy={}) {
    if(regions.status!=="ready"||regions.revision!==binding.surfaceRevision||!binding.worldRevision||binding.solidRevision!==binding.worldRevision||typeof binding.isCurrent!=="function"||![binding.dimensions.halfLength,binding.dimensions.halfWidth,binding.dimensions.halfHeight].every(n=>Number.isFinite(n)&&n>0)||!Number.isFinite(binding.centerHeight)||binding.centerHeight<0)throw new Error("invalid-continuous-world");
    this.binding=Object.freeze({...binding,dimensions:Object.freeze({...binding.dimensions})});
    this.footprint=Object.freeze({...footprint});this.params=Object.freeze({...params});this.motionParams=Object.freeze({...motionParams});
    const mountablePolicy=policy.mountablePolicy??"disabled",boundarySlide=policy.boundarySlide??false;
    if((mountablePolicy!=="disabled"&&mountablePolicy!=="gameplay")||typeof boundarySlide!=="boolean")throw new Error("invalid-continuous-policy");
    this.policy=Object.freeze({boundarySlide,mountablePolicy});
    const maxSlides=motionParams.maxSlides??CONTINUOUS_MOTION_DEFAULTS.maxSlides,maxSupportSegments=motionParams.maxSupportSegments??CONTINUOUS_MOTION_DEFAULTS.maxSupportSegments,supportStep=motionParams.supportStep??CONTINUOUS_MOTION_DEFAULTS.supportStep;
    const sweep={...DEFAULT_SWEEP_LIMITS,...motionParams};
    if(!Number.isSafeInteger(maxSlides)||maxSlides<0||maxSlides>16||!Number.isSafeInteger(maxSupportSegments)||maxSupportSegments<1||
      !Number.isFinite(supportStep)||supportStep<=0||!Number.isFinite(sweep.skin)||sweep.skin<=0||!Number.isFinite(sweep.timeTolerance)||sweep.timeTolerance<=0||sweep.timeTolerance>=1||
      ![sweep.maxTests,sweep.maxCandidates,sweep.maxIntervals,sweep.maxSourceSolids,sweep.maxPolyVertices,sweep.maxAxes].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error("invalid-continuous-budget");
    const maxSolids=motionParams.maxSourceSolids??DEFAULT_SWEEP_LIMITS.maxSourceSolids;
    const maxVertices=motionParams.maxPolyVertices??DEFAULT_SWEEP_LIMITS.maxPolyVertices;
    let elements=0;const maxAxes=motionParams.maxAxes??DEFAULT_SWEEP_LIMITS.maxAxes;
    if(!Number.isSafeInteger(maxAxes)||maxAxes<1||!Number.isSafeInteger(maxSolids)||maxSolids<1||!Number.isSafeInteger(maxVertices)||maxVertices<1||binding.solids.length>maxSolids||
      binding.solids.some(s=>(elements+=s.poly.vertices.length+s.poly.faces.length+s.poly.edges.length)>1000000||s.poly.vertices.length>maxVertices||s.poly.faces.length+s.poly.edges.length*3>maxAxes||!isValidMountableHeight(s.mountableHeight)))throw new Error("continuous-world-budget");
    // Own proxy facts so a caller cannot change collision geometry under a lease.
    this.solids=Object.freeze(binding.solids.map(s=>Object.freeze({...s,poly:{vertices:s.poly.vertices.map(v=>Object.freeze({...v})),faces:s.poly.faces.map(v=>Object.freeze({...v})),edges:s.poly.edges.map(v=>Object.freeze({...v}))}})));
    this.mountable=mountablePolicy==="gameplay"?mountableQueryOf(this.solids):null;
  }
  private readonly policy:Readonly<{boundarySlide:boolean;mountablePolicy:MountablePolicy}>;
  get worldRevision():string{return this.binding.worldRevision;}
  private current(){return this.binding.isCurrent()&&this.regions.status==="ready"&&this.regions.revision===this.binding.surfaceRevision;}
  private body=(pose:SupportedPose):BodyPose=>{
    const c=Math.cos(pose.heading),s=Math.sin(pose.heading),sp=Math.sin(pose.pitch),cp=Math.cos(pose.pitch),cr=Math.cos(pose.roll),sr=Math.sin(pose.roll),h=this.binding.centerHeight;
    return {...pose,x:pose.x+(-c*sp*cr+s*sr)*h,y:pose.y+cp*cr*h,z:pose.z+(-s*sp*cr-c*sr)*h};
  };
  private constrain=(from:SupportedPose,target:SupportedPose)=>{
    if(!this.current())return {ok:false as const,reason:"stale-world"};
    const check=validateMotion(this.regions,from,target,from.surfaceId,this.footprint,this.params,undefined,this.mountable??undefined);
    if(check.ok)return {ok:true as const,pose:{x:target.x,z:target.z,heading:target.heading,y:check.support.y,pitch:check.support.pitch,roll:check.support.roll,surfaceId:check.support.regionId}};
    // 游玩档角落蹭界滑动（街机惯例，默认关——审计会话保持触线即拒的 fail-closed）：
    // 车身角碰到区域边界时不整步拒绝，把剩余运动投影到边界线段切向重试一次，
    // 与固体层的法向滑移同一思想：蹭到角顺过去，掉切向分量之外的速度。
    if(this.policy.boundarySlide&&check.reason==="unsupported-footprint"&&check.witness){
      const w=check.witness,tx=w.bx-w.ax,tz=w.bz-w.az,len=Math.hypot(tx,tz)||1,ux=tx/len,uz=tz/len;
      const along=(target.x-from.x)*ux+(target.z-from.z)*uz;
      if(Math.abs(along)>1e-6){
        const slide={x:from.x+ux*along,z:from.z+uz*along,heading:target.heading};
        const retry=validateMotion(this.regions,from,slide,from.surfaceId,this.footprint,this.params,undefined,this.mountable??undefined);
        if(retry.ok)return {ok:true as const,pose:{x:slide.x,z:slide.z,heading:slide.heading,y:retry.support.y,pitch:retry.support.pitch,roll:retry.support.roll,surfaceId:retry.support.regionId}};
      }
    }
    return {ok:false as const,reason:`support:${check.reason}:${check.detail}`};
  };
  /** Safe placement uses the same relaxed gameplay footprint and frozen solids
   * as motion, so a start pose cannot be accepted inside an obstacle. */
  place(x:number,z:number,heading:number,regionId:string,y?:number):Readonly<{y:number;pitch:number;roll:number}>|null {
    if(!this.current())return null;
    const support=footprintSupport(this.regions,{x,z,heading,y},regionId,this.footprint,this.params,undefined,this.mountable??undefined);
    if(!support.ok)return null;
    const pose:SupportedPose={x,y:support.y,z,heading,pitch:support.pitch,roll:support.roll,surfaceId:support.regionId};
    const checked=resolveDrivingCollision(this.solids,{isCurrent:()=>this.current(),constrain:this.constrain,body:this.body},pose,pose,this.binding.dimensions,{...this.motionParams,mountablePolicy:this.policy.mountablePolicy,maxSlides:0});
    return this.current()&&checked.status==="moved"&&checked.contacts.length===0
      ?Object.freeze({y:support.y,pitch:support.pitch,roll:support.roll}):null;
  }
  move(previous:DrivingState,desired:DrivingMotion):DrivingMoveResult {
    const steps=this.motionSteps(previous,desired);let next=steps.next();
    while(!next.done)next=steps.next();
    return next.value;
  }
  /** Preparation-only driver of the identical motion job. All collision budgets,
   * contacts and trajectory state remain in one generator across host yields. */
  async moveAsync(previous:DrivingState,desired:DrivingMotion,checkpoint:()=>Promise<void>):Promise<DrivingMoveResult> {
    const steps=this.motionSteps(previous,desired);let next=steps.next();
    while(!next.done){await checkpoint();next=steps.next();}
    return next.value;
  }
  private *motionSteps(previous:DrivingState,desired:DrivingMotion):Generator<void,DrivingMoveResult,void> {
    const stopped=(reason:string,unresolved=false):DrivingMoveResult=>({...previous,blocked:true,reason,travelledDistance:0,speedFraction:0,queryStatus:unresolved?"unresolved":"resolved",trajectory:Object.freeze([{...previous}])});
    if(!this.current())return stopped("stale-world",true);
    const support=footprintSupport(this.regions,previous,previous.surfaceId,this.footprint,this.params,undefined,this.mountable??undefined);
    if(!support.ok||Math.abs(support.y-previous.y)>1e-6||Math.abs(support.pitch-previous.pitch)>1e-6||Math.abs(support.roll-previous.roll)>1e-6)return stopped("invalid-start-support",true);
    const maxSegments=this.motionParams.maxSupportSegments??CONTINUOUS_MOTION_DEFAULTS.maxSupportSegments,step=this.motionParams.supportStep??CONTINUOUS_MOTION_DEFAULTS.supportStep;
    if(!Number.isSafeInteger(maxSegments)||maxSegments<1||!Number.isFinite(step)||step<=0)return stopped("invalid-support-budget",true);
    const count=Math.max(1,Math.ceil(Math.hypot(desired.x-previous.x,desired.z-previous.z)/step),Math.ceil(Math.abs(desired.heading-previous.heading)/this.params.maxAngleStep));
    if(count>maxSegments)return stopped("support-budget",true);
    const roadBudget=desired.travelBudget??Math.hypot(desired.x-previous.x,desired.z-previous.z)/Math.max(1e-6,Math.cos(previous.pitch));
    if(!Number.isFinite(roadBudget)||roadBudget<0)return stopped("invalid-travel-budget",true);
    let pose:SupportedPose={...previous},distance=0,contact=false,tests=0,retained=1;
    const testBudget=this.motionParams.maxTests??200000;
    const trajectory:SupportedPose[]=[pose];const contacts:DrivingContact[]=[];
    for(let i=1;i<=count;i++) {
      yield;
      if(!this.current())return stopped("stale-world",true);
      // Advance along the remaining requested direction rather than teleport back
      // to a pre-collision target after a slide displaced the vehicle sideways.
      const next={...pose,x:pose.x+(desired.x-previous.x)/count,z:pose.z+(desired.z-previous.z)/count,
        heading:pose.heading+(desired.heading-previous.heading)/count};
      const resolved=resolveDrivingCollision(this.solids,{isCurrent:()=>this.current(),constrain:this.constrain,body:this.body},pose,next,this.binding.dimensions,{...this.motionParams,mountablePolicy:this.policy.mountablePolicy,maxTests:Math.max(1,testBudget-tests)});
      tests+=resolved.tests;
      if(tests>testBudget)return stopped("continuous-collision:budget",true);
      if(resolved.status==="unresolved")return stopped(`continuous-collision:${resolved.reason}`,true);
      contact ||= resolved.contacts.length>0;retained=Math.min(retained,resolved.speedFraction);
      contacts.push(...resolved.contacts.map(c=>Object.freeze({obstacleId:c.solidId,worldRevision:this.binding.worldRevision,
        time:(i-1+c.time)/count,timeUpper:(i-1+c.timeUpper)/count,normal:Object.freeze({...c.normal}),kind:c.kind})));
      let exhausted=false;
      for(const endpoint of resolved.path.slice(1)) {
        // 路面预算按 3D 弧长计费（坡道距离语义不变）；可越路缘的支撑跳变（0→岛顶）
        // 不是油门行程——端点被可越固体覆盖时，竖直落差按可越预算豁免，否则爬升会
        // 吃光本步预算、把车裁回台阶之前，死锁在路缘线上。
        const riseAllowance=this.mountable&&(()=>{
          const dx=endpoint.x-pose.x,dz=endpoint.z-pose.z,len=Math.hypot(dx,dz)||1,reach=Math.max(this.binding.dimensions.halfLength,this.footprint.wheelbase/2,this.footprint.track/2);
          // 支撑跳变发生在车轮过线而车身中心仍在岛外——用车头/车尾探针判定可越覆盖。
          return this.mountable!.covers(endpoint.x+dx/len*reach,endpoint.z+dz/len*reach)||this.mountable!.covers(pose.x-dx/len*reach,pose.z-dz/len*reach)||this.mountable!.covers(endpoint.x,endpoint.z)||this.mountable!.covers(pose.x,pose.z);
        })()?this.mountable.riseBudget:0;
        const length=chargedLength(pose,endpoint,riseAllowance,this.params.maxSlope),remaining=Math.max(0,roadBudget-distance);
        if(length>remaining+budgetSlack(remaining)) {
          let fraction=remaining/length,trimmed:ReturnType<typeof resolveDrivingCollision>|null=null,charged=Infinity;
          for(let attempt=0;attempt<12;attempt++) {
            const target={...interpolateBody(pose,endpoint,fraction),surfaceId:pose.surfaceId};
            trimmed=resolveDrivingCollision(this.solids,{isCurrent:()=>this.current(),constrain:this.constrain,body:this.body},pose,target,this.binding.dimensions,{...this.motionParams,mountablePolicy:this.policy.mountablePolicy,maxSlides:0,maxTests:Math.max(1,testBudget-tests)});
            tests+=trimmed.tests;
            if(tests>testBudget)return stopped("continuous-collision:budget",true);
            if(trimmed.status!=="moved")return stopped(`travel-prefix:${trimmed.reason}`,true);
            charged=pathCharge(trimmed.path,riseAllowance,this.params.maxSlope);
            if(charged<=remaining+budgetSlack(remaining))break;
            fraction*=remaining/charged;
          }
          if(!trimmed||charged>remaining+budgetSlack(remaining))return stopped("travel-prefix-precision",true);
          pose=trimmed.pose;distance+=charged;trajectory.push(...trimmed.path.slice(1));exhausted=true;break;
        }
        distance+=length;pose=endpoint;trajectory.push(pose);
      }
      if(exhausted||resolved.status==="stopped")break;
    }
    if(!this.current())return stopped("stale-world",true);
    const requested=roadBudget;
    const moved=distance>1e-10||pose.heading!==previous.heading;
    // An idle vehicle legitimately produces no displacement. Only report a
    // support stop when the simulation had a movement budget to spend; otherwise
    // the gameplay HUD would claim an obstacle at every stationary spawn.
    const blocked=!moved&&requested>1e-10;
    return {...pose,blocked,reason:contact?"contact":blocked?"support-stop":undefined,travelledDistance:distance,
      speedFraction:requested>0?Math.min(retained,distance/requested):retained,contact,contacts:Object.freeze(contacts),queryStatus:"resolved",trajectory:Object.freeze(trajectory.map(p=>Object.freeze({...p})))};
  }
  /** B can call this on every submitted piece instead of trusting a trace label. */
  /** Road-budget distance of a trajectory (the odometer's unit): 3D arc length minus seam support steps.
   *  The audit validator measures with this, not its own 3D sum, so the two cannot disagree on a seam. */
  travelCharge(path:readonly {x:number;y:number;z:number}[]):number{return pathCharge(path,0,this.params.maxSlope);}
  validateTrajectory(previous:Readonly<DrivingTrajectoryPose>,next:Readonly<DrivingTrajectoryPose>,path:readonly Readonly<DrivingTrajectoryPose>[]):boolean {
    if(!this.current()||path.length<1||path.length>2048)return false;
    const same=(a:Readonly<DrivingTrajectoryPose>,b:Readonly<DrivingTrajectoryPose>)=>["x","y","z","heading","pitch","roll"].every(k=>Math.abs(a[k as "x"]-b[k as "x"])<=1e-8)&&a.surfaceId===b.surfaceId;
    if(!same(path[0],previous)||!same(path[path.length-1],next))return false;
    const start=this.constrain(path[0],path[0]);
    if(!start.ok||!same(start.pose,path[0]))return false;
    const stationary=resolveDrivingCollision(this.solids,{isCurrent:()=>this.current(),constrain:this.constrain,body:this.body},path[0],path[0],this.binding.dimensions,{...this.motionParams,mountablePolicy:this.policy.mountablePolicy,maxSlides:0});
    if(stationary.status!=="moved"||stationary.contacts.length)return false;
    let tests=stationary.tests;const budget=this.motionParams.maxTests??200000;
    for(let i=1;i<path.length;i++) {
      const a=path[i-1],b=path[i];
      const support=this.constrain(a,b);if(!support.ok||!same(support.pose,b))return false;
      // resolve with zero slides: any contact means the submitted piece was not
      // collision-free. A forged endpoint or path cannot turn contact into pass.
      const checked=resolveDrivingCollision(this.solids,{isCurrent:()=>this.current(),constrain:this.constrain,body:this.body},a,b,this.binding.dimensions,{...this.motionParams,mountablePolicy:this.policy.mountablePolicy,maxSlides:0,maxTests:Math.max(1,budget-tests)});
      tests+=checked.tests;
      if(tests>budget)return false;
      if(checked.status!=="moved"||checked.contacts.length||!same(checked.pose,b))return false;
    }
    return this.current();
  }
}
