#!/usr/bin/env node
// Synthetic controller fixture injected into Vite responses only; never uses
// user sessions. Tests browser interactions, not real-device/native acceptance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) {
    const zh = lang === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1, hasTouch: true, locale: zh ? "zh-CN" : "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
      assert.ok(body.includes(needle), "controller instrumentation point changed");
      body = `import { createMatch as fixtureMatch, bossPrepare as prepareFixture, living as fixtureLiving } from "/src/game/mecha/rules.ts";\n` + body;
      body = body.replace(needle, `const fixture = fixtureMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 },
        raiders: [{ id: "raider-w", pos: { x: 4, y: 4 } }, { id: "raider-e", pos: { x: 6, y: 4 } }],
        mechs: [{ id: "Assault", pos: { x: 5, y: 2 } }, { id: "Gunner", pos: { x: 2, y: 8 } }, { id: "Support", pos: { x: 6, y: 2 } }] });
        prepareFixture(fixture);
        controllerRef.current = createMechaController({ animate: true, locale, site, match: fixture,
          planner: (state) => ({ revision: state.revision, items: fixtureLiving(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) }) });
        window.__multiController = controllerRef.current;`);
      await route.fulfill({ response, body });
    });
    await page.route("**/src/game/CityMechaWorld.tsx*", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const needle = "    const onDown = (event) => {";
      assert.ok(body.includes(needle), "world instrumentation point changed");
      const probe = `    window.__multiWorld = {
        project: (x, y) => {
          const p = cellWorld(site, { x, y }); camera.updateMatrixWorld();
          const v = new THREE.Vector3(p.x, p.y + 0.35, p.z).project(camera);
          const r = canvas.getBoundingClientRect();
          return { x: r.left + (v.x + 1) * r.width / 2, y: r.top + (1 - v.y) * r.height / 2 };
        },
        pick: (x, y) => {
          const r = canvas.getBoundingClientRect();
          pointer.set((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
          raycaster.setFromCamera(pointer, camera); root.updateMatrixWorld(true);
          return raycaster.intersectObjects(picks, false)[0]?.object.userData.cell ?? null;
        },
        layers: (x, y) => ({ view: structuredClone(viewRef.current), threat: threatLines[y * BOARD + x].visible,
          warning: threatWarnings[y * BOARD + x].visible, target: targetLines[y * BOARD + x].visible }),
        orderPositions: () => {
          camera.updateMatrixWorld(); const r = canvas.getBoundingClientRect();
          return orderMarkers.map(({ sprite, actor }) => {
            const v = sprite.position.clone().project(camera);
            return { actor, x: r.left + (v.x + 1) * r.width / 2, y: r.top + (1 - v.y) * r.height / 2 };
          });
        }
      };\n`;
      await route.fulfill({ response, body: body.replace(needle, probe + needle) });
    });
    await page.addInitScript((locale) => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, zh ? "zh-Hans" : "en");
    await page.goto(new URL("/", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics" }).click();
    await page.locator(".mecha-threat-sources button").first().waitFor();
    await page.locator(".mecha-pack li > button").nth(2).click();
    await page.locator(".mecha-selected-actions > .mecha-actions > button").filter({ hasText: zh ? /^维修$/ : /^Repair$/ }).click();
    await page.waitForFunction(() => {
      const s = window.__multiController?.getState();
      return s?.reach.some((c) => c.x === 5 && c.y === 2) && s.targetOptions.some((t) => t.id === "Assault");
    });
    const sources = page.locator(".mecha-threat-sources button");
    assert.equal(await sources.count(), 3);
    for (let i = 0; i < 3; i++) {
      const source = sources.nth(i);
      assert.match(await source.innerText(), /5,2/);
      await source.click();
      assert.equal(await source.getAttribute("aria-pressed"), "true");
      await page.waitForFunction(() => {
        const s = window.__multiController.getState();
        return s.focusedTelegraph.some((c) => c.x === 5 && c.y === 2) && window.__multiWorld.layers(5, 2).target;
      });
      const layers = await page.evaluate(() => window.__multiWorld.layers(5, 2));
      assert.ok(layers.threat && layers.warning && layers.target, "multi-threat target must retain independent scene layers");
      if (screenshots) await page.screenshot({ path: join(screenshots, `multi-${lang}-source-${i + 1}.png`) });
    }
    const orderToggle = page.getByRole("button", { name: zh ? "结算顺序" : "Attack order", exact: true });
    await orderToggle.click();
    await page.waitForFunction(() => window.__multiWorld.orderPositions().length === 3);
    const checkOrderSpacing = async (label) => {
      const positions = (await page.evaluate(() => window.__multiWorld.orderPositions())).sort((a, b) => a.x - b.x);
      assert.equal(positions.length, 3);
      for (let i = 1; i < positions.length; i++) {
        assert.ok(positions[i].x - positions[i - 1].x >= 26, `${label}: overlapping order badges ${JSON.stringify(positions)}`);
        assert.ok(Math.abs(positions[i].y - positions[i - 1].y) < 1, `${label}: badges are not screen-aligned ${JSON.stringify(positions)}`);
      }
      console.log(`${lang}: ${label} order badge spacing ${JSON.stringify(positions)}`);
    };
    for (const [width, height] of [[1100, 700], [1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.getByRole("button", { name: zh ? "战术视角" : "Tactical view" }).click();
      await page.waitForTimeout(300);
      await checkOrderSpacing(`${width}x${height}`);
      if (screenshots) {
        await page.getByRole("button", { name: zh ? "查看战场" : "View field" }).click();
        await page.screenshot({ path: join(screenshots, `multi-${lang}-order-${width}x${height}.png`) });
        await page.getByRole("button", { name: zh ? "恢复面板" : "Show HUD" }).click();
      }
      await page.getByRole("button", { name: zh ? "旋转 90°" : "Rotate 90°" }).click();
      await page.waitForTimeout(300);
      await checkOrderSpacing(`${width}x${height} rotated`);
    }
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.getByRole("button", { name: zh ? "战术视角" : "Tactical view" }).click();
    await orderToggle.click();
    const before = await page.evaluate(() => structuredClone(window.__multiController.getState().draft));
    const focus = page.getByRole("button", { name: zh ? "查看战场" : "View field" });
    const tapVisible = async (locator, label) => {
      const point = await locator.evaluate((el) => {
        const r = el.getBoundingClientRect(), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
          reachable: !!hit && (hit === el || el.contains(hit)), hit: hit?.outerHTML.slice(0, 160) };
      });
      assert.ok(point.inside && point.reachable, `${lang}: ${label} blocked or clipped: ${JSON.stringify(point)}`);
      await page.touchscreen.tap(point.x, point.y);
    };
    const assertActionHeadingVisible = async (label) => {
      const geometry = await page.evaluate(() => {
        const panel = document.querySelector(".mecha-selected-actions");
        const heading = panel.querySelector("h3");
        const p = panel.getBoundingClientRect(), h = heading.getBoundingClientRect();
        return { text: heading.textContent, panelTop: p.top, panelBottom: p.bottom, headingTop: h.top, headingBottom: h.bottom,
          viewportTop: 0, viewportBottom: innerHeight, scrollTop: panel.scrollTop };
      });
      assert.ok(geometry.headingTop >= geometry.panelTop && geometry.headingBottom <= geometry.panelBottom &&
        geometry.headingTop >= geometry.viewportTop && geometry.headingBottom <= geometry.viewportBottom,
        `${lang}: ${label} current-mech heading clipped: ${JSON.stringify(geometry)}`);
    };
    const tapTarget = async () => {
      await tapVisible(focus, "view field");
      const p = await page.evaluate(() => window.__multiWorld.project(5, 2));
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, p), "CANVAS");
      assert.deepEqual(await page.evaluate(({ x, y }) => window.__multiWorld.pick(x, y), p), { x: 5, y: 2 });
      await page.touchscreen.tap(p.x, p.y);
      await page.waitForFunction(() => window.__multiController.getState().candidate?.target === "Assault");
    };
    const repair = page.locator(".mecha-selected-actions > .mecha-actions > button").filter({ hasText: zh ? /^维修$/ : /^Repair$/ });
    for (const [width, height] of [[1100, 700], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.getByRole("button", { name: zh ? "战术视角" : "Tactical view" }).click();
      await tapTarget();
      assert.deepEqual(await page.evaluate(() => window.__multiController.getState().draft), before, "touch preview must not change draft");
      if (screenshots) await page.screenshot({ path: join(screenshots, `multi-${lang}-touch-candidate-${width}x${height}.png`) });
      await tapVisible(page.locator(".mecha-candidate-actions button").nth(1), `${width}x${height} cancel`);
      assert.equal(await page.evaluate(() => window.__multiController.getState().candidate), null);
      assert.deepEqual(await page.evaluate(() => window.__multiController.getState().draft), before, "touch cancel must preserve draft");
      await assertActionHeadingVisible(`${width}x${height} after cancel`);
      await repair.scrollIntoViewIfNeeded();
      await tapVisible(repair, `${width}x${height} repair`);
      console.log(`${lang}: ${width}x${height} touch target preview and cancel passed`);
    }
    await tapTarget();
    assert.deepEqual(await page.evaluate(() => window.__multiController.getState().draft), before, "touch confirmation must be explicit");
    await tapVisible(page.locator(".mecha-candidate-actions button").first(), "390x844 confirm");
    const draft = await page.evaluate(() => window.__multiController.getState().draft);
    assert.equal(draft.Support.action.kind, "repair");
    assert.equal(draft.Support.action.target, "Assault");
    await assertActionHeadingVisible("390x844 after confirm");
    // This is a real controller result and actual incoming-hit indicator, not
    // the synthetic long-text/Hit row used by the separate layout stress test.
    await page.waitForTimeout(350);
    const finalLayout = await page.evaluate(() => {
      const rect = (el) => el.getBoundingClientRect();
      const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const pack = document.querySelector(".mecha-pack");
      const card = pack.querySelectorAll("li")[2];
      const text = card.querySelector(".mecha-card-action");
      const select = card.querySelector("button");
      const t = rect(text), c = rect(card), p = rect(pack), a = rect(document.querySelector(".mecha-selected-actions")), sub = rect(document.querySelector(".mecha-submit"));
      const button = rect(select), hit = document.elementFromPoint((button.left + button.right) / 2, (button.top + button.bottom) / 2);
      return { text: text.textContent, hitRows: pack.querySelectorAll(".mecha-hit").length,
        clipped: text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1 || t.left < c.left - 1 || t.right > c.right + 1 || t.top < c.top - 1 || t.bottom > c.bottom + 1,
        selectReachable: !!hit && (hit === select || select.contains(hit)), actionOverlap: intersects(p, a), submitOverlap: intersects(p, sub) };
    });
    assert.match(finalLayout.text, zh ? /维修.*突击/ : /Repair.*Assault/);
    assert.ok(finalLayout.hitRows > 0, `${lang}: expected an actual incoming-hit indicator`);
    assert.equal(finalLayout.clipped, false, `${lang}: repair target card text clipped: ${JSON.stringify(finalLayout)}`);
    assert.equal(finalLayout.selectReachable, true, `${lang}: repair mech selection blocked: ${JSON.stringify(finalLayout)}`);
    assert.equal(finalLayout.actionOverlap || finalLayout.submitOverlap, false, `${lang}: cards covered: ${JSON.stringify(finalLayout)}`);
    if (screenshots) await page.screenshot({ path: join(screenshots, `multi-${lang}-touch-confirm-390x844.png`) });
    assert.deepEqual(errors, []);
    console.log(`${lang}: three threat sources, layered repair target, emulated touch preview/cancel/confirm and portrait card layout passed`);
    await context.close();
  }
} finally { await browser.close(); }
console.log("Synthetic in-memory fixture with Chromium/emulated touch; not a native or human usability acceptance.");
