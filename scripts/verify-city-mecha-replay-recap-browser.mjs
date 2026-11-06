#!/usr/bin/env node
// Actual local PvE playback and saved archive; City data is synthetic.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178/?fixtureSessions=30";
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) {
    const zh = lang === "zh";
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(90000);
    await page.route("**/src/engine/CityEngine.ts*", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("if (this.documentHidden) return;", "if (this.documentHidden || window.__pauseFixtureDraw) return;") });
    });
    await page.route("**/src/game/MechaBoard.tsx*", async route => {
      const response = await route.fetch(); let body = await response.text();
      const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
      assert.ok(body.includes(needle));
      body = body.replace(needle, needle + '\nwindow.__replayController = controllerRef.current;');
      const siteNeedle = 'const site = safeCatalog[shapeId] ?? null;';
      assert.ok(body.includes(siteNeedle));
      body = body.replace(siteNeedle, siteNeedle + '\nwindow.__replaySites = { safeCatalog, shapeId, site };');
      await route.fulfill({ response, body });
    });
    await page.addInitScript(locale => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, zh ? "zh-Hans" : "en");
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
    await page.waitForFunction(() => window.__replayController?.getState().match.phase === "deployment");
    const finish = await page.evaluate(() => {
      const c = window.__replayController, cells = c.getState().deployment.cells;
      ["Assault", "Gunner", "Support"].forEach((id, i) => c.placeMech(id, cells[i]));
      if (!c.getState().deployment.canConfirm) throw new Error("invalid deployment");
      c.confirmDeployment(); window.__pauseFixtureDraw = true; c.startAuto();
      for (let i = 0; i < 100 && !c.getState().match.outcome; i++) { c.tick(); if (c.getState().performance) c.finishPerformance(); }
      return { outcome: c.getState().match.outcome, count: c.getState().replayAvailable, match: JSON.stringify(c.getState().match), log: JSON.stringify(c.getState().lastLog) };
    });
    assert.ok(finish.outcome && finish.count >= 2);
    const dialog = page.locator("[data-mecha-result-dialog]"); await dialog.waitFor({ state: "visible" });
    const bar = page.locator("[data-mecha-replay]");
    async function checkRecap(source) {
      await bar.waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => window.__replayController.getState().replay.source), source);
      await bar.locator("[data-replay-pause]").click();
      const toggle = bar.locator("[data-replay-recap-toggle]");
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      // The normal, collapsed replay controls must stay at the bottom too,
      // without clipping the exit or navigation controls on narrow screens.
      for (const viewport of [{width:1100,height:700},{width:640,height:480},{width:390,height:844}]) {
        await page.setViewportSize(viewport);
        const rect = await bar.evaluate(el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,sw:el.scrollWidth,cw:el.clientWidth,sh:el.scrollHeight,ch:el.clientHeight}; });
        assert.ok(rect.x >= -1 && rect.y >= -1 && rect.right <= viewport.width+1 && Math.abs(viewport.height-rect.bottom-12)<=1, `${lang} ${source} collapsed bounds ${JSON.stringify(rect)}`);
        assert.ok(rect.sw <= rect.cw+1 && rect.sh <= rect.ch+1, `${lang} ${source} collapsed controls clipped ${JSON.stringify(rect)}`);
        for (const selector of ["[data-replay-turn]", "[data-replay-previous]", "[data-replay-next]", "[data-replay-pause]", "[data-mecha-replay-exit]"]) {
          const visible = await bar.locator(selector).evaluate(el => { const r=el.getBoundingClientRect(), p=el.closest("[data-mecha-replay]").getBoundingClientRect(); return r.left >= p.left-1 && r.right <= p.right+1 && r.top >= p.top-1 && r.bottom <= p.bottom+1; });
          assert.ok(visible, `${lang} ${source} ${viewport.width}: ${selector} should be visible`);
        }
        await page.screenshot({ path:`/tmp/mecha-replay-bottom-${source}-${lang}-${viewport.width}.png` });
      }
      await page.setViewportSize({width:1100,height:700});
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      const recap = bar.locator("[data-replay-recap]");
      await recap.getByText(zh ? "完整记录可能包含尚未播出的事件。" : "The full record may include events not yet shown in the animation.").waitFor();
      for (const index of [0, finish.count - 1, 0]) {
        await bar.locator("[data-replay-turn]").selectOption(String(index));
        const actual = await page.evaluate(() => {
          const r = window.__replayController.getState().replay, tl = r.combat.healthTimeline;
          const result = { index:r.index, fizzles:r.log.filter(e => e.type === "act" && e.fizzled).length, count:r.log.length, failed:!!r.after.outcome && r.after.outcome !== "victory", health:null };
          if (tl?.ok) {
            const enemies = new Set(); let mech = 0, building = 0;
            for (const {effect:e} of tl.steps) { const loss=Math.max(0,e.before-e.after); if(e.kind==='mech') mech+=loss; else if(e.kind==='building') building+=loss; else if((e.kind==='boss'||e.kind==='raider')&&e.before>0&&e.after<=0) enemies.add(`${e.kind}:${e.id}`); }
            result.health=[enemies.size, result.fizzles, mech, building].map(String);
          }
          return result;
        });
        assert.equal(actual.index, index);
        assert.equal(await recap.locator("[data-failure-recap]").count(), actual.failed ? 1 : 0, "failure recap belongs to selected turn");
        if (actual.count) {
          const stats = await recap.locator("[data-turn-recap] dd").allTextContents();
          assert.deepEqual(stats, actual.health ?? ["—", String(actual.fizzles), "—", "—"]);
          const details = recap.locator("details"); if (!await details.evaluate(el => el.open)) await details.locator("summary").click();
          assert.equal(await details.locator("ol").first().locator("li").count(), actual.count, "all selected-turn events are listed");
        }
      }
      // Collapse the verbose event list before inspecting each responsive layout.
      const details = recap.locator("details"); if (await details.evaluate(el => el.open)) await details.locator("summary").click();
      for (const viewport of [{width:1100,height:700},{width:640,height:480},{width:390,height:844}]) {
        await page.setViewportSize(viewport);
        const rect = await bar.evaluate(el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,sw:el.scrollWidth,cw:el.clientWidth,sh:el.scrollHeight,ch:el.clientHeight}; });
        assert.ok(rect.x >= -1 && rect.y >= -1 && rect.right <= viewport.width+1 && Math.abs(viewport.height-rect.bottom-12)<=1, `${lang} ${source} bounds ${JSON.stringify(rect)}`);
        assert.ok(rect.sw <= rect.cw+1 && rect.sh <= rect.ch+1, `${lang} ${source} controls should not be clipped ${JSON.stringify(rect)}`);
        const recapBounds = await recap.evaluate(el => { const a=el.getBoundingClientRect(), b=el.querySelector("[data-turn-recap]")?.getBoundingClientRect(); return b && {top:a.top,bottom:a.bottom,statsTop:b.top,statsBottom:b.bottom}; });
        assert.ok(!recapBounds || (recapBounds.statsTop >= recapBounds.top-1 && recapBounds.statsBottom <= recapBounds.bottom+1), `${lang} ${source} summary stats visible ${JSON.stringify(recapBounds)}`);
        await page.screenshot({ path:`/tmp/mecha-replay-recap-${source}-${lang}-${viewport.width}.png` });
        await bar.locator("[data-replay-next]").click();
        assert.equal(await page.evaluate(() => window.__replayController.getState().replay.index), 1);
        await bar.locator("[data-replay-previous]").click();
      }
      await toggle.click(); assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await bar.locator("[data-mecha-replay-exit]").click(); await bar.waitFor({ state:"hidden" });
      await page.setViewportSize({ width:1100, height:700 });
    }
    await dialog.locator("[data-result-replay]").click();
    await checkRecap("current");
    assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().match)), finish.match);
    assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().lastLog)), finish.log);
    await dialog.waitFor({ state:"visible" });
    await dialog.getByRole("status").getByText(zh ? "本局回放已自动保存到本机。" : "This battle replay was saved locally automatically.").waitFor();
    await dialog.locator("[data-result-restart]").click();
    await page.waitForFunction(() => window.__replayController.getState().match.phase === "deployment");
    const historicalShape = await page.evaluate(() => window.__replaySites.shapeId);
    await page.locator('[data-mecha-settings-trigger="battlefield"]').click();
    const shape = page.locator("#mecha-battlefield-settings .mecha-toolbar label").first().locator("select");
    const alternative = await shape.locator("option:not([disabled])").evaluateAll((options, current) => options.map(o => o.value).find(value => value !== current), historicalShape);
    assert.ok(alternative);
    await shape.selectOption(alternative);
    await page.waitForFunction(value => window.__replaySites.shapeId === value, alternative);
    const before = await page.evaluate(() => JSON.stringify(window.__replayController.getState().match));
    await page.locator("[data-archive-play]").click();
    await bar.getByText(zh ? "历史战场回放 · 结束后返回当前对局" : "Historical battlefield · Your current match resumes afterward").waitFor();
    await checkRecap("saved");
    assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().match)), before);
    assert.deepEqual(errors, []);
    console.log(`${lang}: current and saved historical recaps, turn navigation and responsive controls verified`);
    await page.close();
  }
} finally { await browser.close(); }
