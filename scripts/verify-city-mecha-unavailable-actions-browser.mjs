#!/usr/bin/env node
// Synthetic City fixture only. Start this worktree's Vite server and pass its URL.
// A test-only module response marks Assault's initial skill as cooling down.
// Headless Chromium/programmatic input do not prove native or physical input.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { completeLocalDeployment } from "./mecha-deployment-browser-helpers.mjs";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const locale of ["en", "zh"]) {
    const zh = locale === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1, locale: zh ? "zh-CN" : "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let injected = 0;
    await page.route("**/src/game/mecha/controller.ts*", async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const needle = "let match = init.match ?? freshMatch(preset, script, site, stake, useDeployment);";
      assert.equal(source.split(needle).length, 2);
      injected++;
      await route.fulfill({ response, body: source.replace(needle, `${needle}\n  globalThis.__unavailableDeployCells = init.site?.mechs.map(m => ({ ...m.pos }));\n  match.mechs.find((m) => m.id === "Assault").cd = 1;`) });
    });
    await page.addInitScript((lang) => {
      localStorage.setItem("city.seed", "4196523069");
      window.__AV_PLUGIN_LOCALE__ = lang;
      const frame = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map(); let sequence = 0;
      window.requestAnimationFrame = (callback) => {
        const id = ++sequence;
        const timer = setTimeout(() => { const handle = frame((time) => { pending.delete(id); callback(time); }); pending.set(id, { handle }); }, 100);
        pending.set(id, { timer }); return id;
      };
      window.cancelAnimationFrame = (id) => {
        const entry = pending.get(id);
        if (entry?.timer !== undefined) clearTimeout(entry.timer);
        if (entry?.handle !== undefined) cancel(entry.handle);
        pending.delete(id);
      };
    }, zh ? "zh-Hans" : "en");
    await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 240_000 });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings", exact: true }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
    await page.locator(".mecha-turn-summary").waitFor();
    // Keep the stock fixture positions while deploying through the real UI.
    const preferred = await page.evaluate(() => globalThis.__unavailableDeployCells);
    assert.equal(preferred?.length, 3);
    const deployed = await completeLocalDeployment(page, preferred);
    assert.deepEqual(deployed, preferred.map(({ x, y }) => `${x},${y}`));
    // Deployment ends with Support selected; this regression exercises Assault.
    await page.locator(".mecha-pack .mecha-plan-card__select").first().click();
    assert.equal(injected, 1);
    const details = page.locator(".mecha-unavailable-actions");
    const toggle = details.locator("summary");
    const melee = page.locator(".mecha-selected-actions .mecha-action-card").filter({ hasText: zh ? /^近战/ : /^Melee/ });
    const charge = page.locator(".mecha-selected-actions .mecha-action-card").filter({ hasText: zh ? /^冲撞/ : /^Charge/ });
    assert.equal(await melee.count(), 1);
    assert.equal(await charge.count(), 1);
    assert.equal(await melee.isDisabled(), true, "out-of-range action must not be clickable");
    assert.equal(await charge.isDisabled(), true, "cooling-down action must not be clickable");
    for (const [width, height] of [[1100, 700], [1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await toggle.scrollIntoViewIfNeeded();
      await toggle.focus();
      await page.keyboard.press("Enter");
      assert.equal(await details.evaluate((node) => node.open), true, "keyboard opens the reasons");
      const text = await details.innerText();
      assert.match(text, zh ? /近战.*没有相邻敌人/s : /Melee.*No enemy is adjacent/s);
      assert.match(text, zh ? /冲撞.*冷却中/s : /Charge.*on cooldown/s);
      const layout = await page.evaluate(() => {
        const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
        const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const a = rect(".mecha-selected-actions"), t = rect(".mecha-turn-summary"), s = rect(".mecha-submit");
        return { summary: overlap(a, t), submit: overlap(a, s) };
      });
      assert.deepEqual(layout, { summary: false, submit: false }, `${locale} ${width}x${height} expanded reasons cover another panel`);
      for (const item of await details.locator("li").all()) {
        await item.scrollIntoViewIfNeeded();
        const visible = await item.evaluate((el) => {
          const r = el.getBoundingClientRect(), panel = el.closest(".mecha-selected-actions").getBoundingClientRect();
          return r.top >= panel.top - 1 && r.bottom <= panel.bottom + 1;
        });
        assert.equal(visible, true, `${locale} ${width}x${height}: reason is clipped after scrolling`);
      }
      if (screenshots) await page.screenshot({ path: join(screenshots, `unavailable-${locale}-${width}x${height}.png`) });
      await toggle.scrollIntoViewIfNeeded();
      await toggle.focus();
      await page.keyboard.press("Space");
      assert.equal(await details.evaluate((node) => node.open), false, "keyboard closes the reasons");
    }
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.locator(".mecha-submit-primary").click();
    await page.getByRole("button", { name: zh ? "继续提交" : "Submit anyway", exact: true }).click();
    const skip = page.getByRole("button", { name: zh ? "跳过演出" : "Skip animation", exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.waitForFunction(() => document.querySelector(".mecha-building-current")?.textContent?.includes("68/80"), null, { timeout: 240_000 });
    await page.locator(".mecha-pack li > button").first().click();
    await page.locator(".mecha-move-list summary").click();
    await page.locator(".mecha-move-list select").selectOption("3,2");
    await page.getByRole("button", { name: zh ? "应用移动" : "Apply move", exact: true }).click();
    assert.equal(await melee.isEnabled(), true, "moving into reach exposes melee");
    assert.equal(await charge.isEnabled(), true, "cooldown expires and moving into reach exposes charge");
    assert.equal(await details.count(), 0, "no stale reason remains for available actions");
    assert.deepEqual(errors, []);
    console.log(`${locale}: three synthetic viewports; keyboard-accessible no-target/cooldown explanations, panel separation, and expiry after turn+move passed`);
    await context.close();
  }
} finally {
  await browser.close();
}
