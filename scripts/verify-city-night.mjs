#!/usr/bin/env node
// 夜景光照守卫（CITY_NIGHT_LIGHTING_SPEC N4）：灯光预算自洽，且夜景代码不再绕过预算手填强度。
//   1. cityLightBudget 的预算项/亮灯率曲线通过自检（窗光亮度跨度、傍晚高峰与深夜低谷、桥塔霓虹降饱和）；
//   2. 住宅 / 办公亮灯率：办公傍晚更高、深夜更低；活跃会话夜里更亮；路灯主干 > 次干 > 步道；
//   3. 渲染代码里不再有「墙面全程自发光」「每栋楼顶都画霓虹」「路灯/霓虹手填倍率」这些旧写法。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = path.join(repo, "apps/agent-city/ui/src/engine");
const { buildSync } = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"))("esbuild");
const out = buildSync({ entryPoints: [path.join(engine, "cityLightBudget.ts")], bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent" });
const mod = { exports: {} };
vm.runInNewContext(out.outputFiles[0].text, { module: mod, exports: mod.exports, Math });
const B = mod.exports;

assert.equal(JSON.stringify(B.budgetProblems()), "[]", "light budget self-check"); // 跨 vm 上下文的数组不能 deepEqual
assert(B.windowRate(19, "office") > B.windowRate(19, "residential"), "office lights up more in the early evening");
assert(B.windowRate(2, "office") < 0.1 && B.windowRate(2, "residential") < 0.15, "late night is mostly dark");
assert(B.windowRate(20, "residential") > B.windowRate(0.5, "residential") * 3, "evening far brighter than after midnight");
assert(B.activeBoost(0.05) >= 0.45 && B.activeBoost(0.9) <= 1, "active sessions stay lit overnight");
assert(B.lampTier(12) > B.lampTier(8) && B.lampTier(8) > B.lampTier(5), "street lamps tiered by road class");
assert.equal(B.useOfZone("downtown"), "office");
assert.equal(B.useOfZone("residential"), "residential");
assert.equal(B.nightFactor(0.05), 0, "daytime selfLit is not night");
assert.equal(B.nightFactor(1), 1);

// 地标造型：声明化的在 models/landmarks/*.ts，依赖 three 的手写 drawX 在 render/landmarks/*.ts（桥塔霓虹在 suspensionBridge.ts）：夜景代码检查读 cityParts + engine/render/*.ts + engine/systems/*.ts + 全部造型文件。
const modelsDir = path.join(engine, "models/landmarks");
const splitDirs = ["render", "render/landmarks", "systems"].map((d) => path.join(engine, d)).filter((d) => fs.existsSync(d));
const splitFiles = splitDirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => path.join(d, f)));
const parts = [path.join(engine, "cityParts.ts"), ...splitFiles, ...fs.readdirSync(modelsDir).map((f) => path.join(modelsDir, f)), ...fs.readdirSync(path.join(engine, "models")).filter((f) => f.endsWith(".ts")).map((f) => path.join(engine, "models", f))].map((f) => fs.readFileSync(f, "utf8")).join("\n");
const eng = fs.readFileSync(path.join(engine, "CityEngine.ts"), "utf8");
assert(!/uniforms\.uSelfLit\.value = themeBase;/.test(parts), "walls must dim at night (uSelfLit tied to night)");
assert(!/setColorAt\(roofCount, new THREE\.Color\(palette\.accent\)\.multiplyScalar\(3\.2\)\)/.test(parts), "roof neon must be gated to tall/hotel via the budget");
for (const magic of ["night * 3.2", "night * 0.9", "night * 2.4", "night * 2.6"]) assert(!parts.includes(magic), `hand-tuned lamp multiplier ${magic} bypasses LIGHT_BUDGET`);
assert(parts.includes("LIGHT_BUDGET.street.head") && parts.includes("LIGHT_BUDGET.neon.bridge"), "night lights read the budget");
assert(parts.includes("LIGHT_BUDGET.street.analyticCd"), "driving-mode analytic street lamps read the budget (N5)");
assert(eng.includes("LIGHT_BUDGET.ambient.exposureCut"), "night exposure comes from the budget");
assert(/setNightHour\(hour\)/.test(eng), "engine feeds the local hour to the window-rate curve");
assert(/"#38e8ff"[\s\S]{0,200}bridgeSaturation/.test(parts), "bridge neon is desaturated through the budget");
console.log("City night lighting: budget self-check, rate curves, lamp tiers and no hand-tuned multipliers passed.");

