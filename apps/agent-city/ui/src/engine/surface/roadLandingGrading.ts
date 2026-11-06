/** Bounded lowland earthworks at ground-road/bridge junctions. The wrapped
 * terrain is shared by every renderer and surface compiler, never a decal lift. */
import { DetMath as Math } from "../detMath";
import type { RoadEdge, TerrainField, Vec2 } from "../cityLayout";
export const ROAD_LANDING_GRADING_VERSION = 2;
const cache = new WeakMap<TerrainField,WeakMap<object,TerrainField>>();
/** graded → the raw field it was graded from. Earthworks follow the road set: when a plan
 * patch replaces roads (a player erases a bridge and draws another), the patched layout
 * must be regraded from the raw field, not stacked on pads left by the generator's roads. */
const ungraded = new WeakMap<TerrainField,TerrainField>();
/** Regrade a (possibly already graded) field for a new road set. */
export function regradeRoadLandings(terrain:TerrainField,roads:readonly RoadEdge[]):TerrainField {
  return gradeRoadLandings(ungraded.get(terrain)??terrain,roads);
}
const smooth = (x:number) => { const t=Math.max(0,Math.min(1,x)); return t*t*(3-2*t); };
export function gradeRoadLandings(base:TerrainField,roads:readonly RoadEdge[]):TerrainField {
  const prior=cache.get(base)?.get(roads); if(prior)return prior;
  const valid=roads.filter(road=>Number.isFinite(road.width)&&road.width>0&&road.points.length>=2&&
    road.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.z)));
  const byPoint=new Map<string,{point:Vec2;roads:RoadEdge[]}>();
  const key=(p:Vec2)=>`${p.x}:${p.z}`;
  for(const road of valid) {
    if(road.bridge||road.structure==="deck"||road.points.length<2)continue;
    for(const p of [road.points[0],road.points[road.points.length-1]]) {
      let entry=byPoint.get(key(p));if(!entry){entry={point:p,roads:[]};byPoint.set(key(p),entry);}entry.roads.push(road);
    }
  }
  const zones=new Map<string,{x:number;z:number;core:number;outer:number;target:number}>();
  for(const bridge of valid) {
    if(!bridge.bridge||bridge.points.length<2)continue;
    // One-ended decorative/dead-end spans need their own abutment model before
    // changing elevation; do not lift their sole bank under a fixed far deck.
    if(!byPoint.has(key(bridge.points[0]))||!byPoint.has(key(bridge.points[bridge.points.length-1])))continue;
    for(const end of [bridge.points[0],bridge.points[bridge.points.length-1]]) {
      const entry=byPoint.get(key(end)),h=base.height(end.x,end.z);
      if(!entry||!Number.isFinite(h)||h<0||h>4)continue;
      let target=h,width=bridge.width;
      for(const road of entry.roads) {
        width=Math.max(width,road.width);
        const points=key(road.points[0])===key(end)?road.points:[...road.points].reverse();
        let walked=0;
        for(let i=1;i<points.length&&walked<18;i++) {
          const a=points[i-1],b=points[i],length=Math.hypot(b.x-a.x,b.z-a.z);
          if(length<=0)continue;
          const reach=Math.min(length,18-walked);
          for(let d=0;d<=reach;d+=Math.min(2,reach||1)) {
            const t=d/length,sample=base.height(a.x+(b.x-a.x)*t,a.z+(b.z-a.z)*t);
            if(sample>=0&&sample<=4)target=Math.max(target,sample);
          }
          walked+=length;
        }
      }
      if(target-h<0.02)continue;
      // Keep the sampled approach inside the pad. Blending back before that
      // anchor would create a new dip between the raised pad and uphill road.
      const core=Math.max(18,width/2+2,zones.get(key(end))?.core??0);
      zones.set(key(end),{x:end.x,z:end.z,core,outer:core+12,target:Math.min(h+1.2,target)});
    }
  }
  // Keep the channel under each span open. The approach pad may raise a dry
  // abutment, but must not reclaim shallow water between the two landings.
  const channels=valid.filter(road=>road.bridge).flatMap(road=>{
    const a=road.points[0],b=road.points[road.points.length-1],length=Math.hypot(b.x-a.x,b.z-a.z);
    return length>0&&Number.isFinite(length)?[{a,dx:(b.x-a.x)/length,dz:(b.z-a.z)/length,length,half:road.width/2,landing:Math.min(3,length/3),blend:Math.min(1,length/12)}]:[];
  });
  const ordered=[...zones.values()].sort((a,b)=>a.x-b.x||a.z-b.z);
  const height=(x:number,z:number)=>{
    const raw=base.height(x,z);
    // No reclamation, mountain cuts, or changes to seabed/river channels.
    if(raw<=0||raw>4)return raw;
    let weighted=0,total=0;
    for(const zone of ordered) {
      const dx=x-zone.x,dz=z-zone.z,d2=dx*dx+dz*dz;
      if(d2>=zone.outer*zone.outer)continue;
      const weight=1-smooth((Math.sqrt(d2)-zone.core)/(zone.outer-zone.core));
      weighted+=weight*zone.target;total+=weight;
    }
    if(total===0)return raw;
    let channel=0;
    if(raw<0.7)for(const span of channels){
      const dx=x-span.a.x,dz=z-span.a.z,along=dx*span.dx+dz*span.dz;
      const endDistance=Math.min(along,span.length-along),lateral=Math.abs(dx*span.dz-dz*span.dx);
      // Keep the same bounded landing zone as bridgeDeckProfile, including
      // short spans; fade to the channel within one unit and two at its sides.
      const protectedWeight=smooth((endDistance-span.landing)/span.blend)*(1-smooth((lateral-span.half)/2))*(1-smooth((raw-0.5)/0.2));
      channel=Math.max(channel,protectedWeight);
    }
    return raw+(1-channel)*Math.min(1,total)*smooth(raw/0.2)*Math.max(0,Math.min(1.2,weighted/total-raw));
  };
  const terrain=ordered.length?{...base,height,slope:(x:number,z:number)=>Math.hypot(height(x+1,z)-height(x-1,z),height(x,z+1)-height(x,z-1))/2}:base;
  if(terrain!==base)ungraded.set(terrain,base);
  let worlds=cache.get(base);if(!worlds){worlds=new WeakMap();cache.set(base,worlds);}worlds.set(roads,terrain);
  return terrain;
}
