#!/usr/bin/env node
import { completeLocalDeployment } from "./mecha-deployment-browser-helpers.mjs";
// Independent headless Chromium, synthetic city only. UI selection/movement
// uses actual controls/picks. Overrides below are labelled display fixtures:
// they prove layer coverage, not rule-valid attacks, damage or remote play.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.env.MECHA_SCREENSHOTS_DIR;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
const results = [];
const replaceOnce = (source, needle, value) => { assert.equal(source.split(needle).length, 2, `seam: ${needle}`); return source.replace(needle, value); };
try {
  for (const lang of ["zh", "en"]) {
    const context = await browser.newContext({ viewport: { width: 1768, height: 748 }, deviceScaleFactor: 1 });
    const page = await context.newPage(); page.setDefaultTimeout(60_000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.addInitScript(lang => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en"; }, lang);
    await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
      const response = await route.fetch(); let source = await response.text();
      source = replaceOnce(source, "const raycaster = new THREE.Raycaster();", `
        globalThis.__boardProbe = { THREE, engine, camera, site, cellWorld, fitPoints, pads, reachGeo, reachMat, reachMarks, reachMatrices, overlapReachMarks, overlapReachRims, overlapReachGeo, overlapReachRimGeo, overlapReachMat, overlapReachRimMat,
          targetLines, projectedLines, threatWarnings, projectedWarnings, dangerFrames, dangerFills, sourceGeo, intentSources, intentArrows, inspectionArrows, figures, view: () => viewRef.current };
        globalThis.__boardDisposed = 0;
        for (const resource of [reachGeo, reachMat, reachMarks, sourceGeo, overlapProjectedMat, overlapReachMarks, overlapReachRims, overlapReachGeo, overlapReachRimGeo, overlapReachMat, overlapReachRimMat]) resource.addEventListener("dispose", () => globalThis.__boardDisposed++);
        const raycaster = new THREE.Raycaster();`);
      source = replaceOnce(source, "const current = viewRef.current;\n      syncOrderMarkers", "const current = globalThis.__boardFixture ? { ...viewRef.current, ...globalThis.__boardFixture } : viewRef.current;\n      syncOrderMarkers");
      await route.fulfill({ response, body: source });
    });
    const button = (zh, en) => page.getByRole("button", { name: lang === "zh" ? zh : en, exact: true });
    const screenshot = async name => { if (output) await page.screenshot({ path: join(output, `${name}-${lang}.png`) }); };
    const snapshot = () => page.evaluate(() => {
      const p = globalThis.__boardProbe, view = globalThis.__boardFixture ? { ...p.view(), ...globalThis.__boardFixture } : p.view();
      const key = c => `${c.x},${c.y}`, danger = new Set(view.declaredTelegraph.map(key));
      const allReach = [...new Set(view.reach.map(key))];
      const reach = allReach.filter(k => !danger.has(k));
      const expectedOverlap = allReach.filter(k => danger.has(k));
      const instances = mesh => Array.from({length: mesh.count}, (_, i) => {
        const m = new p.THREE.Matrix4(); mesh.getMatrixAt(i, m);
        const found = p.reachMatrices.findIndex(candidate => candidate.elements.every((v,j) => Math.abs(v - m.elements[j]) < 1e-4));
        return found < 0 ? `invalid:${i}` : `${found % 10},${Math.floor(found / 10)}`;
      }).sort();
      const cells = (meshes) => meshes.flatMap((mesh, i) => mesh.visible ? [`${i % 10},${Math.floor(i / 10)}`] : []);
      const positions = p.reachGeo.getAttribute("position");
      const hasInteriorVertex = Array.from({ length: positions.count }, (_, i) => [positions.getX(i), positions.getZ(i)])
        .some(([x, z]) => Math.abs(x) < (p.site.cellW - .44) / 2 - .01 || Math.abs(z) < (p.site.cellD - .48) / 2 - .01);
      const attackArrows = [...p.intentArrows, ...p.inspectionArrows.filter(r => r.arrow.material.color.getHexString() === "ff7668")]
        .filter(r => r.arrow.visible).map(r => ({ length:r.arrow.scale.x, width:r.arrow.scale.z, transparent:r.arrow.material.transparent, depthTest:r.arrow.material.depthTest }));
      return { danger:[...danger].sort(), expectedReach:reach.sort(), reachCount:p.reachMarks.count, reachCells:instances(p.reachMarks),
        expectedOverlap:expectedOverlap.sort(), overlapCells:instances(p.overlapReachMarks), overlapRimCells:instances(p.overlapReachRims),
        targets:cells(p.targetLines).sort(), expectedTargets:[...new Set(view.targets.map(key))].sort(),
        reachVertices:positions.count, hasInteriorVertex, reachOpacity:p.reachMat.opacity,
        frames:cells(p.dangerFrames).sort(), fills:cells(p.dangerFills).sort(), prediction:cells(p.projectedLines).sort(),
        expectedPrediction:[...new Set((view.projectedTelegraph ?? []).map(key))].sort(),
        overlaps:p.projectedLines.flatMap((mesh,i) => mesh.visible && p.dangerFrames[i].visible ? [mesh.material.opacity] : []),
        sources:p.intentSources.filter(r => r.frame.visible).length, expectedSources:(view.declaredIntents ?? []).length,
        sourceVertices:p.sourceGeo.getAttribute("position").count,
        redWarnings:cells(p.threatWarnings), blueWarnings:cells(p.projectedWarnings),
        terrainMaterials:p.pads.map(m => m.material.uuid), attackArrows, move:view.move, routes:view.inspectionSegments };
    });
    const assertLayers = s => {
      assert.equal(s.reachVertices, 6, "reach is exactly one two-triangle flat tile, not directional symbols");
      assert.equal(s.hasInteriorVertex, false, "green range geometry has no inward arrow tips");
      assert.equal(s.reachCount, s.expectedReach.length, "all non-danger legal moves keep a green overlay");
      assert.deepEqual(s.reachCells, s.expectedReach, "plain markers belong to correct cells");
      assert.deepEqual(s.overlapCells, s.expectedOverlap, "danger markers belong to correct cells");
      assert.deepEqual(s.overlapRimCells, s.expectedOverlap, "diamond rims match their fills");
      assert.deepEqual(s.targets, s.expectedTargets, "legal target layer remains independent");
      assert.equal(s.reachOpacity, .32);
      assert.deepEqual(s.frames, s.danger); assert.deepEqual(s.fills, s.danger);
      assert.deepEqual(s.prediction, s.expectedPrediction, "no prediction cells lost when deemphasizing blue");
      assert.equal(s.sources, s.expectedSources); assert.equal(s.sourceVertices, 48, "sources use four open corners, not danger frames");
      assert.ok(s.overlaps.every(opacity => opacity === .58), "red/blue overlap remains red-primary");
      for (const arrow of s.attackArrows) assert.ok(arrow.length > 0 && arrow.width > 0 && arrow.transparent && !arrow.depthTest);
    };
    try {
      await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil:"domcontentloaded", timeout:90_000 });
      await page.locator(".city-loading").waitFor({ state:"hidden", timeout:90_000 });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await page.locator(".mecha-turn-summary").waitFor(); await completeLocalDeployment(page);
      await page.waitForFunction(() => globalThis.__boardProbe?.intentSources.some(s => s.frame.visible));
      await page.mouse.move(1760, 740);
      // Identical seed/viewports to the previous legend round's real screenshots.
      await page.locator(".mecha-tactical-legend > summary").click();
      for (const [width, height] of [[1768,748], [1100,700], [640,480]]) {
        await page.setViewportSize({ width, height }); await button("重置视角", "Reset view").click(); await page.waitForTimeout(350);
        const actual = await snapshot(); assertLayers(actual); assert.ok(actual.attackArrows.length > 0);
        await screenshot(`actual-${width}x${height}`); results.push({ lang, state:"actual", width, height, status:"passed", actual });
        // Confirm the fitted board perimeter is on-screen in the uncluttered field.
        await button("查看战场", "View field").click(); await page.waitForTimeout(120);
        const corners = await page.evaluate(() => {
          const { THREE, fitPoints, camera } = globalThis.__boardProbe;
          const points = [];
          for (let i=0;i<fitPoints.length;i+=3) { const at = new THREE.Vector3(fitPoints[i],fitPoints[i+1],fitPoints[i+2]).project(camera); points.push([at.x,at.y]); }
          return points;
        });
        assert.ok(corners.every(([x,y]) => Math.abs(x) <= 1.01 && Math.abs(y) <= 1.01), `fitted board cropped: ${JSON.stringify(corners)}`);
        await screenshot(`field-${width}x${height}`); await button("恢复面板", "Show HUD").click();
      }
      await page.setViewportSize({ width:1768, height:748 }); await button("重置视角", "Reset view").click();
      await page.locator(".mecha-tactical-legend > summary").click();
      const opening = await snapshot();
      // Removing the display reach alone must not recolour terrain/cover pads.
      await page.evaluate(() => { globalThis.__boardFixture = { reach:[] }; }); await page.waitForTimeout(100);
      const noReach = await snapshot(); assertLayers(noReach); assert.deepEqual(noReach.terrainMaterials, opening.terrainMaterials);
      await page.evaluate(() => { globalThis.__boardFixture = null; }); await page.waitForTimeout(100);
      // Actual enemy selection: strongest chain changes, other dangers remain.
      await page.locator(".mecha-threat-details > summary").click(); await page.locator(".mecha-threat-sources button").first().click();
      await page.locator(".mecha-threat-details > summary").click(); await page.waitForTimeout(150);
      const selected = await snapshot(); assertLayers(selected); assert.deepEqual(selected.danger, opening.danger);
      assert.ok(selected.routes.some(r => r.kind === "attack")); await screenshot("selected-enemy-1768x748");
      await page.locator(".mecha-threat-details > summary").click(); await page.locator('.mecha-threat-sources button[aria-pressed="true"]').click();
      await page.locator(".mecha-threat-details > summary").click();
      // Actual list move followed by an actual model pick exposes the verified
      // tile-to-tile route. The helper for attacks must not shorten move segments.
      await page.locator(".mecha-move-list > summary").click();
      const option = await page.evaluate(() => {
        const v=globalThis.__boardProbe.view(), figure=v.figures.find(f=>f.selected);
        const cell=v.reach.find(c=>c.x!==figure.x||c.y!==figure.y); return cell ? `${cell.x},${cell.y}` : null;
      });
      assert.ok(option); await page.locator("#mecha-move-choice").selectOption(option); await button("应用移动", "Apply move").click();
      await page.locator(".mecha-move-list > summary").click(); await page.waitForTimeout(500);
      const moved = await snapshot(); assertLayers(moved); assert.equal(`${moved.move.x},${moved.move.y}`, option);
      await button("查看战场", "View field").click();
      const at = await page.evaluate(() => {
        const p = globalThis.__boardProbe, selected = p.view().figures.find(f => f.selected).id;
        const at = p.figures[selected].position.clone(); at.y += 8; at.project(p.camera);
        const r = p.engine.domCanvas.getBoundingClientRect(); return {x:r.left+(at.x+1)*r.width/2,y:r.top+(1-at.y)*r.height/2};
      });
      await page.mouse.click(at.x,at.y); await page.mouse.move(1760,740);
      await page.waitForFunction(() => globalThis.__boardProbe.view().inspectionSegments?.some(s => s.kind === "move"));
      const routeLengths = await page.evaluate(() => {
        const p = globalThis.__boardProbe, segments = p.view().inspectionSegments;
        return segments.map((s,i) => { const a=p.cellWorld(p.site,s.from),b=p.cellWorld(p.site,s.to); return {kind:s.kind,expected:Math.hypot(b.x-a.x,b.z-a.z),actual:p.inspectionArrows[i].arrow.scale.x}; });
      });
      for (const route of routeLengths) { assert.equal(route.kind,"move"); assert.ok(Math.abs(route.expected-route.actual)<1e-6); }
      await screenshot("planned-movement-1768x748");
      // Empty-cell display fixture: all dangers/predictions survive with no
      // redundant screen badges. These cells are explicitly free of models.
      const emptyCells = await page.evaluate(() => {
        const v=globalThis.__boardProbe.view(),occupied=new Set();
        const key=c=>`${c.x},${c.y}`;
        for(const c of [...v.figures,...v.raiders,...v.buildings.flatMap(b=>b.cells),...(v.obstacles??[])])occupied.add(key(c));
        for(let y=0;y<2;y++)for(let x=0;x<2;x++)occupied.add(`${v.boss.x+x},${v.boss.y+y}`);
        return Array.from({length:100},(_,i)=>({x:i%10,y:Math.floor(i/10)})).filter(c=>!occupied.has(key(c))).slice(0,30);
      });
      await page.evaluate(cells => { globalThis.__boardFixture = { declaredIntents:[], declaredTelegraph:cells, projectedTelegraph:cells, reach:cells,
        hoveredEnemy:null, focusedTelegraph:[], inspectedThreats:[], inspectionSegments:[], inspectedCell:null, move:null, targets:[cells[0]], targetPreview:undefined }; }, emptyCells);
      await page.waitForTimeout(150); const empty = await snapshot(); assertLayers(empty);
      assert.equal(empty.reachCount,0,"danger cells use diamonds instead of green wash");
      assert.equal(empty.overlapCells.length,emptyCells.length);
      assert.deepEqual(empty.targets,[`${emptyCells[0].x},${emptyCells[0].y}`],"target, reach and danger can coexist");
      assert.equal(empty.redWarnings.length,0); assert.equal(empty.blueWarnings.length,0);
      for (const [width,height] of [[1768,748], [1100,700], [640,480]]) {
        await page.setViewportSize({width,height}); await button("重置视角", "Reset view").click(); await page.waitForTimeout(150);
        await screenshot(`display-fixture-empty-danger-${width}x${height}`);
      }
      // Same cell transitions check signature invalidation and removal of stale instances.
      await page.setViewportSize({width:1768,height:748});
      for (const [declared,reach] of [[false,true],[true,false],[false,false],[true,true]]) {
        await page.evaluate(({cell,declared,reach}) => { globalThis.__boardFixture = { ...globalThis.__boardFixture,
          declaredTelegraph: declared ? [cell] : [], reach: reach ? [cell] : [], projectedTelegraph:[cell], targets:[cell] }; },
          {cell:emptyCells[0],declared,reach});
        await page.waitForTimeout(120); assertLayers(await snapshot());
      }
      await page.evaluate(() => {globalThis.__boardFixture=null;}); assert.deepEqual(errors,[]);
      await page.locator(".mecha-battle-menu > summary").click(); await button("退出战斗", "Exit battle").click();
      await page.waitForFunction(() => globalThis.__boardDisposed === 11);
      results.push({lang,state:"selection-movement-layer-fixtures",status:"passed",selected,move:moved.move,routeLengths,empty,disposed:11});
      console.log(`PASS board ${lang}: 3 fitted views + actual enemy selection/model pick/list move + terrain/layer fixtures + disposal`);
    } catch (error) {
      await screenshot("failure").catch(()=>{}); results.push({lang,status:"failed",error:error.stack,errors}); console.error(error); process.exitCode=1;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
if (output) await writeFile(join(output,"results.json"),JSON.stringify(results,null,2)+"\n");
