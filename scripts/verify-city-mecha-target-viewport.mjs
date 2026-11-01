#!/usr/bin/env node
// Synthetic fixture only. Start apps/agent-city/ui's Vite server first:
//   npm run dev -- --port 5178 --strictPort
//   node scripts/verify-city-mecha-target-viewport.mjs http://127.0.0.1:5178
// Optional MECHA_SCREENSHOTS_DIR saves the tested viewports. Requires Playwright
// under apps/desktop/ui-dev; this is not native or physical-device acceptance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
const sizes = [[1100, 700], [800, 600], [640, 480], [390, 844], [1440, 900]];
try {
  for (const lang of ["zh", "en"]) {
    const chinese = lang === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1, locale: chinese ? "zh-CN" : "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((locale) => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, chinese ? "zh-Hans" : "en");
    await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    console.log(`${lang}: synthetic city ready`);
    await page.getByRole("button", { name: chinese ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: chinese ? "机甲战棋" : "Mecha tactics" }).click();
    console.log(`${lang}: entered battle`);
    await page.locator(".mecha-submit-primary").click();
    await page.getByRole("button", { name: chinese ? "继续提交" : "Submit anyway" }).click();
    console.log(`${lang}: submitted hold`);
    const skip = page.getByRole("button", { name: chinese ? "跳过演出" : "Skip animation" });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.waitForFunction(() => document.querySelector(".mecha-resource")?.textContent?.includes("68/80"), null, { timeout: 240_000 });
    console.log(`${lang}: settlement complete`);
    await page.locator(".mecha-move-list summary").click();
    await page.locator(".mecha-pack li > button").first().click();
    await page.locator(".mecha-move-list select").selectOption("3,2");
    await page.getByRole("button", { name: chinese ? "应用移动" : "Apply move" }).click();

    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      const before = await page.locator(".mecha-pack").innerText();
      await page.locator(".mecha-selected-actions > .mecha-actions > button").filter({ hasText: chinese ? /^近战$/ : /^Melee$/ }).click();
      await page.locator(".mecha-target-preview .mecha-actions button").filter({ hasText: chinese ? "大怪" : "Boss" }).click();
      const result = page.locator(".mecha-candidate-result");
      await result.waitFor();
      await page.waitForTimeout(100); // Let the selection effect and layout complete; no scrolling the result.
      assert.equal(await page.locator(".mecha-pack").innerText(), before, "candidate must not change draft");
      assert.match(await result.innerText(), chinese ? /直接伤害 2/ : /Direct damage 2/);
      const assertVisibleActions = async (label) => {
        const geometry = await page.evaluate(() => {
          const panel = document.querySelector(".mecha-selected-actions");
          const result = document.querySelector(".mecha-candidate-result");
          const buttons = Array.from(result.querySelectorAll(".mecha-candidate-actions button"));
          const bounds = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
          return { panel: bounds(panel), result: bounds(result), buttons: buttons.map((button) => {
            const box = bounds(button);
            const atCenter = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
            return { ...box, hit: atCenter === button || button.contains(atCenter) };
          }) };
        });
        assert.equal(geometry.buttons.length, 2);
        for (const button of geometry.buttons) {
          assert.ok(button.left >= geometry.panel.left && button.right <= geometry.panel.right && button.top >= geometry.panel.top && button.bottom <= geometry.panel.bottom && button.hit,
            `selection actions clipped or covered (${lang} ${label}): ${JSON.stringify(geometry)}`);
        }
      };
      await assertVisibleActions(`${width}x${height} selected`);
      if (width === 1100) {
        // A selected result must survive a portrait resize without another click.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(100);
        await assertVisibleActions("1100x700 -> 390x844 after selection");
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(100);
        await assertVisibleActions("390x844 -> 1100x700 after selection");
      }
      if (screenshots) await page.screenshot({ path: join(screenshots, `selected-result-${width}x${height}-${lang}.png`) });
      await result.getByRole("button", { name: chinese ? "取消选目标" : "Cancel targeting" }).click();
      assert.equal(await page.locator(".mecha-candidate-result").count(), 0);
      assert.equal(await page.locator(".mecha-pack").innerText(), before, "cancel must not change draft");
      const heading = await page.evaluate(() => {
        const panel = document.querySelector(".mecha-selected-actions");
        const p = panel.getBoundingClientRect(), h = panel.querySelector("h3").getBoundingClientRect();
        return { scrollTop: panel.scrollTop, panelTop: p.top, panelBottom: p.bottom, headingTop: h.top, headingBottom: h.bottom };
      });
      assert.ok(heading.headingTop >= heading.panelTop && heading.headingBottom <= heading.panelBottom,
        `current mech heading clipped after cancel (${lang} ${width}x${height}): ${JSON.stringify(heading)}`);
      console.log(`visible and hit-testable without extra result scrolling: ${lang} ${width}x${height}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log("Synthetic Chromium selection/cancel only; not native, physical-device, performance or user acceptance.");