// Receiver geometry must agree at triangle interiors too: vertex-only height
// samples or a fitted tangent disc can still cut through the road between them.
const { loadCity } = await import("./city-kit/index.mjs");
const {streetLightPoolGeometry,STREET_POOL_LIFT,terrainSurfaceHeight,ROAD_SURFACE_LIFT}=await loadCity({
 "engine/render/streetLightPools.ts":["streetLightPoolGeometry","STREET_POOL_LIFT"],
 "engine/surface/terrainSampling.ts":["terrainSurfaceHeight"],
 "engine/surface/groundRoadCompiler.ts":["ROAD_SURFACE_LIFT"],
});
const layout={extent:384,terrain:{height:(x,z)=>0.4*Math.sin(x*0.65)+0.3*Math.cos(z*0.7)+x*0.08}};
const lamp={x:2.4,z:0,nx:1,nz:0,poolReach:3.2,poolRadius:9.5,tier:1,flat:false,base:0};
const data=streetLightPoolGeometry(layout,[lamp]);
assert(data.indices.length>14*3,"curved terrain requires splitting beyond the original circle fan");
const at=(i)=>Array.from(data.positions.slice(i*3,i*3+3));
for(let i=0;i<data.indices.length;i+=3){
 const [a,b,c]=Array.from(data.indices.slice(i,i+3),at);
 const winding=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]);
 assert(winding>0,"light receivers face upward");
 for(const weights of [[1/3,1/3,1/3],[0.6,0.2,0.2],[0.1,0.4,0.5]]){
  const p=[0,1,2].map(axis=>a[axis]*weights[0]+b[axis]*weights[1]+c[axis]*weights[2]);
  const terrain=terrainSurfaceHeight(layout,p[0],p[2]);
  assert(Math.abs(p[1]-terrain-STREET_POOL_LIFT)<2e-5,"pool interiors follow the actual terrain triangle");
  assert(p[1]-terrain-ROAD_SURFACE_LIFT>0.07,"road surface cannot hide the pool");
 }
}
const deck=streetLightPoolGeometry(layout,[{...lamp,flat:true,base:20}]);
for(let i=1;i<deck.positions.length;i+=3)assert(Math.abs(deck.positions[i]-20.12)<1e-5,"deck pools never follow the terrain below");
assert(data.uvs.every(v=>v>=-1e-6&&v<=1+1e-6));
const nightSource=fs.readFileSync(path.join(engine,"render/nightLighting.ts"),"utf8");
assert.match(nightSource,/depthTest: true/);
assert.match(nightSource,/depthWrite: false/);
assert.match(nightSource,/streetLightPoolGeometry\(host.layout, plan\)/);
console.log("Street pools: curved-terrain interior clearance, upward winding, UVs and elevated-layer isolation passed.");

// Exercise the actual pool mesh created by buildNightLights. GTAO's override
// ignores alpha/blending; emitting even one pool triangle pollutes its G-buffer.
const {installCanvasShim}=await import("./city-kit/scene-hash.mjs");
installCanvasShim();
const night=await loadCity({"pkg:three":["* as THREE"],"engine/render/nightLighting.ts":["buildNightLights","setNightGlow"]});
const T=night.THREE;
const host={layout:{...layout,roadEdges:[],highways:[],publicSites:[{kind:"park",x:0,z:0,radius:10}]},
 group:new T.Group(),disposables:[],matrix:new T.Matrix4(),color:new T.Color(),nightGlow:0,nightHour:20,
 facadeUniforms:[],terrainUniforms:null,waterAssetUniforms:null,heroParts:null,landmarkWindows:[],
 lifeguardGlowMaterial:null,signageNeonMaterial:null,applyNightOverlay(){},
 compose(x,y,z,yaw,sx,sy,sz){this.matrix.compose(new T.Vector3(x,y,z),new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),yaw),new T.Vector3(sx,sy,sz));},
 makeInstanced(g,m,n){const mesh=new T.InstancedMesh(g,m,n);this.group.add(mesh);this.disposables.push(g,m);return mesh;}};
