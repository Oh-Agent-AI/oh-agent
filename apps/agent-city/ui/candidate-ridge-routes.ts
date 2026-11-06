import { buildCityModel } from './src/cityModel.ts';
import { layoutCity } from './src/engine/cityLayout.ts';
import { MIAMI_COASTAL } from './src/engine/citySeaside.ts';
import { terrainSurfaceHeight } from './src/engine/surface/terrainSampling.ts';
import { anchorsFromCity, siteFightShapes, cellWorld } from './src/game/mecha/citySite.ts';
import { matchFromSite } from './src/game/mecha/matchFromSite.ts';
import { bossPrepare, movementPath, validateAndApplyPlan } from './src/game/mecha/rules.ts';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { compileGroundRoadSurface } from './src/engine/surface/groundRoadCompiler.ts';
import { createAssaultCityGround } from './src/game/assaultCityGround.ts';
import { parseMechaManifest } from './src/render/mecha/glbModels.ts';
import { parseAssaultSkinGlb } from './src/render/mecha/assaultSkinGlb.ts';
import { createAssault, disposeMechaModel, upgradeMechaModelToGlb } from './src/render/mecha/models.ts';
import { createConnectedAssaultPreviewPlayer } from './src/render/mecha/connectedAssaultPreview.ts';
import { AssaultGroundController } from './src/render/mecha/assaultGroundController.ts';
import { AssaultContactSampler } from './src/render/mecha/assaultContact.ts';
import { AssaultTurnIK } from './src/render/mecha/assaultTurnIK.ts';
import { solveAssaultLeg } from './src/render/mecha/assaultLegIK.ts';
import { sampleAssaultTerrainSafety } from './src/game/mecha/assaultTerrainSafety.ts';
import { createAssaultGaitPlan, sampleAssaultGait } from './src/render/mecha/assaultGait.ts';
import { measureAssaultStride } from './src/render/mecha/assaultStride.ts';
import { poseMechaModel } from './src/render/mecha/animation.ts';

