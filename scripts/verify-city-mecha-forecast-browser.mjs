#!/usr/bin/env node
// Synthetic fixtures, real UI/controller/rules/renderer. Probes exist only in
// intercepted development modules, never in shipped application code.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.env.MECHA_SCREENSHOTS_DIR;
if (output) await mkdir(output, { recursive: true });
const [width, height] = (process.env.MECHA_FORECAST_SIZE ?? "1100x700").split("x").map(Number);
const scenarios = process.env.MECHA_FORECAST_SCENARIOS?.split(",") ?? ["moved", "victory", "candidate-unavailable", "baseline-unavailable"];
const replaceOnce = (source, needle, replacement) => { assert.equal(source.split(needle).length, 2, `missing seam: ${needle}`); return source.replace(needle, replacement); };
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
const results = [];
try {
  for (const scenario of scenarios) for (const lang of ["zh", "en"]) {
    console.log(`START ${width}x${height} ${scenario} ${lang}`);
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = []; let seams = 0;
    page.setDefaultTimeout(45000); page.on("pageerror", error => errors.push(error.message));
    try {
      await page.addInitScript(({ scenario, lang }) => { window.__FORECAST_FIXTURE__ = scenario; localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en"; }, { scenario, lang });
      await page.route("**/src/game/mecha/controller.ts*", async route => {
        const response = await route.fetch(); let source = await response.text();
        source = replaceOnce(source, "const planner = init.planner ?? planForDoctrine;", `
          if (init.site) {
            const fixture = globalThis.__FORECAST_FIXTURE__;
            init.site.terrain = Array.from({length:10}, () => Array(10).fill("land"));
            init.site.heights = Array.from({length:10}, () => Array(10).fill(0));
            init.match = createMatch({preset:"covers_sparse_mid",script:"stationary_smash",terrain:init.site.terrain,heights:init.site.heights,covers:[],obstacles:[],buildings:[],raiders:[],boss:{x:4,y:3},mechs:[{id:"Assault",pos:{x:3,y:4}},{id:"Gunner",pos:{x:0,y:9}},{id:"Support",pos:{x:8,y:9}}]});
            if (fixture === "victory") init.match.boss.hp = 1;
            bossPrepare(init.match);
            init.planner = state => ({revision:state.revision,items:living(state).map(m => ({mechId:m.id,moveTo:null,action:{kind:"skip"}}))});
            init.preview = (state,plan) => {
              const isCandidate = plan.items.some(item => item.mechId === "Assault" && item.action.kind === "melee");
              if (fixture === "candidate-unavailable" && isCandidate || fixture === "baseline-unavailable" && !isCandidate) throw new Error("synthetic preview failure");
              return previewPlan(state,plan);
            };
          }
          const planner = init.planner ?? planForDoctrine;`);
        source = replaceOnce(source, "return controller;", "globalThis.__forecastController = controller; return controller;");
        seams++; await route.fulfill({ response, body: source });
      });
      await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
        const response = await route.fetch(); let source = await response.text();
        source = replaceOnce(source, "const raycaster = new THREE.Raycaster();", "globalThis.__forecastView = () => viewRef.current; const raycaster = new THREE.Raycaster();");
        seams++; await route.fulfill({ response, body: source });
      });
      const button = (zh, en) => page.getByRole("button", { name: lang === "zh" ? zh : en, exact: true });
      await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 90000 });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await page.locator('.mecha-overlay[data-phase="player_plan"]').waitFor({ timeout: 90000 });
      await page.waitForFunction(() => !!globalThis.__forecastView && !!globalThis.__forecastController, null, { timeout: 90000 });
      assert.equal(seams, 2);
      await page.locator('.mecha-action-cards [data-mecha-action="melee"]').click();
      const before = await page.evaluate(() => ({ state: structuredClone(globalThis.__forecastController.getState()), view: structuredClone(globalThis.__forecastView()) }));
      assert.equal(before.view.predictionSource, "draft");
      const target = page.locator(".mecha-target-preview .mecha-actions button").filter({ hasText: lang === "zh" ? "大怪" : "Boss" }).first();
      await target.click();
      const panel = page.locator('.mecha-candidate-panel[data-candidate-source="selection"]'); await panel.waitFor({ state: "visible" });
      await page.waitForFunction(() => globalThis.__forecastView()?.predictionSource === "candidate");
      const selected = await page.evaluate(() => ({ state: structuredClone(globalThis.__forecastController.getState()), view: structuredClone(globalThis.__forecastView()) }));
      assert.deepEqual(selected.view.declaredTelegraph, before.view.declaredTelegraph, "current enemy declaration must remain unchanged");
      assert.deepEqual(selected.view.enemyOrder, [], "baseline order markers must not be mixed with a candidate");
      assert.equal(selected.view.predictionSource, "candidate");
      const p = selected.state.candidate.preview;
      assert.deepEqual(selected.view.projectedTelegraph, p.ok ? p.telegraphAfter : null, "board must display the candidate prediction or unknown");
      assert.match(await panel.innerText(), scenario === "candidate-unavailable" ? /棋盘预测未知|board forecast unknown/ : /目标试算 · 尚未确认|target preview · not confirmed/);
      const legend = page.locator('#mecha-battlefield-settings [data-legend-item="projected"]');
      assert.match(await legend.textContent(), /目标试算|Target preview/);
      if (scenario === "candidate-unavailable") {
        assert.equal(p.ok, false); assert.equal(selected.view.projectedTelegraph, null);
        assert.match(await legend.textContent(), /未知|Unknown/);
      } else {
        assert.equal(p.ok, true);
        const summary = panel.locator("[data-forecast-summary]");
        assert.match(await summary.innerText(), /整回合对比草稿|Whole-turn vs. draft/);
        const summaryVisible = await summary.evaluate(el => {
          const a = el.getBoundingClientRect(), b = el.closest(".mecha-candidate-panel").getBoundingClientRect();
          return a.top >= b.top && a.bottom <= b.bottom && a.top >= 0 && a.bottom <= innerHeight;
        });
        assert.ok(summaryVisible, "whole-turn change summary must be visible without scrolling");
        const comparison = panel.locator("[data-forecast-comparison]");
        assert.equal(await comparison.getAttribute("data-forecast-comparison"), scenario === "baseline-unavailable" ? "unknown" : "ready");
        if (scenario === "baseline-unavailable") assert.match(await comparison.innerText(), /变化未知|changes are unknown/);
        if (scenario === "moved") {
          assert.notDeepEqual(p.telegraphAfter, before.state.preview.telegraphAfter, "fixture must actually change the forecast");
          assert.equal(await comparison.locator('[data-forecast-actor="boss"]').getAttribute("data-forecast-change"), "changed");
        }
        if (scenario === "victory") {
          assert.equal(p.outcome, "victory"); assert.deepEqual(selected.view.projectedTelegraph, []);
          assert.equal(await comparison.locator('[data-forecast-actor="boss"]').getAttribute("data-forecast-change"), "stopped");
          assert.match(await comparison.innerText(), /连锁影响|other actions and early victory/);
        }
      }
      if (output && (scenario === "moved" || scenario === "candidate-unavailable")) await page.screenshot({ path: join(output, `${width}x${height}-${scenario}-${lang}.png`) });
      if (p.ok) {
        const lastLine = panel.locator("[data-forecast-comparison] > p").last();
        await lastLine.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const reachable = await lastLine.evaluate(el => {
          const a = el.getBoundingClientRect(), b = el.closest(".mecha-candidate-panel").getBoundingClientRect();
          return a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && a.top >= 0 && a.bottom <= innerHeight;
        });
        assert.ok(reachable, "the detailed forecast change must be reachable by scrolling");
      }
      await panel.getByRole("button", { name: lang === "zh" ? "取消选目标" : "Cancel targeting", exact: true }).click();
      await page.waitForFunction(() => globalThis.__forecastView()?.predictionSource === "draft");
      const restored = await page.evaluate(() => structuredClone(globalThis.__forecastView()));
      assert.deepEqual(restored.projectedTelegraph, before.view.projectedTelegraph, "cancel restores baseline forecast");
      assert.deepEqual(restored.declaredTelegraph, before.view.declaredTelegraph);
      if (scenario === "moved") {
        await page.locator('.mecha-action-cards [data-mecha-action="melee"]').click();
        await target.click();
        await panel.waitFor({ state: "visible" });
        const chosen = await page.evaluate(() => structuredClone(globalThis.__forecastController.getState().candidate.preview));
        await panel.getByRole("button", { name: lang === "zh" ? "确认选择" : "Confirm target", exact: true }).click();
        await page.waitForFunction(() => globalThis.__forecastController.getState().candidate === null && globalThis.__forecastView()?.predictionSource === "draft");
        const committed = await page.evaluate(() => ({ state: structuredClone(globalThis.__forecastController.getState()), view: structuredClone(globalThis.__forecastView()) }));
        assert.ok(chosen.ok && committed.state.preview.ok);
        assert.ok(committed.state.preview.draftVersion > before.state.preview.draftVersion);
        assert.deepEqual(committed.state.preview.telegraphAfter, chosen.telegraphAfter, "confirm converts the candidate into the new draft");
        assert.deepEqual(committed.view.projectedTelegraph, committed.state.preview.telegraphAfter);
        assert.deepEqual(committed.view.declaredTelegraph, before.view.declaredTelegraph);
      }
      assert.deepEqual(errors, []);
      results.push({ scenario, lang, status: "passed" }); console.log(`PASS ${scenario} ${lang}`);
    } catch (error) {
      if (output) await page.screenshot({ path: join(output, `failure-${width}x${height}-${scenario}-${lang}.png`) }).catch(() => {});
      results.push({ scenario, lang, status: "failed", error: error.stack, errors }); console.error(`FAIL ${scenario} ${lang}`, error); process.exitCode = 1;
    } finally { await page.close(); }
  }
} finally { await browser.close(); if (output) await writeFile(join(output, `results-${width}x${height}.json`), JSON.stringify(results, null, 2)); }
