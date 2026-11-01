#!/usr/bin/env node
// Isolated synthetic site; start the UI Vite server first. No real user data.
// Usage: node tests/city-mecha-threat-layers.browser.mjs http://127.0.0.1:5179
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5179";
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, hasTouch: true });
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error("browser page error:", error.message); });
  await page.route("**/src/game/CityMechaWorld.tsx*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const needle = "    const onDown = (event) => {";
    assert.ok(source.includes(needle), "world instrumentation point changed");
    const probe = `    window.__markers = {
      root, gridPts, gridGeo, perimeter, reachMarks, targetLines, threatLines, threatWarnings, projectedLines, projectedWarnings, projectedWarningMat, combinedWarningMat, threatMat, focusThreatMat, subduedThreatMat, projectedMat, focusedProjectedMat, subduedProjectedMat, moveLines, focusLines, picks, previewFrame, shoveArrow, shoveOutline, unitBadges,
      cell(x, y) { return cellWorld(site, {x, y}); },
      bossFeet(x, y) { return footprintFeet(site, {x, y}); },
      project(x, y) {
        const p = cellWorld(site, {x, y});
        const v = new THREE.Vector3(p.x, p.y + 0.65, p.z).project(camera);
        const r = canvas.getBoundingClientRect();
        return { x: r.left + (v.x + 1) * r.width / 2, y: r.top + (1 - v.y) * r.height / 2 };
      },
      bounds() {
        camera.updateMatrixWorld();
        const r = canvas.getBoundingClientRect(), points = [];
        for (let i = 0; i < gridPts.length; i += 3) {
          const p = new THREE.Vector3(gridPts[i], gridPts[i+1], gridPts[i+2]).project(camera);
          points.push({x: (p.x + 1) * r.width / 2, y: (1 - p.y) * r.height / 2, z: p.z});
        }
        for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
          const p = cellWorld(site, {x, y});
          const v = new THREE.Vector3(p.x, p.y + 0.65, p.z).project(camera);
          points.push({x: (v.x + 1) * r.width / 2, y: (1 - v.y) * r.height / 2, z: v.z});
        }
        return points;
      }
    };\n`;
    const hook = "    lease.setFrameHook(() => {";
    assert.ok(source.includes(hook), "frame instrumentation point changed");
    await route.fulfill({ response, body: source.replace(needle, probe + needle).replace(hook, "    window.__orders = orderMarkers;\n" + hook) });
  });
  await page.route("**/__tactical-markers-fixture", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><style>html,body{margin:0} canvas{display:block;width:100vw;height:100vh;touch-action:none}</style><canvas></canvas><div id="root"></div>
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
   return {attach:items => { attached = items; scene.add(...items); }, setFrameHook:fn => {frame=fn},
    setOrbitView:view => setView({position:view.position.toArray(),target:view.target.toArray(),fov:view.fov}),
    release:() => { releases++; frame=null; scene.remove(...attached); }};
 } };
