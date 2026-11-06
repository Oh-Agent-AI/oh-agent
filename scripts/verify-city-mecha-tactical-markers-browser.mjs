#!/usr/bin/env node
import { completeLocalDeployment } from "./mecha-deployment-browser-helpers.mjs";
// Synthetic fixtures only. The Vite seam exposes real material objects and
// optionally supplies display-only marks; it never changes the combat state.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.env.MECHA_SCREENSHOTS_DIR;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: [process.env.MECHA_BROWSER_ANGLE === "metal" ? "--use-angle=metal" : "--enable-unsafe-swiftshader"] });
const results = [];
const replaceOnce = (source, needle, value) => { assert.equal(source.split(needle).length, 2, `seam: ${needle}`); return source.replace(needle, value); };
try {
  for (const lang of ["zh", "en"]) {
    const context = await browser.newContext({ viewport: { width:1100, height:700 }, deviceScaleFactor:1 });
    const page = await context.newPage(); page.setDefaultTimeout(60000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await page.addInitScript(lang => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en"; }, lang);
    await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
      const response = await route.fetch(); let source = await response.text();
      source = replaceOnce(source, "const raycaster = new THREE.Raycaster();", `
        globalThis.__tacticalProbe = { THREE, engine, camera, root, threatMat, projectedMat, reachMat, attackRouteMat, moveRouteMat, shoveMat, shoveOutlineMat, threatGeo, projectedGeo, inspectionArrows };
        const raycaster = new THREE.Raycaster();`);
      source = replaceOnce(source, "const current = viewRef.current;\n      syncOrderMarkers", "const current = globalThis.__tacticalFixture ? { ...viewRef.current, ...globalThis.__tacticalFixture } : viewRef.current;\n      syncOrderMarkers");
      await route.fulfill({ response, body:source });
    });
    const button = (zh, en) => page.getByRole("button", { name:lang === "zh" ? zh : en, exact:true });
    try {
      await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil:"domcontentloaded", timeout:90000 });
      await page.locator(".city-loading").waitFor({ state:"hidden", timeout:90000 });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await page.locator(".mecha-turn-summary").waitFor(); await completeLocalDeployment(page);
      await page.waitForFunction(() => Boolean(globalThis.__tacticalProbe) && !document.body.textContent.includes("正在加载 Assault 模型"));
      const gpu = await page.evaluate(() => {
        const p = globalThis.__tacticalProbe, { THREE, engine } = p, renderer = engine.renderer;
        const savedTarget = renderer.getRenderTarget(), exposure = renderer.toneMappingExposure;
        const target = new THREE.WebGLRenderTarget(64, 64, { depthBuffer:false }); target.texture.colorSpace = THREE.SRGBColorSpace;
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20); camera.position.z = 10;
        const geometry = new THREE.PlaneGeometry(1.5, .5), coreGeometry = new THREE.PlaneGeometry(1.5, .3);
        const readPixel = (coreMaterial, rimMaterial, sceneExposure) => {
          const scene = new THREE.Scene(); scene.background = new THREE.Color("#08131e"); scene.fog = new THREE.Fog("#000000", 0, 1);
          const rim = new THREE.Mesh(geometry, rimMaterial), core = new THREE.Mesh(coreGeometry, coreMaterial);
          rim.renderOrder = 15; core.renderOrder = 16; scene.add(rim, core);
          renderer.toneMappingExposure = sceneExposure; renderer.setRenderTarget(target); renderer.render(scene, camera);
          const pixel = new Uint8Array(4); renderer.readRenderTargetPixels(target, 32, 32, 1, 1, pixel);
          const border = new Uint8Array(4); renderer.readRenderTargetPixels(target, 32, 38, 1, 1, border);
          return { center:[...pixel].slice(0,3), rim:[...border].slice(0,3) };
        };
        const captures = [];
        try {
          for (const [kind, material] of [["attack", p.attackRouteMat], ["move", p.moveRouteMat], ["shove", p.shoveMat]]) {
            for (const sceneExposure of [.03, 4]) {
              const core = material.clone(), rim = p.shoveOutlineMat.clone();
              captures.push({ kind, exposure:sceneExposure, expected:material.color.getHexString(), ...readPixel(core, rim, sceneExposure) });
              core.dispose(); rim.dispose();
            }
          }
          // Reproduce the old queue mismatch with the real arrow material.
          // Old fog defaults are also bypassed here to isolate only ordering.
          const legacyCore = p.attackRouteMat.clone(), legacyRim = p.shoveOutlineMat.clone();
          legacyCore.transparent = false; legacyRim.color.set("#172936");
          const legacy = readPixel(legacyCore, legacyRim, 1); legacyCore.dispose(); legacyRim.dispose();
          return { captures, legacy, materials:[p.threatMat,p.projectedMat,p.reachMat,p.attackRouteMat,p.moveRouteMat,p.shoveMat,p.shoveOutlineMat].map(m => ({ transparent:m.transparent, singlePass:m.forceSinglePass, fog:m.fog, toneMapped:m.toneMapped })), hatches:p.threatGeo.getAttribute("position").count, predictionSegments:p.projectedGeo.getAttribute("position").count };
        } finally { renderer.toneMappingExposure = exposure; renderer.setRenderTarget(savedTarget); target.dispose(); geometry.dispose(); coreGeometry.dispose(); }
      });
      for (const capture of gpu.captures) {
        const expected = capture.expected.match(/../g).map(n => parseInt(n,16));
        assert.ok(capture.center.every((v,i) => Math.abs(v-expected[i]) <= 3), `arrow core covered: ${JSON.stringify(capture)}`);
        assert.ok(capture.rim[0] > 230 && capture.rim[1] > 220 && capture.rim[2] > 180, `missing light rim: ${JSON.stringify(capture)}`);
      }
      assert.ok(gpu.legacy.center.every(v => v < 65), `old queue bug must reproduce: ${JSON.stringify(gpu.legacy)}`);
      assert.ok(gpu.materials.every(m => m.transparent && m.singlePass && !m.fog && !m.toneMapped));
      assert.equal(gpu.hatches, 42); assert.equal(gpu.predictionSegments, 72);
      await page.locator(".mecha-tactical-legend > summary").click();
      const legend = page.locator(".mecha-tactical-legend > .mecha-battle-legend");
      assert.match(await legend.innerText(), lang === "zh" ? /敌方攻击[\s\S]*红框攻击者 → 斜纹危险格[\s\S]*草稿预测[\s\S]*移动/ : /Enemy attack[\s\S]*Red: attacker → striped danger cell[\s\S]*Plan prediction[\s\S]*Movement/);
      assert.ok(await legend.locator("[data-legend-item]").count() <= 5, "context key must stay compact");
      assert.equal(await legend.locator('[data-legend-item="declared"]').count(), 1);
      assert.equal(await legend.locator('[data-legend-item="projected"]').count(), 1);
      assert.equal(await legend.locator('[data-legend-item="shove"]').count(), 0, "no speculative shove icon");
      assert.ok((await legend.locator(".mecha-battle-legend__symbol").allTextContents()).every(s => s !== "P" && s !== "!P"));
      const box = await legend.boundingBox(); assert.ok(box.x >= 0 && box.y >= 0 && box.x+box.width <= 1100 && box.y+box.height <= 700);
      if (output) await page.screenshot({ path:join(output, `legend-${lang}-1100x700.png`) });
      await page.locator(".mecha-tactical-legend > summary").click();
      await button("查看战场", "View field").click();
      // Deliberately exposed vacant-cell display fixture for visual comparison.
      // It is not a proposed match or an assertion of rule-legal commands.
      await page.evaluate(() => { globalThis.__tacticalFixture = { declaredTelegraph:[{x:4,y:7},{x:5,y:7}], telegraph:[{x:4,y:7},{x:5,y:7}], projectedTelegraph:[{x:4,y:7}], reach:[], focusedTelegraph:[], hoveredEnemy:null, inspectedCell:{x:4,y:7}, inspectionSegments:[{kind:"attack",from:{x:4,y:5},to:{x:4,y:7}},{kind:"move",from:{x:6,y:7},to:{x:6,y:9}}] }; });
      await page.waitForFunction(() => document.querySelector(".mecha-world-unit-labels")?.dataset.inspectionRoutes === "2");
      if (output) await page.screenshot({ path:join(output, `display-fixture-${lang}-1100x700.png`) });
      await page.evaluate(() => { globalThis.__tacticalFixture = null; });
      await page.waitForTimeout(150); assert.deepEqual(errors, []);
      results.push({ lang, status:"passed", gpu }); console.log(`PASS tactical markers ${lang}: 6 GPU colour probes + legacy reproduction + legend`);
    } catch (error) {
      if (output) await page.screenshot({ path:join(output, `failure-${lang}.png`) }).catch(() => {});
      results.push({ lang, status:"failed", error:error.stack, errors }); console.error(error); process.exitCode = 1;
    } finally { await context.close(); }
  }
} finally { await browser.close(); if (output) await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2)); }
