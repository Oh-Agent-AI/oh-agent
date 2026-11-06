#!/usr/bin/env node
// P2 integration: synthetic City, real UI/controller/rules, and local replay database.
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
    // The guide is user-invoked from the actual topbar menu and must not mutate the match.
    const initial = await page.evaluate(() => JSON.stringify(window.__rescueController.getState().match));
    for (const viewport of [{ width: 1100, height: 700 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const menu = page.locator(".mecha-battle-menu > summary");
      await menu.click();
      await page.locator("[data-mecha-guide-trigger]").click();
      const guide = page.locator("[data-mecha-quick-guide]");
      await guide.waitFor({ state: "visible" });
      assert.match(await guide.innerText(), zh ? /战斗快速指南/ : /Quick battle guide/);
      assert.ok(await guide.evaluate(el => el.matches(":modal")));
      const bounds = await guide.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
      assert.ok(bounds.x >= -1 && bounds.y >= -1 && bounds.right <= viewport.width + 1 && bounds.bottom <= viewport.height + 1, `${lang}: guide outside viewport`);
      if (out) await page.screenshot({ path: join(out, `p2-guide-${lang}-${viewport.width}.png`) });
      await page.keyboard.press("Escape");
      await guide.waitFor({ state: "hidden" });
      assert.equal(await menu.evaluate(el => document.activeElement === el), true, `${lang}: focus returns to topbar menu`);
      assert.equal(await page.evaluate(() => JSON.stringify(window.__rescueController.getState().match)), initial, "guide must not change the match");
    }
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.locator('[data-mecha-settings-trigger="battlefield"]').click();
    const panel = page.locator("#mecha-battlefield-settings"); await panel.waitFor({ state: "visible" });
    const scenarios = panel.locator("[data-p2-scenarios]");
    await scenarios.locator("summary").click();
    let scenarioStarted = false;
    for (const id of ["flat-raid", "shore-siege", "ridge-cadence", "alley-siege"]) {
      await scenarios.locator("[data-p2-scenario-select]").selectOption(id);
      await scenarios.getByRole("button", { name: zh ? "开始组合" : "Start combination" }).click();
      await page.evaluate(() => { window.__scenarioBefore = window.__rescueController.getState().match; });
      await scenarios.getByRole("button", { name: zh ? "取消" : "Cancel", exact: true }).click();
      assert.equal(await page.evaluate(() => window.__rescueController.getState().match === window.__scenarioBefore), true, "cancel keeps current match");
      await scenarios.getByRole("button", { name: zh ? "开始组合" : "Start combination" }).click();
      await scenarios.locator("[data-p2-scenario-confirm]").click();
      await page.waitForFunction(() => window.__rescueController.getState().match !== window.__scenarioBefore || document.querySelector("[data-p2-scenarios] [role=alert]"));
      scenarioStarted = await page.evaluate(() => window.__rescueController.getState().match !== window.__scenarioBefore);
      if (scenarioStarted) {
        assert.equal(await page.evaluate(() => window.__rescueController.getState().match.phase), "deployment");
        assert.equal(await page.evaluate(() => window.__rescueController.getState().match.mission ?? null), null);
        // Restarting on the same site must not strand the connected Assault loading gate.
        await page.locator('[data-mecha-settings-trigger="battlefield"]').waitFor({ state: "visible" });
        await page.getByText(zh ? "正在加载 Assault 模型…" : "Loading Assault model…", { exact: true }).waitFor({ state: "hidden" });
        await page.waitForFunction(() => { const button = document.querySelector(".mecha-deploy-roster button"); return button && !button.disabled; });
        // Start the same combination again: site identity stays the same and the
        // deployment controls must not become permanently disabled by loading.
        await scenarios.getByRole("button", { name: zh ? "开始组合" : "Start combination" }).click();
        await page.evaluate(() => { window.__scenarioBefore = window.__rescueController.getState().match; });
        await scenarios.locator("[data-p2-scenario-confirm]").click();
        await page.waitForFunction(() => window.__rescueController.getState().match !== window.__scenarioBefore);
        await page.waitForFunction(() => { const button = document.querySelector(".mecha-deploy-roster button"); return button && !button.disabled; });
        break;
      }
    }
    assert.ok(scenarioStarted, `${lang}: at least one real catalog combination should be playable in this synthetic city`);
    await scenarios.locator("summary").click();
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
    const disclosure = dialog.locator("[data-result-review] > summary");
    await disclosure.focus(); await page.keyboard.press("Enter");
    const review = dialog.locator("[data-mecha-round-review]"); await review.waitFor({ state: "visible" });
    assert.match(await review.innerText(), zh ? /已核对的结算事件/ : /Verified settled events/);
    assert.equal(await dialog.locator('[data-achievement="protected-buildings-undamaged"]').getAttribute("data-status"), "not-applicable");
    assert.notEqual(await dialog.locator('[data-achievement="all-survived"]').getAttribute("data-status"), "unverifiable");
    await review.locator("details > summary").first().click();
    assert.match(await review.innerText(), zh ? /敌方受到伤害/ : /Enemy damage taken/);
    for (const viewport of [{ width: 1100, height: 700 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const bounds = await dialog.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
      assert.ok(bounds.x >= -1 && bounds.y >= -1 && bounds.right <= viewport.width + 1 && bounds.bottom <= viewport.height + 1, `${lang}: result outside viewport`);
      await review.scrollIntoViewIfNeeded();
      if (out) await page.screenshot({ path: join(out, `p2-result-review-${lang}-${viewport.width}.png`) });
    }
    await page.setViewportSize({ width: 1100, height: 700 });
    assert.equal(await dialog.locator("button").count(), 3);
    try {
      await dialog.getByRole("status").getByText(zh ? "本局回放已自动保存到本机。" : "This battle replay was saved locally automatically.").waitFor({ timeout: 15000 });
    } catch (error) {
      console.error("Replay autosave diagnostic:", await dialog.innerText());
      throw error;
    }
    const saved = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open("agent-city-mecha-replays", 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try { return await new Promise((resolve, reject) => { const r = db.transaction("replays").objectStore("replays").getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); } finally { db.close(); }
    });
    assert.ok(saved.length >= 1, "completed rescue saved in local IndexedDB");
    await dialog.locator("[data-result-replay]").click();
    await page.waitForFunction(() => window.__rescueController.getState().replay !== null);
    assert.deepEqual(errors, []);
    console.log(`${lang}: topbar guide, focus, switch, rescue, local-only guard, real victory, IndexedDB and playback passed`);
    await page.close();
  }
} finally { await browser.close(); }
