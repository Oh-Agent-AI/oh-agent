#!/usr/bin/env node
// Real local rules/controller and live Three.js scene; playback is not a remote fixture.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5190";
const classicBase = new URL(base); classicBase.searchParams.set("mechaV15", "0");
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
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
    // Observe (but do not change) real player event settlement in the live scene.
    await page.route("**/src/render/mecha/animation.ts*", async route => {
      const response = await route.fetch();
      let body = await response.text();
      const needle = "this.onEventSettled?.(index);";
      assert.ok(body.includes(needle), "player instrumentation must match the served module");
      body = body.replace(needle, needle + '\nif (window.__tracePlayback) window.__settledTrace.push({ index, kind: event.kind, actor: event.actor, fallen: Array.from(this.fallen) });');
      await route.fulfill({ response, body });
    });
    // Observe the exact timestep consumed by the real 3D performance player.
    await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
      const response = await route.fetch();
      let body = await response.text();
      const needle = "const performanceDt = performanceDelta(dt, pausedRef.current, reduce, performanceSpeedRef.current);";
      assert.ok(body.includes(needle), "speed instrumentation must match the served module");
      body = body.replace(needle, needle + '\nif (window.__speedSamples) window.__speedSamples.push({ dt, actual: performanceDt, paused: pausedRef.current });');
      await route.fulfill({ response, body });
    });
    await page.route("**/src/game/MechaBoard.tsx*", async route => {
      const response = await route.fetch();
      let body = await response.text();
      const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
      assert.ok(body.includes(needle));
      body = body.replace(needle, needle.replace('animate: true, locale', 'animate: true, deployment: false, locale') + '\nwindow.__replayController = controllerRef.current;');
      await route.fulfill({ response, body });
    });
    await page.addInitScript(locale => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, zh ? "zh-Hans" : "en");
    await page.goto(classicBase.href, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
    await page.waitForFunction(() => window.__replayController?.getState().match.phase === "player_plan");
    const finish = await page.evaluate(() => {
      const c = window.__replayController;
      window.__pauseFixtureDraw = true;
      c.startAuto();
      for (let i = 0; i < 100 && !c.getState().match.outcome; i++) {
        c.tick();
        if (c.getState().performance) c.finishPerformance();
      }
      return { outcome: c.getState().match.outcome, count: c.getState().replayAvailable, match: JSON.stringify(c.getState().match), log: JSON.stringify(c.getState().lastLog) };
    });
    assert.ok(finish.outcome, `match reached outcome: ${JSON.stringify(finish)}`);
    assert.ok(finish.count >= 2, `multiple accepted turns: ${finish.count}`);
    const dialog = page.locator("[data-mecha-result-dialog]");
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("status").getByText(
      zh ? "本局回放已自动保存到本机。" : "This battle replay was saved locally automatically.",
    ).waitFor();
    await dialog.locator("[data-result-replay]").click();
    const bar = page.locator("[data-mecha-replay]");
    await bar.waitFor({ state: "visible" });
    assert.equal(await page.locator(".mecha-panel").count(), 0, "normal planning panels are absent during replay");
    await bar.getByRole("button", { name: zh ? "暂停演出" : "Pause animation" }).click();
    assert.equal(await page.evaluate(() => window.__replayController.getState().paused), true);
    assert.equal(await page.evaluate(() => window.__replayController.getState().replay.index), 0);
    const previous = bar.getByRole("button", { name: zh ? "上一回合" : "Previous turn" });
    const next = bar.getByRole("button", { name: zh ? "下一回合" : "Next turn" });
    const restart = bar.getByRole("button", { name: zh ? "重播本回合" : "Replay this turn" });
    assert.equal(await previous.isDisabled(), true); assert.equal(await next.isEnabled(), true);
    await next.click();
    assert.equal(await page.evaluate(() => window.__replayController.getState().replay.index), 1);
    assert.equal(await page.evaluate(() => window.__replayController.getState().paused), true);
    const cue = await page.evaluate(() => window.__replayController.getState().replay.combat.id);
    await restart.click();
    assert.ok(await page.evaluate(() => window.__replayController.getState().replay.combat.id) > cue, "replay current turn restarts the scene");
    assert.equal(await page.evaluate(() => window.__replayController.getState().replay.index), 1);
    await previous.click();
    assert.equal(await page.evaluate(() => window.__replayController.getState().replay.index), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().match)), finish.match);
    assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().lastLog)), finish.log);
    // Find a real recorded unit damage event and verify the actual world health
    // bar changes only after its corresponding cue; match authority stays final.
    await page.evaluate(() => { window.__pauseFixtureDraw = false; });
    const health = await page.evaluate(async () => {
      const { performanceHealthSchedule } = await import("/src/game/mecha/performanceHealth.ts");
      const c = window.__replayController;
      for (let i = 0; i < c.getState().replay.total; i++) {
        c.selectReplayTurn(i);
        const s = c.getState();
        const schedule = performanceHealthSchedule(s.performance.events, s.replay.combat.healthTimeline, s.replay.combat.presentationChanges);
        if (!schedule) continue;
        for (const effects of schedule) {
          const effect = effects.find(e => e.kind !== "building" && e.before > 0 && e.after < e.before);
          if (!effect) continue;
          const same = effects.filter(e => e.kind === effect.kind && e.id === effect.id);
          // Verify the first change to this unit, so the displayed starting HP is known.
          const earlier = schedule.slice(0, schedule.indexOf(effects)).flat().some(e => e.kind === effect.kind && e.id === effect.id);
          if (!earlier) return { index: i, id: effect.id, before: effect.before, after: same.at(-1).after };
        }
      }
      return null;
    });
    assert.ok(health, "recorded match includes a verifiable unit health change");
    const meter = page.locator(`.mecha-world-healthbar[data-unit-id="${health.id}"]`);
    await page.waitForFunction(({ id, before }) => document.querySelector(`.mecha-world-healthbar[data-unit-id="${id}"]`)?.getAttribute("aria-valuenow") === String(before), health);
    await page.waitForTimeout(350);
    assert.equal(await meter.getAttribute("aria-valuenow"), String(health.before), "paused playback keeps the initial health");
    const speed = bar.getByRole("combobox", { name: zh ? "播放速度" : "Playback speed" });
    assert.equal(await speed.inputValue(), "1");
    for (const rate of [0.5, 2, 1]) {
      await speed.selectOption(String(rate));
      await restart.click();
      await page.evaluate(() => { window.__speedSamples = []; });
      await bar.getByRole("button", { name: zh ? "继续演出" : "Resume animation" }).click();
      await page.waitForFunction(() => window.__speedSamples?.some(sample => !sample.paused && sample.dt > 0), null, { timeout: 90000 });
      await bar.getByRole("button", { name: zh ? "暂停演出" : "Pause animation" }).click();
      const samples = await page.evaluate(() => { const result = window.__speedSamples; window.__speedSamples = null; return result; });
      const running = samples.filter(sample => !sample.paused && sample.dt > 0);
      assert.ok(running.length > 0 && running.every(sample => Math.abs(sample.actual - sample.dt * rate) < 1e-9), `actual 3D playback uses ${rate}×: ${JSON.stringify(running)}`);
      assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().match)), finish.match);
      assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().lastLog)), finish.log);
    }
    await restart.click();
    await page.waitForFunction(({ id, before }) => document.querySelector(`.mecha-world-healthbar[data-unit-id="${id}"]`)?.getAttribute("aria-valuenow") === String(before), health);
    await bar.getByRole("button", { name: zh ? "继续演出" : "Resume animation" }).click();
    await page.waitForFunction(({ id, after }) => document.querySelector(`.mecha-world-healthbar[data-unit-id="${id}"]`)?.getAttribute("aria-valuenow") === String(after), health, { timeout: 90000 });
    await bar.getByRole("button", { name: zh ? "暂停演出" : "Pause animation" }).click();
    const pausedHp = await meter.getAttribute("aria-valuenow");
    await page.waitForTimeout(400);
    assert.equal(await meter.getAttribute("aria-valuenow"), pausedHp, "paused playback freezes displayed health");
    await restart.click();
    await page.waitForFunction(({ id, before }) => document.querySelector(`.mecha-world-healthbar[data-unit-id="${id}"]`)?.getAttribute("aria-valuenow") === String(before), health);
    assert.equal(await page.evaluate(() => window.__replayController.getState().replay.index), health.index);
    assert.equal(await page.evaluate(() => window.__replayController.getState().paused), true, "restarting a turn keeps playback paused");
    await page.waitForTimeout(350);
    assert.equal(await meter.getAttribute("aria-valuenow"), String(health.before), "restart resets the actual world health display");
    assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().match)), finish.match);
    // Play a real turn with an early defeat and inspect the live 3D player's
    // settled cues, rather than just comparing the generated event list.
    const death = await page.evaluate(() => {
      const c = window.__replayController;
      for (let i = 0; i < c.getState().replay.total - 1; i++) {
        c.selectReplayTurn(i);
        const events = c.getState().performance.events;
        for (let d = 0; d < events.length; d++) {
          if (events[d].kind !== "death") continue;
          const later = events.findIndex((event, index) => index > d && event.kind === "attack");
          if (later >= 0) return { turn: i, death: d, actor: events[d].actor, later, laterActor: events[later].actor };
        }
      }
      return null;
    });
    assert.ok(death, "a real replay contains a defeat before another attack");
    await page.waitForTimeout(600); // allow the paused scene to load the selected turn
    await page.evaluate(() => { window.__settledTrace = []; window.__tracePlayback = true; });
    await bar.getByRole("button", { name: zh ? "继续演出" : "Resume animation" }).click();
    await page.waitForFunction(({ later, laterActor }) => window.__settledTrace.some(e => e.index === later && e.kind === "attack" && e.actor === laterActor), death, { timeout: 90000 });
    await bar.getByRole("button", { name: zh ? "暂停演出" : "Pause animation" }).click();
    const pausedEvents = await page.evaluate(() => window.__settledTrace.length);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.__settledTrace.length), pausedEvents, "paused replay settles no additional cues");
    const trace = await page.evaluate(() => { window.__tracePlayback = false; return window.__settledTrace; });
    const deathEntry = trace.findIndex(e => e.index === death.death && e.kind === "death" && e.actor === death.actor);
    const laterEntry = trace.findIndex(e => e.index === death.later && e.kind === "attack" && e.actor === death.laterActor);
    assert.ok(deathEntry >= 0 && laterEntry > deathEntry, `live player settles death before later attack: ${JSON.stringify(trace)}`);
    assert.ok(trace[laterEntry].fallen.includes(death.actor), "the actor remains fallen during the later attack");
    assert.equal(await page.evaluate(id => document.querySelector(`.mecha-world-healthbar[data-unit-id="${id}"]`)?.getAttribute("aria-valuenow"), death.actor), "0");
    assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().match)), finish.match);
    assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().lastLog)), finish.log);
    await bar.locator("[data-replay-turn]").selectOption("0");
    // Let the actual scene complete the first round and advance on its own.
    await bar.getByRole("button", { name: zh ? "继续演出" : "Resume animation" }).click();
    await page.waitForFunction(() => window.__replayController.getState().replay?.index >= 1, null, { timeout: 90000 });
    await bar.getByRole("button", { name: zh ? "暂停演出" : "Pause animation" }).click();
    const select = bar.locator("[data-replay-turn]");
    await select.selectOption(String(finish.count - 1));
    assert.equal(await page.evaluate(() => window.__replayController.getState().replay.index), finish.count - 1);
    assert.equal(await page.evaluate(() => window.__replayController.getState().paused), true);
    assert.equal(await next.isDisabled(), true); assert.equal(await previous.isEnabled(), true);
    for (const viewport of [{ width: 1100, height: 700 }, { width: 390, height: 844 }, { width: 640, height: 480 }]) {
      await page.setViewportSize(viewport);
      const bounds = await bar.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
      assert.ok(bounds.x >= -1 && bounds.y >= -1 && bounds.right <= viewport.width + 1 && bounds.bottom <= viewport.height + 1, `${lang}: replay controls fit ${JSON.stringify(bounds)}`);
      assert.ok(Math.abs(viewport.height - bounds.bottom - 12) <= 1, `${lang}: replay controls are anchored at the bottom ${JSON.stringify(bounds)}`);
      const clipped = await bar.evaluate(el => el.scrollWidth > el.clientWidth + 1);
      assert.equal(clipped, false, `${lang}: replay controls should not overflow horizontally`);
      await page.screenshot({ path: `/tmp/mecha-replay-navigation-${lang}-${viewport.width}.png` });
    }
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.evaluate(() => { window.__pauseFixtureDraw = false; });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `/tmp/mecha-local-replay-${lang}.png` });
    const preserved = await page.evaluate(() => ({ match: JSON.stringify(window.__replayController.getState().match), log: JSON.stringify(window.__replayController.getState().lastLog) }));
    assert.equal(preserved.match, finish.match);
    assert.equal(preserved.log, finish.log);
    await bar.getByRole("button", { name: zh ? "继续演出" : "Resume animation" }).click();
    await dialog.waitFor({ state: "visible", timeout: 90000 });
    assert.equal(await page.evaluate(() => window.__replayController.getState().replay), null);
    assert.equal(await page.evaluate(() => JSON.stringify(window.__replayController.getState().match)), finish.match);
    const survivor = await page.evaluate(() => {
      const match = window.__replayController.getState().match;
      return [...match.mechs, ...match.raiders, { id: "boss", hp: match.boss.hp }].find(unit => unit.hp > 0) ?? null;
    });
    if (survivor) await page.waitForFunction(({ id, hp }) => document.querySelector(`.mecha-world-healthbar[data-unit-id="${id}"]`)?.getAttribute("aria-valuenow") === String(hp), survivor);
    await dialog.locator("[data-result-replay]").click();
    await bar.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
    console.log(`${lang}: replayed ${finish.count} real turns; navigation, pause, defeat ordering, resume, result and authority verified`);
    await page.close();
  }
} finally { await browser.close(); }
