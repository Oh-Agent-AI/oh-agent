#!/usr/bin/env node
// Synthetic City UI regression; this is not a Tauri or remote-match test.
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
    page.setDefaultTimeout(60000);
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
      const snapshotNeedle = 'replaySnapshot.current = snapshot;';
      assert.ok(body.includes(snapshotNeedle));
      body = body.replace(snapshotNeedle, snapshotNeedle + ' window.__testReplaySnapshot = snapshot;');
      await route.fulfill({ response, body });
    });
    await page.addInitScript(locale => { localStorage.setItem("city.seed", "4196523069"); localStorage.setItem("agent-city:mecha-replay-auto-save:v1", "disabled"); window.__AV_PLUGIN_LOCALE__ = locale; }, zh ? "zh-Hans" : "en");
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
    await page.waitForFunction(() => window.__replayController?.getState().match.phase === "deployment");
    const result = page.locator("[data-mecha-result-dialog]");
    const guard = page.locator("[data-replay-unsaved-guard]");
    const cancel = guard.locator("[data-replay-guard-cancel]");
    const confirm = guard.locator("[data-replay-guard-confirm]");
    const restart = result.locator("[data-result-restart]");
    const exit = result.locator("[data-result-exit]");
    const matchSnapshot = () => page.evaluate(() => JSON.stringify(window.__replayController.getState().match));
    const unloadPrevented = () => page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
    async function finish() {
      const value = await page.evaluate(() => {
        const c = window.__replayController, cells = c.getState().deployment.cells;
        ["Assault", "Gunner", "Support"].forEach((id, i) => c.placeMech(id, cells[i]));
        c.confirmDeployment(); window.__pauseFixtureDraw = true; c.startAuto();
        for (let i = 0; i < 100 && !c.getState().match.outcome; i++) { c.tick(); if (c.getState().performance) c.finishPerformance(); }
        return { outcome: c.getState().match.outcome, rounds: c.getState().replayAvailable };
      });
      assert.ok(value.outcome && value.rounds, JSON.stringify(value));
      await result.waitFor({ state: "visible" });
    }
    async function openSettings() {
      await page.locator('[data-mecha-settings-trigger="battlefield"]').click();
      await page.locator("#mecha-battlefield-settings").waitFor({ state: "visible" });
    }
    await finish();
    const first = await matchSnapshot();
    assert.equal(await unloadPrevented(), true, "unsaved completed match warns on unload");
    await restart.click(); await guard.waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-replay-guard-cancel")), true);
    for (const viewport of [{ width: 1100, height: 700 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const bounds = await guard.evaluate(el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom }; });
      assert.ok(bounds.x >= -1 && bounds.y >= -1 && bounds.right <= viewport.width + 1 && bounds.bottom <= viewport.height + 1, `${lang}: ${JSON.stringify(bounds)}`);
      await page.screenshot({ path: `/tmp/mecha-replay-loss-${lang}-${viewport.width}.png` });
    }
    await page.keyboard.press("Escape"); await guard.waitFor({ state: "hidden" });
    assert.equal(await matchSnapshot(), first); assert.equal(await result.isVisible(), true);
    assert.equal(await restart.evaluate(el => el === document.activeElement), true, "Escape restores focus to the triggering button");
    // Real browser unload prompt after user interaction; dismissing preserves the match.
    const unloadDialog = page.waitForEvent("dialog");
    const abortedReload = page.reload({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => null);
    const prompt = await unloadDialog;
    assert.equal(prompt.type(), "beforeunload"); await prompt.dismiss(); await abortedReload;
    assert.equal(await matchSnapshot(), first);
    await exit.click(); await guard.waitFor({ state: "visible" }); await cancel.click(); await guard.waitFor({ state: "hidden" });
    assert.equal(await matchSnapshot(), first);
    await page.keyboard.press("Escape");
    await openSettings();
    const toolbar = page.locator("#mecha-battlefield-settings .mecha-toolbar");
    const shape = toolbar.locator("label").nth(0).locator("select"), script = toolbar.locator("label").nth(1).locator("select");
    const currentShape = await shape.inputValue();
    const otherShape = await shape.locator("option:not([disabled])").evaluateAll((options, current) => options.map(o => o.value).find(v => v !== current), currentShape);
    assert.ok(otherShape);
    await shape.selectOption(otherShape); await guard.waitFor({ state: "visible" });
    assert.equal(await shape.inputValue(), currentShape, "shape remains unchanged until confirmation");
    await cancel.click(); await guard.waitFor({ state: "hidden" });
    const currentScript = await script.inputValue();
    const otherScript = await script.locator("option").evaluateAll((options, current) => options.map(o => o.value).find(v => v !== current), currentScript);
    await script.selectOption(otherScript); await guard.waitFor({ state: "visible" });
    assert.equal(await script.inputValue(), currentScript); await cancel.click();
    await toolbar.getByRole("button", { name: zh ? "新开一局" : "New match" }).click();
    await guard.waitFor({ state: "visible" }); await cancel.click();
    assert.equal(await matchSnapshot(), first);
    await page.locator("#mecha-battlefield-settings .mecha-settings-close").click();
    await page.locator(".mecha-battle-menu summary").click();
    await page.locator(".mecha-battle-menu-items").getByRole("button", { name: zh ? "退出战斗" : "Exit battle" }).click();
    await guard.waitFor({ state: "visible" }); await cancel.click();
    await page.keyboard.press("Escape"); await guard.waitFor({ state: "visible" }); await cancel.click();
    assert.equal(await matchSnapshot(), first);
    // Save from battlefield settings; the settlement actions must remain disabled during validation.
    await openSettings();
    await page.evaluate(() => {
      const subtle = crypto.subtle, original = subtle.digest.bind(subtle);
      let release; const gate = new Promise(resolve => { release = resolve; });
      window.__saveGate = { entered: false, release, restore: () => { subtle.digest = original; } };
      subtle.digest = async (...args) => { window.__saveGate.entered = true; await gate; return original(...args); };
    });
    await page.locator("[data-archive-save-current]").click();
    await page.waitForFunction(() => window.__saveGate.entered);
    await page.locator("#mecha-battlefield-settings .mecha-settings-close").click();
    await page.getByRole("button", { name: zh ? "查看结算" : "View result" }).click();
    assert.equal(await restart.isDisabled(), true); assert.equal(await exit.isDisabled(), true);
    assert.equal(await unloadPrevented(), true);
    await page.evaluate(() => window.__saveGate.release());
    await result.getByRole("status").getByText(zh ? "回放已保存到本机，可在战场设置中打开。" : "Replay saved locally. Open it from battlefield settings.").waitFor();
    await page.evaluate(() => window.__saveGate.restore());
    assert.equal(await unloadPrevented(), false, "verified save suppresses unload warning");
    const db = (op, key, value) => page.evaluate(({ op, key, value }) => new Promise((resolve, reject) => {
      const request = indexedDB.open("agent-city-mecha-replays", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const tx = database.transaction("replays", op === "keys" || op === "get" ? "readonly" : "readwrite");
        const store = tx.objectStore("replays");
        const query = op === "keys" ? store.getAllKeys() : op === "get" ? store.get(key) : op === "put" ? store.put(value, key) : store.delete(key);
        tx.oncomplete = () => { database.close(); resolve(query.result); };
        tx.onerror = tx.onabort = () => { database.close(); reject(tx.error); };
      };
    }), { op, key, value });
    const keys = await db("keys");
    const key = keys.find(k => k.startsWith(prefix)); assert.ok(key);
    const raw = await db("get", key);
    async function refreshSavedSnapshot() {
      await page.keyboard.press("Escape"); await openSettings();
      await page.waitForFunction(({ key, raw }) => window.__testReplaySnapshot?.getItem(key) === raw, { key, raw });
      await page.locator("#mecha-battlefield-settings .mecha-settings-close").click();
      await page.getByRole("button", { name: zh ? "查看结算" : "View result" }).click();
    }
    // IndexedDB cannot be read synchronously in beforeunload. Destructive actions re-read it first.
    await db("put", key, "modified");
    await restart.click(); await guard.waitFor({ state: "visible" });
    assert.equal(await unloadPrevented(), true, "modified save is detected when restarting"); await cancel.click();
    await db("put", key, raw); await refreshSavedSnapshot();
    assert.equal(await unloadPrevented(), false);
    await db("delete", key);
    await restart.click(); await guard.waitFor({ state: "visible" });
    assert.equal(await unloadPrevented(), true, "deleted save is detected when restarting"); await cancel.click();
    await db("put", key, raw); await refreshSavedSnapshot();
    await page.evaluate(() => {
      window.__originalIdbOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function() { throw new DOMException("blocked", "QuotaExceededError"); };
    });
    await restart.click(); await guard.waitFor({ state: "visible" });
    assert.equal(await unloadPrevented(), true, "unreadable storage is not treated as a verified save"); await cancel.click();
    await page.evaluate(() => { IDBFactory.prototype.open = window.__originalIdbOpen; });
    await refreshSavedSnapshot();
    assert.equal(await unloadPrevented(), false);
    await restart.click(); await page.waitForFunction(() => window.__replayController.getState().match.phase === "deployment");
    assert.equal(await guard.count(), 0, "saved match restarts without a warning");
    await finish();
    assert.equal(await unloadPrevented(), true, "new match does not inherit prior saved status");
    await restart.click(); await guard.waitFor({ state: "visible" });
    await confirm.click(); await page.waitForFunction(() => window.__replayController.getState().match.phase === "deployment");
    assert.equal((await db("keys")).filter(k => k.startsWith(prefix)).length, 1, "discarding the new replay does not delete old saves");
    await finish();
    await page.keyboard.press("Escape"); await openSettings();
    const shapeBeforeConfirm = await shape.inputValue();
    const shapeAfterConfirm = await shape.locator("option:not([disabled])").evaluateAll((options, current) => options.map(o => o.value).find(v => v !== current), shapeBeforeConfirm);
    await shape.selectOption(shapeAfterConfirm); await guard.waitFor({ state: "visible" }); await confirm.click();
    await page.waitForFunction(value => window.__replayController.getState().match.phase === "deployment" && document.querySelector("#mecha-battlefield-settings .mecha-toolbar label select")?.value === value, shapeAfterConfirm);
    await page.locator("#mecha-battlefield-settings .mecha-settings-close").click();
    await finish(); await exit.click(); await guard.waitFor({ state: "visible" }); await confirm.click();
    await result.waitFor({ state: "hidden" });
    assert.equal(await page.locator('[data-mecha-settings-trigger="battlefield"]').count(), 0, "explicit discard exits battle");
    assert.deepEqual(errors, []);
    console.log(`${lang}: unsaved replay guards, save races, storage changes and screenshots passed`);
    await page.close();
  }
} finally { await browser.close(); }
