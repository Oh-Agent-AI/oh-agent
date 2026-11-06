#!/usr/bin/env node
// Synthetic fixture only; start Vite with `npm run dev -- --port 5178 --strictPort`.
// Vite's CityMechaWorld module is instrumented in-memory to expose projection and
// the already-rendered view. No production file is changed by the instrumentation.
// MECHA_DPR selects device scale factor (default 1). Requires apps/desktop/ui-dev's
// Playwright. Not native/physical-device acceptance or system-scale verification.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
const dpr = Number(process.env.MECHA_DPR ?? 1);
assert.ok(Number.isFinite(dpr) && dpr > 0, "MECHA_DPR must be a positive number");
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) {
    const chinese = lang === "zh";
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr, hasTouch: true, locale: chinese ? "zh-CN" : "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/src/game/CityMechaWorld.tsx*", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const marker = "    const onDown = (event) => {";
      assert.ok(body.includes(marker), "Vite test instrumentation point changed");
      const pickMarker = '      if (cell) onCellRef.current(cell.x, cell.y, event.pointerType === "touch" ? "touch" : "mouse");';
      assert.ok(body.includes(pickMarker), "Vite pick instrumentation point changed");
      const probe = `    window.__mechaFocusTest = {
        lastCell: null,
        project: (x, y) => {
          const p = cellWorld(site, { x, y });
          camera.updateMatrixWorld();
          const v = new THREE.Vector3(p.x, p.y + 0.35, p.z).project(camera);
          const r = canvas.getBoundingClientRect();
          return { x: r.left + (v.x + 1) * r.width / 2, y: r.top + (1 - v.y) * r.height / 2, z: v.z };
        },
        view: () => structuredClone(viewRef.current),
        boardProjection: () => {
          camera.updateMatrixWorld();
          const r = canvas.getBoundingClientRect();
          const points = [];
          for (let i = 0; i < gridPts.length; i += 3) {
            const v = new THREE.Vector3(gridPts[i], gridPts[i + 1], gridPts[i + 2]).project(camera);
            points.push({ x: r.left + (v.x + 1) * r.width / 2, y: r.top + (1 - v.y) * r.height / 2, z: v.z });
          }
          return { points, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, aspect: camera.aspect, view: engine.photoView() };
        },
        warning: (x, y) => {
          const sprite = threatWarnings[y * BOARD + x];
          camera.updateMatrixWorld();
          const v = sprite.position.clone().project(camera);
          const r = canvas.getBoundingClientRect();
          return { visible: sprite.visible, x: r.left + (v.x + 1) * r.width / 2, y: r.top + (1 - v.y) * r.height / 2, scale: sprite.scale.toArray(), sizeAttenuation: sprite.material.sizeAttenuation };
        },
        warningOpacity: (opacity) => { for (const material of [warningMat, subduedWarningMat, focusWarningMat]) material.opacity = opacity; },
        pick: (x, y) => {
          const r = canvas.getBoundingClientRect();
          pointer.set((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
          raycaster.setFromCamera(pointer, camera);
          root.updateMatrixWorld(true);
          return raycaster.intersectObjects(picks, false)[0]?.object.userData.cell ?? null;
        }
      };\n`;
      await route.fulfill({ response, body: body.replace(marker, probe + marker).replace(pickMarker, '      if (cell) { window.__mechaFocusTest.lastCell = { x: cell.x, y: cell.y, pointer: event.pointerType }; onCellRef.current(cell.x, cell.y, event.pointerType === "touch" ? "touch" : "mouse"); }') });
    });
    await page.addInitScript((locale) => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, chinese ? "zh-Hans" : "en");
    await page.goto(new URL("/", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => devicePixelRatio), dpr, "browser DPR differs from requested test scale");
    console.log(`${lang}: synthetic city ready, DPR ${dpr}`);
    await page.getByRole("button", { name: chinese ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: chinese ? "机甲战棋" : "Mecha tactics" }).click();
    await page.locator(".mecha-threat-sources button").first().waitFor();
    await page.waitForFunction(() => window.__mechaFocusTest && Math.abs(window.__mechaFocusTest.boardProjection().aspect - 390 / 844) < 0.001);
    const initial = await page.evaluate(() => window.__mechaFocusTest.boardProjection());
    assert.ok(initial.points.every((p) => p.x >= initial.rect.left + 12 && p.x <= initial.rect.right - 12 && p.y >= initial.rect.top + 70 && p.y <= initial.rect.bottom - 70 && p.z >= -1 && p.z <= 1), "initial portrait entry did not fit the board");
    console.log(`${lang}: initial portrait grid fit passed`);
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.waitForFunction(() => Math.abs(window.__mechaFocusTest.boardProjection().aspect - 1100 / 700) < 0.001);
    for (let i = 0; i < 3; i++) {
      await page.locator(".mecha-pack li > button").nth(i).click();
      await page.locator(".mecha-selected-actions > .mecha-actions > button").filter({ hasText: chinese ? /^待机$/ : /^Hold$/ }).click();
    }
    await page.locator(".mecha-submit-primary").click();
    assert.match(await page.locator(".mecha-hold-confirm").innerText(), chinese ? /预计建筑损失 3/ : /Predicted building loss 3/);
    await page.getByRole("button", { name: chinese ? "继续提交" : "Submit anyway" }).click();
    const skip = page.getByRole("button", { name: chinese ? "跳过演出" : "Skip animation" });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.waitForFunction(() => document.querySelector(".mecha-resource")?.textContent?.includes("29/32"), null, { timeout: 240_000 });
    await page.locator(".mecha-pack li > button").first().click();
    await page.locator(".mecha-move-list summary").click();
    assert.equal(await page.locator('.mecha-move-list select option[value="4,7"]').count(), 1);
    assert.ok((await page.locator(".mecha-threat-sources button").allTextContents()).some((s) => s.includes("4,7")));
    // Camera fitting is applied on entry and explicit tactical reset, not on
    // resize; test each viewport after the engine has updated its aspect.
    for (const [width, height] of process.env.MECHA_FAST ? [[390, 844]] : [[390, 844], [1100, 700], [1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(({ width, height }) => Math.abs(window.__mechaFocusTest.boardProjection().aspect - width / height) < 0.001, { width, height });
      const tactical = page.getByRole("button", { name: chinese ? "战术视角" : "Tactical view" });
      await tactical.click();
      await page.waitForTimeout(250);
      const fit = await page.evaluate(() => window.__mechaFocusTest.boardProjection());
      const outside = fit.points.filter((p) => p.x < fit.rect.left + 12 || p.x > fit.rect.right - 12 || p.y < fit.rect.top + Math.min(70, height * 0.2) || p.y > fit.rect.bottom - Math.min(70, height * 0.2) || p.z < -1 || p.z > 1);
      assert.equal(outside.length, 0, `grid outside fit at ${width}x${height}: ${JSON.stringify(outside.slice(0, 4))}`);
      console.log(`${lang}: ${width}x${height} grid fit passed`);
      if (width === 390) {
        const beforeRotate = fit.view;
        await page.getByRole("button", { name: chinese ? "旋转 90°" : "Rotate 90°" }).click();
        await page.waitForTimeout(250);
        const rotated = (await page.evaluate(() => window.__mechaFocusTest.boardProjection())).view;
        const distance = (v) => Math.hypot(...v.position.map((p, i) => p - v.target[i]));
        assert.ok(Math.abs(distance(rotated) - distance(beforeRotate)) < 1, "rotate unexpectedly clamped the fitted distance");
        await tactical.click();
        await page.waitForTimeout(250);
        const reset = await page.evaluate(() => window.__mechaFocusTest.boardProjection());
        assert.ok(reset.points.every((p) => p.x >= reset.rect.left + 12 && p.x <= reset.rect.right - 12 && p.y >= reset.rect.top + 70 && p.y <= reset.rect.bottom - 70), "reset after rotation did not fit the board");
      }
    }
    const controls = await page.evaluate(() => {
      const bar = document.querySelector(".mecha-battle-controls").getBoundingClientRect();
      return Array.from(document.querySelectorAll(".mecha-battle-controls button"), (button) => {
        const box = button.getBoundingClientRect();
        return { text: button.textContent, inside: box.left >= bar.left && box.right <= bar.right && box.top >= bar.top && box.bottom <= bar.bottom,
          unclipped: button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight };
      });
    });
    assert.ok(controls.every((button) => button.inside && button.unclipped), `battle controls clipped: ${JSON.stringify(controls)}`);
    const before = await page.evaluate(() => ({ view: window.__mechaFocusTest.view(), point: window.__mechaFocusTest.project(4, 7) }));
    console.log(`${lang}: overlap cell projection ${JSON.stringify(before.point)}, figures ${JSON.stringify(before.view.figures)}, move ${JSON.stringify(before.view.move)}`);
    assert.deepEqual(before.view.figures.find((figure) => figure.selected && figure.alive), { id: "Assault", x: 4, y: 7, alive: true, hp: 14, selected: true });
    // The fitted view may move 4,7 clear of the HUD. Find a blocked cell
    // independently, then verify that map focus exposes that same location.
    const blocked = await page.evaluate(() => {
      const cells = [];
      for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
        const point = window.__mechaFocusTest.project(x, y);
        if (point.x > 1 && point.x < innerWidth - 1 && point.y > 75 && point.y < innerHeight - 1 && document.elementFromPoint(point.x, point.y)?.closest(".mecha-panel > *")) cells.push({ x, y, point });
      }
      return cells;
    });
    assert.ok(blocked.length, "fixture must include at least one HUD-blocked board cell");
    if (screenshots) await page.screenshot({ path: join(screenshots, `before-focus-390x844-${lang}-dpr${dpr}.png`) });
    const focus = page.getByRole("button", { name: chinese ? "查看战场" : "View field" });
    await focus.focus();
    await page.keyboard.press("Enter");
    const restore = page.getByRole("button", { name: chinese ? "恢复面板" : "Show HUD" });
    assert.equal(await restore.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".mecha-turn-summary").isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.__mechaFocusTest.view()), before.view, "HUD collapse changed the plan/view");
    const revealed = await page.evaluate((cells) => cells.filter(({ point }) => document.elementFromPoint(point.x, point.y)?.tagName === "CANVAS"), blocked);
    assert.ok(revealed.length, "map focus did not reveal a HUD-blocked board cell");
    console.log(`${lang}: focus revealed ${revealed.length}/${blocked.length} HUD-blocked cells`);
    if (screenshots) await page.screenshot({ path: join(screenshots, `focus-390x844-${lang}-dpr${dpr}.png`) });
    // Count warning-coloured pixels near the projected sprite, with and without
    // the sprite. This tests actual raster output, not just the scene flag;
    // animated background and a single fixture still limit the claim.
    const warning = await page.evaluate(() => window.__mechaFocusTest.warning(4, 7));
    assert.ok(warning.visible && warning.x > 12 && warning.x < 378 && warning.y > 72 && warning.y < 832, `warning offscreen: ${JSON.stringify(warning)}`);
    const redPixels = async () => {
      const png = (await page.screenshot()).toString("base64");
      return page.evaluate(async ({ png, x, y }) => {
        const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
        const scaleX = image.width / innerWidth, scaleY = image.height / innerHeight;
        const data = ctx.getImageData(Math.floor((x - 10) * scaleX), Math.floor((y - 10) * scaleY), Math.ceil(20 * scaleX), Math.ceil(20 * scaleY)).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 120 && data[i] > data[i + 1] * 1.5 && data[i] > data[i + 2] * 1.5) count++;
        return count;
      }, { png, ...warning });
    };
    const visibleRed = await redPixels();
    await page.evaluate(() => window.__mechaFocusTest.warningOpacity(0));
    await page.waitForTimeout(200);
    if (screenshots) await page.screenshot({ path: join(screenshots, `focus-warning-hidden-390x844-${lang}-dpr${dpr}.png`) });
    const hiddenRed = await redPixels();
    await page.evaluate(() => window.__mechaFocusTest.warningOpacity(1));
    console.log(`${lang}: warning projected at ${JSON.stringify(warning)}; red pixels ${visibleRed} visible vs ${hiddenRed} hidden`);
    assert.ok(visibleRed >= hiddenRed + 3, `warning did not produce visible red pixels: ${visibleRed} vs ${hiddenRed}`);
    await restore.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(".mecha-turn-summary").isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.__mechaFocusTest.view()), before.view, "HUD restore changed the plan/view");
    await focus.click();
    const point = await page.evaluate(() => window.__mechaFocusTest.project(4, 7));
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point);
    const picked = await page.evaluate(({ x, y }) => window.__mechaFocusTest.pick(x, y), point);
    console.log(`${lang}: focused overlap point ${JSON.stringify(point)}, element ${hit}, ray pick ${JSON.stringify(picked)}`);
    assert.ok(point.x > 0 && point.x < 390 && point.y > 0 && point.y < 844, "overlap cell outside viewport");
    assert.equal(hit, "CANVAS", "overlap cell blocked by HUD");
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(300);
    console.log(`${lang}: after click ${JSON.stringify(await page.evaluate(() => ({ map: document.querySelector(".mecha-overlay")?.getAttribute("data-map-focus"), move: window.__mechaFocusTest.view().move, figures: window.__mechaFocusTest.view().figures })) )}`);
    await page.waitForFunction(() => !document.querySelector('.mecha-overlay')?.hasAttribute('data-map-focus'));
    // 4,7 is the selected mech's current location: clicking it is a valid
    // pick but must not invent a movement destination.
    assert.equal(await page.evaluate(() => window.__mechaFocusTest.view().move), null);
    assert.equal(await page.locator(".mecha-turn-summary").isVisible(), true);
    await focus.click();
    const destination = await page.evaluate(() => {
      const test = window.__mechaFocusTest;
      const view = test.view();
      return view.reach.filter((cell) => !view.figures.some((figure) => figure.alive && figure.x === cell.x && figure.y === cell.y)).map((cell) => {
        const point = test.project(cell.x, cell.y);
        const picked = test.pick(point.x, point.y);
        return { cell, point, picked, element: document.elementFromPoint(point.x, point.y)?.tagName };
      }).find(({ cell, point, picked, element }) => point.x > 1 && point.x < 389 && point.y > 60 && point.y < 843 && element === "CANVAS" && picked?.x === cell.x && picked?.y === cell.y);
    });
    assert.ok(destination, "fixture must have a visible reachable unoccupied destination");
    await page.touchscreen.tap(destination.point.x, destination.point.y);
    await page.waitForFunction(({ x, y }) => { const move = window.__mechaFocusTest.view().move; return move?.x === x && move?.y === y; }, destination.cell, { timeout: 5000 });
    assert.equal(await page.locator(".mecha-turn-summary").isVisible(), true);
    // A board pick while paused may restore the HUD, but cannot alter the draft.
    const plannedMove = await page.evaluate(() => window.__mechaFocusTest.view().move);
    await page.getByRole("button", { name: chinese ? "暂停" : "Pause", exact: true }).click();
    await focus.click();
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForFunction(() => !document.querySelector('.mecha-overlay')?.hasAttribute('data-map-focus'));
    assert.deepEqual(await page.evaluate(() => window.__mechaFocusTest.view().move), plannedMove, "paused board pick changed the draft");
    // Do not filter by the implementation's ray pick: projected cell centers
    // are the independent input. Check several board locations for both mouse
    // and emulated touch while paused, without permitting plan edits.
    for (const cell of [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 4, y: 4 }, { x: 1, y: 8 }, { x: 8, y: 8 }]) {
      for (const pointer of ["mouse", "touch"]) {
        await focus.click();
        const projected = await page.evaluate(({ x, y }) => {
          window.__mechaFocusTest.lastCell = null;
          const point = window.__mechaFocusTest.project(x, y);
          return { ...point, hit: document.elementFromPoint(point.x, point.y)?.tagName };
        }, cell);
        assert.equal(projected.hit, "CANVAS", `projected cell is obscured at DPR ${dpr}: ${JSON.stringify({ cell, projected })}`);
        if (pointer === "touch") await page.touchscreen.tap(projected.x, projected.y);
        else await page.mouse.click(projected.x, projected.y);
        await page.waitForFunction(() => window.__mechaFocusTest.lastCell !== null);
        assert.deepEqual(await page.evaluate(() => window.__mechaFocusTest.lastCell), { ...cell, pointer }, `wrong picked cell at DPR ${dpr}`);
        await page.waitForFunction(() => !document.querySelector('.mecha-overlay')?.hasAttribute('data-map-focus'));
      }
    }
    assert.deepEqual(await page.evaluate(() => window.__mechaFocusTest.view().move), plannedMove, "paused DPR pick matrix changed the draft");
    await page.getByRole("button", { name: chinese ? "继续" : "Resume", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__mechaFocusTest.view().move), plannedMove);
    assert.deepEqual(errors, []);
    console.log(`${lang}: DPR ${dpr}, focus toggle, restore, overlap pick, emulated-touch move to ${JSON.stringify(destination.cell)}, and ten paused pointer/cell checks passed`);
    await context.close();
  }
} finally { await browser.close(); }
console.log("Synthetic in-memory instrumentation, mouse and emulated touch only; not physical/native/user acceptance.");