const now = Date.UTC(2026, 9, 7), day = 86400000;
const rows = Array.from({length: 80}, (_, i) => ({
  session_ref: `s:${i}`, harness: i % 2 ? 'harness:claude' : 'harness:zcode', title: null, title_source: null,
  first_event_at: new Date(now - day * 20 + i * 3600000).toISOString(), last_event_at: new Date(now - day * 20 + (i + 2) * 3600000).toISOString(), event_count: 10, model_ids: [],
  tokens: {uncached_input_tokens: 50000 + i * 900000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total: 50000 + i * 900000}, peak_tokens: 50000 + i * 900000,
  cost_minor: null, cost_status: {state: 'unavailable' as const, reason: 'test', has_unresolved: false},
}));
const model = buildCityModel({rows, findings: [], windowStartMs: now - 30 * day, windowEndMs: now, windowLabel: '30d', totalSessions: rows.length, truncated: false, generatedAt: now});
const layout = layoutCity(model, null, 64, MIAMI_COASTAL, 'off');
const site = siteFightShapes(layout.terrain, anchorsFromCity(layout, model), layout.roadEdges).ridge;
if (!site) throw new Error('ridge unavailable');
const height = (x: number, z: number) => terrainSurfaceHeight(layout, x, z);
const realHeight = createAssaultCityGround(layout, compileGroundRoadSurface(layout));
const safety = sampleAssaultTerrainSafety(site, height, 2, .5, .25);
const state = matchFromSite({ ...site, assaultTerrainSafety: safety }, { preset: 'covers_sparse_mid', script: 'siege' });
const results = [];
for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) for (const [nx, ny] of [[x + 1, y], [x, y + 1]]) {
  if (nx >= 10 || ny >= 10 || !['land', 'road'].includes(site.terrain[y]![x]!) || !['land', 'road'].includes(site.terrain[ny]![nx]!)) continue;
  const from = {x,y}, to = {x:nx,y:ny};
  const blocked = (c: typeof from) => safety.unsafeCells.some(cell => cell.x === c.x && cell.y === c.y) || site.blocked.some(cell => cell.x === c.x && cell.y === c.y) || site.buildings.some(building => building.cells.some(cell => cell.x === c.x && cell.y === c.y));
  if (blocked(from) || blocked(to)) continue;
  const path = movementPath(state, from, to, 'Assault', {alliesPass:true});
  if (!path || path.length !== 2) continue;
  const a = cellWorld(site, from), b = cellWorld(site, to);
  let max = 0, at = 0, curve = 0;
  for (let i = 0; i <= 100; i++) {
    const t = i/100, px = a.x + (b.x-a.x)*t, pz = a.z+(b.z-a.z)*t;
    const dx=(height(px+2,pz)-height(px-2,pz))/4, dz=(height(px,pz+2)-height(px,pz-2))/4;
    const grade=Math.hypot(dx,dz), base=realHeight(px,pz);
    for (const ox of [-2,2]) for (const oz of [-2,2]) curve=Math.max(curve,Math.abs(realHeight(px+ox,pz+oz)-base-dx*ox-dz*oz));
    if (grade > max) {max = grade; at=t;}
  }
  results.push({from,to,path,grade:max,at,curve});
}
results.sort((a,b)=>b.curve-a.curve);
console.log(JSON.stringify({seed:64, count:results.length, top:results.slice(0,10)},null,2));
const bytes = readFileSync('src/assets/mecha/assault-connected-candidate.glb'), length = bytes.readUInt32LE(12);
const json = JSON.parse(bytes.subarray(20, 20 + length).toString()), rest = bytes.subarray(20 + length);
for (const material of json.materials ?? []) { const p = material.pbrMetallicRoughness ?? {}; delete p.baseColorTexture; delete p.metallicRoughnessTexture; delete material.emissiveTexture; }
delete json.images; delete json.textures; delete json.samplers;
let text = Buffer.from(JSON.stringify(json)); text = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 32)]);
const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + text.length + rest.length, 8); header.writeUInt32LE(text.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
const out = Buffer.concat([header, text, rest]);
const manifest = parseMechaManifest(JSON.parse(readFileSync('src/assets/mecha/assault-connected-candidate.manifest.json', 'utf8')));
const asset = await parseAssaultSkinGlb(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength), manifest, {scale:21.245691361301702,sourceForward:'+Z'});
const originalGroundFeet = AssaultGroundController.prototype.feet;
for (const candidate of results.slice(0, process.env.IDLE_ONLY ? 0 : Number(process.env.ROUTES ?? 10)).flatMap(route => [route, {...route, from:route.to, to:route.from, path:[...route.path].reverse()}]).filter(route => !process.env.FAIL_ROUTE || (route.from.x === 7 && route.from.y === 5 && route.to.x === 7 && route.to.y === 6)).filter(route => !process.env.HANDOFF || (route.from.x === Number(process.env.FROM_X ?? 8) && route.from.y === Number(process.env.FROM_Y ?? 8) && route.to.x === Number(process.env.TO_X ?? 7) && route.to.y === Number(process.env.TO_Y ?? 8)))) {
AssaultGroundController.prototype.feet = originalGroundFeet;
const route = candidate;
const actual = structuredClone(state);
actual.mechs.find(mech => mech.id === 'Assault')!.pos = {...route.from};
bossPrepare(actual);
const accepted = validateAndApplyPlan(actual, {revision:actual.revision,items:actual.mechs.map(mech => ({mechId:mech.id,moveTo:mech.id === 'Assault' ? route.to : null,action:{kind:'skip' as const}}))});
console.log(JSON.stringify({accepted}));
const actor = createAssault(), effects = new THREE.Group(); upgradeMechaModelToGlb(actor, asset); actor.scale.setScalar(2);
const reference = createAssault(); upgradeMechaModelToGlb(reference, asset); reference.scale.setScalar(2);
const toWorld = (c: {x:number;y:number}) => { const p = cellWorld(site, c); return new THREE.Vector3(p.x, p.y, p.z); };
actor.position.copy(toWorld(route.from));
let initialStanding: THREE.Vector3 | undefined;
if (process.env.TRANSITION) {
  const standing = new AssaultGroundController(actor, {asset,height:realHeight,terrain:height,radius:2,maxGrade:.5,maxDrop:.3});
  const contacts = new AssaultContactSampler(actor, asset);
  poseMechaModel(actor, 'idle', 0); standing.align(Number(process.env.YAW ?? 0)); actor.updateMatrixWorld(true);
  actor.position.y -= process.env.SINGLE ? Math.max(0, Math.min(.3, contacts.clearance(0,realHeight),contacts.clearance(1,realHeight))) : Math.max(0, Math.max(contacts.clearance(0,realHeight),contacts.clearance(1,realHeight)));
  standing.feet(0,0); actor.updateMatrixWorld(true);
  initialStanding = actor.position.clone();
}
let done = 0;
const meshes: THREE.SkinnedMesh[] = [];
actor.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(object as THREE.SkinnedMesh); });
const footVertices = meshes.map(mesh => {
  const names = mesh.skeleton.bones.map(bone => bone.name), indices = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
  const selected = [];
  for (let i = 0; i < indices.count; i++) for (let j = 0; j < 4; j++) {
    if (weights.getComponent(i,j) > 1e-6 && /^(foot|toe)[LR]$/.test(names[indices.getComponent(i,j)]!)) {selected.push(i); break;}
  }
  return {mesh,selected};
});
let minFoot = Infinity, minBody = Infinity, worstFootFrame = -1, worstBodyFrame = -1, lengthError = 0;
const legs = ['L','R'].map(side => [actor.getObjectByName('thigh'+side)!, actor.getObjectByName('shin'+side)!, actor.getObjectByName('foot'+side)!]);
const initialBones = legs.flat().map(bone => bone.getWorldPosition(new THREE.Vector3()));
let previousBones = initialBones.map(p => p.clone()), previousPosition = actor.position.clone();
let previousReference: THREE.Vector3[] | undefined;
let previousFeet: THREE.Quaternion[] | undefined;
let previousVertices = new Map<string,THREE.Vector3>();
const contactMotion: Array<{frame:number;side:number;horizontal:number;vertical:number;angle:number;ankleHorizontal:number;ankleVertical:number;groundGap:number}> = [];
const poseSteps: Array<{frame:number;rootStep:number;boneStep:number;referenceStep:number;footSteps:number[];bone:string;gaps:number[];sample:ReturnType<typeof sampleAssaultGait>}> = [];
const measureLegs = () => legs.map(([thigh,shin,foot]) => {const a = thigh!.getWorldPosition(new THREE.Vector3()), b = shin!.getWorldPosition(new THREE.Vector3()), c = foot!.getWorldPosition(new THREE.Vector3()); return [a.distanceTo(b),b.distanceTo(c)];});
actor.updateMatrixWorld(true); const initialLengths = measureLegs();
if (initialStanding) actor.rotation.set(0, Number(process.env.YAW ?? 0), 0);
if (process.env.STAND_TURN) {
  const align = AssaultGroundController.prototype.align;
  AssaultGroundController.prototype.align = function(yaw,lift,pitch) {
    align.call(this,yaw,lift,pitch);
    if (!new Error().stack?.includes('sampleTurn')) return;
    actor.updateMatrixWorld(true);
    const contact = new AssaultContactSampler(actor,asset);
    const needed = Math.min(.8,Math.max(0,contact.clearance(0,realHeight),contact.clearance(1,realHeight)));
    let factor=1;
    if (process.env.TURN_BLEND) {
      const stage=gaitPlan.stages.find(s=>s.kind==='turn' && previewElapsed >= s.start && previewElapsed < s.start+s.duration);
      const remaining=stage ? stage.start+stage.duration-previewElapsed : 0;
      const t=Math.max(0,Math.min(1,remaining/Number(process.env.TURN_BLEND)));
      factor=t*t*(3-2*t);
    }
    actor.position.y -= needed*factor;
    this.feet(0,0);
  };
}
const experimentalLeg = (leg: {thigh:THREE.Object3D;shin:THREE.Object3D;foot:THREE.Object3D;upper:number;lower:number}, target: THREE.Vector3, rotation:THREE.Quaternion, side:number, correction:number) => {
  if (!process.env.KNEE_BLEND) return solveAssaultLeg(actor,leg,target,rotation);
  actor.updateMatrixWorld(true);
  const hip=leg.thigh.getWorldPosition(new THREE.Vector3()), knee=leg.shin.getWorldPosition(new THREE.Vector3());
  const direction=target.clone().sub(hip).normalize(), raw=knee.sub(hip); raw.addScaledVector(direction,-raw.dot(direction));
  const pole=new THREE.Vector3(side ? 1 : -1,0,.7).applyQuaternion(actor.quaternion); pole.addScaledVector(direction,-pole.dot(direction)).normalize();
  const t=Math.min(1,Math.abs(correction)/Number(process.env.KNEE_BLEND)), weight=t*t*(3-2*t);
  const bend=raw.normalize().lerp(pole,weight).normalize(), distance=target.distanceTo(hip);
  const along=(leg.upper**2-leg.lower**2+distance**2)/(2*distance), height=Math.sqrt(Math.max(0,leg.upper**2-along**2));
  const desired=hip.clone().addScaledVector(direction,along).addScaledVector(bend,height);
  const rotate=(joint:THREE.Object3D,child:THREE.Object3D,to:THREE.Vector3)=>{const j=joint.getWorldPosition(new THREE.Vector3()), c=child.getWorldPosition(new THREE.Vector3()); const q=new THREE.Quaternion().setFromUnitVectors(c.sub(j).normalize(),to.normalize()).multiply(joint.getWorldQuaternion(new THREE.Quaternion())); joint.quaternion.copy(joint.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q)); actor.updateMatrixWorld(true);};
  rotate(leg.thigh,leg.shin,desired.clone().sub(hip)); rotate(leg.shin,leg.foot,target.clone().sub(desired));
  leg.foot.quaternion.copy(leg.foot.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rotation)); actor.updateMatrixWorld(true);
};
if (process.env.KNEE_RATIO) {
  const ratio = Number(process.env.KNEE_RATIO);
  AssaultGroundController.prototype.feet = function(phase,maxDrop) {
    const contact = new AssaultContactSampler(actor,asset);
    for (const [side,index] of [['L',0],['R',1]] as const) {
      const [start,end] = index === 0 ? [.08,.6] : [.51,.98];
      const weight = Math.max(0,Math.min(1,(phase-start)/.10,(end-phase)/.16));
      const thigh=actor.getObjectByName('thigh'+side)!,shin=actor.getObjectByName('shin'+side)!,foot=actor.getObjectByName('foot'+side)!;
      for (let iteration=0;iteration<8;iteration++) {
        actor.updateMatrixWorld(true);
        const clearance=contact.clearance(index,realHeight);
        let correction=clearance < -1e-6 ? -clearance : iteration===0 && clearance>0 ? -Math.min(clearance,maxDrop)*weight : 0;
        if (Math.abs(correction)<=1e-6) break;
        const hip=thigh.getWorldPosition(new THREE.Vector3()),knee=shin.getWorldPosition(new THREE.Vector3()),ankle=foot.getWorldPosition(new THREE.Vector3());
        const upper=hip.distanceTo(knee),lower=knee.distanceTo(ankle),v=ankle.clone().sub(hip),distance=v.length();
        if (correction<0) {
          const along=(upper*upper-lower*lower+distance*distance)/(2*distance);
          const kneeHeight=Math.sqrt(Math.max(0,upper*upper-along*along))*ratio;
          const maximum=Math.sqrt(upper*upper-kneeHeight*kneeHeight)+Math.sqrt(lower*lower-kneeHeight*kneeHeight);
          const horizontal=v.x*v.x+v.z*v.z;
          correction=-Math.max(0,Math.min(-correction,v.y+Math.sqrt(Math.max(0,maximum*maximum-horizontal))));
        }
        if (Math.abs(correction)<=1e-6) break;
        if(maxDrop>0) experimentalLeg({thigh,shin,foot,upper,lower},ankle.add(new THREE.Vector3(0,correction,0)),foot.getWorldQuaternion(new THREE.Quaternion()),index,correction);
        else solveAssaultLeg(actor,{thigh,shin,foot,upper,lower},ankle.add(new THREE.Vector3(0,correction,0)),foot.getWorldQuaternion(new THREE.Quaternion()));
      }
      if (contact.clearance(index,realHeight)<-1e-5) throw new Error('experimental grounding did not converge');
    }
    if (process.env.GAIT_SUPPORT && (maxDrop > 0 || process.env.TURN_SUPPORT)) {
      const drop=Math.max(0,Math.min(contact.clearance(0,realHeight),contact.clearance(1,realHeight)));
      actor.position.y -= drop;
      for (const [side,index] of [['L',0],['R',1]] as const) {
        const thigh=actor.getObjectByName('thigh'+side)!,shin=actor.getObjectByName('shin'+side)!,foot=actor.getObjectByName('foot'+side)!;
        for (let iteration=0;iteration<8;iteration++) {
          actor.updateMatrixWorld(true);
          const clearance=contact.clearance(index,realHeight);
          if (clearance >= -1e-6) break;
          const hip=thigh.getWorldPosition(new THREE.Vector3()),knee=shin.getWorldPosition(new THREE.Vector3()),ankle=foot.getWorldPosition(new THREE.Vector3());
          solveAssaultLeg(actor,{thigh,shin,foot,upper:hip.distanceTo(knee),lower:knee.distanceTo(ankle)},ankle.add(new THREE.Vector3(0,-clearance,0)),foot.getWorldQuaternion(new THREE.Quaternion()));
        }
        if (contact.clearance(index,realHeight)<-1e-5) throw new Error('experimental support did not converge');
      }
    }
  };
}
if (process.env.CAP) {
  const feet = AssaultGroundController.prototype.feet;
  AssaultGroundController.prototype.feet = function(phase,maxDrop) { return feet.call(this,phase,Math.min(maxDrop,Number(process.env.CAP))); };
}
const preview = createConnectedAssaultPreviewPlayer({Assault:actor}, [{kind:'move',actor:'Assault',path:route.path,duration:.5}], toWorld, effects, () => done++, {height:realHeight,terrain:height,radius:2,maxGrade:.5,maxDrop:.3});
const measured = measureAssaultStride(asset);
const gaitPlan = createAssaultGaitPlan(route.path.map(toWorld), Number(process.env.YAW ?? 0), measured.stride * 2, .25, delta => Math.max(.25,(Math.ceil(Math.abs(delta)/(Math.PI/12))+1)*.4), 1);
if (process.env.BLEND_ENDPOINTS) {
  const blendActor = createAssault(); upgradeMechaModelToGlb(blendActor, asset); blendActor.scale.setScalar(2);
  blendActor.position.copy(toWorld(route.from));
  const control = new AssaultGroundController(blendActor, {asset,height:realHeight,terrain:height,radius:2,maxGrade:.5,maxDrop:.3});
  const contact = new AssaultContactSampler(blendActor,asset);
  const stage = gaitPlan.stages.find(s => s.kind === 'turn');
  if (!stage || stage.kind !== 'turn') { console.log(JSON.stringify({experiment:'interpolated-turn-to-walk',from:route.from,to:route.to,skipped:'no turn'})); disposeMechaModel(blendActor); preview.player.dispose(); preview.release(); disposeMechaModel(actor); disposeMechaModel(reference); if (process.env.BLEND_BATCH) continue; process.exit(0); }
  blendActor.rotation.y = stage.yaw; poseMechaModel(blendActor,'idle',0); control.align(stage.yaw);
  blendActor.updateMatrixWorld(true);
  blendActor.position.y -= Math.min(.8,Math.max(0,contact.clearance(0,realHeight),contact.clearance(1,realHeight)));
  control.feet(0,0);
  const turnIK = new AssaultTurnIK(blendActor,.012*21.245691361301702,.022*21.245691361301702);
  turnIK.sample(stage.delta,1); control.feet(0,0); control.support();
  const bones: THREE.Bone[] = [];
  blendActor.traverse(o => {if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);});
  const capture = () => ({position:blendActor.position.clone(), quaternion:blendActor.quaternion.clone(), bones:bones.map(b => ({position:b.position.clone(),quaternion:b.quaternion.clone().normalize(),scale:b.scale.clone()}))});
  const a = capture();
  blendActor.position.copy(toWorld(route.from)); blendActor.rotation.y = stage.yaw+stage.delta;
  poseMechaModel(blendActor,'move',0); control.align(stage.yaw+stage.delta); control.feet(0,.3); control.support();
  const b = capture();
  const apply = (t:number) => {
    const u=t*t*(3-2*t);
    blendActor.position.lerpVectors(a.position,b.position,u); blendActor.quaternion.slerpQuaternions(a.quaternion,b.quaternion,u);
    if(bridge) blendActor.position.y-=bridge.sag*Math.sin(Math.PI*t)**2;
    bones.forEach((bone,i) => { bone.position.lerpVectors(a.bones[i]!.position,b.bones[i]!.position,u); bone.quaternion.slerpQuaternions(a.bones[i]!.quaternion,b.bones[i]!.quaternion,u); bone.scale.lerpVectors(a.bones[i]!.scale,b.bones[i]!.scale,u); });
    if (process.env.ANCHOR_STEP) {
      blendActor.updateMatrixWorld(true);
      const initialGaps=endpoints[0]!.gaps, moves=[2,5].map(j=>endpoints[0]!.points[j]!.distanceTo(endpoints[1]!.points[j]!));
      const swingFirst=initialGaps[0]!>1e-4 && initialGaps[1]!<=1e-4 ? 0 : initialGaps[1]!>1e-4 && initialGaps[0]!<=1e-4 ? 1 : moves[0]!>=moves[1]! ? 0 : 1;
      for(const side of [0,1]) {
        const j=side*3, progress=Math.max(0,Math.min(1,side===swingFirst ? t*2 : t*2-1)), eased=progress*progress*(3-2*progress);
        let target=endpoints[0]!.points[j+2]!.clone().lerp(endpoints[1]!.points[j+2]!,eased);
        let rotation=endpoints[0]!.rotations[side]!.clone().slerp(endpoints[1]!.rotations[side]!,eased).normalize();
        if(bridge) {
          const third=Math.min(2,Math.floor(t*3)), part=Math.max(0,Math.min(1,t*3-third)), k=part*part*(3-2*part);
          if(side===bridge.side) {
            if(third===0) {target=endpoints[0]!.points[j+2]!.clone().lerp(bridge.target,k);rotation=endpoints[0]!.rotations[side]!.clone().slerp(bridge.rotation,k).normalize();}
            else if(third===1) {target=bridge.target.clone();rotation=bridge.rotation.clone();}
            else {target=bridge.target.clone().lerp(endpoints[1]!.points[j+2]!,k);rotation=bridge.rotation.clone().slerp(endpoints[1]!.rotations[side]!,k).normalize();target.y+=Math.min(.3,Math.max(.04,moves[side]!*.5))*Math.sin(Math.PI*k);}
          } else {
            const v=third===0?0:third===1?k:1;target=endpoints[0]!.points[j+2]!.clone().lerp(endpoints[1]!.points[j+2]!,v);rotation=endpoints[0]!.rotations[side]!.clone().slerp(endpoints[1]!.rotations[side]!,v).normalize();
            if(third===1)target.y+=Math.min(.3,Math.max(.04,moves[side]!*.5))*Math.sin(Math.PI*k);
          }
        } else {
          const excursion=Math.min(Number(process.env.STEP_LIFT ?? .3),Math.max(.04,moves[side]!*.5));
          target.y+=excursion*Math.sin(Math.PI*eased);
        }
        const thigh=legBones[j]!,shin=legBones[j+1]!,foot=legBones[j+2]!;
        const hip=thigh.getWorldPosition(new THREE.Vector3()),knee=shin.getWorldPosition(new THREE.Vector3()),ankle=foot.getWorldPosition(new THREE.Vector3());
        solveAssaultLeg(blendActor,{thigh,shin,foot,upper:hip.distanceTo(knee),lower:knee.distanceTo(ankle)},target,rotation);
      }
    }
    control.feet(0,0); control.support(); blendActor.updateMatrixWorld(true);
  };
  const legBones=['thighL','shinL','footL','thighR','shinR','footR'].map(name=>blendActor.getObjectByName(name)!);
  const toeBones=['toeL','toeR'].map(name=>{const bone=blendActor.getObjectByName(name);if(!bone) throw new Error(`missing ${name}`);return bone;});
  const measure = () => legBones.map(bone=>bone.getWorldPosition(new THREE.Vector3()));
  let previous:THREE.Vector3[]|undefined, previousY:number|undefined, baseline:number[]|undefined, maxBoneStep=0,maxRootStep=0,maxLengthError=0,minGap=Infinity,maxSupportGap=0,minBody=Infinity,fail='';
  let previousRotations:THREE.Quaternion[]|undefined, previousGaps:number[]|undefined, maxFootAngleStep=0,maxPlantedFootStep=0,maxPlantedFootAngleStep=0, maxFootShinAngle=0,minFootShinAngle=180, maxEndpointError=0,reverseError=0;
  const sampledPoses:THREE.Vector3[][]=[];
  const plantedDistances=[0,0],plantedFrames=[0,0];
  const endpoints=[a,b].map((pose,endpoint)=>{ blendActor.position.copy(pose.position);blendActor.quaternion.copy(pose.quaternion);bones.forEach((bone,i)=>{bone.position.copy(pose.bones[i]!.position);bone.quaternion.copy(pose.bones[i]!.quaternion);bone.scale.copy(pose.bones[i]!.scale);});blendActor.updateMatrixWorld(true);return {points:measure(),gaps:[contact.clearance(0,realHeight),contact.clearance(1,realHeight)],rotations:[legBones[2]!,legBones[5]!].map(bone=>bone.getWorldQuaternion(new THREE.Quaternion()).normalize())};});
  let bridge: {side:number;target:THREE.Vector3;rotation:THREE.Quaternion;sag:number} | undefined, bridgeFailure='';
  if(process.env.TRIPLE_STEP) {
    const airborne=[0,1].find(side=>endpoints[0]!.gaps[side]!>1e-4 && endpoints[1]!.gaps[side]!>1e-4 && endpoints[0]!.gaps[1-side]!<=1e-4 && endpoints[1]!.gaps[1-side]!<=1e-4);
    if(airborne!==undefined) try {
      blendActor.position.copy(a.position);blendActor.quaternion.copy(a.quaternion);bones.forEach((bone,i)=>{bone.position.copy(a.bones[i]!.position);bone.quaternion.copy(a.bones[i]!.quaternion);bone.scale.copy(a.bones[i]!.scale);});blendActor.updateMatrixWorld(true);
      const j=airborne*3, rotation=endpoints[0]!.rotations[airborne]!.clone(), target=endpoints[0]!.points[j+2]!.clone();
      target.y-=endpoints[0]!.gaps[airborne]!;
      bridge={side:airborne,target,rotation,sag:Math.max(.12,endpoints[0]!.gaps[airborne]!+endpoints[1]!.gaps[airborne]!+.05)};
    } catch(error) {bridgeFailure=String(error);}
  }
  if(process.env.FOOT_DETAIL) for(const [index,pose] of [a,b].entries()) {
    blendActor.position.copy(pose.position);blendActor.quaternion.copy(pose.quaternion);bones.forEach((bone,i)=>{bone.position.copy(pose.bones[i]!.position);bone.quaternion.copy(pose.bones[i]!.quaternion);bone.scale.copy(pose.bones[i]!.scale);});blendActor.updateMatrixWorld(true);
    const details=toeBones.map((toe,side)=>{const ankle=legBones[side*3+2]!,knee=legBones[side*3+1]!;const toeWorld=toe.getWorldPosition(new THREE.Vector3()),ankleWorld=ankle.getWorldPosition(new THREE.Vector3()),kneeWorld=knee.getWorldPosition(new THREE.Vector3());
      const forward=new THREE.Vector3(0,0,-1).applyQuaternion(b.quaternion);forward.y=0;forward.normalize();const right=new THREE.Vector3(-forward.z,0,forward.x), samples:{f:number;y:number;x:number}[]=[];
      blendActor.traverse(o=>{if(!(o as THREE.SkinnedMesh).isSkinnedMesh)return;const mesh=o as THREE.SkinnedMesh,indices=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight');for(let j=0;j<indices.count;j++){let weight=0;for(let k=0;k<4;k++){const name=mesh.skeleton.bones[indices.getComponent(j,k)]?.name;if(name===`foot${side?'R':'L'}`||name===`toe${side?'R':'L'}`)weight+=weights.getComponent(j,k);}if(weight<.5)continue;const v=new THREE.Vector3();mesh.getVertexPosition(j,v);mesh.localToWorld(v);v.sub(ankleWorld);samples.push({f:v.dot(forward),y:v.y,x:v.dot(right)});}});
      const range=(key:'f'|'y'|'x')=>{const values=samples.map(s=>s[key]).sort((x,y)=>x-y);return [values[0],values[Math.floor(values.length*.1)],values[Math.floor(values.length*.5)],values[Math.floor(values.length*.9)],values[values.length-1]];};
      return {side:side?'R':'L',toeLocal:toe.position.toArray(),ankleWorld:ankleWorld.toArray(),toeWorld:toeWorld.toArray(),kneeWorld:kneeWorld.toArray(),toeToAnkleDistance:toeWorld.distanceTo(ankleWorld),toeRelativeForward:toeWorld.clone().sub(ankleWorld).dot(forward),toeRelativeVertical:toeWorld.y-ankleWorld.y,meshCount:samples.length,forwardRange:range('f'),verticalRange:range('y'),lateralRange:range('x')};});
    console.log(JSON.stringify({endpoint:index===0?'turn':'walk',details}));
  }
  try {
    const frames=Number(process.env.BLEND_FRAMES ?? 60);
    for(let i=0;i<=frames;i++) {
      apply(i/frames); const p=measure(), lengths=[p[0]!.distanceTo(p[1]!),p[1]!.distanceTo(p[2]!),p[3]!.distanceTo(p[4]!),p[4]!.distanceTo(p[5]!)];
      if(process.env.REVERSE_CHECK) sampledPoses.push(p.map(point=>point.clone()));
      if (!baseline) baseline=lengths;
      lengths.forEach((length,j)=>maxLengthError=Math.max(maxLengthError,Math.abs(length-baseline![j]!)));
      if(previous) p.forEach((point,j)=>maxBoneStep=Math.max(maxBoneStep,point.distanceTo(previous![j]!)));
      if(previousY!==undefined) maxRootStep=Math.max(maxRootStep,Math.abs(blendActor.position.y-previousY));
      const gaps=[contact.clearance(0,realHeight),contact.clearance(1,realHeight)]; minGap=Math.min(minGap,...gaps); maxSupportGap=Math.max(maxSupportGap,Math.min(...gaps));
      const footRotations=[legBones[2]!,legBones[5]!].map(bone=>bone.getWorldQuaternion(new THREE.Quaternion()).normalize());
      for(const side of [0,1]) {
        const j=side*3, shinDirection=p[j+1]!.clone().sub(p[j+2]!).normalize();
        const footForward=toeBones[side]!.getWorldPosition(new THREE.Vector3()).sub(p[j+2]!).normalize();
        const anatomicalAngle=THREE.MathUtils.radToDeg(shinDirection.angleTo(footForward));
        maxFootShinAngle=Math.max(maxFootShinAngle,anatomicalAngle); minFootShinAngle=Math.min(minFootShinAngle,anatomicalAngle);
        if(previousRotations && previous && previousGaps) {
          const angle=footRotations[side]!.angleTo(previousRotations[side]!); maxFootAngleStep=Math.max(maxFootAngleStep,angle);
          if(gaps[side]!<1e-4 && previousGaps[side]!<1e-4) {const step=Math.hypot(p[j+2]!.x-previous[j+2]!.x,p[j+2]!.z-previous[j+2]!.z);maxPlantedFootAngleStep=Math.max(maxPlantedFootAngleStep,angle);maxPlantedFootStep=Math.max(maxPlantedFootStep,step);plantedDistances[side]!+=step;plantedFrames[side]!++;}
        }
      }
      if(i===0||i===frames) p.forEach((point,j)=>maxEndpointError=Math.max(maxEndpointError,point.distanceTo(endpoints[i===0?0:1]!.points[j]!)));
      previous=p; previousY=blendActor.position.y; previousGaps=gaps; previousRotations=footRotations;
      if(i%10===0) blendActor.traverse(o=>{if((o as THREE.SkinnedMesh).isSkinnedMesh){const mesh=o as THREE.SkinnedMesh, v=new THREE.Vector3();for(let j=0;j<mesh.geometry.attributes.position.count;j++){mesh.getVertexPosition(j,v);mesh.localToWorld(v);minBody=Math.min(minBody,v.y-realHeight(v.x,v.z));}}});
    }
    if(process.env.REVERSE_CHECK) for(let i=frames;i>=0;i--) {apply(i/frames);measure().forEach((point,j)=>{reverseError=Math.max(reverseError,point.distanceTo(sampledPoses[i]![j]!));});}
  } catch(error) {fail=String(error);}
  const endpointFootMotion=[2,5].map(j=>({horizontal:Math.hypot(endpoints[1]!.points[j]!.x-endpoints[0]!.points[j]!.x,endpoints[1]!.points[j]!.z-endpoints[0]!.points[j]!.z),vertical:endpoints[1]!.points[j]!.y-endpoints[0]!.points[j]!.y}));
  console.log(JSON.stringify({experiment:'interpolated-turn-to-walk',frames:Number(process.env.BLEND_FRAMES ?? 60),from:route.from,to:route.to,yaw:stage.yaw,delta:stage.delta,rootDistance:a.position.distanceTo(b.position),rootAngle:a.quaternion.angleTo(b.quaternion),maxBoneStep,maxRootStep,maxLengthError,minGap,maxSupportGap,minBody,maxFootAngleStep,maxPlantedFootStep,maxPlantedFootAngleStep,plantedDistances,plantedFrames,endpointFootMotion,endpointGaps:endpoints.map(e=>e.gaps),bridgeSide:bridge?.side,bridgeFailure,minFootShinAngle,maxFootShinAngle,maxEndpointError,reverseError,fail}));
  disposeMechaModel(blendActor); preview.player.dispose(); preview.release(); disposeMechaModel(actor); disposeMechaModel(reference); if (process.env.BLEND_BATCH) continue; process.exit(0);
}
if (process.env.STEPS) console.log(JSON.stringify({gaitStages:gaitPlan.stages}));
let previewElapsed = 0;
try {
  for (let i = 0; i < 4000 && !done; i++) {
    const dt=1/Number(process.env.HZ ?? 60);
    previewElapsed = Math.min(gaitPlan.duration, previewElapsed + dt);
    try { preview.player.update(dt); }
    catch (error) {
      const contact = new AssaultContactSampler(actor, asset);
      const diagnostics = ['L','R'].map((side,index) => {
        const nodes = ['thigh','shin','foot'].map(name => actor.getObjectByName(name+side)!.getWorldPosition(new THREE.Vector3()));
        const [hip,knee,ankle] = nodes;
        return {side, clearance:contact.clearance(index as 0|1,realHeight), hip:hip!.toArray(), knee:knee!.toArray(), ankle:ankle!.toArray(), lengths:[hip!.distanceTo(knee!),knee!.distanceTo(ankle!)], reach:hip!.distanceTo(ankle!)};
      });
      console.log(JSON.stringify({frame:i, position:actor.position.toArray(), failure:String(error), diagnostics, stack:error instanceof Error ? error.stack : undefined})); break;
    }
    if (initialStanding && (i < 3 || (process.env.HANDOFF && i % 20 === 0))) {
      const c = new AssaultContactSampler(actor, asset);
      console.log(JSON.stringify({transition:route.from,frame:i,initialY:initialStanding.y,currentY:actor.position.y,groundY:realHeight(actor.position.x,actor.position.z),jump:actor.position.y-initialStanding.y,gap:[c.clearance(0,realHeight),c.clearance(1,realHeight)],boneJump:i===0 ? legs.flat().map((bone,j)=>bone.getWorldPosition(new THREE.Vector3()).distanceTo(initialBones[j]!)) : undefined}));
    }
    actor.updateMatrixWorld(true);
    if (process.env.STEPS) {
      const nextBones = legs.flat().map(bone => bone.getWorldPosition(new THREE.Vector3()));
      const deltas = nextBones.map((p,j) => p.distanceTo(previousBones[j]!));
      const worst = deltas.indexOf(Math.max(...deltas));
      const c = new AssaultContactSampler(actor, asset);
      const sample = sampleAssaultGait(gaitPlan,previewElapsed,measured.profile);
      const footRotations = legs.map(leg => leg[2]!.getWorldQuaternion(new THREE.Quaternion()));
      if (process.env.CONTACTS) {
        const currentVertices = new Map<string,THREE.Vector3>();
        for (const [meshIndex, {mesh,selected}] of footVertices.entries()) for (const j of selected) {
          const name=mesh.skeleton.bones, index=mesh.geometry.getAttribute('skinIndex'), weight=mesh.geometry.getAttribute('skinWeight');
          const sides = [0,1].filter(side => Array.from({length:4},(_,k)=>k).some(k => weight.getComponent(j,k)>1e-6 && (name[index.getComponent(j,k)]!.name === (side===0?'footL':'footR') || name[index.getComponent(j,k)]!.name === (side===0?'toeL':'toeR'))));
          const p=new THREE.Vector3(); mesh.getVertexPosition(j,p); mesh.localToWorld(p);
          for (const side of sides) {
            const key=`${meshIndex}:${j}:${side}`, old=previousVertices.get(key), gap=p.y-realHeight(p.x,p.z);
            const stages=gaitPlan.stages;
            const stage=stages.find(s=>s.kind==='turn' && previewElapsed>=s.start && previewElapsed<s.start+s.duration);
            const steps=stage && stage.kind==='turn' ? Math.max(1,Math.ceil(Math.abs(stage.delta)/(Math.PI/12)-1e-10)) : 0;
            const segment=stage && stage.kind==='turn' ? Math.min(steps,Math.floor(sample.phase*(steps+1))) : -1;
            const prior=poseSteps[poseSteps.length-1]?.sample;
            const priorSegment=prior?.kind==='turn' ? Math.min(steps,Math.floor(prior.phase*(steps+1))) : -2;
            if (sample.kind==='turn' && segment===priorSegment && segment%2!==side && old && gap<1e-4 && old.y-realHeight(old.x,old.z)<1e-4 && previousFeet) {
              const ankle=nextBones[side===0?2:5]!.clone().sub(previousBones[side===0?2:5]!);
              contactMotion.push({frame:i,side,horizontal:Math.hypot(p.x-old.x,p.z-old.z),vertical:p.y-old.y,angle:footRotations[side]!.angleTo(previousFeet[side]!),ankleHorizontal:Math.hypot(ankle.x,ankle.z),ankleVertical:ankle.y,groundGap:gap});
            }
            currentVertices.set(key,p.clone());
          }
        }
        previousVertices=currentVertices; previousFeet=footRotations;
      }
      reference.position.copy(actor.position); reference.quaternion.copy(actor.quaternion);
      poseMechaModel(reference,sample.kind === 'walk' ? 'move' : 'idle',sample.kind === 'walk' ? sample.phase * asset.manifest.clips.move!.duration : 0);
      reference.updateMatrixWorld(true);
      const currentReference = legs.flat().map(bone => reference.getObjectByName(bone.name)!.getWorldPosition(new THREE.Vector3()));
      const referenceStep = previousReference ? currentReference[worst]!.distanceTo(previousReference[worst]!) : 0;
      if (process.env.DIAG && i >= Number(process.env.DIAG_FROM ?? 123) && i <= Number(process.env.DIAG_TO ?? 131)) {
        const actualBones = legs.flat().map(bone => bone.getWorldPosition(new THREE.Vector3()));
        const referenceContacts = new AssaultContactSampler(reference,asset);
        const bend = (points: THREE.Vector3[]) => { const v=points[2]!.clone().sub(points[0]!).normalize(), k=points[1]!.clone().sub(points[0]!); return k.addScaledVector(v,-k.dot(v)); };
        const localBend=bend(currentReference.slice(3)).applyQuaternion(actor.quaternion.clone().invert());
        const localLeft=bend(currentReference.slice(0,3)).applyQuaternion(actor.quaternion.clone().invert());
        console.log(JSON.stringify({frame:i, phase:sample.phase, rawGap:[referenceContacts.clearance(0,realHeight),referenceContacts.clearance(1,realHeight)], finalGap:[c.clearance(0,realHeight),c.clearance(1,realHeight)],rawRight:currentReference.slice(3).map(p=>p.toArray()),actualRight:actualBones.slice(3).map(p=>p.toArray()),rawBend:bend(currentReference.slice(3)).toArray(),localBend:localBend.toArray(),localLeft:localLeft.toArray(),finalBend:bend(actualBones.slice(3)).toArray(), rawReach:currentReference[3]!.distanceTo(currentReference[5]!),finalReach:actualBones[3]!.distanceTo(actualBones[5]!),boneStep:deltas[worst]}));
      }
      poseSteps.push({frame:i,rootStep:actor.position.distanceTo(previousPosition),boneStep:deltas[worst]!,referenceStep,footSteps:[deltas[2]!,deltas[5]!],bone:legs.flat()[worst]!.name,gaps:[c.clearance(0,realHeight),c.clearance(1,realHeight)],sample});
      previousReference = currentReference;
      previousBones = nextBones;
      previousPosition = actor.position.clone();
    }
    const lengths = measureLegs();
    for (let side = 0; side < 2; side++) for (let segment = 0; segment < 2; segment++) lengthError = Math.max(lengthError, Math.abs(lengths[side]![segment]! - initialLengths[side]![segment]!));
    for (const {mesh,selected} of footVertices) {
      const p = new THREE.Vector3();
      for (const j of selected) {
        mesh.getVertexPosition(j,p); mesh.localToWorld(p);
        const clearance = p.y - realHeight(p.x,p.z);
        if (clearance < minFoot) {minFoot = clearance; worstFootFrame = i;}
      }
      if (i % 5 === 0) for (let j = 0; j < mesh.geometry.attributes.position.count; j++) {
        mesh.getVertexPosition(j,p); mesh.localToWorld(p);
        const clearance = p.y - realHeight(p.x,p.z);
        if (clearance < minBody) {minBody = clearance; worstBodyFrame = i;}
      }
    }
  }
  if (process.env.CONTACTS) console.log(JSON.stringify({contactMotion:contactMotion.sort((a,b)=>b.horizontal-a.horizontal).slice(0,10),contactSamples:contactMotion.length}));
  const walkSteps = poseSteps.filter(step => step.sample.kind === 'walk');
  console.log(JSON.stringify({from:route.from,to:route.to,done,minFoot,worstFootFrame,minBody,worstBodyFrame,lengthError,walkWorst:process.env.STEPS ? walkSteps.reduce((a,b)=>b.boneStep>a.boneStep?b:a) : undefined,steps:process.env.STEPS ? [...poseSteps].sort((a,b)=>b.boneStep-a.boneStep).slice(0,10) : undefined,turnContacts:process.env.STEPS ? poseSteps.filter((s,i)=>i>0&&s.sample.kind==='turn'&&poseSteps[i-1]!.sample.kind==='turn').flatMap((s,i)=>[0,1].filter(side=>s.gaps[side]!<1e-4 && poseSteps[poseSteps.indexOf(s)-1]!.gaps[side]!<1e-4).map(side=>({frame:s.frame,side,displacement:s.footSteps[side]}))).sort((a,b)=>b.displacement!-a.displacement!).slice(0,5) : undefined,walkSupport:process.env.STEPS ? {bothOff:walkSteps.filter(s=>Math.min(...s.gaps)>1e-5).length,worstGap:Math.max(...walkSteps.map(s=>Math.min(...s.gaps))),maxRoot:Math.max(...walkSteps.map(s=>s.rootStep)),boundaries:poseSteps.filter((s,i)=>i>0&&s.sample.kind!==poseSteps[i-1]!.sample.kind)} : undefined}));
} finally { preview.player.dispose(); preview.release(); disposeMechaModel(actor); disposeMechaModel(reference); }
}
const ground = realHeight;
const idleResults: Array<{cell: {x:number;y:number};yaw:number;worstGap:number;worstPenetration:number;otherGap:number;idleMinimum:number;requiredDrop:number}> = [];
const idleCells = [];
for (let y=0;y<10;y++) for(let x=0;x<10;x++) {
  const cell={x,y};
  if (site.terrain[y]![x] === 'water' || safety.unsafeCells.some(p=>p.x===x&&p.y===y) || site.blocked.some(p=>p.x===x&&p.y===y) || site.buildings.some(b=>b.cells.some(p=>p.x===x&&p.y===y))) continue;
  idleCells.push(cell);
}
for (const cell of (process.env.FAIL_ROUTE || process.env.HANDOFF || process.env.ROUTES_ONLY ? [] : process.env.DETAIL ? [{x:7,y:5},{x:8,y:8},{x:5,y:1}] : idleCells)) for (const yaw of (process.env.DETAIL ? [0,Math.PI,7*Math.PI/4] : Array.from({length:8},(_,i)=>i*Math.PI/4))) {
  const actor = createAssault(); upgradeMechaModelToGlb(actor, asset); actor.scale.setScalar(2);
  const controller = new AssaultGroundController(actor, {asset,height:ground,terrain:height,radius:2,maxGrade:.5,maxDrop:.3});
  const meshes: THREE.SkinnedMesh[] = []; actor.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
  const contacts = new AssaultContactSampler(actor, asset);
  const at = cellWorld(site,cell); actor.position.set(at.x,at.y,at.z);
  try {
    let worstGap=0, worstPenetration=0, otherGap=0, requiredDrop=0;
    const bones = ['thighL','shinL','footL','thighR','shinR','footR'].map(name => actor.getObjectByName(name)!);
    let baseline: THREE.Quaternion[] | undefined;
    let previousPose: THREE.Quaternion[] | undefined;
    let poseDrift = 0, maxKneeStep = 0, maxRootStep = 0, maxLengthError = 0, blendBodyMinimum = Infinity;
    let previousRootY: number | undefined;
    let previousKnees: THREE.Vector3[] | undefined;
    let firstLengths: number[] | undefined;
    const frameCount = process.env.BLEND ? 31 : process.env.DETAIL ? 180 : 24;
    for(let i=0;i<frameCount;i++) {
      if (process.env.RESET && previousPose) bones.forEach((bone,index) => bone.quaternion.copy(previousPose![index]!));
      poseMechaModel(actor,'idle',process.env.BLEND || process.env.FIXED ? 0 : i/60);
      previousPose = bones.map(bone => bone.quaternion.clone());
      if (!baseline) baseline = bones.map(bone => bone.quaternion.clone().normalize());
      if (process.env.FIXED) bones.forEach((bone,index) => { poseDrift = Math.max(poseDrift, bone.quaternion.clone().normalize().angleTo(baseline![index]!)); });
      controller.align(yaw); actor.updateMatrixWorld(true);
      if (process.env.BOTH || process.env.BLEND) {
      const needed = Math.max(0,Math.max(contacts.clearance(0,ground),contacts.clearance(1,ground)));
      if (process.env.DETAIL && i === 0) {
        const limb = ['L','R'].map(side => ['thigh','shin','foot'].map(name => actor.getObjectByName(name + side)!.getWorldPosition(new THREE.Vector3())));
        console.log(JSON.stringify({cell,yaw,limbLengths:limb.map(([a,b,c]) => [a!.distanceTo(b!),b!.distanceTo(c!)]),needed}));
      }
      requiredDrop = Math.max(requiredDrop, needed);
        const t = i / (frameCount - 1), blend = process.env.BLEND ? 1 - t*t*(3-2*t) : 1;
        actor.position.y -= Math.min(Number(process.env.DROP ?? .8), needed) * blend;
        if (process.env.BLEND && process.env.FOOT_DROP) {
          controller.feet(.34,Number(process.env.FOOT_DROP));
          controller.feet(.745,Number(process.env.FOOT_DROP));
        } else controller.feet(0,0);
        if (process.env.SUPPORT) {
          actor.updateMatrixWorld(true);
          const gap = Math.max(0,Math.min(contacts.clearance(0,ground),contacts.clearance(1,ground)));
          actor.position.y -= gap;
          controller.feet(0,0);
        }
      } else controller.stand();
      actor.updateMatrixWorld(true);
      if (process.env.BLEND) {
        if (previousRootY !== undefined) maxRootStep = Math.max(maxRootStep,Math.abs(actor.position.y - previousRootY));
        previousRootY = actor.position.y;
        const positions = bones.map(bone => bone.getWorldPosition(new THREE.Vector3()));
        const lengths = [positions[0]!.distanceTo(positions[1]!),positions[1]!.distanceTo(positions[2]!),positions[3]!.distanceTo(positions[4]!),positions[4]!.distanceTo(positions[5]!)];
        if (!firstLengths) firstLengths = lengths;
        lengths.forEach((length,index) => { maxLengthError = Math.max(maxLengthError,Math.abs(length-firstLengths![index]!)); });
        const knees = [positions[1]!,positions[4]!];
        if (previousKnees) knees.forEach((knee,index) => { maxKneeStep = Math.max(maxKneeStep,knee.distanceTo(previousKnees![index]!)); });
        previousKnees = knees;
        if (process.env.DETAIL || i === 0 || i === 15 || i === frameCount - 1) for (const mesh of meshes) { const p = new THREE.Vector3(); for(let j=0;j<mesh.geometry.attributes.position.count;j++){mesh.getVertexPosition(j,p);mesh.localToWorld(p);blendBodyMinimum=Math.min(blendBodyMinimum,p.y-ground(p.x,p.z));} }
      }
      const left=contacts.clearance(0,ground), right=contacts.clearance(1,ground), gap=Math.min(left,right);
      if (process.env.DETAIL && [0,1,2,10,23,60,120,179].includes(i)) console.log(JSON.stringify({cell,yaw,frame:i,left,right,rootY:actor.position.y,poseDrift}));
      worstGap=Math.max(worstGap,gap); worstPenetration=Math.min(worstPenetration,gap); otherGap=Math.max(otherGap,left,right);
    }
    let minimum=Infinity;
    for (const mesh of meshes) {const p=new THREE.Vector3(); for(let i=0;i<mesh.geometry.attributes.position.count;i++){mesh.getVertexPosition(i,p);mesh.localToWorld(p);minimum=Math.min(minimum,p.y-ground(p.x,p.z));}}
    if (process.env.BLEND) console.log(JSON.stringify({cell,yaw,maxKneeStep,maxRootStep,maxLengthError,blendBodyMinimum}));
    idleResults.push({cell,yaw,worstGap,worstPenetration,otherGap,idleMinimum:minimum,requiredDrop});
  } catch(error) { console.log(JSON.stringify({cell,yaw,idleFailure:String(error)})); }
  finally { disposeMechaModel(actor); }
}
console.log(JSON.stringify({cells:idleCells.length,passes:idleResults.length,worstGap:[...idleResults].sort((a,b)=>b.worstGap-a.worstGap).slice(0,5),otherGap:[...idleResults].sort((a,b)=>b.otherGap-a.otherGap).slice(0,5),requiredDrop:[...idleResults].sort((a,b)=>b.requiredDrop-a.requiredDrop).slice(0,5),bodyPenetration:[...idleResults].sort((a,b)=>a.idleMinimum-b.idleMinimum).slice(0,5)}));
