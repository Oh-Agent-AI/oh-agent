#!/usr/bin/env node
// Exercise a real local PvE match, local storage, reload, and replay UI in a synthetic City.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
const base = process.argv[2] ?? "http://127.0.0.1:5190/?fixtureSessions=30";
const prefix = "agent-city:mecha-local-replay-entry:v1:";
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) {
    const zh = lang === "zh";
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
    page.setDefaultTimeout(90000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
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
    await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
      const response = await route.fetch(); let body = await response.text();
      const needle = 'const root = new THREE.Group();';
      assert.ok(body.includes(needle));
      body = body.replace(needle, 'window.__worldEffectSite = site;\n' + needle);
      await route.fulfill({ response, body });
    });
    await page.addInitScript(locale => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, zh ? "zh-Hans" : "en");
    async function enter() {
      await page.locator(".city-loading").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
      await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
      await page.waitForFunction(() => window.__replayController?.getState().match.phase === "deployment");
    }
    async function settings() {
      await page.locator('[data-mecha-settings-trigger="battlefield"]').click();
      await page.locator("#mecha-battlefield-settings").waitFor({ state: "visible" });
    }
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 240000 }); await enter();
    const finish = await page.evaluate(() => {
      const c = window.__replayController; const cells = c.getState().deployment.cells;
      ["Assault", "Gunner", "Support"].forEach((id, i) => c.placeMech(id, cells[i]));
      if (!c.getState().deployment.canConfirm) throw new Error("test deployment was invalid");
      c.confirmDeployment(); window.__pauseFixtureDraw = true; c.startAuto();
      for (let i = 0; i < 100 && !c.getState().match.outcome; i++) { c.tick(); if (c.getState().performance) c.finishPerformance(); }
      return { outcome: c.getState().match.outcome, count: c.getState().replayAvailable };
    });
    assert.ok(finish.outcome && finish.count > 0, JSON.stringify(finish));
    const dialog = page.locator("[data-mecha-result-dialog]"); await dialog.waitFor({ state: "visible" });
    assert.equal(await page.evaluate(prefix => Object.keys(localStorage).filter(k => k.startsWith(prefix)).length, prefix), 0, "not saved without user consent");
    await dialog.locator("[data-result-save-replay]").click();
    await dialog.getByRole("status").getByText(zh ? "回放已保存到本机，可在战场设置中打开。" : "Replay saved locally. Open it from battlefield settings.").waitFor();
    const key = await page.evaluate(prefix => Object.keys(localStorage).find(k => k.startsWith(prefix)), prefix);
    const archive = await page.evaluate(key => localStorage.getItem(key), key);
    const stored = JSON.parse(JSON.parse(archive).archive); assert.equal(stored.schema, "mecha-local-replay:v1");
    assert.equal(stored.deployment, true); assert.ok(!("site" in stored) && !("events" in stored));
    await page.evaluate(() => { window.__pauseFixtureDraw = false; });
    for (const viewport of [{ width: 1100, height: 700 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const bounds = await dialog.evaluate(el => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom }; });
      assert.ok(bounds.x >= -1 && bounds.y >= -1 && bounds.right <= viewport.width + 1 && bounds.bottom <= viewport.height + 1, `${lang}: result bounds ${JSON.stringify(bounds)}`);
      await page.screenshot({ path: `/tmp/mecha-saved-result-${lang}-${viewport.width}.png` });
    }
    await page.setViewportSize({ width: 1100, height: 700 });
    await dialog.getByRole("button", { name: zh ? "新开一局" : "New match" }).click();
    await page.waitForFunction(() => window.__replayController.getState().match.phase === "deployment");
    const nextFinish = await page.evaluate(() => {
      const c = window.__replayController; const cells = c.getState().deployment.cells;
      ["Assault", "Gunner", "Support"].forEach((id, i) => c.placeMech(id, cells[cells.length - 1 - i]));
      if (!c.getState().deployment.canConfirm) throw new Error("second deployment was invalid");
      c.confirmDeployment(); window.__pauseFixtureDraw = true; c.startAuto();
      for (let i = 0; i < 100 && !c.getState().match.outcome; i++) { c.tick(); if (c.getState().performance) c.finishPerformance(); }
      return c.getState().match.outcome;
    });
    assert.ok(nextFinish); await dialog.waitFor({ state: "visible" });
    await dialog.locator("[data-result-save-replay]").click();
    await dialog.getByRole("status").getByText(zh ? "回放已保存到本机，可在战场设置中打开。" : "Replay saved locally. Open it from battlefield settings.").waitFor();
    const secondKey = await page.evaluate(({ prefix, key }) => Object.keys(localStorage).find(k => k.startsWith(prefix) && k !== key), { prefix, key });
    assert.ok(secondKey); assert.equal(await page.evaluate(key => localStorage.getItem(key), key), archive, "second save did not replace first");
    await page.evaluate(() => { window.__pauseFixtureDraw = false; });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 240000 }); await enter();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), archive, "archive survives a full reload");
    const historicalShape = await page.evaluate(() => window.__replaySites.shapeId);
    await settings();
    const shapeControl = page.locator("#mecha-battlefield-settings .mecha-toolbar label").first().locator("select");
    const alternativeShape = await shapeControl.locator("option:not([disabled])").evaluateAll((options, current) => options.map(o => o.value).find(value => value !== current), historicalShape);
    assert.ok(alternativeShape, `fixture must have a second battlefield (current ${historicalShape})`);
    await shapeControl.selectOption(alternativeShape);
    await page.waitForFunction(shape => window.__replaySites.shapeId === shape && window.__worldEffectSite === window.__replaySites.site, alternativeShape);
    await page.locator("#mecha-battlefield-settings .mecha-settings-close").click();
    await page.waitForFunction(() => window.__replayController.getState().match.phase === "deployment");
    const before = await page.evaluate(() => {
      const c = window.__replayController; c.placeMech("Assault", c.getState().deployment.cells[0]);
      const s = c.getState(); return JSON.stringify({ match:s.match, draft:s.draft, placements:s.deployment.placements, log:s.lastLog });
    });
    await settings();
    assert.equal(await page.locator("[data-archive-select] option").count(), 2);
    for (const viewport of [{ width: 1100, height: 700 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.locator("[data-archive-select]").scrollIntoViewIfNeeded();
      const bounds = await page.locator("[data-archive-select]").boundingBox();
      assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1, `${lang}: archive selection is not clipped`);
      await page.screenshot({ path: `/tmp/mecha-replay-library-${lang}-${viewport.width}.png` });
    }
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.locator("[data-archive-select]").selectOption(key);
    await page.locator("[data-archive-play]").click();
    const bar = page.locator("[data-mecha-replay]"); await bar.waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.__replayController.getState().replay.source), "saved");
    await page.waitForFunction(shape => JSON.stringify(window.__worldEffectSite) === JSON.stringify(window.__replaySites.safeCatalog[shape]), historicalShape);
    assert.equal(await page.evaluate(() => window.__replaySites.shapeId), alternativeShape, "live shape must not change during historical playback");
    await bar.getByText(zh ? "历史战场回放 · 结束后返回当前对局" : "Historical battlefield · Your current match resumes afterward").waitFor();
    await bar.getByRole("button", { name: zh ? "暂停演出" : "Pause animation" }).click();
    const total = await page.evaluate(() => window.__replayController.getState().replay.total);
    assert.ok(total >= 2, "historical replay needs multiple turns for navigation");
    const previous = bar.getByRole("button", { name: zh ? "上一回合" : "Previous turn" });
    const next = bar.getByRole("button", { name: zh ? "下一回合" : "Next turn" });
    const restart = bar.getByRole("button", { name: zh ? "重播本回合" : "Replay this turn" });
    assert.equal(await previous.isDisabled(), true);
    await next.click();
    assert.equal(await page.evaluate(() => window.__replayController.getState().replay.index), 1);
    const cue = await page.evaluate(() => window.__replayController.getState().replay.combat.id);
    await restart.click();
    assert.ok(await page.evaluate(() => window.__replayController.getState().replay.combat.id) > cue);
    assert.equal(await page.evaluate(() => window.__replayController.getState().paused), true);
    const speed = bar.getByRole("combobox", { name: zh ? "播放速度" : "Playback speed" });
    await speed.selectOption("2");
    assert.equal(await speed.inputValue(), "2");
    assert.equal(await page.evaluate(() => window.__replayController.getState().paused), true);
    await previous.click();
    assert.equal(await page.evaluate(() => window.__replayController.getState().replay.index), 0);
    await bar.locator("[data-replay-turn]").selectOption(String(total - 1));
    assert.equal(await next.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__replayController.getState().replay.index), total - 1);
    for (const viewport of [{ width: 1100, height: 700 }, { width: 640, height: 480 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const bounds = await bar.evaluate(el => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom }; });
      assert.ok(bounds.x >= -1 && bounds.y >= -1 && bounds.right <= viewport.width + 1 && bounds.bottom <= viewport.height + 1, `${lang}: replay bounds ${JSON.stringify(bounds)}`);
      assert.ok(Math.abs(viewport.height - bounds.bottom - 12) <= 1, `${lang}: replay controls are anchored at the bottom ${JSON.stringify(bounds)}`);
      await page.screenshot({ path: `/tmp/mecha-saved-replay-${lang}-${viewport.width}.png` });
    }
    await bar.locator("[data-mecha-replay-exit]").click();
    await bar.waitFor({ state: "hidden" });
    await page.waitForFunction(() => window.__worldEffectSite === window.__replaySites.site);
    assert.equal(await page.evaluate(() => window.__replaySites.shapeId), alternativeShape);
    assert.equal(await dialog.count(), 0, "saved replay does not show the old result");
    const after = await page.evaluate(() => { const s = window.__replayController.getState(); return JSON.stringify({ match:s.match, draft:s.draft, placements:s.deployment.placements, log:s.lastLog }); });
    assert.equal(after, before, "current deployment and match are preserved");
    await page.setViewportSize({ width: 1100, height: 700 });
    await settings(); await page.locator("[data-archive-select]").selectOption(secondKey);
    await page.locator("[data-archive-play]").click(); await bar.waitFor({ state: "visible" });
    await page.waitForFunction(shape => JSON.stringify(window.__worldEffectSite) === JSON.stringify(window.__replaySites.safeCatalog[shape]), historicalShape);
    await page.evaluate(() => { const c = window.__replayController; while (c.getState().replay) c.finishPerformance(); });
    await bar.waitFor({ state: "hidden" });
    await page.waitForFunction(() => window.__worldEffectSite === window.__replaySites.site);
    assert.equal(await page.evaluate(() => { const s = window.__replayController.getState(); return JSON.stringify({ match:s.match, draft:s.draft, placements:s.deployment.placements, log:s.lastLog }); }), before, "natural completion preserves current deployment");
    await page.evaluate(key => localStorage.setItem(key, "{broken"), key);
    await settings(); await page.locator("[data-archive-select]").selectOption(key); await page.locator("[data-archive-play]").click();
    await page.getByRole("status").getByText(zh ? "回放记录已损坏或格式不支持。" : "The replay is corrupt or its format is unsupported.").waitFor();
    await page.evaluate(({ key, archive }) => { const value = JSON.parse(archive); const inner = JSON.parse(value.archive); inner.ruleset = "future"; value.archive = JSON.stringify(inner); localStorage.setItem(key, JSON.stringify(value)); }, { key, archive });
    await page.locator("[data-archive-play]").click();
    await page.getByRole("status").getByText(zh ? "回放与当前城市的可用战场或规则不兼容，无法播放。" : "This replay is incompatible with this city’s available battlefields or the current rules.").waitFor();
    // Block Web Crypto in the middle of validation; a new match must cancel
    // the pending read rather than start playback over the new match.
    await page.evaluate(({ key, archive }) => {
      localStorage.setItem(key, archive);
      const subtle = crypto.subtle; const original = subtle.digest.bind(subtle);
      let release; const gate = new Promise(resolve => { release = resolve; });
      window.__digestGate = { entered: false, release, restore: () => { subtle.digest = original; } };
      subtle.digest = async (...args) => { window.__digestGate.entered = true; await gate; return original(...args); };
    }, { key, archive });
    await page.locator("[data-archive-play]").click();
    await page.waitForFunction(() => window.__digestGate.entered);
    await page.evaluate(() => { window.__replayController.restart(); window.__digestGate.release(); });
    await page.getByRole("status").getByText(zh ? "战局已变化，本次操作已取消。" : "The battle changed; the operation was cancelled.").waitFor();
    assert.equal(await page.evaluate(() => window.__replayController.getState().replay), null);
    await page.evaluate(() => window.__digestGate.restore());
    // Denied local storage is surfaced instead of presenting an empty replay.
    await page.evaluate(key => {
      const original = Storage.prototype.getItem;
      window.__restoreStorage = () => { Storage.prototype.getItem = original; };
      Storage.prototype.getItem = function(k) { if (k === key) throw new Error("blocked"); return original.call(this, k); };
    }, key);
    await page.locator("[data-archive-play]").click();
    await page.getByRole("status").getByText(zh ? "本地存储不可用或空间不足，操作未完成。" : "Local storage is unavailable or full; the operation was not completed.").waitFor();
    await page.evaluate(() => window.__restoreStorage());
    await page.locator("[data-archive-delete]").click();
    assert.ok(await page.evaluate(key => localStorage.getItem(key), key), "delete requires confirmation");
    await page.locator("[data-archive-delete-confirm]").click();
    await page.getByRole("status").getByText(zh ? "本机回放已删除。" : "Local replay deleted.").waitFor();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
    assert.ok(await page.evaluate(key => localStorage.getItem(key), secondKey), "deleting one replay preserves the other");
    assert.deepEqual(errors, []);
    console.log(`${lang}: deployed, finished, saved two separate matches, reloaded, replayed both, switched historical battlefield and restored live deployment, rejected corrupt/incompatible save, storage denial and stale read; deleted; ${finish.count} turns`);
    await page.close();
  }
} finally { await browser.close(); }
