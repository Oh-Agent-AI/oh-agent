#!/usr/bin/env node
// Independent synthetic Chromium: deploy via UI, play a real turn, verify the
// displayed recap against the controller's accepted log and reconciled timeline.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completeLocalDeployment } from "./mecha-deployment-browser-helpers.mjs";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const out = process.env.MECHA_SCREENSHOTS_DIR ?? "artifacts/mecha-clarity-p0/turn-recap";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
const results = [];
try {
  for (const [lang, width, height] of [["zh", 1768, 748], ["en", 1100, 700], ["zh", 390, 844], ["en", 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(60000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.addInitScript(lang => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en"; }, lang);
    await page.route("**/src/game/mecha/controller.ts*", async route => {
      const response = await route.fetch(), source = await response.text(), needle = "rebuild();\n  return controller;";
      assert.equal(source.split(needle).length, 2, "controller probe seam");
      await route.fulfill({ response, body: source.replace(needle, "globalThis.__recapController = controller; rebuild();\n  return controller;") });
    });
    const button = (zh, en) => page.getByRole("button", { name: lang === "zh" ? zh : en, exact: true });
    try {
      await page.goto(`${base}/?fixtureSessions=30`, { waitUntil: "domcontentloaded", timeout: 240000 });
      await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 90000 });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await completeLocalDeployment(page);
      await button("结束回合", "End turn").click();
      const submitAnyway = button("继续提交", "Submit anyway"); if (await submitAnyway.isVisible()) await submitAnyway.click();
      await page.waitForFunction(() => globalThis.__recapController?.getState().lastLog.length > 0);
      const skip = button("跳过演出", "Skip animation"); if (await skip.isVisible()) await skip.click();
      const region = page.getByRole("region", { name: lang === "zh" ? "上一回合摘要" : "Previous turn summary" });
      await region.waitFor({ state: "visible" });
      const actual = await page.evaluate(() => {
        const { lastLog, combat } = globalThis.__recapController.getState();
        if (!combat.healthTimeline?.ok) throw Error("real turn timeline did not reconcile");
        const steps = combat.healthTimeline.steps;
        const enemies = new Set(steps.filter(({effect:e}) => ["boss", "raider"].includes(e.kind) && e.before > 0 && e.after <= 0).map(({effect:e}) => `${e.kind}:${e.id}`));
        const loss = kind => steps.filter(({effect:e}) => e.kind === kind).reduce((n, {effect:e}) => n + Math.max(0, e.before - e.after), 0);
        return [enemies.size, lastLog.filter(e => e.type === "act" && e.fizzled).length, loss("mech"), loss("building")].map(String);
      });
      assert.deepEqual(await region.locator("[data-turn-recap] dd").allTextContents(), actual);
      assert.equal(await region.locator(".mecha-recap-stats dt").count(), 4);
      assert.equal(await region.locator("details").getAttribute("open"), null);
      assert.equal(await region.locator("[data-turn-recap]").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, "stats fit their container");
      const layout = await region.locator("[data-turn-recap]").evaluate(el => {
        const box = el.getBoundingClientRect(), outer = el.closest(".mecha-last-result").getBoundingClientRect();
        return { template: getComputedStyle(el).gridTemplateColumns, fitsHeight: box.bottom <= outer.bottom + 1, rows: [...el.querySelectorAll("dt")].map(label => ({ height: label.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(label).lineHeight) })) };
      });
      assert.ok(layout.fitsHeight, `default actual stats clipped: ${JSON.stringify(layout)}`);
      assert.ok(layout.rows.every(row => row.height <= row.lineHeight * 1.25), `stat label wraps: ${JSON.stringify(layout)}`);
      const intersections = await region.evaluate(el => {
        const r = el.getBoundingClientRect();
        return [...document.querySelectorAll(".mecha-turn-summary, .mecha-selected-actions")].filter(other => {
          const q = other.getBoundingClientRect();
          return q.width && q.height && Math.min(r.right, q.right) - Math.max(r.left, q.left) > 1 && Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top) > 1;
        }).map(other => other.className);
      });
      assert.deepEqual(intersections, [], "recap does not cover objective or action controls");
      await region.screenshot({ path: join(out, `recap-${lang}-${width}.png`) });
      await page.screenshot({ path: join(out, `battle-${lang}-${width}.png`) });
      await region.locator("summary").click();
      assert.ok(await region.locator("details ol li").count() > 0, "actual events remain available");
      await region.focus(); await page.keyboard.press("End");
      await page.waitForFunction(() => document.querySelector(".mecha-last-result")?.scrollTop > 0);
      await page.keyboard.press("Home");
      assert.deepEqual(errors, []);
      results.push({ lang, width, height, actual });
      console.log(`PASS ${lang} ${width}x${height}: real accepted turn, actual stats, details, layout`);
    } catch (e) {
      await page.screenshot({ path: join(out, `failure-${lang}-${width}.png`) }).catch(() => {});
      throw e;
    } finally { await page.close(); }
  }
} finally { await browser.close(); await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2) + "\n"); }
