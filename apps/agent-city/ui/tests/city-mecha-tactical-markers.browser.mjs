#!/usr/bin/env node
// Isolated synthetic site; start the UI Vite server first. No real user data.
// Usage: node tests/city-mecha-tactical-markers.browser.mjs http://127.0.0.1:5179
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
      root, gridPts, gridGeo, perimeter, reachMarks, targetLines, threatLines, threatWarnings, projectedLines, moveLines, focusLines, picks, previewFrame, engine, lease, shoveArrow, shoveOutline, unitBadges, figures,
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
    await route.fulfill({ response, body: source.replace(needle, probe + needle) });
  });
  await page.route("**/__tactical-markers-fixture*", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><style>html,body{margin:0} canvas{display:block;width:100vw;height:100vh;touch-action:none}</style><canvas></canvas><div id="root"></div>
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
 captureMechaGroundSource:() => null, // Optional in the target branch's WIP engine.
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
const initial = {figures:[],boss:{x:0,y:0,alive:false},raiders:[],buildings:[],telegraph:[],focusedTelegraph:[],focus:[],reach:[],move:null,targets:[],targetIds:[]};
const ref = React.createRef();
function App() {
 const [view, setFixtureView] = React.useState(initial), [site, setSite] = React.useState(()=>makeSite('flat')), [performance, setPerformance] = React.useState(null);
 window.setFixtureView = value => setFixtureView({...initial,...value});
 window.setFixtureSite = kind => setSite(makeSite(kind));
 window.setFixturePerformance = setPerformance;
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
  // Disable the target branch’s optional connected Assault preview: this mock engine has no city ground.
  await page.goto(new URL("/__tactical-markers-fixture?assaultTrial=1", base).href);
  await page.waitForFunction(() => window.__markers && window.fixture?.ref.current);
  const cells = Array.from({ length: 100 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10) }));
  await page.evaluate((cells) => window.setFixtureView({ reach: cells, targets: [{x:5,y:5}], telegraph: [{x:5,y:5}], focus:[{x:5,y:5}], move:{x:5,y:5} }), cells);
  await page.waitForFunction(() => { window.fixture.render(); return window.__markers.reachMarks.count === 100; });
  const proof = await page.evaluate(() => {
    const { reachMarks, targetLines, threatLines, threatWarnings, moveLines, focusLines } = window.__markers;
    const index = 55;
    const allCalls = window.fixture.render();
    const all = window.fixture.pixels();
    reachMarks.visible = false;
    const noReachCalls = window.fixture.render();
    const noReach = window.fixture.pixels();
    reachMarks.visible = true;
    targetLines[index].visible = false;
    // Render without running the hook, which would restore visibility.
    const noTarget = (() => { const mesh = targetLines[index]; mesh.material.visible = false; window.fixture.render(); const pixels = window.fixture.pixels(); mesh.material.visible = true; return pixels; })();
    const diff = (a,b) => { let n=0; for (let i=0;i<a.length;i+=4) if (a[i]!==b[i] || a[i+1]!==b[i+1] || a[i+2]!==b[i+2]) n++; return n; };
    return { count:reachMarks.count, max:reachMarks.instanceMatrix.count, instanced:reachMarks.isInstancedMesh,
      reachVertices:reachMarks.geometry.attributes.position.count, targetVertices:targetLines[index].geometry.attributes.position.count,
      target:targetLines[index].visible, threat:threatLines[index].visible, warning:threatWarnings[index].visible, move:moveLines[index].visible, focus:focusLines[index].visible,
      allCalls, noReachCalls, reachPixels:diff(all,noReach), targetPixels:diff(all,noTarget) };
  });
  assert.deepEqual([proof.instanced, proof.count, proof.max], [true, 100, 100]);
  assert.deepEqual([proof.target, proof.threat, proof.warning, proof.move, proof.focus], [true,true,true,true,true]);
  assert.equal(proof.reachVertices, 12);
  assert.equal(proof.targetVertices, 48);
  assert.equal(proof.allCalls - proof.noReachCalls, 1, JSON.stringify(proof));
  assert.ok(proof.reachPixels > 5 && proof.targetPixels > 0, JSON.stringify(proof));
  console.log("640x480 synthetic overlapping layers / direct WebGL draw calls:", proof);
  if (process.env.MECHA_MARKERS_SCREENSHOT) {
    await page.evaluate(() => window.fixture.render());
    await page.screenshot({ path: process.env.MECHA_MARKERS_SCREENSHOT });
  }
  // Exercise a user-adjusted low orbit as well as the fitted view. This is an
  // isolated fixture, not a reconstruction of any particular desktop camera.
  await page.evaluate(() => {
    const view = window.fixture.photo();
    const [x,y,z] = view.target, [px,,pz] = view.position;
    const horizontal = Math.hypot(px-x,pz-z);
    window.fixture.setView({ ...view, position:[px,y+horizontal*.5,pz] });
  });
  await page.evaluate(() => window.setFixtureView({ reach:[{x:5,y:5}], move:{x:5,y:5},
    declaredTelegraph:[{x:5,y:5}], projectedTelegraph:[{x:5,y:5}] }));
  await page.waitForFunction(() => { window.fixture.render(); return window.__markers.moveLines[55].visible; });
  for (let turn=0; turn<4; turn++) {
    const marker = await page.evaluate(() => {
      const mesh = window.__markers.moveLines[55];
      window.fixture.render(); const all = window.fixture.pixels();
      mesh.visible = false; window.fixture.rawRender(); const without = window.fixture.pixels();
      let pixels=0; for(let i=0;i<all.length;i+=4) if(all[i]!==without[i] || all[i+1]!==without[i+1] || all[i+2]!==without[i+2]) pixels++;
      mesh.visible = true;
      const projected = window.__markers.projectedLines[55], declaration = window.__markers.threatLines[55];
      projected.visible = false; window.fixture.rawRender(); const withoutProjection = window.fixture.pixels();
      projected.visible = true; declaration.visible = false; window.fixture.rawRender(); const withoutDeclaration = window.fixture.pixels();
      declaration.visible = true;
      const changed = (other) => { let count=0; for(let i=0;i<all.length;i+=4) if(all[i]!==other[i] || all[i+1]!==other[i+1] || all[i+2]!==other[i+2]) count++; return count; };
      return { pixels, projectionPixels:changed(withoutProjection), declarationPixels:changed(withoutDeclaration),
        vertices:mesh.geometry.attributes.position.count, mesh:mesh.isMesh, declaration:declaration.visible, projection:projected.visible };
    });
    assert.deepEqual([marker.mesh, marker.vertices, marker.declaration, marker.projection], [true,24,true,true]);
    assert.ok(marker.pixels > 5 && marker.projectionPixels > 5 && marker.declarationPixels > 5,
      `low orbit turn ${turn}: ${JSON.stringify(marker)}`);
    const point = await page.evaluate(() => window.__markers.project(5,5));
    await page.evaluate(() => window.fixture.clearPick());
    await page.mouse.click(point.x, point.y);
    assert.deepEqual(await page.evaluate(() => window.fixture.getPick()), {x:5,y:5,input:"mouse"});
    if (turn === 0 && process.env.MECHA_LOW_ORBIT_SCREENSHOT) {
      await page.evaluate(() => window.fixture.render());
      await page.screenshot({path:process.env.MECHA_LOW_ORBIT_SCREENSHOT});
    }
    console.log(`low orbit turn ${turn}: move ${marker.pixels}, projected ${marker.projectionPixels}, declared ${marker.declarationPixels} pixels`);
    await page.evaluate(() => { window.fixture.ref.current.rotateCamera(); window.fixture.render(); });
  }
  await page.evaluate(() => { window.fixture.ref.current.resetCamera(); window.fixture.render(); });
  // MoveTo is also the planned figure position in the HUD. Measure the
  // ground diamond with the actual mesh over it, not just on an empty tile.
  const occupiedMove = { figures:[{id:"Assault",x:5,y:5,alive:true,selected:true,hp:14}], move:{x:5,y:5}, declaredTelegraph:[{x:5,y:5}], projectedTelegraph:[{x:5,y:5}] };
  await page.evaluate(view => window.setFixtureView(view), occupiedMove);
  await page.waitForFunction(() => {window.fixture.render(); return window.__markers.unitBadges[0].sprite.visible;});
  await page.evaluate(() => {const m=window.__markers, p=m.cell(5,5); m.figures.Assault.position.set(p.x,p.y,p.z); window.fixture.render();});
  const occupiedPixels = await page.evaluate(() => {
    const m=window.__markers; window.fixture.render(); const all=window.fixture.pixels();
    m.moveLines[55].material.visible=false; window.fixture.rawRender(); const absent=window.fixture.pixels(); m.moveLines[55].material.visible=true;
    let n=0; for(let i=0;i<all.length;i+=4) if(all[i]!==absent[i] || all[i+1]!==absent[i+1] || all[i+2]!==absent[i+2]) n++;
    return n;
  });
  console.log("occupied destination ground pixels at fitted view:", occupiedPixels);
  // With identical model/camera and the ground material hidden, changing
  // only move exercises the actual on-screen badge, not just its canvas data.
  for (const [width,height,angle] of [[640,480,"fitted"],[640,480,"low"],[390,844,"fitted"]]) {
    await page.setViewportSize({width,height});
    await page.evaluate(() => {window.fixture.resize(); window.fixture.ref.current.resetCamera(); window.fixture.render();});
    if (angle === "low") await page.evaluate(() => {
      const view=window.fixture.photo(), [x,y,z]=view.target, [px,,pz]=view.position;
      const horizontal=Math.hypot(px-x,pz-z);
      window.fixture.setView({...view,position:[px,y+horizontal*.45,pz]});
    });
    const plannedPixelProof = [];
    for (let turn=0; turn<4; turn++) {
      await page.evaluate(view => window.setFixtureView(view), occupiedMove);
      await page.waitForFunction(() => {window.fixture.render(); return window.__markers.unitBadges[0].signature === "false:14:true:true";});
      await page.evaluate(() => {window.__markers.moveLines[55].material.visible=false; window.fixture.render(); window.__withMove=window.fixture.pixels();});
      if (turn===0 && angle==="low" && process.env.MECHA_OCCUPIED_SCREENSHOT) {
        await page.evaluate(() => {window.__markers.moveLines[55].material.visible=true; window.fixture.render();});
        await page.screenshot({path:process.env.MECHA_OCCUPIED_SCREENSHOT});
        await page.evaluate(() => {window.__markers.moveLines[55].material.visible=false;});
      }
      await page.evaluate(view => window.setFixtureView({...view,move:null}), occupiedMove);
      await page.waitForFunction(() => {window.fixture.render(); return window.__markers.unitBadges[0].signature === "false:14:true:false";});
      const changed = await page.evaluate(() => {window.fixture.render(); const before=window.__withMove, after=window.fixture.pixels(); let n=0; for(let i=0;i<before.length;i+=4) if(before[i]!==after[i] || before[i+1]!==after[i+1] || before[i+2]!==after[i+2]) n++; return n;});
      assert.ok(changed>10, `${width}x${height} ${angle} occupied move badge turn ${turn}: ${changed} pixels`);
      plannedPixelProof.push(changed);
      await page.evaluate(() => {window.__markers.moveLines[55].material.visible=true; window.fixture.ref.current.rotateCamera(); window.fixture.render();});
    }
    console.log(`${width}x${height} ${angle} occupied destination badge pixels across four turns:`, plannedPixelProof);
    await page.evaluate(() => {window.fixture.ref.current.resetCamera(); window.fixture.render();});
  }
  await page.setViewportSize({width:640,height:480});
  await page.evaluate(() => {window.fixture.resize(); window.fixture.ref.current.resetCamera(); window.fixture.render();});
  // A sliding model has not visually reached the destination; do not attach
  // the destination label to its transient position.
  await page.evaluate(view => window.setFixtureView(view), occupiedMove);
  await page.waitForFunction(() => {window.fixture.render(); return window.__markers.unitBadges[0].signature === "false:14:true:true";});
  await page.evaluate(() => {window.__markers.figures.Assault.position.x += 8; window.fixture.render();});
  assert.equal(await page.evaluate(() => window.__markers.unitBadges[0].signature), "false:14:true:false");
  await page.evaluate(() => {const m=window.__markers, p=m.cell(5,5); m.figures.Assault.position.set(p.x,p.y,p.z); window.fixture.render();});
  assert.equal(await page.evaluate(() => window.__markers.unitBadges[0].signature), "false:14:true:true");
  // Defensive hiding even if a caller still has a stale draft during playback.
  await page.evaluate(view => {window.setFixtureView(view); window.setFixturePerformance({events:[]});},occupiedMove);
  await page.waitForFunction(() => {window.fixture.render(); return !window.__markers.unitBadges[0].sprite.visible && !window.__markers.moveLines[55].visible;});
  await page.evaluate(() => window.setFixturePerformance(null));
  for (const view of [
    {...occupiedMove,move:{x:4,y:5}},
    {...occupiedMove,figures:[{...occupiedMove.figures[0],selected:false}]},
    {...occupiedMove,figures:[{...occupiedMove.figures[0],alive:false}]},
  ]) {
    await page.evaluate(view => window.setFixtureView(view),view);
    await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const badge=await page.evaluate(() => {window.fixture.render(); const b=window.__markers.unitBadges[0]; return {visible:b.sprite.visible,signature:b.signature};});
    if (view.figures[0].alive) assert.ok(badge.signature.endsWith(":false"), JSON.stringify(badge));
    else assert.equal(badge.visible,false);
  }
  await page.evaluate(() => {window.fixture.ref.current.resetCamera(); window.fixture.render();});
  // Selection is presentation-only: the same HP and faction persist, and
  // swapping selected mechs refreshes both badges without changing positions.
  const twoUnits = [{id:"Assault",x:2,y:2,alive:true,selected:true,hp:14},{id:"Support",x:7,y:7,alive:true,selected:false,hp:9}];
  await page.evaluate(figures => window.setFixtureView({figures}), twoUnits);
  await page.waitForFunction(() => { window.fixture.render(); return window.__markers.unitBadges[0].signature === "false:14:true:false"; });
  const badgeBefore = await page.evaluate(() => window.__markers.unitBadges[0].canvas.getContext("2d").getImageData(10,7,1,1).data.join(","));
  await page.evaluate(figures => window.setFixtureView({figures:figures.map(unit => ({...unit, selected:!unit.selected}))}), twoUnits);
  await page.waitForFunction(() => { window.fixture.render(); return window.__markers.unitBadges[2].signature === "false:9:true:false"; });
  const badgeAfter = await page.evaluate(() => ({signature:window.__markers.unitBadges[0].signature,
    border:window.__markers.unitBadges[0].canvas.getContext("2d").getImageData(10,7,1,1).data.join(",")}));
  assert.equal(badgeAfter.signature, "false:14:false:false");
  assert.notEqual(badgeBefore, badgeAfter.border, "selection changes the actual rendered badge border");

  // The chosen 2×2 boss is distinct from the four legal target cells. The
  // producer alone supplies verified endpoints; no result is inferred here.
  const bossView = { boss:{x:4,y:3,alive:true,hp:37}, figures:[{id:"Support",x:2,y:2,alive:true,selected:false,hp:9}],
    raiders:[{id:"raider-w",x:7,y:5,alive:true,hp:6}], targets:[{x:4,y:3},{x:5,y:3},{x:4,y:4},{x:5,y:4}],
    targetIds:["boss","raider-w","Support"], telegraph:[{x:4,y:3}], reach:[{x:4,y:3}],
    targetPreview:{target:{x:4,y:3},shove:{from:{x:4,y:3},to:{x:5,y:3}}} };
  await page.evaluate((view) => window.setFixtureView(view), bossView);
  await page.waitForFunction(() => { window.fixture.render(); return window.__markers.previewFrame.visible && window.__markers.shoveArrow.visible; });
  const selected = await page.evaluate(() => {
    const m=window.__markers, frame=m.previewFrame, arrow=m.shoveArrow, from=m.bossFeet(4,3), to=m.bossFeet(5,3);
    const allCalls=window.fixture.render(), all=window.fixture.pixels();
    frame.material.visible=false; arrow.material.visible=false; m.shoveOutline.material.visible=false;
    const withoutCalls=window.fixture.render(), without=window.fixture.pixels();
    frame.material.visible=true; arrow.material.visible=true; m.shoveOutline.material.visible=true;
    let pixels=0; for(let i=0;i<all.length;i+=4) if(all[i]!==without[i] || all[i+1]!==without[i+1] || all[i+2]!==without[i+2]) pixels++;
    return {frameScale:frame.scale.toArray(), frameAt:frame.position.toArray(), from:from.toArray(), to:to.toArray(), arrowAt:arrow.position.toArray(),
      arrowDirection:[Math.cos(arrow.rotation.y)*arrow.scale.x,-Math.sin(arrow.rotation.y)*arrow.scale.x],
      calls:allCalls-withoutCalls,pixels,badges:m.unitBadges.map(b=>({visible:b.sprite.visible,signature:b.signature}))};
  });
  assert.deepEqual(selected.frameScale,[2,1,2]);
  for(const axis of [0,2]) { assert.ok(Math.abs(selected.frameAt[axis]-selected.from[axis])<1e-5); assert.ok(Math.abs(selected.arrowAt[axis]-selected.from[axis])<1e-5); }
  assert.ok(Math.abs(selected.arrowDirection[0]-(selected.to[0]-selected.from[0]))<1e-5);
  assert.ok(Math.abs(selected.arrowDirection[1]-(selected.to[2]-selected.from[2]))<1e-5);
  assert.equal(selected.calls,3); assert.ok(selected.pixels>5,JSON.stringify(selected));
  assert.deepEqual(selected.badges.map(b=>b.visible),[false,false,true,true,true,false]);
  assert.equal(selected.badges[2].signature,"false:9:false:false"); assert.equal(selected.badges[3].signature,"true:37:false:false"); assert.equal(selected.badges[4].signature,"true:6:false:false");
  console.log("boss footprint / true shove / current HP badges:",selected);
  if (process.env.MECHA_PREVIEW_SCREENSHOT) {
    await page.evaluate(() => window.fixture.render());
    await page.screenshot({path:process.env.MECHA_PREVIEW_SCREENSHOT});
  }
  // The renderer accepts distinct anchors without conflating their positions.
  // This fixture is not a HUD contract: the HUD deliberately withholds arrows
  // when earlier actions moved the target; integration must verify that guard.
  await page.evaluate(async view => {
    window.setFixtureView({...view,targetPreview:{target:{x:4,y:3},shove:{from:{x:2,y:3},to:{x:3,y:3}}}});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  },bossView);
  const shifted = await page.evaluate(() => {window.fixture.render(); const m=window.__markers; return {frame:m.previewFrame.position.toArray(),arrow:m.shoveArrow.position.toArray(),current:m.bossFeet(4,3).toArray(),from:m.bossFeet(2,3).toArray()};});
  for (const axis of [0,2]) { assert.ok(Math.abs(shifted.frame[axis]-shifted.current[axis])<1e-5); assert.ok(Math.abs(shifted.arrow[axis]-shifted.from[axis])<1e-5); }
  assert.notDeepEqual(shifted.current,shifted.from);
  for (const shove of [undefined, {from:{x:4,y:3},to:{x:4,y:3}}, {from:{x:4,y:3},to:{x:9,y:3}}]) {
    await page.evaluate(async ({view,shove}) => { window.setFixtureView({...view,targetPreview:{target:{x:4,y:3},shove}}); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); },{view:bossView,shove});
    await page.waitForFunction(() => {window.fixture.render(); return window.__markers.previewFrame.visible && !window.__markers.shoveArrow.visible && !window.__markers.shoveOutline.visible;});
  }
  // Raider is single-cell, unknown shove remains absent; switching to a friendly
  // also changes the footprint rather than accidentally reusing the boss frame.
  for (const target of [{x:7,y:5},{x:2,y:2}]) {
    await page.evaluate(async ({view,target})=>{ window.setFixtureView({...view,targetPreview:{target}}); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); },{view:bossView,target});
    await page.waitForFunction(() => {window.fixture.render(); return window.__markers.previewFrame.visible && window.__markers.previewFrame.scale.x===1 && !window.__markers.shoveArrow.visible;});
    const at=await page.evaluate(({x,y})=>({ actual:window.__markers.previewFrame.position.toArray(), expected:window.__markers.cell(x,y) }),target);
    assert.ok(Math.abs(at.actual[0]-at.expected.x)<1e-5 && Math.abs(at.actual[2]-at.expected.z)<1e-5);
  }
  await page.evaluate((view)=>window.setFixtureView({...view,targetPreview:{target:{x:0,y:0},shove:{from:{x:0,y:0},to:{x:1,y:0}}}}),bossView);
  await page.waitForFunction(()=>{window.fixture.render(); return !window.__markers.previewFrame.visible && !window.__markers.shoveArrow.visible;});
  await page.evaluate((view)=>window.setFixtureView({...view,targetPreview:undefined,figures:[],raiders:[],boss:{x:4,y:3,alive:false}}),bossView);
  await page.waitForFunction(()=>{window.fixture.render(); return !window.__markers.previewFrame.visible && !window.__markers.shoveArrow.visible && window.__markers.unitBadges.every(b=>!b.sprite.visible);});
  // Projection coverage uses both grid vertices and pick-box tops, including
  // non-square and sloped sites. HUD/buildings are absent from this fixture.
  for (const kind of ["flat", "rect", "slope"]) {
    const oldRoot = await page.evaluate(() => window.__markers.root.uuid);
    await page.evaluate(kind => window.setFixtureSite(kind), kind);
    await page.waitForFunction(id => window.__markers.root.uuid !== id && window.fixture.ref.current, oldRoot);
    for (const [width,height] of [[640,480],[390,844],[1100,700]]) {
      await page.setViewportSize({width,height});
      await page.evaluate(() => { window.fixture.resize(); window.fixture.ref.current.resetCamera(); window.fixture.render(); });
      for (let rotation=0; rotation<4; rotation++) {
        const bounds = await page.evaluate(() => window.__markers.bounds());
        assert.equal(bounds.length, 540); // 440 grid vertices + 100 pick tops
        assert.ok(bounds.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.z > -1 && p.z < 1 && p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height), `${kind} ${width}x${height} rotation ${rotation}: clipped grid or pick top`);
        // All 100 center rays travel through the same DOM pointer handlers;
        // the three native Playwright gestures below also cover real input.
        const misses = await page.evaluate(() => {
          const canvas=document.querySelector("canvas"), misses=[];
          for(let y=0;y<10;y++) for(let x=0;x<10;x++) {
            const p=window.__markers.project(x,y); window.fixture.clearPick();
            for(const type of ["pointerdown","pointerup"]) canvas.dispatchEvent(new PointerEvent(type,{clientX:p.x,clientY:p.y,button:0,pointerType:"mouse",bubbles:true}));
            const hit=window.fixture.getPick(); if(!hit || hit.x!==x || hit.y!==y) misses.push({x,y,hit});
          }
          return misses;
        });
        assert.deepEqual(misses, [], `${kind} ${width}x${height} rotation ${rotation}: center rays`);
        for (const [x,y,input] of [[0,0,"mouse"],[5,5,"touch"],[9,9,"mouse"]]) {
          const point = await page.evaluate(({x,y}) => window.__markers.project(x,y), {x,y});
          await page.evaluate(() => window.fixture.clearPick());
          if (input === "touch") await page.touchscreen.tap(point.x, point.y);
          else await page.mouse.click(point.x, point.y);
          assert.deepEqual(await page.evaluate(() => window.fixture.getPick()), {x,y,input}, `${kind} ${width}x${height} rotation ${rotation} ${input}`);
        }
        await page.evaluate(() => { window.fixture.ref.current.rotateCamera(); window.fixture.render(); });
      }
      console.log(`${kind} ${width}x${height}: grid, 100 center rays and native mouse/touch across four turns`);
    }
  }
  // Rotation preserves a user-adjusted shared view rather than resetting zoom,
  // target or FOV. Only its horizontal offset is quarter-turned.
  const manual = {position:[130,210,-90], target:[7,8,9], fov:47};
  await page.evaluate(view => { window.fixture.setView(view); window.fixture.ref.current.rotateCamera(); }, manual);
  const rotated = await page.evaluate(() => window.fixture.photo());
  assert.deepEqual(rotated.target, manual.target);
  assert.equal(rotated.fov, manual.fov);
  const beforeOffset = manual.position.map((p,i)=>p-manual.target[i]);
  const afterOffset = rotated.position.map((p,i)=>p-rotated.target[i]);
  assert.ok(Math.abs(afterOffset[0]-beforeOffset[2])<1e-7 && Math.abs(afterOffset[1]-beforeOffset[1])<1e-7 && Math.abs(afterOffset[2]+beforeOffset[0])<1e-7);
  await page.evaluate(() => window.setFixtureView({ reach:[{x:1,y:2}], targets:[], telegraph:[], move:null }));
  await page.waitForFunction(() => { window.fixture.render(); return window.__markers.reachMarks.count === 1 && !window.__markers.targetLines[55].visible && !window.__markers.threatLines[55].visible && !window.__markers.moveLines[55].visible; });
  await page.evaluate(() => window.setFixtureView({}));
  await page.waitForFunction(() => { window.fixture.render(); return window.__markers.reachMarks.count === 0; });
  // Verify teardown on the last lease, without assuming that site remounts
  // earlier in this test had no releases of their own.
  const beforeUnmount = await page.evaluate(() => {
    const m=window.__markers; window.__disposed=[];
    for (const [name,resource] of [["grid",m.gridGeo],["reach",m.reachMarks.geometry],["move",m.moveLines[0].geometry],["moveMaterial",m.moveLines[0].material],["badgeTexture",m.unitBadges[0].texture]])
      resource.addEventListener("dispose",()=>window.__disposed.push(name));
    return window.fixture.lifecycle();
  });
  await page.evaluate(() => window.fixture.unmount());
  const teardown = await page.evaluate(() => ({...window.fixture.lifecycle(), view:window.fixture.photo(), original:window.fixture.originalView, disposed:window.__disposed.sort()}));
  assert.equal(teardown.releases, beforeUnmount.releases+1);
  assert.equal(teardown.restores, beforeUnmount.restores+1);
  assert.equal(teardown.rootAttached, false); assert.equal(teardown.frameActive, false);
  assert.deepEqual(teardown.view, teardown.original);
  assert.deepEqual(teardown.disposed, ["badgeTexture","grid","move","moveMaterial","reach"]);
  await page.evaluate(() => window.fixture.clearPick());
  await page.mouse.click(100,100);
  assert.equal(await page.evaluate(() => window.fixture.getPick()), null, "picking listeners removed on unmount");
  console.log("lease release, resource disposal and shared-camera restoration:", teardown);
  if (process.env.MECHA_REAL_CITY_SCREENSHOT) {
    // Optional visual evidence against the actual synthetic city, not a usability test.
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.addInitScript(() => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = "zh-Hans"; });
    await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 240_000 });
    await page.getByRole("button", { name: "城市设置" }).click();
    await page.getByRole("button", { name: "机甲战棋" }).click();
    await page.locator(".mecha-turn-summary").waitFor({ timeout: 90_000 });
    await page.getByRole("button", { name: "战术视角" }).click();
    await page.waitForTimeout(1000);
    if (process.env.MECHA_CITY_LOW_SCREENSHOT) {
      // Move the camera explicitly: the source screenshot does not provide its
      // orbit parameters. This is a comparable angle, not a reproduction.
      await page.evaluate(() => {
        const { engine, lease } = window.__markers;
        const view = engine.photoView(), [x,y,z] = view.target, [px,,pz] = view.position;
        const horizontal = Math.hypot(px-x,pz-z);
        lease.setOrbitView({ position:{x:px,y:y+horizontal*.5,z:pz}, target:{x,y,z}, fov:view.fov });
      });
      await page.waitForTimeout(1000);
      await page.screenshot({ path: process.env.MECHA_CITY_LOW_SCREENSHOT });
    }
    await page.setViewportSize({ width: 640, height: 480 });
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "战术视角" }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: process.env.MECHA_REAL_CITY_SCREENSHOT });
    console.log("640x480 synthetic city screenshot saved:", process.env.MECHA_REAL_CITY_SCREENSHOT);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
