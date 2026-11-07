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
    const page = await context.newPage(); page.setDefaultTimeout(180000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(lang => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en"; }, locale);
    await page.route("**/src/game/SequentialMechaMatch.tsx*", async route => {
      const response = await route.fetch(); const source = await response.text();
      const seam = "const state = useSyncExternalStore(controller.subscribe, controller.getState);";
      assert.equal(source.split(seam).length, 2);
      await route.fulfill({ response, body: source.replace(seam, `${seam} globalThis.__v15Controller = controller; globalThis.__v15LegalActions = legalActions; globalThis.__v15MoveHelpers = { BOARD, pathDistance, moveBudget, occupant };`) });
    });
    await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
      const response = await route.fetch(); const source = await response.text();
      const seam = "const raycaster = new THREE.Raycaster();";
      const statusSeam = "performanceRef.current ? performanceStatuses ?? [] : viewRef.current.statuses ?? []";
      assert.equal(source.split(seam).length, 2); assert.equal(source.split(statusSeam).length, 2);
      await route.fulfill({ response, body: source.replace(seam, `globalThis.__v15World = { site, cellWorld, figures, camera, engine, view: () => viewRef.current, performance: () => performanceRef.current }; ${seam}`)
        .replace(statusSeam, "performanceRef.current ? performanceStatuses ?? [] : (globalThis.__v15SyntheticStatuses ?? viewRef.current.statuses ?? [])") });
    });
    await page.goto(`${base}/?fixtureSessions=30`, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    const button = (zh, en) => page.getByRole("button", { name: locale === "zh" ? zh : en, exact: true });
    await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
    const root = page.locator("[data-mecha-v15]"); await root.waitFor();
    const openMovementList = async () => {
      const summary = root.locator(".mecha-move-list > summary");
      if (!(await summary.evaluate(el => el.parentElement.open))) await summary.click();
    };
    assert.equal(await root.getAttribute("data-hud-mode"), "sequential", "v1.5 must use the shared HUD model adapter");
    assert.equal(await root.getAttribute("data-hud-phase"), "deployment");
    assert.match(await root.locator(".mecha-deploy-actions").innerText(), locale === "zh" ? /完成 3\/3 并确认后，即可操作机甲、移动和攻击/ : /Deploy all 3 mechs and confirm to unlock mech actions, movement and attacks/);
    await page.screenshot({ path: `/tmp/mecha-v15-deployment-${locale}.png` });
    await root.locator(".mecha-battle-menu summary").click();
    await button("战斗教学", "Quick guide").click();
    assert.match(await page.locator("[data-mecha-quick-guide]").innerText(), locale === "zh" ? /逐台行动/ : /sequential play/);
    // The full City canvas can intercept Playwright's pointer over the native
    // dialog in headless Chromium; the dedicated guide test covers its button.
    await page.keyboard.press("Escape");
    assert.equal(await root.locator(".mecha-battle-menu summary").evaluate(el => document.activeElement === el), true, "guide returns focus to its trigger");
    await root.locator(".mecha-deploy-list > summary").click();
    const deploySelect = page.locator("#mecha-deploy-choice");
    const cells = await deploySelect.locator("option").evaluateAll(options => options.map(option => option.value).filter(Boolean));
    assert.ok(cells.length >= 3);
    for (let index = 0; index < 3; index++) {
      await root.locator(".mecha-deploy-roster button").nth(index).click();
      await deploySelect.selectOption(cells[index]); await button("放置机甲", "Place mech").click();
      assert.match(await root.locator(".mecha-deploy-roster li").nth(index).innerText(), new RegExp(cells[index].replace(",", ", ")));
    }
    await button("确认部署", "Confirm deployment").click();
    await root.locator(".mecha-action-card").first().waitFor();
    assert.equal(await root.getAttribute("data-hud-phase"), "planning");
    assert.match(await root.locator(".mecha-selected-actions").innerText(), locale === "zh" ? /操作机甲/ : /Selected mech/);
    assert.ok(await root.locator(".mecha-action-card").count() > 0, "v1.5 actions must be available in the planning phase");
    await root.locator(".mecha-v15-roster button").nth(1).click();
    const attack = root.locator(".mecha-action-card").filter({ hasText: locale === "zh" ? "射击" : "Shoot" });
    await attack.waitFor();
    assert.equal(await attack.isDisabled(), true, "out-of-range attack remains visible and unavailable");
    assert.match(await attack.innerText(), locale === "zh" ? /无合法目标/ : /No legal target/);
    await page.screenshot({ path: `/tmp/mecha-v15-attack-${locale}.png` });
    await button("结算顺序", "Turn order").click();
    const orderSteps = root.locator("[data-attack-order-step]");
    await orderSteps.first().waitFor();
    const orderNumbers = await orderSteps.evaluateAll(nodes => nodes.map(node => Number(node.getAttribute("data-order"))));
    assert.deepEqual(orderNumbers, orderNumbers.map((_, index) => index + 1), "v1.5 order rows follow the actual resolution sequence");
    await page.screenshot({ path: `/tmp/mecha-m4-v15-${locale}.png` });
    await button("结算顺序", "Turn order").click();
    const deployed = await page.evaluate(() => globalThis.__v15Controller.getState().match.mechs.map(m => [m.id, m.pos.x, m.pos.y]));
    assert.deepEqual(deployed.map(m => `${m[1]},${m[2]}`), cells.slice(0, 3));
    await page.waitForFunction(() => document.querySelector('.mecha-action-card:not(:disabled)'));
    // Synthetic presentation projection only; the status encounter remains gated.
    await page.evaluate(() => { globalThis.__v15SyntheticStatuses = [{ target: "Assault", source: "boss", kind: "poison", remainingTurns: 2 }]; });
    const badge = page.locator('.mecha-world-healthbar[data-unit-id="Assault"]');
    await page.waitForFunction(() => document.querySelector('.mecha-world-healthbar[data-unit-id="Assault"] .mecha-world-healthbar__status')?.textContent === "☠️2");
    try {
      await page.waitForFunction(lang => {
        const label = document.querySelector('.mecha-world-healthbar[data-unit-id="Assault"]')?.getAttribute("aria-label") ?? "";
        return lang === "zh" ? /中毒.*2/.test(label) : /Poison.*2 turns/.test(label);
      }, locale);
    } catch (error) {
      console.error("status badge diagnostics", { locale, badge: await badge.getAttribute("aria-label"), text: await badge.locator(".mecha-world-healthbar__status").textContent() });
      throw error;
    }
    assert.match(await badge.getAttribute("aria-label"), locale === "zh" ? /中毒.*2/ : /Poison.*2 turns/);
    await page.evaluate(() => { globalThis.__v15SyntheticStatuses = []; });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
    await root.waitFor(); await button("恢复对局", "Recover match").click();
    assert.deepEqual(await page.evaluate(() => globalThis.__v15Controller.getState().match.mechs.map(m => [m.id, m.pos.x, m.pos.y])), deployed, "opening checkpoint survives reload before any action");
    const roster = root.locator(".mecha-v15-roster .mecha-plan-card");
    assert.match(await roster.nth(0).innerText(), locale === "zh" ? /部署点.*可移动 · 可行动/s : /Deployed at.*Can move · Can act/s);
    const inspectTile = async reachable => {
      const tile = await page.evaluate(wantReachable => {
        const world = globalThis.__v15World, { BOARD, occupant } = globalThis.__v15MoveHelpers;
        const match = globalThis.__v15Controller.getState().match;
        const canvas = world.engine.domCanvas, rect = canvas.getBoundingClientRect();
        const candidates = [];
        for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
          const cell = { x, y };
          if (occupant(match, cell) !== "empty" || world.view().reach.some(c => c.x === x && c.y === y) !== wantReachable) continue;
          const at = world.cellWorld(world.site, cell);
          const projected = world.camera.position.clone().set(at.x, at.y + 0.35, at.z).project(world.camera);
          const px = rect.left + (projected.x + 1) * rect.width / 2, py = rect.top + (1 - projected.y) * rect.height / 2;
          if (document.elementFromPoint(px, py) === canvas) candidates.push({ x: px, y: py, key: `${x},${y}`, centerDistance: Math.hypot(projected.x, projected.y) });
        }
        return candidates.sort((a, b) => a.centerDistance - b.centerDistance)[0] ?? null;
      }, reachable);
      assert.ok(tile, "an empty tile is visible on the canvas");
      const revision = await page.evaluate(() => globalThis.__v15Controller.getState().match.revision);
      await page.mouse.click(tile.x, tile.y);
      const inspector = root.locator(`.mecha-cell-inspector[data-cell="${tile.key}"]`);
      await inspector.waitFor();
      assert.equal(await inspector.locator("details[open]").count(), 1, "terrain rules are visible immediately");
      assert.equal(await inspector.locator("details p").first().evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
      }), true, "terrain description is not covered by another panel");
      assert.equal(await page.evaluate(() => globalThis.__v15Controller.getState().match.revision), revision, "inspection never commits a move");
      await page.screenshot({ path: `/tmp/mecha-v15-tile-inspection-${locale}.png` });
      await button("关闭属性", "Close information").click();
      await inspector.waitFor({ state: "hidden" });
    };
    await inspectTile(false);
    await button("查看战场", "View field").click();
    await inspectTile(true);
    await root.locator(".mecha-v15-roster button").nth(2).click(); await openMovementList();
    const supportOpeningCells = await page.locator("#v15-cell option").evaluateAll(options => options.map(option => option.value).filter(Boolean));
    const supportJointCell = await page.evaluate(values => {
      const controller = globalThis.__v15Controller, { BOARD, pathDistance, moveBudget, occupant } = globalThis.__v15MoveHelpers;
      for (const supportCell of values) {
        const [sx, sy] = supportCell.split(",").map(Number);
        const supportTrial = controller.preview({ kind: "move", mech: "Support", to: { x: sx, y: sy } });
        if (!supportTrial?.ok) continue;
        const match = supportTrial.snapshot.match, gunner = match.mechs.find(mech => mech.id === "Gunner");
        for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
          const cell = { x, y }, distance = pathDistance(match, gunner.pos, cell, gunner.id, { alliesPass: true });
          if (occupant(match, cell) !== "empty" || distance === null || distance > moveBudget(gunner.id)) continue;
          const moved = structuredClone(match); moved.mechs.find(mech => mech.id === "Gunner").pos = cell;
          if (globalThis.__v15LegalActions(moved, "Gunner").some(action => action.kind === "shoot")) return supportCell;
        }
      }
      return null;
    }, supportOpeningCells);
    assert.ok(supportJointCell, "Support can move without eliminating Gunner's legal shot");
    await page.locator("#v15-cell").selectOption(supportJointCell); await button("移动", "Move").click();
    await page.waitForFunction(() => { const state = globalThis.__v15Controller.getState(); return !state.presentation && state.persistence === "ready"; });
    await root.locator(".mecha-v15-roster button").nth(1).click();
    await openMovementList();
    const gunnerMoveCells = await page.locator("#v15-cell option").evaluateAll(options => options.map(option => option.value).filter(Boolean));
    const attackPlan = await page.evaluate(values => {
      const controller = globalThis.__v15Controller;
      for (const value of values) {
        const [x, y] = value.split(",").map(Number);
        const trial = controller.preview({ kind: "move", mech: "Gunner", to: { x, y } });
        if (!trial?.ok) continue;
        const action = globalThis.__v15LegalActions(trial.snapshot.match, "Gunner").find(candidate => candidate.kind === "shoot");
        if (action) return { cell: value };
      }
      return null;
    }, gunnerMoveCells);
    assert.ok(attackPlan, "Gunner can move to a cell with a legal shot");
    await page.locator("#v15-cell").selectOption(attackPlan.cell); await button("移动", "Move").click();
    await page.waitForFunction(() => { const state = globalThis.__v15Controller.getState(); return !state.presentation && state.persistence === "ready"; });
    const shoot = root.locator(".mecha-action-card").filter({ hasText: locale === "zh" ? "射击" : "Shoot" });
    await shoot.waitFor(); assert.equal(await shoot.isEnabled(), true, "moving Gunner makes a legal attack actionable");
    await shoot.click();
    const shotTarget = root.locator(".mecha-target-preview .mecha-actions button").first();
    await shotTarget.waitFor(); await shotTarget.click();
    assert.equal(await button("确认行动", "Confirm action").isEnabled(), true, "selected attack target can be executed");
    await root.locator(".mecha-v15-roster button").nth(0).click();
    assert.equal(await button("确认行动", "Confirm action").isDisabled(), true, "Gunner's attack preview cannot be confirmed from the Assault panel");
    await root.locator(".mecha-v15-roster button").nth(1).click();
    assert.equal(await button("确认行动", "Confirm action").isDisabled(), true, "switching back requires a fresh target");
    await shoot.click();
    await shotTarget.click();
    await button("确认行动", "Confirm action").click();
    await page.waitForFunction(() => { const state = globalThis.__v15Controller.getState(); return !state.presentation && state.persistence === "ready"; });
    assert.equal(await page.locator("#v15-cell").isDisabled(), true, "a mech that already moved cannot choose another path");
    assert.match(await roster.nth(1).innerText(), locale === "zh" ? /已移动 · 已行动/ : /Moved · Acted/);
    assert.equal(await button("撤销移动", "Undo move").isDisabled(), true, "Gunner's panel cannot undo Support's move");
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
    assert.equal(await button("撤销移动", "Undo move").isEnabled(), true, "Support can still undo after Gunner acts");
    assert.match(await root.locator(".mecha-selected-actions").innerText(), locale === "zh" ? /仍可撤销/ : /still undo this mech/);
    const movementSummary = root.locator(".mecha-move-list > summary");
    if (await movementSummary.evaluate(element => element.parentElement.open)) await movementSummary.click();
    await root.locator(".mecha-selected-actions").evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: `/tmp/mecha-v15-cross-mech-undo-${locale}.png` });
    await button("撤销移动", "Undo move").click();
    await page.waitForFunction(() => { const state = globalThis.__v15Controller.getState(); return !state.presentation && state.persistence === "ready"; });
    const supportUndo = await page.evaluate(() => {
      const state = globalThis.__v15Controller.getState(), support = state.match.mechs.find(mech => mech.id === "Support");
      return { cell: `${support.pos.x},${support.pos.y}`, canMove: state.rights.Support.move, canAct: state.rights.Support.action };
    });
    assert.equal(supportUndo.cell, cells[2], "undo restores Support's opening position even after Gunner acted");
    assert.equal(supportUndo.canMove, true); assert.equal(supportUndo.canAct, true);
    assert.match(await roster.nth(2).innerText(), locale === "zh" ? /可移动 · 可行动/ : /Can move · Can act/);
    await openMovementList();
    const select = page.locator("#v15-cell");
    const moveCells = await select.locator("option").evaluateAll(options => options.map(option => option.value).filter(Boolean));
    const newDestination = moveCells.find(cell => cell !== supportJointCell);
    assert.ok(newDestination, "Support can choose a different destination after undo");
    await select.selectOption(newDestination); await button("移动", "Move").click();
    await page.waitForFunction(() => document.querySelector('.mecha-action-card:not(:disabled)'));
    await page.waitForFunction(() => !globalThis.__v15Controller.getState().presentation);
    const moved = await page.evaluate(() => {
      const state = globalThis.__v15Controller.getState(), actor = state.match.mechs.find(m => m.id === state.selected), world = globalThis.__v15World;
      const at = world.cellWorld(world.site, actor.pos), model = world.figures[actor.id];
      return { cell: `${actor.pos.x},${actor.pos.y}`, distance: Math.hypot(at.x - model.position.x, at.z - model.position.z) };
    });
    assert.equal(moved.cell, newDestination); assert.ok(moved.distance < .02, `rendered position differs by ${moved.distance}`);
    const hold = root.locator(".mecha-action-card").filter({ hasText: locale === "zh" ? "待机" : "Hold" });
    assert.equal(await hold.count(), 1, "one card per hold action"); assert.equal(await hold.isEnabled(), true);
    await hold.click();
    assert.equal(await button("确认行动", "Confirm action").isEnabled(), true, "hold action can be confirmed without a target");
    await button("确认行动", "Confirm action").click();
    await page.waitForFunction(() => { const state = globalThis.__v15Controller.getState(); return !state.presentation && state.persistence === "ready"; });
    assert.equal(await button("撤销移动", "Undo move").isDisabled(), true, "a mech's own action locks its movement undo");
    await page.screenshot({ path: `/tmp/mecha-v15-post-action-locked-${locale}.png` });
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
      await button("暂停演出", "Pause animation").click();
      assert.equal(await button("继续演出", "Resume animation").isVisible(), true);
      await page.locator(".mecha-replay-bar select").selectOption("2");
      await page.screenshot({ path: `/tmp/mecha-v15-replay-controls-${locale}.png` });
      await button("继续演出", "Resume animation").click();
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
      const resultDialog = page.locator("[data-mecha-result-dialog]");
      await resultDialog.waitFor({ state: "visible" });
      assert.match(await resultDialog.innerText(), terminal === "victory" ? /战斗胜利/ : /战斗失败/);
      await resultDialog.locator("[data-result-review] summary").click();
      await resultDialog.locator("[data-mecha-round-review]").waitFor();
      assert.match(await resultDialog.locator("[data-mecha-round-review]").innerText(), /已核对的结算事件/);
      await page.screenshot({ path: "/tmp/mecha-v15-terminal-result-zh.png" });
      await page.keyboard.press("Escape");
      await resultDialog.waitFor({ state: "hidden" });
      await button("查看结算", "View results").click();
      await resultDialog.waitFor({ state: "visible" });
      await resultDialog.locator("[data-result-replay]").click();
      await page.locator(".mecha-replay-bar").waitFor();
      assert.match(await page.locator(".mecha-replay-bar").innerText(), /回放步骤 0\//);
      await button("返回对局", "Return to match").click();
      await resultDialog.waitFor({ state: "visible" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(".city-loading").waitFor({ state: "hidden" });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await root.waitFor(); await button("查看已结束对局", "Review finished match").click();
      await page.locator("[data-mecha-result-dialog]").waitFor({ state: "visible" });
      page.once("dialog", dialog => dialog.accept());
      await page.locator("[data-result-restart]").click();
      await root.locator(".mecha-deploy-roster").waitFor();
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
