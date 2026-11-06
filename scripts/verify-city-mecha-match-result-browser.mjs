#!/usr/bin/env node
// Integration fixtures go through the real controller, turn rules, playback gate and UI.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5190";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
const cases = [
  { id: "victory", zh: "所有敌人已被消灭。", en: "All enemies eliminated." },
  { id: "defeat_buildings", zh: "防守建筑全部失守。", en: "All defended buildings were lost." },
  { id: "defeat_wipe", zh: "机甲全部失守。", en: "All mechs were lost." },
  { id: "defeat_timeout", zh: "回合耗尽，未完成目标。", en: "The turn limit was reached before the objective was completed." },
];
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) for (const scenario of cases.filter(item => !process.env.MECHA_RESULT_CASE || item.id === process.env.MECHA_RESULT_CASE)) {
    const zh = lang === "zh";
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
    page.setDefaultTimeout(90000);
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/src/engine/CityEngine.ts*", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("if (this.documentHidden) return;", "if (this.documentHidden || window.__pauseFixtureDraw) return;") });
    });
    await page.route("**/src/game/MechaBoard.tsx*", async route => {
      const response = await route.fetch();
      let body = await response.text();
      const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
      assert.ok(body.includes(needle));
      body = 'import { createMatch as fixtureMatch, bossPrepare as prepareFixture } from "/src/game/mecha/rules.ts";\n' + body;
      body = body.replace(needle, `const scenario = ${JSON.stringify(scenario.id)};
        const fixture = fixtureMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 7, y: 0 },
          buildings: [{ id: "defended", cells: [{ x: 3, y: 3 }], hp: 3 }],
          raiders: [{ id: "raider-w", pos: scenario === "defeat_buildings" ? { x: 2, y: 3 } : { x: 5, y: 6 } }],
          mechs: [{ id: "Assault", pos: { x: 6, y: 6 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }] });
        fixture.boss.hp = scenario === "defeat_timeout" ? fixture.boss.hp : 0;
        if (scenario === "defeat_timeout") fixture.turn = 15;
        if (scenario === "defeat_wipe") { fixture.mechs[0].hp = 1; fixture.mechs[1].hp = 0; fixture.mechs[2].hp = 0; }
        if (scenario === "victory") fixture.raiders[0].hp = 1;
        prepareFixture(fixture);
        fixture.boss.intent = { skillId: "skip", local: [], projected: [], cdSweep: 0, status: "planned" };
        const target = scenario === "defeat_buildings" ? { x: 3, y: 3 } : { x: 6, y: 6 };
        fixture.raiders[0].pos = scenario === "defeat_buildings" ? { x: 2, y: 3 } : { x: 5, y: 6 };
        fixture.raiders[0].intent = scenario === "victory" || scenario === "defeat_timeout"
          ? { skillId: "skip", local: [], projected: [], cdSweep: 0, status: "planned" }
          : { skillId: "smash", local: [{ x: 1, y: 0 }], projected: [target], cdSweep: 0, status: "planned" };
        controllerRef.current = createMechaController({ animate: true, locale, site, match: fixture });
        window.__resultController = controllerRef.current;`);
      await route.fulfill({ response, body });
    });
    await page.addInitScript(locale => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, zh ? "zh-Hans" : "en");
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
    await page.waitForFunction(() => window.__resultController?.getState().match.phase === "player_plan");
    await page.evaluate(() => { window.__pauseFixtureDraw = true; });
    const start = await page.evaluate(id => {
      const c = window.__resultController;
      for (const mech of c.getState().match.mechs.filter(m => m.hp > 0)) { c.setMove(mech.id, null); c.setAction(mech.id, id === "victory" && mech.id === "Assault" ? { kind: "melee", target: "raider-w" } : { kind: "skip" }); }
      // Ensure timeout has a real movement event so its playback gate is exercised too.
      if (id === "defeat_timeout") c.setMove("Assault", { x: 6, y: 7 });
      c.submit();
      if (c.getState().holdConfirmation) c.confirmHold();
      c.pause();
      return { outcome: c.getState().match.outcome, performance: Boolean(c.getState().performance), fault: c.getState().fault, log: c.getState().lastLog, state: c.getState().match };
    }, scenario.id);
    assert.equal(start.outcome, scenario.id, `${lang}/${scenario.id} actual rules: ${JSON.stringify(start)}`);
    assert.equal(start.performance, true, `${lang}/${scenario.id} presentation active`);
    assert.equal(await page.locator("[data-mecha-result-dialog]").count(), 0, "no result dialog while performance is paused");
    await page.evaluate(() => window.__resultController.finishPerformance());
    const dialog = page.locator("[data-mecha-result-dialog]");
    await dialog.waitFor({ state: "visible" });
    assert.equal(await dialog.evaluate(el => el.matches(":modal")), true, "native modal blocks battlefield interactions");
    assert.equal(await page.locator(".mecha-objective-paused").count(), 0, "terminal result is not labelled paused after skipping playback");
    assert.ok(!(await page.locator("#mecha-submit-status").innerText()).includes(zh ? "演出暂停中" : "Playback is paused"));
    assert.ok((await dialog.innerText()).includes(zh ? scenario.zh : scenario.en));
    assert.ok((await dialog.innerText()).includes(zh ? scenario.id === "victory" ? "战斗胜利" : "战斗失败" : scenario.id === "victory" ? "Victory" : "Defeat"));
    assert.ok(!(await dialog.innerText()).includes("Translation unavailable"));
    if (scenario.id === "defeat_timeout") assert.match(await dialog.innerText(), /15\s*\/\s*15/);
    await page.evaluate(() => { window.__pauseFixtureDraw = true; });
    for (const viewport of [{ width: 1100, height: 700 }, { width: 640, height: 480 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const bounds = await dialog.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, h: r.height }; });
      assert.ok(bounds.h > 0 && bounds.x >= -1 && bounds.y >= -1 && bounds.right <= viewport.width + 1 && bounds.bottom <= viewport.height + 1, `${lang}/${scenario.id}: dialog viewport ${JSON.stringify(bounds)}`);
      const stats = await dialog.locator(".mecha-match-result__stats > div").evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top, left: rect.left, right: rect.right };
      }));
      assert.equal(stats.length, 3);
      assert.ok(stats.every(item => Math.abs(item.top - stats[0].top) < 1), `${lang}/${scenario.id}: statistics should share a row`);
      assert.ok(stats[0].right <= stats[1].left && stats[1].right <= stats[2].left, `${lang}/${scenario.id}: statistics must not overlap`);
      for (const button of await dialog.locator("button").all()) {
        await button.scrollIntoViewIfNeeded();
        assert.ok(await button.isVisible());
      }
      if (screenshots && ["victory", "defeat_buildings"].includes(scenario.id)) await page.screenshot({ path: join(screenshots, `${scenario.id}-${lang}-${viewport.width}x${viewport.height}.png`) });
    }
    const buttons = await dialog.locator("button").allTextContents();
    assert.deepEqual(buttons.map(text => text.trim()), zh ? ["重播", "再开一局", "退出战斗"] : ["Replay Match", "New Match", "Exit Battle"]);
    const replayButton = dialog.locator("[data-result-replay]");
    await replayButton.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("[data-result-replay]")?.disabled);
    await replayButton.focus();
    await page.keyboard.press("Tab");
    assert.equal(await dialog.locator("[data-result-restart]").evaluate(el => el === document.activeElement), true, "keyboard focus stays in modal");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await replayButton.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    const trigger = page.getByRole("button", { name: zh ? "查看结算" : "View result" });
    await trigger.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("mecha-result-reopen"));
    assert.equal(await page.locator(".mecha-overlay.has-match").count(), 1, "Escape dismisses result, not battle");
    assert.equal(await page.locator(".mecha-tactical-legend").count(), 0, "no next-turn risk after terminal result");
    assert.equal(await page.locator(".mecha-plan-card__risk").count(), 0);
    await trigger.click();
    await dialog.waitFor({ state: "visible" });
    if (scenario.id === "victory") {
      await dialog.locator("[data-result-restart]").click();
      if (await page.locator("[data-replay-unsaved-guard]").isVisible()) await page.locator("[data-replay-guard-confirm]").click();
      await page.waitForFunction(() => window.__resultController.getState().match.phase === "deployment");
      assert.equal(await dialog.count(), 0, "restart starts deployment and clears result");
      assert.ok(await page.locator(".mecha-tactical-legend").count());
    } else if (scenario.id === "defeat_buildings") {
      await dialog.locator("[data-result-exit]").click();
      if (await page.locator("[data-replay-unsaved-guard]").isVisible()) await page.locator("[data-replay-guard-confirm]").click();
      await page.locator(".mecha-overlay.has-match").waitFor({ state: "hidden" });
    }
    assert.deepEqual(errors, []);
    console.log(`${lang}/${scenario.id}: real result, playback gate, modal, 3 viewports, Escape, reopen and lifecycle passed`);
    await page.close();
  }
} finally { await browser.close(); }
