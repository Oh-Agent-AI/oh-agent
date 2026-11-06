#!/usr/bin/env node
// Synthetic City: local preference, automatic save, capacity, and cross-tab cancellation.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const browser = await chromium.launch({ headless: true, args: [process.env.MECHA_BROWSER_ANGLE === "metal" ? "--use-angle=metal" : "--enable-unsafe-swiftshader"] });
const base = process.argv[2] ?? "http://127.0.0.1:5190/?fixtureSessions=30";
const prefix = "agent-city:mecha-local-replay-entry:v1:";
const preference = "agent-city:mecha-replay-auto-save:v1";
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) {
    const zh = lang === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
    const page = await context.newPage(); page.setDefaultTimeout(60000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("**/src/engine/CityEngine.ts*", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("if (this.documentHidden) return;", "if (this.documentHidden || window.__pauseFixtureDraw) return;") });
    });
    await page.route("**/src/game/MechaBoard.tsx*", async route => {
      const response = await route.fetch(); let body = await response.text();
      const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
      assert.ok(body.includes(needle)); body = body.replace(needle, needle + "\nwindow.__replayController = controllerRef.current;");
      await route.fulfill({ response, body });
    });
    await page.route("**/src/game/mecha/replayArchive.ts*", async route => {
      const response = await route.fetch(); let body = await response.text();
      const needle = 'const result = await globalThis.crypto.subtle.digest("SHA-256", bytes);';
      assert.ok(body.includes(needle)); body = body.replace(needle, 'if (window.__holdReplayDigest) await new Promise(resolve => { window.__releaseReplayDigest = resolve; });\n    ' + needle);
      await route.fulfill({ response, body });
    });
    await page.addInitScript(locale => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, zh ? "zh-Hans" : "en");
    async function enter() {
      await page.locator(".city-loading").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
      await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
      await page.waitForFunction(() => window.__replayController?.getState().match.phase === "deployment");
    }
    async function settings() { await page.locator('[data-mecha-settings-trigger="battlefield"]').click(); await page.locator("#mecha-battlefield-settings").waitFor({ state: "visible" }); }
    async function finish() {
      const value = await page.evaluate(() => {
        const c = window.__replayController, cells = c.getState().deployment.cells;
        ["Assault", "Gunner", "Support"].forEach((id, i) => c.placeMech(id, cells[i]));
        c.confirmDeployment(); window.__pauseFixtureDraw = true; c.startAuto();
        for (let i = 0; i < 100 && !c.getState().match.outcome; i++) { c.tick(); if (c.getState().performance) c.finishPerformance(); }
        return { outcome: c.getState().match.outcome, rounds: c.getState().replayAvailable };
      });
      assert.ok(value.outcome && value.rounds); await page.locator("[data-mecha-result-dialog]").waitFor({ state: "visible" });
    }
    const dbAction = (action, key, value) => page.evaluate(async ({ action, key, value }) => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open("agent-city-mecha-replays", 1); r.onupgradeneeded = () => r.result.createObjectStore("replays"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try { return await new Promise((resolve, reject) => {
        const tx = db.transaction("replays", action === "count" ? "readonly" : "readwrite"), store = tx.objectStore("replays");
        const r = action === "count" ? store.count() : action === "delete" ? store.delete(key) : store.put(value, key);
        tx.oncomplete = () => resolve(r.result); tx.onerror = tx.onabort = () => reject(tx.error);
      }); } finally { db.close(); }
    }, { action, key, value });
    const count = () => dbAction("count");
    const dialog = page.locator("[data-mecha-result-dialog]");
    const checkbox = page.locator("[data-replay-auto-save]");
    const restart = () => dialog.locator("[data-result-restart]").click();
    async function manualSave() {
      await page.keyboard.press("Escape"); await settings();
      await page.locator("[data-archive-save-current]").click();
      await page.getByRole("status").getByText(zh ? "回放已保存到本机，可在战场设置中打开。" : "Replay saved locally. Open it from battlefield settings.").first().waitFor();
      await page.locator("#mecha-battlefield-settings .mecha-settings-close").click();
      await page.locator(".mecha-result-reopen").click(); await dialog.waitFor({ state: "visible" });
    }
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 240000 }); await enter();
    await settings(); assert.equal(await checkbox.isChecked(), true, "new installations default to auto-save"); await page.locator("#mecha-battlefield-settings .mecha-settings-close").click();
    await finish();
    await dialog.getByRole("status").getByText(zh ? "本局回放已自动保存到本机。" : "This battle replay was saved locally automatically.").waitFor();
    await page.screenshot({ path: `/tmp/mecha-result-auto-saved-${lang}.png` });
    assert.equal(await count(), 1, "completed battle is written into IndexedDB");
    assert.equal(await page.evaluate(p => Object.keys(localStorage).filter(k => k.startsWith(p)).length, prefix), 0, "new replays are not stored in localStorage");
    await page.keyboard.press("Escape"); await settings();
    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.screenshot({ path: `/tmp/mecha-replay-auto-save-${lang}-${width}.png` });
      const bounds = await checkbox.evaluate(el => { const r = el.closest("label").getBoundingClientRect(); return { left:r.left, right:r.right }; });
      assert.ok(bounds.left >= 0 && bounds.right <= width, JSON.stringify(bounds));
    }
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 240000 }); await enter();
    assert.equal(await count(), 1, "database survives reload");
    await settings(); await page.waitForFunction(() => document.querySelectorAll("[data-archive-select] option").length === 1); assert.equal(await page.locator("[data-archive-select] option").count(), 1, "saved replay is listed after reload");
    await page.locator("#mecha-battlefield-settings .mecha-settings-close").click();
    await finish();
    await dialog.getByRole("status").getByText(zh ? "本局回放已自动保存到本机。" : "This battle replay was saved locally automatically.").waitFor();
    assert.equal(await count(), 2, "new finished match automatically saved exactly once");
    await restart(); await page.evaluate(() => { window.__holdReplayDigest = true; }); await finish();
    await page.waitForFunction(() => typeof window.__releaseReplayDigest === "function");
    const other = await context.newPage(); await other.goto(new URL("/src/game/mecha/replayAutoSave.ts", base).href);
    await other.evaluate(key => localStorage.setItem(key, "disabled"), preference);
    await page.waitForFunction(key => localStorage.getItem(key) === "disabled", preference);
    await page.evaluate(() => { window.__holdReplayDigest = false; window.__releaseReplayDigest(); });
    await page.waitForFunction(() => !document.querySelector("[data-result-restart]").disabled);
    assert.equal(await count(), 2, "cross-tab opt-out cancels pending save");
    await manualSave(); assert.equal(await count(), 3, "manual retry remains available");
    await other.close();
    await restart(); await page.evaluate(key => { localStorage.setItem(key, "enabled"); window.dispatchEvent(new StorageEvent("storage", { key, newValue: "enabled" })); }, preference);
    for (let i = 0; i < 17; i++) await dbAction("put", `${prefix}00000000-0000-4000-8000-${String(i).padStart(12,"0")}`, "invalid");
    await finish();
    await dialog.getByRole("status").getByText(zh ? "自动保存失败：本机回放已满，请先删除一条记录。" : "Automatic save failed: replay storage is full. Delete an entry first.").waitFor();
    assert.equal(await count(), 20); await restart(); await page.locator("[data-replay-unsaved-guard]").waitFor({ state: "visible" });
    await page.locator("[data-replay-guard-cancel]").click();
    await dbAction("delete", `${prefix}00000000-0000-4000-8000-000000000000`);
    await manualSave(); await restart();
    await dbAction("delete", `${prefix}00000000-0000-4000-8000-000000000001`);
    await page.evaluate(() => { window.__originalIdbOpen = IDBFactory.prototype.open; IDBFactory.prototype.open = function() { throw new DOMException("denied", "QuotaExceededError"); }; });
    await finish();
    await dialog.getByRole("status").getByText(zh ? "自动保存失败，请手动保存或检查本机存储空间。" : "Automatic save failed. Try saving manually or check local storage space.").waitFor();
    await page.evaluate(() => { IDBFactory.prototype.open = window.__originalIdbOpen; });
    await manualSave();
    assert.deepEqual(errors, []); console.log(`${lang}: local auto-save checks passed`);
    await context.close();
  }
} finally { await browser.close(); }
