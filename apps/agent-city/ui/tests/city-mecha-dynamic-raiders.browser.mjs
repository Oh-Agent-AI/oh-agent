#!/usr/bin/env node
// Synthetic local fixture: real CityMechaWorld and WebGL, with a browser-only
// read probe and deterministic clock. No gameplay-rule integration is claimed.
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
          badge: !m.badge.label.hidden, unitId: m.badge.label.dataset.unitId, side: m.badge.label.dataset.side,
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
  const site=await page.evaluate(()=>window.fixture.site);
  const world=({x,y})=>{const a=(x+.5)*site.cellW,b=(y+.5)*site.cellD,c=Math.cos(site.yaw),s=Math.sin(site.yaw);return [site.originX+a*c+b*s,site.heights[y][x],site.originZ-a*s+b*c]};
  const near=(actual,expected,label)=>actual.forEach((n,i)=>assert.ok(Math.abs(n-expected[i])<1e-5,`${label}[${i}]: ${n} != ${expected[i]}`));
  const make=(id,x,y,alive=true)=>({id,x,y,alive,hp:alive?2:0,maxHp:3});
  let view={boss:{x:7,y:7,alive:true,hp:10,maxHp:10},bossSpeciesId:'phase_stalker',figures:[{id:'Assault',x:0,y:9,alive:true,selected:false,hp:5,maxHp:5}],
    raiders:[make('raider-w',1,1),make('raider-e',4,1),make('swarm:0',6,3),make('swarm:1',2,6)],targetIds:['swarm:0']};
  await setView(view);let s=await snapshot();
  assert.deepEqual(Object.keys(s).sort(),view.raiders.map(r=>r.id).sort());
  for(const r of view.raiders){near(s[r.id].position,world(r),r.id);assert.ok(s[r.id].visible&&s[r.id].ring&&s[r.id].badge&&s[r.id].animator);assert.equal(s[r.id].unitId,r.id);assert.equal(s[r.id].light,'procedural')}
  assert.equal(s['swarm:0'].scale,1.28);assert.equal(s['swarm:0'].opacity,1);assert.equal(s['swarm:0'].side,'unknown');
  await page.evaluate(()=>{for(const id of ['raider-w','raider-e','swarm:0','swarm:1'])window.__raiderProbe.watch(id)});
  const point=await page.evaluate(()=>window.__raiderProbe.find('swarm:0'));assert.ok(point,'third raider has a visible, unobstructed raycast target');
  await page.mouse.move(point.x,point.y);await page.waitForFunction(()=>window.fixture.hover()==='swarm:0');
  await page.mouse.click(point.x,point.y);assert.deepEqual(await page.evaluate(()=>window.fixture.pick()),{x:6,y:3,kind:'mouse'});
  // A cue on an extra actor reaches its independent battle animator.
  view={...view,combat:{id:1,actions:[{actor:'swarm:0',action:'attack'}]}};await setView(view);
  assert.equal((await snapshot())['swarm:0'].action,'attack');
  // Legacy IDs, extra IDs and boss all bind to the same player, not fixed slots.
  const movers=[...view.raiders.map(r=>({id:r.id,from:{x:r.x,y:r.y},to:{x:r.x,y:r.y+1}})),{id:'boss',from:{x:7,y:7},to:{x:7,y:6}}];
  const events=movers.flatMap(m=>[{kind:'move',actor:m.id,path:[m.from,m.to],duration:.2},{kind:'move',actor:m.id,path:[m.to,m.from],duration:.2}]);
  await page.evaluate(events=>window.setFixturePerformance({events}),events);await sync();
  await page.evaluate(()=>window.setFixturePaused(false));await sync();
  const actorPos=id=>page.evaluate(id=>window.__raiderProbe.actors[id].position.toArray(),id);
  const bossWorld=({x,y})=>{const a=(x+1)*site.cellW,b=(y+1)*site.cellD,c=Math.cos(site.yaw),s=Math.sin(site.yaw);return [site.originX+a*c+b*s,(site.heights[y][x]+site.heights[y][x+1]+site.heights[y+1][x]+site.heights[y+1][x+1])/4,site.originZ-a*s+b*c]};
  for(const m of movers){const f=m.id==='boss'?bossWorld:world;await render(.1);near(await actorPos(m.id),f(m.from).map((n,i)=>(n+f(m.to)[i])/2),m.id+' player midpoint');await render(.1);await render(.2);near(await actorPos(m.id),f(m.from),m.id+' player return')}
  assert.equal(await page.evaluate(()=>window.fixture.completes()),1);
  await page.evaluate(()=>window.setFixturePerformance(null));await sync();
  // Reordering does not reassign surviving models, and obsolete resources are disposed.
  view={...view,raiders:[make('swarm:1',2,6),make('swarm:0',6,3),make('swarm:new',8,2)],targetIds:[]};await setView(view);
  s=await snapshot();assert.deepEqual(Object.keys(s).sort(),['swarm:0','swarm:1','swarm:new']);
  assert.equal((await page.evaluate(()=>window.__raiderProbe.state('swarm:0'))).same,true);
  const disposed={same:false,disposed:true,parent:false,ringParent:false,badgeConnected:false,geo:1,mat:1};
  for(const id of ['raider-w','raider-e'])assert.deepEqual(await page.evaluate(id=>window.__raiderProbe.state(id),id),disposed);
  // Draft movement uses interpolation rather than snapping.
  await page.evaluate(()=>window.setFixturePaused(false));await sync();
  view={...view,raiders:[make('swarm:1',2,6),make('swarm:0',5,3),make('swarm:new',8,2)]};await setView(view);
  const from=world({x:6,y:3}),to=world({x:5,y:3});await render(.08);s=await snapshot();
  assert.ok(Math.hypot(s['swarm:0'].position[0]-to[0],s['swarm:0'].position[2]-to[2])>.01);
  assert.ok(Math.hypot(s['swarm:0'].position[0]-from[0],s['swarm:0'].position[2]-from[2])>.01);
  for(let i=0;i<120;i++)await render(.08);near((await snapshot())['swarm:0'].position,to,'draft settled');
  // Synthetic performance replayed twice with pause, midpoint, ring, and completion.
  const event={kind:'move',actor:'swarm:0',path:[{x:5,y:3},{x:5,y:4}],duration:1};
  for(let pass=0;pass<2;pass++){
    await page.evaluate(event=>{window.setFixturePaused(true);window.setFixturePerformance({events:[event]})},event);await sync();
    near((await snapshot())['swarm:0'].position,to,'replay start');
    await page.evaluate(()=>window.setFixturePaused(false));await sync();await render(.5);s=await snapshot();const dest=world({x:5,y:4});
    near(s['swarm:0'].position,to.map((n,i)=>(n+dest[i])/2),'replay midpoint');
    near(s['swarm:0'].ringPosition,[s['swarm:0'].position[0],s['swarm:0'].position[1]+.55,s['swarm:0'].position[2]],'moving ring');
    await page.evaluate(()=>window.setFixturePaused(true));await sync();await render(.5);near((await snapshot())['swarm:0'].position,s['swarm:0'].position,'paused');
    await page.evaluate(()=>window.setFixturePaused(false));await sync();await render(.5);near((await snapshot())['swarm:0'].position,dest,'replay end');
    assert.equal(await page.evaluate(()=>window.fixture.completes()),pass+2);
    await page.evaluate(()=>window.setFixturePerformance(null));await sync();
  }
  // Dead snapshots keep the posed model but suppress picking, marker and badge.
  view={...view,raiders:[make('swarm:1',2,6),make('swarm:0',5,3),make('swarm:new',8,2,false)]};await setView(view);s=await snapshot();
  assert.equal(s['swarm:new'].visible,true);assert.equal(s['swarm:new'].ring,false);assert.equal(s['swarm:new'].badge,false);
  assert.equal(await page.evaluate(()=>window.__raiderProbe.find('swarm:new')),null);
  for(let i=0;i<8;i++)await render(.08);assert.equal((await snapshot())['swarm:new'].action,'defeat');
  // A roster switch while playing must not mutate the player's actor dictionary.
  const lateMove={kind:'move',actor:'swarm:late',path:[{x:3,y:8},{x:4,y:8}],duration:1};
  await page.evaluate(events=>{window.setFixturePaused(true);window.setFixturePerformance({events})},[event,lateMove]);await sync();
  view={...view,raiders:[make('swarm:new',8,2),make('swarm:late',3,8)]};await setView(view);s=await snapshot();
  assert.equal(s['swarm:0'].visible,false);assert.equal(s['swarm:0'].ring,false);assert.equal(s['swarm:late'].visible,true);
  assert.equal((await page.evaluate(()=>window.__raiderProbe.state('swarm:0'))).disposed,false);
  await page.evaluate(()=>window.setFixturePaused(false));await sync();await render(.5);await render(.5);await render(.5);
  near((await snapshot())['swarm:late'].position,world({x:3,y:8}),'late actor not in current player snapshot');assert.deepEqual(errors,[]);
  // Switching to a new performance binds that same newly displayed actor.
  await page.evaluate(event=>window.setFixturePerformance({events:[event]}),lateMove);await sync();await render(.5);
  near((await snapshot())['swarm:late'].position,world({x:3,y:8}).map((n,i)=>(n+world({x:4,y:8})[i])/2),'late actor in next player');
  await page.evaluate(()=>window.setFixturePerformance(null));await sync();
  assert.deepEqual(await page.evaluate(()=>window.__raiderProbe.state('swarm:0')),disposed);
  await page.evaluate(()=>{window.__raiderProbe.watch('swarm:new');window.__raiderProbe.watch('swarm:late');window.fixture.unmount()});
  for(const id of ['swarm:new','swarm:late'])assert.deepEqual(await page.evaluate(id=>window.__raiderProbe.state(id),id),disposed);
  assert.deepEqual(await page.evaluate(()=>window.fixture.lifecycle()),{releases:1,frameActive:false,rootAttached:false});assert.deepEqual(errors,[]);
  console.log('Dynamic raiders: synthetic real world, four actors, reorder/replacement, pointer, draft movement, replay/pause, live roster switch, and disposal passed.');
}finally{await browser.close()}
