#!/usr/bin/env node
// Synthetic City fixture + read-only Vite projection seam. No native data/IPC/relay.
// Camera gestures use the real canvas; the existing ?cityDebug hook supplies pose.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.env.MECHA_SCREENSHOTS_DIR;
if (output) await mkdir(output, { recursive: true });
const sizes = [[1100, 700], [800, 600], [640, 480], [390, 844]];
const browser = await chromium.launch({ headless: true, args: [process.env.MECHA_BROWSER_ANGLE === "metal" ? "--use-angle=metal" : "--enable-unsafe-swiftshader"] });
const results = [];
try {
  for (const lang of ["zh", "en"]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: lang === "zh" ? "zh-CN" : "en-US" });
    const page = await context.newPage(); page.setDefaultTimeout(60000);
    const errors = []; let seams = 0;
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(lang => {
      localStorage.setItem("city.seed", "4196523069");
      window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en";
    }, lang);
    await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
      const response = await route.fetch(), body = await response.text();
      const needle = "const home = { fov: 40, minDistance: 45, maxDistance: 520 };";
      assert.equal(body.split(needle).length, 2, "camera-fit read-only seam"); seams++;
      await route.fulfill({ response, body: body.replace(needle, `${needle}\n globalThis.__mechaCameraFit = { points: fitPoints, homeTarget, returnPose: saved };`) });
    });
    const button = (zh, en) => page.getByRole("button", { name: lang === "zh" ? zh : en, exact: true });
    const pose = () => page.evaluate(() => {
      const { camera, controls } = window.__cityEngine;
      return { position: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov };
    });
    const fit = () => page.evaluate(() => {
      const { camera, controls, THREE } = window.__cityEngine;
      const { points, homeTarget } = window.__mechaCameraFit;
      const offset = camera.position.clone().sub(controls.target);
      const projected = [];
      camera.updateMatrixWorld();
      for (let i = 0; i < points.length; i += 3) projected.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]).project(camera).toArray());
      return { elevation: Math.atan2(offset.y, Math.hypot(offset.x, offset.z)) * 180 / Math.PI,
        distance: offset.length(), targetError: controls.target.distanceTo(homeTarget), fov: camera.fov,
        controls: controls.enabled && controls.enableRotate && controls.enableZoom,
        x: [Math.min(...projected.map(p => p[0])), Math.max(...projected.map(p => p[0]))],
        y: [Math.min(...projected.map(p => p[1])), Math.max(...projected.map(p => p[1]))],
        z: [Math.min(...projected.map(p => p[2])), Math.max(...projected.map(p => p[2]))] };
    });
    const assertFit = async (width, height) => {
      const frame = await fit(), xLimit = 1 - 28 / width, yLimit = 1 - 2 * Math.min(60, height * .16) / height;
      assert.ok(Math.abs(frame.elevation - 45) < .05 && frame.targetError < .001, `default/reset pose: ${JSON.stringify(frame)}`);
      assert.ok(frame.controls && frame.fov === 40 && frame.distance >= 45, `perspective/manual controls: ${JSON.stringify(frame)}`);
      assert.ok(frame.x[0] >= -xLimit - .001 && frame.x[1] <= xLimit + .001 && frame.y[0] >= -yLimit - .001 && frame.y[1] <= yLimit + .001 && frame.z[0] > -1 && frame.z[1] < 1, `board clipping: ${JSON.stringify(frame)}`);
      return frame;
    };
    try {
      await page.goto(new URL("/?fixtureSessions=30&cityDebug", base).href, { waitUntil: "domcontentloaded", timeout: 120000 });
      // The dev-only FPS paragraph overlaps the City settings opener; it is not
      // part of the normal demo/HUD. Hide only that debug display in this harness.
      await page.addStyleTag({ content: ".city-perf { display: none !important; }" });
      await page.locator(".city-loading").waitFor({ state: "hidden" });
      await button("城市设置", "City settings").click();
      await button("机甲战棋", "Mecha tactics").click();
      await page.waitForFunction(() => window.__mechaCameraFit && document.querySelector(".mecha-plan-card__select")?.disabled === false);
      assert.equal(seams, 1);
      const returnPose = await page.evaluate(() => window.__mechaCameraFit.returnPose);
      await assertFit(1100, 700); // Automatic entry, before any Reset view click.
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height }); await page.waitForTimeout(200);
        await button("重置视角", "Reset view").click();
        const frame = await assertFit(width, height), draft = await page.locator(".mecha-pack").textContent();
        const homePose = await pose();
        if (output) await page.screenshot({ path: join(output, `camera-default-${lang}-${width}x${height}.png`) });
        await button("查看战场", "View field").click();
        if (output && width === 1100) await page.screenshot({ path: join(output, `camera-field-${lang}-${width}x${height}.png`) });
        await page.mouse.move(width / 2, height * .62); await page.mouse.down();
        await page.mouse.move(width / 2 + 55, height * .62 + 20, { steps: 6 }); await page.mouse.up();
        await page.waitForTimeout(250);
        const rotated = await pose();
        assert.ok(rotated.position.some((n, i) => Math.abs(n - homePose.position[i]) > .5), "real drag must rotate the camera");
        const beforeZoom = await page.evaluate(() => window.__cityEngine.camera.position.distanceTo(window.__cityEngine.controls.target));
        await page.mouse.wheel(0, -120); await page.waitForTimeout(250);
        const afterZoom = await page.evaluate(() => window.__cityEngine.camera.position.distanceTo(window.__cityEngine.controls.target));
        assert.ok(Math.abs(beforeZoom - afterZoom) > .5, "real wheel must zoom the camera");
        assert.equal(await page.locator(".mecha-pack").textContent(), draft, "camera gestures must not change the draft");
        await button("重置视角", "Reset view").click(); await assertFit(width, height);
        await button("恢复面板", "Show HUD").click();
        results.push({ lang, width, height, pass: true, frame });
        console.log(`PASS ${lang} ${width}x${height}: 45° entry/reset, board fit, drag, zoom, unchanged draft`);
      }
      await page.setViewportSize({ width: 1100, height: 700 });
      await page.locator(".mecha-battle-menu > summary").click(); await button("退出战斗", "Exit battle").click();
      await page.locator(".mecha-overlay").waitFor({ state: "hidden" });
      const restored = await pose();
      assert.ok(restored.position.every((n, i) => Math.abs(n - returnPose.position[i]) < .001) && restored.target.every((n, i) => Math.abs(n - returnPose.target[i]) < .001) && restored.fov === returnPose.fov, `exit must restore the leased city camera: ${JSON.stringify({ restored, expected: returnPose })}`);
      assert.deepEqual(errors, []);
      console.log(`PASS ${lang}: exit restores city pose`);
    } catch (error) {
      results.push({ lang, pass: false, error: error.message }); console.error(`FAIL ${lang}: ${error.stack}`);
      if (output) await page.screenshot({ path: join(output, `camera-failure-${lang}.png`) }).catch(() => {});
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
if (output) await writeFile(join(output, "results.json"), JSON.stringify({ timestamp: new Date().toISOString(), results, scope: "synthetic Chromium perspective/geometry and real canvas input; no native WebView, real device or full mobile HUD certification" }, null, 2) + "\n");
if (results.some(result => !result.pass)) process.exitCode = 1;
