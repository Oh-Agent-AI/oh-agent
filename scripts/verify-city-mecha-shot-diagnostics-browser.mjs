#!/usr/bin/env node
// Synthetic already-started PvE combat, injected at the controller seam; no
// physical device, native Tauri, remote relay or deployed match is claimed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.env.MECHA_SCREENSHOTS_DIR;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
try {
  for (const lang of ["zh", "en"]) {
    const zh = lang === "zh";
    console.log(`START ${lang}`);
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(60000);
    const errors = []; let seams = 0;
    page.on("pageerror", e => errors.push(e.message));
    await page.addInitScript((language) => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = language; }, zh ? "zh-Hans" : "en");
    await page.route("**/src/game/mecha/controller.ts*", async route => {
      const response = await route.fetch(); const source = await response.text();
      const needle = "const planner = init.planner ?? planForDoctrine;";
      assert.equal(source.split(needle).length, 2);
      const injected = `
        if (init.site) {
          init.site.terrain = Array.from({length:10}, () => Array(10).fill("land"));
          init.site.heights = Array.from({length:10}, () => Array(10).fill(0));
          init.match = createMatch({preset:"covers_sparse_mid", script:"stationary_smash", terrain:init.site.terrain, heights:init.site.heights,
            covers:[{x:0,y:4},{x:0,y:5}], obstacles:[], buildings:[], boss:{x:0,y:1},
            raiders:[{id:"raider-w",pos:{x:3,y:5}}], mechs:[{id:"Assault",pos:{x:8,y:8}},{id:"Gunner",pos:{x:0,y:6}},{id:"Support",pos:{x:4,y:8}}]});
          bossPrepare(init.match);
          init.match.raiders[0].pos = {x:3,y:5}; init.match.raiders[0].intent = null;
          init.planner = state => ({revision:state.revision,items:living(state).map(m => ({mechId:m.id,moveTo:null,action:{kind:"skip"}}))});
        }
        ${needle}`;
      seams++; await route.fulfill({ response, body: source.replace(needle, injected) });
    });
    const button = (cn, en) => page.getByRole("button", { name: zh ? cn : en, exact: true });
    await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 240000 });
    await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
    await page.locator('.mecha-overlay[data-phase="player_plan"]').waitFor({ timeout: 240000 });
    assert.equal(seams, 1);
    await page.locator(".mecha-pack .mecha-plan-card__select").nth(1).click();
    const details = page.locator(".mecha-unavailable-actions");
    for (const [width, height] of [[1100,700],[390,844],[640,480]]) {
      await page.setViewportSize({ width, height });
      const summary = details.locator("summary");
      await summary.scrollIntoViewIfNeeded(); await summary.focus(); await page.keyboard.press("Enter");
      assert.equal(await details.evaluate(el => el.open), true);
      const rows = details.locator(".mecha-shot-diagnostics li");
      assert.equal(await rows.count(), 4);
      const text = await details.innerText();
      assert.match(text, zh ? /掩体、建筑或废墟阻挡射线/ : /Cover, building, or rubble blocks line of fire/);
      assert.match(text, zh ? /不在同一行或列/ : /Not in the same row or column/);
      const actionRow = label => details.locator(":scope > ul > li").filter({
        has: page.locator("strong").filter({ hasText: new RegExp(`^${label}$`) }),
      });
      const shoot = actionRow(zh ? "射击" : "Shoot");
      const pierce = actionRow(zh ? "穿射" : "Pierce");
      assert.match(await shoot.innerText(), /\(0,5\)/, "ordinary shot is blocked at the first cover from the shooter");
      assert.match(await pierce.innerText(), /\(0,4\)/, "pierce is blocked at the second cover from the shooter");
      assert.doesNotMatch(text, /Translation unavailable/);
      for (const row of await rows.all()) {
        await row.scrollIntoViewIfNeeded(); await page.waitForTimeout(350);
        assert.equal(await row.evaluate(el => {
          const r=el.getBoundingClientRect(), p=el.closest(".mecha-selected-actions").getBoundingClientRect();
          return r.top >= p.top - 1 && r.bottom <= p.bottom + 1 && r.top >= 0 && r.bottom <= innerHeight + 1;
        }), true, `${lang} ${width}x${height}: target reason clipped after delayed scroll`);
      }
      if (output) await page.screenshot({path:join(output,`shot-reasons-${lang}-${width}x${height}.png`)});
      await summary.scrollIntoViewIfNeeded(); await summary.focus(); await page.keyboard.press("Space");
      assert.equal(await details.evaluate(el => el.open), false);
      console.log(`PASS ${lang} ${width}x${height} distinct rule reasons and scroll`);
    }
    await page.setViewportSize({width:1100,height:700});
    await page.locator(".mecha-move-list summary").click();
    await page.locator(".mecha-move-list select").selectOption("1,6");
    await button("应用移动","Apply move").click();
    assert.equal(await page.locator(".mecha-action-card").filter({hasText:zh ? /^射击/ : /^Shoot/}).isEnabled(), true, "move clears stale shot reason");
    await button("撤回移动","Undo move").click();
    assert.equal(await page.locator(".mecha-action-card").filter({hasText:zh ? /^射击/ : /^Shoot/}).isDisabled(), true, "undo restores real blocked condition");
    assert.deepEqual(errors, []);
    console.log(`PASS ${lang} move/undo updates real action availability`);
    await page.close();
  }
} finally { await browser.close(); }
