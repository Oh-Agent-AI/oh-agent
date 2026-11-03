#!/usr/bin/env node
import { completeLocalDeployment } from "./mecha-deployment-browser-helpers.mjs";
// Synthetic city only. The injected view is a legend display fixture, not a
// rule-valid battle, damage/push simulation or remote match authorization.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.env.MECHA_SCREENSHOTS_DIR;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
const results = [];
try {
  for (const lang of ["zh", "en"]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1 });
    const page = await context.newPage(); page.setDefaultTimeout(60_000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.addInitScript(lang => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en"; }, lang);
    await page.route("**/src/game/MechaBattleLegend.tsx*", async route => {
      const response = await route.fetch(), source = await response.text();
      const needle = "const legend = presentBattleLegend(view, locale);";
      assert.equal(source.split(needle).length, 2, "legend-only display seam");
      await route.fulfill({ response, body: source.replace(needle, "const legend = presentBattleLegend(globalThis.__legendFixture ?? view, locale); globalThis.__legendLiveView = view;") });
    });
    const button = (zh, en) => page.getByRole("button", { name: lang === "zh" ? zh : en, exact: true });
    const legend = page.locator(".mecha-tactical-legend > .mecha-battle-legend");
    const summary = page.locator(".mecha-tactical-legend > summary");
    const measure = async label => {
      const geometry = await legend.evaluate(el => {
        const b = el.getBoundingClientRect();
        const clipped = [...el.querySelectorAll("strong,small,h4,p")].filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent);
        return { x: b.x, y: b.y, width: b.width, height: b.height, viewport: [innerWidth, innerHeight], clipped, items: [...el.querySelectorAll("[data-legend-item]")].map(n => n.dataset.legendItem) };
      });
      assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.x + geometry.width <= geometry.viewport[0] + 1 && geometry.y + geometry.height <= geometry.viewport[1] + 1, `${label} leaves viewport: ${JSON.stringify(geometry)}`);
      assert.deepEqual(geometry.clipped, [], `${label} clips text`);
      assert.ok(geometry.items.length >= 2 && geometry.items.length <= 5);
      assert.equal(await legend.locator('[data-legend-item="declared"]').count(), 1);
      assert.equal(await legend.locator('[data-legend-item="projected"]').count(), 1);
      assert.doesNotMatch(await legend.innerText(), /可选目标|已选目标|Selected target|Both threats|✣/);
      return geometry;
    };
    try {
      await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 90_000 });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await page.locator(".mecha-turn-summary").waitFor(); await completeLocalDeployment(page);
      await page.waitForFunction(() => Boolean(globalThis.__legendLiveView));
      assert.equal(await page.locator(".mecha-tactical-legend").getAttribute("open"), null, "default key stays collapsed");
      await summary.focus(); await page.keyboard.press("Enter");
      for (const [width, height] of [[1100, 700], [1768, 748], [640, 480]]) {
        await page.setViewportSize({ width, height }); await page.waitForTimeout(400);
        const geometry = await measure(`actual ${lang} ${width}x${height}`);
        const expected = await page.evaluate(async lang => {
          const { presentBattleLegend } = await import("/src/game/mecha/legendPresentation.ts");
          return presentBattleLegend(globalThis.__legendLiveView, lang === "zh" ? "zh-Hans" : "en").actions.map(item => item.id);
        }, lang);
        assert.deepEqual(geometry.items.slice(2), expected, "key context matches current actual world view");
        assert.ok(!geometry.items.includes("shove"), "no speculative shove in opening fixture");
        if (output) {
          await page.screenshot({ path: join(output, `actual-${lang}-${width}x${height}.png`) });
          await legend.screenshot({ path: join(output, `legend-${lang}-${width}x${height}.png`) });
        }
        results.push({ lang, state: "actual", width, height, status: "passed", geometry });
      }
      await page.setViewportSize({ width: 1100, height: 700 });
      const actualText = await legend.innerText();
      await button("战场设置", "Battlefield").click();
      assert.equal(await page.locator(".mecha-settings-body > .mecha-battle-legend").innerText(), actualText, "settings uses the same key");
      assert.equal(await page.locator(".mecha-map-legend").count(), 0, "obsolete duplicate key removed");
      await button("关闭设置", "Close settings").click();
      const baseFixture = { declaredTelegraph: [{ x: 2, y: 3 }], projectedTelegraph: [{ x: 2, y: 3 }], reach: [], move: null };
      for (const [state, view, ids, status] of [
        ["unknown", { ...baseFixture, projectedTelegraph: null }, [], "unknown"],
        ["none", { ...baseFixture, projectedTelegraph: [] }, [], "none"],
        ["movement", { ...baseFixture, reach: [{ x: 1, y: 3 }], move: { x: 1, y: 3 } }, ["movement", "landing"], "present"],
        ["reachable-danger", { ...baseFixture, reach: [{ x: 2, y: 3 }] }, ["movement"], "present"],
        ["verified-shove-display", { ...baseFixture, reach: [{ x: 1, y: 3 }], move: { x: 1, y: 3 }, targetPreview: { shove: { from: { x: 2, y: 3 }, to: { x: 2, y: 4 } } } }, ["movement", "landing", "shove"], "present"],
      ]) {
        await page.evaluate(view => { globalThis.__legendFixture = view; }, view);
        // Settings changes only UI state and re-renders both contextual keys.
        await button("战场设置", "Battlefield").click(); await button("关闭设置", "Close settings").click();
        await page.setViewportSize({ width: 640, height: 480 }); await page.waitForTimeout(250);
        const geometry = await measure(`display fixture ${lang} ${state}`);
        assert.deepEqual(geometry.items, ["declared", "projected", ...ids]);
        assert.equal(await legend.getAttribute("data-predicted-threat"), status);
        assert.equal(await legend.locator(".mecha-battle-legend__note").count(), status === "present" ? 1 : 0);
        if (status === "unknown") assert.match(await legend.innerText(), /未知 · 预测不可用|Unknown · prediction unavailable/);
        if (status === "none") assert.match(await legend.innerText(), /预测无攻击格|No attack cells predicted/);
        if (state === "reachable-danger") {
          assert.match(await legend.innerText(), /双菱形.*危险|twin diamonds.*threatened/);
          assert.equal(await legend.locator('[data-legend-item="movement"] svg path[fill="#a4ffd0"]').count(), 1);
        }
        if (output) await legend.screenshot({ path: join(output, `display-fixture-${state}-${lang}-640x480.png`) });
        results.push({ lang, state, width: 640, height: 480, status: "passed", displayFixtureOnly: true, geometry });
      }
      assert.deepEqual(errors, []); console.log(`PASS ${lang}: actual key at 3 viewports + shared settings + 5 contextual display fixtures`);
    } catch (error) {
      if (output) await page.screenshot({ path: join(output, `failure-${lang}.png`) }).catch(() => {});
      results.push({ lang, status: "failed", error: error.stack, errors }); console.error(error); process.exitCode = 1;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
if (output) await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
console.log("Scope: synthetic headless legend UI only; shove display fixtures do not validate displacement rules. No native, remote or full small-screen HUD acceptance.");
