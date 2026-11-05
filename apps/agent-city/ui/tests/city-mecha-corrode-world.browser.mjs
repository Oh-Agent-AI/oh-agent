#!/usr/bin/env node
// Real CityMechaWorld with a synthetic, local-only WebGL site.
// node tests/city-mecha-corrode-world.browser.mjs http://127.0.0.1:5179
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const board = await readFile(new URL("../src/game/MechaBoard.tsx", import.meta.url), "utf8");
assert.match(board, /const state = performance\?\.before \?\? resolvedState/);
assert.match(board, /corrodeFields: state\?\.corrode\?\.fields\.map\(field => \(\{ id: field\.id, cell: field\.cell \}\)\)/);
const require = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5179", origin = new URL(base).origin;
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
    const response = await route.fetch(); let source = await response.text();
    const needle = "    const onDown = (event) => {";
    assert.ok(source.includes(needle));
    const probe = `    window.__corrodeHistory ??= [];
    const counts = { geometry: 0, material: 0, badgeMaterial: 0, texture: 0 };
    corrodeGeo.addEventListener("dispose", () => counts.geometry++);
    corrodeMat.addEventListener("dispose", () => counts.material++);
    corrodeBadgeMat.addEventListener("dispose", () => counts.badgeMaterial++);
    corrodeTexture.addEventListener("dispose", () => counts.texture++);
    window.__corrodeProbe = {root,camera,corrodeMarks,threatLines,targetLines,moveLines,counts,site,
      cell(x,y){return cellWorld(site,{x,y});},
      project(x,y){const p=cellWorld(site,{x,y}),v=new THREE.Vector3(p.x,p.y+.65,p.z).project(camera),r=canvas.getBoundingClientRect();return {x:r.left+(v.x+1)*r.width/2,y:r.top+(1-v.y)*r.height/2}}};
    window.__corrodeHistory.push(window.__corrodeProbe);\n`;
    source = source.replace(needle, probe + needle);
    const clock = "const dt = Math.min(0.08, (now - lastFrame) / 1e3);";
    assert.ok(source.includes(clock));
    source = source.replace(clock, "const dt = window.__testDt ?? Math.min(0.08, (now - lastFrame) / 1000);");
    await route.fulfill({response,body:source});
  });
  await page.route("**/__corrode-fixture*", route => route.fulfill({contentType:"text/html",body: `<!doctype html><style>html,body{margin:0} canvas{display:block;width:100vw;height:100vh;touch-action:none}</style><canvas></canvas><div id="root"></div>
<script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
const React = (await import('/node_modules/.vite/deps/react.js')).default;
const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const THREE = await import('/node_modules/.vite/deps/three.js');
const { CityMechaWorld } = await import('/src/game/CityMechaWorld.tsx');
const canvas = document.querySelector('canvas');
const renderer = new THREE.WebGLRenderer({canvas, antialias:true, preserveDrawingBuffer:true});
renderer.setPixelRatio(1); renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene(); scene.background = new THREE.Color('#526567');
scene.add(new THREE.HemisphereLight('#ffffff','#666666',2));
const camera = new THREE.PerspectiveCamera(40, innerWidth/innerHeight, 1, 8000);
const target = new THREE.Vector3(9, 4, -3);
camera.position.set(130, 210, -90); camera.fov = 53; camera.updateProjectionMatrix(); camera.lookAt(target); camera.updateMatrixWorld();
let frame = null, lastPick = null, lastHover = null, releases = 0, restores = 0, completes = 0;
const photo = () => ({position:camera.position.toArray(), target:target.toArray(), fov:camera.fov});
const setView = view => { camera.position.fromArray(view.position); target.fromArray(view.target); camera.fov=view.fov; camera.updateProjectionMatrix(); camera.lookAt(target); camera.updateMatrixWorld(); };
const originalView = photo();
const engine = { domCanvas:canvas, renderCamera:camera, skyNight:0, owner:'orbit',
 captureReturnView:() => photo(), restoreReturnView:view => { restores++; setView(view); },
 photoView:photo,
 acquireModeLease:() => {
   let attached = [];
   return {setBattleClarity:() => {}, attach:items => { attached = items; scene.add(...items); }, setFrameHook:fn => {frame=fn},
    setOrbitView:view => setView({position:view.position.toArray(),target:view.target.toArray(),fov:view.fov}),
    release:() => { releases++; frame=null; scene.remove(...attached); }};
 } };
const makeSite = (kind) => ({originX:13,originZ:-21,yaw:kind==='rect' ? -0.71 : 0.35,
 cellW:kind==='rect' ? 12 : 16,cellD:kind==='rect' ? 19 : 16,
 heights:Array.from({length:10},(_,y)=>Array.from({length:10},(_,x)=>kind==='slope' || kind==='rect' ? 0.3*x+0.2*y : 0)),
 terrain:Array.from({length:10},()=>Array(10).fill('empty')), buildings:[], blocked:[]});
const initial = {figures:[],boss:{x:0,y:0,alive:false},raiders:[],buildings:[],declaredTelegraph:[],projectedTelegraph:null,telegraph:[],focusedTelegraph:[],focus:[],reach:[],move:null,targets:[],targetIds:[]};
const ref = React.createRef();
function App() {
 const [view, setFixtureView] = React.useState(initial), [site, setSite] = React.useState(()=>makeSite('flat')), [performance, setPerformance] = React.useState(null), [paused, setPaused] = React.useState(true), [speed, setSpeed] = React.useState(1);
 window.setFixturePerformance = value => setPerformance(value);
 window.setFixturePaused = value => setPaused(value);
 window.setFixtureSpeed = value => setSpeed(value);
 window.setFixtureView = value => setFixtureView({...initial,...value});
 window.setFixtureSite = kind => setSite(makeSite(kind));
 return React.createElement(CityMechaWorld,{engine,site,view,ref,performance,paused,performanceSpeed:speed,onPerformanceComplete:()=>{completes++},onCell:(x,y,input)=>{lastPick={x,y,input}},onHoverCell:cell=>{lastHover=cell}});
}
const reactRoot = createRoot(document.getElementById('root'));
reactRoot.render(React.createElement(App));
window.fixture = { ref, originalView, photo, setView,
 resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); },
 render() { frame?.(); scene.updateMatrixWorld(true); renderer.render(scene,camera); return renderer.info.render.calls; },
 rawRender() { scene.updateMatrixWorld(true); renderer.render(scene,camera); },
 pixels() { const gl=renderer.getContext(), data=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4); gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data); return data; },
 completes:()=>completes, getHover:()=>lastHover, getPick:()=>lastPick, clearPick:()=>{lastPick=null},
 lifecycle:() => ({releases, restores, rootAttached:scene.children.includes(window.__corrodeProbe.root), frameActive:frame !== null}),
 unmount:() => reactRoot.unmount() };
window.fixture.resize();
</script>`}));
  await page.goto(new URL("/__corrode-fixture?assaultTrial=1",base).href);
  await page.waitForFunction(()=>window.__corrodeProbe && window.fixture?.ref.current);
  const render = (dt=0) => page.evaluate(dt=>{window.__testDt=dt;window.fixture.render()},dt);
  const change = async (method,value) => {await page.evaluate(([method,value])=>window[method](value),[method,value]);await page.waitForTimeout(25);await render()};
  const active = () => page.evaluate(()=>window.__corrodeProbe.corrodeMarks.filter(m=>m.ground.visible).map(m=>`${m.cell.x},${m.cell.y}`));
  const field=(id,x,y)=>({id,cell:{x,y}});
  const cue=(id,x,y,change,duration=1)=>({kind:"corrode_field",actor:"boss",change,fieldId:id,cell:{x,y},duration});
  await render(); assert.deepEqual(await active(),[]);
  const c={x:5,y:5}, overlap={declaredTelegraph:[c],projectedTelegraph:[c],targets:[c],move:c,reach:[c],targetPreview:{target:c}};
  await change("setFixtureView",overlap); assert.deepEqual(await active(),[],"targets and previews are not fields");
  await change("setFixtureView",{...overlap,corrodeFields:[field("a",5,5),field("invalid",10,2)]});
  assert.deepEqual(await active(),["5,5"]);
  const geometry=await page.evaluate(()=>{const p=window.__corrodeProbe,m=p.corrodeMarks[55],at=p.cell(5,5);return {xyz:m.ground.position.toArray(),expected:[at.x,at.y+.34,at.z],yaw:m.ground.rotation.y,siteYaw:p.site.yaw,badge:m.badge.visible}});
  assert.deepEqual(geometry.xyz,geometry.expected);assert.equal(geometry.yaw,geometry.siteYaw);assert.equal(geometry.badge,true);
  // Pixel-test the independent overlapping layers in the actual WebGL render.
  const pixels=await page.evaluate(()=>{const p=window.__corrodeProbe,m=p.corrodeMarks[55];window.fixture.rawRender();const all=window.fixture.pixels();
    const diff=objects=>{for(const o of objects)o.visible=false;window.fixture.rawRender();const other=window.fixture.pixels();for(const o of objects)o.visible=true;let n=0;for(let i=0;i<all.length;i+=4)if(all[i]!==other[i]||all[i+1]!==other[i+1]||all[i+2]!==other[i+2])n++;return n};
    return {marker:diff([m.ground,m.badge]),badge:diff([m.badge]),layers:[p.threatLines[55],p.targetLines[55],p.moveLines[55]].map(o=>diff([o]))}});
  assert.ok(pixels.marker>10 && pixels.badge>5,JSON.stringify(pixels));assert.ok(pixels.layers.every(n=>n>0),JSON.stringify(pixels));
  const point=await page.evaluate(()=>window.__corrodeProbe.project(5,5));await page.mouse.click(point.x,point.y);
  assert.deepEqual(await page.evaluate(()=>window.fixture.getPick()),{x:5,y:5,input:"mouse"});
  await page.mouse.move(point.x + 1,point.y + 1);
  assert.deepEqual(await page.evaluate(()=>window.fixture.getHover()),{x:5,y:5});
  // With a real mech occupying the tile, compare click/hover with and without
  // the landmark and test its depth-independent badge over four camera angles.
  await change("setFixturePaused",false);
  await change("setFixtureView",{...overlap,figures:[{id:"Assault",x:5,y:5,alive:true,selected:false}]});
  for(let i=0;i<40;i++) await render(.05);
  const occupiedPoint=await page.evaluate(()=>window.__corrodeProbe.project(5,5));
  await page.mouse.click(occupiedPoint.x,occupiedPoint.y);
  const occupiedPick=await page.evaluate(()=>window.fixture.getPick());
  await change("setFixtureView",{...overlap,figures:[{id:"Assault",x:5,y:5,alive:true,selected:false}],corrodeFields:[field("a",5,5)]});
  await page.mouse.click(occupiedPoint.x,occupiedPoint.y);assert.deepEqual(await page.evaluate(()=>window.fixture.getPick()),occupiedPick);
  for(let turn=0;turn<4;turn++) {
    await render();
    const badgePixels=await page.evaluate(()=>{const m=window.__corrodeProbe.corrodeMarks[55];window.fixture.rawRender();const all=window.fixture.pixels();m.badge.visible=false;window.fixture.rawRender();const off=window.fixture.pixels();m.badge.visible=true;let n=0;for(let i=0;i<all.length;i+=4)if(all[i]!==off[i]||all[i+1]!==off[i+1]||all[i+2]!==off[i+2])n++;return n});
    assert.ok(badgePixels>30,`occupied badge angle ${turn}: ${badgePixels}`);
    await page.evaluate(()=>window.fixture.ref.current.rotateCamera());
  }
  if(process.env.MECHA_CORRODE_SCREENSHOT) await page.screenshot({path:process.env.MECHA_CORRODE_SCREENSHOT});
  await change("setFixturePaused",true);
  await change("setFixtureView",{corrodeFields:[field("a",5,5)]});
  await change("setFixturePerformance",{events:[cue("b",6,5,"created"),{kind:"corrode_tick",actor:"Assault",fieldId:"b",cell:{x:6,y:5},damage:1,duration:1},cue("a",5,5,"expired")]});
  await render(2);assert.deepEqual(await active(),["5,5"],"pause freezes playback");
  await change("setFixtureView",{corrodeFields:[field("changed",8,8)]});
  assert.deepEqual(await active(),["5,5"],"snapshot changes do not reset an active performance");
  await change("setFixturePaused",false);await render(.5);assert.deepEqual(await active(),["5,5"]);
  await render(.5);assert.deepEqual(await active(),["5,5","6,5"],"creation settles in frame");
  await render(1);assert.deepEqual(await active(),["5,5","6,5"],"tick does not expire");
  await render(.5);assert.deepEqual(await active(),["5,5","6,5"]);
  await change("setFixtureSpeed",2);await render(.25);assert.deepEqual(await active(),["6,5"],"expiry settles at replay speed");
  await change("setFixtureSpeed",1);
  assert.equal(await page.evaluate(()=>window.fixture.completes()),1);
  // Replacing the replay round resets from its before snapshot; stopping restores live state.
  await page.evaluate(([v,p])=>{window.setFixtureView(v);window.setFixturePerformance(p)},[{corrodeFields:[field("c",2,3)]},{events:[cue("c",2,3,"expired",2)]}]);await page.waitForTimeout(25);await render();
  assert.deepEqual(await active(),["2,3"]);await render(.5);assert.deepEqual(await active(),["2,3"]);
  await page.evaluate(()=>{window.setFixturePerformance(null);window.setFixtureView({corrodeFields:[{id:"live",cell:{x:7,y:8}}]})});await page.waitForTimeout(25);await render();assert.deepEqual(await active(),["7,8"]);
  await change("setFixtureView",{});assert.deepEqual(await active(),[]);
  // Drive the real rule -> verified presentation pipeline, not only hand-made
  // cues, through the real world. Check every settled event against its fields.
  const actual=await page.evaluate(async()=>{
    const {createMatch,bossPrepare,living,playTurn}=await import('/src/game/mecha/rules.ts');
    const {buildPresentationChanges}=await import('/src/game/mecha/presentationChanges.ts');
    const {buildHealthTimeline}=await import('/src/game/mecha/healthTimeline.ts');
    const {performanceFromLog}=await import('/src/game/mecha/performance.ts');
    const before=createMatch({preset:'covers_sparse_mid',script:'stationary_smash',covers:[],boss:{x:4,y:4},mechs:[{id:'Assault',pos:{x:4,y:7}},{id:'Gunner',pos:{x:4,y:8}},{id:'Support',pos:{x:0,y:9}}],monsterContent:{speciesId:'porous_shaper',contentVersion:1}});
    bossPrepare(before);
    const result=playTurn(before,{revision:before.revision,items:living(before).map(({id})=>({mechId:id,moveTo:null,action:{kind:'skip'}}))});
    const changes=buildPresentationChanges(result.presentationStages,result.log),health=buildHealthTimeline(before,result.state,result.log);
    return {ok:result.ok,verified:changes.ok,before:before.corrode.fields,after:result.state.corrode.fields,
      events:performanceFromLog(before,result.state,result.log,{presentationChanges:changes,healthTimeline:health}),
      unverified:performanceFromLog(before,result.state,result.log,{presentationChanges:{ok:false,reason:'missing'},healthTimeline:health})};
  });
  assert.ok(actual.ok && actual.verified);assert.ok(actual.events.some(e=>e.kind==="corrode_field" && e.change==="created"));
  assert.ok(!actual.unverified.some(e=>e.kind==="corrode_field"),"unverified evidence cannot invent a cue");
  await page.evaluate(([v,p])=>{window.setFixtureView(v);window.setFixturePerformance(p);window.setFixturePaused(true)},[{corrodeFields:actual.before},{events:actual.events}]);await page.waitForTimeout(25);await render();
  let expected=new Map(actual.before.map(f=>[f.id,f.cell]));
  await change("setFixturePaused",false);
  for(const event of actual.events){
    await render(event.duration);
    if(event.kind==="corrode_field"){if(event.change==="created")expected.set(event.fieldId,event.cell);else expected.delete(event.fieldId)}
    const cells=[...new Set([...expected.values()].map(c=>`${c.x},${c.y}`))].sort();
    assert.deepEqual((await active()).sort(),cells,`settled real cue ${event.kind}`);
  }
  assert.deepEqual([...expected.keys()].sort(),actual.after.map(f=>f.id).sort());
  // If evidence is unavailable, no field is inferred during the replay. The
  // authoritative after snapshot appears only when playback ends.
  await page.evaluate(([v,p])=>{window.setFixtureView(v);window.setFixturePerformance(p)},[{corrodeFields:actual.before},{events:actual.unverified}]);await page.waitForTimeout(25);await render();
  for(const event of actual.unverified) await render(event.duration);
  assert.deepEqual((await active()).sort(),actual.before.map(f=>`${f.cell.x},${f.cell.y}`).sort());
  await page.evaluate(v=>{window.setFixturePerformance(null);window.setFixtureView({corrodeFields:v})},actual.after);await page.waitForTimeout(25);await render();
  assert.deepEqual((await active()).sort(),actual.after.map(f=>`${f.cell.x},${f.cell.y}`).sort());
  if (process.env.MECHA_CORRODE_CAPTURE_DIR) {
    // Show the real resolved field alongside the corresponding species on the
    // same synthetic site; the fixture does not represent a full City session.
    await change("setFixtureView", { corrodeFields: actual.after, bossSpeciesId: "porous_shaper", boss: { x: 4, y: 4, alive: true },
      figures: [{ id: "Assault", x: 4, y: 7, alive: true }, { id: "Gunner", x: 4, y: 8, alive: true }, { id: "Support", x: 0, y: 9, alive: true }] });
    await change("setFixturePaused", false);
    for (let i = 0; i < 80; i++) await render(.05);
    await mkdir(process.env.MECHA_CORRODE_CAPTURE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MECHA_CORRODE_CAPTURE_DIR, "corrode-committed.png") });
  }
  await page.emulateMedia({reducedMotion:"reduce"});await change("setFixtureSite","rect");
  assert.deepEqual(await page.evaluate(()=>window.__corrodeHistory[0].counts),{geometry:1,material:1,badgeMaterial:1,texture:1});
  await page.evaluate(([v,p])=>{window.setFixtureView(v);window.setFixturePerformance(p);window.setFixturePaused(true)},[{corrodeFields:[]},{events:[cue("x",4,4,"created"),cue("x",4,4,"expired"),cue("y",3,4,"created")]}]);await page.waitForTimeout(25);await render(2);
  assert.deepEqual(await active(),[],"reduced motion still respects pause");
  await change("setFixturePaused",false);await render(.1);
  assert.deepEqual(await active(),["3,4"],"reduced motion settles all events");
  const rect=await page.evaluate(()=>{const p=window.__corrodeProbe,m=p.corrodeMarks[43],at=p.cell(3,4);return {position:m.ground.position.toArray(),expected:[at.x,at.y+.34,at.z],yaw:m.ground.rotation.y,siteYaw:p.site.yaw}});
  assert.deepEqual(rect.position,rect.expected);assert.equal(rect.yaw,rect.siteYaw);
  const snapshot=()=>page.evaluate(()=>{const m=window.__corrodeProbe.corrodeMarks[43];return {position:m.badge.position.toArray(),scale:m.badge.scale.toArray(),angle:m.ground.rotation.y}});
  const before=await snapshot();await render(1);assert.deepEqual(await snapshot(),before,"persistent marker does not animate");
  await page.evaluate(()=>window.fixture.unmount());const cleanup=await page.evaluate(()=>({history:window.__corrodeHistory.map(p=>p.counts),life:window.fixture.lifecycle()}));
  for(const counts of cleanup.history)assert.deepEqual(counts,{geometry:1,material:1,badgeMaterial:1,texture:1});
  assert.equal(cleanup.life.releases,2);assert.equal(cleanup.life.frameActive,false);assert.equal(cleanup.life.rootAttached,false);
  assert.deepEqual(errors,[]);
  console.log("Corrode world: authoritative state, no intent impostors, pixel overlap, picking, playback/replay/stop, reduced motion and disposal passed (synthetic WebGL).");
} finally { await browser.close() }
