#!/usr/bin/env node
// Synthetic local site; exercises the real CityMechaWorld and Three.js renderer.
// Usage: node tests/city-mecha-monster-world.browser.mjs http://127.0.0.1:5179
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5179";
const origin = new URL(base).origin;
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  // The fixture and existing local assets may load, but nothing leaves localhost.
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
    const response = await route.fetch();
    const source = await response.text();
    const needle = "    const onDown = (event) => {";
    assert.ok(source.includes(needle), "world instrumentation point changed");
    const probe = `    window.__speciesProbe = { root, boss, get visual() { return bossSpeciesVisual; }, get view() { return viewRef.current; }, unitHit() { return unitUnderPointer(); },
      findOuter() {
        root.updateMatrixWorld(true);
        const body = bossSpeciesVisual.pickRoot; if (!body) return null;
        const bounds = new THREE.Box3().setFromObject(body); const vertices = [];
        for (const x of [bounds.min.x,bounds.max.x]) for (const y of [bounds.min.y,bounds.max.y]) for (const z of [bounds.min.z,bounds.max.z]) vertices.push(new THREE.Vector3(x,y,z).project(camera));
        const rect = canvas.getBoundingClientRect(), ray = new THREE.Raycaster(), tileRay = new THREE.Raycaster(); tileRay.layers.set(1);
        const minX = Math.max(0,Math.floor((Math.min(...vertices.map(v=>v.x))+1)*rect.width/2));
        const maxX = Math.min(rect.width-1,Math.ceil((Math.max(...vertices.map(v=>v.x))+1)*rect.width/2));
        const minY = Math.max(0,Math.floor((1-Math.max(...vertices.map(v=>v.y)))*rect.height/2));
        const maxY = Math.min(rect.height-1,Math.ceil((1-Math.min(...vertices.map(v=>v.y)))*rect.height/2));
        for (let y=minY;y<=maxY;y+=1) for (let x=minX;x<=maxX;x+=1) {
          const pointer = new THREE.Vector2(x/rect.width*2-1,1-y/rect.height*2);
          ray.setFromCamera(pointer,camera); tileRay.setFromCamera(pointer,camera);
          const hit = ray.intersectObject(body,true)[0]; if (!hit || ray.intersectObject(boss,true).length) continue;
          const tile = tileRay.intersectObjects(picks,false)[0]; if (tile && tile.distance < hit.distance) continue;
          return {x:rect.left+x,y:rect.top+y,distance:hit.distance};
        }
        return null;
      }, project(x,y) { const p=cellWorld(site,{x,y}); const v=new THREE.Vector3(p.x,p.y+.65,p.z).project(camera); const r=canvas.getBoundingClientRect(); return {x:r.left+(v.x+1)*r.width/2,y:r.top+(1-v.y)*r.height/2}; } };\n`;
    await route.fulfill({ response, body: source.replace(needle, probe + needle) });
  });
  await page.route("**/__monster-world-fixture*", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><style>html,body{margin:0} canvas{display:block;width:100vw;height:100vh;touch-action:none}</style><canvas></canvas><div id="root"></div>
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
let frame = null, lastPick = null, lastHover = null, releases = 0, restores = 0;
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
const initial = {figures:[],boss:{x:5,y:5,alive:true},raiders:[],buildings:[],declaredTelegraph:[],projectedTelegraph:null,telegraph:[],focusedTelegraph:[],focus:[],reach:[],move:null,targets:[],targetIds:[]};
const ref = React.createRef();
function App() {
 const [view, setFixtureView] = React.useState(initial), [site, setSite] = React.useState(()=>makeSite('flat')), [performance, setPerformance] = React.useState(null), [paused, setPaused] = React.useState(true);
 window.setFixturePaused = value => setPaused(value);
 window.setFixturePerformance = value => setPerformance(value);
 window.setFixtureView = value => setFixtureView({...initial,...value});
 window.setFixtureSite = kind => setSite(makeSite(kind));
 return React.createElement(CityMechaWorld,{engine,site,view,ref,performance,paused,onPerformanceComplete:()=>{},onCell:(x,y,input)=>{lastPick={x,y,input}},onHoverEnemy:id=>{lastHover=id}});
}
const reactRoot = createRoot(document.getElementById('root'));
reactRoot.render(React.createElement(App));
window.fixture = { ref, originalView, photo, setView,
 resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); },
 render() { frame?.(); scene.updateMatrixWorld(true); renderer.render(scene,camera); return renderer.info.render.calls; },
 rawRender() { scene.updateMatrixWorld(true); renderer.render(scene,camera); },
 pixels() { const gl=renderer.getContext(), data=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4); gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data); return data; },
 getPick:()=>lastPick, clearPick:()=>{lastPick=null}, getHover:()=>lastHover,
 lifecycle:() => ({releases, restores, rootAttached:scene.children.includes(window.__speciesProbe.root), frameActive:frame !== null}),
 unmount:() => reactRoot.unmount() };