const makeSite = (kind) => ({originX:13,originZ:-21,yaw:kind==='rect' ? -0.71 : 0.35,
 cellW:kind==='rect' ? 12 : 16,cellD:kind==='rect' ? 19 : 16,
 heights:Array.from({length:10},(_,y)=>Array.from({length:10},(_,x)=>kind==='slope' ? 0.3*x+0.2*y : 0)),
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
  await page.goto(new URL("/__tactical-markers-fixture", base).href);
  await page.waitForFunction(() => window.__markers && window.fixture?.ref.current);
  const view = { declaredTelegraph:[{x:2,y:3}, {x:5,y:5}], projectedTelegraph:[{x:5,y:5}, {x:7,y:6}],
    telegraph:[{x:1,y:1}], focusedTelegraph:[{x:2,y:3}], hoveredEnemy:"boss",
    reach:[{x:5,y:5}], targets:[{x:5,y:5}], focus:[{x:5,y:5}], move:{x:5,y:5},
    enemyOrder:[{actor:"boss",cells:[{x:8,y:8}]}, {actor:"raider-w",cells:[{x:4,y:4}]}] };
  await page.evaluate(v => window.setFixtureView(v), view);
  await page.waitForFunction(() => { window.fixture.render(); return window.__markers.projectedLines[55].visible; });
  const layers = await page.evaluate(() => {
    const m = window.__markers;
    const cell = i => ({declared:m.threatLines[i].visible, projected:m.projectedLines[i].visible,
      triangle:m.threatWarnings[i].visible, badge:m.projectedWarnings[i].visible,
      material:m.projectedWarnings[i].material === m.combinedWarningMat ? 'combined' : 'projected'});
    window.fixture.render();
    const all = window.fixture.pixels();
    m.projectedLines[55].material.visible = false;
    m.projectedWarnings[55].material.visible = false;
    window.fixture.rawRender();
    const noProjection = window.fixture.pixels();
    m.projectedLines[55].material.visible = true;
    m.projectedWarnings[55].material.visible = true;
    let pixels = 0;
    for (let i=0; i<all.length; i+=4) if (all[i]!==noProjection[i] || all[i+1]!==noProjection[i+1] || all[i+2]!==noProjection[i+2]) pixels++;
    return {declaredOnly:cell(32), overlap:cell(55), projectedOnly:cell(67), compatibilityOnly:cell(11),
      target:m.targetLines[55].visible, reach:m.reachMarks.count, focus:m.focusLines[55].visible, move:m.moveLines[55].visible,
      declarationGeo:m.threatLines[55].geometry.attributes.position.count, projectionGeo:m.projectedLines[55].geometry.attributes.position.count,
      orderCount:window.__orders.length, projectionPixels:pixels, picks:m.picks.length};
  });
  assert.deepEqual(layers.declaredOnly, {declared:true,projected:false,triangle:true,badge:false,material:'projected'});
  assert.deepEqual(layers.overlap, {declared:true,projected:true,triangle:false,badge:true,material:'combined'});
  assert.deepEqual(layers.projectedOnly, {declared:false,projected:true,triangle:false,badge:true,material:'projected'});
  assert.equal(layers.compatibilityOnly.declared, false, 'explicit declarations must override legacy telegraph');
  assert.deepEqual([layers.target,layers.reach,layers.focus,layers.move], [true,1,true,true]);
  assert.notEqual(layers.declarationGeo, layers.projectionGeo);
  assert.equal(layers.orderCount, 0, 'impact cells are not attack-time positions');
  assert.equal(layers.picks, 100);
  assert.ok(layers.projectionPixels > 5, JSON.stringify(layers));
  console.log('640×480 separate and combined layers:', layers);
  if (process.env.MECHA_THREATS_SCREENSHOT) { await page.evaluate(() => window.fixture.render()); await page.screenshot({path:process.env.MECHA_THREATS_SCREENSHOT}); }

  // The same square may belong to different enemies in the two layers.
  // Focus from a successful prediction must never recolor the declaration.
  await page.evaluate(v => window.setFixtureView(v), {...view, focusedTelegraph:[{x:5,y:5}]});
  await page.waitForFunction(() => {window.fixture.render(); return window.__markers.projectedLines[55].material === window.__markers.focusedProjectedMat;});
  assert.deepEqual(await page.evaluate(() => {
    const m=window.__markers;
    return [m.threatLines[55].material === m.threatMat, m.projectedLines[55].material === m.focusedProjectedMat,
      m.threatLines[32].material === m.threatMat, m.projectedLines[67].material === m.subduedProjectedMat];
  }), [true,true,true,true]);
  await page.evaluate(v => window.setFixtureView(v), {...view, projectedTelegraph:null, focusedTelegraph:[{x:2,y:3}]});
  await page.waitForFunction(() => {window.fixture.render(); return window.__markers.threatLines[32].material === window.__markers.focusThreatMat;});
  assert.equal(await page.evaluate(() => window.__markers.threatLines[55].material === window.__markers.subduedThreatMat), true);
  await page.evaluate(v => window.setFixtureView(v), view);
  await page.waitForFunction(() => {window.fixture.render(); return window.__markers.projectedLines[55].visible;});

  const point = await page.evaluate(() => window.__markers.project(5,5));
  await page.mouse.click(point.x, point.y);
  assert.deepEqual(await page.evaluate(() => window.fixture.getPick()), {x:5,y:5,input:'mouse'});
  // Unknown and successful-empty both omit projection geometry; their distinct
  // source values remain the HUD's responsibility. Declarations are retained.
  for (const projectedTelegraph of [null, []]) {
    await page.evaluate(v => window.setFixtureView(v), {...view, projectedTelegraph});
    await page.waitForFunction(() => { window.fixture.render(); return !window.__markers.projectedLines[55].visible; });
    const state = await page.evaluate(() => ({declaration:window.__markers.threatLines[55].visible, badge:window.__markers.threatWarnings[55].visible, projected:window.__markers.projectedWarnings[55].visible}));
    assert.deepEqual(state, {declaration:true,badge:true,projected:false});
  }
  const events = [{actor:'boss',cells:[{x:9,y:9}]}, {actor:'raider-w',cells:[],position:{x:3,y:4}},
    {actor:'boss',cells:[],position:{x:3,y:4}}, {actor:'bad',cells:[],position:{x:10,y:0}}, {actor:'bad',cells:[],position:{x:1.5,y:1}}];
  await page.evaluate(v => window.setFixtureView(v), {...view,enemyOrder:events});
  await page.waitForFunction(() => {window.fixture.render(); return window.__orders.length === 2;});
  const orders = await page.evaluate(() => window.__orders.map(m => ({actor:m.actor,slot:m.slot,slots:m.slots,origin:m.origin.toArray(),expected:window.__markers.cell(3,4)})));
  assert.deepEqual(orders.map(o => [o.actor,o.slot,o.slots]), [['raider-w',0,2],['boss',1,2]]);
  for (const o of orders) { assert.equal(o.origin[0],o.expected.x); assert.equal(o.origin[2],o.expected.z); }
  await page.evaluate(v => window.setFixtureView(v), {...view, projectedTelegraph:null, enemyOrder:events});
  await page.waitForFunction(() => {window.fixture.render(); return window.__orders.length === 0;});
  assert.equal(await page.evaluate(() => window.__markers.threatLines[55].visible), true);
  await page.evaluate(v => window.setFixtureView(v), {...view, enemyOrder:events});
  await page.waitForFunction(() => {window.fixture.render(); return window.__orders.length === 2;});
  await page.evaluate(() => window.setFixturePerformance({events:[]}));
  await page.waitForFunction(() => {window.fixture.render(); return !window.__markers.threatLines[55].visible && !window.__markers.projectedLines[55].visible && window.__orders.length===0;});
  assert.deepEqual(await page.evaluate(() => [window.__markers.threatWarnings[55].visible, window.__markers.projectedWarnings[55].visible]), [false,false]);
  await page.evaluate(() => window.setFixturePerformance(null));
  await page.waitForFunction(() => {window.fixture.render(); return window.__markers.threatLines[55].visible && window.__markers.projectedLines[55].visible && window.__orders.length===2;});
  // Dense overlap retains both ground patterns, but reserves badges for
  // occupied/obscured squares so the board is not buried under icons.
  const dense = Array.from({length:100}, (_, i) => ({x:i % 10, y:Math.floor(i / 10)}));
  await page.evaluate(cells => window.setFixtureView({declaredTelegraph:cells, projectedTelegraph:cells,
    figures:[{id:'Support',x:5,y:5,alive:true,selected:false}]}), dense);
  await page.waitForFunction(() => {window.fixture.render(); return window.__markers.projectedLines.filter(m => m.visible).length === 100;});
  assert.deepEqual(await page.evaluate(() => [window.__markers.threatLines.filter(m => m.visible).length,
    window.__markers.threatWarnings.filter(m => m.visible).length,
    window.__markers.projectedWarnings.filter(m => m.visible && m.material === window.__markers.combinedWarningMat).length,
    window.__markers.picks.length]), [100,0,1,100]);
  if (process.env.MECHA_THREATS_DENSE_SCREENSHOT) await page.screenshot({path:process.env.MECHA_THREATS_DENSE_SCREENSHOT});
  const materials = await page.evaluate(() => {
    const m=window.__markers; window.__threatDisposed=[];
    for (const [name, object] of [['projectedGeo',m.projectedLines[0].geometry], ['projectedMaterial',m.projectedMat],
      ['combinedTexture',m.combinedWarningMat.map], ['projectedTexture',m.projectedWarningMat.map]]) {
      object.addEventListener('dispose', () => window.__threatDisposed.push(name));
    }
    window.fixture.unmount();
    return window.__threatDisposed;
  });
  assert.deepEqual(materials.sort(), ['combinedTexture','projectedGeo','projectedMaterial','projectedTexture']);
  console.log('verified-position ordering, performance suppression and threat cleanup: passed');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
