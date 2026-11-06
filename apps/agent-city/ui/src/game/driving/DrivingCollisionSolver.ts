/** Bounded C motion solver. Every accepted segment is checked, including slides.
 * The support callback is B's authority and can refuse any projection; recovery
 * from initial overlap is intentionally left to SafeRecovery. */
import type { Solid, CollisionDimensions } from "./CollisionIndex";
import { sweepBody, interpolateBody, type BodyPose, type SweepOptions, type SweepContact } from "./DrivingCollision";
export type SupportedPose=BodyPose & Readonly<{surfaceId:string}>;
export type MotionProjection=Readonly<{ok:true;pose:SupportedPose}>|Readonly<{ok:false;reason:string}>;
export type CollisionMotionWorld=Readonly<{
  isCurrent():boolean;
  constrain(from:SupportedPose,target:SupportedPose):MotionProjection;
  body(pose:SupportedPose):BodyPose;
}>;
export type ResolvedMotion=Readonly<{status:"moved"|"stopped"|"unresolved";reason:string;pose:SupportedPose;
  path:readonly SupportedPose[];contacts:readonly SweepContact[];distance:number;speedFraction:number;tests:number}>;
export function resolveDrivingCollision(solids:readonly Solid[],world:CollisionMotionWorld,from:SupportedPose,to:SupportedPose,
  dimensions:CollisionDimensions,options:SweepOptions&Readonly<{maxSlides?:number}>={}):ResolvedMotion {
  const maxSlides=options.maxSlides??4,contacts:SweepContact[]=[],path:SupportedPose[]=[Object.freeze({...from})];
  let current=path[0],goal=to,distance=0,tests=0,elapsed=0;
  let velocity:Readonly<{x:number;y:number;z:number}>|null=null,initialVelocityLength=0;
  const sweep=(a:BodyPose,b:BodyPose)=>{const value=sweepBody(solids,a,b,dimensions,{...options,maxTests:Math.max(1,(options.maxTests??200000)-tests)});tests+=value.tests;return value;};
  const requested=Math.hypot(to.x-from.x,to.y-from.y,to.z-from.z);
  const finish=(status:ResolvedMotion["status"],reason:string):ResolvedMotion=>Object.freeze({status,reason,
    // Query uncertainty rolls back the whole transaction, never applies a prefix
    // from one revision while leaving later unknown pieces unverified.
    pose:status==="unresolved"?from:current,path:Object.freeze(status==="unresolved"?[from]:path),contacts:Object.freeze(contacts),
    tests,distance:status==="unresolved"?0:distance,speedFraction:status!=="moved"?0:contacts.length?initialVelocityLength>0&&velocity?Math.min(1,Math.hypot(velocity.x,velocity.y,velocity.z)/initialVelocityLength):0:requested>0?Math.min(1,distance/requested):1});
  if(!Number.isSafeInteger(maxSlides)||maxSlides<0||maxSlides>16)return finish("unresolved","invalid-slide-budget");
  const accept=(pose:SupportedPose)=>{distance+=Math.hypot(pose.x-current.x,pose.y-current.y,pose.z-current.z);current=Object.freeze({...pose});path.push(current);};
  for(let iteration=0;iteration<=maxSlides;iteration++) {
    if(!world.isCurrent())return finish("unresolved","stale-world");
    const projected=world.constrain(current,goal);
    if(!world.isCurrent())return finish("unresolved","stale-world");
    if(!projected.ok)return finish("stopped",projected.reason);
    goal=projected.pose;
    if(!velocity){velocity={x:goal.x-current.x,y:goal.y-current.y,z:goal.z-current.z};initialVelocityLength=Math.hypot(velocity.x,velocity.y,velocity.z);}
    const hit=sweep(world.body(current),world.body(goal));
    if(!world.isCurrent())return finish("unresolved","stale-world");
    if(hit.status==="unresolved")return finish("unresolved",hit.reason);
    if(hit.status==="clear"){accept(goal);return finish("moved",contacts.length?"slide":"none");}
    const contact=hit.contact!;
    const inward:number=velocity.x*contact.normal.x+velocity.y*contact.normal.y+velocity.z*contact.normal.z;
    if(inward<0)velocity={x:velocity.x-inward*contact.normal.x,y:velocity.y-inward*contact.normal.y,z:velocity.z-inward*contact.normal.z};
    contacts.push(Object.freeze({...contact,time:elapsed+(1-elapsed)*contact.time,timeUpper:elapsed+(1-elapsed)*contact.timeUpper}));
    const magnitude=Math.hypot(goal.x-current.x,goal.y-current.y,goal.z-current.z)+
      Math.hypot(dimensions.halfLength,dimensions.halfWidth,dimensions.halfHeight)*(Math.abs(goal.heading-current.heading)+Math.abs(goal.pitch-current.pitch)+Math.abs(goal.roll-current.roll));
    const t=Math.max(0,contact.time-(options.skin??1e-4)*0.1/Math.max(magnitude,1e-12));
    if(t>0) {
      const prefix={...interpolateBody(current,goal,t),surfaceId:current.surfaceId};
      const support=world.constrain(current,prefix);
      if(!world.isCurrent())return finish("unresolved","stale-world");
      if(!support.ok)return finish("stopped",support.reason);
      // Re-fitting pitch/roll/height may change a collision path: recheck it.
      const checked=sweep(world.body(current),world.body(support.pose));
      if(checked.status!=="clear")return finish("unresolved",`prefix:${checked.reason}`);
      if(!world.isCurrent())return finish("unresolved","stale-world");
      accept(support.pose);
    }
    elapsed+=(1-elapsed)*t;
    if(iteration===maxSlides)return finish("stopped","slide-limit");
    let dx=goal.x-current.x,dy=goal.y-current.y,dz=goal.z-current.z;
    // Accumulate planes; projection may only remove inward velocity. Bounded
    // sweeps below are the final authority at non-orthogonal corners.
    for(const plane of contacts) {
      const n=plane.normal,inward=dx*n.x+dy*n.y+dz*n.z;
      if(inward<0){dx-=inward*n.x;dy-=inward*n.y;dz-=inward*n.z;}
    }
    if(Math.hypot(dx,dy,dz)<1e-9)return finish("stopped","contact");
    // Freeze remaining angular motion at first contact. Rotation into a wall
    // is not translated into an unvalidated orbit around the contact point.
    goal={...current,x:current.x+dx,y:current.y+dy,z:current.z+dz};
  }
  return finish("stopped","slide-limit");
}
