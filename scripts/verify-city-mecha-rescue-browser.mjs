#!/usr/bin/env node
// Synthetic City fixture: real UI, controller, rules, local replay database and WebGL.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5188/?fixtureSessions=30";
const out = process.env.MECHA_SCREENSHOTS_DIR;
if (out) await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: [process.env.MECHA_BROWSER_ANGLE === "metal" ? "--use-angle=metal" : "--enable-unsafe-swiftshader"] });
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) {
    const zh = lang === "zh";
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
    page.setDefaultTimeout(90000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.route("**/src/game/MechaBoard.tsx*", async route => {
      const response = await route.fetch(); let body = await response.text();
      const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
      assert.ok(body.includes(needle)); body = body.replace(needle, needle + '\nwindow.__rescueController = controllerRef.current;');
      await route.fulfill({ response, body });
    });
    await page.addInitScript(locale => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, zh ? "zh-Hans" : "en");
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
    await page.waitForFunction(() => window.__rescueController?.getState().match.phase === "deployment");
    await page.locator('[data-mecha-settings-trigger="battlefield"]').click();
    const panel = page.locator("#mecha-battlefield-settings"); await panel.waitFor({ state: "visible" });
    await panel.locator(".mecha-toolbar select").nth(2).selectOption("stationary_smash");
    await panel.locator("[data-mission-mode]").selectOption("rescue:v1");
    await page.waitForFunction(() => window.__rescueController.getState().match.mission?.kind === "rescue:v1");
    await panel.locator(".mecha-settings-close").click();
    const label = page.locator("[data-rescue-target]"); await label.waitFor({ state: "visible" });
    assert.match(await label.innerText(), zh ? /紫色十字/ : /purple cross/);
    for (const viewport of [{ width: 1100, height: 700 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await page.waitForTimeout(400);
      assert.ok(await label.isVisible());
      if (out) await page.screenshot({ path: join(out, `rescue-${lang}-${viewport.width}.png`) });
    }
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.locator('[data-mecha-settings-trigger="remote"]').click();
    assert.match(await page.locator("#mecha-remote-settings").innerText(), zh ? /仅支持本地对局/ : /local-only/);
    await page.locator("#mecha-remote-settings .mecha-settings-close").click();
    const played = await page.evaluate(async () => {
      const { pathRoute, moveBudget } = await import('/src/game/mecha/board.ts');
      const c = window.__rescueController;
      const cells = c.getState().deployment.cells;
      ["Assault", "Gunner", "Support"].forEach((id, i) => c.placeMech(id, cells[i]));
      c.confirmDeployment();
      if (c.getState().match.phase !== "player_plan") return { error: c.getState().deployment?.error };
      for (let turn = 0; turn < 15 && !c.getState().match.outcome; turn++) {
        const state = c.getState().match, target = state.mission.target;
        const unit = state.mechs.find(m => m.hp > 0 && pathRoute(state, m.pos, target, m.id, { alliesPass: true }));
        if (!unit) return { error: 'no route', turn };
        const route = pathRoute(state, unit.pos, target, unit.id, { alliesPass: true });
        const destination = [...route.cells].reverse().find(cell => !state.mechs.some(m => m.id !== unit.id && m.hp > 0 && m.pos.x === cell.x && m.pos.y === cell.y) && (pathRoute(state, unit.pos, cell, unit.id, { alliesPass: true })?.cost ?? Infinity) <= moveBudget(unit.id));
        if (!destination) return { error: 'no destination', turn };
        c.setMove(unit.id, destination);
        for (const mech of state.mechs.filter(m => m.hp > 0)) c.setAction(mech.id, { kind: 'skip' });
        c.submit(); if (c.getState().holdConfirmation) c.confirmHold();
        if (c.getState().performance) c.finishPerformance();
        if (c.getState().match === state) return { error: c.getState().notice ?? 'turn did not advance', turn };
      }
      return { outcome: c.getState().match.outcome, rounds: c.getState().replayAvailable };
    });
    assert.equal(played.outcome, "victory", JSON.stringify(played)); assert.ok(played.rounds > 0);
    const dialog = page.locator("[data-mecha-result-dialog]"); await dialog.waitFor({ state: "visible" });
    assert.match(await dialog.innerText(), zh ? /救援点已抵达/ : /rescue point was reached/i);
    assert.equal(await dialog.locator("button").count(), 3);
    await dialog.getByRole("status").getByText(zh ? "本局回放已自动保存到本机。" : "This battle replay was saved locally automatically.").waitFor();
    const saved = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open("agent-city-mecha-replays", 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try { return await new Promise((resolve, reject) => { const r = db.transaction("replays").objectStore("replays").getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); } finally { db.close(); }
    });
    assert.ok(saved.length >= 1, "completed rescue saved in local IndexedDB");
    await dialog.locator("[data-result-replay]").click();
    await page.waitForFunction(() => window.__rescueController.getState().replay !== null);
    assert.deepEqual(errors, []);
    console.log(`${lang}: switch, objective, local-only guard, real victory, automatic IndexedDB save and playback passed`);
    await page.close();
  }
} finally { await browser.close(); }
