#!/usr/bin/env node
// Synthetic City only: actual browser download, verified import and local replay.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
const base = process.argv[2] ?? "http://127.0.0.1:5190/?fixtureSessions=30";
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) {
    const zh = lang === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US", acceptDownloads: true });
    const page = await context.newPage(); page.setDefaultTimeout(60000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
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
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
    await page.waitForFunction(() => window.__replayController?.getState().match.phase === "deployment");
    const finished = await page.evaluate(() => {
      const c = window.__replayController, cells = c.getState().deployment.cells;
      ["Assault", "Gunner", "Support"].forEach((id, i) => c.placeMech(id, cells[i]));
      c.confirmDeployment(); window.__pauseFixtureDraw = true; c.startAuto();
      for (let i = 0; i < 100 && !c.getState().match.outcome; i++) { c.tick(); if (c.getState().performance) c.finishPerformance(); }
      return { outcome: c.getState().match.outcome, rounds: c.getState().replayAvailable };
    });
    assert.ok(finished.outcome && finished.rounds);
    const dialog = page.locator("[data-mecha-result-dialog]"); await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("status").getByText(zh ? "本局回放已自动保存到本机。" : "This battle replay was saved locally automatically.").waitFor();
    await dialog.locator("[data-result-restart]").click();
    await page.waitForFunction(() => window.__replayController.getState().match.phase === "deployment");
    await page.locator('[data-mecha-settings-trigger="battlefield"]').click();
    const settings = page.locator("#mecha-battlefield-settings"); await settings.waitFor({ state: "visible" });
    const fileTools = settings.locator(".mecha-replay-file-tools"); await fileTools.locator("summary").click();
    const downloadPromise = page.waitForEvent("download");
    await settings.locator("[data-archive-export]").click();
    const download = await downloadPromise; assert.equal(download.suggestedFilename(), "mecha-battle-replay.json");
    const raw = await readFile(await download.path(), "utf8");
    const parsed = JSON.parse(raw); assert.equal(parsed.schema, "mecha-local-replay:v1");
    assert.ok(!("site" in parsed) && !("events" in parsed) && !raw.includes("private-building-identity"));
    const count = () => page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("agent-city-mecha-replays", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result; const tx = db.transaction("replays", "readonly"); const count = tx.objectStore("replays").count(); tx.oncomplete = () => { db.close(); resolve(count.result); }; tx.onerror = () => reject(tx.error); };
    }));
    const message = text => settings.getByRole("status").getByText(text).waitFor();
    const importFile = async content => {
      const chooser = page.waitForEvent("filechooser"); await settings.locator("[data-archive-import]").click();
      await (await chooser).setFiles({ name: "replay.json", mimeType: "application/json", buffer: Buffer.from(content) });
    };
    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await settings.locator("[data-archive-import]").scrollIntoViewIfNeeded();
      const bounds = await settings.locator("[data-archive-import]").evaluate(el => { const r = el.getBoundingClientRect(); return { left:r.left, right:r.right }; });
      assert.ok(bounds.left >= 0 && bounds.right <= width, JSON.stringify(bounds));
      await page.screenshot({ path: `/tmp/mecha-replay-file-${lang}-${width}.png` });
    }
    await page.setViewportSize({ width: 1100, height: 700 });
    await importFile(raw); await message(zh ? "这条回放已在本机列表中。" : "This replay is already in the local list.");
    assert.equal(await count(), 1, "duplicate import should not create an extra save");
    await settings.locator("[data-archive-delete]").click(); await settings.locator("[data-archive-delete-confirm]").click();
    assert.equal(await count(), 0);
    await importFile("{broken"); await message(zh ? "回放记录已损坏或格式不支持。" : "The replay is corrupt or its format is unsupported.");
    await importFile("x".repeat(40001)); await message(zh ? "回放记录已损坏或格式不支持。" : "The replay is corrupt or its format is unsupported.");
    const forged = JSON.parse(raw); forged.resultDigest = "0".repeat(64);
    await importFile(JSON.stringify(forged)); await message(zh ? "回放与当前城市的可用战场或规则不兼容，无法播放。" : "This replay is incompatible with this city’s available battlefields or the current rules.");
    assert.equal(await count(), 0);
    await page.evaluate(() => { window.__holdReplayDigest = true; });
    await importFile(raw); await page.waitForFunction(() => typeof window.__releaseReplayDigest === "function");
    await page.evaluate(() => { window.__replayController.restart(); window.__holdReplayDigest = false; window.__releaseReplayDigest(); });
    await message(zh ? "战局已变化，本次操作已取消。" : "The battle changed; the operation was cancelled.");
    assert.equal(await count(), 0, "changed live state must cancel the import");
    await page.evaluate(() => { window.__originalIdbOpen = IDBFactory.prototype.open; IDBFactory.prototype.open = function() { throw new DOMException("denied", "QuotaExceededError"); }; });
    await importFile(raw); await message(zh ? "本地存储不可用或空间不足，操作未完成。" : "Local storage is unavailable or full; the operation was not completed.");
    await page.evaluate(() => { IDBFactory.prototype.open = window.__originalIdbOpen; });
    assert.equal(await count(), 0);
    const before = await page.evaluate(() => JSON.stringify(window.__replayController.getState().match));
    await importFile(raw); await message(zh ? "回放已导入本机，可从列表中播放。" : "Replay imported locally. Select it in the list to play.");
    assert.equal(await count(), 1);
    // Optional synthetic fixture for checking the desktop SQLite validator against a real browser-generated record.
    if (process.env.MECHA_REPLAY_FIXTURE) {
      const record = await page.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open("agent-city-mecha-replays", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction("replays", "readonly"), values = tx.objectStore("replays").getAll();
          tx.oncomplete = () => { db.close(); resolve(values.result[0]); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
      }));
      await writeFile(process.env.MECHA_REPLAY_FIXTURE, record);
    }
    await settings.locator("[data-archive-play]").click();
    await page.waitForFunction(() => window.__replayController.getState().replay?.source === "saved");
    assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().match)), before);
    await page.locator("[data-mecha-replay-exit]").click();
    assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().match)), before);
    assert.deepEqual(errors, []); console.log(`${lang}: replay export/import browser checks passed`);
    await context.close();
  }
} finally { await browser.close(); }
