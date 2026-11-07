#!/usr/bin/env node
// Smoke-test the production release picker and both supported mode routes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5188";
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
try {
  for (const choice of ["sequential", "classic"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("city.seed", "4196523069");
      window.__CITY_ISOLATION_FIXTURE__ = true;
      window.__AV_PLUGIN_LOCALE__ = "zh-Hans";
    });
    await page.goto(`${base}/?mechaV15=1`, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 180000 });
    await page.getByRole("button", { name: "城市设置", exact: true }).click();
    await page.getByRole("button", { name: "机甲战棋", exact: true }).click();
    const picker = page.getByRole("button", { name: "机甲战棋 1.5 · 本地 PvE", exact: true });
    await picker.waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-mecha-v15=""]').count(), 0, "production query must not bypass the release picker");
    await page.screenshot({ path: `/tmp/mecha-m2-production-${choice}-picker.png` });
    await page.getByRole("button", { name: choice === "sequential" ? "机甲战棋 1.5 · 本地 PvE" : "经典模式 · 1.4", exact: true }).click();
    const mode = page.locator(choice === "sequential" ? '[data-hud-mode="sequential"]' : '[data-hud-mode="classic"]');
    await mode.waitFor({ timeout: 120000 });
    if (choice === "sequential") {
      assert.equal(await mode.getAttribute("data-hud-phase"), "deployment");
      assert.equal(await mode.getAttribute("data-mecha-v15"), "");
    } else {
      assert.equal(await mode.getAttribute("data-mecha-v15"), null);
    }
    await page.screenshot({ path: `/tmp/mecha-m2-production-${choice}-selected.png` });
    assert.deepEqual(errors, [], `${choice} production route page errors`);
    console.log(`PASS production ${choice}: release picker, selected route, no page errors`);
    await context.close();
  }
} finally {
  await browser.close();
}