window.fixture.resize();
</script>` }));
  await page.goto(new URL("/__monster-world-fixture?assaultTrial=1", base).href);
  await page.waitForFunction(() => window.__speciesProbe && window.fixture?.ref.current);
  const frame = () => page.evaluate(() => window.fixture.render());
  const setView = async view => { await page.evaluate(v => window.setFixtureView(v), view); await page.waitForTimeout(50); await frame(); };
  const view = {boss:{x:5,y:5,alive:true}};
  await setView(view);
  assert.equal(await page.evaluate(() => window.__speciesProbe.visual.status), "legacy");
  const legacyInfo = await page.evaluate(() => {
    const p=window.__speciesProbe, meshes=[];
    p.boss.traverse(n => { if (n.isMesh) meshes.push(...(Array.isArray(n.material) ? n.material : [n.material])); });
    return { name:p.visual.root.children[0]?.name, pick:p.visual.pickRoot===p.visual.root, masked:meshes.length>0 && meshes.every(m=>!m.visible) };
  });
  assert.deepEqual(legacyInfo, {name:"legacy-boss-geometric-body",pick:true,masked:true});
  const defaultPixels = await page.evaluate(() => Array.from(window.fixture.pixels()));
  await setView({...view, bossSpeciesId:"legacy_boss"});
  assert.equal(await page.evaluate(() => window.__speciesProbe.visual.status), "legacy");
  assert.deepEqual(await page.evaluate(() => Array.from(window.fixture.pixels())), defaultPixels, "explicit and undefined legacy are pixel-identical");
  await setView({...view, bossSpeciesId:"unknown"});
  assert.equal(await page.evaluate(() => window.__speciesProbe.visual.status), "unavailable");
  assert.notDeepEqual(await page.evaluate(() => Array.from(window.fixture.pixels())), defaultPixels, "unknown explicitly degrades to old rig");
  await setView(view);
  // Zoom to a normal close board view so thin geometry is represented by pixels,
  // while still exercising the real perspective camera and pointer handlers.
  await page.evaluate(() => {
    const p = window.__speciesProbe.boss.position;
    window.fixture.setView({position:[p.x+55,p.y+70,p.z-85], target:[p.x,p.y+8,p.z], fov:45});
  });
  await frame();
  const point = await page.evaluate(() => window.__speciesProbe.project(5,5));
  await page.mouse.click(point.x, point.y);
  const legacyPick = await page.evaluate(() => window.fixture.getPick());
  assert.ok(legacyPick, "baseline click must hit a cell");
  const legacyEdge = await page.evaluate(() => window.__speciesProbe.findOuter());
  assert.ok(legacyEdge, "default geometry has a pickable silhouette outside the rig");
  await page.mouse.move(2,2); await page.mouse.move(legacyEdge.x,legacyEdge.y); await page.waitForTimeout(40);
  assert.equal(await page.evaluate(() => window.fixture.getHover()), "boss");
  await page.evaluate(() => window.fixture.clearPick()); await page.mouse.click(legacyEdge.x,legacyEdge.y);
  assert.deepEqual(await page.evaluate(() => window.fixture.getPick()), {x:5,y:5,input:"mouse"});
  await page.evaluate(() => window.setFixturePaused(false));
  await setView({...view, boss:{...view.boss,alive:false}});
  await page.mouse.move(2,2); await page.mouse.move(legacyEdge.x,legacyEdge.y); await page.waitForTimeout(40);
  assert.notEqual(await page.evaluate(() => window.__speciesProbe.unitHit()?.id), "boss", "dead legacy boss cannot be picked");
  for (let i=0;i<16;i++) { await page.waitForTimeout(100); await frame(); }
  assert.ok(await page.evaluate(() => Math.abs(window.__speciesProbe.visual.root.children[0].rotation.x) > 0.5), "legacy body follows the defeat animation");
  await setView(view);
  await page.evaluate(() => window.setFixturePaused(true)); await frame();
  const captureDir = process.env.MECHA_MONSTER_WORLD_CAPTURE_DIR;
  if (captureDir) await mkdir(captureDir, { recursive: true });
  const ids = ["spore_leaper","flux_lancer","porous_shaper","prism_warden","swarm_mantle","phase_stalker","gravity_core","neural_weaver","many_core","field_sovereign"];
  for (const id of ids) {
    await setView({...view, bossSpeciesId:id});
    const result = await page.evaluate(() => {
      const p = window.__speciesProbe, visual = p.visual;
      const before = window.fixture.pixels(); visual.root.visible = false; window.fixture.rawRender(); const after = window.fixture.pixels(); visual.root.visible = true;
      let pixels = 0, clipped = 0;
      for (let i=0;i<before.length;i+=4) if (before[i]!==after[i] || before[i+1]!==after[i+1] || before[i+2]!==after[i+2]) {
        pixels++;
        if (before[i]>=240 && before[i+1]>=240 && before[i+2]>=240) clipped++;
      }
      const meshes = []; visual.root.traverse(n => { if(n.isMesh) meshes.push(n); });
      return { status:visual.status, name:visual.root.children[0]?.name, pixels, clipped,
        sibling:visual.root.parent === p.boss.parent && visual.root.parent === p.root,
        samePosition:visual.root.position.equals(p.boss.position), sameRotation:visual.root.quaternion.equals(p.boss.quaternion), sameScale:visual.root.scale.equals(p.boss.scale),
        pickRoot: p.visual.pickRoot === p.visual.root, meshCount:meshes.length };
    });
    assert.equal(result.status,"active",id); assert.equal(result.name,`monster-species-${id}`);
    assert.ok(result.pixels > 0, `${id} ornament should change visible pixels: ${JSON.stringify(result)}`);
    // A distant dense particle cloud previously clipped into an opaque white
    // blob. Keep the luminous pixels bounded in this representative view.
    if (id === "porous_shaper") {
      assert.ok(result.clipped < Math.max(32, result.pixels * .2), `board-view organism overexposed: ${JSON.stringify(result)}`);
      const far = await page.evaluate(() => {
        const p = window.__speciesProbe, previous = window.fixture.photo(), position = p.boss.position;
        window.fixture.setView({position:[position.x+110,position.y+140,position.z-170], target:[position.x,position.y+8,position.z], fov:45});
        window.fixture.rawRender(); const before = window.fixture.pixels();
        p.visual.root.visible = false; window.fixture.rawRender(); const after = window.fixture.pixels();
        p.visual.root.visible = true; window.fixture.setView(previous); window.fixture.rawRender();
        let pixels = 0, clipped = 0;
        for (let i=0;i<before.length;i+=4) if (before[i]!==after[i] || before[i+1]!==after[i+1] || before[i+2]!==after[i+2]) {
          pixels++;
          if (before[i]>=240 && before[i+1]>=240 && before[i+2]>=240) clipped++;
        }
        return {pixels, clipped};
      });
      assert.ok(far.pixels > 0, `far organism must remain visible: ${JSON.stringify(far)}`);
      assert.ok(far.clipped < Math.max(32, far.pixels * .2), `far organism overexposed: ${JSON.stringify(far)}`);
      console.log(`porous board pixels: ${JSON.stringify({pixels:result.pixels, clipped:result.clipped})}; farther pixels: ${JSON.stringify(far)}`);
    }
    assert.ok(result.sibling && result.samePosition && result.sameRotation && result.sameScale && result.pickRoot, JSON.stringify(result));
    assert.ok(result.meshCount >= 3);
    if (captureDir) {
      await frame();
      await page.screenshot({ path: path.join(captureDir, `${id}.png`) });
    }
    const edge = await page.evaluate(() => window.__speciesProbe.findOuter());
    assert.ok(edge, `${id}: must have a visible raycast target outside the old rig`);
    await page.mouse.move(2, 2); await page.waitForTimeout(30);
    await page.mouse.move(edge.x, edge.y); await page.waitForTimeout(40);
    assert.equal(await page.evaluate(() => window.fixture.getHover()), "boss", `${id}: new-only silhouette hover`);
    await page.evaluate(() => window.fixture.clearPick());
    await page.mouse.click(edge.x, edge.y);
    assert.deepEqual(await page.evaluate(() => window.fixture.getPick()), {x:5,y:5,input:"mouse"}, `${id}: new-only silhouette click`);
    const hit = await page.evaluate(() => window.__speciesProbe.unitHit());
    assert.equal(hit?.id,"boss", `${id}: actual unitUnderPointer identifies the boss`);
    assert.ok(Math.abs(hit.distance-edge.distance) < 1e-5, `${id}: actual hit must be the geometric mesh`);
    await page.evaluate(() => window.setFixturePaused(false));
    await setView({ ...view, bossSpeciesId:id, boss:{...view.boss,alive:false} });
    for (let i=0;i<16;i++) { await page.waitForTimeout(100); await frame(); }
    assert.ok(await page.evaluate(() => Math.abs(window.__speciesProbe.visual.root.children[0].rotation.x) > 0.5), `${id}: body follows defeat animation`);
    assert.notEqual(await page.evaluate(() => window.__speciesProbe.unitHit()?.id), "boss", `${id}: defeated boss cannot be picked`);
    await setView({...view,bossSpeciesId:id});
    await page.evaluate(() => window.setFixturePaused(true)); await frame();
    if (id === "field_sovereign") {
      await page.evaluate(() => { window.__speciesProbe.visual.root.visible = false; });
      await page.mouse.move(2,2); await page.waitForTimeout(30);
      await page.mouse.move(edge.x,edge.y); await page.waitForTimeout(40);
      assert.notEqual(await page.evaluate(() => window.fixture.getHover()), "boss", "hidden geometry does not hover");
      assert.notEqual(await page.evaluate(() => window.__speciesProbe.unitHit()?.id), "boss", "hidden ancestor rejects geometry hit");
      await page.evaluate(() => { window.__speciesProbe.visual.root.visible = true; });
      await setView({ ...view, bossSpeciesId:id, boss:{...view.boss,alive:false} });
      await page.mouse.move(2,2); await page.waitForTimeout(30);
      await page.mouse.move(edge.x,edge.y); await page.waitForTimeout(40);
      assert.notEqual(await page.evaluate(() => window.fixture.getHover()), "boss", "dead boss is not hoverable");
      assert.notEqual(await page.evaluate(() => window.__speciesProbe.unitHit()?.id), "boss", "dead boss is excluded from pointer candidates");
      await setView({...view,bossSpeciesId:id});
    }
  }
  await page.evaluate(() => window.fixture.clearPick());
  await page.mouse.click(point.x, point.y);
  assert.deepEqual(await page.evaluate(() => window.fixture.getPick()), legacyPick, "ornament must not change real canvas picking");
  // Exercise the default legacy body while the performance player owns movement.
  await setView({...view, bossSpeciesId:"legacy_boss"});
  // Confirm the sibling follows its sampled transform in the same rendered frame.
  await page.evaluate(() => { window.setFixturePaused(false); window.setFixturePerformance({events:[{kind:"move",actor:"boss",path:[{x:5,y:5},{x:7,y:5}],duration:1}]}); });
  await page.waitForTimeout(50); await frame();
  const startPosition = await page.evaluate(() => window.__speciesProbe.boss.position.toArray());
  for (let i=0;i<4;i++) {
    await page.waitForTimeout(60); await frame();
    assert.ok(await page.evaluate(() => { const p=window.__speciesProbe; return p.visual.root.position.equals(p.boss.position) && p.visual.root.quaternion.equals(p.boss.quaternion); }), "performance transform must sync in-frame");
  }
  assert.notDeepEqual(await page.evaluate(() => window.__speciesProbe.boss.position.toArray()), startPosition, "performance actually moved the boss");
  await page.evaluate(() => { window.setFixturePaused(true); });
  await page.waitForTimeout(50); await frame();
  const pausedScale = await page.evaluate(() => window.__speciesProbe.visual.root.children[0].scale.x);
  await page.waitForTimeout(80); await frame();
  assert.equal(await page.evaluate(() => window.__speciesProbe.visual.root.children[0].scale.x), pausedScale, "paused pulse must freeze");
  const watched = await page.evaluate(() => {
    const p = window.__speciesProbe, visual = p.visual, resources = new Set();
    visual.root.traverse(node => { if(node.isMesh) { resources.add(node.geometry); resources.add(node.material); } });
    window.__disposeCounts = { count:0, expected:resources.size, old:visual, rig:p.boss };
    for (const resource of resources) resource.addEventListener("dispose", () => window.__disposeCounts.count++);
    return resources.size;
  });
  await setView({...view, bossSpeciesId:"spore_leaper"});
  assert.deepEqual(await page.evaluate(() => ({count:window.__disposeCounts.count, status:window.__disposeCounts.old.status, sameRig:window.__disposeCounts.rig===window.__speciesProbe.boss})), {count:watched,status:"disposed",sameRig:true});
  // A new site destroys the old world and creates a new one from the current view.
  // Reduced motion is sampled when that world is created.
  await page.emulateMedia({ reducedMotion:"reduce" });
  await page.evaluate(() => {
    const p=window.__speciesProbe, resources=new Set();
    p.visual.root.traverse(node => { if(node.isMesh) { resources.add(node.geometry); resources.add(node.material); } });
    window.__oldSite = { probe:p, visual:p.visual, count:0, expected:resources.size };
    for (const resource of resources) resource.addEventListener("dispose", () => window.__oldSite.count++);
    window.setFixtureSite("slope");
    window.setFixturePaused(false);
  });
  await page.waitForFunction(() => window.__speciesProbe !== window.__oldSite.probe);
  await frame(); await page.waitForTimeout(100); await frame();
  const changedSite = await page.evaluate(() => ({count:window.__oldSite.count, expected:window.__oldSite.expected,
    oldStatus:window.__oldSite.visual.status, status:window.__speciesProbe.visual.status,
    name:window.__speciesProbe.visual.root.children[0]?.name, scale:window.__speciesProbe.visual.root.children[0]?.scale.x,
    synced:window.__speciesProbe.visual.root.position.equals(window.__speciesProbe.boss.position)}));
  assert.equal(changedSite.count,changedSite.expected); assert.equal(changedSite.oldStatus,"disposed");
  assert.equal(changedSite.status,"active"); assert.equal(changedSite.name,"monster-species-spore_leaper");
  await page.waitForTimeout(150); await frame();
  assert.equal(await page.evaluate(() => window.__speciesProbe.visual.root.children[0].scale.x), changedSite.scale, "reduced motion freezes scale");
  assert.ok(changedSite.synced);
  const cleanup = await page.evaluate(() => {
    const visual = window.__speciesProbe.visual, resources = new Set();
    visual.root.traverse(node => { if(node.isMesh) { resources.add(node.geometry); resources.add(node.material); } });
    window.__cleanup = { count:0, expected:resources.size, visual };
    for (const resource of resources) resource.addEventListener("dispose", () => window.__cleanup.count++);
    window.fixture.unmount();
    return {count:window.__cleanup.count, expected:window.__cleanup.expected, status:visual.status, parent:visual.root.parent === null, ...window.fixture.lifecycle()};
  });
  assert.equal(cleanup.count,cleanup.expected); assert.equal(cleanup.status,"disposed"); assert.ok(cleanup.parent && !cleanup.frameActive && !cleanup.rootAttached); assert.equal(cleanup.releases,2);
  assert.deepEqual(errors,[]);
  console.log("CityMechaWorld: 10 visible species, legacy geometric silhouette click/hover and death, visibility, unknown fallback, live switching, sibling transforms, playback, reduced motion, site teardown, and disposal passed");
} finally { await browser.close(); }
