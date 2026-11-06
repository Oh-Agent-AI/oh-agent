#!/usr/bin/env node
// Synthetic city, real controller/UI/world. No native IPC or external network.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5179";
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const lang of ["zh", "en"]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    page.setDefaultTimeout(90000);
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(base)) external.push(request.url()); });
    await page.route("**/*", route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.routeWebSocket("**/*", ws => ws.close());
    await page.addInitScript(lang => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en"; }, lang);
    await page.route("**/src/game/MechaBoard.tsx*", async route => {
      const response = await route.fetch(); let body = await response.text();
      const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
      assert.equal(body.split(needle).length, 2, "fixture controller seam");
      body = body.replace(needle, needle.replace("animate: true, locale", "animate: true, deployment: false, locale") + '\nwindow.__swarmController = controllerRef.current;');
      await route.fulfill({ response, body });
    });
    const text = (zh, en) => lang === "zh" ? zh : en;
    await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: text("城市设置", "City settings"), exact: true }).click();
    await page.getByRole("button", { name: text("机甲战棋", "Mecha tactics"), exact: true }).click();
    await page.waitForFunction(() => window.__swarmController?.getState().match.phase === "player_plan");
    await page.locator('[data-mecha-settings-trigger="battlefield"]').click();
    const settings = page.locator("#mecha-battlefield-settings");
    await settings.waitFor({ state: "visible" });
    await settings.locator("[data-monster-practice] summary").click();
    await settings.locator("[data-monster-practice-select]").selectOption("swarm_mantle");
    await settings.locator("[data-monster-practice-start]").click();
    await settings.locator("[data-monster-practice-confirm]").click();
    await page.waitForFunction(() => window.__swarmController.getState().match.boss.intent?.skillId === "split_swarm");
    assert.equal(await settings.getByRole("button", { name: text("生成行动建议", "Generate suggestions"), exact: true }).isDisabled(), true);
    assert.equal(await settings.getByRole("button", { name: text("自动对战", "Auto battle"), exact: true }).isDisabled(), true);
    assert.ok((await settings.innerText()).includes(text("当前敌人暂不支持行动建议或自动对战，请手动规划。", "Suggestions and auto play are unavailable for this enemy; plan manually.")));
    await settings.getByRole("button", { name: text("关闭设置", "Close settings") }).click();
    const projection = await page.evaluate(() => {
      const c = window.__swarmController;
      for (const mech of c.getState().match.mechs.filter(m => m.hp > 0)) c.setAction(mech.id, { kind: "skip" });
      const s = c.getState();
      return { candidates: s.match.boss.intent.swarm.request.candidates,
        slots: s.preview?.monsterProjection?.swarmProjection?.slots };
    });
    assert.equal(projection.candidates.length, 8);
    assert.equal(projection.slots.length, 8);
    await page.locator(".mecha-threat-details summary").click();
    const intent = page.locator("[data-monster-intent]");
    await intent.waitFor({ state: "visible" });
    const intentText = await intent.innerText();
    assert.ok(intentText.includes(text("原始候选格（顺序固定）", "Original candidate cells (fixed order)")));
    assert.ok(intentText.includes(text("草稿重投影", "Draft reprojection")));
    assert.ok(intentText.includes(text("以下为预测召唤，并非已生成。", "Projected spawns, not units already spawned.")));
    const displayedSlots = await intent.locator("[data-swarm-slot]").evaluateAll(nodes => nodes.map(node => ({ cell: node.dataset.swarmSlot, status: node.dataset.status })));
    // The last eight slots belong to the post-draft projection, not the original declaration.
    assert.deepEqual(displayedSlots.slice(-8), projection.slots.map(slot => ({
      cell: `${slot.cell.x},${slot.cell.y}`,
      status: slot.reason === null && slot.unit ? "valid" : typeof slot.reason === "string" && slot.unit === null ? "invalid" : "unknown"
    })));
    const turn = await page.evaluate(() => {
      const c = window.__swarmController, before = c.getState().match, preview = c.getState().preview;
      c.submit(); if (c.getState().holdConfirmation) c.confirmHold();
      return { ready: preview.ok, expected: preview.ok ? preview.log : [], actual: c.getState().lastLog,
        revision: c.getState().match.revision, prior: before.revision, events: c.getState().performance?.events ?? [] };
    });
    assert.equal(turn.ready, true);
    assert.ok(turn.revision > turn.prior);
    assert.deepEqual(turn.actual, turn.expected);
    const births = turn.actual.filter(e => e.type === "raider_spawn");
    assert.ok(births.length > 0, "the real city encounter must produce summons");
    assert.equal(turn.events.filter(e => e.kind === "raider_spawn").length, births.length);
    await page.waitForFunction(() => !window.__swarmController.getState().performance, null, { timeout: 60000 });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(`${lang}: swarm city UI, manual-only gate, authoritative turn and real presentation passed`);
    await page.close();
  }
} finally { await browser.close(); }
