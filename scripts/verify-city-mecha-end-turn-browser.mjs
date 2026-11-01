#!/usr/bin/env node
// Synthetic City/controller fixture. Start the UI's Vite server before running:
// node scripts/verify-city-mecha-end-turn-browser.mjs http://127.0.0.1:5389
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5389";
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const locale of ["zh", "en"]) {
    const zh = locale === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let patched = false, patchError = null;
    await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
      try {
        const response = await route.fetch();
        let body = await response.text();
        const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
        assert.equal(body.split(needle).length, 2, "controller fixture seam");
        const completions = [["onPerformanceComplete: finishPerformance", "onPerformanceComplete: () => {}"], ["onPerformanceComplete={finishPerformance}", "onPerformanceComplete={() => {}}"]];
        const matches = completions.filter(([token]) => body.split(token).length === 2);
        assert.equal(matches.length, 1, "playback completion fixture seam");
        body = body.replace(matches[0][0], matches[0][1]);
        body = 'import { createMatch as endTurnMatch, bossPrepare as endTurnPrepare } from "/src/game/mecha/rules.ts";\n' + body;
        body = body.replace(needle, `const fixture = endTurnMatch({preset:"covers_sparse_mid", script:"cadence_ssw", covers:[],
          buildings:[{id:"end-turn-building",cells:[{x:4,y:2}],hp:10}], boss:{x:4,y:0},
          raiders:[{id:"raider-w",pos:{x:4,y:4}},{id:"raider-e",pos:{x:6,y:4}}],
          mechs:[{id:"Assault",pos:{x:5,y:2}},{id:"Gunner",pos:{x:2,y:8}},{id:"Support",pos:{x:7,y:2}}]});
          fixture.boss.cadence = 2; endTurnPrepare(fixture);
          fixture.mechs.find((m) => m.id === "Assault").pos = {x:6,y:3};
          controllerRef.current = createMechaController({animate:true, locale, site, match:fixture,
            planner:(state) => ({revision:state.revision,items:[]})});
          globalThis.__endTurnController = controllerRef.current;`);
        patched = true;
        await route.fulfill({ response, body });
      } catch (error) { patchError = error.message; await route.abort(); }
    });
    await page.addInitScript((lang) => {
      localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang;
      const frame = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map(); let sequence = 0;
      window.requestAnimationFrame = (callback) => {
        const id = ++sequence;
        const timer = setTimeout(() => { const handle = frame((time) => { pending.delete(id); callback(time); }); pending.set(id, { handle }); }, 100);
        pending.set(id, { timer }); return id;
      };
      window.cancelAnimationFrame = (id) => { const entry = pending.get(id); if (entry?.timer !== undefined) clearTimeout(entry.timer); if (entry?.handle !== undefined) cancel(entry.handle); pending.delete(id); };
    }, zh ? "zh-Hans" : "en");
    const button = (z, e) => page.getByRole("button", { name: zh ? z : e, exact: true });
    try {
      await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 180_000 });
      await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 180_000 });
      assert.ok(patched, `fixture not applied: ${patchError}`);
      await button("城市设置", "City settings").click();
      await button("机甲战棋", "Mecha tactics").click();
      const end = button("结束回合", "End turn"), status = page.locator("#mecha-submit-status");
      await end.waitFor();
      assert.equal(await end.isDisabled(), true, "unplanned mechs must block end turn");
      assert.match(await status.innerText(), zh ? /待规划/ : /Needs action/);
      assert.equal(await end.getAttribute("aria-describedby"), "mecha-submit-status");
      assert.match(await page.locator(".mecha-submit strong").first().innerText(), /0\/3/);
      for (let i = 0; i < 3; i++) {
        await page.locator(".mecha-pack li > button").nth(i).click();
        await page.locator(".mecha-selected-actions").getByRole("button", { name: zh ? "待机" : "Hold", exact: true }).click();
      }
      assert.equal(await end.isEnabled(), true);
      assert.match(await status.innerText(), zh ? /已就绪，可结束回合/ : /Ready to end the turn/);
      assert.match(await page.locator(".mecha-submit strong").first().innerText(), /3\/3/);
      for (const [width, height] of [[640, 480], [1100, 700]]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(300);
        const geometry = await end.evaluate((el) => {
          const r = el.getBoundingClientRect(), style = getComputedStyle(el);
          const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          return { rect: r.toJSON(), visible: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
            hit: hit === el || el.contains(hit), fits: el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1,
            color: style.color, background: style.backgroundColor };
        });
        assert.ok(geometry.visible && geometry.hit && geometry.fits, `${locale} ${width}x${height} button inaccessible: ${JSON.stringify(geometry)}`);
        await end.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await end.evaluate((el) => document.activeElement === el), true, "end turn keyboard focus");
        assert.notEqual(await end.evaluate((el) => getComputedStyle(el).outlineStyle), "none", "keyboard focus indicator");
      }
      // All holds in this fixture threaten a building, so submission must not
      // skip its existing risk confirmation or advance before confirmation.
      await end.focus(); await page.keyboard.press("Enter");
      await button("继续提交", "Submit anyway").waitFor();
      assert.equal(await page.evaluate(() => globalThis.__endTurnController.getState().match.turn), 1);
      await button("继续提交", "Submit anyway").click();
      await page.waitForFunction(() => globalThis.__endTurnController.getState().performance !== null);
      assert.equal(await end.isDisabled(), true);
      assert.match(await status.innerText(), zh ? /等待战斗演出/ : /Waiting for battle playback/);
      await button("跳过演出", "Skip animation").click();
      await page.waitForFunction(() => !globalThis.__endTurnController.getState().performance);
      assert.equal(await page.evaluate(() => globalThis.__endTurnController.getState().match.turn), 2);
      assert.equal(await end.isDisabled(), true);
      assert.match(await status.innerText(), zh ? /待规划/ : /Needs action/);
      assert.deepEqual(errors, []);
      console.log(`${locale}: end turn labels, readiness, keyboard, layouts, confirmation and turn transition passed`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
console.log("Synthetic fixture only; physical touch, Tauri and remote matches are not covered.");