host.nightLights=night.buildNightLights(host);
const pool=host.group.getObjectByName("street-light-pools");
assert(pool?.isMesh);assert(pool.geometry.index.count>0);
const scene=new T.Scene(), override=new T.MeshNormalMaterial();
const before=()=>pool.onBeforeRender(null,scene,null,pool.geometry,pool.material,null);
const after=()=>pool.onAfterRender(null,scene,null,pool.geometry,pool.material,null);
for(const glow of [0,1,0,1]){
 night.setNightGlow(host,glow);
 assert.equal(pool.material.visible,glow===1,"day/night controls remain intact");
 scene.overrideMaterial=override;before();assert.equal(pool.geometry.drawRange.count,0,"no opaque pool in GTAO normal/depth pass");after();
 assert.equal(pool.geometry.drawRange.count,pool.geometry.index.count,"restore after override");
 scene.overrideMaterial=null;before();assert.equal(pool.geometry.drawRange.count,pool.geometry.index.count,"normal additive pass retains the complete pool");after();
}
scene.overrideMaterial=override;before(); // Simulate an interrupted pass without after.
scene.overrideMaterial=null;before();assert.equal(pool.geometry.drawRange.count,pool.geometry.index.count,"the next color pass recovers even after an interrupted override");
console.log("Street pool GTAO regression: zero override triangles, additive restoration, interrupted-pass recovery and day/night toggles passed.");

// Daytime civic signs/glass must survive turning their night overlay off.
const civic=await loadCity({"engine/systems/civicSystem.ts":["buildCivics","writeCivic"]});
host.layout.civics=[{id:"hospital",kind:"hospital",x:0,z:0,y:0.3,yaw:0.4,width:30,depth:24}];
host.civicPieces=[];host.civicMeshes=[];host.civicProgress=[];host.civicTarget=[];
const sky={uEnv:{value:null},uEnvStrength:{value:0},uGradeTop:{value:new T.Color("#adcddd")},uGradeHorizon:{value:new T.Color("#d4e0e4")},uGradeAmount:{value:0},uSkyYaw:{value:0}};
host.facadeUniforms=[null,sky];host.writeCivic=(index)=>civic.writeCivic(host,index);
civic.buildCivics(host);
const [walls,,glows]=host.civicMeshes,mask=walls.geometry.getAttribute("aCivicGlass");
assert.equal(mask.count,walls.count,"glass mask stays aligned with the instance batch");
assert(Array.from(mask.array).some(v=>v===1)&&Array.from(mask.array).some(v=>v===0),"only glass is reflective");
const red=new T.Color("#e0352b"),color=new T.Color();let crosses=0;
for(let i=0;i<walls.count;i++){walls.getColorAt(i,color);if(Math.abs(color.r-red.r)+Math.abs(color.g-red.g)+Math.abs(color.b-red.b)<1e-6){crosses++;assert.equal(mask.getX(i),0,"red sign stays diffuse");}}
assert(crosses>=2,"hospital contains solid red cross arms");
assert(glows.material.transparent&&glows.material.blending===T.AdditiveBlending&&!glows.material.depthWrite,"off overlays cannot cover signs with opaque black");
assert.notEqual(glows.material,host.nightLights.neon,"civic blend state does not mutate shared landmark material");
assert.equal(glows.material.color,host.nightLights.neon.color,"night intensity remains live");
const glowScene=new T.Scene();
for(const level of [0,1,0]){
 night.setNightGlow(host,level);
 glowScene.overrideMaterial=override;glows.onBeforeRender(null,glowScene);assert.equal(glows.count,0,"glows do not occlude GTAO");
 glowScene.overrideMaterial=null;glows.onBeforeRender(null,glowScene);assert(glows.count>0,"normal pass recovers without after callback");
}
const shader={uniforms:{},vertexShader:T.ShaderLib.lambert.vertexShader,fragmentShader:T.ShaderLib.lambert.fragmentShader};
walls.material.onBeforeCompile(shader,{});
assert.equal(shader.uniforms.uEnv,sky.uEnv,"async sky assets propagate by uniform identity");
assert.equal(shader.uniforms.uGradeAmount,sky.uGradeAmount,"weather/time grading stays shared");
assert(shader.fragmentShader.includes("reflect(viewDir,n)")&&shader.fragmentShader.includes("if(vCivicGlass>0.5)"),"reflection is limited to glass");
assert(!shader.fragmentShader.includes("#include <opaque_fragment>\n#include <opaque_fragment>"));
for(const resource of new Set(host.disposables))resource.dispose();override.dispose();
console.log("Civic signs/glass: red base, glass-only mask, additive night toggles, GTAO exclusion and shared sky uniforms passed.");
