#!/usr/bin/env node
// Isolated synthetic site; start the UI Vite server first. No real user data.
// Usage: node tests/city-mecha-mission-marker.browser.mjs http://127.0.0.1:5179
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5179";
const browser = await chromium.launch({ headless: true, args: [process.env.MECHA_BROWSER_ANGLE === "metal" ? "--use-angle=metal" : "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, hasTouch: true });
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error("browser page error:", error.message); });
  await page.route("**/src/game/CityMechaWorld.tsx*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const needle = "    const onDown = (event) => {";
    assert.ok(source.includes(needle), "world instrumentation point changed");
    const probe = `    window.__missionHistory ??= [];
    const counts = { geometry: 0, rimMaterial: 0, badgeMaterial: 0, texture: 0 };
    missionGeo.addEventListener("dispose", () => counts.geometry++);
    missionMat.addEventListener("dispose", () => counts.rimMaterial++);
    missionBadgeMat.addEventListener("dispose", () => counts.badgeMaterial++);
    missionTexture.addEventListener("dispose", () => counts.texture++);
    window.__markers = {
      root, camera, missionRim, missionBadge, threatLines, targetLines, moveLines, overlapReachMarks,
      counts, site, cell(x, y) { return cellWorld(site, { x, y }); },
      board(x, y) { return boardToWorld(site, x * site.cellW, y * site.cellD); },
      project(x, y) {
        const p = cellWorld(site, {x, y});
        const v = new THREE.Vector3(p.x, p.y + 0.65, p.z).project(camera);
        const r = canvas.getBoundingClientRect();
        return { x: r.left + (v.x + 1) * r.width / 2, y: r.top + (1 - v.y) * r.height / 2 };
      }
    };
    window.__missionHistory.push(window.__markers);\n`;
    await route.fulfill({ response, body: source.replace(needle, probe + needle) });
  });
  await page.route("**/__mission-marker-fixture*", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><style>html,body{margin:0} canvas{display:block;width:100vw;height:100vh;touch-action:none}</style><canvas></canvas><div id="root"></div>
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
let frame = null, lastPick = null, releases = 0, restores = 0;
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
 const [view, setFixtureView] = React.useState(initial), [site, setSite] = React.useState(()=>makeSite('flat')), [performance, setPerformance] = React.useState(null);
 window.setFixturePerformance = value => setPerformance(value);
 window.setFixtureView = value => setFixtureView({...initial,...value});
 window.setFixtureSite = kind => setSite(makeSite(kind));
 return React.createElement(CityMechaWorld,{engine,site,view,ref,performance,paused:true,onPerformanceComplete:()=>{},onCell:(x,y,input)=>{lastPick={x,y,input}}});
}
const reactRoot = createRoot(document.getElementById('root'));
reactRoot.render(React.createElement(App));
window.fixture = { ref, originalView, photo, setView,
 resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); },
 render() { frame?.(); scene.updateMatrixWorld(true); renderer.render(scene,camera); return renderer.info.render.calls; },
 rawRender() { scene.updateMatrixWorld(true); renderer.render(scene,camera); },
 pixels() { const gl=renderer.getContext(), data=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4); gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data); return data; },
 getPick:()=>lastPick, clearPick:()=>{lastPick=null},
 lifecycle:() => ({releases, restores, rootAttached:scene.children.includes(window.__markers.root), frameActive:frame !== null}),
 unmount:() => reactRoot.unmount() };
