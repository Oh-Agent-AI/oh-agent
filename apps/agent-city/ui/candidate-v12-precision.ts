import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {validateAssaultSkin} from './src/render/mecha/assaultSkinContract.ts';
const base='/Users/Admin/3D-Assets/assault-production-2026-10-28/stage98_battle_candidate/battle_v12_timing_';
async function load(suffix:string){
 const b=readFileSync(base+suffix+'.glb'), n=b.readUInt32LE(12), json=JSON.parse(b.subarray(20,20+n).toString()), rest=b.subarray(20+n);
 for(const m of json.materials??[]){const p=m.pbrMetallicRoughness??{};delete p.baseColorTexture;delete p.metallicRoughnessTexture;delete m.emissiveTexture;}delete json.images;delete json.textures;delete json.samplers;
 let txt=Buffer.from(JSON.stringify(json));txt=Buffer.concat([txt,Buffer.alloc((4-txt.length%4)%4,32)]);const h=Buffer.alloc(20);h.writeUInt32LE(0x46546c67,0);h.writeUInt32LE(2,4);h.writeUInt32LE(20+txt.length+rest.length,8);h.writeUInt32LE(txt.length,12);h.writeUInt32LE(0x4e4f534a,16);const out=Buffer.concat([h,txt,rest]);return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(out.buffer.slice(out.byteOffset,out.byteOffset+out.byteLength),'');
}
const source=await load('source'), compressed=await load('precise');validateAssaultSkin(compressed.scene,compressed.animations,Object.fromEntries(source.animations.map(c=>[c.name,c.duration])));
const ms=new THREE.AnimationMixer(source.scene), mc=new THREE.AnimationMixer(compressed.scene);const bones=['pelvis','thighL','shinL','footL','toeL','thighR','shinR','footR','toeR'];const scale=21.245691361301702;let maximum=0,worst='',minY=Infinity,maxFloorError=0;
for(const c of source.animations){const d=compressed.animations.find(x=>x.name===c.name);assert.ok(d);const a=ms.clipAction(c),b=mc.clipAction(d);a.setLoop(THREE.LoopOnce,1);b.setLoop(THREE.LoopOnce,1);a.clampWhenFinished=true;b.clampWhenFinished=true;a.play();b.play();
 for(let i=0;i<=100;i++){const t=c.duration*i/100;ms.setTime(t);mc.setTime(t);source.scene.updateMatrixWorld(true);compressed.scene.updateMatrixWorld(true);for(const name of bones){const p=source.scene.getObjectByName(name)!.getWorldPosition(new THREE.Vector3()),q=compressed.scene.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());const err=p.distanceTo(q)*scale;if(err>maximum){maximum=err;worst=`${c.name}@${t}:${name}`;}}
 if(i%5===0){const y=new THREE.Box3().setFromObject(source.scene,true).min.y*scale,z=new THREE.Box3().setFromObject(compressed.scene,true).min.y*scale;minY=Math.min(minY,z);maxFloorError=Math.max(maxFloorError,Math.abs(y-z));}
 }a.stop();b.stop();
}
console.log('COMPRESSED_PRECISION',JSON.stringify({clips:source.animations.length,samplesPerClip:101,maxJointErrorMetres:maximum,worst,minYMetres:minY,maxFloorErrorMetres:maxFloorError}));assert.ok(maximum<.01);assert.ok(minY>=-.001);
