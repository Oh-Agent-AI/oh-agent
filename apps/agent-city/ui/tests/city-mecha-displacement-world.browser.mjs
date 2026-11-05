#!/usr/bin/env node
// Synthetic local fixture (not a user/UI walkthrough): real rules, presentation
// and CityMechaWorld, with a browser-only read probe and deterministic clock.
// Start Vite, then: node tests/city-mecha-displacement-world.browser.mjs http://127.0.0.1:5179
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5179", origin = new URL(base).origin;
const browser = await chromium.launch({headless:true,args:["--enable-unsafe-swiftshader"]});
try {
  const page = await browser.newPage({viewport:{width:640,height:480}}), errors=[];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
    const response=await route.fetch(); let source=await response.text();
    const needle="    lease.setFrameHook(() => {", clock="const dt = Math.min(0.08, (now - lastFrame) / 1e3);";
    assert.ok(source.includes(needle) && source.includes(clock), "world probe/clock insertion points");
    source=source.replace(needle,"    window.__displacementProbe = {actors,root};\n"+needle)
      .replace(clock,"const dt = window.__testDt ?? Math.min(0.08, (now - lastFrame) / 1000);");
    await route.fulfill({response,body:source});
  });
  await page.route("**/__displacement-fixture*", route => route.fulfill({contentType:"text/html",body:`<!doctype html><style>html,body{margin:0}canvas{display:block;width:100vw;height:100vh;touch-action:none}</style><canvas></canvas><div id="root"></div>
<script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
const React=(await import('/node_modules/.vite/deps/react.js')).default;
const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const THREE=await import('/node_modules/.vite/deps/three.js');
const {CityMechaWorld}=await import('/src/game/CityMechaWorld.tsx');
const canvas=document.querySelector('canvas'),renderer=new THREE.WebGLRenderer({canvas,antialias:true});renderer.setSize(innerWidth,innerHeight);
const scene=new THREE.Scene();scene.add(new THREE.HemisphereLight('#ffffff','#666666',2));
const camera=new THREE.PerspectiveCamera(53,innerWidth/innerHeight,1,8000),target=new THREE.Vector3(9,4,-3);
camera.position.set(130,210,-90);camera.lookAt(target);camera.updateMatrixWorld();
let frame=null,releases=0,completes=0;
const photo=()=>({position:camera.position.toArray(),target:target.toArray(),fov:camera.fov});
const setView=v=>{camera.position.fromArray(v.position);target.fromArray(v.target);camera.fov=v.fov;camera.updateProjectionMatrix();camera.lookAt(target);camera.updateMatrixWorld()};
const engine={domCanvas:canvas,renderCamera:camera,skyNight:0,owner:'orbit',captureReturnView:photo,restoreReturnView:setView,photoView:photo,
 acquireModeLease:()=>{let attached=[];return {setBattleClarity:()=>{},attach:items=>{attached=items;scene.add(...items)},setFrameHook:fn=>{frame=fn},setOrbitView:v=>setView({position:v.position.toArray(),target:v.target.toArray(),fov:v.fov}),release:()=>{releases++;frame=null;scene.remove(...attached)}}}};
// Sloped heights, a rotated board and rectangular cells exercise coordinate conversion.
const site={originX:13,originZ:-21,yaw:.35,cellW:12,cellD:17,heights:Array.from({length:10},(_,y)=>Array.from({length:10},(_,x)=>.3*x+.2*y)),terrain:Array.from({length:10},()=>Array(10).fill('empty')),buildings:[],blocked:[]};
const initial={figures:[],boss:{x:0,y:0,alive:false},raiders:[],buildings:[],declaredTelegraph:[],projectedTelegraph:null,telegraph:[],focusedTelegraph:[],focus:[],reach:[],move:null,targets:[],targetIds:[]},ref=React.createRef();
function App(){const [view,setView]=React.useState(initial),[performance,setPerformance]=React.useState(null),[paused,setPaused]=React.useState(true);
 window.setFixtureView=v=>setView({...initial,...v});window.setFixturePerformance=setPerformance;window.setFixturePaused=setPaused;
 return React.createElement(CityMechaWorld,{engine,site,view,ref,performance,paused,performanceSpeed:1,onPerformanceComplete:()=>completes++,onCell:()=>{}})}
const root=createRoot(document.getElementById('root'));root.render(React.createElement(App));
window.fixture={site,ref,render(){frame?.();scene.updateMatrixWorld(true);renderer.render(scene,camera)},completes:()=>completes,
 lifecycle:()=>({releases,frameActive:frame!==null,rootAttached:scene.children.includes(window.__displacementProbe.root)}),unmount:()=>root.unmount()};
</script>`}));
  await page.goto(new URL("/__displacement-fixture?assaultTrial=1",base).href);
  await page.waitForFunction(()=>window.__displacementProbe && window.fixture?.ref.current);
  const render=(dt=0)=>page.evaluate(dt=>{window.__testDt=dt;window.fixture.render()},dt);
  const sync=async()=>{await page.waitForTimeout(30);await render()};
  const snapshot=()=>page.evaluate(()=>Object.fromEntries(["boss","Assault","Gunner","Support"].map(id=>[id,window.__displacementProbe.actors[id].position.toArray()])));
  const site=await page.evaluate(()=>window.fixture.site);
  // Independent cell/footprint conversion oracle, including four boss terrain heights.
  const world=(cell,id)=>{const offset=id==="boss"?1:.5,x=(cell.x+offset)*site.cellW,z=(cell.y+offset)*site.cellD,c=Math.cos(site.yaw),s=Math.sin(site.yaw);
    const h=id==="boss"?(site.heights[cell.y][cell.x]+site.heights[cell.y][cell.x+1]+site.heights[cell.y+1][cell.x]+site.heights[cell.y+1][cell.x+1])/4:site.heights[cell.y][cell.x];
    return [site.originX+x*c+z*s,h,site.originZ-x*s+z*c]};
  const near=(actual,expected,message)=>{assert.equal(actual.length,3,message);actual.forEach((n,i)=>assert.ok(Math.abs(n-expected[i])<1e-5,`${message} [${i}]: ${n} vs ${expected[i]}`))};
  for(const species of ["phase_stalker","gravity_core"]){
    const data=await page.evaluate(async speciesId=>{
      const {createMatch,bossPrepare,living,playTurn}=await import('/src/game/mecha/rules.ts');
      const {buildPresentationChanges}=await import('/src/game/mecha/presentationChanges.ts');
      const {buildHealthTimeline}=await import('/src/game/mecha/healthTimeline.ts');
      const {performanceFromLog}=await import('/src/game/mecha/performance.ts');
      const {performanceHealthSchedule}=await import('/src/game/mecha/performanceHealth.ts');
      const mechs=speciesId==='phase_stalker'?[{id:'Assault',pos:{x:4,y:7}},{id:'Gunner',pos:{x:5,y:7}},{id:'Support',pos:{x:0,y:9}}]:[{id:'Assault',pos:{x:2,y:4}},{id:'Gunner',pos:{x:7,y:4}},{id:'Support',pos:{x:4,y:7}}];
      const before=createMatch({preset:'covers_sparse_mid',script:'stationary_smash',covers:[],boss:{x:4,y:4},mechs,monsterContent:{speciesId,contentVersion:1}});bossPrepare(before);
      const result=playTurn(before,{revision:before.revision,items:living(before).map(({id})=>({mechId:id,moveTo:null,action:{kind:'skip'}}))});
      const changes=buildPresentationChanges(result.presentationStages,result.log),health=buildHealthTimeline(before,result.state,result.log),events=performanceFromLog(before,result.state,result.log,{presentationChanges:changes,healthTimeline:health});
      const schedule=performanceHealthSchedule(events,health,changes);
      const project=s=>({figures:s.mechs.map(m=>({id:m.id,x:m.pos.x,y:m.pos.y,alive:m.hp>0,hp:m.hp,selected:false})),boss:{x:s.boss.anchor.x,y:s.boss.anchor.y,alive:s.boss.hp>0,hp:s.boss.hp},bossSpeciesId:speciesId,raiders:s.raiders.map(r=>({id:r.id,x:r.pos.x,y:r.pos.y,alive:r.hp>0,hp:r.hp})),buildings:s.buildings.map(b=>({id:b.id,cells:b.cells,hp:b.hp,maxHp:b.maxHp}))});
      return {ok:result.ok,changes,health,schedule,events,log:result.log,before:project(before),after:project(result.state)};
    },species);
    assert.ok(data.ok && data.changes.ok && data.health.ok && data.schedule,`${species}: verified outcome`);
    const skill=species==="phase_stalker"?"phase_swap":"gravity_well";
    const logs=data.log.flatMap((event,index)=>event.type==="monster_displacement"?[{event,index}]:[]),moves=data.events.filter(e=>e.kind==="monster_displacement");
    assert.ok(logs.length && moves.length===logs.length,`${skill}: non-void displacements`);
    for(const {event,index} of logs){const cue=moves.find(e=>e.sourceLogIndex===index);assert.ok(cue && cue.skill===skill && event.skill===skill);
      assert.deepEqual(cue.moves.map(m=>[m.actor,m.from,m.to]),event.moves.map(m=>[m.unit.replace(/^mech:/,""),m.from,m.to]))}
    assert.ok(data.events.findIndex(e=>e.kind==="attack" && e.actor==="boss")>data.events.findLastIndex(e=>e.kind==="monster_displacement"));
    if(skill==="phase_swap")assert.equal(moves[0].moves.length,2);else assert.equal(moves.length,3,"three sequential pulls");
    const anchor=data.before.boss;
    for(const cue of moves)for(const move of cue.moves){
      assert.notDeepEqual(move.from,move.to,`${skill}: each reported displacement actually moves`);
      if(move.actor!=="boss"){
        // Manhattan distance to the nearest cell of the initial 2x2 footprint.
        const dx=Math.max(anchor.x-move.from.x,0,move.from.x-anchor.x-1);
        const dy=Math.max(anchor.y-move.from.y,0,move.from.y-anchor.y-1);
        assert.ok(dx+dy<=2,`${skill}: ${move.actor} starts close to boss footprint`);
      }
    }
    await page.evaluate(({before,events,health,changes})=>{window.setFixturePaused(true);window.setFixtureView({...before,combat:{id:1,actions:[],healthTimeline:health,presentationChanges:changes}});window.setFixturePerformance({events})},data);await sync();
    const cells=Object.fromEntries(data.before.figures.map(f=>[f.id,{x:f.x,y:f.y}]));cells.boss={x:data.before.boss.x,y:data.before.boss.y};
    let current=await snapshot();for(const id of Object.keys(cells))near(current[id],world(cells[id],id),`${skill}: initial ${id}`);
    const completedBefore=await page.evaluate(()=>window.fixture.completes());
    await page.evaluate(()=>window.setFixturePaused(false));await sync();
    for(const event of data.events){
      if(event.kind!=="monster_displacement"){await render(event.duration);continue}
      current=await snapshot();
      for(const move of event.moves){assert.deepEqual(cells[move.actor],move.from,`${skill}: committed from`);near(current[move.actor],world(move.from,move.actor),`${skill}: ${move.actor} start`)}
      await render(event.duration/2);
      const mid=await snapshot(),moving=new Map(event.moves.map(m=>[m.actor,m]));
      for(const id of Object.keys(cells)){const move=moving.get(id);if(!move){near(mid[id],world(cells[id],id),`${skill}: ${id} stays`);continue}
        const from=world(move.from,id),to=world(move.to,id),expected=from.map((v,i)=>(v+to[i])/2+(i===1 && skill==="phase_swap"?2:0));near(mid[id],expected,`${skill}: ${id} halfway`)}
      await page.evaluate(()=>window.setFixturePaused(true));await sync();await render(.5);
      const paused=await snapshot();for(const id of Object.keys(cells))near(paused[id],mid[id],`${skill}: ${id} paused`);
      await page.evaluate(()=>window.setFixturePaused(false));await sync();await render(event.duration/2+1e-9);
      for(const move of event.moves)cells[move.actor]=move.to;
      const settled=await snapshot();for(const id of Object.keys(cells))near(settled[id],world(cells[id],id),`${skill}: ${id} settled`);
    }
    await render(.000001);assert.equal(await page.evaluate(()=>window.fixture.completes()),completedBefore+1,`${skill}: completion once`);
    const final=await snapshot();for(const f of data.after.figures)near(final[f.id],world({x:f.x,y:f.y},f.id),`${skill}: ${f.id} final rule state`);
    near(final.boss,world({x:data.after.boss.x,y:data.after.boss.y},"boss"),`${skill}: boss final rule state`);
    await page.evaluate(after=>{window.setFixturePerformance(null);window.setFixtureView(after)},data.after);await sync();
    const live=await snapshot();for(const id of Object.keys(cells))near(live[id],final[id],`${skill}: no jump on state switch`);
    await render(1);assert.equal(await page.evaluate(()=>window.fixture.completes()),completedBefore+1,`${skill}: completion not repeated`);
    console.log(`${skill}: ${logs.length} verified cue(s), halfway/pause/settle/final and state switch passed; ${JSON.stringify(moves.map(c=>c.moves))}`);
  }
  await page.evaluate(()=>window.fixture.unmount());
  assert.deepEqual(await page.evaluate(()=>window.fixture.lifecycle()),{releases:1,frameActive:false,rootAttached:false});assert.deepEqual(errors,[]);
  console.log("Synthetic fixture: real rules + CityMechaWorld with injected deterministic clock; not an interactive UI walkthrough.");
}finally{await browser.close()}