window.fixture.resize();
</script>` }));
  await page.goto(new URL("/__mission-marker-fixture?assaultTrial=1", base).href);
  await page.waitForFunction(() => window.__markers && window.fixture?.ref.current);
  const frame = () => page.evaluate(() => window.fixture.render());
  const setView = async (view) => { await page.evaluate(v => window.setFixtureView(v), view); await page.waitForTimeout(50); await frame(); };
  const isHidden = async () => page.evaluate(() => [window.__markers.missionRim.visible, window.__markers.missionBadge.visible]);
  await frame();
  assert.deepEqual(await isHidden(), [false, false], "absent mission is invisible");
  const initialPixels = await page.evaluate(() => Array.from(window.fixture.pixels()));
  await setView({ missionTarget: null });
  assert.deepEqual(await isHidden(), [false, false], "null mission is invisible");
  assert.deepEqual(await page.evaluate(() => Array.from(window.fixture.pixels())), initialPixels, "null preserves old rendered behavior");
  for (const missionTarget of [{x:-1,y:5}, {x:10,y:5}, {x:4.5,y:5}, {x:5,y:NaN}]) {
    await setView({missionTarget});
    assert.deepEqual(await isHidden(), [false, false], `invalid cell must not invent a target: ${JSON.stringify(missionTarget)}`);
  }
  const target = {x:5,y:5};
  const overlapping = { missionTarget: target, figures:[{id:'Assault', x:5, y:5, alive:true, selected:false}],
    reach:[target], move:target, targets:[target], declaredTelegraph:[target], projectedTelegraph:[target] };
  await setView(overlapping);
  const check = async () => page.evaluate(() => {
    const m = window.__markers, pos = m.cell(5,5), badge = m.board(5.5,5.18);
    window.fixture.render(); const all = window.fixture.pixels();
    const diffWithout = (objects) => {
      for (const object of objects) object.visible = false;
      window.fixture.rawRender(); const without = window.fixture.pixels();
      for (const object of objects) object.visible = true;
      let changed = 0; for (let i=0;i<all.length;i+=4) if (all[i]!==without[i] || all[i+1]!==without[i+1] || all[i+2]!==without[i+2]) changed++;
      return changed;
    };
    const changed = diffWithout([m.missionRim,m.missionBadge]);
    const badgePixels = diffWithout([m.missionBadge]);
    const rimPixels = diffWithout([m.missionRim]);
    const threatPixels = diffWithout([m.threatLines[55]]);
    const targetPixels = diffWithout([m.targetLines[55]]);
    const movePixels = diffWithout([m.moveLines[55]]);
    m.missionRim.visible = m.missionBadge.visible = false;
    window.fixture.rawRender(); const baseline = window.fixture.pixels();
    const baselinePixels = (object) => {
      object.visible = false; window.fixture.rawRender(); const without = window.fixture.pixels(); object.visible = true;
      let changed = 0; for (let i=0;i<baseline.length;i+=4) if (baseline[i]!==without[i] || baseline[i+1]!==without[i+1] || baseline[i+2]!==without[i+2]) changed++;
      return changed;
    };
    const baselineLayers = [m.threatLines[55], m.targetLines[55], m.moveLines[55]].map(baselinePixels);
    m.missionRim.visible = m.missionBadge.visible = true;
    const projectedBadge = m.missionBadge.position.clone().project(m.camera);
    const projectedBase = m.missionBadge.position.clone().set(badge.x,pos.y+.8,badge.z).project(m.camera);
    return { visible:[m.missionRim.visible,m.missionBadge.visible], xyz:m.missionRim.position.toArray(), expected:[pos.x,pos.y+.36,pos.z],
      badgeScreenDelta:[(projectedBadge.x-projectedBase.x)*innerWidth/2,(projectedBadge.y-projectedBase.y)*innerHeight/2], yaw:m.missionRim.rotation.y, siteYaw:m.site.yaw,
      cross:m.missionBadge.material.map.image.getContext('2d').getImageData(48,48,1,1).data[0],
      vertices:m.missionRim.geometry.attributes.position.count, layers:[m.threatLines[55].visible,m.targetLines[55].visible,m.moveLines[55].visible,m.overlapReachMarks.count], changed, badgePixels, rimPixels, threatPixels, targetPixels, movePixels, baselineLayers };
  });
  function verify(snapshot, label) {
    assert.deepEqual(snapshot.visible, [true,true], label);
    for (let i=0;i<3;i++) assert.ok(Math.abs(snapshot.xyz[i]-snapshot.expected[i])<1e-8, label + JSON.stringify(snapshot));
    assert.ok(Math.abs(snapshot.badgeScreenDelta[0])<1e-7 && Math.abs(snapshot.badgeScreenDelta[1]-14)<1e-7, label + JSON.stringify(snapshot));
    assert.equal(snapshot.yaw, snapshot.siteYaw, label);
    assert.equal(snapshot.vertices,48, label);
    assert.equal(snapshot.cross,255, label);
    assert.deepEqual(snapshot.layers,[true,true,true,1], label);
    assert.ok(snapshot.changed > 12 && snapshot.badgePixels > 8, `${label}: marker obscured ${JSON.stringify(snapshot)}`);
    for (const [i, pixels] of [snapshot.threatPixels,snapshot.targetPixels,snapshot.movePixels].entries()) {
      if (snapshot.baselineLayers[i] > 0) assert.ok(pixels > 0, `${label}: marker fully obscured a previously visible layer ${JSON.stringify(snapshot)}`);
    }
  }
  const point = await page.evaluate(() => window.__markers.project(5,5));
  await page.mouse.click(point.x, point.y);
  assert.deepEqual(await page.evaluate(() => window.fixture.getPick()), {x:5,y:5,input:'mouse'}, "mission marker must not intercept cell picking");
  if (process.env.MECHA_MISSION_MARKER_SCREENSHOT) await page.screenshot({path:process.env.MECHA_MISSION_MARKER_SCREENSHOT});
  for (const kind of ['flat','slope','rect']) {
    if (kind !== 'flat') {
      const before = await page.evaluate(() => window.__missionHistory.length);
      await page.evaluate(kind => window.setFixtureSite(kind), kind);
      await page.waitForFunction(n => window.__missionHistory.length > n, before);
    }
    for (let turn=0;turn<4;turn++) {
      await frame(); verify(await check(), `${kind} rotation ${turn}`);
      await page.evaluate(() => window.fixture.ref.current.rotateCamera());
    }
  }
  for (const size of [{width:1100,height:700},{width:640,height:480}]) {
    await page.setViewportSize(size); await page.evaluate(() => window.fixture.resize()); await frame();
    verify(await check(), `${size.width}x${size.height}`);
  }
  await setView({missionTarget:{x:2,y:8}});
  const moved = await page.evaluate(() => { const m=window.__markers, p=m.cell(2,8); return {visible:m.missionRim.visible, actual:m.missionRim.position.toArray(), expected:[p.x,p.y+.36,p.z]}; });
  assert.equal(moved.visible,true); moved.actual.forEach((v,i) => assert.ok(Math.abs(v-moved.expected[i])<1e-8));
  await setView({}); assert.deepEqual(await isHidden(),[false,false], "removed mission hides marker");
  await page.evaluate(() => window.fixture.unmount());
  const lifecycle = await page.evaluate(() => ({history:window.__missionHistory.map(m=>m.counts), state:window.fixture.lifecycle()}));
  assert.equal(lifecycle.history.length, 3);
  for (const counts of lifecycle.history) assert.deepEqual(counts,{geometry:1,rimMaterial:1,badgeMaterial:1,texture:1});
  assert.deepEqual(lifecycle.state, {releases:3, restores:3, rootAttached:false, frameActive:false});
  assert.deepEqual(errors, []);
  console.log('Mission marker: optional/invalid, real pixel overlap, flat/sloped/rotated site, four camera turns, resize, updates and disposal passed.');
  console.log('Scope: synthetic WebGL fixture, not production wiring or accessibility/device acceptance.');
} finally {
  await browser.close();
}
