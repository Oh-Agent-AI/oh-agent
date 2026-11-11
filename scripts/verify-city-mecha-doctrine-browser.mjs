#!/usr/bin/env node
// Isolated synthetic match; real UI, controller, rules and browser input.
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
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(45000);
    const errors = []; let seams = 0;
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.addInitScript(locale => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, lang === "zh" ? "zh-Hans" : "en");
      await page.route("**/src/game/mecha/controller.ts*", async route => {
        const response = await route.fetch(); let source = await response.text();
        const needle = "const planner = init.planner ?? planForDoctrine;";
        assert.equal(source.split(needle).length, 2);
        source = source.replace(needle, `
          if (init.site) {
            init.site.terrain = Array.from({length:10}, () => Array(10).fill("land"));
            init.site.heights = Array.from({length:10}, () => Array(10).fill(0));
            init.match = createMatch({preset:"covers_sparse_mid",script:"stationary_smash",terrain:init.site.terrain,heights:init.site.heights,covers:[],obstacles:[],buildings:[],raiders:[],boss:{x:4,y:3},mechs:[{id:"Assault",pos:{x:3,y:4}},{id:"Gunner",pos:{x:4,y:7}},{id:"Support",pos:{x:8,y:9}}]});
            bossPrepare(init.match);
            init.planner = state => ({revision:state.revision,items:living(state).map(m => ({mechId:m.id,moveTo:null,action:{kind:"skip"}}))});
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
      await page.locator('.mecha-action-cards [data-mecha-action="melee"]').click();
      await page.locator(".mecha-target-preview .mecha-actions button").filter({ hasText: lang === "zh" ? "大怪" : "Boss" }).first().click();
      await button("确认选择", "Confirm target").click();
      const pack = page.locator(".mecha-pack");
      const manual = await pack.innerText();
      await button("战场设置", "Battlefield").click();
      const field = page.locator("#mecha-battlefield-settings");
      const select = field.locator("select").nth(2);
      await select.scrollIntoViewIfNeeded(); await select.selectOption("peel");
      assert.equal(await pack.innerText(), manual, "switching doctrine keeps the manual plan");
      const generate = button("生成行动建议", "Generate suggestions");
      await generate.scrollIntoViewIfNeeded(); await generate.click();
      const confirm = button("确认替换草稿", "Replace draft");
      const cancel = button("保留当前草稿", "Keep current draft");
      await confirm.scrollIntoViewIfNeeded();
      const fit = await confirm.evaluate(el => { const r = el.getBoundingClientRect(), parent = el.closest(".mecha-settings-body").getBoundingClientRect(); const hit = document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return r.top >= parent.top-1 && r.bottom <= parent.bottom+1 && (hit === el || el.contains(hit)); });
      assert.ok(fit, "confirmation is visible and clickable within scrollable settings");
      if (dir) await page.screenshot({ path: join(dir, `${width}x${height}-${lang}-confirm.png`) });
      await cancel.scrollIntoViewIfNeeded(); await cancel.click();
      assert.equal(await pack.innerText(), manual, "cancel preserves the draft");
      await generate.scrollIntoViewIfNeeded(); await generate.click();
      await confirm.scrollIntoViewIfNeeded(); await confirm.click();
      assert.notEqual(await pack.innerText(), manual, "confirmation replaces the manual draft");
      const undo = button("撤回建议", "Undo suggestions");
      await undo.scrollIntoViewIfNeeded(); assert.equal(await undo.isEnabled(), true); await undo.click();
      assert.equal(await pack.innerText(), manual, "undo restores the manual draft");
      assert.equal(await undo.isEnabled(), false);
      await generate.scrollIntoViewIfNeeded(); await generate.click();
      await cancel.scrollIntoViewIfNeeded(); await cancel.focus();
      assert.equal(await cancel.evaluate(el => document.activeElement === el), true, "keyboard can reach cancellation");
      await page.keyboard.press("Enter");
      assert.equal(await pack.innerText(), manual);
      await generate.scrollIntoViewIfNeeded(); await generate.click();
      await field.getByRole("button", { name: lang === "zh" ? "关闭设置" : "Close settings", exact: true }).click();
      await button("战场设置", "Battlefield").click();
      assert.equal(await confirm.count(), 0, "closing settings cancels an unconfirmed replacement");
      assert.equal(await pack.innerText(), manual);
      assert.deepEqual(errors, []);
      console.log(`doctrine ${width}x${height} ${lang}: ok`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
