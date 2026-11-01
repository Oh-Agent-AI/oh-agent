#!/usr/bin/env node
// Synthetic fixture and programmatic keyboard only: not native or physical-input acceptance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) {
    const zh = lang === "zh";
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript((locale) => {
      localStorage.setItem("city.seed", "4196523069");
      window.__AV_PLUGIN_LOCALE__ = locale;
      const nativeFrame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => nativeFrame(time => setTimeout(() => callback(time), 100));
    }, zh ? "zh-Hans" : "en");
    await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 240_000 });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics" }).click();
    const summary = page.locator(".mecha-turn-summary");
    await summary.waitFor();
    for (const [width, height] of [[1100, 700], [1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(300);
      assert.equal(await summary.getAttribute("tabindex"), "0", `${lang} ${width}x${height}: summary must be an explicit keyboard stop`);
      const description = await summary.getAttribute("aria-describedby");
      assert.ok(description, "scrollable summary must explain its contents and scrolling");
      const descriptionText = await page.locator(`[id="${description}"]`).innerText();
      assert.match(descriptionText, zh ? /滚动/ : /scroll/i);
      // A tall viewport can fit the collapsed summary. Expand order to exercise
      // real overflow rather than claiming a scroll test where there is none.
      if (await summary.evaluate(el => el.scrollHeight - el.clientHeight) < 20) {
        const order = page.getByRole("button", { name: zh ? "结算顺序" : "Attack order", exact: true });
        if (await order.getAttribute("aria-expanded") !== "true") await order.click();
      }
      const orderToggle = page.getByRole("button", { name: zh ? "结算顺序" : "Attack order", exact: true });
      if (await orderToggle.getAttribute("aria-expanded") !== "true") await orderToggle.click();
      const nestedOrder = await page.locator(".mecha-order").evaluate(el => ({
        scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflow: getComputedStyle(el).overflowY,
      }));
      assert.ok(nestedOrder.scrollHeight <= nestedOrder.clientHeight + 1, `${lang} ${width}x${height}: order should not hide text behind a nested scroll area: ${JSON.stringify(nestedOrder)}`);
      const hint = summary.locator(".mecha-scroll-hint");
      assert.equal(await hint.isVisible(), true, `${lang} ${width}x${height}: scroll hint must be visible`);
      assert.match(await hint.innerText(), zh ? /滚动/ : /scroll/i);
      await summary.evaluate(el => { el.scrollTop = 0; });
      const hintInside = await hint.evaluate(el => {
        const hint = el.getBoundingClientRect(), summary = el.closest(".mecha-turn-summary").getBoundingClientRect();
        return hint.left >= summary.left && hint.right <= summary.right && hint.top >= summary.top && hint.bottom <= summary.bottom;
      });
      assert.ok(hintInside, `${lang} ${width}x${height}: scroll hint is clipped at the start`);
      if (screenshots) await page.screenshot({ path: join(screenshots, `summary-${lang}-${width}x${height}.png`) });
      await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle", exact: true }).focus();
      await page.keyboard.press("Tab");
      assert.equal(await summary.evaluate(el => el === document.activeElement), true, `${lang} ${width}x${height}: Tab did not reach summary`);
      const before = await summary.evaluate(el => ({ top: el.scrollTop, overflow: el.scrollHeight - el.clientHeight }));
      assert.ok(before.overflow > 20, `${lang} ${width}x${height}: fixture must actually overflow`);
      await page.keyboard.press("ArrowDown");
      const after = await summary.evaluate(el => ({ top: el.scrollTop, outline: getComputedStyle(el).outlineStyle }));
      assert.ok(after.top > before.top, `${lang} ${width}x${height}: ArrowDown must scroll the focused summary`);
      assert.notEqual(after.outline, "none", `${lang} ${width}x${height}: keyboard focus not visible`);
      await page.keyboard.press("ArrowUp");
      assert.equal(await summary.evaluate(el => el.scrollTop), 0, "ArrowUp returns to the start");
      await page.keyboard.press("End");
      assert.ok(await summary.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1), "End reaches the bottom");
      await page.keyboard.press("Home");
      assert.equal(await summary.evaluate(el => el.scrollTop), 0, "Home reaches the top");
      await page.keyboard.press("PageDown");
      assert.ok(await summary.evaluate(el => el.scrollTop) > 0, "PageDown scrolls");
      await page.keyboard.press("PageUp");
      assert.equal(await summary.evaluate(el => el.scrollTop), 0, "PageUp returns to the top");
      // The last explanatory paragraph must be revealable with the summary's
      // own keyboard scrolling, not hidden in a second inaccessible scroller.
      let reachedOrderEnd = false;
      for (let i = 0; i < 30; i++) {
        reachedOrderEnd = await page.locator(".mecha-order > p").last().evaluate(el => {
          const text = el.getBoundingClientRect(), scroller = el.closest(".mecha-turn-summary").getBoundingClientRect();
          return text.top >= scroller.top && text.bottom <= scroller.bottom;
        });
        if (reachedOrderEnd) break;
        await page.keyboard.press("PageDown");
      }
      assert.ok(reachedOrderEnd, `${lang} ${width}x${height}: order explanation cannot be revealed by keyboard`);
      await page.keyboard.press("Home");
      const order = page.getByRole("button", { name: zh ? "结算顺序" : "Attack order", exact: true });
      await order.focus();
      const expanded = await order.getAttribute("aria-expanded");
      await page.evaluate(() => {
        window.__summaryChildKey = null;
        document.addEventListener("keydown", event => { window.__summaryChildKey = { key: event.key, defaultPrevented: event.defaultPrevented }; }, { once: true });
      });
      await page.keyboard.press("ArrowDown");
      assert.deepEqual(await page.evaluate(() => window.__summaryChildKey), { key: "ArrowDown", defaultPrevented: false }, "summary must not hijack a child button's key");
      await page.keyboard.press("Enter");
      assert.notEqual(await order.getAttribute("aria-expanded"), expanded, "child order button remains keyboard-operable");
      console.log(`${lang} ${width}x${height}: Tab, focus, scrolling keys and child control passed`);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("Synthetic Chromium keyboard check only; no native or physical-input claims.");
} finally {
  await browser.close();
}
