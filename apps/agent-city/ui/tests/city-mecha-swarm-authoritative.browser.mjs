#!/usr/bin/env node
// Synthetic local fixture: real CityMechaWorld and WebGL, with a browser-only
// read probe and deterministic clock, driven by real local authoritative swarm turns.
// Start Vite, then: node tests/city-mecha-dynamic-raiders.browser.mjs http://127.0.0.1:5179
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
    const probe = `    window.__raiderProbe = {
      actors, root, raiderModels, boss, animators, saved: new Map(),
      watch(id) {
        const m = raiderModels.get(id), state = { m, geo: 0, mat: 0 };
        m.ring.geo.addEventListener('dispose', () => state.geo++);
        m.ring.mat.addEventListener('dispose', () => state.mat++);
        this.saved.set(id, state);
      },
      state(id) {
        const s = this.saved.get(id);
        return { same: raiderModels.get(id) === s.m, disposed: !!s.m.mesh.userData.disposed,
          parent: !!s.m.mesh.parent, ringParent: !!s.m.ring.mesh.parent,
          badgeConnected: s.m.badge.label.isConnected, geo: s.geo, mat: s.mat };
      },
      snapshot() {
        return Object.fromEntries(Array.from(raiderModels, ([id, m]) => [id, {
          position: m.mesh.position.toArray(), visible: m.mesh.visible, ring: m.ring.mesh.visible,
          ringPosition: m.ring.mesh.position.toArray(), opacity: m.ring.mat.opacity, scale: m.ring.mesh.scale.x,
          hp: m.badge.label.getAttribute("aria-valuenow"), badge: !m.badge.label.hidden, unitId: m.badge.label.dataset.unitId, side: m.badge.label.dataset.side,
          light: m.mesh.userData.unitLightFor, animator: animators.has(m.mesh), action: animators.get(m.mesh)?.animator.action
        }]));
      },
      find(id) {
        root.updateMatrixWorld(true); camera.updateMatrixWorld(true);
        const mesh = raiderModels.get(id)?.mesh; if (!mesh) return null;
        const bounds = new THREE.Box3().setFromObject(mesh), vertices = [];
        for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z]) vertices.push(new THREE.Vector3(x, y, z).project(camera));
        const rect = canvas.getBoundingClientRect();
        const minX = Math.max(0, Math.floor((Math.min(...vertices.map(p => p.x)) + 1) * rect.width / 2));
        const maxX = Math.min(rect.width - 1, Math.ceil((Math.max(...vertices.map(p => p.x)) + 1) * rect.width / 2));
        const minY = Math.max(0, Math.floor((1 - Math.max(...vertices.map(p => p.y))) * rect.height / 2));
        const maxY = Math.min(rect.height - 1, Math.ceil((1 - Math.min(...vertices.map(p => p.y))) * rect.height / 2));
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
          pointer.set(x / rect.width * 2 - 1, 1 - y / rect.height * 2);
          const hit = unitUnderPointer(); raycaster.setFromCamera(pointer, camera);
          const tile = raycaster.intersectObjects(picks, false)[0];
          if (hit?.id === id && (!tile || hit.distance <= tile.distance)) return { x: rect.left + x, y: rect.top + y };
        }
        return null;
      }
    };\n`;
    source=source.replace(needle,probe+needle)
      .replace(clock,"const dt = window.__testDt ?? Math.min(0.08, (now - lastFrame) / 1000);");
    await route.fulfill({response,body:source});
  });
  await page.route("**/__dynamic-raiders-fixture*", route => route.fulfill({contentType:"text/html",body:`<!doctype html><style>html,body{margin:0}canvas{display:block;width:100vw;height:100vh;touch-action:none}</style><canvas></canvas><div id="root"></div>
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
let frame=null,releases=0,completes=0,lastPick=null,lastHover=null;
const photo=()=>({position:camera.position.toArray(),target:target.toArray(),fov:camera.fov});
const setView=v=>{camera.position.fromArray(v.position);target.fromArray(v.target);camera.fov=v.fov;camera.updateProjectionMatrix();camera.lookAt(target);camera.updateMatrixWorld()};
const engine={domCanvas:canvas,renderCamera:camera,skyNight:0,owner:'orbit',captureReturnView:photo,restoreReturnView:setView,photoView:photo,
 acquireModeLease:()=>{let attached=[];return {setBattleClarity:()=>{},attach:items=>{attached=items;scene.add(...items)},setFrameHook:fn=>{frame=fn},setOrbitView:v=>setView({position:v.position.toArray(),target:v.target.toArray(),fov:v.fov}),release:()=>{releases++;frame=null;scene.remove(...attached)}}}};
// Sloped heights, a rotated board and rectangular cells exercise coordinate conversion.
const site={originX:13,originZ:-21,yaw:.35,cellW:12,cellD:17,heights:Array.from({length:10},(_,y)=>Array.from({length:10},(_,x)=>.3*x+.2*y)),terrain:Array.from({length:10},()=>Array(10).fill('empty')),buildings:[],blocked:[]};
const initial={figures:[],boss:{x:0,y:0,alive:false},raiders:[],buildings:[],declaredTelegraph:[],projectedTelegraph:null,telegraph:[],focusedTelegraph:[],focus:[],reach:[],move:null,targets:[],targetIds:[]},ref=React.createRef();
function App(){const [view,setView]=React.useState(initial),[performance,setPerformance]=React.useState(null),[paused,setPaused]=React.useState(true);
 window.setFixtureView=v=>setView({...initial,...v});window.setFixturePerformance=setPerformance;window.setFixturePaused=setPaused;
 return React.createElement(CityMechaWorld,{engine,site,view,ref,performance,paused,performanceSpeed:1,onPerformanceComplete:()=>completes++,onCell:(x,y,kind)=>lastPick={x,y,kind},onHoverEnemy:id=>lastHover=id})}
const root=createRoot(document.getElementById('root'));root.render(React.createElement(App));
window.fixture={site,ref,render(){frame?.();scene.updateMatrixWorld(true);renderer.render(scene,camera)},completes:()=>completes,pick:()=>lastPick,hover:()=>lastHover,
 lifecycle:()=>({releases,frameActive:frame!==null,rootAttached:scene.children.includes(window.__raiderProbe.root)}),unmount:()=>root.unmount()};
</script>`}));
  await page.goto(new URL("/__dynamic-raiders-fixture?assaultTrial=1",base).href);
  await page.waitForFunction(()=>window.__raiderProbe && window.fixture?.ref.current);
  const render=dt=>page.evaluate(dt=>{window.__testDt=dt;window.fixture.render()},dt);
  const sync=async()=>{await page.waitForTimeout(150);await render(0)};
  const setView=async view=>{await page.evaluate(v=>window.setFixtureView(v),view);await sync()};
  const snapshot=()=>page.evaluate(()=>window.__raiderProbe.snapshot());
  const actual = await page.evaluate(async () => {
    const {createMatch,bossPrepare,playTurn} = await import('/src/game/mecha/rules.ts');
    const {buildPresentationChanges} = await import('/src/game/mecha/presentationChanges.ts');
    const {buildHealthTimeline} = await import('/src/game/mecha/healthTimeline.ts');
    const {performanceFromLog} = await import('/src/game/mecha/performance.ts');
    const {unitMaxHp} = await import('/src/game/mecha/unitHealth.ts');
    let state=createMatch({preset:'covers_sparse_mid',script:'stationary_smash',monsterContent:{speciesId:'swarm_mantle',contentVersion:1},
      boss:{x:4,y:4},covers:[],buildings:[],raiders:[],mechs:[{id:'Assault',pos:{x:4,y:2}},{id:'Gunner',pos:{x:0,y:9}},{id:'Support',pos:{x:1,y:9}}]});
    bossPrepare(state);
    const evaluate=(before,plan)=>{const result=playTurn(before,plan);if(!result.ok)throw Error(JSON.stringify(result));
      const changes=buildPresentationChanges(result.presentationStages,result.log),health=buildHealthTimeline(before,result.state,result.log,result.presentationStages);
      if(!changes.ok||!health.ok)throw Error(JSON.stringify({changes,health}));
      const maxHpFor = state => Object.fromEntries(state.raiders.map(r => [r.id, unitMaxHp(r.id, state)]));
      return {before,after:result.state,beforeMaxHp:maxHpFor(before),afterMaxHp:maxHpFor(result.state),events:performanceFromLog(before,result.state,result.log,{healthTimeline:health,presentationChanges:changes}),changes,health};};
    const plan=(before,target)=>({revision:before.revision,items:before.mechs.filter(m=>m.hp>0).map(m=>({mechId:m.id,moveTo:null,action:target&&m.id==='Assault'?{kind:'melee',target}:{kind:'skip'}}))});
    const first=evaluate(state,plan(state)),second=evaluate(first.after,plan(first.after));
    const victim=structuredClone(first.after);victim.boss.hp=0;victim.boss.intent=null;victim.raiders=[victim.raiders[0]];
    victim.mechs.find(m=>m.id==='Assault').pos={x:victim.raiders[0].pos.x-1,y:victim.raiders[0].pos.y};
    return {first,second,death:evaluate(victim,plan(victim,victim.raiders[0].id))};
  });
  const view = turn => ({boss:{x:turn.before.boss.anchor.x,y:turn.before.boss.anchor.y,alive:turn.before.boss.hp>0,hp:turn.before.boss.hp,maxHp:turn.before.boss.maxHp},bossSpeciesId:'swarm_mantle',
    figures:turn.before.mechs.map(m=>({id:m.id,x:m.pos.x,y:m.pos.y,alive:m.hp>0,hp:m.hp,maxHp:m.maxHp})),
    raiders:turn.before.raiders.map(r=>({id:r.id,x:r.pos.x,y:r.pos.y,alive:r.hp>0,hp:r.hp,maxHp:turn.beforeMaxHp[r.id]})),
    combat:{id:1,actions:[],healthTimeline:turn.health,presentationChanges:turn.changes}});
  const setPaused=async value=>{await page.evaluate(v=>window.setFixturePaused(v),value);await sync()};
  async function start(turn){await page.evaluate(v=>{window.setFixturePaused(true);window.setFixturePerformance(null);window.setFixtureView(v)},view(turn));await sync();
    await page.evaluate(events=>window.setFixturePerformance({events}),turn.events);await sync();}
  async function stop(turn){await page.evaluate(v=>{window.setFixturePerformance(null);window.setFixtureView(v)}, {...view(turn),raiders:turn.after.raiders.map(r=>({id:r.id,x:r.pos.x,y:r.pos.y,alive:r.hp>0,hp:r.hp,maxHp:turn.afterMaxHp[r.id]}))});await sync()}
  for (let pass=0;pass<2;pass++) {
    const t=actual.first; assert.equal(t.events.filter(e=>e.kind==='raider_spawn').length,2);
    await start(t); let s=await snapshot();
    for(const e of t.events.filter((e,i)=>e.kind==='raider_spawn' && i>0)){
      assert.equal(s[e.actor].visible,false,'future newborn hidden');assert.equal(s[e.actor].badge,false);
      assert.equal(await page.evaluate(id=>window.__raiderProbe.find(id),e.actor),null,'future newborn is not pickable');
    }
    await setPaused(false);
    for(const e of t.events){await render(e.duration);s=await snapshot();if(e.kind==='raider_spawn'){
      assert.equal(s[e.actor].visible,true,'born actor visible');assert.equal(s[e.actor].badge,true);assert.equal(s[e.actor].hp,String(e.hp));}}
    assert.equal(await page.evaluate(()=>window.fixture.completes()),pass+1);
    await setPaused(true);const frozen=await snapshot();await render(2);assert.deepEqual(await snapshot(),frozen,'paused frame');
    await stop(t);
  }
  const t=actual.second;assert.deepEqual(Object.values(t.beforeMaxHp),[2,2], 'production max HP mapping for real summoned children');await start(t);await setPaused(false);
  for(const e of t.events){await render(e.duration);const s=await snapshot();
    if(e.kind==='raider_spawn')assert.equal(s[e.actor].visible,true);
    if(e.kind==='raider_remove'){assert.equal(e.reason,'expired');assert.equal(s[e.actor].visible,false);assert.equal(s[e.actor].badge,false);}}
  await stop(t);assert.deepEqual(Object.keys(await snapshot()).sort(),t.after.raiders.map(r=>r.id).sort());
  const death=actual.death;await start(death);await setPaused(false);
  const removal=death.events.findIndex(e=>e.kind==='raider_remove' && e.reason==='death');assert.ok(removal>0,JSON.stringify(death.events));
  for(let i=0;i<death.events.length;i++){const e=death.events[i];await render(e.duration);const s=await snapshot();
    if(i===removal-1)assert.equal(s[death.before.raiders[0].id].hp,'0','lethal health visible before removal');
    if(i===removal){assert.equal(s[e.actor].visible,false);assert.equal(s[e.actor].badge,false);}}
  await stop(death);assert.deepEqual(Object.keys(await snapshot()),[]);
  await page.evaluate(()=>window.fixture.unmount());assert.deepEqual(await page.evaluate(()=>window.fixture.lifecycle()),{releases:1,frameActive:false,rootAttached:false});
  assert.deepEqual(errors,[]);
  console.log('Authoritative swarm WebGL: births, hidden/picking, health, replay, pause, expiry, death and cleanup passed.');
}finally{await browser.close()}
