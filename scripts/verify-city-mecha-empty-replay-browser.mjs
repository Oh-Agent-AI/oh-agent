#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/src/engine/CityEngine.ts*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("if (this.documentHidden) return;", "if (this.documentHidden || window.__pauseFixtureDraw) return;") });
  });
  await page.route("**/src/game/MechaBoard.tsx*", async route => {
    const response = await route.fetch();
    let body = await response.text();
    const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
    assert.ok(body.includes(needle));
    body = 'import { createMatch as replayFixture, bossPrepare as prepareReplayFixture } from "/src/game/mecha/rules.ts";\n' + body;
    body = body.replace(needle, `const fixture = replayFixture({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], raiders: [] });
      fixture.turn = 15; prepareReplayFixture(fixture);
      fixture.boss.intent = { skillId: "skip", local: [], projected: [], cdSweep: 0, status: "planned" };
      controllerRef.current = createMechaController({ animate: true, locale, site, match: fixture });
      window.__replayController = controllerRef.current;`);
    await route.fulfill({ response, body });
  });
  await page.addInitScript(() => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = "zh-Hans"; });
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5190", { waitUntil: "domcontentloaded", timeout: 240000 });
  await page.locator(".city-loading").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "城市设置" }).click();
  await page.getByRole("button", { name: "机甲战棋", exact: true }).click();
  await page.waitForFunction(() => window.__replayController?.getState().match.phase === "player_plan");
  const result = await page.evaluate(() => {
    const c = window.__replayController;
    window.__pauseFixtureDraw = true;
    for (const mech of c.getState().match.mechs) { c.setMove(mech.id, null); c.setAction(mech.id, { kind: "skip" }); }
    c.submit();
    if (c.getState().holdConfirmation) c.confirmHold();
    return { outcome: c.getState().match.outcome, recorded: c.getState().replayAvailable, performance: c.getState().performance };
  });
  assert.deepEqual(result, { outcome: "defeat_timeout", recorded: 1, performance: null });
  await page.evaluate(async () => {
    const { ReplayHoldClock } = await import("/src/game/mecha/replayPlayback.ts");
    window.__emptyClock = [];
    const start = ReplayHoldClock.prototype.start;
    const stop = ReplayHoldClock.prototype.stop;
    ReplayHoldClock.prototype.start = function(now, speed) {
      const wait = start.call(this, now, speed); window.__emptyClock.push({ kind: "start", speed, wait }); return wait;
    };
    ReplayHoldClock.prototype.stop = function(now) {
      const remaining = stop.call(this, now); window.__emptyClock.push({ kind: "stop", remaining }); return remaining;
    };
  });
  const dialog = page.locator("[data-mecha-result-dialog]");
  await dialog.waitFor({ state: "visible" });
  await dialog.locator("[data-result-replay]").click();
  const bar = page.locator("[data-mecha-replay]");
  await bar.waitFor({ state: "visible" });
  assert.ok((await bar.innerText()).includes("无演出事件"));
  await bar.getByRole("button", { name: "暂停演出" }).click();
  assert.equal(await bar.getByRole("button", { name: "上一回合" }).isDisabled(), true);
  assert.equal(await bar.getByRole("button", { name: "下一回合" }).isDisabled(), true);
  await bar.getByRole("combobox", { name: "播放速度" }).selectOption("0.5");
  await bar.getByRole("button", { name: "重播本回合" }).click();
  assert.equal(await page.evaluate(() => window.__replayController.getState().paused), true);
  await page.waitForTimeout(2500);
  assert.ok(await page.evaluate(() => window.__replayController.getState().replay));
  await bar.getByRole("button", { name: "继续演出" }).click();
  await page.waitForFunction(() => window.__emptyClock.some(e => e.kind === "start" && e.speed === 0.5));
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const remaining = await page.evaluate(() => window.__emptyClock.filter(e => e.kind === "stop").at(-1).remaining);
  assert.ok(remaining > 0, "empty hold retains time when the document becomes hidden");
  await page.waitForTimeout(4200);
  assert.ok(await page.evaluate(() => window.__replayController.getState().replay), "hidden empty replay does not advance");
  await bar.getByRole("combobox", { name: "播放速度" }).selectOption("2");
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForFunction(() => window.__emptyClock.some(e => e.kind === "start" && e.speed === 2));
  const acceleratedWait = await page.evaluate(() => window.__emptyClock.filter(e => e.kind === "start" && e.speed === 2).at(-1)?.wait);
  assert.ok(Math.abs(acceleratedWait - remaining / 2) < 5, `resumed 2× hold preserves time: ${acceleratedWait} / ${remaining}`);
  await dialog.waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => window.__replayController.getState().replay), null);
  assert.deepEqual(errors, []);
  console.log("Empty-event replay respects pause, hidden time and speed, then returns to result.");
  await page.close();
} finally { await browser.close(); }
