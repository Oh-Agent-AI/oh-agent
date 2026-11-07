#!/usr/bin/env node
// Opt-in development UI against synthetic fixture data. No production globals.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5187";
const reduced = process.env.MECHA_V15_REDUCED === "1";
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
try {
  const cases = process.env.MECHA_V15_LOCALE === "en" ? [["en", 390, 844]] : process.env.MECHA_V15_LOCALE === "zh" ? [["zh", 1280, 800]] : [["zh", 1280, 800], ["en", 390, 844]];
  for (const [locale, width, height] of cases) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? "reduce" : "no-preference" });
    const page = await context.newPage(); page.setDefaultTimeout(60000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(lang => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en"; }, locale);
    await page.route("**/src/game/SequentialMechaMatch.tsx*", async route => {
      const response = await route.fetch(); const source = await response.text();
      const seam = "const state = useSyncExternalStore(controller.subscribe, controller.getState);";
      assert.equal(source.split(seam).length, 2);
      await route.fulfill({ response, body: source.replace(seam, `${seam} globalThis.__v15Controller = controller;`) });
    });
    await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
      const response = await route.fetch(); const source = await response.text();
      const seam = "const raycaster = new THREE.Raycaster();";
      assert.equal(source.split(seam).length, 2);
      await route.fulfill({ response, body: source.replace(seam, `globalThis.__v15World = { site, cellWorld, figures, camera, engine, view: () => viewRef.current, performance: () => performanceRef.current }; ${seam}`) });
    });
    await page.goto(`${base}/?fixtureSessions=30&mechaV15=1`, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    const button = (zh, en) => page.getByRole("button", { name: locale === "zh" ? zh : en, exact: true });
    await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
    const root = page.locator("[data-mecha-v15]"); await root.waitFor();
    await root.locator(".mecha-battle-menu summary").click();
    await button("战斗教学", "Quick guide").click();
    assert.match(await page.locator("[data-mecha-quick-guide]").innerText(), locale === "zh" ? /逐台行动/ : /sequential play/);
    await button("关闭指南", "Close guide").click();
    assert.equal(await root.locator(".mecha-battle-menu summary").evaluate(el => document.activeElement === el), true, "guide returns focus to its trigger");
    await root.locator(".mecha-deploy-list > summary").click();
    const deploySelect = page.locator("#mecha-deploy-choice");
    const cells = await deploySelect.locator("option").evaluateAll(options => options.map(option => option.value).filter(Boolean));
    assert.ok(cells.length >= 3);
    for (let index = 0; index < 3; index++) {
      await root.locator(".mecha-deploy-roster button").nth(index).click();
      await deploySelect.selectOption(cells[index]); await button("放置机甲", "Place mech").click();
    }
    await button("确认部署", "Confirm deployment").click();
    await root.locator(".mecha-action-card").first().waitFor();
    const deployed = await page.evaluate(() => globalThis.__v15Controller.getState().match.mechs.map(m => [m.id, m.pos.x, m.pos.y]));
    assert.deepEqual(deployed.map(m => `${m[1]},${m[2]}`), cells.slice(0, 3));
    await page.waitForFunction(() => document.querySelector('.mecha-action-card:not(:disabled)'));
    // Synthetic presentation projection only; the status encounter remains gated.
    await page.evaluate(() => { globalThis.__v15World.view().statuses = [{ target: "Assault", source: "boss", kind: "poison", remainingTurns: 2 }]; });
    const badge = page.locator('.mecha-world-healthbar[data-unit-id="Assault"]');
    await page.waitForFunction(() => document.querySelector('.mecha-world-healthbar[data-unit-id="Assault"] .mecha-world-healthbar__status')?.textContent === "☠️2");
    await page.waitForFunction(lang => {
      const label = document.querySelector('.mecha-world-healthbar[data-unit-id="Assault"]')?.getAttribute("aria-label") ?? "";
      return lang === "zh" ? /中毒.*2/.test(label) : /Poison.*2 turns/.test(label);
    }, locale);
    assert.match(await badge.getAttribute("aria-label"), locale === "zh" ? /中毒.*2/ : /Poison.*2 turns/);
    await page.evaluate(() => { globalThis.__v15World.view().statuses = []; });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
    await root.waitFor(); await button("恢复对局", "Recover match").click();
    assert.deepEqual(await page.evaluate(() => globalThis.__v15Controller.getState().match.mechs.map(m => [m.id, m.pos.x, m.pos.y])), deployed, "opening checkpoint survives reload before any action");
    if (width > 800) {
      const pick = await page.evaluate(() => {
        const world = globalThis.__v15World, current = globalThis.__v15Controller.getState().selected, rect = world.engine.domCanvas.getBoundingClientRect();
        return world.view().figures.filter(f => f.id !== current).map(f => {
          const cell = world.cellWorld(world.site, f), p = world.figures[f.id].position.clone();
          p.set(cell.x, cell.y + .6, cell.z).project(world.camera);
          const x = rect.left + (p.x + 1) * rect.width / 2, y = rect.top + (1 - p.y) * rect.height / 2;
          return { id: f.id, x, y, hit: document.elementFromPoint(x, y) === world.engine.domCanvas };
        }).find(item => item.hit);
      });
      assert.ok(pick, "at least one deployed mech is accessible on the battlefield");
      await page.mouse.click(pick.x, pick.y);
      await page.waitForFunction(id => globalThis.__v15Controller.getState().selected === id, pick.id);
    }
    await root.locator(".mecha-v15-roster button").nth(2).click();
    await root.locator(".mecha-move-list > summary").click();
    const select = page.locator("#v15-cell");
    const moveCells = await select.locator("option").evaluateAll(options => options.map(option => option.value).filter(Boolean));
    assert.ok(moveCells.length > 0);
    await select.selectOption(moveCells[0]); await button("移动", "Move").click();
    await page.waitForFunction(() => document.querySelector('.mecha-action-card:not(:disabled)'));
    await page.waitForFunction(() => !globalThis.__v15Controller.getState().presentation);
    const moved = await page.evaluate(() => {
      const state = globalThis.__v15Controller.getState(), actor = state.match.mechs.find(m => m.id === state.selected), world = globalThis.__v15World;
      const at = world.cellWorld(world.site, actor.pos), model = world.figures[actor.id];
      return { cell: `${actor.pos.x},${actor.pos.y}`, distance: Math.hypot(at.x - model.position.x, at.z - model.position.z) };
    });
    assert.equal(moved.cell, moveCells[0]); assert.ok(moved.distance < .02, `rendered position differs by ${moved.distance}`);
    await button("撤销移动", "Undo move").click();
    await page.waitForFunction(() => document.querySelector('.mecha-action-card:not(:disabled)'));
    const undone = await page.evaluate(() => globalThis.__v15Controller.getState().match.mechs.find(m => m.id === globalThis.__v15Controller.getState().selected).pos);
    assert.equal(`${undone.x},${undone.y}`, cells[2]);
    const repair = root.locator(".mecha-action-card").filter({ hasText: locale === "zh" ? "维修" : "Repair" });
    assert.equal(await repair.count(), 1, "one card per action kind");
    await repair.click();
    assert.equal(await button("确认行动", "Confirm action").isDisabled(), true, "targeted action requires a target");
    const targetChoice = root.locator(".mecha-target-preview .mecha-actions button").first();
    await targetChoice.click();
    await root.locator(".mecha-v15-preview").waitFor();
    assert.equal(await button("确认行动", "Confirm action").isEnabled(), true, "selected legal target can be confirmed");
    await root.locator(".mecha-action-card:not(:disabled)").first().click();
    await button("确认行动", "Confirm action").click();
    await page.waitForFunction(() => { const el = [...document.querySelectorAll('.mecha-v15-panel button')].find(x => x.textContent.includes('结束回合') || x.textContent === 'End turn'); return el && !el.disabled; });
    await button("结束回合", "End turn").click();
    await root.locator(".mecha-v15-confirm").getByRole("button", { name: locale === "zh" ? "确认结束" : "End turn", exact: true }).click();
    try { await page.waitForFunction(() => { const match = globalThis.__v15Controller.getState().match; return match.turn > 1 || Boolean(match.outcome); }); }
    catch (error) { console.error("end-turn diagnostics", await page.evaluate(() => { const s = globalThis.__v15Controller.getState(); return { turn: s.match.turn, outcome: s.match.outcome, phase: s.match.phase, error: s.error, persistence: s.persistence, presentation: Boolean(s.presentation), selected: s.selected, rights: s.rights, panel: document.querySelector(".mecha-v15-panel")?.innerText }; })); throw error; }
    await page.waitForFunction(() => !globalThis.__v15Controller.getState().presentation);
    await page.waitForFunction(() => { const match = globalThis.__v15Controller.getState().match; const text = document.querySelector('.mecha-v15-panel .mecha-objective-round')?.textContent ?? ''; return Boolean(match.outcome) || text.includes(String(match.turn)); });
    const finalState = await page.evaluate(() => globalThis.__v15Controller.getState().match);
    await root.locator(".mecha-v15-replays summary").click();
    await button("保存当前回放", "Save current replay").click();
    await page.getByText(locale === "zh" ? "回放已保存并核对。" : "Replay saved and verified.").waitFor();
    if (locale === "zh" && process.env.MECHA_V15_RECORD_OUTPUT) {
      const raw = await page.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open("agent-city-mecha-sequential-replays", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction("replays", "readonly"), get = tx.objectStore("replays").getAll();
          get.onsuccess = () => { db.close(); resolve(get.result[0]); };
          get.onerror = () => reject(get.error);
        };
      }));
      assert.equal(typeof raw, "string");
      const normalized = JSON.parse(raw); normalized.savedAt = "2026-11-06T12:00:00.000Z";
      await writeFile(process.env.MECHA_V15_RECORD_OUTPUT, JSON.stringify(normalized));
    }
    await button("查看回放", "View replay").click();
    const next = button("下一步", "Next"); await next.waitFor();
    const count = await page.evaluate(() => globalThis.__v15Controller.records().length);
    await next.click();
    if (!reduced) {
      await page.waitForFunction(() => globalThis.__v15World.performance()?.events.some(event => event.kind === "move"));
      await button("跳过演出", "Skip animation").click();
    }
    await page.waitForFunction(() => !globalThis.__v15World.performance());
    const firstReplay = await page.evaluate(() => ({
      rendered: globalThis.__v15World.view().figures.map(f => [f.id, f.x, f.y, f.hp]),
      expected: globalThis.__v15Controller.records()[0].snapshot.match.mechs.map(m => [m.id, m.pos.x, m.pos.y, m.hp]),
    }));
    assert.deepEqual(firstReplay.rendered, firstReplay.expected, "skipping replay converges to the verified command result");
    for (let index = 1; index < count; index++) await next.click();
    await page.waitForFunction(() => !globalThis.__v15World.performance());
    const replayEnd = await page.evaluate(() => ({ figures: globalThis.__v15World.view().figures.map(f => [f.id, f.x, f.y, f.hp]), live: globalThis.__v15Controller.getState().match }));
    assert.deepEqual(replayEnd.figures, finalState.mechs.map(m => [m.id, m.pos.x, m.pos.y, m.hp]));
    assert.deepEqual(replayEnd.live, finalState, "replay does not mutate the live match");
    await button("返回对局", "Return to match").click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
    await root.waitFor();
    await button("恢复对局", "Recover match").click();
    await page.getByText(locale === "zh" ? "已恢复自动检查点。" : "Automatic checkpoint restored.").waitFor();
    assert.deepEqual(await page.evaluate(() => globalThis.__v15Controller.getState().match), finalState, "automatic checkpoint survives reload without re-executing actions");
    await root.locator(".mecha-v15-replays summary").click();
    await page.waitForFunction(() => document.querySelector('#v15-replay-choice')?.options.length > 1);
    await page.locator("#v15-replay-choice").selectOption({ index: 1 });
    await button("查看回放", "View replay").click(); await next.waitFor();
    for (let index = 0; index < count; index++) await next.click();
    await page.waitForFunction(() => !globalThis.__v15World.performance());
    const reopened = await page.evaluate(() => globalThis.__v15World.view().figures.map(f => [f.id, f.x, f.y, f.hp]));
    assert.deepEqual(reopened, finalState.mechs.map(m => [m.id, m.pos.x, m.pos.y, m.hp]), "saved replay survives reload");
    page.once("dialog", dialog => dialog.accept());
    await button("继续此对局", "Resume this match").click();
    await page.getByText(locale === "zh" ? "已恢复对局，可以继续行动。" : "Match restored. You can continue playing.").waitFor();
    assert.deepEqual(await page.evaluate(() => globalThis.__v15Controller.getState().match), finalState, "resume restores the verified authority");
    await root.locator(".mecha-action-card:not(:disabled)").first().click();
    await button("确认行动", "Confirm action").click();
    await page.waitForFunction(n => globalThis.__v15Controller.records().length === n + 1, count);
    const commandIds = await page.evaluate(() => globalThis.__v15Controller.records().map(record => record.command.id));
    assert.deepEqual(commandIds, commandIds.map((_, index) => `c${index}`), "durable command IDs remain unchanged across recovery");
    if (locale === "zh") {
      const terminal = await page.evaluate(async () => {
        const controller = globalThis.__v15Controller;
        for (let i = 0; i < 20 && !controller.getState().match.outcome; i++) {
          controller.finishPresentation(); await controller.executeDurable({ kind: "end", confirmUnused: true });
          if (controller.getState().error) throw new Error(controller.getState().error);
        }
        controller.finishPresentation(); return controller.getState().match.outcome;
      });
      assert.ok(terminal, "fixture must reach a terminal checkpoint");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(".city-loading").waitFor({ state: "hidden" });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await root.waitFor(); await button("查看已结束对局", "Review finished match").click();
      await page.getByText(/回放步骤/).waitFor();
      await button("返回对局", "Return to match").click();
    }
    const cas = await page.evaluate(async () => {
      const { checkpointBackend } = await import("/src/game/mecha/sequentialCheckpoint.ts");
      const one = await checkpointBackend(), two = await checkpointBackend(), start = await one.read();
      const writes = await Promise.allSettled([one.write(start.revision, start.raw), two.write(start.revision, start.raw)]);
      const after = await one.read();
      await one.write(after.revision, null);
      const cleared = await one.read();
      return { successes: writes.filter(item => item.status === "fulfilled").length, start: start.revision, after: after.revision, cleared: cleared.revision, raw: cleared.raw };
    });
    assert.deepEqual(cas, { successes: 1, start: cas.start, after: cas.start + 1, cleared: cas.start + 2, raw: null }, "browser checkpoint CAS and clear generation");
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/tmp/mecha-v15-${locale}.png` });
    console.log(`PASS v1.5 ${locale} ${width}x${height}${reduced ? " reduced-motion" : ""}: deploy, move, undo, act, end, save, resume after reload`);
    await context.close();
  }
} finally { await browser.close(); }
