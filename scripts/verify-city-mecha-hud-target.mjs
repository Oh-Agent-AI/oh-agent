#!/usr/bin/env node
// Synthetic Chromium HUD checks, not physical touch, screen-reader or Tauri acceptance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
async function tabTo(page, locator, label) {
  for (let i = 0; i < 100; i++) {
    if (await locator.evaluate((el) => document.activeElement === el)) return;
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => !!document.activeElement?.isConnected), `${label}: detached focus`);
  }
  assert.fail(`${label}: not reachable by Tab`);
}
async function actionsVisible(page, label) {
  const geometry = await page.locator(".mecha-candidate-result").evaluate((result) => {
    const panel = result.closest(".mecha-selected-actions"), p = panel.getBoundingClientRect();
    return [...result.querySelectorAll(".mecha-candidate-actions button")].map((button) => {
      const r = button.getBoundingClientRect(), hit = document.elementFromPoint((r.left+r.right)/2, (r.top+r.bottom)/2);
      return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height,
        clipped:r.left < p.left + panel.clientLeft - 1 || r.right > p.left + panel.clientLeft + panel.clientWidth + 1 ||
          r.top < p.top + panel.clientTop - 1 || r.bottom > p.top + panel.clientTop + panel.clientHeight + 1 ||
          r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight,
        hit:hit === button || button.contains(hit) };
    });
  });
  assert.equal(geometry.length, 2, `${label}: two candidate decisions`);
  for (const button of geometry) assert.ok(!button.clipped && button.hit && button.width >= 44 && button.height >= 44,
    `${label}: decisions must be visible, hit-testable and at least 44x44: ${JSON.stringify(geometry)}`);
}
try {
  for (const lang of ["zh", "en"]) {
    const zh = lang === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, hasTouch: true, locale: zh ? "zh-CN" : "en-US" });
    const page = await context.newPage(); page.setDefaultTimeout(90_000);
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/src/engine/CityEngine.ts*", async (route) => {
      const response = await route.fetch(), body = await response.text(), needle = "if (this.documentHidden) return;";
      assert.ok(body.includes(needle));
      await route.fulfill({ response, body: body.replace(needle, "if (this.documentHidden || window.__pauseHudDraw) return;") });
    });
    await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
      const response = await route.fetch(), body = await response.text();
      const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
      assert.ok(body.includes(needle));
      await route.fulfill({ response, body: body.replace(needle, needle + " window.__hudController = controllerRef.current;") });
    });
    await page.addInitScript((locale) => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, zh ? "zh-Hans" : "en");
    await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics" }).click();
    await page.locator(".mecha-submit-primary").click();
    await page.getByRole("button", { name: zh ? "继续提交" : "Submit anyway" }).click();
    const skip = page.getByRole("button", { name: zh ? "跳过演出" : "Skip animation" });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.waitForFunction(() => document.querySelector(".mecha-resource")?.textContent?.includes("68/80"), null, { timeout: 240_000 });
    await page.evaluate(() => { window.__pauseHudDraw = true; });
    await page.locator(".mecha-move-list summary").click();
    await page.locator(".mecha-pack li > button").first().click();
    await page.locator(".mecha-move-list select").selectOption("3,2");
    await page.getByRole("button", { name: zh ? "应用移动" : "Apply move" }).click();
    await page.setViewportSize({ width: 640, height: 480 });
    const melee = page.locator('.mecha-selected-actions button[data-mecha-action="melee"]');
    const boss = page.locator(".mecha-target-preview .mecha-actions button").filter({ hasText: zh ? "大怪" : "Boss" });
    const confirm = page.locator(".mecha-candidate-actions").getByRole("button", { name: zh ? "确认选择" : "Confirm target", exact: true });
    const cancel = page.locator(".mecha-candidate-actions").getByRole("button", { name: zh ? "取消选目标" : "Cancel targeting", exact: true });
    const draft = () => page.evaluate(() => window.__hudController.getState().draft.Assault);
    const original = await draft();
    // Keyboard target selection moves focus to confirm; Tab to cancel and Enter
    // must return focus to the action that initiated targeting.
    await melee.click();
    await melee.focus(); await tabTo(page, boss, `${lang}: boss target`); await page.keyboard.press("Enter");
    await confirm.waitFor();
    await page.waitForFunction(() => document.activeElement === document.querySelector(".mecha-candidate-actions button"));
    assert.deepEqual(await draft(), original, `${lang}: preview must not change draft`);
    await actionsVisible(page, `${lang} keyboard candidate`);
    if (screenshots) await page.screenshot({ path: join(screenshots, `hud-target-${lang}-640x480.png`) });
    await tabTo(page, cancel, `${lang}: cancel target`); await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector(".mecha-candidate-result"));
    assert.deepEqual(await draft(), original, `${lang}: cancel must not change draft`);
    assert.equal(await melee.evaluate((el) => document.activeElement === el), true, `${lang}: keyboard cancel restores action focus`);
    // Emulated touch selects and confirms; activation must actually change the draft.
    await melee.scrollIntoViewIfNeeded(); await melee.tap();
    await boss.scrollIntoViewIfNeeded(); await boss.tap();
    await confirm.waitFor(); await actionsVisible(page, `${lang} touch candidate`);
    assert.deepEqual(await draft(), original, `${lang}: touch preview must not change draft`);
    await confirm.tap();
    await page.waitForFunction(() => window.__hudController.getState().draft.Assault.action.kind === "melee");
    const applied = await draft();
    assert.equal(applied.action.target, "boss", `${lang}: touch confirm applies the selected boss`);
    assert.ok(await page.evaluate(() => !!document.activeElement?.isConnected), `${lang}: touch confirm left detached focus`);
    // Also exercise focus restoration after keyboard confirmation, not only cancel.
    await melee.click(); await melee.focus(); await tabTo(page, boss, `${lang}: keyboard reselect boss`);
    await page.keyboard.press("Enter"); await confirm.waitFor();
    await page.waitForFunction(() => document.activeElement === document.querySelector(".mecha-candidate-actions button"));
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector(".mecha-candidate-result"));
    assert.equal(await melee.evaluate((el) => document.activeElement === el), true, `${lang}: keyboard confirm restores action focus`);
    assert.equal((await draft()).action.target, "boss");
    assert.deepEqual(errors, []);
    console.log(`${lang}: 640x480 keyboard target/cancel focus and emulated-touch target/confirm, draft integrity and 44px decisions passed`);
    await context.close();
  }
} finally { await browser.close(); }
console.log("Synthetic Chromium only; no native, physical-input or screen-reader acceptance implied.");
