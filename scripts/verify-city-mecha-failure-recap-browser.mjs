#!/usr/bin/env node
// Synthetic browser integration: real controller, rules, UI, and reconciled HP log.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5190";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) {
    const zh = lang === "zh";
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
    page.setDefaultTimeout(90000);
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/src/engine/CityEngine.ts*", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({ response, body: body.replace("if (this.documentHidden) return;", "if (this.documentHidden || window.__pauseFixtureDraw) return;") });
    });
    await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
      assert.ok(body.includes(needle), "controller fixture hook changed");
      body = 'import { createMatch as fixtureMatch, bossPrepare as prepareFixture } from "/src/game/mecha/rules.ts";\n' + body;
      body = body.replace(needle, `const fixture = fixtureMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 7, y: 0 },
        buildings: [{ id: "defended", cells: [{ x: 3, y: 3 }], hp: 3 }],
        raiders: [{ id: "raider-w", pos: { x: 2, y: 3 } }],
        mechs: [{ id: "Assault", pos: { x: 6, y: 6 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }] });
        fixture.boss.hp = 0; prepareFixture(fixture);
        fixture.raiders[0].pos = { x: 2, y: 3 };
        fixture.raiders[0].intent = { skillId: "smash", local: [{ x: 1, y: 0 }], projected: [{ x: 3, y: 3 }], cdSweep: 0, status: "planned" };
        controllerRef.current = createMechaController({ animate: true, locale, site, match: fixture });
        window.__failureController = controllerRef.current;`);
      await route.fulfill({ response, body });
    });
    await page.addInitScript((locale) => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, zh ? "zh-Hans" : "en");
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
    await page.waitForFunction(() => window.__failureController?.getState().match.phase === "player_plan");
    await page.evaluate(() => { for (const id of ["Assault", "Gunner", "Support"]) window.__failureController.setAction(id, { kind: "skip" }); });
    await page.locator(".mecha-submit-primary").click();
    await page.getByRole("button", { name: zh ? "继续提交" : "Submit anyway" }).click();
    await page.waitForFunction(() => window.__failureController.getState().performance !== null);
    assert.equal(await page.locator("[data-failure-recap]").count(), 0, "no outcome before playback ends");
    await page.getByRole("button", { name: zh ? "跳过演出" : "Skip animation" }).click();
    await page.waitForFunction(() => window.__failureController.getState().match.outcome === "defeat_buildings" && !window.__failureController.getState().performance);
    await page.evaluate(() => { window.__pauseFixtureDraw = true; });
    const result = page.locator("[data-mecha-result-dialog]");
    await result.waitFor({ state: "visible" });
    assert.ok((await result.innerText()).includes(zh ? "战斗失败" : "Defeat"));
    await result.locator("[data-result-view]").click();
    await result.waitFor({ state: "hidden" });
    const recap = page.getByRole("region", { name: zh ? "上一回合摘要" : "Previous turn summary", exact: true });
    const failure = recap.locator("[data-failure-recap]");
    await failure.waitFor({ state: "visible" });
    const text = await failure.innerText();
    for (const part of zh ? ["失败复盘", "最终回合 1", "防守建筑全部失守", "建筑 defended", "小怪西", "砸击"] : ["Defeat review", "Final turn 1", "All defended buildings were lost", "Building defended", "West raider", "Smash"]) {
      assert.ok(text.includes(part), `${lang}: expected ${part} in ${text}`);
    }
    assert.equal(await page.evaluate(() => window.__failureController.getState().combat.healthTimeline.ok), true);
    for (const viewport of [{ width: 1100, height: 700 }, { width: 640, height: 480 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(350);
      assert.ok(await recap.isVisible(), `${lang} ${viewport.width}: summary visible`);
      const bounds = await recap.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height, scroll: el.scrollHeight, client: el.clientHeight }; });
      assert.ok(bounds.w > 0 && bounds.h > 0 && bounds.x >= -1 && bounds.y >= -1 && bounds.right <= viewport.width + 1 && bounds.bottom <= viewport.height + 1, `${lang} ${viewport.width}: recap viewport bounds ${JSON.stringify(bounds)}`);
      await recap.evaluate(el => { el.scrollTop = 0; });
      const headingVisible = await failure.locator("strong").evaluate(el => { const r = el.getBoundingClientRect(), b = el.closest('.mecha-last-result').getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1; });
      assert.ok(headingVisible, `${lang} ${viewport.width}: initial failure heading must be visible`);
      if (screenshots) await page.screenshot({ path: join(screenshots, `failure-${lang}-${viewport.width}x${viewport.height}.png`) });
      // The final event remains reachable in the result's scrollport on narrow screens.
      const decisive = recap.locator("[data-failure-decisive]");
      await decisive.scrollIntoViewIfNeeded();
      const inRail = await decisive.evaluate(el => { const r = el.getBoundingClientRect(), rail = el.closest('.mecha-last-result'), b = rail.getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.left >= b.left - 1 && r.right <= b.right + 1; });
      assert.ok(inRail, `${lang} ${viewport.width}: decisive loss reachable`);
      const disclosure = recap.locator("details > summary");
      await disclosure.scrollIntoViewIfNeeded();
      await disclosure.focus();
      await page.keyboard.press("Enter");
      assert.equal(await recap.locator("details").evaluate(el => el.open), true);
      assert.equal(await disclosure.evaluate(el => document.activeElement === el), true);
      await page.keyboard.press("Enter");
      assert.equal(await recap.locator("details").evaluate(el => el.open), false);
      const overlap = await recap.evaluate(el => { const a = el.getBoundingClientRect(); return [...document.querySelectorAll('.mecha-submit, .mecha-selected-actions')].filter(other => { const b = other.getBoundingClientRect(), style = getComputedStyle(other); return style.display !== 'none' && style.visibility !== 'hidden' && b.width > 0 && b.height > 0 && b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top; }).map(e => e.className); });
      assert.deepEqual(overlap, [], `${lang} ${viewport.width}: recap must not overlap actions`);
    }
    assert.deepEqual(errors, []);
    console.log(`${lang}: real terminal rule, playback gating, localized review, scroll and keyboard on 3 viewports passed`);
    await page.close();
  }
} finally { await browser.close(); }
