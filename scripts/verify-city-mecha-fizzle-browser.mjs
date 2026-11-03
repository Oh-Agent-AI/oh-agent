#!/usr/bin/env node
// Synthetic starting state, real controller/rules and normal HUD interaction.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const dir = process.env.MECHA_SCREENSHOTS_DIR;
if (dir) await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
try {
  for (const [width, height] of [[1100, 700], [390, 844]]) for (const lang of ["zh", "en"]) {
    if (process.env.MECHA_CASE && process.env.MECHA_CASE !== `${width}x${height}-${lang}`) continue;
    console.log(`fizzle ${width}x${height} ${lang}`);
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(45000);
    const errors = []; let seams = 0;
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.addInitScript((locale) => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, lang === "zh" ? "zh-Hans" : "en");
      await page.route("**/src/game/mecha/controller.ts*", async route => {
        const response = await route.fetch(); let source = await response.text();
        const needle = "const planner = init.planner ?? planForDoctrine;";
        assert.equal(source.split(needle).length, 2);
        source = source.replace(needle, `
          if (init.site) {
            init.site.terrain = Array.from({length:10}, () => Array(10).fill("land"));
            init.site.heights = Array.from({length:10}, () => Array(10).fill(0));
            init.match = createMatch({preset:"covers_sparse_mid",script:"stationary_smash",terrain:init.site.terrain,heights:init.site.heights,covers:[],obstacles:[],buildings:[],raiders:[],boss:{x:4,y:3},mechs:[{id:"Assault",pos:{x:3,y:4}},{id:"Gunner",pos:{x:4,y:7}},{id:"Support",pos:{x:8,y:9}}]});
            init.match.boss.hp = 1; bossPrepare(init.match);
            init.planner = state => ({revision:state.revision,items:living(state).map(m => ({mechId:m.id,moveTo:null,action:m.id === "Gunner" ? {kind:"pierce",target:"boss"} : {kind:"skip"}}))});
          }
          const planner = init.planner ?? planForDoctrine;`);
        seams++; await route.fulfill({ response, body: source });
      });
      const button = (zh, en) => page.getByRole("button", { name: lang === "zh" ? zh : en, exact: true });
      await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 90000 });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await page.locator('.mecha-overlay[data-phase="player_plan"]').waitFor({ timeout: 90000 });
      assert.equal(seams, 1);
      assert.equal(await page.locator("[data-draft-fizzle]").count(), 0, "draft without fizzle has no warning");
      await page.locator('.mecha-action-cards [data-mecha-action="melee"]').click();
      await page.locator(".mecha-target-preview .mecha-actions button").filter({ hasText: lang === "zh" ? "大怪" : "Boss" }).first().click();
      const candidate = page.locator(".mecha-candidate-result");
      await candidate.waitFor({state:"visible"});
      const warning = candidate.locator("[data-candidate-fizzles]");
      await warning.waitFor({state:"visible"});
      assert.match(await warning.innerText(), lang === "zh" ? /其他机甲预计落空[\s\S]*射手[\s\S]*目标已经倒下[\s\S]*不消耗冷却/ : /other actions forecast to fizzle[\s\S]*Gunner[\s\S]*target is already down[\s\S]*no cooldown consumed/);
      assert.equal(await page.locator("[data-draft-fizzle]").count(), 0, "candidate does not overwrite current draft");
      const candidateVisible = await warning.evaluate(el => {
        const r = el.getBoundingClientRect(), p = el.closest(".mecha-candidate-result").getBoundingClientRect();
        return r.top >= p.top - 1 && r.bottom <= p.bottom + 1 && r.top >= 0 && r.bottom <= innerHeight;
      });
      assert.ok(candidateVisible, "candidate warning fits the visible result panel");
      if (dir) await page.screenshot({ path: join(dir, `${width}x${height}-${lang}-candidate.png`) });
      await button("确认选择", "Confirm target").click();
      const draftWarning = page.locator("[data-draft-fizzle]");
      await draftWarning.waitFor({ state: "visible" });
      assert.match(await draftWarning.innerText(), lang === "zh" ? /草稿预计落空：射手/ : /Draft: action fizzles — Gunner/);
      assert.equal(await draftWarning.evaluate(el => getComputedStyle(el).color), "rgb(255, 184, 169)", "draft warning uses risk color");
      assert.match(await page.locator(".mecha-submit-primary").getAttribute("aria-describedby"), /mecha-draft-fizzle/);
      const draftVisible = await draftWarning.evaluate(el => {
        const r = el.getBoundingClientRect(), p = el.closest(".mecha-team-planning").getBoundingClientRect();
        return r.top >= p.top - 1 && r.bottom <= p.bottom + 1 && r.top >= 0 && r.bottom <= innerHeight;
      });
      assert.ok(draftVisible, "draft warning fits the planning area");
      const card = page.locator(".mecha-pack .mecha-plan-card").nth(1);
      assert.match(await card.locator("summary").innerText(), lang === "zh" ? /预计落空/ : /Forecast: fizzles/);
      await card.locator("summary").click();
      assert.match(await card.innerText(), lang === "zh" ? /目标已经倒下/ : /target is already down/);
      if (dir) await page.screenshot({ path: join(dir, `${width}x${height}-${lang}-draft.png`) });
      if ((width === 1100 && lang === "zh") || (width === 390 && lang === "en")) {
        await button("结束回合", "End turn").click();
        const skip = button("跳过演出", "Skip animation");
        await skip.waitFor({ state: "visible", timeout: 10000 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const layout = await skip.evaluate(el => {
          const rect = node => { const r = node.getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; };
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { bar:rect(el.closest(".mecha-battle-bar")), summary:rect(document.querySelector(".mecha-turn-summary")), hitButton:hit === el || el.contains(hit) };
        });
        assert.ok(layout.summary.top >= layout.bar.bottom, `objective rail stays below the wrapped bar: ${JSON.stringify(layout)}`);
        assert.ok(layout.hitButton, `skip animation remains clickable: ${JSON.stringify(layout)}`);
        if (dir) await page.screenshot({ path: join(dir, `${width}x${height}-${lang}-performance.png`) });
        await skip.click();
        const recap = page.locator(".mecha-last-result");
        await recap.waitFor({ state: "visible", timeout: 30000 });
        assert.match(await recap.locator(".mecha-last-result-highlights").innerText(), lang === "zh" ? /射手.*落空.*目标已经倒下/ : /Gunner.*fizzled.*target is already down/, "actual fizzle remains visible even on victory");
        const recapFit = await recap.locator("[data-result-highlight]").evaluate(el => {
          const r = el.getBoundingClientRect(), parent = el.closest(".mecha-last-result"), p = parent.getBoundingClientRect();
          return { fits:r.top >= p.top - 1 && r.bottom <= p.bottom + 1, top:r.top, bottom:r.bottom, parentTop:p.top, parentBottom:p.bottom, scrollHeight:parent.scrollHeight, clientHeight:parent.clientHeight };
        });
        assert.ok(recapFit.fits, `actual fizzle is not clipped in the recap: ${JSON.stringify(recapFit)}`);
        assert.equal(await page.locator("[data-draft-fizzle]").count(), 0, "finished turn is not labeled as a draft forecast");
        if (width === 390 && lang === "en") {
          const statusLines = await page.locator(".mecha-plan-card__status").first().evaluate(el => {
            const range = document.createRange(); range.selectNodeContents(el);
            return range.getClientRects().length;
          });
          assert.equal(statusLines, 1, "short roster status is not split into fragments on phones");
        }
        if (dir) await page.screenshot({ path: join(dir, `${width}x${height}-${lang}-actual.png`) });
      } else {
        await page.locator('.mecha-action-cards [data-mecha-action="skip"]').click();
        assert.equal(await page.locator("[data-draft-fizzle]").count(), 0, "changing the order clears the warning");
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
console.log("fizzle HUD scenarios passed");
