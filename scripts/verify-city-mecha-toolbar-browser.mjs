#!/usr/bin/env node
// Synthetic City sessions. Start the City Vite server first.
// node scripts/verify-city-mecha-toolbar-browser.mjs http://127.0.0.1:5389
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5389";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const locale of ["zh", "en"]) {
    const zh = locale === "zh";
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((lang) => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang; }, zh ? "zh-Hans" : "en");
    try {
      await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 180_000 });
      await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 180_000 });
      const toolbar = page.locator(".city-local-toolbar");
      const entry = toolbar.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true });
      const drive = toolbar.getByRole("button", { name: zh ? "驾车" : "Drive", exact: true });
      await entry.waitFor({ state: "visible" });
      assert.equal(await entry.isEnabled(), true);
      assert.equal(await entry.evaluate((el) => el.previousElementSibling?.textContent), await drive.textContent(), "mecha entry follows drive");
      for (const [width, height] of [[1100, 700], [640, 480]]) {
        await page.setViewportSize({ width, height });
        const layout = await entry.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          return { rect: r.toJSON(), inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
            clickable: hit === el || el.contains(hit), fits: el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1 };
        });
        assert.ok(layout.inside && layout.clickable && layout.fits, `${locale} ${width}x${height}: ${JSON.stringify(layout)}`);
      }
      await page.setViewportSize({ width: 1100, height: 700 });
      if (screenshots && zh) await page.screenshot({ path: join(screenshots, "mecha-city-toolbar-zh.png") });
      // Both the settings entry and the toolbar entry use the same guard.
      await toolbar.getByRole("button", { name: zh ? "城市设置" : "City settings", exact: true }).click();
      const settings = page.getByRole("dialog", { name: zh ? "城市设置" : "City settings" });
      const settingsEntry = settings.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true });
      assert.equal(await settingsEntry.isEnabled(), true);
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "hidden" });
      // Normal keyboard navigation reaches the direct entry and starts a battle.
      await entry.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
      assert.equal(await entry.evaluate((el) => document.activeElement === el), true);
      await page.keyboard.press("Enter");
      await page.locator(".mecha-turn-summary").waitFor({ state: "visible", timeout: 180_000 });
      assert.equal(await toolbar.isVisible(), false, "city toolbar is hidden during battle");
      await page.locator(`summary[aria-label="${zh ? "战斗菜单" : "Battle menu"}"]`).click();
      await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle", exact: true }).click();
      await entry.waitFor({ state: "visible" });
      assert.equal(await entry.isEnabled(), true);
      // A running city mode owns the camera, so opening mecha must be blocked.
      await toolbar.getByRole("button", { name: zh ? "航拍" : "Aerial tour", exact: true }).click();
      await toolbar.getByRole("button", { name: zh ? "停止航拍" : "Stop tour", exact: true }).waitFor();
      assert.equal(await entry.isDisabled(), true);
      await toolbar.getByRole("button", { name: zh ? "停止航拍" : "Stop tour", exact: true }).click();
      assert.equal(await entry.isEnabled(), true);
      assert.deepEqual(errors, []);
      console.log(`${locale}: toolbar placement, settings, keyboard entry, exit and cinematic guard passed`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
console.log("Synthetic browser fixture only; native Tauri toolbar is not exercised.");
