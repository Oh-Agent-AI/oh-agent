/** Isolated, texture-free candidate checks; not visual or battle acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { parseMechaManifest, instantiateMechaGlb, MechaGlbError } from "../src/render/mecha/glbModels.ts";
import { parseTrialAssault } from "../src/render/mecha/trialAssault.ts";
import { poseMechaModel, setMechaRig } from "../src/render/mecha/animation.ts";
const dir=resolve(dirname(fileURLToPath(import.meta.url)),"../src/assets/mecha");
const bytes=readFileSync(process.env.ASSAULT_TRIAL_GLB ?? resolve(dir,"assault-trial.glb"));
const manifestJson=JSON.parse(readFileSync(resolve(dir,"assault-trial.manifest.json"),"utf8"));
const manifest=parseMechaManifest(manifestJson);
function glb(mutate?: (j:any)=>void):ArrayBuffer {
 const n=bytes.readUInt32LE(12),j=JSON.parse(bytes.subarray(20,20+n).toString()),rest=bytes.subarray(20+n);
 for(const m of j.materials??[]){const p=m.pbrMetallicRoughness??{};delete p.baseColorTexture;delete p.metallicRoughnessTexture;delete m.emissiveTexture;}
 delete j.textures;delete j.images;delete j.samplers;mutate?.(j);
 let t=Buffer.from(JSON.stringify(j));t=Buffer.concat([t,Buffer.alloc((4-t.length%4)%4,0x20)]);const h=Buffer.alloc(20);h.writeUInt32LE(0x46546c67,0);h.writeUInt32LE(2,4);h.writeUInt32LE(20+t.length+rest.length,8);h.writeUInt32LE(t.length,12);h.writeUInt32LE(0x4e4f534a,16);const x=Buffer.concat([h,t,rest]);return x.buffer.slice(x.byteOffset,x.byteOffset+x.byteLength);
}
function skins(root:THREE.Object3D):THREE.SkinnedMesh[]{const out:THREE.SkinnedMesh[]=[];root.traverse(o=>{if((o as THREE.SkinnedMesh).isSkinnedMesh)out.push(o as THREE.SkinnedMesh)});return out}
test("the installed trial's provenance hash matches its bytes",{skip:!!process.env.ASSAULT_TRIAL_GLB},()=>{
 assert.equal(createHash("sha256").update(bytes).digest("hex"),manifestJson.source.glb_sha256);
});
test("trial preserves two skin primitives, clip durations and independent instances",async()=>{
 const asset=await parseTrialAssault(glb(),manifest);const original=skins(asset.scene);assert.equal(original.length,2);assert.equal(asset.clips.length,5);
 for(const [name,spec] of Object.entries(manifest.clips))assert.ok(Math.abs(asset.clips.find(c=>c.name===name)!.duration-spec.duration)<1e-5);
 const a=instantiateMechaGlb(asset,2),b=instantiateMechaGlb(asset,2);setMechaRig(a.wrapper,a.rig);setMechaRig(b.wrapper,b.rig);const sa=skins(a.wrapper),sb=skins(b.wrapper);assert.equal(sa.length,2);assert.equal(sb.length,2);
 assert.equal(sa[0]!.skeleton.bones[0],sa[1]!.skeleton.bones[0]);assert.notEqual(sa[0]!.skeleton.bones[0],sb[0]!.skeleton.bones[0]);
 const before=sb[0]!.skeleton.bones.map(x=>x.quaternion.clone());poseMechaModel(a.wrapper,"attack",.45);a.wrapper.updateMatrixWorld(true);assert.ok(sb[0]!.skeleton.bones.every((bone,i)=>Math.max(Math.abs(bone.quaternion.x-before[i]!.x),Math.abs(bone.quaternion.y-before[i]!.y),Math.abs(bone.quaternion.z-before[i]!.z),Math.abs(bone.quaternion.w-before[i]!.w))<1e-8));
 for(const mesh of sa){mesh.skeleton.update();assert.ok([...mesh.skeleton.boneMatrices].every(Number.isFinite))}a.dispose();b.dispose();
});
test("trial refuses malformed skeleton and missing action",async()=>{
 await assert.rejects(parseTrialAssault(glb(j=>{j.nodes.find((n:any)=>n.name==='forearm.L').name='missing';}),manifest),MechaGlbError);
 await assert.rejects(parseTrialAssault(glb(j=>{j.animations=j.animations.filter((a:any)=>a.name!=='ground_half_trial_attack');}),manifest),MechaGlbError);
});
